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
const { writeEvent }                  = require('./_lib/audit-event-writer');

/** Cap on live events.jsonl read size (defence against runaway growth). */
const MAX_LIVE_EVENTS_BYTES = 256 * 1024 * 1024; // 256 MB hard cap

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
  // nothing to do. The historical-finalization path below uses the most
  // recent history dir so we don't lose the close-fire.
  if (!orchId) {
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

  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`archive-orch-events: top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
}

module.exports = { main };
