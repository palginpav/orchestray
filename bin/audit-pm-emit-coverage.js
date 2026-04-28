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
 * happens to produce a single backstop emit.
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

const WATCHED_EVENT_TYPES = [
  'tier2_invoked',
  'pattern_roi_snapshot',
  'verify_fix_start',
  'consequence_forecast',
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
}

// Always emit the continue envelope so the Stop hook chain is well-formed.
process.stdout.write(JSON.stringify({ continue: true }));

try { main(); }
catch (e) {
  process.stderr.write('[audit-pm-emit-coverage] uncaught: ' + (e && e.message) + '\n');
}

process.exit(0);
