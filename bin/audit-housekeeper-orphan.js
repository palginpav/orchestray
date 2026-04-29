#!/usr/bin/env node
'use strict';

/**
 * audit-housekeeper-orphan.js — SubagentStop / cron hook (v2.2.9 B-1.2/B-1.3).
 *
 * Detects two classes of orphaned housekeeper approvals:
 *
 *   1. `spawn_orphaned` (B-1.2 original):
 *      A row in spawn-approved.jsonl was approved but no Agent() call for
 *      orchestray-housekeeper appeared in events.jsonl within 60 seconds.
 *      Emits `spawn_orphaned` per affected row.
 *
 *   2. `spawn_drainer_orphaned` (B-1.3 addition):
 *      The drainer marked a row as drained (drained_at set) but the PM still
 *      did not call Agent() within 60 seconds. Different signal from "approval
 *      never came" — this means the PM ignored the injection.
 *      Emits `spawn_drainer_orphaned` per affected row.
 *
 * Run context: called from SubagentStop or a periodic sweep hook. Fail-open.
 *
 * Kill switch: ORCHESTRAY_SPAWN_DRAINER_DISABLED=1 suppresses both orphan
 * classes (same gate as the drainer itself).
 *
 * Input:  JSON hook payload on stdin (we use cwd)
 * Output: exit 0 always
 */

const fs   = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES }  = require('./_lib/constants');
const { resolveSafeCwd }   = require('./_lib/resolve-project-cwd');
const { writeEvent }       = require('./_lib/audit-event-writer');

const HOUSEKEEPER_AGENT = 'orchestray-housekeeper';
const APPROVED_REL      = path.join('.orchestray', 'state', 'spawn-approved.jsonl');
const EVENTS_REL        = path.join('.orchestray', 'audit', 'events.jsonl');

// Grace period: 60 seconds after approval/draining before we consider it orphaned.
const ORPHAN_GRACE_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Check kill switch
// ---------------------------------------------------------------------------
function isDisabled() {
  return process.env.ORCHESTRAY_SPAWN_DRAINER_DISABLED === '1';
}

// ---------------------------------------------------------------------------
// Read spawn-approved.jsonl
// ---------------------------------------------------------------------------
function readApproved(projectRoot) {
  const filePath = path.join(projectRoot, APPROVED_REL);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = [];
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { entries.push(JSON.parse(l)); } catch (_e) {}
    }
    return entries;
  } catch (_e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Check events.jsonl for an Agent() call for the housekeeper after a given time.
// Returns true if found (not orphaned).
// ---------------------------------------------------------------------------
function hasAgentCallAfter(projectRoot, afterIso) {
  const filePath = path.join(projectRoot, EVENTS_REL);
  const afterMs = new Date(afterIso).getTime();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      let ev;
      try { ev = JSON.parse(l); } catch (_e) { continue; }
      if (!ev) continue;
      // Look for agent_start with orchestray-housekeeper subagent_type.
      if (
        ev.type === 'agent_start' &&
        ev.subagent_type === HOUSEKEEPER_AGENT &&
        ev.timestamp &&
        new Date(ev.timestamp).getTime() >= afterMs
      ) {
        return true;
      }
    }
  } catch (_e) {}
  return false;
}

// ---------------------------------------------------------------------------
// Emit audit event (fail-silently).
// ---------------------------------------------------------------------------
function emitOrphan(projectRoot, type, fields) {
  try {
    writeEvent(
      Object.assign({ type, version: 1, schema_version: 1 }, fields),
      { cwd: projectRoot }
    );
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Main audit logic — exported for testability.
// ---------------------------------------------------------------------------
function runOrphanAudit(cwd) {
  if (isDisabled()) return { skipped: true, reason: 'kill_switch' };

  const entries = readApproved(cwd);
  const now = Date.now();

  let orphanCount = 0;
  let drainerOrphanCount = 0;

  for (const row of entries) {
    if (!row || row.requested_agent !== HOUSEKEEPER_AGENT) continue;

    const approvedAt   = row.approved_at   || row.decided_at || null;
    const drainedAt    = row.drained_at    || null;

    // ── Class 1: approved but never drained + no Agent() call within 60s ──
    if (approvedAt && !drainedAt) {
      const approvedMs = new Date(approvedAt).getTime();
      const age = now - approvedMs;
      if (age > ORPHAN_GRACE_MS && !hasAgentCallAfter(cwd, approvedAt)) {
        emitOrphan(cwd, 'spawn_orphaned', {
          request_id:      row.request_id     || null,
          requested_agent: row.requested_agent || HOUSEKEEPER_AGENT,
          orphan_age_seconds: Math.round(age / 1000),
        });
        orphanCount++;
      }
    }

    // ── Class 2: drainer injected prompt but PM still didn't call Agent() ──
    if (drainedAt) {
      const drainedMs = new Date(drainedAt).getTime();
      const age = now - drainedMs;
      if (age > ORPHAN_GRACE_MS && !hasAgentCallAfter(cwd, drainedAt)) {
        emitOrphan(cwd, 'spawn_drainer_orphaned', {
          request_id:            row.request_id     || null,
          requested_agent:       row.requested_agent || HOUSEKEEPER_AGENT,
          drained_at:            drainedAt,
          drainer_orphan_age_seconds: Math.round(age / 1000),
        });
        drainerOrphanCount++;
      }
    }
  }

  return { orphanCount, drainerOrphanCount };
}

// ---------------------------------------------------------------------------
// Stdin reader + hook entrypoint.
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    let event = {};
    if (input.trim()) {
      try { event = JSON.parse(input); } catch (_e) {}
    }
    const cwd = resolveSafeCwd(event && event.cwd);
    runOrphanAudit(cwd);
  } catch (_e) {
    // Fail-open.
  }
  process.exit(0);
});

// Export for tests.
module.exports = { runOrphanAudit, readApproved, hasAgentCallAfter };
