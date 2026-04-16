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
 * TODO(backlog): switch validateMcpEnforcement() to zod once zod is added to package.json
 */

const fs = require('fs');
const path = require('path');

/**
 * Write a prefixed diagnostic line to stderr (mirrors logStderr in mcp-server/lib/rpc.js
 * but lives here so _lib modules stay independent of the mcp-server subtree).
 * @param {string} msg
 */
function logStderr(msg) {
  try { process.stderr.write('[orchestray] ' + msg + '\n'); } catch (_e) {}
}

/**
 * Remove prototype-pollution keys from a user-supplied config object before
 * merging via Object.assign. Strips __proto__, constructor, and prototype so
 * a crafted config file cannot modify the merged object's prototype chain.
 *
 * S5 (T3 reviewer observation): This function is intentionally shallow — it
 * does not recurse into nested objects (e.g., pricing_table tier entries).
 * That is safe because all nested objects are consumed only by validators that
 * read known keys (e.g., validateCostBudgetCheckConfig iterates
 * Object.entries(pt) and only reads `input_per_1m`/`output_per_1m`). A
 * prototype-polluted nested object cannot inject unexpected values through
 * those read paths. No action required; this comment confirms the defense-in-
 * depth is adequate.
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
  // D2 v2.0.16 Stage C: default flipped from 'hook-warn' to 'hook-strict' (blocking).
  // User explicitly approved this flip (2026-04-15) with zero field data — see D2 risk note in
  // v2016-devb-report.md. Mitigation: post-upgrade-sweep seeds 'hook-warn' on existing installs
  // so the strict default only hits fresh installs. Set pattern_record_application:'hook-warn'
  // in .orchestray/config.json to opt back to advisory mode.
  pattern_record_application: 'hook-strict', // Second-spawn post-decomposition gate: 'hook-warn' = warn+allow; 'hook-strict' = block. Set by the gate in gate-agent-spawn.js. Advisory-only for first spawn.
  // T3 A1: Add 2.0.14 tools to the enforcement model. Default 'allow' because
  // neither tool is gated (pattern_record_skip_reason is advisory-only;
  // cost_budget_check is advisory-only in 2.0.14/2.0.15). Absent keys cause
  // unknown_tool_policy to evaluate them, which can produce unexpected block/warn
  // signals if an operator sets unknown_tool_policy:'block'.
  pattern_record_skip_reason: 'allow',
  cost_budget_check: 'allow',
  // W6: kb_write is advisory/write-scoped (not a spawn-gate tool) — 'allow' is
  // appropriate so unknown_tool_policy:'block' installations don't block it.
  kb_write: 'allow',
  // v2.0.16 new tools: routing_lookup and cost_budget_reserve are advisory-only
  // (no spawn-gate role) — 'allow' prevents unknown_tool_policy:'block' from
  // blocking them on fresh and upgraded installs.
  routing_lookup: 'allow',
  cost_budget_reserve: 'allow',
  // v2.0.16 D1: pattern_deprecate is a write tool (not spawn-gate) — 'allow' is safe.
  pattern_deprecate: 'allow',
  // v2.0.17 T5: metrics_query is read-only telemetry — 'allow' prevents
  // unknown_tool_policy:'block' from blocking it on fresh and upgraded installs.
  metrics_query: 'allow',
  unknown_tool_policy: 'block',
  global_kill_switch: false,
});

// W5 (v2.0.15): add `hook-warn` (unconditional warn-mode advisory) and
// `hook-strict` (opt-in blocking) to the §22c escalation ladder.
// Stage C shipped in the 2.0.16 amendment: default is now `hook-strict` (blocking).
// Operators can revert to advisory mode via mcp_enforcement.pattern_record_application: 'hook-warn'
// (or 'hook') in .orchestray/config.json.
const VALID_PER_TOOL_VALUES = ['hook', 'hook-warn', 'hook-strict', 'prompt', 'allow'];
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
      logStderr('mcp_enforcement config warnings: ' + result.errors.join('; '));
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

  // T3 A1: perToolKeys must stay in sync with DEFAULT_MCP_ENFORCEMENT. Add
  // pattern_record_skip_reason and cost_budget_check so operator configs that
  // include these keys are validated rather than silently accepted.
  // W6: add kb_write (2.0.15 addition).
  const perToolKeys = [
    'pattern_find',
    'kb_search',
    'history_find_similar_tasks',
    'pattern_record_application',
    'pattern_record_skip_reason',
    'cost_budget_check',
    'kb_write',
    // v2.0.16 additions (W3/W4)
    'routing_lookup',
    'cost_budget_reserve',
    // v2.0.16 D1
    'pattern_deprecate',
    // v2.0.17 T5
    'metrics_query',
  ];
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
    // T1 H5 (v2.0.15): `kill_switch_reason` is required when the kill switch is
    // active — makes blast-radius auditable in events.jsonl.
    if (v === true) {
      const reason = obj.kill_switch_reason;
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        errors.push(
          'mcp_enforcement.kill_switch_reason is required (non-empty string) when global_kill_switch is true'
        );
      }
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
      logStderr('audit config warnings: ' + result.errors.join('; '));
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
      logStderr('shield config warnings: ' + result.errors.join('; '));
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
 * @returns {{ pricing_table: object, last_verified: string, effort_multipliers: object|null }}
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
      effort_multipliers: null,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
      effort_multipliers: null,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
      effort_multipliers: null,
    };
  }

  const mcpServer = parsed.mcp_server;
  if (!mcpServer || typeof mcpServer !== 'object' || Array.isArray(mcpServer)) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
      effort_multipliers: null,
    };
  }

  const fromFile = mcpServer.cost_budget_check;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return {
      pricing_table: Object.assign({}, DEFAULT_COST_BUDGET_CHECK.pricing_table),
      last_verified: DEFAULT_COST_BUDGET_CHECK.last_verified,
      effort_multipliers: null,
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

  // W15 (v2.0.16): load optional effort_multipliers sub-block.
  // null/absent → callers fall back to DEFAULT_EFFORT_MULTIPLIERS.
  const emFromFile = fromFile.effort_multipliers;
  const effortMultipliers =
    (emFromFile && typeof emFromFile === 'object' && !Array.isArray(emFromFile))
      ? sanitizeConfig(emFromFile)
      : null;

  // Validate and warn — always return merged (fail-open).
  try {
    const result = validateCostBudgetCheckConfig({ pricing_table: mergedTable, last_verified: lastVerified });
    if (!result.valid) {
      logStderr('cost_budget_check config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return { pricing_table: mergedTable, last_verified: lastVerified, effort_multipliers: effortMultipliers };
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

// ---------------------------------------------------------------------------
// cost_budget_enforcement section defaults and loader (W5 v2.0.16)
//
// cost_budget_enforcement.enabled — boolean, default false.
//   When false, the gate-cost-budget.js PreToolUse:Agent hook skips all checks.
//   Opt-in: set to true to activate the H1 cost gate.
//
// cost_budget_enforcement.hard_block — boolean, default true (D3 v2.0.16).
//   When true: exit 2 on breach (hard block). When false: stderr warn + exit 0.
//   This is LOW-RISK because enforcement is only active when enabled=true (default false).
//   Operators who explicitly enable enforcement get hard-block by default, which is the
//   expected behavior for a cost gate. Downgrade to false in config if soft-block is needed.
//   Post-upgrade-sweep seeds existing explicit 'hard_block: false' values intact.
// ---------------------------------------------------------------------------

const DEFAULT_COST_BUDGET_ENFORCEMENT = Object.freeze({
  enabled: false,
  hard_block: true,
});

/**
 * Load and merge the cost_budget_enforcement block from
 * <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_COST_BUDGET_ENFORCEMENT.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ enabled: boolean, hard_block: boolean }}
 */
function loadCostBudgetEnforcementConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_COST_BUDGET_ENFORCEMENT);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_COST_BUDGET_ENFORCEMENT);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_COST_BUDGET_ENFORCEMENT);
  }

  const fromFile = parsed.cost_budget_enforcement;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_COST_BUDGET_ENFORCEMENT);
  }

  const merged = Object.assign({}, DEFAULT_COST_BUDGET_ENFORCEMENT, sanitizeConfig(fromFile));

  try {
    const result = validateCostBudgetEnforcementConfig(merged);
    if (!result.valid) {
      logStderr('cost_budget_enforcement config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return merged;
}

/**
 * Validate a cost_budget_enforcement config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateCostBudgetEnforcementConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['cost_budget_enforcement must be an object'] };
  }

  if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
    errors.push(
      'cost_budget_enforcement.enabled must be a boolean — got ' + JSON.stringify(obj.enabled)
    );
  }

  if ('hard_block' in obj && typeof obj.hard_block !== 'boolean') {
    errors.push(
      'cost_budget_enforcement.hard_block must be a boolean — got ' + JSON.stringify(obj.hard_block)
    );
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// routing_gate section defaults and loader (D7 v2.0.16)
//
// routing_gate.auto_seed_on_miss — boolean, default true.
//   When true: if no routing entry is found for an Agent() spawn (task_id + description
//   both miss), the gate emits a stderr warning and auto-seeds a synthetic entry to
//   routing.jsonl rather than hard-blocking (exit 2). The PM should write a proper
//   entry per Section 19 before spawning. Set to false to restore the prior hard-fail.
// ---------------------------------------------------------------------------

const DEFAULT_ROUTING_GATE = Object.freeze({
  auto_seed_on_miss: true,
});

/**
 * Load and merge the routing_gate config section from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_ROUTING_GATE.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ auto_seed_on_miss: boolean }}
 */
function loadRoutingGateConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_ROUTING_GATE);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_ROUTING_GATE);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_ROUTING_GATE);
  }

  const fromFile = parsed.routing_gate;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_ROUTING_GATE);
  }

  const merged = Object.assign({}, DEFAULT_ROUTING_GATE, sanitizeConfig(fromFile));

  // Validate auto_seed_on_miss
  if ('auto_seed_on_miss' in merged && typeof merged.auto_seed_on_miss !== 'boolean') {
    logStderr('routing_gate.auto_seed_on_miss must be a boolean — got ' + JSON.stringify(merged.auto_seed_on_miss) + '; using default');
    merged.auto_seed_on_miss = DEFAULT_ROUTING_GATE.auto_seed_on_miss;
  }

  return merged;
}

// ---------------------------------------------------------------------------
// cost_budget_reserve section defaults and loader (D5 v2.0.16)
//
// mcp_server.cost_budget_reserve.ttl_minutes — integer 1..1440, default 30.
//   Controls how long a cost reservation remains active. The reservation's
//   expires_at is computed as created_at + ttl_minutes * 60 * 1000 ms.
//   Used by loadReservationTTLMs() in cost-helpers.js.
// ---------------------------------------------------------------------------

const DEFAULT_COST_BUDGET_RESERVE = Object.freeze({
  ttl_minutes: 30,
});

/**
 * Load the cost_budget_reserve config section TTL value.
 * Returns ttl_minutes as an integer, validated to range 1..1440.
 * Falls back to DEFAULT_COST_BUDGET_RESERVE.ttl_minutes on any error.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ ttl_minutes: number }}
 */
function loadCostBudgetReserveConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_COST_BUDGET_RESERVE);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_COST_BUDGET_RESERVE);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_COST_BUDGET_RESERVE);
  }

  const mcpServer = parsed.mcp_server;
  if (!mcpServer || typeof mcpServer !== 'object' || Array.isArray(mcpServer)) {
    return Object.assign({}, DEFAULT_COST_BUDGET_RESERVE);
  }

  const fromFile = mcpServer.cost_budget_reserve;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_COST_BUDGET_RESERVE);
  }

  let ttl = DEFAULT_COST_BUDGET_RESERVE.ttl_minutes;
  if ('ttl_minutes' in fromFile) {
    const v = fromFile.ttl_minutes;
    if (Number.isInteger(v) && v >= 1 && v <= 1440) {
      ttl = v;
    } else {
      logStderr(
        'mcp_server.cost_budget_reserve.ttl_minutes must be an integer 1..1440 — got ' +
        JSON.stringify(v) + '; using default 30'
      );
    }
  }

  return { ttl_minutes: ttl };
}

// ---------------------------------------------------------------------------
// effort_multipliers for cost_budget_check (W15 v2.0.16)
//
// Hardcoded defaults based on internal calibration. Configurable via
// mcp_server.cost_budget_check.effort_multipliers (null/absent → use defaults).
//   low:    0.7 (below-average compute/token usage)
//   medium: 1.0 (baseline — no adjustment)
//   high:   1.4 (above-average compute/token usage)
//   max:    1.8 (maximum reasoning depth — Opus 4.6 only)
// ---------------------------------------------------------------------------

const DEFAULT_EFFORT_MULTIPLIERS = Object.freeze({
  low:    0.7,
  medium: 1.0,
  high:   1.4,
  max:    1.8,
});

// ---------------------------------------------------------------------------
// max_per_task defaults (W6 v2.0.16)
//
// Per-task call limits for rate-limited MCP tools. These are enforced by
// bin/mcp-server/lib/tool-counts.js when both orchestration_id and task_id
// are supplied in a tool call.
//
// Values (OQ4): ask_user: 20, kb_write: 20, pattern_record_application: 20.
// TODO(backlog): surface max_per_task in the schema loader so it can be
// validated and documented via loadMcpServerConfig; for now tool-counts.js
// reads from mcp_server.max_per_task.<tool> directly.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PER_TASK = Object.freeze({
  ask_user: 20,
  kb_write: 20,
  pattern_record_application: 20,
});

// ---------------------------------------------------------------------------
// cache_choreography section defaults and loader (T12 v2.0.17)
//
// cache_choreography.pre_commit_guard_enabled — boolean, default false.
//   When true, install.js --pre-commit-guard wires up .git/hooks/pre-commit to
//   alert on Block A changes missing an 'BLOCK-A: approved' commit-message line.
//   Strictly opt-in: the default is false. Run bin/install-pre-commit-guard.sh to
//   install the hook after enabling this flag.
//
// cache_choreography.drift_warn_threshold_hex_changes — positive integer, default 1.
//   Number of hex-content changes to Block A before emitting a drift warning.
//   Default 1 means alert on ANY change (fail-fast to keep cache hygiene tight).
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_CHOREOGRAPHY = Object.freeze({
  pre_commit_guard_enabled: false,          // opt-in; run install-pre-commit-guard.sh to wire the hook
  drift_warn_threshold_hex_changes: 1,      // alert on any change (0 = disable warnings)
});

/**
 * Load and merge the cache_choreography block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_CACHE_CHOREOGRAPHY.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ pre_commit_guard_enabled: boolean, drift_warn_threshold_hex_changes: number }}
 */
function loadCacheChoreographyConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_CACHE_CHOREOGRAPHY);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_CACHE_CHOREOGRAPHY);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_CACHE_CHOREOGRAPHY);
  }

  const fromFile = parsed.cache_choreography;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_CACHE_CHOREOGRAPHY);
  }

  const merged = Object.assign({}, DEFAULT_CACHE_CHOREOGRAPHY, sanitizeConfig(fromFile));

  try {
    const result = validateCacheChoreographyConfig(merged);
    if (!result.valid) {
      logStderr('cache_choreography config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return merged;
}

/**
 * Validate a cache_choreography config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateCacheChoreographyConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['cache_choreography must be an object'] };
  }

  if ('pre_commit_guard_enabled' in obj && typeof obj.pre_commit_guard_enabled !== 'boolean') {
    errors.push(
      'cache_choreography.pre_commit_guard_enabled must be a boolean — got ' +
      JSON.stringify(obj.pre_commit_guard_enabled)
    );
  }

  if ('drift_warn_threshold_hex_changes' in obj) {
    const v = obj.drift_warn_threshold_hex_changes;
    if (!Number.isInteger(v) || v < 0) {
      errors.push(
        'cache_choreography.drift_warn_threshold_hex_changes must be a non-negative integer — got ' +
        JSON.stringify(v)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// (T19 pm_prompt_variant removed in v2.0.18 — FC3b cleanup)

// ---------------------------------------------------------------------------
// pattern_decay section defaults and loader (W9 v2.0.18)
//
// pattern_decay.default_half_life_days — positive integer 1..3650, default 90.
//   Half-life (in days) for exponential confidence decay in pattern_find results.
//   The decay formula is:
//     decayed_confidence = confidence * 0.5 ^ (age_days / half_life)
//   where age_days is measured from last_applied (if set) or the pattern's
//   creation timestamp (derived from created_from or file mtime as fallback).
//
//   A half-life of 90 days means a pattern not applied in 90 days decays to
//   0.5× its original confidence. At 180 days, it decays to 0.25×.
//
// pattern_decay.category_overrides — object mapping category names to integer
//   half-life values, e.g. {"anti-pattern": 180}. Optional; absent means use
//   the global default. Fallback precedence (highest to lowest priority):
//     1. per-pattern frontmatter `decay_half_life_days` (if present)
//     2. category_overrides[pattern.category] (if key present)
//     3. default_half_life_days (global default)
//
// Decay is computed on read in pattern_find.js; never written back to files.
// Related config keys live in the mcp_server block (cost_budget_check, etc.);
// pattern_decay is a sibling top-level section alongside audit, shield, etc.
// ---------------------------------------------------------------------------

const DEFAULT_PATTERN_DECAY = Object.freeze({
  /**
   * Global half-life in days for pattern confidence decay.
   * A pattern last applied N days ago has confidence * 0.5^(N/half_life).
   * @type {number}
   */
  default_half_life_days: 90,
  /**
   * Per-category half-life overrides. Keys are category names (e.g. "anti-pattern").
   * Values are integers 1..3650. Absent key → fall through to global default.
   * @type {Object.<string,number>}
   */
  category_overrides: {},
});

/**
 * Load and merge the pattern_decay block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_PATTERN_DECAY so that
 * decay still applies at safe defaults rather than crashing pattern_find.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ default_half_life_days: number, category_overrides: Object.<string,number> }}
 */
function loadPatternDecayConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return {
      default_half_life_days: DEFAULT_PATTERN_DECAY.default_half_life_days,
      category_overrides: {},
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return {
      default_half_life_days: DEFAULT_PATTERN_DECAY.default_half_life_days,
      category_overrides: {},
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      default_half_life_days: DEFAULT_PATTERN_DECAY.default_half_life_days,
      category_overrides: {},
    };
  }

  const fromFile = parsed.pattern_decay;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return {
      default_half_life_days: DEFAULT_PATTERN_DECAY.default_half_life_days,
      category_overrides: {},
    };
  }

  const merged = Object.assign(
    { default_half_life_days: DEFAULT_PATTERN_DECAY.default_half_life_days, category_overrides: {} },
    sanitizeConfig(fromFile)
  );

  try {
    const result = validatePatternDecayConfig(merged);
    if (!result.valid) {
      logStderr('pattern_decay config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return {
    default_half_life_days: merged.default_half_life_days,
    category_overrides: merged.category_overrides,
  };
}

/**
 * Validate a pattern_decay config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validatePatternDecayConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['pattern_decay config must be an object'] };
  }

  if ('default_half_life_days' in obj) {
    const v = obj.default_half_life_days;
    if (!Number.isInteger(v) || v < 1 || v > 3650) {
      errors.push(
        'pattern_decay.default_half_life_days must be an integer 1..3650 — got ' + JSON.stringify(v)
      );
    }
  }

  if ('category_overrides' in obj && obj.category_overrides !== null) {
    const co = obj.category_overrides;
    if (typeof co !== 'object' || Array.isArray(co)) {
      errors.push('pattern_decay.category_overrides must be an object or null');
    } else {
      for (const [cat, v] of Object.entries(co)) {
        if (!Number.isInteger(v) || v < 1 || v > 3650) {
          errors.push(
            `pattern_decay.category_overrides.${cat} must be an integer 1..3650 — got ${JSON.stringify(v)}`
          );
        }
      }
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// anti_pattern_gate section defaults and loader (W12 v2.0.18)
//
// anti_pattern_gate.enabled — boolean, default true.
//   Kill flag: set to false to disable the entire anti-pattern advisory gate
//   without touching other gate logic in gate-agent-spawn.js.
//
// anti_pattern_gate.min_decayed_confidence — number 0.0..1.0, default 0.65.
//   Only anti-patterns with decayed_confidence >= this threshold emit advisories.
//   Lowering to 0 means all matching anti-patterns advise (not recommended);
//   raising to 1 effectively disables the gate.
//
// anti_pattern_gate.max_advisories_per_spawn — positive integer, default 1.
//   Maximum number of advisory injections per single Agent() spawn. Capped at 1
//   per the DESIGN §Risks mitigation. Do NOT raise above 1 without a rethink —
//   the additionalContext injection path is designed for a single focused advisory.
//
// The gate is a hot-path component (PreToolUse hook); this block is loaded on
// every spawn. Fail-open contract: any missing/malformed block returns defaults.
// ---------------------------------------------------------------------------

const DEFAULT_ANTI_PATTERN_GATE = Object.freeze({
  /**
   * Kill flag: false disables the entire anti-pattern matching logic.
   * Other gate-agent-spawn.js logic continues to run.
   * @type {boolean}
   */
  enabled: true,
  /**
   * Minimum decayed_confidence for an anti-pattern match to emit an advisory.
   * Range 0.0..1.0. Default 0.65 per DESIGN §Risks.
   * @type {number}
   */
  min_decayed_confidence: 0.65,
  /**
   * Maximum advisories injected per single Agent() spawn. MUST remain 1.
   * Future-proofing key: do not raise without a rethink of the injection path.
   * @type {number}
   */
  max_advisories_per_spawn: 1,
});

/**
 * Load and merge the anti_pattern_gate block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_ANTI_PATTERN_GATE so the
 * gate activates at safe defaults rather than crashing.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ enabled: boolean, min_decayed_confidence: number, max_advisories_per_spawn: number }}
 */
function loadAntiPatternGateConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_ANTI_PATTERN_GATE);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_ANTI_PATTERN_GATE);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_ANTI_PATTERN_GATE);
  }

  const fromFile = parsed.anti_pattern_gate;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_ANTI_PATTERN_GATE);
  }

  const merged = Object.assign({}, DEFAULT_ANTI_PATTERN_GATE, sanitizeConfig(fromFile));

  try {
    const result = validateAntiPatternGateConfig(merged);
    if (!result.valid) {
      logStderr('anti_pattern_gate config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return {
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : DEFAULT_ANTI_PATTERN_GATE.enabled,
    min_decayed_confidence: typeof merged.min_decayed_confidence === 'number'
      ? merged.min_decayed_confidence
      : DEFAULT_ANTI_PATTERN_GATE.min_decayed_confidence,
    max_advisories_per_spawn: Number.isInteger(merged.max_advisories_per_spawn) && merged.max_advisories_per_spawn >= 1
      ? merged.max_advisories_per_spawn
      : DEFAULT_ANTI_PATTERN_GATE.max_advisories_per_spawn,
  };
}

/**
 * Validate an anti_pattern_gate config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateAntiPatternGateConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['anti_pattern_gate must be an object'] };
  }

  if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
    errors.push(
      'anti_pattern_gate.enabled must be a boolean — got ' + JSON.stringify(obj.enabled)
    );
  }

  if ('min_decayed_confidence' in obj) {
    const v = obj.min_decayed_confidence;
    if (typeof v !== 'number' || v < 0 || v > 1) {
      errors.push(
        'anti_pattern_gate.min_decayed_confidence must be a number 0.0..1.0 — got ' + JSON.stringify(v)
      );
    }
  }

  if ('max_advisories_per_spawn' in obj) {
    const v = obj.max_advisories_per_spawn;
    if (!Number.isInteger(v) || v < 1) {
      errors.push(
        'anti_pattern_gate.max_advisories_per_spawn must be a positive integer — got ' + JSON.stringify(v)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// state_sentinel section defaults and loader (W7 v2.0.18)
//
// state_sentinel.pause_check_enabled — boolean, default true.
//   Kill flag: set to false to inert the entire pause/cancel sentinel check in
//   check-pause-sentinel.js without removing sentinel files. Useful for emergency
//   bypass when the sentinel hook misbehaves. Other gate-agent-spawn.js logic
//   continues to run regardless.
//
// state_sentinel.cancel_grace_seconds — non-negative number, default 5.
//   After cancel.sentinel is written, the hook allows Agent() spawns for this many
//   seconds so any in-flight call can finish cleanly before blocking begins.
//   Set to 0 to block immediately. Set to a larger value (e.g., 30) if your PM
//   typically has long inter-spawn gaps.
//
// The sentinel files live in .orchestray/state/:
//   pause.sentinel  — created by bin/state-pause.js; deleted by --resume.
//   cancel.sentinel — created by bin/state-cancel.js; deleted by clean-abort.
//
// This section is a sibling top-level config block alongside audit, shield, etc.
// ---------------------------------------------------------------------------

const DEFAULT_STATE_SENTINEL = Object.freeze({
  /**
   * Kill flag: false exits the sentinel check without reading files.
   * Other gate logic in gate-agent-spawn.js still runs.
   * @type {boolean}
   */
  pause_check_enabled: true,
  /**
   * Grace window (seconds) after cancel.sentinel is written before blocking.
   * Allows any in-flight Agent() call that was already issued to finish.
   * Range: 0..3600. Default 5.
   * @type {number}
   */
  cancel_grace_seconds: 5,
});

/**
 * Load and merge the state_sentinel block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_STATE_SENTINEL so the
 * hook still runs at safe defaults rather than crashing.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ pause_check_enabled: boolean, cancel_grace_seconds: number }}
 */
function loadStateSentinelConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_STATE_SENTINEL);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_STATE_SENTINEL);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_STATE_SENTINEL);
  }

  const fromFile = parsed.state_sentinel;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_STATE_SENTINEL);
  }

  const merged = Object.assign({}, DEFAULT_STATE_SENTINEL, sanitizeConfig(fromFile));

  try {
    const result = validateStateSentinelConfig(merged);
    if (!result.valid) {
      logStderr('state_sentinel config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return {
    pause_check_enabled: typeof merged.pause_check_enabled === 'boolean'
      ? merged.pause_check_enabled
      : DEFAULT_STATE_SENTINEL.pause_check_enabled,
    cancel_grace_seconds: Number.isFinite(merged.cancel_grace_seconds) && merged.cancel_grace_seconds >= 0
      ? merged.cancel_grace_seconds
      : DEFAULT_STATE_SENTINEL.cancel_grace_seconds,
  };
}

/**
 * Validate a state_sentinel config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateStateSentinelConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['state_sentinel must be an object'] };
  }

  if ('pause_check_enabled' in obj && typeof obj.pause_check_enabled !== 'boolean') {
    errors.push(
      'state_sentinel.pause_check_enabled must be a boolean — got ' + JSON.stringify(obj.pause_check_enabled)
    );
  }

  if ('cancel_grace_seconds' in obj) {
    const v = obj.cancel_grace_seconds;
    if (!Number.isFinite(v) || v < 0 || v > 3600) {
      errors.push(
        'state_sentinel.cancel_grace_seconds must be a number 0..3600 — got ' + JSON.stringify(v)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// redo_flow section defaults and loader (W8 v2.0.18)
//
// redo_flow.max_cascade_depth — positive integer, default 10.
//   Maximum number of transitive downstream dependents to include in a
//   --cascade redo closure. Prevents runaway recursion on pathological
//   dependency graphs. Range: 1..1000. Default 10.
//
// redo_flow.commit_prefix — non-empty string, default "redo".
//   Prefix used in redo commit messages: "<commit_prefix>(<W-id>): ...".
//   Operators can customise to match their project commit conventions.
//
// ---------------------------------------------------------------------------

const DEFAULT_REDO_FLOW = Object.freeze({
  /**
   * Maximum cascade depth when computing transitive dependent closure.
   * Prevents infinite loops on cycles or very deep graphs.
   * Range: 1..1000. Default 10.
   * @type {number}
   */
  max_cascade_depth: 10,
  /**
   * Prefix for redo commit messages: "<prefix>(<W-id>): ...".
   * Default: "redo".
   * @type {string}
   */
  commit_prefix: 'redo',
});

/**
 * Load and merge the redo_flow block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_REDO_FLOW.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ max_cascade_depth: number, commit_prefix: string }}
 */
function loadRedoFlowConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_REDO_FLOW);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_REDO_FLOW);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_REDO_FLOW);
  }

  const fromFile = parsed.redo_flow;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_REDO_FLOW);
  }

  const merged = Object.assign({}, DEFAULT_REDO_FLOW, sanitizeConfig(fromFile));

  try {
    const result = validateRedoFlowConfig(merged);
    if (!result.valid) {
      logStderr('redo_flow config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return {
    max_cascade_depth:
      Number.isFinite(merged.max_cascade_depth) &&
      merged.max_cascade_depth >= 1 &&
      merged.max_cascade_depth <= 1000
        ? Math.floor(merged.max_cascade_depth)
        : DEFAULT_REDO_FLOW.max_cascade_depth,
    commit_prefix:
      typeof merged.commit_prefix === 'string' && merged.commit_prefix.length > 0
        ? merged.commit_prefix
        : DEFAULT_REDO_FLOW.commit_prefix,
  };
}

/**
 * Validate a redo_flow config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateRedoFlowConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['redo_flow must be an object'] };
  }

  if ('max_cascade_depth' in obj) {
    const v = obj.max_cascade_depth;
    if (!Number.isFinite(v) || v < 1 || v > 1000 || !Number.isInteger(v)) {
      errors.push(
        'redo_flow.max_cascade_depth must be an integer 1..1000 — got ' + JSON.stringify(v)
      );
    }
  }

  if ('commit_prefix' in obj) {
    if (typeof obj.commit_prefix !== 'string' || obj.commit_prefix.length === 0) {
      errors.push(
        'redo_flow.commit_prefix must be a non-empty string — got ' + JSON.stringify(obj.commit_prefix)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// adaptive_verbosity section defaults and loader (T22 v2.0.17)
//
// adaptive_verbosity.enabled — boolean, default false.
//   When false, the PM does not inject response-length budgets into delegations.
//   Opt-in: set to true AND set v2017_experiments.adaptive_verbosity='on' to
//   activate. Both gates must be open for the feature to apply.
//
// adaptive_verbosity.base_response_tokens — positive integer, default 2000.
//   Default agent response budget (approximate token count). Passed as
//   "Response budget: ~{N} tokens" in each delegation prompt.
//
// adaptive_verbosity.reducer_on_late_phase — number 0.0..1.0, default 0.4.
//   Multiplier applied to base_response_tokens when phase_position >= 0.5
//   (past the midpoint of the orchestration). Reduces output-token tail
//   for late-phase agents whose tasks are typically narrower.
// ---------------------------------------------------------------------------

const DEFAULT_ADAPTIVE_VERBOSITY = Object.freeze({
  enabled: false,                 // opt-in; also requires v2017_experiments.adaptive_verbosity='on'
  base_response_tokens: 2000,     // default delegation budget in tokens
  reducer_on_late_phase: 0.4,     // multiply budget for phases past midpoint (phase_position >= 0.5)
});

/**
 * Load and merge the adaptive_verbosity block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_ADAPTIVE_VERBOSITY.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ enabled: boolean, base_response_tokens: number, reducer_on_late_phase: number }}
 */
function loadAdaptiveVerbosityConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_ADAPTIVE_VERBOSITY);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_ADAPTIVE_VERBOSITY);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_ADAPTIVE_VERBOSITY);
  }

  const fromFile = parsed.adaptive_verbosity;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_ADAPTIVE_VERBOSITY);
  }

  const merged = Object.assign({}, DEFAULT_ADAPTIVE_VERBOSITY, sanitizeConfig(fromFile));

  try {
    const result = validateAdaptiveVerbosityConfig(merged);
    if (!result.valid) {
      logStderr('adaptive_verbosity config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return merged;
}

/**
 * Validate an adaptive_verbosity config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateAdaptiveVerbosityConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['adaptive_verbosity must be an object'] };
  }

  if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
    errors.push(
      'adaptive_verbosity.enabled must be a boolean — got ' + JSON.stringify(obj.enabled)
    );
  }

  if ('base_response_tokens' in obj) {
    const v = obj.base_response_tokens;
    if (!Number.isInteger(v) || v <= 0) {
      errors.push(
        'adaptive_verbosity.base_response_tokens must be a positive integer — got ' + JSON.stringify(v)
      );
    }
  }

  if ('reducer_on_late_phase' in obj) {
    const v = obj.reducer_on_late_phase;
    if (typeof v !== 'number' || v < 0 || v > 1) {
      errors.push(
        'adaptive_verbosity.reducer_on_late_phase must be a number 0.0..1.0 — got ' + JSON.stringify(v)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// v2017_experiments section defaults and loader (T4 v2.0.17)
//
// v2017_experiments.__schema_version — literal 1; bumped when new keys are added.
// v2017_experiments.global_kill_switch — boolean, default false.
//   One-flip disables all v2017 experiments simultaneously (safety escape hatch).
// v2017_experiments.prompt_caching — "off"|"on", default "off".
//   S1: Block A/B/C cache-hygiene layout in agents/pm.md.
// v2017_experiments.adaptive_verbosity — "off"|"on", default "off".
//   S4: Adaptive response-length budgets in delegation templates.
// (pm_prose_strip removed in v2.0.18 — FC3b cleanup)
// ---------------------------------------------------------------------------

const DEFAULT_V2017_EXPERIMENTS = Object.freeze({
  __schema_version: 1,
  global_kill_switch: false,       // 2-state; one flip disables all v2017 experiments
  prompt_caching: 'off',           // 2-state: "off"|"on" → S1 cache-hygiene layout
  adaptive_verbosity: 'off',       // 2-state: "off"|"on" → S4 response-length budgets
});

/**
 * Load and merge the v2017_experiments block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_V2017_EXPERIMENTS.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ __schema_version: number, global_kill_switch: boolean, prompt_caching: string, adaptive_verbosity: string }}
 */
function loadV2017ExperimentsConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_V2017_EXPERIMENTS);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_V2017_EXPERIMENTS);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_V2017_EXPERIMENTS);
  }

  const fromFile = parsed.v2017_experiments;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_V2017_EXPERIMENTS);
  }

  // Shallow merge: defaults fill in missing keys; file values win for present keys.
  // sanitizeConfig strips __proto__/constructor/prototype to prevent prototype pollution.
  const merged = Object.assign({}, DEFAULT_V2017_EXPERIMENTS, sanitizeConfig(fromFile));

  try {
    const result = validateV2017ExperimentsConfig(merged);
    if (!result.valid) {
      logStderr('v2017_experiments config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return merged;
}

/**
 * Validate a v2017_experiments config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateV2017ExperimentsConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['v2017_experiments must be an object'] };
  }

  if ('__schema_version' in obj && obj.__schema_version !== 1) {
    errors.push(
      'v2017_experiments.__schema_version must be 1 — got ' + JSON.stringify(obj.__schema_version)
    );
  }

  if ('global_kill_switch' in obj && typeof obj.global_kill_switch !== 'boolean') {
    errors.push(
      'v2017_experiments.global_kill_switch must be a boolean — got ' + JSON.stringify(obj.global_kill_switch)
    );
  }

  if ('prompt_caching' in obj && !['off', 'on'].includes(obj.prompt_caching)) {
    errors.push(
      'v2017_experiments.prompt_caching must be "off" or "on" — got ' + JSON.stringify(obj.prompt_caching)
    );
  }

  // pm_prose_strip removed in v2.0.18 (FC3b cleanup) — unknown keys are silently ignored

  if ('adaptive_verbosity' in obj && !['off', 'on'].includes(obj.adaptive_verbosity)) {
    errors.push(
      'v2017_experiments.adaptive_verbosity must be "off" or "on" — got ' + JSON.stringify(obj.adaptive_verbosity)
    );
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Check if a v2.0.17 experiment flag is active ('on' state).
 *
 * @param {object|null|undefined} cfg - Root config object. MUST contain a `v2017_experiments`
 *   sub-object (i.e. the full config root, NOT just the experiments block).
 *   Do NOT pass the experiments block directly — pass the full config.
 *   Use loadV2017ExperimentsConfig to load the block, then wrap as
 *   { v2017_experiments: loaded } if you only have the sub-block.
 *   Passing the experiments block directly will silently return false for all flags.
 * @param {string} flagName - Flag key (e.g. 'prompt_caching', 'adaptive_verbosity').
 * @returns {boolean} true only if flag === 'on' AND global_kill_switch !== true.
 *   'shadow' returns false (measurement-only, not behavior-active).
 *   Any error (null cfg, missing key, etc.) returns false (fail-open).
 */
function isExperimentActive(cfg, flagName) {
  try {
    const block = cfg && cfg.v2017_experiments;
    if (!block) return false;
    if (block.global_kill_switch === true) return false;
    const v = block[flagName];
    return v === 'on';  // 'shadow' is measurement-only, not "active" for behavior gating
  } catch { return false; }
}

module.exports = {
  DEFAULT_MCP_ENFORCEMENT,
  loadMcpEnforcement,
  validateMcpEnforcement,
  DEFAULT_AUDIT,
  loadAuditConfig,
  DEFAULT_SHIELD,
  loadShieldConfig,
  DEFAULT_COST_BUDGET_CHECK,
  loadCostBudgetCheckConfig,
  DEFAULT_COST_BUDGET_ENFORCEMENT,
  loadCostBudgetEnforcementConfig,
  validateCostBudgetEnforcementConfig,
  DEFAULT_EFFORT_MULTIPLIERS,
  DEFAULT_MAX_PER_TASK,
  // D7 (v2.0.16): routing_gate auto-seed on miss
  DEFAULT_ROUTING_GATE,
  loadRoutingGateConfig,
  // D5 (v2.0.16): cost_budget_reserve TTL config
  DEFAULT_COST_BUDGET_RESERVE,
  loadCostBudgetReserveConfig,
  // T4 (v2.0.17): v2017 experiment flags
  DEFAULT_V2017_EXPERIMENTS,
  loadV2017ExperimentsConfig,
  validateV2017ExperimentsConfig,
  isExperimentActive,
  // T12 (v2.0.17): cache_choreography config block
  DEFAULT_CACHE_CHOREOGRAPHY,
  loadCacheChoreographyConfig,
  validateCacheChoreographyConfig,
  // T22 (v2.0.17): adaptive_verbosity config block
  DEFAULT_ADAPTIVE_VERBOSITY,
  loadAdaptiveVerbosityConfig,
  validateAdaptiveVerbosityConfig,
  // W9 (v2.0.18): pattern confidence decay
  DEFAULT_PATTERN_DECAY,
  loadPatternDecayConfig,
  validatePatternDecayConfig,
  // W12 (v2.0.18): anti-pattern pre-spawn advisory gate
  DEFAULT_ANTI_PATTERN_GATE,
  loadAntiPatternGateConfig,
  validateAntiPatternGateConfig,
  // W7 (v2.0.18): pause/cancel sentinel config
  DEFAULT_STATE_SENTINEL,
  loadStateSentinelConfig,
  validateStateSentinelConfig,
  // W8 (v2.0.18): redo_flow config
  DEFAULT_REDO_FLOW,
  loadRedoFlowConfig,
  validateRedoFlowConfig,
  logStderr,
};
