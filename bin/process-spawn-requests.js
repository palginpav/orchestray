#!/usr/bin/env node
'use strict';

/**
 * PreToolUse:Agent hook — drain reactive spawn-request queue.
 *
 * Runs at the start of every PM Agent() call. Reads
 * `.orchestray/state/spawn-requests.jsonl`, processes pending requests,
 * and auto-approves or auto-denies each one.
 *
 * Per v2.2.8 Item 5 (L): reactive worker-initiated agent spawning.
 *
 * Exit semantics:
 *   0 — allow spawn to proceed (always, per fail-open contract).
 *
 * This hook NEVER blocks the PM's spawn (exit 2 is reserved for hard
 * enforcement hooks like gate-cost-budget). Its job is to drain the queue
 * and emit decision events. The approved requests are written to a sentinel
 * file `.orchestray/state/spawn-approved.jsonl` for the PM to consume.
 *
 * Kill switches:
 *   - ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1 (env)
 *   - reactive_spawn.enabled: false (config)
 *
 * Auto-approve condition (ALL must be true):
 *   1. request.max_cost_usd < (remaining_budget * auto_approve_threshold_pct)
 *   2. total spawn_requested count for this orchestration <= per_orchestration_quota
 *
 * Fail-open: any internal error → exit 0 (hook must never block the PM).
 */

const fs = require('node:fs');
const path = require('node:path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { verifyRow } = require('./_lib/spawn-hmac');

// Import helpers from the spawn_agent tool module.
const {
  loadReactiveSpawnConfig,
  readOrchestrationId,
  readBudgetState,
  DEFAULT_QUOTA,
  DEFAULT_AUTO_APPROVE_THRESHOLD_PCT,
} = require('./mcp-server/tools/spawn_agent');

// === v2.2.21 W1-T2: auto_approve origin allowlist (CWE-862 closure) ===
// Only requesters in this set may carry `auto_approve: true`. New entries
// require both code review and an explicit threat-model addendum (see
// .orchestray/kb/artifacts/v2221-T4-security-findings.md § F1).
const SYSTEM_REQUESTER_ALLOWLIST = new Set([
  'system:housekeeper-trigger',
]);

// F8 closure: stale rows whose orchestration_id != active orch get evicted
// after this age. 5 minutes = ample slack for a legitimate row queued just
// before an orchestration boundary, while bounding JSONL growth.
const STALE_ROW_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Drain stdin (required for Claude Code hook scripts to avoid EPIPE)
// ---------------------------------------------------------------------------

let _stdinBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {});
process.stdin.on('data', (chunk) => {
  _stdinBuf += chunk;
  if (_stdinBuf.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] process-spawn-requests: stdin exceeded limit; failing open\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => { main(); });

// Guard: if stdin never closes (unlikely in test contexts), run after 200ms.
const _guard = setTimeout(() => { main(); }, 200);
let _ran = false;

function safeExit0() {
  try { clearTimeout(_guard); } catch (_e) {}
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read spawn-requests.jsonl and return all parsed entries.
 * Returns [] on any error.
 */
function readSpawnRequests(projectRoot) {
  const filePath = path.join(projectRoot, '.orchestray', 'state', 'spawn-requests.jsonl');
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

/**
 * Rewrite spawn-requests.jsonl with the updated entries array.
 * Fail-silently on write errors.
 */
function writeSpawnRequests(projectRoot, entries) {
  const filePath = path.join(projectRoot, '.orchestray', 'state', 'spawn-requests.jsonl');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (_e) {}
}

/**
 * Append an approved request record to spawn-approved.jsonl so the PM can
 * consume it on its next turn.
 */
function appendApproved(projectRoot, request) {
  const filePath = path.join(projectRoot, '.orchestray', 'state', 'spawn-approved.jsonl');
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(request) + '\n', 'utf8');
  } catch (_e) {}
}

/**
 * Emit an audit event to events.jsonl (inline implementation — must not throw).
 * Reuses the canonical writeEvent if available; falls back to direct append.
 */
function emitEvent(projectRoot, event) {
  try {
    // Try the canonical gateway first, passing cwd so the event lands in the
    // correct project root (critical for test isolation).
    const { writeEvent } = require('./_lib/audit-event-writer');
    writeEvent(Object.assign({ timestamp: new Date().toISOString() }, event), { cwd: projectRoot });
  } catch (_e) {
    // Fallback: direct JSONL append.
    try {
      const eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
      fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
      const line = JSON.stringify(Object.assign({ timestamp: new Date().toISOString() }, event));
      fs.appendFileSync(eventsPath, line + '\n', 'utf8');
    } catch (_e2) {}
  }
}

/**
 * Count spawn_requested events already in events.jsonl for the given orchId.
 */
function countSpawnRequestedEvents(projectRoot, orchId) {
  try {
    const eventsPath = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
    const raw = fs.readFileSync(eventsPath, 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      let ev;
      try { ev = JSON.parse(l); } catch (_e) { continue; }
      if (ev && ev.orchestration_id === orchId && ev.type === 'spawn_requested') count++;
    }
    return count;
  } catch (_e) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (_ran) return;
  _ran = true;
  clearTimeout(_guard);

  try {
    run();
  } catch (_e) {
    // Fail-open: any unhandled error must not block the PM.
    process.stderr.write('[orchestray] process-spawn-requests: unhandled error: ' + String(_e) + '\n');
    process.exit(0);
  }
}

function run() {
  // --- Kill switch ---
  if (process.env.ORCHESTRAY_DISABLE_REACTIVE_SPAWN === '1') {
    safeExit0();
    return;
  }

  // --- Parse stdin for cwd ---
  let event = {};
  try {
    if (_stdinBuf.trim()) event = JSON.parse(_stdinBuf);
  } catch (_e) {}

  const cwd = resolveSafeCwd(event.cwd);

  // --- Config ---
  const cfg = loadReactiveSpawnConfig(cwd);
  if (!cfg.enabled) {
    safeExit0();
    return;
  }

  // --- Orchestration ID ---
  const orchId = readOrchestrationId(cwd);
  if (!orchId) {
    // No active orchestration — nothing to process.
    safeExit0();
    return;
  }

  // --- Read pending requests ---
  let entries = readSpawnRequests(cwd);

  // F8 closure (v2.2.21): TTL-evict pending rows whose orchestration_id does
  // not match the active orch and whose age exceeds STALE_ROW_TTL_MS. Without
  // this, forged or abandoned rows accumulate unbounded in spawn-requests.jsonl
  // (the drainer otherwise filters but never deletes them).
  let evictedAny = false;
  const nowMs = Date.now();
  const beforeLen = entries.length;
  entries = entries.filter((e) => {
    if (!e || typeof e !== 'object') return false;       // drop malformed
    if (e.status !== 'pending') return true;             // keep terminal rows
    if (e.orchestration_id === orchId) return true;      // keep current-orch
    let ageMs = Infinity;
    if (typeof e.ts === 'string') {
      const parsed = Date.parse(e.ts);
      if (!Number.isNaN(parsed)) ageMs = nowMs - parsed;
    }
    const stale = ageMs > STALE_ROW_TTL_MS;
    if (stale) {
      evictedAny = true;
      emitEvent(cwd, {
        type: 'spawn_request_evicted',
        version: 1,
        schema_version: 1,
        orchestration_id: orchId,
        request_id: e.request_id,
        evicted_orchestration_id: e.orchestration_id || null,
        reason: 'stale_orchestration_id_ttl',
        age_ms: Number.isFinite(ageMs) ? ageMs : null,
      });
    }
    return !stale;
  });
  if (evictedAny || entries.length !== beforeLen) {
    writeSpawnRequests(cwd, entries);
  }

  const pending = entries.filter(e => e && e.status === 'pending' && e.orchestration_id === orchId);

  if (pending.length === 0) {
    safeExit0();
    return;
  }

  // --- Budget state ---
  const budget = readBudgetState(cwd, orchId);
  const thresholdPct = cfg.auto_approve_threshold_pct;

  // --- Existing spawn_requested count (for quota enforcement) ---
  let spawnRequestedCount = countSpawnRequestedEvents(cwd, orchId);

  let changed = false;

  for (const req of pending) {
    const idx = entries.indexOf(req);

    // --- Quota check ---
    if (spawnRequestedCount >= cfg.per_orchestration_quota) {
      entries[idx] = Object.assign({}, req, { status: 'denied', decided_at: new Date().toISOString(), reason: 'quota_exhausted' });
      changed = true;
      emitEvent(cwd, {
        type: 'spawn_denied',
        version: 1,
        schema_version: 1,
        orchestration_id: orchId,
        request_id: req.request_id,
        decision_source: 'auto',
        reason: 'quota_exhausted',
      });
      process.stderr.write(
        '[orchestray] Reactive spawn request DENIED: quota_exhausted (' +
        spawnRequestedCount + '/' + cfg.per_orchestration_quota + ' used).' +
        ' Run `/orchestray:spawn-requests` to review.\n'
      );
      continue;
    }

    // --- Max-depth check ---
    const spawnDepth = typeof req.spawn_depth === 'number' ? req.spawn_depth : 0;
    if (spawnDepth >= cfg.max_depth) {
      entries[idx] = Object.assign({}, req, { status: 'denied', decided_at: new Date().toISOString(), reason: 'max_depth_exceeded' });
      changed = true;
      emitEvent(cwd, {
        type: 'spawn_denied',
        version: 1,
        schema_version: 1,
        orchestration_id: orchId,
        request_id: req.request_id,
        decision_source: 'auto',
        reason: 'max_depth_exceeded',
      });
      process.stderr.write(
        '[orchestray] Reactive spawn request DENIED: max_depth_exceeded' +
        ' (depth ' + spawnDepth + ' >= ' + cfg.max_depth + ').' +
        ' Run `/orchestray:spawn-requests` to review.\n'
      );
      continue;
    }

    // --- Auto-approve threshold check ---
    const maxCost = typeof req.max_cost_usd === 'number' ? req.max_cost_usd : 0;
    let approved = false;
    let denyReason = 'above_threshold';
    let approveReason = 'below_threshold';

    // Fast path: system-initiated requests that carry `auto_approve: true`
    // bypass the cost-vs-budget gate entirely. This is reserved for hook-
    // generated synthetic requests (e.g. `spawn-housekeeper-on-trigger.js`
    // queueing a housekeeper run after a KB write) where user approval is
    // not appropriate. Quota and max-depth checks above still apply.
    //
    // v2.2.21 W1-T2 (CWE-862 closure): the auto_approve flag is no longer
    // self-attesting. The row's `requester_agent` must appear in
    // SYSTEM_REQUESTER_ALLOWLIST AND the row must carry a valid HMAC
    // signature derived from ~/.claude/orchestray/.spawn-hmac-key. Failing
    // either condition → spawn_denied{auto_approve_origin_unverified}. Kill
    // switch ORCHESTRAY_AUTO_APPROVE_ALLOWLIST_DISABLED=1 reverts to the
    // v2.2.20 unverified behavior for emergency rollback.
    if (req && req.auto_approve === true) {
      const allowlistDisabled = process.env.ORCHESTRAY_AUTO_APPROVE_ALLOWLIST_DISABLED === '1';
      if (allowlistDisabled) {
        approved = true;
        approveReason = 'system_auto_approve_allowlist_disabled';
      } else {
        const requesterAllowed = SYSTEM_REQUESTER_ALLOWLIST.has(req.requester_agent);
        const sigValid = verifyRow(req);
        if (requesterAllowed && sigValid) {
          approved = true;
          approveReason = 'system_auto_approve';
        } else {
          // Hard-deny the row. Skip the budget branch entirely.
          entries[idx] = Object.assign({}, req, {
            status: 'denied',
            decided_at: new Date().toISOString(),
            reason: 'auto_approve_origin_unverified',
          });
          changed = true;
          emitEvent(cwd, {
            type: 'spawn_denied',
            version: 1,
            schema_version: 1,
            orchestration_id: orchId,
            request_id: req.request_id,
            decision_source: 'auto',
            reason: 'auto_approve_origin_unverified',
            requester_agent: req.requester_agent || null,
            requester_in_allowlist: requesterAllowed,
            signature_valid: sigValid,
          });
          process.stderr.write(
            '[orchestray] Reactive spawn request DENIED: auto_approve_origin_unverified' +
            ' (requester=' + (req.requester_agent || 'unknown') +
            ', allowlist=' + requesterAllowed +
            ', signature_valid=' + sigValid + ').' +
            ' Run `/orchestray:spawn-requests` to review.\n'
          );
          continue;
        }
      }
    } else if (budget.remaining_usd !== null) {
      const threshold = budget.remaining_usd * thresholdPct;
      approved = maxCost < threshold;
    } else {
      // No budget configured — auto-approve (conservative: 0 remaining => deny).
      // When there is no budget cap at all, we approve.
      approved = true;
    }

    if (approved) {
      entries[idx] = Object.assign({}, req, { status: 'approved', decided_at: new Date().toISOString(), reason: approveReason });
      changed = true;
      spawnRequestedCount++; // track locally for subsequent iterations
      emitEvent(cwd, {
        type: 'spawn_approved',
        version: 1,
        schema_version: 1,
        orchestration_id: orchId,
        request_id: req.request_id,
        decision_source: 'auto',
        reason: approveReason,
      });
      // Write to spawn-approved.jsonl for PM consumption.
      appendApproved(cwd, entries[idx]);
    } else {
      entries[idx] = Object.assign({}, req, { status: 'denied', decided_at: new Date().toISOString(), reason: denyReason });
      changed = true;
      emitEvent(cwd, {
        type: 'spawn_denied',
        version: 1,
        schema_version: 1,
        orchestration_id: orchId,
        request_id: req.request_id,
        decision_source: 'auto',
        reason: denyReason,
      });
      process.stderr.write(
        '[orchestray] Reactive spawn request DENIED: ' + denyReason +
        ' (requested $' + maxCost.toFixed(4) +
        ', threshold $' + (budget.remaining_usd !== null ? (budget.remaining_usd * thresholdPct).toFixed(4) : 'n/a') + ').' +
        ' Run `/orchestray:spawn-requests` to review.\n'
      );
    }
  }

  // --- Persist updated request list ---
  if (changed) {
    writeSpawnRequests(cwd, entries);
  }

  safeExit0();
}
