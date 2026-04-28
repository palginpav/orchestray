#!/usr/bin/env node
'use strict';

/**
 * validate-kb-index.js — PreToolUse:Edit|Write checkpoint for `.orchestray/kb/index.json`.
 *
 * v2.2.9 B-7.3. Mechanises W1 F-PM-26 (KB-write protocol prose):
 *
 *   "Write to .orchestray/kb/facts/{slug}.md ... Update .orchestray/kb/index.json,
 *    adding your entry to the entries array. Check the index first ... Keep detail
 *    files under 500 tokens."
 *
 * The MCP `kb_write` tool already serialises index updates under a lock. But
 * an agent armed with Write/Edit can bypass kb_write and corrupt the index
 * directly. This hook:
 *
 *   - For Edit/Write tool calls touching `.orchestray/kb/index.json`:
 *       1. Reads the current state (pre-edit).
 *       2. Lets the edit proceed only if the current state is structurally valid.
 *          (We cannot validate post-edit content from PreToolUse; that runs in
 *           a future PostToolUse companion. PreToolUse just makes sure we don't
 *           start from a broken base — agents can't "fix" by overwriting if the
 *           gate later refuses to load it.)
 *   - For mcp__orchestray__kb_write calls: validate the current index before
 *     allowing the call to proceed (cheap check; the MCP tool will validate
 *     the inputs again, but this layer surfaces the issue earlier).
 *
 * Exit 2 on detected corruption with a `kb_index_invalid` event emitted.
 *
 * Fail-open: any unexpected error → exit 0 (do not block legitimate work).
 */

const path = require('path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { validate } = require('./_lib/kb-index-validator');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

function _isIndexPath(p, cwd) {
  if (typeof p !== 'string' || p.length === 0) return false;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const target = path.resolve(cwd, '.orchestray', 'kb', 'index.json');
  return abs === target;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) process.exit(0);
});
process.stdin.on('end', () => {
  let event;
  try {
    event = input ? JSON.parse(input) : {};
  } catch (_e) {
    process.exit(0);
  }

  const cwd = resolveSafeCwd(event.cwd);
  const toolName = event.tool_name || '';
  const toolInput = event.tool_input || {};

  // Scope: Edit/Write touching kb/index.json, OR mcp__orchestray__kb_write.
  const interesting =
    (toolName === 'Edit' || toolName === 'Write') &&
    _isIndexPath(toolInput.file_path || toolInput.path, cwd);
  const isKbWrite = toolName === 'mcp__orchestray__kb_write';

  if (!interesting && !isKbWrite) process.exit(0);

  let result;
  try {
    result = validate(cwd);
  } catch (_e) {
    process.exit(0);
  }

  if (result.valid) process.exit(0);

  // Emit event and block.
  try {
    writeEvent({
      type: 'kb_index_invalid',
      version: 1,
      timestamp: new Date().toISOString(),
      index_path: result.file_path,
      reason: result.reason,
    }, { cwd });
  } catch (_evErr) { /* fail-open on emit failure */ }

  const msg =
    '[orchestray] validate-kb-index: .orchestray/kb/index.json fails structural ' +
    'validation (reason=' + result.reason + '). Refusing to write — repair the ' +
    'index by hand or via `mcp__orchestray__kb_write` before retrying.';
  process.stderr.write(msg + '\n');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: msg,
    },
  }));
  process.exit(2);
});
