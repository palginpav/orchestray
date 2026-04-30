#!/usr/bin/env node
'use strict';

/**
 * audit-dossier-orphan.js — Stop-hook tail (v2.2.9 B-3.3).
 *
 * Detects the v2.2.8 regression class: `dossier_written` rows landed for an
 * orchestration but no paired `dossier_injected` OR operator-relevant
 * `dossier_injection_skipped` row appeared. Emits
 * `dossier_write_without_inject_detected` per orphan orchestration.
 *
 * Pairing rule (per v2.2.9 B-3 spec):
 *   For each orchestration_id with write_count > 0, an orchestration is an
 *   orphan iff:
 *     inject_count == 0 AND
 *     no `dossier_injection_skipped` row exists with skip_reason ≠
 *       'kill_switch_set'
 *   (skips with skip_reason == 'kill_switch_set' represent operator-configured
 *   suppression — not a regression.)
 *
 * Source preference:
 *   1. `.orchestray/history/<orch_id>/events.jsonl` if F2 (per-orchestration
 *      archive) has landed.
 *   2. Fallback: filter `.orchestray/audit/events.jsonl` by orchestration_id.
 *
 * Contract:
 *   - Never throws (fail-open). Any error → `{ continue: true }` with no event.
 *   - Idempotent per orchestration: emits at most one
 *     `dossier_write_without_inject_detected` per orchestration_id per Stop
 *     hook invocation. (No persistent dedup — relies on the Stop hook firing
 *     once per orchestration close.)
 *   - Wired as a Stop-hook tail in `hooks/hooks.json`. Runs after the existing
 *     post-orchestration-extract-on-stop.js so any per-orch archive that
 *     lands first is consumed.
 *
 * Threshold escalator (v2.2.13 W6, G-08):
 *   When orphan detections for a given orchestration_id accumulate beyond a
 *   configurable threshold (default 5), `dossier_orphan_threshold_exceeded` is
 *   emitted ONCE — on the crossing event (count == threshold), not on every
 *   subsequent orphan. Counter persisted in:
 *     `.orchestray/state/dossier-orphan-counter.<orchestration_id>`
 *   Config override: `.orchestray/config.json` → `dossier_orphan_threshold`
 *   Kill switch: ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED=1 (default off).
 *
 * Kill switch: ORCHESTRAY_DOSSIER_ORPHAN_AUDIT_DISABLED=1 disables the
 * detector. Default-on.
 *
 * Design: v2.2.9 mechanisation plan §B-3.3, §E.5; W4 RCA-5.
 *         v2.2.13 mechanisation plan §5 W6 (P1-1 re-keyed on orchestration_id).
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

const KILL_SWITCH_REASON = 'kill_switch_set';

/**
 * Parse JSONL lines, ignoring malformed rows (best-effort).
 *
 * @param {string} content
 * @returns {object[]}
 */
function _parseJsonl(content) {
  const out = [];
  if (!content) return out;
  const lines = content.split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (_e) { /* skip malformed */ }
  }
  return out;
}

/**
 * Read events for a single orchestration, preferring the per-orch archive
 * (F2) if present. Falls back to filtering the live audit log.
 *
 * @param {string} cwd
 * @param {string} orchestrationId
 * @returns {{ events: object[], source: 'per_orch_archive'|'live_events_filter'|'none' }}
 */
function _readOrchestrationEvents(cwd, orchestrationId) {
  const archivePath = path.join(cwd, '.orchestray', 'history', orchestrationId, 'events.jsonl');
  if (_existsFile(archivePath)) {
    try {
      const content = fs.readFileSync(archivePath, 'utf8');
      return { events: _parseJsonl(content), source: 'per_orch_archive' };
    } catch (_e) { /* fall through to live */ }
  }

  const livePath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!_existsFile(livePath)) {
    return { events: [], source: 'none' };
  }
  try {
    const content = fs.readFileSync(livePath, 'utf8');
    const all = _parseJsonl(content);
    const filtered = all.filter((ev) => ev && ev.orchestration_id === orchestrationId);
    return { events: filtered, source: 'live_events_filter' };
  } catch (_e) {
    return { events: [], source: 'none' };
  }
}

/**
 * Tally write/inject/skip events for the supplied event list.
 *
 * @param {object[]} events
 * @returns {{
 *   write_count: number,
 *   inject_count: number,
 *   skip_count: number,
 *   kill_switch_skip_count: number,
 *   non_kill_switch_skip_count: number,
 * }}
 */
function tallyDossierEvents(events) {
  let writeCount = 0;
  let injectCount = 0;
  let skipCount = 0;
  let killSwitchSkipCount = 0;
  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    if (ev.type === 'dossier_written') {
      writeCount += 1;
    } else if (ev.type === 'dossier_injected') {
      injectCount += 1;
    } else if (ev.type === 'dossier_injection_skipped') {
      skipCount += 1;
      if (ev.skip_reason === KILL_SWITCH_REASON) killSwitchSkipCount += 1;
    }
  }
  return {
    write_count: writeCount,
    inject_count: injectCount,
    skip_count: skipCount,
    kill_switch_skip_count: killSwitchSkipCount,
    non_kill_switch_skip_count: skipCount - killSwitchSkipCount,
  };
}

/**
 * Decide whether a tally indicates an orphan write.
 *
 * Orphan iff: write_count > 0 AND inject_count == 0 AND
 *             non_kill_switch_skip_count == 0.
 *
 * @param {ReturnType<typeof tallyDossierEvents>} tally
 * @returns {boolean}
 */
function isOrphan(tally) {
  if (!tally || tally.write_count <= 0) return false;
  if (tally.inject_count > 0) return false;
  if (tally.non_kill_switch_skip_count > 0) return false;
  return true;
}

/**
 * Discover orchestration_ids that have at least one `dossier_written` row.
 * Looks at the live audit log (per-orch archives are derivative from the same
 * live log).
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function _findOrchestrationsWithDossierWrites(cwd) {
  const livePath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!_existsFile(livePath)) return [];
  let content;
  try {
    content = fs.readFileSync(livePath, 'utf8');
  } catch (_e) { return []; }
  const events = _parseJsonl(content);
  const ids = new Set();
  for (const ev of events) {
    if (ev && ev.type === 'dossier_written' && typeof ev.orchestration_id === 'string') {
      ids.add(ev.orchestration_id);
    }
  }
  return Array.from(ids);
}

function _existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_e) { return false; }
}

/**
 * Read the threshold from `.orchestray/config.json` → `dossier_orphan_threshold`.
 * Returns the default (5) on any read/parse failure.
 *
 * @param {string} cwd
 * @returns {number}
 */
function _readThreshold(cwd) {
  const DEFAULT = 5;
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.dossier_orphan_threshold === 'number' && cfg.dossier_orphan_threshold > 0) {
      return cfg.dossier_orphan_threshold;
    }
  } catch (_e) { /* fall through to default */ }
  return DEFAULT;
}

/**
 * Increment the per-orchestration orphan counter and emit
 * `dossier_orphan_threshold_exceeded` ONCE when the counter first crosses the
 * threshold (count === threshold). Subsequent orphans for the same
 * orchestration_id do NOT re-emit.
 *
 * No-op when:
 *   - orchId is falsy / empty
 *   - ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED=1 is set
 *
 * @param {string} cwd
 * @param {string} orchId
 */
function maybeEmitThreshold(cwd, orchId) {
  if (!orchId) return;
  if (process.env.ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED === '1') return;

  const threshold = _readThreshold(cwd);
  const counterPath = path.join(cwd, '.orchestray', 'state', `dossier-orphan-counter.${orchId}`);

  let count = 0;
  try {
    const raw = fs.readFileSync(counterPath, 'utf8').trim();
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed)) count = parsed;
  } catch (_e) { /* file absent — count starts at 0 */ }

  count += 1;

  try {
    fs.mkdirSync(path.dirname(counterPath), { recursive: true });
    fs.writeFileSync(counterPath, String(count), 'utf8');
  } catch (_e) { /* fail-open */ }

  if (count === threshold) {
    const payload = {
      type: 'dossier_orphan_threshold_exceeded',
      schema_version: 1,
      orchestration_id: orchId,
      count,
      threshold,
    };
    try {
      writeEvent(payload, { cwd });
    } catch (_e) { /* fail-open */ }
  }
}

/**
 * Run the orphan audit. Returns { orphans: [...], scanned: N, source_breakdown: {...} }.
 * Emits one `dossier_write_without_inject_detected` per orphan.
 *
 * @param {object} [opts] - { cwd?: string, orchestrationIds?: string[] }
 * @returns {{ orphans: object[], scanned: number, source_breakdown: object }}
 */
function runAudit(opts) {
  opts = opts || {};
  const cwd = resolveSafeCwd(opts.cwd);

  const ids = Array.isArray(opts.orchestrationIds) && opts.orchestrationIds.length > 0
    ? opts.orchestrationIds
    : _findOrchestrationsWithDossierWrites(cwd);

  const orphans = [];
  const sourceBreakdown = { per_orch_archive: 0, live_events_filter: 0, none: 0 };
  let scanned = 0;

  for (const orchId of ids) {
    scanned += 1;
    const { events, source } = _readOrchestrationEvents(cwd, orchId);
    sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;

    const tally = tallyDossierEvents(events);
    if (!isOrphan(tally)) continue;

    const payload = {
      type: 'dossier_write_without_inject_detected',
      version: 1,
      orchestration_id: orchId,
      write_count: tally.write_count,
      inject_count: tally.inject_count,
      skip_count: tally.skip_count,
      kill_switch_skip_count: tally.kill_switch_skip_count,
      archive_source: source,
    };
    try {
      writeEvent(payload, { cwd });
    } catch (_e) { /* fail-open */ }
    orphans.push(payload);

    // Threshold escalator: increment per-orch counter; emit once on crossing.
    maybeEmitThreshold(cwd, orchId);
  }

  return { orphans, scanned, source_breakdown: sourceBreakdown };
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    try { process.stdout.write(CONTINUE_RESPONSE); } catch (_e) {}
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      try {
        process.stderr.write('[audit-dossier-orphan] stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
        process.stdout.write(CONTINUE_RESPONSE + '\n');
      } catch (_e) {}
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      if (process.env.ORCHESTRAY_DOSSIER_ORPHAN_AUDIT_DISABLED === '1') {
        process.stdout.write(CONTINUE_RESPONSE + '\n');
        process.exit(0);
      }
      let event = {};
      try { event = JSON.parse(input || '{}'); } catch (_e) { event = {}; }
      runAudit({ cwd: event && event.cwd });
    } catch (_e) { /* fail-open */ }
    try { process.stdout.write(CONTINUE_RESPONSE + '\n'); } catch (_e) {}
    process.exit(0);
  });
}

module.exports = {
  runAudit,
  tallyDossierEvents,
  isOrphan,
  maybeEmitThreshold,
  _readOrchestrationEvents,
  _readThreshold,
  _parseJsonl,
};
