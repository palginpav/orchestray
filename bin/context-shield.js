#!/usr/bin/env node
'use strict';

/**
 * context-shield.js — PreToolUse:Read hook for Orchestray 2.0.14.
 *
 * Implements the CATRC (Cache-Aware Tool Result Compaction) primitive: R14.
 *
 * R14: On a second Read call for the same (file_path, offset, limit) triple
 * within a session where the file's mtime has not changed, return
 * permissionDecision: "deny" with a one-line hint pointing to the prior turn.
 * This eliminates cache-replay multiplication on re-reads.
 *
 * Input:  JSON on stdin (Claude Code PreToolUse hook payload)
 * Output: JSON on stdout:
 *   Allow:  { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" } }
 *   Deny:   {
 *             "hookSpecificOutput": {
 *               "hookEventName": "PreToolUse",
 *               "permissionDecision": "deny",
 *               "permissionDecisionReason": "<hint>"
 *             }
 *           }
 *
 * Fail-open contract: ANY unexpected error → exit 0 with allow decision so a
 * hook bug never blocks legitimate Read calls.
 *
 * Config: shield.r14_dedup_reads.enabled (default: true)
 *   Set to false in .orchestray/config.json to disable R14 globally.
 *   This flag is the degrade path for the smoke-test gate (G4): if the smoke
 *   test reveals that permissionDecision:"deny" surfaces to the agent as a hard
 *   tool-call failure rather than a soft signal, flip this to false.
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { loadShieldConfig } = require('./_lib/config-schema');
const { RULES } = require('./_lib/shield-rules');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// Env-var escape hatch: set ORCHESTRAY_SHIELD_DISABLED=1 for zero-overhead exit
// when the shield is permanently disabled (avoids even one config readFileSync).
if (process.env.ORCHESTRAY_SHIELD_DISABLED === '1') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function allowDecision() {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
}

function denyDecision(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// ---------------------------------------------------------------------------
// Main stdin processing
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(allowDecision());
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] context-shield: hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; failing open\n');
    process.stdout.write(allowDecision());
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  // Entire handler is wrapped in a try/catch to guarantee fail-open behavior.
  try {
    const event = JSON.parse(input || '{}');
    const cwd = resolveSafeCwd(event.cwd);

    // Only act on Read tool calls.  Any other tool_name gets an immediate allow.
    const toolName = event.tool_name || '';
    if (toolName !== 'Read') {
      process.stdout.write(allowDecision());
      process.exit(0);
    }

    // Load shield config.  Fail-open on any config error (loadShieldConfig
    // returns defaults on parse failure).
    const shieldConfig = loadShieldConfig(cwd);

    // If R14 is disabled via config, allow everything through.
    if (!shieldConfig.r14_dedup_reads || !shieldConfig.r14_dedup_reads.enabled) {
      process.stdout.write(allowDecision());
      process.exit(0);
    }

    // Resolve the session_id.
    const sessionId = event.session_id || 'unknown';

    // Stat the target file so rules can check mtime for cache invalidation.
    const toolInput = event.tool_input || {};
    const filePath = toolInput.file_path || toolInput.path || '';
    let fileStat = null;
    if (filePath) {
      try {
        // Resolve relative to cwd if not absolute, matching Claude Code behavior.
        const resolvedPath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(cwd, filePath);
        fileStat = fs.statSync(resolvedPath);
      } catch (_e) {
        // File may not exist yet, or may be unreadable — fileStat stays null.
        // Rules handle null fileStat as "no mtime → allow through".
      }
    }

    // Build the rule context.
    const ctx = {
      toolName,
      toolInput,
      event,
      cwd,
      sessionId,
      fileStat,
      config: shieldConfig,
    };

    // Evaluate rules in order — first deny wins.
    for (const rule of RULES) {
      let result;
      try {
        result = rule.apply(ctx);
      } catch (_e) {
        // A rule that throws is treated as allow (fail-open).
        process.stderr.write('[orchestray] context-shield: rule ' + rule.id + ' threw: ' + ((_e && _e.message) || 'unknown error') + '\n');
        continue;
      }

      if (result && result.decision === 'deny') {
        process.stdout.write(denyDecision(result.reason || 'orchestray-shield: denied by rule ' + rule.id));
        process.exit(0);
      }
      // decision === 'allow' or unknown → continue to next rule.
    }

    // All rules passed — allow.
    process.stdout.write(allowDecision());
    process.exit(0);

  } catch (_e) {
    // Top-level catch: any parse error, unexpected exception → fail open.
    process.stderr.write('[orchestray] context-shield: unexpected error: ' + ((_e && _e.message) || 'unknown error') + '\n');
    process.stdout.write(allowDecision());
    process.exit(0);
  }
});
