#!/usr/bin/env node
'use strict';

/**
 * kb-pattern-extract.js — kb/-sourced pattern extraction (v2.3.30,
 * substantive fix for the direct-spawn learn-extraction blind spot).
 *
 * See .orchestray/kb/artifacts/v2330-learn-extraction-diagnosis.md
 * (Recommendation 2) for the full diagnosis this closes.
 *
 * Both `/orchestray:learn` (manual) and the two auto-extraction hooks read
 * exclusively from `.orchestray/history/` or `current-orchestration.json` —
 * neither exists for direct-spawn / Simple-Task-Path work. This CLI reads
 * `.orchestray/kb/{facts,decisions,artifacts}/` directly instead, scoped by
 * a "since last kb-extract run" timestamp (not orchestration_id — kb
 * entries carry none, see bin/_lib/kb-extract-source.js docstring), and
 * writes proposals into the SAME `.orchestray/proposed-patterns/` staging
 * area the history-sourced path uses, so the existing accept/reject flow
 * (`/orchestray:patterns`, curator) needs zero changes.
 *
 * Human-gated: this is a manual CLI, not a hook. That's why it is allowed
 * to propose ALL THREE kb-derivable categories (anti-pattern,
 * user-correction, specialization) — the automatic hook fallback wired
 * into bin/post-orchestration-extract.js restricts itself to the subset
 * already on AUTO_EXTRACT_CATEGORY_ALLOWLIST (specialization only), because
 * anti-pattern/user-correction are reserved for human-or-curator-authorized
 * extraction per that file's own top-of-file comment (B1 §3).
 *
 * Usage: node bin/kb-pattern-extract.js [projectRoot] [--dry-run]
 * Prints a JSON summary to stdout. Exit 0 regardless (best-effort, not a gate).
 *
 * Provenance: every proposal this script writes carries
 * `provenance: kb` + `kb_source_path` + `kb_source_bucket` frontmatter
 * fields (see buildKbProposalContent) — visibly distinct from a
 * history-sourced proposal's `provenance: history`.
 *
 * No new npm dependencies — stdlib only.
 */

const fs   = require('node:fs');
const path = require('node:path');

const {
  readLastRunStamp,
  writeLastRunStamp,
  collectKbEntriesSince,
  deriveCategoryForEntry,
  buildProposalFromKbEntry,
  buildKbProposalContent,
} = require('./_lib/kb-extract-source.js');
const { validateProposal } = require('./_lib/proposal-validator.js');
const { writeEvent }       = require('./_lib/audit-event-writer.js');

// All three kb-derivable categories — human-gated manual invocation (see
// module docstring for why this differs from the automatic hook fallback).
const KB_MANUAL_CATEGORIES = new Set(['anti-pattern', 'user-correction', 'specialization']);

/**
 * Run the kb-sourced extraction pipeline.
 *
 * @param {{ projectRoot: string, dryRun?: boolean, allowedCategories?: Set<string> }} opts
 * @returns {{
 *   since: string|null,
 *   checked: number,
 *   staged: string[],
 *   skipped: Array<{ slug: string, reason: string, detail?: string }>,
 *   dry_run: boolean,
 * }}
 */
function runKbExtraction(opts) {
  const projectRoot = opts.projectRoot;
  const dryRun = !!opts.dryRun;
  const allowedCategories = opts.allowedCategories || KB_MANUAL_CATEGORIES;

  const since = readLastRunStamp(projectRoot);
  const entries = collectKbEntriesSince(projectRoot, since);

  const proposedPatternsDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
  const activePatternsDir   = path.join(projectRoot, '.orchestray', 'patterns');

  const staged  = [];
  const skipped = [];

  for (const entry of entries) {
    const category = deriveCategoryForEntry(entry);
    if (!category) {
      skipped.push({ slug: entry.slug, reason: 'no_category_match' });
      continue;
    }
    if (!allowedCategories.has(category)) {
      skipped.push({ slug: entry.slug, reason: 'category_not_allowed_here', detail: category });
      continue;
    }

    const proposal = buildProposalFromKbEntry(entry, category);
    const valResult = validateProposal(proposal, { strict: true });
    if (!valResult.ok) {
      const fields = (valResult.errors || []).map((e) => e.field).join(',');
      skipped.push({ slug: entry.slug, reason: 'validator_rejected', detail: fields });
      continue;
    }

    const proposedPath = path.join(proposedPatternsDir, proposal.name + '.md');
    const activePath   = path.join(activePatternsDir, proposal.name + '.md');
    if (fs.existsSync(proposedPath) || fs.existsSync(activePath)) {
      skipped.push({ slug: entry.slug, reason: 'slug_collision', detail: proposal.name });
      continue;
    }

    if (!dryRun) {
      const content = buildKbProposalContent(proposal, entry);
      const dir = path.dirname(proposedPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = proposedPath + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, proposedPath);

      try {
        writeEvent({
          type: 'kb_extract_staged',
          schema_version: 1,
          slug: proposal.name,
          category,
          kb_source_path: entry.relPath,
          kb_source_bucket: entry.bucket,
          provenance: 'kb',
        }, { cwd: projectRoot });
      } catch (_e) { /* fail-open — proposal write already succeeded */ }
    }

    staged.push(proposal.name);
  }

  if (!dryRun) {
    writeLastRunStamp(projectRoot);
    try {
      writeEvent({
        type: 'kb_extract_run_complete',
        schema_version: 1,
        since: since || null,
        checked: entries.length,
        staged_count: staged.length,
        skipped_count: skipped.length,
        provenance: 'kb',
      }, { cwd: projectRoot });
    } catch (_e) { /* fail-open */ }
  }

  return {
    since: since || null,
    checked: entries.length,
    staged,
    skipped,
    dry_run: dryRun,
  };
}

module.exports = { runKbExtraction, KB_MANUAL_CATEGORIES };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => !a.startsWith('--'));
  const projectRoot = positional[0] || process.cwd();

  // Cheap, consistent safety valve with the auto-extraction hooks — same
  // env var, same semantics (global kill switch).
  if (process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH === '1') {
    console.log(JSON.stringify({ since: null, checked: 0, staged: [], skipped: [], dry_run: dryRun, reason: 'kill_switch_env' }, null, 2));
    process.exit(0);
  }

  let summary;
  try {
    summary = runKbExtraction({ projectRoot, dryRun });
  } catch (err) {
    summary = { since: null, checked: 0, staged: [], skipped: [], dry_run: dryRun, error: (err && err.message) || 'unexpected_error' };
  }
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}
