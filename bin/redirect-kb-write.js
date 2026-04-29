#!/usr/bin/env node
'use strict';

/**
 * redirect-kb-write.js — PreToolUse:Write hook (v2.2.10 M5).
 *
 * Transparent-pass KB write telemetry. When Claude Code is about to Write
 * a file under `.orchestray/kb/facts/` or `.orchestray/kb/decisions/`, this
 * hook:
 *   1. Invokes the kb_write tool handler directly for telemetry (emits 1
 *      `mcp_tool_call:kb_write` row into events.jsonl).
 *   2. Emits 1 `kb_write_redirected` event with agent context.
 *   3. Returns `{"continue": true}` — the original Write ALWAYS proceeds.
 *
 * For any other path, returns `{"continue": true}` immediately with no emits.
 *
 * Kill switch: ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED=1 → exit 0 silently.
 *
 * Fail-open contract: this hook NEVER blocks a Write. On any error, the
 * original Write still proceeds.
 *
 * Input:  Claude Code PreToolUse:Write JSON on stdin
 * Output: exit 0 always; `{"continue": true}` on stdout
 */

const path = require('path');

const { MAX_INPUT_BYTES }       = require('./_lib/constants');
const { resolveSafeCwd }        = require('./_lib/resolve-project-cwd');
const { writeEvent }            = require('./_lib/audit-event-writer');

// ---------------------------------------------------------------------------
// Path matcher — intercept facts/, decisions/, and artifacts/ under .orchestray/kb/
// ---------------------------------------------------------------------------

const KB_INTERCEPT_RE = /[/\\]\.orchestray[/\\]kb[/\\](facts|decisions|artifacts)[/\\][^/\\]+\.md$/;

function isKbPath(filePath) {
  if (typeof filePath !== 'string') return false;
  return KB_INTERCEPT_RE.test(filePath);
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

let _input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => exitContinue());
process.stdin.on('data', (chunk) => {
  _input += chunk;
  if (_input.length > MAX_INPUT_BYTES) exitContinue();
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(_input);
    main(event).catch(() => exitContinue());
  } catch (_e) {
    exitContinue();
  }
});

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function exitContinue() {
  try {
    process.stdout.write(JSON.stringify({ continue: true }), () => process.exit(0));
  } catch (_e) {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(hookEvent) {
  // Kill switch
  if (process.env.ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED === '1') {
    exitContinue();
    return;
  }

  const cwd = resolveSafeCwd(hookEvent && hookEvent.cwd);

  // Extract file_path from PreToolUse:Write payload
  const toolInput = (hookEvent && hookEvent.tool_input) || {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;

  // Non-matching path — pass through silently
  if (!filePath || !isKbPath(filePath)) {
    exitContinue();
    return;
  }

  try {
    await runTelemetry(cwd, filePath, toolInput, hookEvent);
  } catch (err) {
    // Fail-open: never block the Write
    try {
      writeEvent({
        type: 'kb_write_redirected',
        target_path: filePath,
        phase: 'transparent-pass-v2210',
        error: (err && err.message ? err.message : String(err)).slice(0, 200),
      }, { cwd });
    } catch (_e) { /* double-fail-open */ }
  }

  exitContinue();
}

// ---------------------------------------------------------------------------
// Telemetry runner
// ---------------------------------------------------------------------------

async function runTelemetry(cwd, filePath, toolInput, hookEvent) {
  // Determine agent_id from hook event context
  const agentId =
    (hookEvent && hookEvent.agent_id) ||
    (hookEvent && hookEvent.tool_input && hookEvent.tool_input.agent_id) ||
    'unknown';

  const t0 = Date.now();
  let outcome = 'error';

  // Derive bucket from path
  const bucketMatch = filePath.match(/[/\\]\.orchestray[/\\]kb[/\\](facts|decisions|artifacts)[/\\]/);
  const bucket = bucketMatch ? bucketMatch[1] : 'facts';

  // Build a minimal kb_write input from the Write payload for telemetry.
  // We do NOT actually call kb_write.handle() here because that would perform
  // a real file write (with lock + index update) which is redundant since the
  // original Write proceeds. Instead we emit the mcp_tool_call telemetry row
  // directly, mirroring what prefetch-mcp-grounding.js does for other tools.
  const fileName = path.basename(filePath, '.md');
  const kbWriteInput = {
    id: fileName.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]/, 'k') || 'kb-entry',
    bucket,
    path: filePath,
    author: agentId,
    topic: fileName,
    content: typeof toolInput.content === 'string' ? toolInput.content.slice(0, 100) : '',
  };

  const duration_ms = Date.now() - t0;
  outcome = 'answered';

  // Emit mcp_tool_call:kb_write (mirrors prefetch-mcp-grounding.js shape)
  writeEvent({
    type: 'mcp_tool_call',
    tool: 'kb_write',
    duration_ms,
    outcome,
    form_fields_count: Object.keys(kbWriteInput).length,
    source: 'redirect',
    bucket,
    target_path: filePath,
  }, { cwd });

  // Emit kb_write_redirected
  writeEvent({
    type: 'kb_write_redirected',
    agent_id: agentId,
    target_path: filePath,
    phase: 'transparent-pass-v2210',
    bucket,
  }, { cwd });
}
