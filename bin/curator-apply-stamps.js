#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';
// Usage: node bin/curator-apply-stamps.js <runId> [projectRoot] [--evaluated-slugs <json-array>]
//
// H6 (v2.1.4): the optional --evaluated-slugs flag accepts a JSON array of slug strings.
// These are patterns the curator evaluated but did not act on. They receive an
// action: "evaluated" stamp so the next --diff run sees them as clean (not stamp-absent).
//
// Prints a JSON summary of {stamped, skipped, failed} to stdout.
// Exit 0 regardless (stamp-apply is best-effort, not a gate).
const { applyStampsForRun } = require('./_lib/curator-recently-curated');

const args        = process.argv.slice(2);
const runId       = args[0];
const projectRoot = (!args[1] || args[1].startsWith('--')) ? process.cwd() : args[1];

if (!runId) {
  console.error('Usage: curator-apply-stamps.js <runId> [projectRoot] [--evaluated-slugs <json-array>]');
  process.exit(1);
}

// Parse --evaluated-slugs <json-array> from remaining args.
let evaluatedSlugs = [];
const evalFlagIdx = args.indexOf('--evaluated-slugs');
if (evalFlagIdx !== -1 && args[evalFlagIdx + 1]) {
  try {
    const parsed = JSON.parse(args[evalFlagIdx + 1]);
    if (Array.isArray(parsed)) {
      evaluatedSlugs = parsed.filter(s => typeof s === 'string');
    }
  } catch (_) {
    // Malformed JSON — silently ignore; body-hash stamps are best-effort.
  }
}

const summary = applyStampsForRun(runId, { projectRoot, evaluatedSlugs });
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
