#!/usr/bin/env node
// NOT_A_HOOK (v2.3.24): CLI-only utility, not wired as a hook handler.
'use strict';
// Usage: node bin/curator-backfill-stamps.js [projectRoot] [--dry-run]
//
// Backfills a `recently_curated_action: promote` stamp for every local
// pattern that is verifiably present in the shared tier but never received
// ANY local stamp — see bin/_lib/curator-recently-curated.js's
// backfillPromoteStamps() docstring and
// .orchestray/kb/decisions/v2324-curate-followups.md §Item 1.
//
// Prints a JSON summary of {backfilled, skipped, failed} to stdout.
// Exit 0 regardless (stamp-backfill is best-effort, not a gate).
const { backfillPromoteStamps } = require('./_lib/curator-recently-curated');

const args        = process.argv.slice(2);
const dryRun      = args.includes('--dry-run');
const projectRoot = (!args[0] || args[0].startsWith('--')) ? process.cwd() : args[0];

const summary = backfillPromoteStamps({ projectRoot, dryRun });
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
