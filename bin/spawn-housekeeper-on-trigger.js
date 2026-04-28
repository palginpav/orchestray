#!/usr/bin/env node
'use strict';

/**
 * spawn-housekeeper-on-trigger.js — PostToolUse hook (v2.2.9 B-1.1).
 *
 * Mechanical housekeeper delegation — converts a triggering tool call (KB
 * write, schema edit) into a synthetic row in
 * `.orchestray/state/spawn-requests.jsonl`. The downstream
 * `bin/process-spawn-requests.js` PreToolUse:Agent hook drains the queue,
 * marks system housekeeper rows `auto_approve: true` as approved, and
 * surfaces the approved entries via `.orchestray/state/spawn-approved.jsonl`
 * for the PM to consume on its next turn.
 *
 * Why this changed (v2.2.8 → v2.2.9 B-1.1):
 *   v2.2.8 wrote a sentinel at `.orchestray/state/housekeeper-pending.json`
 *   that the next PreToolUse:Agent hook (`inject-housekeeper-pending.js`)
 *   converted into a *prose nudge* prepended to the PM prompt. Per W3 G-1
 *   and W4 RCA-1 the prose nudge produced ZERO `housekeeper_action` events
 *   across 5 v2.2.8 orchestrations (canonical "prose-only auto-delegation"
 *   anti-pattern). v2.2.9 routes the trigger through the reactive-spawn
 *   queue used by the `mcp__orchestray__spawn_agent` MCP tool — a real
 *   mechanism the PM cannot ignore.
 *
 * Trigger events:
 *   mcp__orchestray__kb_write      → trigger_type: 'kb_write'
 *   Edit  on event-schemas.md or schemas/*.js → 'schema_edit'
 *   Write on event-schemas.md or schemas/*.js → 'schema_edit'
 *
 * Debounce (per spec): N=1 pending request per orchestration_id at a time.
 *   When a previous synthetic housekeeper request for the SAME
 *   orchestration_id is still pending in spawn-requests.jsonl, this hook
 *   does NOT enqueue a duplicate. Instead it emits
 *   `housekeeper_trigger_debounced` with `{trigger_reason, debounced_count}`
 *   so the collapse is observable.
 *
 * Kill switches (any one disables):
 *   process.env.ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED === '1'   (B-1.1)
 *   process.env.ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER === '1'          (legacy)
 *   config.housekeeping.auto_delegate.enabled === false              (legacy)
 *
 * Fail-open: any error → log to stderr, exit 0. Never block Claude Code.
 *
 * Input:  JSON PostToolUse hook payload on stdin
 *         { hook_event_name, tool_name, tool_input, tool_response, cwd, ... }
 * Output: { continue: true } on stdout, always.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent }                  = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REQUESTS_REL = path.join('.orchestray', 'state', 'spawn-requests.jsonl');
const HOUSEKEEPER_AGENT  = 'orchestray-housekeeper';
const REQUESTER_SYSTEM   = 'system:housekeeper-trigger';
const HOUSEKEEPER_MAX_COST_USD = 0.50;

// ---------------------------------------------------------------------------
// Tool → trigger reason mapping
// ---------------------------------------------------------------------------
const TOOL_TRIGGER = {
  'mcp__orchestray__kb_write': 'kb_write',
  'Edit':  'schema_edit',
  'Write': 'schema_edit',
};

function isSchemaFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalised = filePath.replace(/\\/g, '/');
  if (normalised.endsWith('event-schemas.md')) return true;
  if (/\/schemas\/[^/]+\.js$/.test(normalised)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Config / kill-switch check
// ---------------------------------------------------------------------------
function isDisabled(cwd) {
  if (process.env.ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED === '1') return true;
  if (process.env.ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER === '1') return true;
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8')
    );
    if (
      cfg &&
      cfg.housekeeping &&
      cfg.housekeeping.auto_delegate &&
      cfg.housekeeping.auto_delegate.enabled === false
    ) return true;
  } catch (_e) { /* config absent → default-on */ }
  return false;
}

// ---------------------------------------------------------------------------
// Resolve orchestration_id from current-orchestration.json (best-effort)
// ---------------------------------------------------------------------------
function resolveOrchestrationId(cwd) {
  try {
    const raw = fs.readFileSync(getCurrentOrchestrationFile(cwd), 'utf8');
    const d = JSON.parse(raw);
    return (d && typeof d.orchestration_id === 'string') ? d.orchestration_id : null;
  } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------
// Read pending housekeeper requests for a given orchestration.
// Returns the array (may be empty) of pending rows whose requester is the
// system housekeeper-trigger AND orchestration_id matches.
// ---------------------------------------------------------------------------
function readPendingHousekeeperRequests(cwd, orchId) {
  const filePath = path.join(cwd, REQUESTS_REL);
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (_e) { return []; }
  const pending = [];
  for (const line of raw.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    let parsed;
    try { parsed = JSON.parse(l); }
    catch (_e) { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.status !== 'pending') continue;
    if (parsed.orchestration_id !== orchId) continue;
    if (parsed.requester_agent !== REQUESTER_SYSTEM) continue;
    if (parsed.requested_agent !== HOUSEKEEPER_AGENT) continue;
    pending.push(parsed);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Append a synthetic spawn request row.
// ---------------------------------------------------------------------------
function appendSpawnRequest(cwd, request) {
  const filePath = path.join(cwd, REQUESTS_REL);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(request) + '\n', 'utf8');
}

function newRequestId() {
  return (crypto.randomUUID && crypto.randomUUID())
    || crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

process.stdout.write(JSON.stringify({ continue: true }));  // always emit early

(async () => {
  try {
    // Read stdin.
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        process.stderr.write('[spawn-housekeeper-on-trigger] stdin too large, skipping\n');
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return;

    let event;
    try { event = JSON.parse(raw); }
    catch (_e) {
      process.stderr.write('[spawn-housekeeper-on-trigger] invalid JSON on stdin\n');
      return;
    }

    const toolName = event.tool_name || '';
    const cwd      = resolveSafeCwd(event.cwd);

    // Early exit if not a trigger tool.
    if (!TOOL_TRIGGER[toolName]) return;

    // For Edit/Write, only trigger on schema-file paths.
    if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = (event.tool_input && event.tool_input.file_path) || '';
      if (!isSchemaFile(filePath)) return;
    }

    if (isDisabled(cwd)) return;

    const triggerReason = TOOL_TRIGGER[toolName];
    const sourceFile    = (
      (event.tool_input && (event.tool_input.path || event.tool_input.file_path)) || ''
    );
    const orchId = resolveOrchestrationId(cwd);
    if (!orchId) return; // no active orchestration → no queue context

    // Debounce: one pending system-housekeeper request per orchestration.
    const pending = readPendingHousekeeperRequests(cwd, orchId);
    if (pending.length >= 1) {
      // Emit collapse-observability event.
      try {
        writeEvent({
          type:             'housekeeper_trigger_debounced',
          version:          1,
          orchestration_id: orchId,
          trigger_reason:   triggerReason,
          debounced_count:  pending.length,
        }, { cwd });
      } catch (_e) { /* fail-open */ }
      return;
    }

    // Build and append the synthetic spawn request.
    const requestId = newRequestId();
    const request = {
      request_id:       requestId,
      orchestration_id: orchId,
      requester_agent:  REQUESTER_SYSTEM,
      requested_agent:  HOUSEKEEPER_AGENT,
      justification:    triggerReason,
      prompt:           buildHousekeeperPrompt(triggerReason, sourceFile),
      max_cost_usd:     HOUSEKEEPER_MAX_COST_USD,
      auto_approve:     true,
      spawn_depth:      0,
      status:           'pending',
      ts:               new Date().toISOString(),
    };
    appendSpawnRequest(cwd, request);

    // Emit `spawn_requested` so downstream observers (and the
    // process-spawn-requests hook on the next PreToolUse:Agent) can correlate.
    try {
      writeEvent({
        type:             'spawn_requested',
        version:          1,
        orchestration_id: orchId,
        request_id:       requestId,
        requester_agent:  REQUESTER_SYSTEM,
        requested_agent:  HOUSEKEEPER_AGENT,
        justification:    triggerReason,
        max_cost_usd:     HOUSEKEEPER_MAX_COST_USD,
      }, { cwd });
    } catch (_e) { /* fail-open */ }

    // Compatibility shim: also write the legacy sentinel so any session
    // running the v2.2.8 inject-housekeeper-pending.js code path still
    // sees a trigger. The shim is removed in v2.2.10.
    try {
      const legacyPath = path.join(cwd, '.orchestray', 'state', 'housekeeper-pending.json');
      const tmp = legacyPath + '.tmp.' + process.pid;
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({
        trigger_type:     triggerReason,
        source_file:      sourceFile,
        orchestration_id: orchId,
        request_id:       requestId,
        ts:               new Date().toISOString(),
      }, null, 2), 'utf8');
      fs.renameSync(tmp, legacyPath);
    } catch (_e) { /* legacy sentinel is best-effort */ }

  } catch (err) {
    process.stderr.write(
      '[spawn-housekeeper-on-trigger] unexpected error: ' +
      (err && err.message ? err.message : String(err)) + '\n'
    );
  }
})();

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function buildHousekeeperPrompt(triggerReason, sourceFile) {
  const target = sourceFile || '(unspecified)';
  return (
    'Housekeeper run auto-triggered by ' + triggerReason + '.\n' +
    'Source file: ' + target + '.\n' +
    'Perform the appropriate narrow-scope housekeeping operation per ' +
    'agents/orchestray-housekeeper.md (kb-write-verify | regen-schema-shadow | ' +
    'rollup-recompute) and emit the [housekeeper: ...] marker in your output.'
  );
}

module.exports = {
  isSchemaFile,
  isDisabled,
  resolveOrchestrationId,
  readPendingHousekeeperRequests,
  appendSpawnRequest,
  buildHousekeeperPrompt,
  REQUESTER_SYSTEM,
  HOUSEKEEPER_AGENT,
  HOUSEKEEPER_MAX_COST_USD,
};
