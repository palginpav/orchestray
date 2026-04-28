#!/usr/bin/env node
'use strict';

/**
 * audit-promised-events.js — promised-event tracker (v2.2.9 F3 part 1).
 *
 * Why this exists
 * ---------------
 * v2.2.8 shipped 17 new event types in CHANGELOG; several (`housekeeper_action`,
 * `verify_fix_coverage_report`, `dossier_injected`, ...) fired ZERO times under
 * production load (W4 §E.1 + RCA-1/2/5/6). The release shipped on the
 * assumption that promised events would surface — but with no mechanical
 * tracker, "promised but dark" looked identical to "promised and quiet
 * because the trigger is rare".
 *
 * F3 makes the failure mode structurally observable. Every event-type
 * registered in `agents/pm-reference/event-schemas.shadow.json` that has
 * fired ZERO times across the live audit log + per-orchestration archives
 * AND has been registered for more than 7 days AND is NOT marked
 * `feature_optional: true` in its event-schemas.md Field-notes block →
 * emits `event_promised_but_dark` once per (event_type, 24h window).
 *
 * Inputs
 * ------
 *   1. `agents/pm-reference/event-schemas.shadow.json` — the registry of every
 *      registered event-type. Each entry's optional `f: 1` flag is the
 *      `feature_optional: true` opt-out (propagated from MD via
 *      `bin/_lib/event-schemas-parser.js parseFeatureOptional` and
 *      `bin/regen-schema-shadow.js`).
 *
 *   2. Live `.orchestray/audit/events.jsonl` — current-orchestration window.
 *
 *   3. Per-orch archives `.orchestray/history/<orch>/events.jsonl` (F2). Used
 *      to count fires from prior orchestrations after the live log rotates or
 *      is rotated by `bin/_lib/jsonl-rotate.js`.
 *
 *   4. Tracker registry `.orchestray/state/promised-event-registry.json` —
 *      tracker-managed `{event_type: first_seen_iso}` map. Updated on every
 *      run when a NEW event-type is observed in shadow. Drives the 7-day
 *      registration window without depending on shadow's `_meta.generated_at`
 *      (which resets on every regen).
 *
 *   5. Debounce marker `.orchestray/state/promised-event-tracker.last-run.json`
 *      — stores `{event_type: last_emit_iso}` per type. Each event_type emits
 *      at most ONCE per 24h.
 *
 * Wall-clock budget
 * -----------------
 * 5 seconds total. On overrun, the tracker emits
 * `event_promised_but_dark_scan_truncated` with `partial_count` and exits 0.
 *
 * Default-on contract
 * -------------------
 * Per `feedback_default_on_shipping.md`. Kill switch
 * `ORCHESTRAY_PROMISED_EVENT_TRACKER_DISABLED=1`.
 *
 * Fail-open contract
 * ------------------
 * Hooks must never block Claude Code. Every error path logs to stderr and
 * exits 0.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent }     = require('./_lib/audit-event-writer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCAN_BUDGET_MS         = 5000;       // 5-second wall-clock cap
const DARK_THRESHOLD_DAYS    = 7;          // events younger than this are not alarmed
const DEBOUNCE_WINDOW_MS     = 24 * 3600 * 1000;
const MAX_EVENTS_FILE_BYTES  = 256 * 1024 * 1024; // 256 MB defensive cap on read

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load the schema shadow and return `{ entries: Map<event_type, {f, ...}>,
 * generated_at: <ISO> }`. Returns null on read/parse error.
 */
function loadShadow(cwd) {
  const shadowPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');
  let raw;
  try {
    raw = fs.readFileSync(shadowPath, 'utf8');
  } catch (e) {
    process.stderr.write(`audit-promised-events: read shadow failed: ${e.message}\n`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    process.stderr.write(`audit-promised-events: parse shadow failed: ${e.message}\n`);
    return null;
  }
  const entries = new Map();
  let generated_at = null;
  for (const k of Object.keys(parsed)) {
    if (k === '_meta') {
      if (parsed._meta && typeof parsed._meta.generated_at === 'string') {
        generated_at = parsed._meta.generated_at;
      }
      continue;
    }
    const entry = parsed[k];
    if (entry && typeof entry === 'object') entries.set(k, entry);
  }
  return { entries, generated_at };
}

/**
 * Load the tracker-managed registry
 * `.orchestray/state/promised-event-registry.json`.
 * Returns `{ event_types: { event_type: first_seen_iso } }`. Missing/unreadable
 * → empty map.
 */
function loadRegistry(cwd) {
  const file = path.join(cwd, '.orchestray', 'state', 'promised-event-registry.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.event_types && typeof parsed.event_types === 'object') {
      return parsed;
    }
  } catch (_e) { /* fail-open */ }
  return { event_types: {} };
}

/**
 * Persist the registry. Best-effort; failures are logged.
 */
function saveRegistry(cwd, reg) {
  const dir  = path.join(cwd, '.orchestray', 'state');
  const file = path.join(dir, 'promised-event-registry.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(reg, null, 2), { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`audit-promised-events: registry save failed: ${e.message}\n`);
  }
}

/**
 * Load the debounce marker. Returns `{event_types:{event_type:last_emit_iso}}`.
 */
function loadDebounce(cwd) {
  const file = path.join(cwd, '.orchestray', 'state', 'promised-event-tracker.last-run.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.event_types && typeof parsed.event_types === 'object') {
      return parsed;
    }
  } catch (_e) { /* fail-open */ }
  return { event_types: {} };
}

function saveDebounce(cwd, marker) {
  const dir  = path.join(cwd, '.orchestray', 'state');
  const file = path.join(dir, 'promised-event-tracker.last-run.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2), { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`audit-promised-events: debounce save failed: ${e.message}\n`);
  }
}

/**
 * Build a map of `event_type -> total_fire_count` by scanning the live audit
 * log + every per-orch archive at `.orchestray/history/<orch>/events.jsonl`.
 *
 * Uses a single substring pre-filter pass per file: if the type name does not
 * appear in the file at all, we skip JSON parsing entirely. The cost is
 * O(files * text-size); for a 256 MB live log + dozens of archives this is
 * still well under the 5-second budget.
 *
 * Surrogate `schema_shadow_validation_block` rows count toward the
 * `blocked_event_type` they wrap (so a perpetually-blocked event still looks
 * "alive" and does not double-alarm — the autofill-disabled / drop-mode
 * problem is a different signal class).
 */
function tallyFires(cwd, eventTypes, deadlineMs) {
  const counts = Object.create(null);
  for (const t of eventTypes) counts[t] = 0;

  // Cheap-substring + JSON.parse path for one file.
  const scanFile = (filePath) => {
    if (Date.now() > deadlineMs) return false; // budget exhausted
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (e) {
      if (e && e.code === 'ENOENT') return true;
      return true; // ignore unreadable
    }
    if (stat.size === 0) return true;
    if (stat.size > MAX_EVENTS_FILE_BYTES) return true; // skip oversized
    let text;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (_e) { return true; }

    // Quick reject — for every event-type we have to check substring presence
    // anyway, so do one pass per line and parse only when it's a JSONL row.
    for (const line of text.split('\n')) {
      if (!line) continue;
      // Most lines have exactly one "type":"X" — locate it without a full
      // JSON parse when possible.
      const m = line.match(/"type"\s*:\s*"([^"]+)"/);
      if (!m) continue;
      let t = m[1];
      // Surrogate fold-in: a `schema_shadow_validation_block` carries the
      // wrapped type in `blocked_event_type`. Count under the wrapped type so
      // a perpetually-blocked event still appears "fired".
      if (t === 'schema_shadow_validation_block') {
        const w = line.match(/"blocked_event_type"\s*:\s*"([^"]+)"/);
        if (w) t = w[1];
      }
      if (t in counts) counts[t] += 1;
    }
    return true;
  };

  // 1. live audit log
  scanFile(path.join(cwd, '.orchestray', 'audit', 'events.jsonl'));

  // 2. per-orch archives (F2)
  if (Date.now() < deadlineMs) {
    const historyDir = path.join(cwd, '.orchestray', 'history');
    let entries = [];
    try {
      entries = fs.readdirSync(historyDir, { withFileTypes: true });
    } catch (_e) { /* ENOENT is normal on a fresh repo */ }
    for (const ent of entries) {
      if (Date.now() > deadlineMs) break;
      if (!ent.isDirectory()) continue;
      scanFile(path.join(historyDir, ent.name, 'events.jsonl'));
    }
  }

  return { counts, truncated: Date.now() > deadlineMs };
}

/**
 * Compute days-since-iso. Returns 0 for invalid inputs.
 */
function daysSince(iso, nowMs) {
  const ts = Date.parse(iso);
  if (isNaN(ts)) return 0;
  const ms = nowMs - ts;
  if (ms < 0) return 0;
  return Math.floor(ms / (24 * 3600 * 1000));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.ORCHESTRAY_PROMISED_EVENT_TRACKER_DISABLED === '1') {
    return 0;
  }

  // Hook payload (cwd) — same shape as F2.
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
  const startMs    = Date.now();
  const deadlineMs = startMs + SCAN_BUDGET_MS;

  const shadow = loadShadow(cwd);
  if (!shadow) return 0;

  // Walk the registry: stamp first_seen for any event-type not yet recorded.
  const registry = loadRegistry(cwd);
  const nowIso   = new Date(startMs).toISOString();
  let registryDirty = false;
  for (const t of shadow.entries.keys()) {
    if (!registry.event_types[t]) {
      // Use shadow.generated_at when available — it's the closest thing to
      // "when this type was first registered" for events that already
      // existed before F3 shipped. Fall back to now() when shadow's
      // generated_at is missing.
      registry.event_types[t] = shadow.generated_at || nowIso;
      registryDirty = true;
    }
  }

  // Filter to dark candidates.
  const candidates = [];
  for (const [t, entry] of shadow.entries.entries()) {
    if (entry && entry.f === 1) continue;        // feature_optional opt-out
    candidates.push(t);
  }

  if (candidates.length === 0) {
    if (registryDirty) saveRegistry(cwd, registry);
    return 0;
  }

  // Tally fires.
  const { counts, truncated } = tallyFires(cwd, Array.from(shadow.entries.keys()), deadlineMs);

  // Load debounce marker.
  const debounce = loadDebounce(cwd);
  const debouncedSet = new Set();
  for (const t of Object.keys(debounce.event_types)) {
    const lastIso = debounce.event_types[t];
    const lastMs  = Date.parse(lastIso);
    if (!isNaN(lastMs) && (startMs - lastMs) < DEBOUNCE_WINDOW_MS) {
      debouncedSet.add(t);
    }
  }

  // Emit per dark event-type.
  let scannedCount = 0;
  for (const t of candidates) {
    scannedCount++;
    if (Date.now() > deadlineMs) {
      truncated || (truncated = true); // ensure we report truncation
      break;
    }
    const fireCount = counts[t] || 0;
    if (fireCount > 0) continue;             // not dark

    const firstSeen = registry.event_types[t] || nowIso;
    const days = daysSince(firstSeen, startMs);
    if (days <= DARK_THRESHOLD_DAYS) continue;

    if (debouncedSet.has(t)) continue;        // 24h debounce in effect

    try {
      writeEvent({
        type:                  'event_promised_but_dark',
        version:               1,
        event_type:            t,
        days_dark:             days,
        first_seen_in_shadow_at: firstSeen,
        total_fire_count:      0,
      }, { cwd });
      debounce.event_types[t] = nowIso;
    } catch (e) {
      process.stderr.write(`audit-promised-events: emit ${t} failed: ${e.message}\n`);
    }
  }

  if (truncated) {
    try {
      writeEvent({
        type:              'event_promised_but_dark_scan_truncated',
        version:           1,
        partial_count:     scannedCount,
        total_event_types: shadow.entries.size,
        elapsed_ms:        Date.now() - startMs,
      }, { cwd });
    } catch (e) {
      process.stderr.write(`audit-promised-events: emit truncation failed: ${e.message}\n`);
    }
  }

  // Persist marker + registry.
  saveDebounce(cwd, debounce);
  if (registryDirty) saveRegistry(cwd, registry);

  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`audit-promised-events: top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
}

module.exports = { main };
