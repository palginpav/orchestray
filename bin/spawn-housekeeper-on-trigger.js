#!/usr/bin/env node
'use strict';

/**
 * spawn-housekeeper-on-trigger.js — PostToolUse hook (v2.2.8 Item 1).
 *
 * Mechanical housekeeper delegation — replaces the prose-based
 * §23f directive in agents/pm.md that was never reliably followed.
 *
 * On each PostToolUse event, checks whether the completed tool call
 * is a housekeeper-triggering event. When it is, writes a sentinel
 * at `.orchestray/state/housekeeper-pending.json` so the next
 * PreToolUse:Agent hook (inject-housekeeper-pending.js) can queue
 * the housekeeper spawn.
 *
 * Trigger events:
 *   mcp__orchestray__kb_write → trigger_type: 'kb_write'
 *   Edit (if file matches event-schemas.md or schemas/*.js) → 'schema_edit'
 *   Write (same condition) → 'schema_edit'
 *
 * Debounce: one sentinel per trigger_type per 60-second window.
 * If a sentinel already exists for that type and is < 60 s old, skip.
 *
 * Kill switches (any one disables):
 *   process.env.ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER === '1'
 *   config.housekeeping.auto_delegate.enabled === false
 *
 * Fail-open: any error → log to stderr, exit 0. Never block Claude Code.
 *
 * Input:  JSON PostToolUse hook payload on stdin
 *         { hook_event_name, tool_name, tool_input, tool_response, cwd, ... }
 * Output: { continue: true } on stdout, always.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }               = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile }  = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }              = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Sentinel path
// ---------------------------------------------------------------------------
const SENTINEL_REL = path.join('.orchestray', 'state', 'housekeeper-pending.json');

// ---------------------------------------------------------------------------
// Debounce TTL (milliseconds)
// ---------------------------------------------------------------------------
const DEBOUNCE_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Tool → trigger type mapping
// ---------------------------------------------------------------------------
const TOOL_TRIGGER = {
  'mcp__orchestray__kb_write': 'kb_write',
  'Edit':  'schema_edit',
  'Write': 'schema_edit',
};

// File-path patterns that qualify Edit/Write as schema_edit triggers.
// A path is qualifying if it ends with event-schemas.md or matches
// schemas/*.js (relative or absolute).
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
  // Env kill switch.
  if (process.env.ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER === '1') return true;
  // Config kill switch.
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
// Debounce check: return true if we should skip (already have a fresh sentinel)
// ---------------------------------------------------------------------------
function isDebounced(sentinelPath, triggerType) {
  try {
    const existing = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    if (!existing || existing.trigger_type !== triggerType) return false;
    const age = Date.now() - new Date(existing.ts).getTime();
    return age < DEBOUNCE_MS;
  } catch (_e) { return false; }
}

// ---------------------------------------------------------------------------
// Write sentinel
// ---------------------------------------------------------------------------
function writeSentinel(sentinelPath, payload) {
  const dir = path.dirname(sentinelPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = sentinelPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, sentinelPath);
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

    // Kill-switch check.
    if (isDisabled(cwd)) return;

    const triggerType  = TOOL_TRIGGER[toolName];
    const sentinelPath = path.join(cwd, SENTINEL_REL);

    // Debounce.
    if (isDebounced(sentinelPath, triggerType)) return;

    const sourceFile = (
      (event.tool_input && (event.tool_input.path || event.tool_input.file_path)) || ''
    );
    const orchestrationId = resolveOrchestrationId(cwd);

    const payload = {
      trigger_type:     triggerType,
      source_file:      sourceFile,
      orchestration_id: orchestrationId,
      ts:               new Date().toISOString(),
    };

    writeSentinel(sentinelPath, payload);

  } catch (err) {
    // Fail-open — never let this hook break Claude Code.
    process.stderr.write(
      '[spawn-housekeeper-on-trigger] unexpected error: ' +
      (err && err.message ? err.message : String(err)) + '\n'
    );
  }
})();
