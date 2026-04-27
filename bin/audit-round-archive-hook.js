#!/usr/bin/env node
'use strict';

/**
 * audit-round-archive-hook.js — SubagentStop hook (P3.1, v2.2.0).
 *
 * Detects audit-round closure by tailing `.orchestray/audit/events.jsonl`
 * for `verify_fix_pass | verify_fix_fail | verify_fix_oscillation` rows
 * (emitted per `agents/pm-reference/phase-verify.md:286-302`). When a
 * close-row appears that is newer than the most recent
 * `audit_round_closed`, this script:
 *   1. Emits `audit_round_closed` (synthesised — Claude Code does not
 *      emit it natively).
 *   2. Calls `archiveRound(orchId, roundN, {cwd})` from
 *      `bin/_lib/audit-round-archive.js`.
 *
 * Fail-open: any error → `process.exit(0)` with no stderr (audit hooks
 * must never block Claude Code).
 *
 * Three-layer kill switch (env / config / sentinel) is honoured by the
 * library; the hook also checks env early to avoid even the tail-read
 * cost when disabled.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { writeEvent }                  = require('./_lib/audit-event-writer');
const { archiveRound }                = require('./_lib/audit-round-archive');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });
const TAIL_LINES        = 200;
const ROUND_CLOSE_TYPES = new Set([
  'verify_fix_pass', 'verify_fix_fail', 'verify_fix_oscillation',
]);

let stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE + '\n');
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  if (stdinBuf.length > MAX_INPUT_BYTES) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const payload = stdinBuf ? JSON.parse(stdinBuf) : {};
    handle(payload);
  } catch (_e) {
    // fall-through fail-open
  }
  try { process.stdout.write(CONTINUE_RESPONSE + '\n'); } catch (_e) {}
  process.exit(0);
});

function tailLines(filePath, n) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return [];
  }
  if (!raw) return [];
  const all = raw.split('\n');
  return all.slice(Math.max(0, all.length - n));
}

function handle(event) {
  // Early env kill — avoid the tail-read cost when disabled.
  if (process.env.ORCHESTRAY_DISABLE_AUDIT_ROUND_ARCHIVE === '1') return;

  const cwd = resolveSafeCwd(event && event.cwd);
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');

  const lines = tailLines(eventsPath, TAIL_LINES);
  if (lines.length === 0) return;

  // Walk newest → oldest. Find the most recent close-row not yet
  // followed by a matching `audit_round_closed`.
  let lastClosedKey = null;          // "<orch>:<round>" of latest audit_round_closed
  let pendingClose  = null;          // close-row to act on

  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch (_e) { continue; }
    if (!ev || typeof ev !== 'object') continue;

    const t = ev.type || ev.event_type;
    if (!t) continue;

    if (t === 'audit_round_closed') {
      const r = (typeof ev.round_n === 'number') ? ev.round_n : null;
      const o = ev.orchestration_id;
      if (o != null && r != null) {
        lastClosedKey = o + ':' + r;
        break; // stop — anything newer in our scan was already handled.
      }
    }

    if (ROUND_CLOSE_TYPES.has(t) && pendingClose === null) {
      const r =
        (typeof ev.round === 'number' ? ev.round : null) ??
        (ev.extra && typeof ev.extra.round === 'number' ? ev.extra.round : null);
      const o = ev.orchestration_id;
      if (o != null && r != null) {
        pendingClose = {
          type:   t,
          round_n: r,
          orchestration_id: o,
          task_id: ev.task_id || (ev.extra && ev.extra.task_id) || null,
        };
      }
    }
  }

  if (!pendingClose) return;
  const closeKey = pendingClose.orchestration_id + ':' + pendingClose.round_n;
  if (lastClosedKey === closeKey) return;   // already handled in a prior turn

  // Emit synthesised audit_round_closed FIRST. We re-count the
  // finding-bearing rows for this round for the schema field.
  let findingCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch (_e) { continue; }
    if (!ev || ev.orchestration_id !== pendingClose.orchestration_id) continue;
    const r =
      (typeof ev.round === 'number' ? ev.round : null) ??
      (ev.extra && typeof ev.extra.round === 'number' ? ev.extra.round : null);
    if (r !== pendingClose.round_n) continue;
    findingCount++;
  }

  const outcomeMap = {
    verify_fix_pass:        'pass',
    verify_fix_fail:        'fail',
    verify_fix_oscillation: 'oscillation',
  };

  try {
    writeEvent({
      version: 1,
      type: 'audit_round_closed',
      orchestration_id: pendingClose.orchestration_id,
      round_n: pendingClose.round_n,
      outcome: outcomeMap[pendingClose.type] || 'pass',
      finding_count: findingCount,
      task_id: pendingClose.task_id,
    }, { cwd });
  } catch (_e) { /* fail-open */ }

  // Run the archiver. Library is fail-open and honours the kill switches.
  try {
    archiveRound(pendingClose.orchestration_id, pendingClose.round_n, { cwd });
  } catch (_e) { /* fail-open */ }
}
