#!/usr/bin/env node
'use strict';

/**
 * emit-orchestration-complete.js — SubagentStop hook (v2.2.13 W4, G-05).
 *
 * Emits orchestration_complete on the first SubagentStop after an orchestration
 * finishes. Replaces the prior (broken) design that tried to write inside the
 * gated audit-on-orch-complete handler — that handler only runs when the row
 * already exists, so it could never be the originator.
 *
 * Idempotency
 * -----------
 * Atomic sentinel via `fs.writeFileSync(path, '', { flag: 'wx' })` closes the
 * TOCTOU race from W3-review P1-6. Two parallel SubagentStop fires → only one
 * wins the sentinel create; the other catches EEXIST and exits 0.
 *
 * Secondary gate against ox.js double-fire
 * -----------------------------------------
 * If bin/ox.js:329 already wrote orchestration_complete (operator used
 * `ox state complete` directly), this hook detects the existing row after
 * winning the sentinel, removes the sentinel (so a future legitimate completion
 * can still emit), and exits 0 without writing a duplicate row.
 *
 * Kill switch
 * -----------
 * ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED=1 — exits 0 before sentinel work.
 *
 * Fail-open contract
 * ------------------
 * Every error path exits 0. The cost of a missed emit is o:>=1 reverts to o:0
 * for that one orch — never a blocked subagent stop.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { resolveSafeCwd }                  = require('./_lib/resolve-project-cwd');
const { writeEvent }                      = require('./_lib/audit-event-writer');
const { hasOrchComplete, readCurrentOrchId } = require('./audit-on-orch-complete');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  if (process.env.ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED === '1') {
    return process.exit(0);
  }

  let cwd = process.cwd();
  try { cwd = resolveSafeCwd(JSON.parse(raw || '{}').cwd); } catch (_e) {}

  const orchId = readCurrentOrchId(cwd);
  if (!orchId) return process.exit(0);

  const sentinelPath = path.join(cwd, '.orchestray', 'state',
    `orchestration-complete-emitted.${orchId}`);

  let won = false;
  try {
    fs.writeFileSync(sentinelPath, '', { flag: 'wx' }); // atomic create
    won = true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return process.exit(0); // another stop already won
    // disk error → fail-open
    return process.exit(0);
  }

  // Secondary gate: if ox.js or audit-on-orch-complete already wrote the row,
  // do not double-fire. Remove the sentinel so a subsequent legitimate
  // completion-via-different-path can still emit.
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (hasOrchComplete(eventsPath, orchId)) {
    try { fs.unlinkSync(sentinelPath); } catch (_e) {}
    return process.exit(0);
  }

  try {
    writeEvent({
      event_type:       'orchestration_complete',
      version:          1,
      orchestration_id: orchId,
      completed_at:     new Date().toISOString(),
      schema_version:   1,
    }, { cwd });
  } catch (_e) { /* fail-open */ }

  process.exit(0);
});
