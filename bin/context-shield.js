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
const { writeEvent } = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

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
// v2.2.8: redirect Reads of event-schemas.md to mcp__orchestray__schema_get,
// with a worked example in the deny message and conversion tracking via
// schema_redirect_emitted / schema_redirect_followed events.
// ---------------------------------------------------------------------------

/**
 * Guess a slug from a tool input or context string.
 * Looks for snake_case tokens that end with common event-type suffixes.
 * Falls back to 'agent_start' as a generic example slug.
 *
 * @param {object} toolInput
 * @returns {string}
 */
function guessSlug(toolInput) {
  const candidates = [
    toolInput.file_path || '',
    toolInput.path || '',
  ];
  const EVENT_SUFFIX_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:_emit|_call|_blocked|_action|_start|_stop|_outcome|_savings|_followed|_emitted))\b/g;
  for (const str of candidates) {
    const matches = Array.from(String(str).matchAll(EVENT_SUFFIX_RE));
    if (matches.length > 0) {
      return matches[0][1];
    }
  }
  return 'agent_start';
}

// Roles that legitimately need the full event-schemas.md file (schema design,
// release prep, documentation). They bypass the redirect and Read directly.
// W-DO-5 (v2.2.21): The null/orchestrator-session bypass has been removed so
// that the block applies to ALL agent roles, including the PM orchestrator.
// Only the three roles listed here may Read the full file directly.
const FULL_READ_ALLOWED_AGENTS = new Set([
  'architect',
  'release-manager',
  'documenter',
]);

/**
 * Returns a redirect reason string when the given toolInput targets
 * agents/pm-reference/event-schemas.md and the config gate is active,
 * or null when the Read should be allowed through.
 *
 * Honor opt-out: config.event_schemas.full_load_disabled === false bypasses.
 * Default (no config key present): disabled === true → redirect.
 *
 * Bypass roles: agentType in FULL_READ_ALLOWED_AGENTS, or null/absent.
 *
 * v2.2.9 B-5.2: when bypass triggers (allowlist or null-agent-type), emit
 * `schema_redirect_bypassed` so operators can observe whether the bypass-by-
 * agent-type list is too permissive. Pure observability — does NOT change
 * bypass behavior. Kill switch: ORCHESTRAY_SCHEMA_REDIRECT_BYPASS_TELEMETRY_DISABLED=1.
 *
 * @param {object} toolInput - Raw tool_input from the hook payload.
 * @param {object|null} rawConfig - Parsed config.json (may be null on read failure).
 * @param {string|null} agentType - Calling agent role (null for orchestrator).
 * @param {string} cwd - Project root for emit context.
 * @returns {{ reason: string, slug: string }|null}
 */
function shouldRedirectEventSchemasRead(toolInput, rawConfig, agentType, cwd) {
  // Honor opt-out: if config.event_schemas.full_load_disabled === false, skip.
  const disabled = !(rawConfig && rawConfig.event_schemas && rawConfig.event_schemas.full_load_disabled === false);
  if (!disabled) return null;

  // v2.2.9 B-5.2 — pre-check bypass conditions and emit observability event.
  // Only emit when the read would have been redirect-target (agents/pm-reference/event-schemas.md)
  // so we don't flood on unrelated reads.
  const fpForBypass = toolInput.file_path || toolInput.path || '';
  let isRedirectTarget = false;
  if (fpForBypass) {
    const normCheck = String(fpForBypass).replace(/\\/g, '/');
    const baseCheck = normCheck.split('/').pop() || '';
    isRedirectTarget = baseCheck === 'event-schemas.md' && normCheck.includes('agents/pm-reference/');
  }

  // Roles that need the full file pass through. The orchestrator (null/absent
  // agent_type) also bypasses — the user's main Claude Code session is
  // never blocked. W-DO-5 (v2.2.21): all named agent roles that are NOT in
  // FULL_READ_ALLOWED_AGENTS are subject to the redirect; this applies to
  // every role including pm, developer, refactorer, reviewer, etc.
  if (!agentType || FULL_READ_ALLOWED_AGENTS.has(agentType)) {
    if (isRedirectTarget) {
      try {
        if (process.env.ORCHESTRAY_SCHEMA_REDIRECT_BYPASS_TELEMETRY_DISABLED !== '1') {
          const oid = resolveOrchestrationId(cwd);
          writeEvent({
            type:           'schema_redirect_bypassed',
            version:        1,
            schema_version: 1,
            timestamp:      new Date().toISOString(),
            orchestration_id: oid,
            agent_type:     agentType || 'null',
            file_path:      fpForBypass,
            bypass_reason:  agentType ? 'allowlist' : 'null_agent',
          }, { cwd });
        }
      } catch (_e) { /* fail-open */ }
    }
    return null;
  }

  const fp = toolInput.file_path || toolInput.path || '';
  if (!fp) return null;

  const normalized = String(fp).replace(/\\/g, '/');
  const basename = normalized.split('/').pop() || '';
  if (basename !== 'event-schemas.md') return null;
  if (!normalized.includes('agents/pm-reference/')) return null;

  const slug = guessSlug(toolInput);

  const reason = [
    'Read of agents/pm-reference/event-schemas.md is disabled. Use the chunked-load MCP tool instead.',
    '',
    "Example: `mcp__orchestray__schema_get(slug='" + slug + "')`",
    '',
    'The slug is the event_type field of the event you want. Common slugs: `agent_start`, `agent_stop`,',
    '`routing_outcome`, `tokenwright_realized_savings`, `prompt_compression`. Full list: call',
    "`mcp__orchestray__schema_get(slug='_index')`.",
    '',
    'To restore the legacy full-file Read, set event_schemas.full_load_disabled: false in .orchestray/config.json.',
  ].join('\n');

  return { reason, slug };
}

/**
 * Resolve the current orchestration_id from state, fail-open to 'unknown'.
 * @param {string} cwd
 * @returns {string}
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    if (orchData && orchData.orchestration_id) return orchData.orchestration_id;
  } catch (_e) { /* keep unknown */ }
  return 'unknown';
}

/**
 * Write a schema_redirect_emitted event and a pending sentinel for follow-through
 * detection. Both are best-effort; errors are swallowed (fail-open).
 *
 * @param {string} cwd
 * @param {string} oid
 * @param {string} filePath
 * @param {string} agentType
 * @param {string} slug
 */
function emitRedirectEmitted(cwd, oid, filePath, agentType, slug) {
  try {
    writeEvent({
      version: 1,
      schema_version: 1,
      timestamp: new Date().toISOString(),
      type: 'schema_redirect_emitted',
      orchestration_id: oid,
      blocking_path: filePath,
      suggested_tool: 'mcp__orchestray__schema_get',
      suggested_slug: slug,
    }, { cwd });
  } catch (_e) { /* fail-open */ }

  // Write sentinel for PostToolUse follow-through detection.
  try {
    const sentinelDir = path.join(cwd, '.orchestray', 'state');
    const sentinelPath = path.join(sentinelDir, 'schema-redirect-pending.jsonl');
    const record = JSON.stringify({
      orchestration_id: oid,
      agent_type: agentType || null,
      ts: new Date().toISOString(),
      suggested_slug: slug,
    }) + '\n';
    fs.mkdirSync(sentinelDir, { recursive: true });
    fs.appendFileSync(sentinelPath, record, 'utf8');
  } catch (_e) { /* fail-open */ }
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

    const toolInput = event.tool_input || {};

    // Load raw config for event_schemas gate (fail-open: null on any error).
    let rawConfig = null;
    try {
      const configPath = path.join(cwd, '.orchestray', 'config.json');
      rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_e) {
      // Config absent or malformed — rawConfig stays null (default-on).
    }

    // Check event-schemas.md redirect BEFORE R14 dedup.
    // Pass through the calling agent_type so the orchestrator (null) and
    // architect/release-manager/documenter roles bypass the redirect.
    const agentType = event.agent_type || null;
    const redirectResult = shouldRedirectEventSchemasRead(toolInput, rawConfig, agentType, cwd);
    if (redirectResult) {
      const oid = resolveOrchestrationId(cwd);
      // Backward-compat: emit event_schemas_full_load_blocked(source: 'pretool-deny')
      // alongside schema_redirect_emitted so v2.2.7 tests / analytics still work.
      try {
        writeEvent({
          version: 1,
          schema_version: 1,
          timestamp: new Date().toISOString(),
          type: 'event_schemas_full_load_blocked',
          orchestration_id: oid,
          file_path: toolInput.file_path || toolInput.path,
          agent_role: agentType,
          source: 'pretool-deny',
        }, { cwd });
      } catch (_e) { /* fail-open */ }
      emitRedirectEmitted(cwd, oid, toolInput.file_path || toolInput.path || '', agentType, redirectResult.slug);
      process.stdout.write(denyDecision(redirectResult.reason));
      process.exit(0);
    }

    // If R14 is disabled via config, allow everything through.
    if (!shieldConfig.r14_dedup_reads || !shieldConfig.r14_dedup_reads.enabled) {
      process.stdout.write(allowDecision());
      process.exit(0);
    }

    // Resolve the session_id.
    const sessionId = event.session_id || 'unknown';
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
