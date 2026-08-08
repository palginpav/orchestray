#!/usr/bin/env node
'use strict';

/**
 * dark-event-banner.js — SessionStart advisory + doctor --json surface for
 * declared event types that have never fired.
 *
 * Why this exists
 * ---------------
 * bin/audit-firing-nightly.js and bin/audit-promised-events.js already
 * compute the "declared but never fired" signal — the latter writes an
 * `event_promised_but_dark` row per type (event_type, days_dark,
 * total_fire_count) once it clears a 7-day age threshold and a lifetime
 * zero-fire count. Neither script has a success-path human output: the
 * signal lands in events.jsonl and nobody sees it. This script reuses that
 * already-computed signal (no recomputation, single source of truth) and
 * adds the missing piece — telling a human, at session start and in doctor.
 *
 * Data source
 * -----------
 * Reads `.orchestray/state/promised-event-dark-state.last-run.json`, a
 * snapshot `audit-promised-events.js` fully OVERWRITES on every run (orch-
 * complete cadence) with that run's exact current dark set — never an
 * accumulating log. This fixed a real bug (v2.3.21): the previous design
 * scanned `event_promised_but_dark` ROWS in events.jsonl, which accumulate
 * and are debounced to one emission per 24h per type. A type flagged dark
 * once, then fixed (started firing), left its stale row in place for up to
 * 30 days — the banner kept counting it as dark long after it wasn't
 * (measured on this repo: 307 reported by the old scan vs. 119 from a fresh
 * corpus scan run through the fixed algorithm the same day). Reading the
 * fresh snapshot instead means "dark" always means "dark as of the last
 * scan", never "was dark at some point in the last 30 days".
 *
 * This is also why the scan itself is not repeated here: the corpus scan
 * (live log + rotated generations + per-orch archives) is expensive and
 * already runs in audit-promised-events.js on orch-complete; this script
 * only reads that cached result, keeping SessionStart cost flat regardless
 * of corpus size.
 *
 * The whole snapshot is dropped (treated as no signal) if its `generated_at`
 * is older than STALE_AFTER_MS (30 days) — an old snapshot describes state
 * that may no longer hold, so showing it would be a false claim rather than
 * silence.
 *
 * Noise threshold (the crux)
 * ---------------------------
 * The registered-type corpus is large (331 types measured 2026-08-08, of
 * which 119 were dark that day) and will only grow. Enumerating every dark
 * type every session is exactly the noise this script exists to avoid —
 * a wall of names gets skimmed once and then filtered out by habit. The
 * rule: name at most TOP_N_NAMED (3) worst offenders by days_dark, plus the
 * total count. This keeps the banner a fixed one-line cost regardless of
 * corpus size — 3 names stays scannable in under two seconds whether the
 * corpus is 331 types or 3,000. The full list is one `/orchestray:doctor`
 * away, not stuffed into a login banner.
 *
 * v2.3.22: also folds in the misshapen-emit signal from
 * audit-pm-emit-coverage.js's scanMisshapenEmits() — audit rows written
 * with `event:` instead of `type:`, invisible to every `evt.type` consumer.
 * That scanner writes its own fresh snapshot
 * (`.orchestray/state/misshapen-emit-state.last-run.json`) on the same
 * full-overwrite contract as the dark-event snapshot. Deliberately reusing
 * THIS banner rather than adding a second one: a competing session-start
 * advisory is how banners become noise (see that script's header).
 *
 * v2.3.23: also folds in the recent-diagnostics signal from
 * bin/_lib/recent-diagnostics.js — diagnostic-shaped event types
 * (*_warn/*_blocked/*_failed/*_missing/*_violation/*_detected/*_gap/
 * *_orphaned/*_stale/*_drift) that HAVE fired in the last 24h, ranked by
 * actionability rather than volume. Unlike the two signals above, this one
 * has no cadence-job cache to read (see that module's header for why) — it
 * does a single byte-capped tail read of events.jsonl instead. Folded into
 * the SAME banner and the same `--json` payload for the same reason: a
 * third competing advisory is exactly the noise this banner exists to
 * avoid, and the line is restructured (two physical lines, one
 * `[orchestray]`-prefixed header) rather than growing a third run-on
 * clause — see formatBanner() below.
 *
 * Two modes
 * ---------
 *   1. Hook mode (default): reads a SessionStart hook payload from stdin,
 *      emits a one-time-per-session stderr banner (tmpdir sentinel lock,
 *      same convention as feature-quarantine-banner.js) when dark types
 *      and/or misshapen rows exist. Always writes {continue:true} to stdout.
 *   2. `--json [--cwd <path>]`: prints the full computeDarkEvents() result
 *      plus `misshapenEmits` as JSON to stdout, no session lock, no stdin
 *      read. This is the surface /orchestray:doctor's P9c/P9c2 probes
 *      consume (same pattern as `_tools/behavior-diff.js --coverage --json`
 *      for P9b).
 *
 * Kill switch
 * -----------
 * `ORCHESTRAY_DARK_EVENT_BANNER_DISABLED=1` → hook mode exits silently.
 *
 * Fail-open contract
 * ------------------
 * Advisory only. Every error path is swallowed; the hook never blocks
 * session start and never throws past its own boundary.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { computeRecentDiagnostics } = require('./_lib/recent-diagnostics');

const CONTINUE_RESPONSE      = JSON.stringify({ continue: true });
const STALE_AFTER_MS         = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOP_N_NAMED            = 3;

/**
 * Read the fresh dark-set snapshot written by audit-promised-events.js,
 * validate it, and sort by days_dark descending.
 *
 * @param {string} cwd
 * @param {number} nowMs
 * @returns {{ darkTypes: Array<{event_type:string, days_dark:number, total_fire_count:number}>, totalDark: number }}
 */
function computeDarkEvents(cwd, nowMs) {
  const EMPTY = { darkTypes: [], totalDark: 0 };
  const statePath = path.join(cwd, '.orchestray', 'state', 'promised-event-dark-state.last-run.json');

  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (_e) {
    return EMPTY; // no snapshot yet (e.g. no orchestration has completed)
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return EMPTY; // malformed — fail-open to silence
  }
  if (!parsed || !Array.isArray(parsed.dark_types)) return EMPTY;

  // Whole-snapshot staleness: an old snapshot may no longer describe
  // reality (types may have started firing since), so it is dropped
  // wholesale rather than surfaced as a possibly-false claim.
  const generatedMs = Date.parse(parsed.generated_at);
  if (isNaN(generatedMs) || (nowMs - generatedMs) > STALE_AFTER_MS) return EMPTY;

  const candidateCount = typeof parsed.candidate_count === 'number' ? parsed.candidate_count : 0;

  const darkTypes = parsed.dark_types
    .filter((d) => d && typeof d.event_type === 'string')
    .map((d) => ({
      event_type:       d.event_type,
      days_dark:         typeof d.days_dark === 'number' ? d.days_dark : 0,
      total_fire_count:  typeof d.total_fire_count === 'number' ? d.total_fire_count : 0,
    }));

  // Sanity assert: the dark set can never exceed the candidate corpus it was
  // drawn from. Violating this means the snapshot is corrupt or from an
  // incompatible format — fail closed to silence rather than print an
  // absurd number.
  if (darkTypes.length > candidateCount) return EMPTY;

  darkTypes.sort((a, b) => b.days_dark - a.days_dark || a.event_type.localeCompare(b.event_type));

  return { darkTypes, totalDark: darkTypes.length };
}

/**
 * Read the misshapen-emit snapshot audit-pm-emit-coverage.js's
 * scanMisshapenEmits() overwrites on every run. Same fresh-snapshot +
 * staleness-drop contract as computeDarkEvents() (see module header).
 *
 * @returns {{types: Array<{event_name:string, count:number}>, total: number}}
 */
function computeMisshapenSnapshot(cwd, nowMs) {
  const EMPTY = { types: [], total: 0 };
  const statePath = path.join(cwd, '.orchestray', 'state', 'misshapen-emit-state.last-run.json');

  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (_e) {
    return EMPTY; // no snapshot yet (scanner hasn't run)
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return EMPTY; // malformed — fail-open to silence
  }
  if (!parsed || !Array.isArray(parsed.misshapen_types)) return EMPTY;

  const generatedMs = Date.parse(parsed.generated_at);
  if (isNaN(generatedMs) || (nowMs - generatedMs) > STALE_AFTER_MS) return EMPTY;

  const types = parsed.misshapen_types
    .filter((d) => d && typeof d.event_name === 'string')
    .map((d) => ({ event_name: d.event_name, count: typeof d.count === 'number' ? d.count : 0 }));

  const total = typeof parsed.total_misshapen === 'number'
    ? parsed.total_misshapen
    : types.reduce((sum, t) => sum + t.count, 0);

  return { types, total };
}

/**
 * Format the session banner. Returns null when there is nothing to say.
 * Folds all three signals (dark-event, misshapen-emit, recent-diagnostics)
 * into ONE banner rather than a fourth competing advisory — see the
 * v2.3.22/v2.3.23 header notes. Two physical lines, not three run-on
 * clauses crammed into one: line 1 is the "declared but quiet" header
 * (dark + misshapen, unchanged wording from v2.3.22), line 2 is the "fired
 * recently, ranked by actionability" signal plus the doctor pointer. Only
 * line 1 (when present) carries the `[orchestray]` prefix — same
 * one-header-line convention feature-quarantine-banner.js already uses for
 * its own two-line advisory.
 */
function formatBanner(result, misshapen, recent) {
  const headerClauses = [];

  if (result.totalDark > 0) {
    const worst = result.darkTypes.slice(0, TOP_N_NAMED)
      .map(d => `${d.event_type} ${d.days_dark}d`)
      .join(', ');
    headerClauses.push(`${result.totalDark} declared event type(s) have never fired (worst: ${worst})`);
  }

  if (misshapen && misshapen.total > 0) {
    headerClauses.push(
      `${misshapen.total} audit row(s) are misshapen ("event:" not "type:") ` +
      `across ${misshapen.types.length} type(s)`,
    );
  }

  let recentClause = null;
  if (recent && recent.totalMatched > 0) {
    const top = recent.ranked.slice(0, TOP_N_NAMED)
      .map(d => `${d.event_type} (${d.count})`)
      .join(', ');
    // windowTruncated: the tail cap didn't reach back the full window on a
    // high-volume log — say so rather than silently under-reporting (see
    // recent-diagnostics.js header).
    const truncatedNote = recent.windowTruncated ? ', window truncated by log volume' : '';
    recentClause = `${recent.totalMatched} diagnostic-shaped event(s) fired in the last ${recent.windowHours}h${truncatedNote} — top: ${top}`;
  }

  if (headerClauses.length === 0 && !recentClause) return null;

  const line1 = headerClauses.length > 0 ? `[orchestray] ${headerClauses.join('. ')}.` : null;
  const line2Body = recentClause
    ? `${recentClause}. Run \`/orchestray:doctor\` for the full list.`
    : 'Run `/orchestray:doctor` for the full list.';
  const line2 = line1 ? line2Body : `[orchestray] ${line2Body}`;

  return line1 ? `${line1}\n${line2}\n` : `${line2}\n`;
}

// ---------------------------------------------------------------------------
// Hook mode
// ---------------------------------------------------------------------------

function handle(event) {
  try {
    if (process.env.ORCHESTRAY_DARK_EVENT_BANNER_DISABLED === '1') {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    const cwd = resolveSafeCwd(event && event.cwd);
    const nowMs = Date.now();
    const result     = computeDarkEvents(cwd, nowMs);
    const misshapen  = computeMisshapenSnapshot(cwd, nowMs);
    const recent     = computeRecentDiagnostics(cwd, nowMs);
    const banner = formatBanner(result, misshapen, recent);
    if (!banner) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    // Session-scoped lock: emit banner only once per session (mirrors
    // feature-quarantine-banner.js exactly).
    const sessionId = (event && event.session_id)
      ? String(event.session_id).replace(/[^a-zA-Z0-9_-]/g, '')
      : String(process.pid);
    const lockPath = path.join(os.tmpdir(), `orchestray-dark-event-banner-${sessionId}.lock`);

    if (fs.existsSync(lockPath)) {
      process.stdout.write(CONTINUE_RESPONSE);
      return;
    }

    try {
      fs.writeFileSync(lockPath, new Date().toISOString(), 'utf8');
    } catch (_e) {
      // Lock write failed — still emit the banner (fail-open)
    }

    process.stderr.write(banner);
  } catch (_e) {
    // Fail-open
  } finally {
    process.stdout.write(CONTINUE_RESPONSE);
  }
}

// ---------------------------------------------------------------------------
// --json CLI mode (for /orchestray:doctor)
// ---------------------------------------------------------------------------

function runJsonMode(argv) {
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1 && argv[cwdIdx + 1]) cwd = argv[cwdIdx + 1];
  const resolvedCwd = resolveSafeCwd(cwd);
  const nowMs = Date.now();
  const result    = computeDarkEvents(resolvedCwd, nowMs);
  const misshapen = computeMisshapenSnapshot(resolvedCwd, nowMs);
  const recent    = computeRecentDiagnostics(resolvedCwd, nowMs);
  process.stdout.write(JSON.stringify(Object.assign({}, result, { misshapenEmits: misshapen, recentDiagnostics: recent })));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--json')) {
    try {
      runJsonMode(argv);
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
    }
  } else {
    let input = '';
    try {
      input = readHookInputRaw();
    } catch (_e) {
      input = '';
    }
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(CONTINUE_RESPONSE);
      process.exit(0);
    }
    setImmediate(() => {
      try {
        handle(JSON.parse(input || '{}'));
      } catch (_e) {
        process.stdout.write(CONTINUE_RESPONSE);
        process.exit(0);
      }
    });
  }
}

module.exports = { handle, computeDarkEvents, computeMisshapenSnapshot, formatBanner };
