#!/usr/bin/env node
'use strict';

/**
 * audit-housekeeper-orphan.js — Stop-tail hook (v2.2.9 B-1.2).
 *
 * Purpose
 * -------
 * Surfaces housekeeper trigger-orphans: synthetic `spawn_requested` rows
 * created by `bin/spawn-housekeeper-on-trigger.js` (requester
 * `system:housekeeper-trigger`, requested `orchestray-housekeeper`) that
 * never received a follow-up `spawn_approved` or `spawn_denied` within 60
 * seconds. Such orphans indicate that the spawn-queue handoff fell on the
 * floor — typically because `bin/process-spawn-requests.js` did not run on
 * a subsequent PreToolUse:Agent (e.g. no Agent() call followed the
 * trigger) — and they explain a `housekeeper_action=0` outcome
 * mechanically rather than via prose inspection.
 *
 * Wiring
 * ------
 * Stop-hook tail. Runs after F2 (`bin/archive-orch-events.js`) so the
 * per-orchestration archive is up to date. Reads
 * `.orchestray/history/<orch_id>/events.jsonl` first; falls back to the
 * live `.orchestray/audit/events.jsonl` if no archive exists yet.
 *
 * Emit
 * ----
 * For each unmatched system-housekeeper `spawn_requested` row whose
 * timestamp is older than 60 seconds at the moment this hook runs, emit
 * `housekeeper_trigger_orphaned` with:
 *   { request_id, trigger_reason, age_seconds }
 *
 * Idempotency
 * -----------
 * Each Stop fire re-scans the archive. To avoid double-emitting on
 * subsequent fires within the same orchestration we skip any request
 * whose `request_id` is already present as the subject of a prior
 * `housekeeper_trigger_orphaned` row in the same archive.
 *
 * Kill switch
 * -----------
 * None — pure observability. The wider scope-lock §1 default-on policy
 * and `feedback_default_on_shipping.md` apply: shipped on by default.
 *
 * Fail-open contract
 * ------------------
 * Hooks must never block Claude Code. Every error path logs to stderr
 * and exits 0.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent }                  = require('./_lib/audit-event-writer');

const ORPHAN_AGE_THRESHOLD_MS = 60 * 1000;
const REQUESTER_SYSTEM        = 'system:housekeeper-trigger';
const HOUSEKEEPER_AGENT       = 'orchestray-housekeeper';
const MAX_LIVE_BYTES          = 64 * 1024 * 1024; // 64 MB defensive cap

// ---------------------------------------------------------------------------
// Drainer tombstone — prevents the same spawn_drainer_orphaned event from
// being re-emitted on every Stop fire. Each tombstone expires after 7 days.
// ---------------------------------------------------------------------------

const TOMBSTONE_TTL_DAYS = 7;

function _tombstonePath(cwd) {
  return path.join(cwd, '.orchestray', 'state', 'drainer-tombstones.jsonl');
}

function writeTombstone(cwd, requestId) {
  const until = new Date(Date.now() + TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const dir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(_tombstonePath(cwd), JSON.stringify({ request_id: requestId, until }) + '\n');
  } catch (_e) { /* fail-open */ }
}

function isTombstoned(cwd, requestId) {
  const p = _tombstonePath(cwd);
  if (!fs.existsSync(p)) return false;
  const now = Date.now();
  let lines;
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  } catch (_e) { return false; }
  return lines.some(line => {
    try {
      const t = JSON.parse(line);
      return t.request_id === requestId && new Date(t.until).getTime() > now;
    } catch (_e) { return false; }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCurrentOrchestrationId(cwd) {
  const file = getCurrentOrchestrationFile(cwd);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.orchestration_id === 'string' && parsed.orchestration_id) {
      return parsed.orchestration_id;
    }
  } catch (_e) { /* fail-open */ }
  return null;
}

/**
 * Resolve the events source for an orchestration. Prefers the per-orch
 * archive; falls back to the live log. Returns { path, lines: string[] }
 * or null on read failure.
 */
function loadEventLines(cwd, orchId) {
  const archive = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  const live    = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  for (const candidate of [archive, live]) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.size === 0) continue;
      if (stat.size > MAX_LIVE_BYTES) {
        process.stderr.write(`audit-housekeeper-orphan: ${candidate} exceeds ${MAX_LIVE_BYTES} bytes; skipping\n`);
        continue;
      }
      const text = fs.readFileSync(candidate, 'utf8');
      return { path: candidate, lines: text.split('\n').filter(Boolean) };
    } catch (e) {
      if (e && e.code !== 'ENOENT') {
        process.stderr.write(`audit-housekeeper-orphan: read ${candidate} failed: ${e.message}\n`);
      }
    }
  }
  return null;
}

function tsMs(iso) {
  if (!iso || typeof iso !== 'string') return NaN;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Scan a list of parsed events for housekeeper trigger orphans.
 *
 * Pure function — exported for tests. `nowMs` lets callers freeze "now"
 * for deterministic fixtures.
 *
 * @param {Array<object>} events       — parsed event rows.
 * @param {string}        orchId       — orchestration_id to filter on.
 * @param {number}        nowMs        — current time (epoch ms).
 * @returns {Array<object>}            — list of {request_id, trigger_reason, age_seconds}
 */
function findOrphans(events, orchId, nowMs) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const requested  = new Map();           // request_id → {trigger_reason, ts_ms}
  const decided    = new Set();           // request_ids already approved/denied
  const orphaned   = new Set();           // request_ids already orphan-emitted

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (ev.orchestration_id !== orchId) continue;

    if (ev.type === 'spawn_requested'
        && ev.requester_agent === REQUESTER_SYSTEM
        && ev.requested_agent === HOUSEKEEPER_AGENT
        && typeof ev.request_id === 'string') {
      const ts = tsMs(ev.timestamp);
      if (!Number.isFinite(ts)) continue;
      requested.set(ev.request_id, {
        trigger_reason: typeof ev.justification === 'string' ? ev.justification : null,
        ts_ms:          ts,
      });
      continue;
    }

    if ((ev.type === 'spawn_approved' || ev.type === 'spawn_denied')
        && typeof ev.request_id === 'string') {
      decided.add(ev.request_id);
      continue;
    }

    if (ev.type === 'housekeeper_trigger_orphaned' && typeof ev.request_id === 'string') {
      orphaned.add(ev.request_id);
      continue;
    }
  }

  const out = [];
  for (const [rid, info] of requested) {
    if (decided.has(rid)) continue;
    if (orphaned.has(rid)) continue; // already reported in a prior stop fire
    const age = nowMs - info.ts_ms;
    if (age < ORPHAN_AGE_THRESHOLD_MS) continue;
    out.push({
      request_id:     rid,
      trigger_reason: info.trigger_reason,
      age_seconds:    Math.round(age / 1000),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Drain stdin (Claude Code hooks must not leave stdin pipes hanging).
  let payload = {};
  try {
    if (!process.stdin.isTTY) {
      const raw = fs.readFileSync(0, 'utf8');
      if (raw && raw.trim().length > 0) payload = JSON.parse(raw);
    }
  } catch (_e) { /* fail-open */ }

  const cwd = resolveSafeCwd(payload && payload.cwd);
  const orchId = readCurrentOrchestrationId(cwd);
  if (!orchId) return 0;

  const loaded = loadEventLines(cwd, orchId);
  if (!loaded) return 0;

  const events = [];
  for (const line of loaded.lines) {
    try { events.push(JSON.parse(line)); }
    catch (_e) { /* skip malformed */ }
  }

  const orphans = findOrphans(events, orchId, Date.now());
  for (const o of orphans) {
    try {
      writeEvent({
        type:             'housekeeper_trigger_orphaned',
        version:          1,
        orchestration_id: orchId,
        request_id:       o.request_id,
        trigger_reason:   o.trigger_reason,
        age_seconds:      o.age_seconds,
      }, { cwd });
    } catch (e) {
      process.stderr.write(`audit-housekeeper-orphan: emit failed: ${e && e.message}\n`);
    }
  }

  // v2.2.9 W1 (B-1.3): drainer-orphan detection. When the spawn-approved
  // drainer (bin/inject-spawn-approved-drainer.js) injected a hard-block
  // prompt for a housekeeper row but the PM still didn't call Agent() within
  // 60s of the drainer firing, that's a separate failure mode worth seeing.
  try {
    const approvedPath = path.join(cwd, '.orchestray', 'state', 'spawn-approved.jsonl');
    if (fs.existsSync(approvedPath)) {
      const lines = fs.readFileSync(approvedPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        let row;
        try { row = JSON.parse(line); } catch (_e) { continue; }
        if (!row || row.requested_agent !== HOUSEKEEPER_AGENT) continue;
        if (!row.drained_at || row.orphan_reported_at) continue;
        if (isTombstoned(cwd, row.request_id)) continue;
        const drainedMs = tsMs(row.drained_at);
        if (drainedMs == null) continue;
        const age = Date.now() - drainedMs;
        if (age <= ORPHAN_AGE_THRESHOLD_MS) continue;
        if (hasAgentCallAfter(events, row.drained_at)) continue;
        try {
          const tombstoneUntil = new Date(Date.now() + TOMBSTONE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
          writeEvent({
            type:                          'spawn_drainer_orphaned',
            version:                       1,
            timestamp:                     new Date().toISOString(),
            orchestration_id:              orchId,
            request_id:                    row.request_id,
            requested_agent:               row.requested_agent,
            drained_at:                    row.drained_at,
            drainer_orphan_age_seconds:    Math.floor(age / 1000),
            tombstone_until:               tombstoneUntil,
          }, { cwd });
          writeTombstone(cwd, row.request_id);
          row.orphan_reported_at = new Date().toISOString();
        } catch (e) {
          process.stderr.write(`audit-housekeeper-orphan: drainer emit failed: ${e && e.message}\n`);
        }
      }
      // Persist orphan_reported_at idempotency markers.
      const updated = lines.map(l => {
        try { return JSON.parse(l); } catch (_e) { return null; }
      }).filter(Boolean);
      fs.writeFileSync(approvedPath, updated.map(JSON.stringify).join('\n') + '\n');
    }
  } catch (_e) { /* fail-open */ }

  return 0;
}

// Helper: scan events for an Agent() call to housekeeper after the given iso ts.
function hasAgentCallAfter(events, isoTs) {
  const sinceMs = tsMs(isoTs);
  if (sinceMs == null) return false;
  return events.some(e => {
    if (!e || (e.type !== 'agent_start' && e.event_type !== 'agent_start')) return false;
    if (e.agent_type !== HOUSEKEEPER_AGENT && e.agent_role !== HOUSEKEEPER_AGENT) return false;
    const t = tsMs(e.timestamp || e.ts);
    return t != null && t >= sinceMs;
  });
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`audit-housekeeper-orphan: top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
}

module.exports = {
  main,
  findOrphans,
  ORPHAN_AGE_THRESHOLD_MS,
  REQUESTER_SYSTEM,
  HOUSEKEEPER_AGENT,
};
