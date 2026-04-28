#!/usr/bin/env node
'use strict';

/**
 * post-orchestration-extract-on-stop.js — Stop-hook wrapper for auto-extraction.
 *
 * Why this exists
 * ---------------
 * `post-orchestration-extract.js` is wired only to `PreCompact`. Short release-style
 * orchestrations complete without triggering context compaction, so the Haiku
 * extractor never fires — auto-learning produces zero proposals despite being enabled.
 *
 * This wrapper runs on `Stop`. By the time Stop fires, the PM has already written
 * the `orchestration_complete` event AND archived `.orchestray/audit/events.jsonl`
 * to `.orchestray/history/{timestamp}/events.jsonl`, and deleted the live
 * `current-orchestration.json`. So we can't reuse the PreCompact entrypoint as-is —
 * it reads the current-orchestration marker which has already been removed.
 *
 * Strategy
 * --------
 *   1. Scan `.orchestray/history/*` for the most recent subdir (by mtime).
 *   2. Require: mtime within last 15 minutes, events.jsonl contains a
 *      `orchestration_complete` event, and no sibling `.extracted` marker.
 *   3. Extract `orchestration_id` from the archive's `orchestration_start` event.
 *   4. Write a temporary synthetic `current-orchestration.json` inside the archive
 *      directory so `runExtraction()` can scope events correctly.
 *   5. Call `runExtraction()` from `post-orchestration-extract.js` (reuses all the
 *      kill-switches, circuit breaker, quarantine, validator, and proposal writer).
 *   6. Touch `.extracted` so repeat Stop events (e.g. subsequent PM turns on the
 *      same archive) don't re-run extraction.
 *
 * Fail-open: every error path records a degraded-journal entry and exits 0.
 *
 * v2.1.8+ — follow-up to "auto-learning inert" diagnosis.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { runExtraction }    = require('./post-orchestration-extract');
const { resolveSafeCwd }   = require('./_lib/resolve-project-cwd');
const { recordDegradation } = require('./_lib/degraded-journal');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { emitTier2Invoked }  = require('./_lib/tier2-invoked-emitter');
const { runCoverageProbe }  = require('./_lib/tokenwright/coverage-probe');
const { emitTokenwrightSpawnCoverage } = require('./_lib/tokenwright/emit');
const { runVerifyFixCoverageProbe } = require('./_lib/verify-fix-coverage');
const { writeEvent } = require('./_lib/audit-event-writer');

/** Only consider history archives newer than this (ms). 15 minutes. */
const FRESH_ARCHIVE_WINDOW_MS = 15 * 60 * 1000;

/** Cap on per-events.jsonl read size during the orchestration_complete scan. */
const MAX_EVENTS_SCAN_BYTES = 10 * 1024 * 1024;

/**
 * Find a history archive that just completed and has not yet been extracted.
 *
 * @param {string} projectRoot
 * @returns {{archiveDir:string,eventsPath:string,markerPath:string,orchId:string}|null}
 */
function findFreshArchive(projectRoot) {
  const historyDir = path.join(projectRoot, '.orchestray', 'history');
  let entries;
  try {
    entries = fs.readdirSync(historyDir, { withFileTypes: true });
  } catch (_e) {
    return null;
  }

  const candidates = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(historyDir, e.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    candidates.push({ name: e.name, path: full, mtime: st.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);

  const now = Date.now();
  for (const c of candidates) {
    if (now - c.mtime > FRESH_ARCHIVE_WINDOW_MS) return null; // sorted — all older from here
    const eventsPath = path.join(c.path, 'events.jsonl');
    const markerPath = path.join(c.path, '.extracted');
    if (fs.existsSync(markerPath)) continue;
    let stat;
    try { stat = fs.statSync(eventsPath); } catch { continue; }
    if (stat.size === 0 || stat.size > MAX_EVENTS_SCAN_BYTES) continue;

    let text;
    try { text = fs.readFileSync(eventsPath, 'utf8'); } catch { continue; }
    // Cheap string scan first, JSON parse second (only if substring hits).
    if (text.indexOf('orchestration_complete') === -1) continue;

    let orchId = null;
    let sawComplete = false;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      if (!orchId && ev.orchestration_id) orchId = ev.orchestration_id;
      const kind = ev.event || ev.type;
      if (kind === 'orchestration_complete') sawComplete = true;
    }
    if (!sawComplete || !orchId) continue;

    return { archiveDir: c.path, eventsPath, markerPath, orchId };
  }
  return null;
}

/**
 * Run extraction on a fresh archive; idempotent via `.extracted` marker.
 *
 * @param {string} projectRoot
 */
function processStop(projectRoot) {
  const fresh = findFreshArchive(projectRoot);
  if (!fresh) return; // nothing to do

  // Synthetic current-orchestration.json — kept inside the archive dir so it
  // gets cleaned up with the archive and never collides with the live marker.
  const synthOrchFile = path.join(fresh.archiveDir, '.current-orchestration.synthetic.json');
  try {
    fs.writeFileSync(
      synthOrchFile,
      JSON.stringify({ orchestration_id: fresh.orchId }),
      'utf8'
    );
  } catch (err) {
    recordDegradation({
      kind: 'config_load_failed',
      severity: 'warn',
      detail: {
        reason: 'post_orch_stop_synth_write_failed',
        error: err && err.message ? err.message.slice(0, 80) : 'unknown',
      },
      projectRoot,
    });
    return;
  }

  // R-TGATE (v2.1.14): emit tier2_invoked for pattern_extraction protocol.
  try {
    emitTier2Invoked({
      cwd: projectRoot,
      protocol: 'pattern_extraction',
      trigger_signal: 'post-orchestration auto-extraction triggered on Stop',
    });
  } catch (_te) { /* fail-open */ }

  try {
    runExtraction({
      projectRoot,
      eventsPath:   fresh.eventsPath,
      orchFilePath: synthOrchFile,
    });
  } catch (err) {
    recordDegradation({
      kind: 'config_load_failed',
      severity: 'warn',
      detail: {
        reason: 'post_orch_stop_runExtraction_threw',
        error: err && err.message ? err.message.slice(0, 80) : 'unknown',
      },
      projectRoot,
    });
  } finally {
    try { fs.unlinkSync(synthOrchFile); } catch {}
    // Mark regardless of outcome: re-running on the same archive is pointless
    // whether extraction succeeded, was kill-switched, or was breaker-tripped.
    try {
      fs.writeFileSync(fresh.markerPath, new Date().toISOString() + '\n', 'utf8');
    } catch {}
  }

  // v2.2.6: tokenwright spawn coverage probe.
  // Reads the archived events.jsonl for this orchestration, computes coverage
  // metrics, and emits a `tokenwright_spawn_coverage` event to the live audit log.
  // This runs AFTER extraction to avoid any ordering conflicts with the extract pass.
  // Kill-switches honored: config compression.coverage_probe_enabled === false
  // or ORCHESTRAY_DISABLE_COVERAGE_PROBE=1.
  if (fresh.orchId) {
    try {
      // Kill-switch: env var
      if (process.env.ORCHESTRAY_DISABLE_COVERAGE_PROBE !== '1') {
        // Kill-switch: config
        let coverageEnabled = true;
        try {
          const cfgPath = path.join(projectRoot, '.orchestray', 'config.json');
          if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (cfg && cfg.compression && cfg.compression.coverage_probe_enabled === false) {
              coverageEnabled = false;
            }
          }
        } catch (_e) { /* config unreadable — proceed */ }

        if (coverageEnabled) {
          const coverage = runCoverageProbe({
            orchestrationId: fresh.orchId,
            eventsPath:      fresh.eventsPath,
          });
          emitTokenwrightSpawnCoverage(coverage);
        }
      }
    } catch (e) {
      // Fail-safe: don't block the stop hook
      console.error('[post-orch] coverage probe failed:', e && e.message ? e.message : String(e));
    }
  }

  // v2.2.8 Item 2: verify-fix coverage report.
  // Reads archived events.jsonl, counts developer/refactorer agent_starts vs
  // verify_fix_start events, and emits `verify_fix_coverage_report`.
  // Kill-switches honored:
  //   env:    ORCHESTRAY_DISABLE_VERIFY_FIX_COVERAGE=1
  //   config: verify_fix.coverage_report.enabled === false
  if (fresh.orchId) {
    try {
      if (process.env.ORCHESTRAY_DISABLE_VERIFY_FIX_COVERAGE !== '1') {
        let vfEnabled = true;
        try {
          const cfgPath = path.join(projectRoot, '.orchestray', 'config.json');
          if (fs.existsSync(cfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
            if (
              cfg &&
              cfg.verify_fix &&
              cfg.verify_fix.coverage_report &&
              cfg.verify_fix.coverage_report.enabled === false
            ) {
              vfEnabled = false;
            }
          }
        } catch (_e) { /* config unreadable — proceed */ }

        if (vfEnabled) {
          const vfReport = runVerifyFixCoverageProbe({
            orchestrationId: fresh.orchId,
            eventsPath:      fresh.eventsPath,
          });
          try {
            writeEvent(vfReport);
          } catch (we) {
            console.error('[post-orch] verify-fix coverage emit failed:', we && we.message ? we.message : String(we));
          }
        }
      }
    } catch (e) {
      // Fail-safe: don't block the stop hook
      console.error('[post-orch] verify-fix coverage probe failed:', e && e.message ? e.message : String(e));
    }
  }
}

// ---------------------------------------------------------------------------
// Hook entrypoint
// ---------------------------------------------------------------------------

module.exports = { findFreshArchive, processStop };

if (require.main === module) {
  let input = '';
  const finish = () => {
    try {
      let event = {};
      if (input.trim()) {
        try { event = JSON.parse(input); } catch { event = {}; }
      }
      const projectRoot =
        process.env.ORCHESTRAY_PROJECT_ROOT ||
        resolveSafeCwd(event && event.cwd);
      processStop(projectRoot);
    } catch (err) {
      try {
        recordDegradation({
          kind: 'config_load_failed',
          severity: 'warn',
          detail: {
            reason: 'post_orch_stop_uncaught',
            error: err && err.message ? err.message.slice(0, 80) : 'unknown',
          },
        });
      } catch {}
    }
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('error', finish);
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write(
        '[orchestray] post-orchestration-extract-on-stop: stdin exceeded ' +
        MAX_INPUT_BYTES + ' bytes; aborting\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', finish);
}
