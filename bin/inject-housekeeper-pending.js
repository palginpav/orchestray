#!/usr/bin/env node
'use strict';

/**
 * inject-housekeeper-pending.js — PreToolUse:Agent hook (v2.2.8 Item 1).
 *
 * Drains the `.orchestray/state/housekeeper-pending.json` sentinel written
 * by spawn-housekeeper-on-trigger.js and either:
 *   (a) If the next Agent spawn IS `orchestray-housekeeper`: clear the
 *       sentinel and allow the spawn through unmodified.
 *   (b) If the next Agent spawn is anything else: prepend a pending-trigger
 *       note to the prompt reminding the PM to spawn the housekeeper after
 *       the current task completes, then clear the sentinel.
 *
 * Fail-safe: a corrupted or unreadable sentinel MUST NOT block a real spawn.
 * Any error → log to stderr, emit passthrough, exit 0.
 *
 * Kill switches:
 *   process.env.ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER === '1'
 *   config.housekeeping.auto_delegate.enabled === false
 *
 * Input:  Claude Code PreToolUse hook payload on stdin
 *         { hook_event_name, tool_name, tool_input: { subagent_type, prompt, ... }, cwd }
 * Output: JSON on stdout:
 *           When prompt is mutated:
 *             { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *               permissionDecision: 'allow',
 *               updatedInput: { ...original tool_input, prompt: <prepended> } },
 *               continue: true }
 *           Otherwise:
 *             { continue: true }
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');

const SENTINEL_REL = path.join('.orchestray', 'state', 'housekeeper-pending.json');

// ---------------------------------------------------------------------------
// Config / kill-switch check
// ---------------------------------------------------------------------------
function isDisabled(cwd) {
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
// stdout helpers
// ---------------------------------------------------------------------------
function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

function emitAllowWithUpdatedInput(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName:      'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
    continue: true,
  }));
}

// ---------------------------------------------------------------------------
// Pending-trigger note injected into non-housekeeper spawns
// ---------------------------------------------------------------------------
function buildPendingNote(triggerType) {
  return (
    '## Pending housekeeper trigger\n\n' +
    'A housekeeper run is queued (trigger: ' + triggerType + '). ' +
    "After your task completes, the next spawn should be " +
    "`Agent(subagent_type='orchestray-housekeeper', ...)`."
  );
}

// ---------------------------------------------------------------------------
// Clear sentinel (best-effort — fail-open if removal fails)
// ---------------------------------------------------------------------------
function clearSentinel(sentinelPath) {
  try { fs.unlinkSync(sentinelPath); } catch (_e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  try {
    // Read stdin.
    const chunks = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        process.stderr.write('[inject-housekeeper-pending] stdin too large, skipping\n');
        emitContinue();
        return;
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) { emitContinue(); return; }

    let event;
    try { event = JSON.parse(raw); }
    catch (_e) {
      process.stderr.write('[inject-housekeeper-pending] invalid JSON on stdin\n');
      emitContinue();
      return;
    }

    // Only act on Agent spawns.
    if (event.tool_name !== 'Agent') { emitContinue(); return; }

    const cwd          = resolveSafeCwd(event.cwd);
    const sentinelPath = path.join(cwd, SENTINEL_REL);

    // Kill-switch check — if disabled, passthrough.
    if (isDisabled(cwd)) { emitContinue(); return; }

    // Read sentinel.
    let sentinel;
    try {
      sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
    } catch (_e) {
      // No sentinel → passthrough.
      emitContinue();
      return;
    }

    if (!sentinel || typeof sentinel.trigger_type !== 'string') {
      // Corrupted sentinel — clear and passthrough (fail-open).
      clearSentinel(sentinelPath);
      emitContinue();
      return;
    }

    const toolInput   = event.tool_input || {};
    const agentType   = toolInput.subagent_type || '';
    const triggerType = sentinel.trigger_type;

    if (agentType === 'orchestray-housekeeper') {
      // The spawn IS the housekeeper — just drain the sentinel.
      clearSentinel(sentinelPath);
      emitContinue();
      return;
    }

    // Some other agent — prepend the pending note and clear the sentinel.
    const originalPrompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
    const note           = buildPendingNote(triggerType);
    const newPrompt      = note + '\n\n' + originalPrompt;

    clearSentinel(sentinelPath);

    const updatedInput = Object.assign({}, toolInput, { prompt: newPrompt });
    emitAllowWithUpdatedInput(updatedInput);

  } catch (err) {
    // Top-level fail-open — never block a spawn.
    process.stderr.write(
      '[inject-housekeeper-pending] unexpected error: ' +
      (err && err.message ? err.message : String(err)) + '\n'
    );
    emitContinue();
  }
})();
