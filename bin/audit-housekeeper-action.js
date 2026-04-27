#!/usr/bin/env node
'use strict';

/**
 * audit-housekeeper-action.js — SubagentStop hook (P3.3, v2.2.0, Clause 4).
 *
 * Wires the per-action telemetry the locked-scope D-5 contract Clause 4
 * requires. Triggered on every SubagentStop; only emits when the stopping
 * subagent_type is `orchestray-housekeeper`. Other subagent types are a
 * no-op pass-through (this hook is intentionally narrow).
 *
 * Why a dedicated hook (Option B) instead of folding into collect-agent-
 * metrics.js (Option A): the metrics collector is 730+ LOC of billing
 * logic with its own evolving responsibilities (model resolution,
 * Variant-C dedupe, structural scoring). The housekeeper telemetry is
 * narrow-scope by design — keeping it in a separate file makes it
 * trivially auditable for scope drift, mirrors the
 * `bin/audit-housekeeper-drift.js` pattern (Clause 3 also has a dedicated
 * hook), and makes the Clause 4 contract structurally legible in the
 * hooks.json manifest.
 *
 * Per Clause 4 of locked-scope D-5 hardening contract:
 *   - One `housekeeper_action` row per housekeeper SubagentStop.
 *   - Required fields: `op_type`, `target_bytes`, `savings_claimed_usd`,
 *     `marker_received`, `orchestration_id`, `session_id`, `timestamp`,
 *     `version`.
 *   - Schema-conformant `op_type`: one of `kb-write-verify`,
 *     `regen-schema-shadow`, `rollup-recompute`. An out-of-scope value is
 *     emitted verbatim — the rollup analytics flag the drift.
 *
 * Field-name transformation boundary:
 *   - The agent body's Structured Result uses `housekeeper_op` and
 *     `housekeeper_target_bytes` (per agents/orchestray-housekeeper.md).
 *   - The event schema uses `op_type` and `target_bytes`.
 *   - This hook does the rename.
 *   - `housekeeper_savings_usd` (agent body, optional) → `savings_claimed_usd`
 *     (event); defaults to 0 when absent or non-numeric.
 *
 * Kill switches (Clause 5):
 *   - `ORCHESTRAY_HOUSEKEEPER_DISABLED=1` → no-op (also blocks Clause 3).
 *   - `haiku_routing.housekeeper_enabled === false` → no-op.
 *
 * Stdin: SubagentStop hook payload (we use subagent_type, agent_output,
 *   structured_result, session_id, hook_event_name).
 * Stdout: standard `{"continue": true}` JSON envelope.
 * Exit: always 0 (fail-open contract).
 */

const fs = require('fs');
const path = require('path');

const { writeEvent } = require('./_lib/audit-event-writer');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { extractStructuredResult, identifyAgentRole } = require('./validate-task-completion');

const HOUSEKEEPER_AGENT = 'orchestray-housekeeper';
const VALID_OP_TYPES = new Set(['kb-write-verify', 'regen-schema-shadow', 'rollup-recompute']);

function loadConfigEnabled(cwd) {
  // Default-on per locked-scope D-5: malformed/missing → enabled.
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.haiku_routing && cfg.haiku_routing.housekeeper_enabled === false) {
      return false;
    }
  } catch (_e) { /* fail-open */ }
  return true;
}

function resolveOrchestrationId(cwd) {
  try {
    const f = getCurrentOrchestrationFile(cwd);
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.orchestration_id || null;
  } catch (_e) {
    return null;
  }
}

function pickMarker(event) {
  // Marker is conventionally echoed back by the housekeeper in its
  // Structured Result OR carried through by the PM in the spawn description.
  // We accept either; null is acceptable per schema.
  if (!event) return null;
  // Prefer the housekeeper's own echoed marker (most authoritative).
  const sr = extractStructuredResult(event);
  if (sr && typeof sr === 'object') {
    if (typeof sr.marker_received === 'string' && sr.marker_received) return sr.marker_received;
    if (typeof sr.housekeeper_marker === 'string' && sr.housekeeper_marker) return sr.housekeeper_marker;
  }
  // Fall back to the spawn-side description if Claude Code surfaces it.
  if (event.tool_input && typeof event.tool_input.description === 'string') {
    const m = event.tool_input.description.match(/\[housekeeper:[^\]]*\]/);
    if (m) return m[0];
  }
  if (typeof event.description === 'string') {
    const m = event.description.match(/\[housekeeper:[^\]]*\]/);
    if (m) return m[0];
  }
  return null;
}

function coerceNumber(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Build the housekeeper_action event payload from a SubagentStop event.
 * Returns null when the event is not a housekeeper stop OR when no
 * Structured Result is recoverable. Otherwise returns the event row ready
 * for writeEvent.
 *
 * @param {object} event   - Raw SubagentStop hook payload.
 * @param {string} cwd     - Project root.
 * @returns {object|null}
 */
function buildHousekeeperActionEvent(event, cwd) {
  if (!event || typeof event !== 'object') return null;
  const role = identifyAgentRole(event);
  if (role !== HOUSEKEEPER_AGENT) return null;

  const sr = extractStructuredResult(event);
  // Per agent body contract, op_type and target_bytes come from the
  // Structured Result fields housekeeper_op + housekeeper_target_bytes.
  // If missing, emit the event with op_type=null so downstream rollup
  // can flag the malformed-handoff case.
  const opType = sr && typeof sr.housekeeper_op === 'string' && sr.housekeeper_op
    ? sr.housekeeper_op
    : null;
  const targetBytes = sr ? coerceNumber(sr.housekeeper_target_bytes, 0) : 0;
  const savings = sr ? coerceNumber(sr.housekeeper_savings_usd, 0) : 0;

  return {
    version: 1,
    type: 'housekeeper_action',
    timestamp: new Date().toISOString(),
    orchestration_id: resolveOrchestrationId(cwd),
    session_id: event.session_id || null,
    op_type: opType,
    target_bytes: targetBytes,
    savings_claimed_usd: savings,
    marker_received: pickMarker(event),
  };
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try { event = input ? JSON.parse(input) : {}; }
    catch (_e) { event = {}; }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); }
    catch (_e) { cwd = process.cwd(); }

    try {
      // Kill-switch short-circuit (Clause 5).
      if (process.env.ORCHESTRAY_HOUSEKEEPER_DISABLED === '1') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }
      if (!loadConfigEnabled(cwd)) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }
      // X-002 (v2.2.0 pre-ship cross-phase fix-pass): mirror Clause 3 from
      // gate-agent-spawn.js:138-153. If the quarantine sentinel is present,
      // do NOT admit telemetry from a (possibly drifted) housekeeper into
      // the rollup — that would corrupt the locked-scope D-5 promotion
      // ratchet (Clause 4 "≥ 100 events with zero violations" gate). The
      // gate-agent-spawn already blocks the spawn; this is defense-in-depth
      // for the case where a spawn somehow occurs (e.g., the gate is
      // bypassed by a future refactor or the sentinel is written mid-spawn).
      try {
        const sentinelPath = path.join(cwd, '.orchestray', 'state', 'housekeeper-quarantined');
        if (fs.existsSync(sentinelPath)) {
          process.stdout.write(JSON.stringify({ continue: true }));
          process.exit(0);
        }
      } catch (_e) { /* fail-open */ }

      // Only SubagentStop / TaskCompleted carry an agent role we care about.
      const hookEvent = event.hook_event_name || null;
      if (hookEvent && hookEvent !== 'SubagentStop' && hookEvent !== 'TaskCompleted') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const payload = buildHousekeeperActionEvent(event, cwd);
      if (payload) {
        try { writeEvent(payload, { cwd }); }
        catch (_writeErr) { /* fail-open per contract */ }
      }
    } catch (_e) {
      // Never block SubagentStop on housekeeper bookkeeping.
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  buildHousekeeperActionEvent,
  loadConfigEnabled,
  VALID_OP_TYPES,
};

if (require.main === module) {
  main();
}
