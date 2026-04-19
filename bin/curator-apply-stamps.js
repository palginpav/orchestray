#!/usr/bin/env node
'use strict';
// Usage: node bin/curator-apply-stamps.js <runId> [projectRoot]
// Prints a JSON summary of {stamped, skipped, failed} to stdout.
// Exit 0 regardless (stamp-apply is best-effort, not a gate).
const { applyStampsForRun } = require('./_lib/curator-recently-curated');
const runId = process.argv[2];
const projectRoot = process.argv[3] || process.cwd();
if (!runId) { console.error('Usage: curator-apply-stamps.js <runId> [projectRoot]'); process.exit(1); }
const summary = applyStampsForRun(runId, { projectRoot });
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
