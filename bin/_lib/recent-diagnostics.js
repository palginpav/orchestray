'use strict';

/**
 * recent-diagnostics.js — ranks recently-fired diagnostic-shaped event types
 * from the live audit log.
 *
 * Why this exists
 * ----------------
 * `dark-event-banner.js` (and P9c/P9c2 in /orchestray:doctor) report event
 * types that have NEVER fired. The complementary — and more urgent — signal
 * is event types that HAVE fired recently: 37 diagnostic-shaped types
 * (*_warn, *_blocked, *_failed, *_missing, *_violation, *_detected, *_gap,
 * *_orphaned, *_stale, *_drift) totalling 1,200+ rows in this repo's history,
 * none surfaced anywhere a human looks. This module computes that signal.
 *
 * Recency window
 * ---------------
 * Rolling 24 hours from `nowMs` (default), matching the convention already
 * used by doctor's P7 ("silent fallback(s) in last 24h"). A fixed calendar
 * window (vs. "since last session" or "since some marker") stays meaningful
 * without external state: it needs no bookkeeping of when the last session
 * ended, degrades gracefully on a fresh checkout (nothing dark, no state to
 * lose), and matches the mental model doctor already trained operators on.
 * A type that fired 20 times three weeks ago and is quiet now correctly
 * disappears from this surface — see dual_install_divergence_detected in the
 * v2.3.22 corpus survey (48 lifetime fires, 0 in the last 24h, condition
 * since resolved). Reporting lifetime totals would announce 1,200+ stale
 * problems and be ignored immediately; that is the failure mode this module
 * exists to avoid.
 *
 * Bounded tail read (no cadence job to piggyback on)
 * ----------------------------------------------------
 * The dark-event snapshot is cheap at SessionStart because
 * audit-promised-events.js already recomputes it on orch-complete cadence —
 * this module reads no equivalent cache because writing one would mean
 * editing an existing hook script's cadence (out of scope: this module owns
 * only bin/dark-event-banner.js, skills/orchestray:doctor/**, and helpers
 * under bin/_lib/). Instead it reads a single BYTE-CAPPED tail of
 * `.orchestray/audit/events.jsonl` directly, once per SessionStart — one
 * positioned read() syscall, not a scan of the full (multi-MB, growing)
 * live log.
 *
 * TAIL_CAP_BYTES_DEFAULT (512 KiB) trades window completeness for
 * SessionStart cost, deliberately on the cheap side. Measured end-to-end
 * (subprocess hook mode, n=40, this repo's own 10 MB live log): the
 * pre-existing banner (dark-event + misshapen only) has a ~69ms median in
 * this environment; adding this module's 512 KiB read+parse costs a further
 * ~14ms median (~83ms total) — a 1 MiB cap measured ~39ms added instead,
 * roughly 3x the cost for the same marginal coverage gain, because a
 * cold-started V8 isolate pays JIT/GC costs a warm process wouldn't. 512 KiB
 * covers the full 24h window on a typical project easily; on THIS repo's own
 * unusually high test/orchestration churn (2,344+ events/24h some days) it
 * does not quite reach 24h back, and `windowTruncated: true` says so rather
 * than silently under-reporting — see the truncation-detection note below.
 * A quieter target project reads its whole file in one pass, well under the
 * cap, with no truncation.
 *
 * Truncation detection: if the read started mid-file (start > 0, i.e. the
 * file is bigger than the cap) and the OLDEST timestamp actually read is
 * still inside the window, there may be more in-window rows further back
 * that the cap didn't reach — an append-only, chronological log makes that
 * inference sound (if the oldest row we saw were already older than the
 * cutoff, everything before it is provably out of window too, and no
 * truncation occurred).
 *
 * Ranking (actionability, not volume)
 * -------------------------------------
 * `git_destructive_blocked` firing once matters more than
 * `schema_shape_violation` firing 20 times because a schema field is
 * optional-in-practice — the suffix itself carries most of the signal
 * about how urgent a firing is, independent of any specific event name:
 *   tier 1 (an enforcement action occurred — something was actively
 *           stopped or outright failed): *_blocked, *_failed
 *   tier 2 (a resource/state gap or a rule violation was observed):
 *           *_missing, *_orphaned, *_violation
 *   tier 3 (advisory / decay signals — worth knowing, rarely urgent):
 *           *_gap, *_stale, *_drift, *_detected, *_warn
 * Within a tier, rank by in-window fire count descending (more firings of
 * an equally-severe type is more worth a look), then by event_type
 * alphabetically for a stable, deterministic order. Lifetime totals are
 * deliberately NOT part of the tiebreak — computing them would require the
 * same full-log scan this module exists to avoid.
 *
 * Kill switch
 * -----------
 * Reuses ORCHESTRAY_DARK_EVENT_BANNER_DISABLED (checked by the caller,
 * dark-event-banner.js) — this module has no independent switch by design,
 * per the same "competing advisories are how banners become noise"
 * reasoning documented there.
 *
 * Fail-open contract
 * -------------------
 * Every error path (missing file, unreadable, malformed JSON) returns the
 * empty result. Never throws past this module's boundary.
 */

const fs = require('node:fs');
const path = require('node:path');

const RECENT_WINDOW_HOURS_DEFAULT = 24;
const TAIL_CAP_BYTES_DEFAULT = 512 * 1024; // 512 KiB — see header for sizing rationale

const TIER1_SUFFIXES = ['_blocked', '_failed'];
const TIER2_SUFFIXES = ['_missing', '_orphaned', '_violation'];
const TIER3_SUFFIXES = ['_gap', '_stale', '_drift', '_detected', '_warn'];
const DIAGNOSTIC_SUFFIXES = TIER1_SUFFIXES.concat(TIER2_SUFFIXES, TIER3_SUFFIXES);

/** @param {string} type @returns {boolean} */
function isDiagnosticType(type) {
  return typeof type === 'string' && DIAGNOSTIC_SUFFIXES.some((sfx) => type.endsWith(sfx));
}

/**
 * Actionability tier for a diagnostic-shaped type. Anchored to the suffix at
 * the END of the string only — e.g. "mcp_allowlist_stale_entry_warn" ends in
 * "_warn" (tier 3), not "_stale" even though "stale" appears mid-string.
 * @param {string} type
 * @returns {1|2|3|4} 4 = not a recognized diagnostic suffix (defensive; the
 *   caller only ranks types that already passed isDiagnosticType).
 */
function severityTier(type) {
  if (TIER1_SUFFIXES.some((sfx) => type.endsWith(sfx))) return 1;
  if (TIER2_SUFFIXES.some((sfx) => type.endsWith(sfx))) return 2;
  if (TIER3_SUFFIXES.some((sfx) => type.endsWith(sfx))) return 3;
  return 4;
}

/**
 * Read the diagnostic-shaped events fired in the last `windowHours`, ranked
 * by actionability. See module header for the window, tail-cap, and ranking
 * rationale.
 *
 * @param {string} cwd
 * @param {number} nowMs
 * @param {{windowHours?: number, tailCapBytes?: number}} [opts]
 * @returns {{
 *   totalMatched: number,
 *   ranked: Array<{event_type: string, count: number, tier: number}>,
 *   windowHours: number,
 *   windowTruncated: boolean,
 * }}
 */
function computeRecentDiagnostics(cwd, nowMs, opts) {
  const windowHours = (opts && typeof opts.windowHours === 'number') ? opts.windowHours : RECENT_WINDOW_HOURS_DEFAULT;
  const tailCapBytes = (opts && typeof opts.tailCapBytes === 'number') ? opts.tailCapBytes : TAIL_CAP_BYTES_DEFAULT;
  const EMPTY = { totalMatched: 0, ranked: [], windowHours, windowTruncated: false };

  const filePath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_e) {
    return EMPTY; // no audit log yet
  }
  if (!stat.isFile() || stat.size === 0) return EMPTY;

  const start = Math.max(0, stat.size - tailCapBytes);
  const len = stat.size - start;

  let text;
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    text = buf.toString('utf8');
  } catch (_e) {
    return EMPTY; // fail-open
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  }

  const lines = text.split('\n');
  // A tail read that didn't start at byte 0 almost certainly begins mid-record
  // (split across the read boundary) — drop the first fragment rather than
  // risk parsing a truncated line as valid JSON.
  if (start > 0 && lines.length > 0) lines.shift();

  const cutoffMs = nowMs - windowHours * 60 * 60 * 1000;
  const counts = new Map(); // event_type -> in-window count
  let oldestSeenMs = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let evt;
    try { evt = JSON.parse(line); } catch (_e) { continue; }
    if (!evt || typeof evt !== 'object' || typeof evt.type !== 'string') continue;
    const ts = Date.parse(evt.timestamp);
    if (isNaN(ts)) continue;

    if (oldestSeenMs === null || ts < oldestSeenMs) oldestSeenMs = ts;
    if (ts < cutoffMs) continue;
    if (!isDiagnosticType(evt.type)) continue;

    counts.set(evt.type, (counts.get(evt.type) || 0) + 1);
  }

  // See header: sound only because the log is append-only and chronological.
  const windowTruncated = start > 0 && oldestSeenMs !== null && oldestSeenMs >= cutoffMs;

  const ranked = Array.from(counts.entries())
    .map(([event_type, count]) => ({ event_type, count, tier: severityTier(event_type) }))
    .sort((a, b) => (a.tier - b.tier) || (b.count - a.count) || a.event_type.localeCompare(b.event_type));

  const totalMatched = ranked.reduce((sum, r) => sum + r.count, 0);

  return { totalMatched, ranked, windowHours, windowTruncated };
}

module.exports = {
  computeRecentDiagnostics,
  isDiagnosticType,
  severityTier,
  RECENT_WINDOW_HOURS_DEFAULT,
  TAIL_CAP_BYTES_DEFAULT,
  DIAGNOSTIC_SUFFIXES,
};
