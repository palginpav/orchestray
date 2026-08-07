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
 * D9 (v2.3.18): detection alone turned a recoverable index into a hard block
 * on every KB write until someone hand-repaired index.json. Before blocking,
 * this hook now attempts `repair(cwd)` (bin/_lib/kb-index-validator.js) — it
 * only fixes the two mechanically-unambiguous shapes (mis-bucketed entries,
 * exact-duplicate ids) and never guesses. On success it emits
 * `kb_index_repaired` (with the diff) and lets the original call proceed. On
 * failure (or a genuinely ambiguous corruption) it falls back to the
 * pre-existing block below, now naming the specific unrepairable entry.
 *
 * Exit 2 on detected corruption with a `kb_index_invalid` event emitted.
 *
 * CLI: `node bin/validate-kb-index.js --repair [cwd]` runs repair() directly
 * against a project root (default: process.cwd()) without needing a hook
 * stdin payload — for manual/CI invocation.
 *
 * Fail-open: any unexpected error → exit 0 (do not block legitimate work).
 */

const path = require('path');

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { validate, repair } = require('./_lib/kb-index-validator');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { readHookInputRaw } = require('./_lib/hook-stdin');

function _emitRepairedEvent(cwd, repairResult, triggerReason) {
  try {
    writeEvent({
      type: 'kb_index_repaired',
      version: 1,
      timestamp: new Date().toISOString(),
      index_path: repairResult.file_path,
      changes: repairResult.changes,
      change_count: repairResult.changes.length,
      trigger_reason: triggerReason || null,
    }, { cwd });
  } catch (_evErr) { /* fail-open on emit failure */ }
}

// --repair CLI path: bypass the stdin hook protocol entirely.
if (process.argv.includes('--repair')) {
  const cliCwdArg = process.argv.find((a, i) => i > 1 && !a.startsWith('-'));
  const cwd = resolveSafeCwd(cliCwdArg || process.cwd());
  let result;
  try {
    result = repair(cwd);
  } catch (err) {
    process.stderr.write('[orchestray] validate-kb-index --repair: threw: ' + (err && err.message) + '\n');
    process.exit(1);
  }
  if (result.repaired) {
    _emitRepairedEvent(cwd, result, 'manual_cli');
    process.stdout.write(
      '[orchestray] kb index repaired: ' + result.changes.length + ' change(s)\n' +
      JSON.stringify(result.changes, null, 2) + '\n'
    );
    process.exit(0);
  }
  process.stderr.write('[orchestray] kb index repair failed (reason=' + result.reason + ')\n');
  process.exit(1);
}

function _isIndexPath(p, cwd) {
  if (typeof p !== 'string' || p.length === 0) return false;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  const target = path.resolve(cwd, '.orchestray', 'kb', 'index.json');
  return abs === target;
}

let input = '';
input = readHookInputRaw();
if (input.length > MAX_INPUT_BYTES) process.exit(0);
setImmediate(() => {
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

  // D9: try mechanical auto-repair before blocking. A recoverable index
  // should never hard-block a KB write.
  let repairResult = null;
  try {
    repairResult = repair(cwd);
  } catch (_e) {
    repairResult = null;
  }

  if (repairResult && repairResult.repaired) {
    _emitRepairedEvent(cwd, repairResult, result.reason);
    process.exit(0); // repaired in place — let the original call proceed
  }

  // Not repairable (or repair itself failed) — emit + block, naming the
  // most specific reason we have (repair's, if it got further than validate's).
  const blockingReason = (repairResult && repairResult.reason) ? repairResult.reason : result.reason;
  try {
    writeEvent({
      type: 'kb_index_invalid',
      version: 1,
      timestamp: new Date().toISOString(),
      index_path: result.file_path,
      reason: result.reason,
      repair_attempted: !!repairResult,
      repair_reason: repairResult ? repairResult.reason : null,
    }, { cwd });
  } catch (_evErr) { /* fail-open on emit failure */ }

  const msg =
    '[orchestray] validate-kb-index: .orchestray/kb/index.json fails structural ' +
    'validation (reason=' + blockingReason + '). Refusing to write — repair the ' +
    'index by hand, via `node bin/validate-kb-index.js --repair`, or via ' +
    '`mcp__orchestray__kb_write` before retrying.';
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
