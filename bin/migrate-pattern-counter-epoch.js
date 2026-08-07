#!/usr/bin/env node
// NOT_A_HOOK: one-shot CLI migration, not wired into hooks.json.
'use strict';

/**
 * migrate-pattern-counter-epoch.js — one-shot `times_applied` epoch migration
 * (design: pattern-application-evidence-design.md §7.2).
 *
 * §0.1 correction: spawn prompts are never persisted to events.jsonl, so
 * there is no archived `@orchestray:pattern://` injection history to backfill
 * `times_applied` from. This migration does NOT attempt that. It epochs the
 * counter instead:
 *
 *   times_applied_legacy = <current times_applied>   (preserved, advisory only)
 *   times_applied        = 0                          (semantics changed — reset)
 *   times_offered         = count of DISTINCT orchestration_ids carrying a
 *                            pattern_skip_enriched row for this slug, across
 *                            the live log + every .orchestray/history/<id>/
 *                            archive, deduped on
 *                            (timestamp, orchestration_id, pattern_name) —
 *                            the dedupe key that prevents the 3.4x inflation
 *                            from double-counting live+archived copies of the
 *                            same row.
 *   times_contradicted    = 0
 *   counter_epoch          = 2
 *
 * Runs over all three offer-eligible tiers (local, team, shared) — see
 * bin/_lib/pattern-file-resolve.js.
 *
 * Idempotent: a pattern already at counter_epoch === 2 is skipped (no-op, no
 * journal rows). Every field write is journaled to
 * .orchestray/state/pattern-counter-journal.jsonl with
 * orchestration_id: MIGRATION_SENTINEL, committer: 'migrate-pattern-counter-epoch',
 * so `bin/pattern-counter-revert.js --migration` can restore epoch 1 exactly —
 * including deleting the fields that did not exist before the migration, which
 * is what before_absent on each journal row records.
 *
 * CLI usage:
 *   node bin/migrate-pattern-counter-epoch.js [--project-root=PATH] [--dry-run]
 */

const fs   = require('node:fs');
const path = require('node:path');

const ledger = require('./_lib/pattern-evidence-ledger');
const patternFiles = require('./_lib/pattern-file-resolve');
const frontmatter = require('./mcp-server/lib/frontmatter');
const paths = require('./mcp-server/lib/paths');

const MIGRATION_SENTINEL = 'migration:epoch-2';
const COMMITTER = 'migrate-pattern-counter-epoch';
const MAX_EVENTS_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Scan the live events log + every history archive for pattern_skip_enriched
 * rows, deduped on (timestamp, orchestration_id, pattern_name), and return
 * slug -> Set(distinct orchestration_id).
 *
 * @param {string} projectRoot
 * @returns {Map<string, Set<string>>}
 */
function scanOfferedOrchestrations(projectRoot) {
  const files = [];
  const liveEvents = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
  if (fs.existsSync(liveEvents)) files.push(liveEvents);

  const historyDir = paths.getHistoryDir(projectRoot);
  try {
    for (const entry of fs.readdirSync(historyDir)) {
      const candidate = path.join(historyDir, entry, 'events.jsonl');
      if (fs.existsSync(candidate)) files.push(candidate);
    }
  } catch (_e) { /* no history dir yet */ }

  const seenKeys = new Set(); // dedupe: timestamp|orchestration_id|pattern_name
  const orchsBySlug = new Map(); // pattern_name -> Set<orchestration_id>

  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file); } catch (_e) { continue; }
    if (stat.size === 0 || stat.size > MAX_EVENTS_FILE_BYTES) continue;

    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_e) { continue; }

    for (const line of text.split('\n')) {
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_e) { continue; }
      if (!ev || ev.type !== 'pattern_skip_enriched') continue;
      const slug = ev.pattern_name;
      const orchId = ev.orchestration_id;
      const ts = ev.timestamp;
      if (typeof slug !== 'string' || typeof orchId !== 'string' || typeof ts !== 'string') continue;

      const key = ts + '|' + orchId + '|' + slug;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      if (!orchsBySlug.has(slug)) orchsBySlug.set(slug, new Set());
      orchsBySlug.get(slug).add(orchId);
    }
  }

  return orchsBySlug;
}

/**
 * Migrate one pattern file. Returns { migrated: boolean, changes: object[] }.
 * No-op (migrated: false) when counter_epoch is already 2.
 *
 * @param {string} patternFile
 * @param {number} timesOffered
 * @param {boolean} dryRun
 */
function migratePatternFile(patternFile, timesOffered, dryRun) {
  let content;
  try { content = fs.readFileSync(patternFile, 'utf8'); }
  catch (_e) { return { migrated: false, changes: [] }; }

  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) return { migrated: false, changes: [] };

  const currentEpoch = parsed.frontmatter.counter_epoch;
  if (currentEpoch === 2) return { migrated: false, changes: [] }; // idempotent no-op

  const currentApplied = typeof parsed.frontmatter.times_applied === 'number' ? parsed.frontmatter.times_applied : 0;

  const fm = Object.assign({}, parsed.frontmatter);

  // A field absent from the frontmatter is journaled with before_absent so the
  // revert DELETES it instead of writing null back. Journaling `null` (or a 0 /
  // epoch-1 default) made the only undo materialise fields that never existed
  // and fail schemas/pattern.schema.js, whose .optional() rejects null (RV-1 E5).
  const change = (field, after) => (fm[field] === undefined
    ? { field, before: null, before_absent: true, after }
    : { field, before: fm[field], before_absent: false, after });

  const changes = [
    change('times_applied_legacy', currentApplied),
    change('times_applied', 0),
    change('times_offered', timesOffered),
    change('times_contradicted', 0),
    change('counter_epoch', 2),
  ];

  if (!dryRun) {
    fm.times_applied_legacy = currentApplied;
    fm.times_applied = 0;
    fm.times_offered = timesOffered;
    fm.times_contradicted = 0;
    fm.counter_epoch = 2;

    const next = frontmatter.stringify({ frontmatter: fm, body: parsed.body });
    const tmp = patternFile + '.tmp';
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, patternFile);
  }

  return { migrated: true, changes };
}

/**
 * @param {{ projectRoot?: string, dryRun?: boolean }} opts
 * @returns {{ scanned: number, migrated: number, skipped: number }}
 */
function main(opts) {
  const projectRoot = (opts && opts.projectRoot) || process.cwd();
  const dryRun = !!(opts && opts.dryRun);

  const orchsBySlug = scanOfferedOrchestrations(projectRoot);
  // All three offer-eligible tiers, not just the local one: a shared-tier
  // pattern left at epoch 1 while local ones reset to 0 skews every ranking
  // that tiebreaks on times_applied (RV-1 E6). counter_epoch keeps a second
  // project's migration run a no-op on the files this one already migrated.
  const files = patternFiles.listPatternFiles(projectRoot);

  let migrated = 0;
  let skipped = 0;
  const nowIso = new Date().toISOString();

  for (const entry of files) {
    const timesOffered = (orchsBySlug.get(entry.slug) || new Set()).size;

    const result = migratePatternFile(entry.file, timesOffered, dryRun);
    if (!result.migrated) { skipped++; continue; }
    migrated++;

    if (!dryRun) {
      for (const change of result.changes) {
        ledger.appendJournal(projectRoot, {
          timestamp: nowIso,
          orchestration_id: MIGRATION_SENTINEL,
          slug: entry.slug,
          tier: entry.tier,
          field: change.field,
          before: change.before,
          before_absent: !!change.before_absent,
          after: change.after,
          committer: COMMITTER,
        });
      }
    }
  }

  return { scanned: files.length, migrated, skipped };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  let projectRoot = process.cwd();
  let dryRun = false;
  for (const arg of argv) {
    if (arg.startsWith('--project-root=')) projectRoot = arg.split('=')[1];
    else if (arg === '--dry-run') dryRun = true;
  }

  try {
    const result = main({ projectRoot, dryRun });
    process.stdout.write(
      `[migrate-pattern-counter-epoch] scanned=${result.scanned} migrated=${result.migrated} skipped=${result.skipped}` +
      (dryRun ? ' (dry-run, no writes)' : '') + '\n'
    );
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[migrate-pattern-counter-epoch] error: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}

module.exports = { main, scanOfferedOrchestrations, migratePatternFile, MIGRATION_SENTINEL };
