#!/usr/bin/env node
'use strict';

/**
 * audit-pm-emit-coverage.js — Stop-hook tail: PM-emit-prose rotting detector
 * (v2.2.9 B-8.2).
 *
 * Why this exists
 * ---------------
 * `pm-emit-state-watcher.js` (B-8.1) silently fires on the PM's behalf when
 * one of the 4 prose-only emits goes missing. This Stop-hook tail asks:
 * "across the whole orchestration, what fraction of these events came from
 * the backstop vs. from PM prose?" When backstop_count / (pm_count +
 * backstop_count) > 0.5 for any of the 4 watched event-types, the helper
 * emits `pm_emit_prose_rotting` so the on-call operator sees that a section
 * of pm.md has decayed below the "good enough" threshold.
 *
 * Inputs
 * ------
 *   1. `.orchestray/audit/current-orchestration.json` — active orch_id.
 *   2. `.orchestray/history/<orch_id>/events.jsonl` (F2 archive, preferred).
 *   3. `.orchestray/audit/events.jsonl` (live log, fallback when the archive
 *      doesn't exist yet — the archive Stop-hook fires before this one but
 *      we still read both to survive ordering changes).
 *
 * Output
 * ------
 * Per watched event-type: emit `pm_emit_prose_rotting` IFF
 *   pm_count + backstop_count >= 2  AND  backstop_count / (pm_count + backstop_count) > 0.5
 *
 * The "≥ 2 events seen" floor avoids alarming on an orchestration that
 * happens to produce a single backstop emit. It structurally CANNOT catch a
 * type that emits zero times, or one whose few real rows are shaped wrong —
 * see the two v2.3.21 additions below, which close that gap without
 * touching the floor (lowering it globally would false-positive on every
 * event type that is legitimately rare, e.g. `custom_agents_skipped` in an
 * orchestration with no invalid custom-agent files).
 *
 * v2.3.21 item 1: `checkStateCancelCompleteness` (in pm-emit-state-watcher.js)
 * reconstructs `state_cancel_aborted` directly from the archived-directory
 * ground truth — a dedicated completeness check, same shape as
 * `checkOrchRoiPresence`/`checkOversizedInputCompleteness` below, because
 * this event fires at most once per orchestration and can never reach the
 * ratio floor's "≥ 2" requirement even in principle.
 *
 * v2.3.21 item 2: `scanMisshapenEmits` catches the "event: instead of type:"
 * failure mode surfaced by `verify_fix_attempt` — every one of its 19
 * historical PM-hand-written rows used the wrong field name, so they are
 * invisible to `tallyEvents()`'s `evt.type` lookup regardless of the floor.
 * A single misshapen row is unambiguous proof of the bug (no well-formed
 * emitter ever produces an `event:` key), so this scan needs no floor at
 * all — it fires on count >= 1.
 *
 * Kill switch
 * -----------
 *   ORCHESTRAY_PM_EMIT_WATCHER_DISABLED=1 — same as the watcher itself
 *
 * Fail-open contract
 * ------------------
 * Hooks must never block Claude Code. Every error path logs to stderr and
 * exits 0.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { writeEvent }                  = require('./_lib/audit-event-writer');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

// B6: ROI presence check — logic lives in pm-emit-state-watcher for
// co-location with the other watcher rules. We import and call it here
// so audit-pm-emit-coverage participates in the orch-close fan-out.
// v2.3.20: item 2 (oversized-input completeness) and item 4 (dynamic-target
// zero-emission detector) join the same fan-out, same rationale.
const {
  checkOrchRoiPresence,
  checkReplanBudget,
  checkOversizedInputCompleteness,
  checkStateCancelCompleteness,
  checkDynamicTargetZeroEmission,
} = require('./_lib/pm-emit-state-watcher');

const WATCHED_EVENT_TYPES = [
  'tier2_invoked',
  'pattern_roi_snapshot',
  'verify_fix_start',
  'consequence_forecast',
  'orchestration_roi',
  // N2-fix: developer agent emits this when delta-handoff fallback triggers
  // (delegation-templates.md §Fallback). No clean state-file trigger exists
  // for the watcher (it fires on developer-side logic, not PM state writes),
  // so coverage-script rot-detection is the mechanical backstop.
  'delta_handoff_fallback',
  // v2.3.1: emitted by bin/discover-custom-agents.js per invalid file at SessionStart.
  'custom_agents_skipped',
  // v2.3.14: oversized-input map-reduce protocol events, emitted by the PM /
  // synthesizer subagent during oversized-input-mode.md (OI.5/OI.6/OI.8), not on
  // PM state writes. checkOversizedInputCompleteness (below) is the real
  // backstop; this ratio scan still watches for PARTIAL rot once it fires.
  'oversized_map_dispatched',
  'oversized_slice_skipped',
  'oversized_synthesis_complete',
  // v2.3.20: the dynamic-eventType WATCH_TARGETS family (B1 + item 1 below).
  // Included so tallyEvents() has real counts for checkDynamicTargetZeroEmission
  // to read — without an entry here, tallyCounts[type] is undefined and the
  // zero-emission check would misread "not tallied" as "confirmed zero".
  'verify_fix_pass',
  'verify_fix_fail',
  'verify_fix_oscillation',
  'replan',
  // v2.3.21 item 2: no code emitter exists yet and its historical rows all
  // used the wrong field name (event: not type:), so they're invisible to
  // this ratio check regardless of this list — see scanMisshapenEmits.
  // Tracked here anyway so a future field-name fix gets ratio-based
  // partial-rot coverage the same way the other prose-only types do.
  'verify_fix_attempt',
];

const FLOOR_TOTAL_EVENTS = 2;     // require at least 2 emits before alarming
const ROT_THRESHOLD      = 0.5;   // backstop / total > this → emit rotting

const EVENTS_FILE_BYTES_CAP = 64 * 1024 * 1024; // 64 MB defensive cap

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDisabled() {
  return process.env.ORCHESTRAY_PM_EMIT_WATCHER_DISABLED === '1';
}

function resolveOrchId(cwd) {
  try {
    const file = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.orchestration_id === 'string') {
      return data.orchestration_id;
    }
  } catch (_e) { /* fail-open */ }
  return null;
}

function readJsonlLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return [];
    if (stat.size > EVENTS_FILE_BYTES_CAP) {
      // Tail-read — most recent activity is what matters at orch-close.
      const fd = fs.openSync(filePath, 'r');
      try {
        const start = stat.size - EVENTS_FILE_BYTES_CAP;
        const buf = Buffer.alloc(EVENTS_FILE_BYTES_CAP);
        fs.readSync(fd, buf, 0, EVENTS_FILE_BYTES_CAP, start);
        return buf.toString('utf8').split('\n');
      } finally {
        fs.closeSync(fd);
      }
    }
    return fs.readFileSync(filePath, 'utf8').split('\n');
  } catch (_e) { return []; }
}

/**
 * Tally PM-emitted vs. backstop-emitted events for the 4 watched types.
 * Reads from the F2 archive when present, otherwise live events.jsonl.
 * If both exist, the archive wins (it's the immutable view).
 */
function tallyEvents(cwd, orchId) {
  const counts = {};
  for (const t of WATCHED_EVENT_TYPES) counts[t] = { pm: 0, backstop: 0 };

  const archivePath = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  const livePath    = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');

  let lines;
  if (fs.existsSync(archivePath)) {
    lines = readJsonlLines(archivePath);
  } else {
    lines = readJsonlLines(livePath);
  }

  for (const l of lines) {
    const trimmed = l.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); }
    catch (_e) { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (!Object.prototype.hasOwnProperty.call(counts, evt.type)) continue;
    if (orchId && evt.orchestration_id && evt.orchestration_id !== orchId) continue;
    if (evt.source === 'state_watcher_backstop') {
      counts[evt.type].backstop++;
    } else {
      counts[evt.type].pm++;
    }
  }

  return counts;
}

/**
 * v2.3.21 item 2: scan for PM-prose rows shaped `{event: "x", ...}` instead
 * of the canonical `{type: "x", ...}` — structurally invisible to
 * `tallyEvents()` since `evt.type` is undefined for them. Emits
 * `pm_emit_prose_rotting` (reusing the existing schema, no new event type
 * registered) with `wrong_field_shape: true` so operators can tell this
 * apart from ordinary ratio rot.
 *
 * Idempotent: a prior `wrong_field_shape` flag for the same event_type is
 * itself a well-shaped row (written via writeEvent), so it's visible on the
 * next scan and suppresses re-emission — no lock file needed.
 */
function scanMisshapenEmits(cwd, orchId) {
  if (process.env.ORCHESTRAY_MISSHAPEN_EMIT_SCAN_DISABLED === '1') return;
  if (!orchId) return;

  const archivePath = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  const livePath    = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  const lines = fs.existsSync(archivePath) ? readJsonlLines(archivePath) : readJsonlLines(livePath);

  const counts         = {}; // event-name -> count of misshapen rows
  const alreadyFlagged = new Set();

  for (const l of lines) {
    const trimmed = l.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); }
    catch (_e) { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (orchId && evt.orchestration_id && evt.orchestration_id !== orchId) continue;

    if (evt.type === 'pm_emit_prose_rotting' && evt.wrong_field_shape === true) {
      alreadyFlagged.add(evt.event_type);
      continue;
    }
    if (evt.type) continue; // well-shaped row — not our concern here
    if (typeof evt.event === 'string' && evt.event) {
      counts[evt.event] = (counts[evt.event] || 0) + 1;
    }
  }

  for (const eventName of Object.keys(counts)) {
    if (alreadyFlagged.has(eventName)) continue;
    try {
      writeEvent({
        version:           1,
        type:              'pm_emit_prose_rotting',
        event_type:        eventName,
        pm_count:          0,
        backstop_count:    0,
        ratio:             1,
        zero_emission:     true,
        wrong_field_shape: true,
        misshapen_count:   counts[eventName],
      }, { cwd });
    } catch (_e) { /* fail-open */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (isDisabled()) return;

  const cwd = resolveSafeCwd();
  const orchId = resolveOrchId(cwd);
  if (!orchId) return;

  let counts;
  try { counts = tallyEvents(cwd, orchId); }
  catch (e) {
    process.stderr.write('[audit-pm-emit-coverage] tally failed: ' + e.message + '\n');
    return;
  }

  for (const eventType of WATCHED_EVENT_TYPES) {
    const { pm, backstop } = counts[eventType];
    const total = pm + backstop;
    if (total < FLOOR_TOTAL_EVENTS) continue;
    const ratio = backstop / total;
    if (ratio <= ROT_THRESHOLD) continue;
    try {
      writeEvent({
        version:        1,
        type:           'pm_emit_prose_rotting',
        event_type:     eventType,
        pm_count:       pm,
        backstop_count: backstop,
        ratio,
      }, { cwd });
    } catch (_e) { /* fail-open */ }
  }

  // B6: emit orchestration_roi_missing when orchestration_roi absent in orch slice.
  try { checkOrchRoiPresence(cwd, orchId, readJsonlLines); }
  catch (_e) { /* fail-open */ }

  // W2-5: emit replan_budget_exceeded when w_item_redo_requested count exceeds budget.
  try { checkReplanBudget(cwd, orchId, readJsonlLines); }
  catch (_e) { /* fail-open */ }

  // v2.3.20 item 2: reconstruct missing oversized-input protocol events.
  try { checkOversizedInputCompleteness(cwd, orchId, readJsonlLines); }
  catch (_e) { /* fail-open */ }

  // v2.3.21 item 1: reconstruct state_cancel_aborted when the archived
  // directory exists but the manual emit was skipped.
  try { checkStateCancelCompleteness(cwd, orchId, readJsonlLines); }
  catch (_e) { /* fail-open */ }

  // v2.3.21 item 2: flag PM-prose rows shaped `event:` instead of `type:` —
  // invisible to the ratio check above regardless of its floor.
  try { scanMisshapenEmits(cwd, orchId); }
  catch (_e) { /* fail-open */ }

  // v2.3.20 item 4: catch dynamic-target types that resolved a trigger but
  // produced zero real events — the class the ratio floor above can't see.
  // Re-tally after checkOversizedInputCompleteness/checkOrchRoiPresence may
  // have appended new rows, so this reads the freshest count.
  try {
    const freshCounts = tallyEvents(cwd, orchId);
    checkDynamicTargetZeroEmission(cwd, orchId, freshCounts);
  } catch (_e) { /* fail-open */ }
}

// Always emit the continue envelope so the Stop hook chain is well-formed.
process.stdout.write(JSON.stringify({ continue: true }));

try { main(); }
catch (e) {
  process.stderr.write('[audit-pm-emit-coverage] uncaught: ' + (e && e.message) + '\n');
}

process.exit(0);
