'use strict';

/**
 * config-schema.js — Authoritative defaults and loader for the mcp_enforcement config block.
 *
 * Used by gate-agent-spawn.js (T3) and any other hook scripts that need to read
 * mcp_enforcement settings.
 *
 * STATELESS by design: loadMcpEnforcement() re-reads the config file on every call
 * so that changes take effect without a session restart (DESIGN §D6 rule 6:
 * "No session reload required").
 *
 * TODO: switch validateMcpEnforcement() to zod once zod is added to package.json
 * dependencies (CLAUDE.md recommends zod for schema validation; it is not currently
 * installed — see grep result that found no zod in bin/ or package.json). For now,
 * validation is implemented with plain JS type checks.
 */

const fs = require('fs');
const path = require('path');

/**
 * Per-tool enforcement policy values.
 *   "hook"   — the gate checks for a matching MCP checkpoint before allowing spawn (default)
 *   "prompt" — gate skips the MCP-checkpoint requirement for this tool; warn only
 *   "allow"  — gate fully skips enforcement for this tool (legacy / opt-out)
 *
 * unknown_tool_policy values.
 *   "block"  — any tool_name not in the agent/skip allowlists is blocked (fail-closed, 2.0.12 default)
 *   "warn"   — log and allow (2.0.11 behaviour)
 *   "allow"  — fully fail-open
 */
const DEFAULT_MCP_ENFORCEMENT = Object.freeze({
  pattern_find: 'hook',
  kb_search: 'hook',
  history_find_similar_tasks: 'hook',
  pattern_record_application: 'hook', // Advisory — read by bin/record-pattern-skip.js (PreCompact), NOT by the gate. Setting this to 'prompt' or 'allow' suppresses the pattern_record_skipped advisory event.
  unknown_tool_policy: 'block',
  global_kill_switch: false,
});

const VALID_PER_TOOL_VALUES = ['hook', 'prompt', 'allow'];
const VALID_UNKNOWN_TOOL_POLICY = ['block', 'warn', 'allow'];

/**
 * Load and merge mcp_enforcement from <cwd>/.orchestray/config.json with defaults.
 *
 * Fail-open contract: if the config file is missing, unreadable, or malformed,
 * returns a shallow copy of DEFAULT_MCP_ENFORCEMENT so enforcement still applies
 * at safe defaults rather than crashing the hook.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {object} Merged mcp_enforcement object with all six keys guaranteed present.
 */
function loadMcpEnforcement(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    // File missing or unreadable — return defaults (fail-open)
    return Object.assign({}, DEFAULT_MCP_ENFORCEMENT);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    // Malformed JSON — return defaults (fail-open)
    return Object.assign({}, DEFAULT_MCP_ENFORCEMENT);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_MCP_ENFORCEMENT);
  }

  const fromFile = parsed.mcp_enforcement;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    // Key absent or wrong shape — return defaults
    return Object.assign({}, DEFAULT_MCP_ENFORCEMENT);
  }

  // Shallow merge: defaults fill in any missing keys; file values win for present keys
  const merged = Object.assign({}, DEFAULT_MCP_ENFORCEMENT, fromFile);

  // Validate merged result and warn on stderr — fail-open (always return merged).
  try {
    const result = validateMcpEnforcement(merged);
    if (!result.valid) {
      process.stderr.write(
        '[orchestray] mcp_enforcement config warnings: ' +
        result.errors.join('; ') + '\n'
      );
    }
  } catch (_e) {
    // Validation itself should never throw, but fail-open just in case.
  }

  return merged;
}

/**
 * Validate an mcp_enforcement object (as returned by loadMcpEnforcement or user input).
 *
 * @param {unknown} obj - Value to validate.
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateMcpEnforcement(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['mcp_enforcement must be an object'] };
  }

  const perToolKeys = ['pattern_find', 'kb_search', 'history_find_similar_tasks', 'pattern_record_application'];
  for (const key of perToolKeys) {
    if (key in obj) {
      const v = obj[key];
      if (!VALID_PER_TOOL_VALUES.includes(v)) {
        errors.push(
          `mcp_enforcement.${key} must be one of: ${VALID_PER_TOOL_VALUES.join(', ')} — got ${JSON.stringify(v)}`
        );
      }
    }
  }

  if ('unknown_tool_policy' in obj) {
    const v = obj.unknown_tool_policy;
    if (!VALID_UNKNOWN_TOOL_POLICY.includes(v)) {
      errors.push(
        `mcp_enforcement.unknown_tool_policy must be one of: ${VALID_UNKNOWN_TOOL_POLICY.join(', ')} — got ${JSON.stringify(v)}`
      );
    }
  }

  if ('global_kill_switch' in obj) {
    const v = obj.global_kill_switch;
    if (typeof v !== 'boolean') {
      errors.push(
        `mcp_enforcement.global_kill_switch must be a boolean — got ${JSON.stringify(v)}`
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

module.exports = {
  DEFAULT_MCP_ENFORCEMENT,
  loadMcpEnforcement,
  validateMcpEnforcement,
};
