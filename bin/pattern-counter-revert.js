#!/usr/bin/env node
// NOT_A_HOOK: manual rollback CLI, not wired into hooks.json.
'use strict';

/**
 * pattern-counter-revert.js — rollback CLI for both Phase-3 orchestration
 * commits and the epoch migration (design: pattern-application-evidence-
 * design.md §10.2).
 *
 * Reads .orchestray/state/pattern-counter-journal.jsonl, filters to rows
 * matching either `--orchestration <id>` (bin/commit-pattern-applications.js
 * writes) or `--migration` (bin/migrate-pattern-counter-epoch.js writes,
 * orchestration_id === MIGRATION_SENTINEL), and replays them in REVERSE
 * (last-written-first) restoring each row's recorded `before` value.
 *
 * No git involvement — patterns are runtime state under .orchestray/. The
 * journal is append-only; revert does not delete or rewrite journal rows,
 * it only restores frontmatter. A row with `before_absent: true` had no such
 * field before the write, so restoring it means DELETING the key — writing
 * null back would leave the file invalid under schemas/pattern.schema.js.
 * Files are resolved across all three pattern tiers, preferring the tier
 * recorded on the journal row.
 *
 * CLI usage:
 *   node bin/pattern-counter-revert.js --orchestration <id> [--project-root=PATH] [--dry-run]
 *   node bin/pattern-counter-revert.js --migration [--project-root=PATH] [--dry-run]
 */

const fs   = require('node:fs');
const path = require('node:path');

const ledger = require('./_lib/pattern-evidence-ledger');
const patternFiles = require('./_lib/pattern-file-resolve');
const frontmatter = require('./mcp-server/lib/frontmatter');
const { MIGRATION_SENTINEL } = require('./migrate-pattern-counter-epoch');

/**
 * @param {string} projectRoot
 * @param {string} orchestrationId - target orchestration_id, or MIGRATION_SENTINEL.
 * @returns {object[]} matching journal rows, in FILE (append) order.
 */
function readJournalRows(projectRoot, orchestrationId) {
  let raw;
  try { raw = fs.readFileSync(ledger._journalPath(projectRoot), 'utf8'); }
  catch (_e) { return []; }

  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.orchestration_id === orchestrationId) rows.push(row);
    } catch (_e) { /* skip malformed */ }
  }
  return rows;
}

/**
 * Restore one field on one pattern file to `before`. Returns
 * { ok: true } | { ok: false, error: string }.
 *
 * @param {string} patternFile
 * @param {string} field
 * @param {*} before
 * @param {*} expectedAfter - the journaled `after` value, used only for a
 *   stderr warning when the on-disk value has drifted (still reverts).
 * @param {boolean} [beforeAbsent] - the field did not exist before the write:
 *   DELETE it rather than writing `before` back. Writing null back left the
 *   corpus schema-invalid and materialised counters that never existed (E5).
 */
function restoreField(patternFile, field, before, expectedAfter, beforeAbsent) {
  let content;
  try { content = fs.readFileSync(patternFile, 'utf8'); }
  catch (e) { return { ok: false, error: (e && e.code) || 'read_failed' }; }

  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) return { ok: false, error: 'malformed_frontmatter' };

  const current = parsed.frontmatter[field];
  if (current !== expectedAfter) {
    process.stderr.write(
      `[pattern-counter-revert] WARN: ${path.basename(patternFile)} field "${field}" ` +
      `current value ${JSON.stringify(current)} != journaled after ${JSON.stringify(expectedAfter)} ` +
      `(a later write happened) — reverting to ${JSON.stringify(before)} anyway\n`
    );
  }

  const fm = Object.assign({}, parsed.frontmatter);
  if (beforeAbsent) delete fm[field];
  else fm[field] = before;
  const next = frontmatter.stringify({ frontmatter: fm, body: parsed.body });
  const tmp = patternFile + '.tmp';
  try {
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, patternFile);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_e2) { /* swallow */ }
    return { ok: false, error: (e && e.code) || 'write_failed' };
  }
  return { ok: true };
}

/**
 * @param {{ projectRoot?: string, orchestrationId?: string, migration?: boolean, dryRun?: boolean }} opts
 * @returns {{ reverted: number, failed: number, rows: number }}
 */
function main(opts) {
  const projectRoot = (opts && opts.projectRoot) || process.cwd();
  const dryRun = !!(opts && opts.dryRun);
  const target = (opts && opts.migration) ? MIGRATION_SENTINEL : (opts && opts.orchestrationId);
  if (!target) throw new Error('pattern-counter-revert: --orchestration <id> or --migration is required');

  const rows = readJournalRows(projectRoot, target);

  let reverted = 0;
  let failed = 0;

  // Replay in reverse (last-written-first) so an intermediate field state
  // never briefly reflects a later write's "before" applied out of order.
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    // Claim rows (§5.2 idempotency marker) carry no field write to undo.
    if (row && row.kind === 'claim') continue;
    if (!row || typeof row.slug !== 'string' || typeof row.field !== 'string') { failed++; continue; }

    // Resolve across the same three tiers the committer writes to, preferring
    // the tier journaled with the row (RV-1 E6).
    const patternFile = patternFiles.resolvePatternFile(projectRoot, row.slug, row.tier);
    if (!patternFile) {
      process.stderr.write(`[pattern-counter-revert] pattern file missing for slug "${row.slug}"; skipping\n`);
      failed++;
      continue;
    }

    if (dryRun) {
      const action = row.before_absent ? 'delete' : 'restore to ' + JSON.stringify(row.before);
      process.stdout.write(`[dry-run] would ${action}: ${row.slug}.${row.field}\n`);
      reverted++;
      continue;
    }

    const result = restoreField(patternFile, row.field, row.before, row.after, row.before_absent);
    if (result.ok) reverted++;
    else { failed++; process.stderr.write(`[pattern-counter-revert] revert failed for ${row.slug}.${row.field}: ${result.error}\n`); }
  }

  return { reverted, failed, rows: rows.length };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let projectRoot = process.cwd();
  let orchestrationId = null;
  let migration = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--orchestration') { orchestrationId = argv[++i]; }
    else if (arg.startsWith('--orchestration=')) { orchestrationId = arg.split('=')[1]; }
    else if (arg === '--migration') { migration = true; }
    else if (arg.startsWith('--project-root=')) { projectRoot = arg.split('=')[1]; }
    else if (arg === '--dry-run') { dryRun = true; }
  }

  try {
    const result = main({ projectRoot, orchestrationId, migration, dryRun });
    process.stdout.write(
      `[pattern-counter-revert] rows=${result.rows} reverted=${result.reverted} failed=${result.failed}` +
      (dryRun ? ' (dry-run, no writes)' : '') + '\n'
    );
    process.exit(result.failed > 0 ? 1 : 0);
  } catch (e) {
    process.stderr.write(`[pattern-counter-revert] error: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}

module.exports = { main, readJournalRows, restoreField };
