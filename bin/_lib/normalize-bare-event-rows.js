#!/usr/bin/env node
'use strict';

/**
 * normalize-bare-event-rows.js — repairs audit rows written with a bare
 * `event` key instead of the canonical `type` key.
 *
 * Background
 * ----------
 * Every consumer of `.orchestray/audit/events.jsonl` keys on `type` (see
 * `bin/_lib/audit-event-writer.js`, THE single sanctioned emit gateway).
 * `bin/audit-pm-emit-coverage.js`'s `computeMisshapenEmits` scanner DETECTS
 * rows shaped `{event: "x", ...}` instead of `{type: "x", ...}` —
 * live evidence found 46 such rows, all hand-appended via raw Bash (the
 * sanctioned `bin/ox.js events append` path already rejects `event` as a
 * reserved key). See `.orchestray/kb/decisions/bare-event-key-hand-appends.md`
 * for the investigation. That scanner deliberately never mutates a row (it is
 * a read-only detector); this module is the separate REPAIR half.
 *
 * What this module does
 * ----------------------
 *   1. `classifyLine(rawLine)` — pure per-line classifier: unchanged,
 *      malformed, both-keys-present, or backfillable.
 *   2. `normalizeEventsFile(filePath, opts)` — streaming (constant-memory,
 *      chunked fd reads) rewrite of ONE JSONL file. Every row that is not a
 *      bare-`event` row passes through byte-for-byte untouched, INCLUDING a
 *      missing final newline (a crash-shape source file that does not end in
 *      `\n` stays that way in the output — see the quiescence note below, the
 *      trailing byte is never invented). A bare-`event` row has its `event`
 *      key renamed to `type` in place (same key order, same value, all other
 *      fields untouched). A row carrying BOTH `event` and `type` is left
 *      alone and reported — never guessed at. Malformed JSON lines are left
 *      alone and counted. No-op (no backup, no write) when nothing needs to
 *      change — this is what makes a second run idempotent. When a change IS
 *      needed: after the read loop reaches apparent EOF, the source is
 *      re-`fs.statSync`'d and drained again if it grew, repeated until a full
 *      `QUIESCENT_IDLE_MS` span passes with no further growth (bounded — see
 *      `MAX_QUIESCENCE_WAIT_MS`). Only then is a timestamped backup taken, the
 *      rewrite landed in a pid+timestamp-stamped tmp file, and the tmp file
 *      swapped in via `fs.renameSync` (atomic on the same filesystem — but
 *      atomicity of the swap was never the gap; a writer appending between
 *      "read loop hit EOF" and "rename" used to have its row silently
 *      discarded by the swap, since the swap picked up a stale snapshot. The
 *      quiescence drain closes that window; see
 *      `.orchestray/kb/decisions/` for the v2.3.21 fix writeup and its
 *      concurrent-writer regression test in
 *      `bin/_lib/__tests__/normalize-bare-event-rows.test.js`).
 *   3. `repairBareEventRows(cwd, opts)` — the automatic-repair entry point.
 *      Scoped to the LIVE log only (`.orchestray/audit/events.jsonl`) — the
 *      46 real rows all landed there, and rotated generations
 *      (`events.N.jsonl`) are frozen history the way `computeMisshapenEmits`
 *      already treats `.orchestray/history/**`: not something a periodic
 *      repair needs to reach into. Emits `bare_event_key_repaired` when it
 *      backfills anything, and `bare_event_key_both_present` when it finds
 *      the leave-alone case, so both outcomes are visible in events.jsonl
 *      rather than only in a return value nobody reads.
 *
 *      High-water-mark fast path (v2.3.21): a full `normalizeEventsFile`
 *      pass reads and re-writes the ENTIRE file even when nothing changes
 *      (measured 509ms on a 45MB log) — and since this runs on every
 *      SessionStart, that cost recurred forever even though the defect class
 *      it guards against is already prevented at the sanctioned emit source.
 *      `repairBareEventRows` now persists the byte offset it has already
 *      confirmed clean (`HIGHWATER_REL_PATH`) and, on the next call, only
 *      classifies the bytes appended since — via the read-only
 *      `classifyRange()` helper, which never opens a tmp file. The full
 *      rewrite still runs (unconditionally, at full correctness) whenever
 *      that cheap delta scan finds a genuinely new backfillable row. A
 *      both-keys row never needs a rewrite (it is never mutated), so its
 *      presence alone no longer forces one either — its count/types simply
 *      accumulate into the persisted state so `bothKeysCount` keeps
 *      reflecting the whole file, not just the delta.
 *
 * Kill switch (env + config key, matching the misshapen scanner's own
 * `ORCHESTRAY_MISSHAPEN_EMIT_SCAN_DISABLED` convention):
 *   - `ORCHESTRAY_BARE_EVENT_REPAIR_DISABLED=1`
 *   - `.orchestray/config.json` → `{"bare_event_key_repair": {"enabled": false}}`
 *   Default-on per `feedback_default_on_shipping.md` — fail-open to enabled
 *   on any read/parse error, same as `audit-housekeeper-drift.js`'s
 *   `loadConfigEnabled`.
 *
 * Fail-open contract
 * -------------------
 * `normalizeEventsFile`/`repairBareEventRows` DO throw on genuine I/O failure
 * (backup or rename failing partway through a change) so a CLI caller or test
 * can see the real error. The automatic caller — `bin/dark-event-banner.js`'s
 * SessionStart handler — is what wraps the call in try/catch so a repair
 * failure never blocks Claude Code; this module intentionally does not
 * swallow its own errors, since the CLI entry below relies on seeing them.
 * The high-water-mark state file (`HIGHWATER_REL_PATH`) is pure perf cache —
 * a failed read or write of it always fails open to "do a full rescan",
 * never to "skip a needed repair".
 */

const fs = require('node:fs');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const { writeEvent } = require('./audit-event-writer');

const EVENTS_REL_PATH = path.join('.orchestray', 'audit', 'events.jsonl');
const DEFAULT_CHUNK_BYTES = 1 * 1024 * 1024; // 1 MiB — constant-memory streaming

const ENV_DISABLED = 'ORCHESTRAY_BARE_EVENT_REPAIR_DISABLED';

// Race-fix (v2.3.21): after the read loop hits apparent EOF, keep re-checking
// whether the source grew before committing to backup+rename. A writer that
// pauses briefly BETWEEN appends (any batching/throttling shape, not just a
// single instantaneous write) can fool a naive "two consecutive same-size
// stats" check — two samples can both land inside the same short pause. The
// gate below instead requires a full QUIESCENT_IDLE_MS *span* of continuous
// non-growth (reset to zero the instant any growth is observed), which a
// brief inter-batch pause cannot satisfy. The whole quiescence phase is
// still bounded by MAX_QUIESCENCE_WAIT_MS so a sustained write storm cannot
// hang the caller indefinitely — it proceeds with whatever was captured.
const QUIESCENT_IDLE_MS = 25;
const QUIESCENCE_POLL_MS = 3;
const MAX_QUIESCENCE_WAIT_MS = 500;

// High-water-mark fast path (v2.3.21) — see header note 3.
const HIGHWATER_REL_PATH = path.join('.orchestray', 'state', 'bare-event-scan-highwater.json');
// Above this delta size, classifyRange's benefit over just re-running the
// full (already-correct) normalizeEventsFile pass is marginal — skip the
// bookkeeping and fall back to a full rescan rather than add complexity for
// a case that should not occur in steady state (repair disabled for a long
// stretch, or a very bursty hand-append session).
const MAX_FAST_PATH_DELTA_BYTES = 16 * 1024 * 1024;

/**
 * Short synchronous pause between quiescence-check rounds. Mirrors
 * `atomic-append.js`'s `sleepMs` — duplicated locally rather than imported to
 * keep this module's dependency surface unchanged (fs/path/StringDecoder/
 * writeEvent only).
 */
function _sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_e) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* spin */ }
  }
}

// ---------------------------------------------------------------------------
// Per-line classification
// ---------------------------------------------------------------------------

/**
 * Classify one raw JSONL line (no trailing newline).
 *
 * @param {string} rawLine
 * @returns {{kind: 'unchanged'|'malformed'|'both_keys'|'backfill', line: string, eventType?: string}}
 */
function classifyLine(rawLine) {
  if (rawLine.trim() === '') {
    return { kind: 'unchanged', line: rawLine };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawLine);
  } catch (_e) {
    return { kind: 'malformed', line: rawLine };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unchanged', line: rawLine };
  }

  const hasType = Object.prototype.hasOwnProperty.call(parsed, 'type');
  const hasEvent = Object.prototype.hasOwnProperty.call(parsed, 'event')
    && typeof parsed.event === 'string' && parsed.event.length > 0;

  if (!hasEvent) {
    return { kind: 'unchanged', line: rawLine };
  }
  if (hasType) {
    // Both keys present — never guess which one is authoritative. Leave the
    // row exactly as it is and let the caller report it.
    return { kind: 'both_keys', line: rawLine, eventType: parsed.type };
  }

  // Bare `event`, no `type` — rename the key in place, preserving field order
  // and every other field exactly.
  const next = {};
  for (const key of Object.keys(parsed)) {
    if (key === 'event') next.type = parsed.event;
    else next[key] = parsed[key];
  }
  return { kind: 'backfill', line: JSON.stringify(next), eventType: parsed.event };
}

// ---------------------------------------------------------------------------
// Streaming file rewrite
// ---------------------------------------------------------------------------

/**
 * Streaming, constant-memory backfill of one JSONL file: bare `event` keys
 * become `type`, every other row is copied through byte-for-byte.
 *
 * @param {string} filePath
 * @param {{dryRun?: boolean, chunkBytes?: number}} [opts]
 * @returns {{
 *   filePath: string, existed: boolean, changed: boolean, dryRun: boolean,
 *   backfilled: number, bothKeysCount: number, malformedCount: number,
 *   totalLines: number, backupPath: string|null, bothKeysEventTypes: string[],
 * }}
 * @throws on I/O failure while a change is actually being committed (backup
 *   or atomic rename). No-op reads (nothing to change, or the file is
 *   missing/unreadable) never throw — see the header's fail-open contract.
 */
function normalizeEventsFile(filePath, opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const chunkBytes = opts.chunkBytes || DEFAULT_CHUNK_BYTES;

  const summary = {
    filePath,
    existed: false,
    changed: false,
    dryRun,
    backfilled: 0,
    bothKeysCount: 0,
    malformedCount: 0,
    totalLines: 0,
    backupPath: null,
    bothKeysEventTypes: [],
  };

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_e) {
    return summary; // missing — no-op
  }
  if (!stat.isFile() || stat.size === 0) {
    summary.existed = stat.isFile();
    return summary; // empty (or not a regular file) — no-op
  }
  summary.existed = true;

  const tmpPath = filePath + '.tmp.' + process.pid + '.' + Date.now();

  let readFd;
  try {
    readFd = fs.openSync(filePath, 'r');
  } catch (_e) {
    return summary; // unreadable — fail-open no-op
  }

  let writeFd;
  try {
    writeFd = fs.openSync(tmpPath, 'w');
  } catch (_e) {
    try { fs.closeSync(readFd); } catch (_e2) { /* ignore */ }
    return summary; // can't stage a tmp file — fail-open no-op
  }

  // suffix is '\n' for every real line except the very final one, and only
  // then when the SOURCE itself had no trailing newline (a crash-shape file)
  // — see the trailing-newline fidelity fix, v2.3.21 fix 5.
  const processLine = (rawLine, suffix) => {
    summary.totalLines++;
    const plan = classifyLine(rawLine);
    if (plan.kind === 'backfill') {
      summary.backfilled++;
      fs.writeSync(writeFd, plan.line + suffix);
    } else if (plan.kind === 'both_keys') {
      summary.bothKeysCount++;
      summary.bothKeysEventTypes.push(plan.eventType);
      fs.writeSync(writeFd, rawLine + suffix);
    } else if (plan.kind === 'malformed') {
      summary.malformedCount++;
      fs.writeSync(writeFd, rawLine + suffix);
    } else {
      fs.writeSync(writeFd, rawLine + suffix);
    }
  };

  const decoder = new StringDecoder('utf8');
  const buf = Buffer.alloc(chunkBytes);
  let leftover = '';
  let readError = null;
  let pos = 0; // explicit read position — lets the quiescence check below
               // compare "bytes we've consumed" against a fresh fs.statSync
               // without depending on an implicit fd cursor.

  // Drain everything currently available from `pos` to the fd's live EOF.
  // Called once up front, then again by the quiescence loop below whenever a
  // re-stat shows the source grew since the last drain.
  const drainAvailable = () => {
    for (;;) {
      let bytesRead;
      try {
        bytesRead = fs.readSync(readFd, buf, 0, chunkBytes, pos);
      } catch (e) {
        readError = e;
        return;
      }
      if (bytesRead === 0) return;
      pos += bytesRead;
      // StringDecoder buffers any trailing partial multi-byte UTF-8 sequence
      // across chunk boundaries so a split character never corrupts a line.
      const text = leftover + decoder.write(buf.slice(0, bytesRead));
      const lines = text.split('\n');
      leftover = lines.pop();
      for (const line of lines) processLine(line, '\n');
    }
  };

  try {
    drainAvailable();

    // Race fix (v2.3.21, fix 1): the read loop above stops the instant a
    // read returns 0 bytes, i.e. "apparent EOF". A writer that appends
    // between that moment and the eventual backup+rename below used to have
    // its row silently discarded — the rename swaps in a stale snapshot, not
    // a corrupt one, so nothing LOOKED wrong. Re-stat and keep draining until
    // a full QUIESCENT_IDLE_MS span has passed with no growth (bounded by
    // MAX_QUIESCENCE_WAIT_MS so a sustained write storm cannot hang the
    // caller forever).
    if (!readError) {
      const quiescenceDeadline = Date.now() + MAX_QUIESCENCE_WAIT_MS;
      let idleSinceMs = Date.now();
      for (;;) {
        if (Date.now() - idleSinceMs >= QUIESCENT_IDLE_MS) break; // confirmed quiescent
        if (Date.now() >= quiescenceDeadline) break; // bounded — proceed with what we've captured
        if (readError) break;

        let curSize;
        try {
          curSize = fs.statSync(filePath).size;
        } catch (_e) {
          break; // source vanished mid-scan — proceed with what we've captured
        }
        if (curSize > pos) {
          idleSinceMs = Date.now(); // growth resets the idle span from scratch
          drainAvailable();
        } else {
          _sleepMs(QUIESCENCE_POLL_MS);
        }
      }
    }

    if (!readError) {
      leftover += decoder.end();
      // A non-empty leftover here means the source's final line was NOT
      // newline-terminated (a crash-shape file) — preserve that exactly
      // instead of inventing a trailing `\n` the source never had.
      if (leftover.length > 0) processLine(leftover, '');
    }
  } finally {
    try { fs.closeSync(readFd); } catch (_e) { /* ignore */ }
    try { fs.closeSync(writeFd); } catch (_e) { /* ignore */ }
  }

  if (readError) {
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    throw readError;
  }

  if (summary.backfilled === 0) {
    // Nothing to change — discard the tmp copy and leave the original file
    // completely untouched. This is what makes a second run idempotent: the
    // file is not even opened for writing when there is nothing to backfill.
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    return summary;
  }

  summary.changed = true;

  if (dryRun) {
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    return summary;
  }

  // Backup BEFORE the swap, matching bin/_lib/config-repair.js's convention.
  const backupPath = filePath + '.bak-' + Date.now();
  try {
    fs.copyFileSync(filePath, backupPath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    throw new Error('normalize-bare-event-rows: backup failed: ' + (e && e.message ? e.message : e));
  }
  summary.backupPath = backupPath;

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
    throw new Error('normalize-bare-event-rows: atomic replace failed: ' + (e && e.message ? e.message : e));
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Read-only range classification — high-water-mark fast path (v2.3.21)
// ---------------------------------------------------------------------------

/**
 * Read-only, no-write classification scan over the byte range
 * `[fromOffset, toOffset)` of `filePath`. Used by `repairBareEventRows` to
 * check whether bytes appended since the last full scan contain anything
 * actionable, without opening a tmp file or touching the source at all.
 *
 * Trailing bytes that are not terminated by a confirmed `\n` before
 * `toOffset` are excluded from both the classification and `cleanOffset` —
 * they may belong to a line a concurrent writer has not finished flushing
 * yet. The caller should persist `cleanOffset` (not `toOffset`) as the next
 * high-water mark so that torn tail is re-examined on the next call.
 *
 * @param {string} filePath
 * @param {number} fromOffset
 * @param {number} toOffset
 * @param {number} [chunkBytes]
 * @returns {{
 *   hasBackfill: boolean, bothKeysCount: number, bothKeysEventTypes: string[],
 *   malformedCount: number, scannedLines: number, cleanOffset: number,
 * }}
 */
function classifyRange(filePath, fromOffset, toOffset, chunkBytes) {
  chunkBytes = chunkBytes || DEFAULT_CHUNK_BYTES;
  const result = {
    hasBackfill: false,
    bothKeysCount: 0,
    bothKeysEventTypes: [],
    malformedCount: 0,
    scannedLines: 0,
    cleanOffset: fromOffset,
  };
  if (toOffset <= fromOffset) return result;

  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (_e) {
    return result; // unreadable — caller falls back to a full scan
  }

  const decoder = new StringDecoder('utf8');
  const buf = Buffer.alloc(Math.min(chunkBytes, toOffset - fromOffset) || chunkBytes);
  let pos = fromOffset;
  let leftover = '';
  let cleanOffset = fromOffset;

  try {
    while (pos < toOffset) {
      const want = Math.min(buf.length, toOffset - pos);
      let bytesRead;
      try {
        bytesRead = fs.readSync(fd, buf, 0, want, pos);
      } catch (_e) {
        break; // fail-open — report what was confirmed before the failure
      }
      if (bytesRead === 0) break;
      pos += bytesRead;
      const text = leftover + decoder.write(buf.slice(0, bytesRead));
      const lines = text.split('\n');
      leftover = lines.pop(); // possibly-incomplete tail — never classified
      for (const line of lines) {
        result.scannedLines++;
        const plan = classifyLine(line);
        if (plan.kind === 'backfill') {
          result.hasBackfill = true;
        } else if (plan.kind === 'both_keys') {
          result.bothKeysCount++;
          result.bothKeysEventTypes.push(plan.eventType);
        } else if (plan.kind === 'malformed') {
          result.malformedCount++;
        }
      }
      cleanOffset = pos - Buffer.byteLength(leftover, 'utf8');
    }
  } finally {
    try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
  }

  result.cleanOffset = cleanOffset;
  return result;
}

// ---------------------------------------------------------------------------
// High-water-mark state — persisted between repairBareEventRows calls
// ---------------------------------------------------------------------------

/**
 * Load the persisted high-water state, or null on any absence/corruption
 * (fail-open to "treat as no prior scan" — the caller then does a full scan,
 * never skips a needed one).
 *
 * @param {string} cwd
 * @returns {{offset:number, bothKeysCount:number, bothKeysEventTypes:string[],
 *            malformedCount:number, totalLines:number}|null}
 */
function loadHighWaterState(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, HIGHWATER_REL_PATH), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.offset === 'number' && parsed.offset >= 0) {
      return {
        offset: parsed.offset,
        bothKeysCount: typeof parsed.bothKeysCount === 'number' ? parsed.bothKeysCount : 0,
        bothKeysEventTypes: Array.isArray(parsed.bothKeysEventTypes) ? parsed.bothKeysEventTypes : [],
        malformedCount: typeof parsed.malformedCount === 'number' ? parsed.malformedCount : 0,
        totalLines: typeof parsed.totalLines === 'number' ? parsed.totalLines : 0,
      };
    }
  } catch (_e) { /* fail-open: no prior state, or corrupt — full rescan */ }
  return null;
}

/**
 * Persist the high-water state. Best-effort — a failed write just means the
 * next call pays for a full rescan instead of the fast path; never a
 * correctness issue, only a perf one, so no lock is taken.
 *
 * @param {string} cwd
 * @param {{offset:number, bothKeysCount:number, bothKeysEventTypes:string[],
 *          malformedCount:number, totalLines:number}} state
 */
function saveHighWaterState(cwd, state) {
  try {
    const p = path.join(cwd, HIGHWATER_REL_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch (_e) { /* fail-open — worst case the next call does a full rescan */ }
}

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * Env + config kill switch, mirroring `ORCHESTRAY_MISSHAPEN_EMIT_SCAN_DISABLED`
 * (the detector this repairs alongside) and `audit-housekeeper-drift.js`'s
 * inline `loadConfigEnabled`. Default-on, fail-open to enabled.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isRepairDisabled(cwd) {
  if (process.env[ENV_DISABLED] === '1') return true;
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.bare_event_key_repair && cfg.bare_event_key_repair.enabled === false) {
      return true;
    }
  } catch (_e) { /* fail-open: default-on */ }
  return false;
}

// ---------------------------------------------------------------------------
// Both-keys reporting dedup
// ---------------------------------------------------------------------------

const BOTH_KEYS_SCAN_CAP_BYTES = 64 * 1024 * 1024; // matches audit-pm-emit-coverage.js's cap

/**
 * Some legitimate, schema-declared event types carry a field literally named
 * `event` alongside `type` — e.g. `hook_chain_drift_detected.event` records
 * WHICH hook-lifecycle event drifted (`"PreToolUse"`, `"SessionStart"`, ...),
 * a real payload field, not a duplicate of `type`. Those rows correctly land
 * in `classifyLine`'s `both_keys` bucket (never guessed at, never rewritten)
 * but they are permanent and unresolvable — re-reporting them every time this
 * repair runs (every SessionStart once wired into dark-event-banner.js) would
 * flood events.jsonl with an identical, actionless advisory forever, exactly
 * the failure mode `audit-event-writer.js` goes to such lengths to avoid
 * elsewhere in this codebase (rate limits, sampling, dedup sets).
 *
 * Mirrors `computeMisshapenEmits`'s own `alreadyFlagged` convention in
 * bin/audit-pm-emit-coverage.js: a prior `bare_event_key_both_present` row
 * naming an event_type suppresses re-reporting that SAME event_type forever
 * — the flag row is itself well-shaped (`type`, not `event`) so it survives
 * rescans without needing a separate lock/state file. A genuinely NEW
 * both-keys event_type (one never reported before) still gets through.
 *
 * @param {string} cwd
 * @returns {Set<string>}
 */
function alreadyReportedBothKeysTypes(cwd) {
  const reported = new Set();
  const filePath = path.join(cwd, EVENTS_REL_PATH);
  let text;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return reported;
    if (stat.size > BOTH_KEYS_SCAN_CAP_BYTES) return reported; // fail-open: skip dedup, re-report rather than silently swallow forever
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return reported;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch (_e) { continue; }
    if (evt && evt.type === 'bare_event_key_both_present' && Array.isArray(evt.event_types)) {
      for (const t of evt.event_types) reported.add(t);
    }
  }
  return reported;
}

/**
 * Derive a fresh high-water state from a just-completed FULL
 * `normalizeEventsFile` pass. The offset is the file's size right after the
 * rewrite/rename (before any advisory row this call may append next), since
 * a full pass is, by construction, whole-file truth.
 *
 * @param {object} summary  - Return value of normalizeEventsFile.
 * @param {string} filePath
 * @returns {{offset:number, bothKeysCount:number, bothKeysEventTypes:string[],
 *            malformedCount:number, totalLines:number}}
 */
function summaryToFreshState(summary, filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (_e) { /* file vanished — offset 0 is safe, just forces a full rescan next time */ }
  return {
    offset: size,
    bothKeysCount: summary.bothKeysCount,
    bothKeysEventTypes: Array.from(new Set(summary.bothKeysEventTypes)),
    malformedCount: summary.malformedCount,
    totalLines: summary.totalLines,
  };
}

// ---------------------------------------------------------------------------
// Automatic repair entry point (scoped to the live log)
// ---------------------------------------------------------------------------

/**
 * Repair `.orchestray/audit/events.jsonl` in `cwd`, emitting audit events for
 * both outcomes (repaired rows, and any left-alone both-keys rows — the
 * latter deduped per event_type, see `alreadyReportedBothKeysTypes`). Never
 * throws — every failure is caught, reported to stderr, and returned in
 * `result.error` instead.
 *
 * High-water-mark fast path (v2.3.21, fix 4): when bytes appended since the
 * last confirmed-clean scan contain nothing actionable, this returns without
 * ever opening a tmp file or rewriting the (potentially huge) live log — see
 * `classifyRange` / `loadHighWaterState` / `saveHighWaterState` above. A full
 * `normalizeEventsFile` pass still runs, at full correctness (including the
 * v2.3.21 fix 1 concurrent-append race close), whenever the delta actually
 * contains a backfillable row, or on the very first call for a given file
 * (no prior state yet), or when the file shrank under the recorded offset
 * (external truncation/rotation — the old state no longer describes it).
 *
 * @param {string} cwd
 * @param {{dryRun?: boolean, chunkBytes?: number}} [opts]
 * @returns {{ran: boolean, disabled: boolean, error: string|null, summary: object|null}}
 */
function repairBareEventRows(cwd, opts) {
  opts = opts || {};
  const result = { ran: false, disabled: false, error: null, summary: null };

  if (isRepairDisabled(cwd)) {
    result.disabled = true;
    return result;
  }

  const filePath = path.join(cwd, EVENTS_REL_PATH);

  let summary;
  let persistState = null; // set only when a state update should be cached

  try {
    let stat = null;
    try { stat = fs.statSync(filePath); } catch (_e) { stat = null; }

    if (!stat || !stat.isFile() || stat.size === 0) {
      // Missing / empty file: identical to normalizeEventsFile's own no-op
      // shape. Delegate rather than duplicate that shape here.
      summary = normalizeEventsFile(filePath, { dryRun: !!opts.dryRun, chunkBytes: opts.chunkBytes });
    } else {
      const prior = loadHighWaterState(cwd);
      // Stale/reset: no prior state, or the file shrank under the recorded
      // offset (external truncation/rotation — the old state no longer
      // describes this file's history).
      const staleReset = !prior || prior.offset > stat.size;
      const fromOffset = staleReset ? 0 : prior.offset;

      if (fromOffset === stat.size) {
        // Nothing appended since the last confirmed-clean scan — the
        // cheapest possible outcome: one stat, one small JSON read, zero I/O
        // against events.jsonl itself.
        summary = {
          filePath, existed: true, changed: false, dryRun: !!opts.dryRun,
          backfilled: 0,
          bothKeysCount: prior.bothKeysCount,
          malformedCount: prior.malformedCount,
          totalLines: prior.totalLines,
          backupPath: null,
          bothKeysEventTypes: prior.bothKeysEventTypes.slice(),
        };
      } else if (stat.size - fromOffset > MAX_FAST_PATH_DELTA_BYTES) {
        // Delta too large to bother classifying separately — fall back to
        // the full pass. Should not occur in steady state.
        summary = normalizeEventsFile(filePath, { dryRun: !!opts.dryRun, chunkBytes: opts.chunkBytes });
        if (!opts.dryRun) persistState = summaryToFreshState(summary, filePath);
      } else {
        const range = classifyRange(filePath, fromOffset, stat.size, opts.chunkBytes);
        if (range.hasBackfill) {
          // A genuinely new backfillable row — the full, correct rewrite
          // must run (this is also what closes the fix-1 race for real).
          summary = normalizeEventsFile(filePath, { dryRun: !!opts.dryRun, chunkBytes: opts.chunkBytes });
          if (!opts.dryRun) persistState = summaryToFreshState(summary, filePath);
        } else {
          // Only unchanged/both-keys/malformed rows in the delta — no
          // rewrite needed. Accumulate onto the prior baseline so
          // bothKeysCount/malformedCount/totalLines keep reflecting the
          // whole file, not just this delta (both-keys rows are permanent
          // and never mutated, so nothing here is ever stale).
          const baseline = staleReset
            ? { bothKeysCount: 0, bothKeysEventTypes: [], malformedCount: 0, totalLines: 0 }
            : prior;
          const combinedTypes = Array.from(new Set(baseline.bothKeysEventTypes.concat(range.bothKeysEventTypes)));
          summary = {
            filePath, existed: true, changed: false, dryRun: !!opts.dryRun,
            backfilled: 0,
            bothKeysCount: baseline.bothKeysCount + range.bothKeysCount,
            malformedCount: baseline.malformedCount + range.malformedCount,
            totalLines: baseline.totalLines + range.scannedLines,
            backupPath: null,
            bothKeysEventTypes: combinedTypes,
          };
          if (!opts.dryRun) {
            persistState = {
              offset: range.cleanOffset,
              bothKeysCount: summary.bothKeysCount,
              bothKeysEventTypes: summary.bothKeysEventTypes,
              malformedCount: summary.malformedCount,
              totalLines: summary.totalLines,
            };
          }
        }
      }
    }
  } catch (e) {
    result.error = String(e && e.message ? e.message : e);
    try {
      process.stderr.write('[normalize-bare-event-rows] repair failed: ' + result.error + '\n');
    } catch (_e2) { /* ignore */ }
    return result;
  }

  if (persistState) saveHighWaterState(cwd, persistState);

  result.ran = true;
  result.summary = summary;

  if (summary.bothKeysCount > 0) {
    const distinctTypes = Array.from(new Set(summary.bothKeysEventTypes));
    const alreadyReported = alreadyReportedBothKeysTypes(cwd);
    const newTypes = distinctTypes.filter((t) => !alreadyReported.has(t));

    // Only report event_types not already flagged in a prior run — see
    // alreadyReportedBothKeysTypes for why (permanent, legitimate both-keys
    // rows must not flood the log with an identical advisory every run).
    if (newTypes.length > 0) {
      try {
        process.stderr.write(
          '[normalize-bare-event-rows] ' + summary.bothKeysCount +
          ' row(s) carry BOTH event and type — left unchanged, needs manual review ' +
          '(newly seen: ' + newTypes.join(', ') + ')\n'
        );
      } catch (_e) { /* ignore */ }
      // dryRun must have zero side effects on the live log — report to
      // stderr (diagnostic output only) but do not write the advisory.
      if (!opts.dryRun) {
        try {
          writeEvent({
            version: 1,
            type: 'bare_event_key_both_present',
            count: summary.bothKeysCount,
            event_types: newTypes.slice(0, 10),
          }, { cwd });
        } catch (_e) { /* fail-open */ }
      }
    }
  }

  if (summary.changed && !opts.dryRun) {
    try {
      writeEvent({
        version: 1,
        type: 'bare_event_key_repaired',
        repaired_count: summary.backfilled,
        malformed_skipped: summary.malformedCount,
        both_keys_skipped: summary.bothKeysCount,
        backup_path: summary.backupPath,
      }, { cwd });
    } catch (_e) { /* fail-open */ }
  }

  return result;
}

module.exports = {
  classifyLine,
  normalizeEventsFile,
  repairBareEventRows,
  isRepairDisabled,
  alreadyReportedBothKeysTypes,
  EVENTS_REL_PATH,
  ENV_DISABLED,
  // v2.3.21 high-water-mark fast path — exported for direct unit testing.
  classifyRange,
  loadHighWaterState,
  saveHighWaterState,
  HIGHWATER_REL_PATH,
  QUIESCENT_IDLE_MS,
  MAX_QUIESCENCE_WAIT_MS,
  MAX_FAST_PATH_DELTA_BYTES,
};

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
//
// This module is NOT registered directly in hooks/hooks.json — the automatic
// trigger is a call from bin/dark-event-banner.js's SessionStart handler (see
// that file's header note, item 3, for why: piggybacking on an already-declared
// (script, event) pair avoids opening a fresh gap in
// bin/_lib/hook-fixture-parity.js's fixture-coverage ratchet). This CLI entry
// exists for manual/one-off invocation and matches bin/_lib/config-repair.js's
// shape (`--project-root=`, `--dry-run`).

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const projectRootArg = argv.find((a) => a.startsWith('--project-root='));
  const cwd = projectRootArg ? path.resolve(projectRootArg.split('=')[1]) : process.cwd();

  try {
    const result = repairBareEventRows(cwd, { dryRun });
    if (result.disabled) {
      process.stdout.write('[normalize-bare-event-rows] disabled by kill switch — no-op\n');
    } else if (result.error) {
      process.stderr.write('[normalize-bare-event-rows] error: ' + result.error + '\n');
      process.exit(1);
    } else {
      const s = result.summary;
      process.stdout.write(
        '[normalize-bare-event-rows] ' + (dryRun ? 'DRY RUN — ' : '') +
        'totalLines=' + s.totalLines + ' backfilled=' + s.backfilled +
        ' bothKeys=' + s.bothKeysCount + ' malformed=' + s.malformedCount +
        (s.backupPath ? ' backup=' + s.backupPath : '') + '\n'
      );
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write('[normalize-bare-event-rows] uncaught: ' + (e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }
}
