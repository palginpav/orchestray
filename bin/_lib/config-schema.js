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
 * Remove prototype-pollution keys from a user-supplied config object before
 * merging via Object.assign. Strips __proto__, constructor, and prototype so
 * a crafted config file cannot modify the merged object's prototype chain.
 *
 * @param {unknown} obj
 * @returns {object} Safe shallow copy with dangerous keys removed, or {} on bad input.
 */
function sanitizeConfig(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const { __proto__: _a, constructor: _b, prototype: _c, ...safe } = obj;
  return safe;
}

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

  // Shallow merge: defaults fill in any missing keys; file values win for present keys.
  // sanitizeConfig strips __proto__/constructor/prototype to prevent prototype pollution.
  const merged = Object.assign({}, DEFAULT_MCP_ENFORCEMENT, sanitizeConfig(fromFile));

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

// ---------------------------------------------------------------------------
// audit section defaults and loader
//
// audit.max_events_bytes_for_scan — positive integer or null.
//   null means "use env var ORCHESTRAY_MAX_EVENTS_BYTES or the built-in default".
//   Precedence chain (resolved at module load in collect-agent-metrics.js):
//     1. env ORCHESTRAY_MAX_EVENTS_BYTES (integer, must be > 0)
//     2. this config key (positive integer, or null → fall through)
//     3. built-in default (see MAX_EVENTS_BYTES_DEFAULT in collect-agent-metrics.js)
//   BUG-PERF-2.0.13: see collect-agent-metrics.js for full context.
// ---------------------------------------------------------------------------

const DEFAULT_AUDIT = Object.freeze({
  /**
   * Maximum bytes to read from events.jsonl when scanning for routing_outcome events.
   * null = use env var or built-in default; positive integer = explicit override.
   */
  max_events_bytes_for_scan: null,
});

/**
 * Load and validate the audit block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: any missing/malformed value returns DEFAULT_AUDIT so the
 * hook still runs at a safe default rather than crashing.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ max_events_bytes_for_scan: number|null }}
 */
function loadAuditConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_AUDIT);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_AUDIT);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_AUDIT);
  }

  const fromFile = parsed.audit;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_AUDIT);
  }

  const merged = Object.assign({}, DEFAULT_AUDIT, sanitizeConfig(fromFile));

  // Validate: warn on stderr but always return merged (fail-open)
  try {
    const result = validateAuditConfig(merged);
    if (!result.valid) {
      process.stderr.write(
        '[orchestray] audit config warnings: ' +
        result.errors.join('; ') + '\n'
      );
    }
  } catch (_e) {
    // Validation must never throw
  }

  return merged;
}

/**
 * Validate an audit config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateAuditConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['audit config must be an object'] };
  }

  if ('max_events_bytes_for_scan' in obj) {
    const v = obj.max_events_bytes_for_scan;
    if (v !== null) {
      if (!Number.isInteger(v)) {
        errors.push('audit.max_events_bytes_for_scan must be a positive integer or null — got ' + JSON.stringify(v));
      } else if (v <= 0) {
        errors.push('audit.max_events_bytes_for_scan must be > 0 — got ' + v);
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// shield section defaults and loader
//
// shield.r14_dedup_reads.enabled — boolean, default true.
//   When true, the context-shield.js PreToolUse:Read hook will deny re-reads of
//   the same (file_path, offset, limit) triple within a session where the file's
//   mtime has not changed (R14 rule).
//
//   Set to false if the smoke-test gate (G4) reveals that permissionDecision:
//   "deny" on native Read calls surfaces as a hard tool-call failure rather than
//   a soft "already read" signal.  Disabling here reverts to allow-everything
//   behavior without removing any code.
//
// The shield section is structured so that W3's cost_budget_check config can be
// added as a sibling section (shield.cost_budget_check.*) or alongside shield in
// a separate top-level key (mcp_server.cost_budget_check.*) without touching
// these keys — each sub-section is an independently mergeable block.
// ---------------------------------------------------------------------------

const DEFAULT_SHIELD = Object.freeze({
  r14_dedup_reads: Object.freeze({
    enabled: true,
  }),
});

/**
 * Load and merge the shield config section from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing file, unreadable, or malformed JSON returns
 * DEFAULT_SHIELD so the hook still runs at safe defaults.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ r14_dedup_reads: { enabled: boolean } }}
 */
function loadShieldConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return {
      r14_dedup_reads: Object.assign({}, DEFAULT_SHIELD.r14_dedup_reads),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {
      r14_dedup_reads: Object.assign({}, DEFAULT_SHIELD.r14_dedup_reads),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      r14_dedup_reads: Object.assign({}, DEFAULT_SHIELD.r14_dedup_reads),
    };
  }

  const fromFile = parsed.shield;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return {
      r14_dedup_reads: Object.assign({}, DEFAULT_SHIELD.r14_dedup_reads),
    };
  }

  // Merge r14_dedup_reads sub-section.
  // sanitizeConfig strips __proto__/constructor/prototype to prevent prototype pollution.
  const r14FromFile = fromFile.r14_dedup_reads;
  const r14Merged = Object.assign(
    {},
    DEFAULT_SHIELD.r14_dedup_reads,
    (r14FromFile && typeof r14FromFile === 'object' && !Array.isArray(r14FromFile))
      ? sanitizeConfig(r14FromFile)
      : {}
  );

  // Validate and warn — always return merged (fail-open).
  try {
    const result = validateShieldConfig({ r14_dedup_reads: r14Merged });
    if (!result.valid) {
      process.stderr.write(
        '[orchestray] shield config warnings: ' +
        result.errors.join('; ') + '\n'
      );
    }
  } catch (_e) {
    // Validation must never throw
  }

  return { r14_dedup_reads: r14Merged };
}

/**
 * Validate a shield config object (as returned by loadShieldConfig).
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateShieldConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['shield config must be an object'] };
  }

  if ('r14_dedup_reads' in obj) {
    const r14 = obj.r14_dedup_reads;
    if (!r14 || typeof r14 !== 'object' || Array.isArray(r14)) {
      errors.push('shield.r14_dedup_reads must be an object');
    } else if ('enabled' in r14 && typeof r14.enabled !== 'boolean') {
      errors.push(
        'shield.r14_dedup_reads.enabled must be a boolean — got ' + JSON.stringify(r14.enabled)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// cost_budget_check section defaults and loader
//
// mcp_server.cost_budget_check.pricing_table — model pricing table used by the
//   cost_budget_check MCP tool to project spawn costs before calling Agent().
//   Structure: { <tier>: { input_per_1m: number, output_per_1m: number } }
//   Supported tiers: haiku, sonnet, opus.
//   Current Anthropic rates (2026): haiku $1/$5, sonnet $3/$15, opus $5/$25.
//
// mcp_server.cost_budget_check.last_verified — ISO date string ('YYYY-MM-DD')
//   recording when the pricing table was last verified against Anthropic's
//   published rates. Used as a drift-detection signal (R3 risk mitigation).
//
// This section is in the mcp_server subtree (mcp_server.cost_budget_check.*)
// and is independent of the shield section — they are sibling config blocks.
// Per 2014-scope-proposal.md §W3.
// ---------------------------------------------------------------------------

const DEFAULT_COST_BUDGET_CHECK = Object.freeze({
  pricing_table: Object.freeze({
    haiku:  Object.freeze({ input_per_1m: 1.00,  output_per_1m: 5.00  }),
    sonnet: Object.freeze({ input_per_1m: 3.00,  output_per_1m: 15.00 }),
    opus:   Object.freeze({ input_per_1m: 5.00,  output_per_1m: 25.00 }),
  }),
  last_verified: '2026-04-11',
});

/**
 * Load and merge the cost_budget_check config section from
 * <cwd>/.orchestray/config.json -> mcp_server.cost_budget_check.
 *
 * Fail-open contract: any missing/malformed value returns DEFAULT_COST_BUDGET_CHECK
 * so the tool can still project costs at safe defaults.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ pricing_table: object, last_verified: string }}
 */
function loadCostBudgetCheckConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
    };
  }

  const mcpServer = parsed.mcp_server;
  if (!mcpServer || typeof mcpServer !== 'object' || Array.isArray(mcpServer)) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
    };
  }

  const fromFile = mcpServer.cost_budget_check;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
    };
  }

  // Merge pricing_table sub-section: file values override defaults per tier,
  // missing tiers fall back to defaults (preserves user-customized entries).
  // sanitizeConfig strips __proto__/constructor/prototype to prevent prototype pollution.
  const ptFromFile = fromFile.pricing_table;
  const mergedTable = Object.assign(
    {},
    DEFAULT_COST_BUDGET_CHECK.pricing_table,
    (ptFromFile && typeof ptFromFile === 'object' && !Array.isArray(ptFromFile))
      ? sanitizeConfig(ptFromFile)
      : {}
  );

  const lastVerified =
    (fromFile.last_verified && typeof fromFile.last_verified === 'string')
      ? fromFile.last_verified
      : DEFAULT_COST_BUDGET_CHECK.last_verified;

  // Validate and warn — always return merged (fail-open).
  try {
    const result = validateCostBudgetCheckConfig({ pricing_table: mergedTable, last_verified: lastVerified });
    if (!result.valid) {
      process.stderr.write(
        '[orchestray] cost_budget_check config warnings: ' +
        result.errors.join('; ') + '\n'
      );
    }
  } catch (_e) {
    // Validation must never throw
  }

  return { pricing_table: mergedTable, last_verified: lastVerified };
}

/**
 * Validate a cost_budget_check config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateCostBudgetCheckConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['cost_budget_check config must be an object'] };
  }

  if ('pricing_table' in obj) {
    const pt = obj.pricing_table;
    if (!pt || typeof pt !== 'object' || Array.isArray(pt)) {
      errors.push('cost_budget_check.pricing_table must be an object');
    } else {
      for (const [tier, entry] of Object.entries(pt)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          errors.push(`cost_budget_check.pricing_table.${tier} must be an object`);
          continue;
        }
        if (typeof entry.input_per_1m !== 'number' || entry.input_per_1m < 0) {
          errors.push(
            `cost_budget_check.pricing_table.${tier}.input_per_1m must be a non-negative number`
          );
        }
        if (typeof entry.output_per_1m !== 'number' || entry.output_per_1m < 0) {
          errors.push(
            `cost_budget_check.pricing_table.${tier}.output_per_1m must be a non-negative number`
          );
        }
      }
    }
  }

  if ('last_verified' in obj && obj.last_verified !== null) {
    if (typeof obj.last_verified !== 'string') {
      errors.push(
        'cost_budget_check.last_verified must be a string (YYYY-MM-DD) — got ' +
        JSON.stringify(obj.last_verified)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

module.exports = {
  DEFAULT_MCP_ENFORCEMENT,
  loadMcpEnforcement,
  DEFAULT_AUDIT,
  loadAuditConfig,
  DEFAULT_SHIELD,
  loadShieldConfig,
  DEFAULT_COST_BUDGET_CHECK,
  loadCostBudgetCheckConfig,
};
