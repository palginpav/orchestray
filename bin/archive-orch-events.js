#!/usr/bin/env node
'use strict';

/**
 * archive-orch-events.js — per-orchestration events.jsonl archive (v2.2.9 F2).
 *
 * Why this exists
 * ---------------
 * Six downstream consumers (`replay-last-n.sh`, `watch-events.js`,
 * `audit-default-true-flags.js`, `mcp-server/lib/history_scan.js`,
 * `pattern-roi-aggregate.js`, `_lib/archetype-cache.js`) all expect a
 * per-orchestration archive at `.orchestray/history/<orch_id>/events.jsonl`.
 * Until v2.2.9 nothing wrote that archive, so `verify_fix_coverage_report`
 * fired ZERO times across 5 multi-task v2.2.8 orchestrations and three other
 * dark events stayed dark (W4 RCA-2, W3 G-10, W3 G-6).
 *
 * What it does
 * ------------
 * On every Stop hook fire, this script:
 *   1. Reads `.orchestray/audit/current-orchestration.json` for the active
 *      orchestration_id.
 *   2. Streams `.orchestray/audit/events.jsonl` line by line, parses each as
 *      JSON, and keeps lines where `orchestration_id === current_orch_id`.
 *   3. Writes the filtered slice atomically to
 *      `.orchestray/history/<orch_id>/events.jsonl` (tmp + rename).
 *   4. Emits `orchestration_events_archived` with `{orchestration_id,
 *      event_count, byte_size, archive_path}` via the central
 *      `audit-event-writer` gateway (so F1 autofill picks up version).
 *
 * Idempotency
 * -----------
 * Stop fires many times per orchestration. Each fire re-archives so the slice
 * grows with the live log. The archive becomes immutable only when the
 * ORCHESTRATION is officially complete: at that point a `.archived` marker
 * file is written next to the events.jsonl. If the marker exists on entry,
 * the script exits 0 silently with no event emit and no work.
 *
 * The marker is written when:
 *   - The current-orchestration marker file is missing (orchestration closed).
 *   - The events archive contains an `orchestration_complete` event for this
 *     orchestration_id.
 *
 * Atomicity
 * ---------
 * Write goes to `<archive_path>.tmp` then `fs.renameSync` swaps it in. POSIX
 * rename on the same filesystem is atomic. On any error the tmp file is
 * cleaned up (best-effort) so a partial archive never appears under the
 * canonical name.
 *
 * Kill switch
 * -----------
 * `ORCHESTRAY_ORCH_ARCHIVE_DISABLED=1` short-circuits the entire script.
 * Default-on per `feedback_default_on_shipping.md`.
 *
 * Fail-open contract
 * ------------------
 * Hooks must never block Claude Code. Every error path logs to stderr and
 * exits 0. The script never throws past the top-level try/catch.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { pruneOrphanedTaskState }      = require('./_lib/orchestration-state');
const { writeEvent }                  = require('./_lib/audit-event-writer');

/** Cap on live events.jsonl read size (defence against runaway growth). */
const MAX_LIVE_EVENTS_BYTES = 256 * 1024 * 1024; // 256 MB hard cap

// ---------------------------------------------------------------------------
// C4 (v2.3.10): append-safe size-based rotation of the LIVE events.jsonl.
//
// Live events.jsonl grew unbounded (audit measured 22.9 MB / 81k rows) because
// state-gc only touches history/. Past the metrics scan cap (32 MB), cost
// attribution silently degrades — i.e. unbounded growth actively degrades C2's
// resolver. We roll the live log when it crosses ROTATE_THRESHOLD_BYTES.
//
// APPEND-SAFETY: rotation is a single fs.renameSync(events.jsonl → .1). It
// NEVER truncates. Concurrent appenders use O_APPEND (atomicAppendJsonl):
//   - a writer that already holds an fd keeps writing to the same inode, which
//     is now named events.jsonl.1 — its line lands intact (no partial line, no
//     data loss);
//   - the next writer opens events.jsonl by path and the OS creates a fresh
//     file (append-create), so subsequent lines land in the new live log.
// Either way every append is whole. This coordinates with archive-orch-events'
// copy-only archival: archival reads a point-in-time snapshot, so a rotation
// between two archive fires simply means the next fire re-reads the (smaller)
// live log; the per-orch history slice is rebuilt idempotently from whatever
// remains plus is preserved in the rolled .1 file.
// ---------------------------------------------------------------------------

/** Roll the live log once it crosses this size. ~16 MB keeps us well under the 32 MB metrics scan cap. */
const ROTATE_THRESHOLD_BYTES = 16 * 1024 * 1024;

/** Number of rolled generations to retain (events.jsonl.1 .. .N). */
const ROTATE_KEEP = 3;

/** Orphaned state/tasks/ files older than this are pruned (belt-and-suspenders for C1). */
const TASK_STATE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Append-safe rotation. Returns { rotated, reason } and never throws.
 * Reads the configured threshold from env ORCHESTRAY_EVENTS_ROTATE_BYTES when
 * set (>0), else the built-in.
 */
function rotateLiveEvents(eventsPath) {
  let threshold = ROTATE_THRESHOLD_BYTES;
  const envVal = parseInt(process.env.ORCHESTRAY_EVENTS_ROTATE_BYTES, 10);
  if (!Number.isNaN(envVal) && envVal > 0) threshold = envVal;

  let st;
  try {
    st = fs.statSync(eventsPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { rotated: false, reason: 'no_live_log' };
    return { rotated: false, reason: 'stat_failed' };
  }
  if (st.size < threshold) return { rotated: false, reason: 'below_threshold' };

  // Shift older generations: .{N-1} → .N, … , .1 → .2. Best-effort.
  try {
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      const from = eventsPath + '.' + i;
      const to   = eventsPath + '.' + (i + 1);
      if (fs.existsSync(from)) {
        try { fs.renameSync(from, to); } catch (_e) { /* best-effort */ }
      }
    }
    // Atomic single rename. No truncation — O_APPEND writers stay consistent.
    fs.renameSync(eventsPath, eventsPath + '.1');
    return { rotated: true, reason: 'rotated', size_bytes: st.size, threshold };
  } catch (e) {
    return { rotated: false, reason: 'rename_failed', err: e && e.message };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the current-orchestration marker. Returns the orchestration_id or
 * null when the marker is missing/unparseable. The "missing" return is the
 * normal post-close state and is NOT an error.
 */
function readCurrentOrchestrationId(cwd) {
  const file = getCurrentOrchestrationFile(cwd);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    process.stderr.write(`archive-orch-events: read current-orchestration failed: ${e.message}\n`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.orchestration_id === 'string' && parsed.orchestration_id.length > 0) {
      return parsed.orchestration_id;
    }
  } catch (e) {
    process.stderr.write(`archive-orch-events: parse current-orchestration failed: ${e.message}\n`);
  }
  return null;
}

/**
 * Filter the live events.jsonl by orchestration_id. Returns a Buffer
 * containing the matching lines (each terminated with '\n') and the
 * matching event count.
 *
 * Streams line-by-line via fs.readFileSync (Node lacks a sync line iterator;
 * for our 256 MB cap a single read is fine and we already have a 5 MB cap
 * elsewhere in the codebase). Malformed JSON lines are skipped silently.
 */
function filterEventsByOrchId(eventsPath, orchId) {
  let stat;
  try {
    stat = fs.statSync(eventsPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { buf: Buffer.alloc(0), count: 0, sawComplete: false };
    throw e;
  }
  if (stat.size === 0) return { buf: Buffer.alloc(0), count: 0, sawComplete: false };
  if (stat.size > MAX_LIVE_EVENTS_BYTES) {
    process.stderr.write(`archive-orch-events: events.jsonl exceeds ${MAX_LIVE_EVENTS_BYTES} bytes (${stat.size}); skipping\n`);
    return { buf: Buffer.alloc(0), count: 0, sawComplete: false };
  }

  const text = fs.readFileSync(eventsPath, 'utf8');
  const out  = [];
  let count  = 0;
  let sawComplete = false;
  // Cheap substring pre-filter. If the orch_id never appears, skip the JSON
  // parse loop entirely.
  if (text.indexOf(orchId) === -1) return { buf: Buffer.alloc(0), count: 0, sawComplete: false };

  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.indexOf(orchId) === -1) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (_e) {
      continue; // skip malformed line
    }
    if (parsed && parsed.orchestration_id === orchId) {
      out.push(line);
      count += 1;
      if (parsed.type === 'orchestration_complete' || parsed.event_type === 'orchestration_complete') {
        sawComplete = true;
      }
    }
  }
  if (count === 0) return { buf: Buffer.alloc(0), count: 0, sawComplete: false };
  const joined = out.join('\n') + '\n';
  return { buf: Buffer.from(joined, 'utf8'), count, sawComplete };
}

/**
 * Atomic write. tmp + rename. Returns true on success, false on error.
 */
function atomicWrite(targetPath, buf) {
  const dir    = path.dirname(targetPath);
  const tmp    = targetPath + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    process.stderr.write(`archive-orch-events: mkdir ${dir} failed: ${e.message}\n`);
    return false;
  }
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, targetPath);
    return true;
  } catch (e) {
    process.stderr.write(`archive-orch-events: write ${targetPath} failed: ${e.message}\n`);
    try { fs.unlinkSync(tmp); } catch (_e) { /* best-effort cleanup */ }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Kill switch.
  if (process.env.ORCHESTRAY_ORCH_ARCHIVE_DISABLED === '1') {
    return 0;
  }

  // Hook payload may carry { cwd } via stdin. Read non-blocking; the helper
  // falls back to process.cwd() if no payload is provided.
  let payload = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = fs.readFileSync(0, 'utf8');
      if (raw && raw.trim().length > 0) {
        payload = JSON.parse(raw);
      }
    }
  } catch (_e) { /* fail-open */ }

  const cwd = resolveSafeCwd(payload && payload.cwd);
  const orchId = readCurrentOrchestrationId(cwd);

  // Resolve archive paths regardless of whether orchestration is active so
  // we can finalize a freshly-closed orchestration on its terminal Stop.
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');

  // No active orchestration AND no recently-closed unfinalized archive →
  // nothing to archive. Still run C4 housekeeping: between orchestrations is the
  // SAFEST time to roll the live log (no active orch's lines are at risk of
  // being missed by an in-flight archive) and to prune orphaned task state.
  if (!orchId) {
    runHousekeeping(cwd, null);
    return 0;
  }

  const archiveDir   = path.join(cwd, '.orchestray', 'history', orchId);
  const archivePath  = path.join(archiveDir, 'events.jsonl');
  const markerPath   = path.join(archiveDir, '.archived');

  // Idempotent fast-path: archive is frozen, exit silently.
  if (fs.existsSync(markerPath)) {
    return 0;
  }

  // Filter live events.jsonl by orchestration_id.
  let result;
  try {
    result = filterEventsByOrchId(eventsPath, orchId);
  } catch (e) {
    process.stderr.write(`archive-orch-events: filter failed: ${e.message}\n`);
    return 0;
  }

  if (result.count === 0) {
    // Nothing for this orchestration_id in the live log. Could be a brand-new
    // orchestration whose events haven't landed yet. Exit silently.
    return 0;
  }

  // Atomic write.
  if (!atomicWrite(archivePath, result.buf)) {
    return 0;
  }

  // If we saw the orchestration_complete event in the live log, freeze the
  // archive by writing the .archived marker. Subsequent Stop fires become
  // idempotent no-ops.
  if (result.sawComplete) {
    try {
      fs.writeFileSync(markerPath, new Date().toISOString() + '\n', { mode: 0o600 });
    } catch (e) {
      process.stderr.write(`archive-orch-events: marker write failed: ${e.message}\n`);
      // Continue — the archive itself is committed.
    }
  }

  // Emit telemetry. F1 autofill picks up `version` from the schema shadow.
  const byteSize = result.buf.length;
  try {
    writeEvent({
      type:             'orchestration_events_archived',
      version:          1,
      orchestration_id: orchId,
      event_count:      result.count,
      byte_size:        byteSize,
      archive_path:     archivePath,
    }, { cwd });
  } catch (e) {
    process.stderr.write(`archive-orch-events: emit failed: ${e.message}\n`);
  }

  // C4: housekeeping AFTER the archive copy committed for this fire, so the
  // current orch's lines are safely in history before we may roll the live log.
  runHousekeeping(cwd, orchId);

  return 0;
}

/**
 * C4 (v2.3.10): rotate the oversized live events.jsonl (append-safe) and prune
 * orphaned state/tasks/ leftovers. Best-effort; never throws. Emits a small
 * `events_log_rotated` audit row when a roll happened (post-rotation, into the
 * fresh live log) for observability.
 *
 * @param {string} cwd
 * @param {string|null} orchId
 */
function runHousekeeping(cwd, orchId) {
  if (process.env.ORCHESTRAY_EVENTS_ROTATE_DISABLED !== '1') {
    try {
      const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
      const r = rotateLiveEvents(eventsPath);
      if (r.rotated) {
        // Emit into the now-fresh live log so the rotation itself is auditable.
        try {
          writeEvent({
            type:             'events_log_rotated',
            version:          1,
            orchestration_id: orchId || 'unknown',
            rolled_bytes:     r.size_bytes,
            threshold_bytes:  r.threshold,
            target:           eventsPath + '.1',
          }, { cwd });
        } catch (_e) { /* fail-open */ }
      }
    } catch (e) {
      process.stderr.write(`archive-orch-events: rotation failed: ${e && e.message}\n`);
    }
  }

  if (process.env.ORCHESTRAY_TASK_PRUNE_DISABLED !== '1') {
    try {
      pruneOrphanedTaskState(cwd, TASK_STATE_TTL_MS);
    } catch (e) {
      process.stderr.write(`archive-orch-events: task prune failed: ${e && e.message}\n`);
    }
  }
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`archive-orch-events: top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
}

module.exports = { main, rotateLiveEvents, runHousekeeping, ROTATE_THRESHOLD_BYTES };
