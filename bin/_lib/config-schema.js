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

const { recordDegradation } = require('./degraded-journal');

/**
 * Per-process guard: tracks which sections have already emitted the flat-key
 * deprecation warning to stderr. Using a Set ensures the warning fires at most
 * once per section per process invocation (avoids log spam across MCP calls).
 * @type {Set<string>}
 */
const _flatDeprecationWarned = new Set();

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
// max_per_task defaults and loader (W6 v2.0.16; schema-surfaced v2.1.7 C)
//
// Per-task call limits for rate-limited MCP tools. Enforced by
// bin/mcp-server/lib/tool-counts.js when both orchestration_id and task_id
// are supplied in a tool call.
//
// Shape: mcp_server.max_per_task.<tool_name> — integer 1..1000 per tool.
// Known tools (defaults): ask_user: 20, kb_write: 20, pattern_record_application: 20.
// Unknown tool keys: passed through unchanged + one dedup journal entry per boot (K5).
// Out-of-range or non-integer values: fall back to default + journal entry.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_PER_TASK = Object.freeze({
  ask_user: 20,
  kb_write: 20,
  pattern_record_application: 20,
});

// Known tool names that have defaults — used for range-checking vs. pass-through.
const KNOWN_MAX_PER_TASK_TOOLS = Object.freeze(Object.keys(DEFAULT_MAX_PER_TASK));

/**
 * Load and validate the mcp_server.max_per_task config block.
 *
 * Fail-open contract: missing/malformed values fall back to DEFAULT_MAX_PER_TASK.
 * Unknown tool keys are passed through unchanged (K5 — forward-compat operators).
 * Out-of-range or non-integer values fall back to defaults + journal one entry per boot.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ ask_user: number, kb_write: number, pattern_record_application: number }}
 */
function loadMcpServerConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_MAX_PER_TASK);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_MAX_PER_TASK);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_MAX_PER_TASK);
  }

  const mcpServer = parsed.mcp_server;
  if (!mcpServer || typeof mcpServer !== 'object' || Array.isArray(mcpServer)) {
    return Object.assign({}, DEFAULT_MAX_PER_TASK);
  }

  const fromFile = mcpServer.max_per_task;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_MAX_PER_TASK);
  }

  // Start with defaults; overlay validated/passed-through values.
  const result = Object.assign({}, DEFAULT_MAX_PER_TASK);

  for (const [toolName, rawVal] of Object.entries(fromFile)) {
    const isKnown = KNOWN_MAX_PER_TASK_TOOLS.includes(toolName);

    if (isKnown) {
      // Range-check known tools: integer 1..1000.
      if (Number.isInteger(rawVal) && rawVal >= 1 && rawVal <= 1000) {
        result[toolName] = rawVal;
      } else {
        // Out-of-range or non-integer: keep default, journal once per boot.
        recordDegradation({
          kind:     'mcp_server_max_per_task_out_of_range',
          severity: 'warn',
          detail:   {
            tool:      toolName,
            value:     rawVal,
            default:   DEFAULT_MAX_PER_TASK[toolName],
            dedup_key: 'mcp_server_max_per_task_out_of_range|' + toolName,
          },
          projectRoot: cwd,
        });
      }
    } else {
      // Unknown tool: pass through, journal once per boot (K5).
      result[toolName] = rawVal;
      recordDegradation({
        kind:     'mcp_server_max_per_task_unknown_tool',
        severity: 'warn',
        detail:   {
          tool:      toolName,
          value:     rawVal,
          dedup_key: 'mcp_server_max_per_task_unknown_tool|' + toolName,
        },
        projectRoot: cwd,
      });
    }
  }

  return result;
}

/**
 * Validate a mcp_server.max_per_task config object without loading from disk.
 * Returns { valid: true } or { valid: false, errors: string[] }.
 *
 * Only validates known tool keys (unknown keys are advisory pass-throughs, not errors).
 *
 * @param {{ max_per_task?: object }} cfg
 * @returns {{ valid: boolean, errors?: string[] }}
 */
function validateMcpServerConfig(cfg) {
  const errors = [];

  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    errors.push('validateMcpServerConfig: argument must be a plain object');
    return { valid: false, errors };
  }

  const mpt = cfg.max_per_task;
  if (mpt === undefined || mpt === null) {
    return { valid: true };
  }

  if (typeof mpt !== 'object' || Array.isArray(mpt)) {
    errors.push('mcp_server.max_per_task must be a plain object');
    return { valid: false, errors };
  }

  for (const toolName of KNOWN_MAX_PER_TASK_TOOLS) {
    if (!(toolName in mpt)) continue;
    const v = mpt[toolName];
    if (!Number.isInteger(v) || v < 1 || v > 1000) {
      errors.push(
        'mcp_server.max_per_task.' + toolName + ' must be an integer 1..1000 — got ' +
        JSON.stringify(v)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

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
// v2017_experiments.prompt_caching — "off"|"on", default "on".
//   S1: Block A/B/C cache-hygiene layout in agents/pm.md.
// v2017_experiments.adaptive_verbosity — "off"|"on", default "off".
//   S4: Adaptive response-length budgets in delegation templates.
// (pm_prose_strip removed in v2.0.18 — FC3b cleanup)
// ---------------------------------------------------------------------------

const DEFAULT_V2017_EXPERIMENTS = Object.freeze({
  __schema_version: 1,
  global_kill_switch: false,       // 2-state; one flip disables all v2017 experiments
  prompt_caching: 'on',            // 2-state: "off"|"on" → S1 cache-hygiene layout
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

// ---------------------------------------------------------------------------
// context_statusbar section defaults and loader (W3 / v2.0.19 Pillar B)
//
// context_statusbar.enabled — boolean, default true.
//   When false, bin/statusline.js prints an empty line and exits 0.
//   Hooks still write the cache (cheap; avoids cold-cache flicker on re-enable).
//
// context_statusbar.unicode — boolean, default false.
//   When true, use Unicode block-fill bar instead of K/M numbers.
//
// context_statusbar.color — boolean, default false.
//   When true, emit ANSI color codes for pressure levels.
//
// context_statusbar.width_cap — positive integer, default 120.
//   Maximum rendered line width; subagent list is truncated from the right.
//
// context_statusbar.pressure_thresholds.warn     — integer 0-100, default 75.
// context_statusbar.pressure_thresholds.critical — integer 0-100, default 90.
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_STATUSBAR = Object.freeze({
  enabled: true,
  unicode: false,
  color:   false,
  width_cap: 120,
  pressure_thresholds: Object.freeze({ warn: 75, critical: 90 }),
});

/**
 * Load and merge the context_statusbar config block from
 * <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: any missing/malformed value returns DEFAULT_CONTEXT_STATUSBAR.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ enabled: boolean, unicode: boolean, color: boolean, width_cap: number, pressure_thresholds: { warn: number, critical: number } }}
 */
function loadContextStatusbarConfig(cwd) {
  const def = {
    enabled:  DEFAULT_CONTEXT_STATUSBAR.enabled,
    unicode:  DEFAULT_CONTEXT_STATUSBAR.unicode,
    color:    DEFAULT_CONTEXT_STATUSBAR.color,
    width_cap: DEFAULT_CONTEXT_STATUSBAR.width_cap,
    pressure_thresholds: Object.assign({}, DEFAULT_CONTEXT_STATUSBAR.pressure_thresholds),
  };

  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch (_) { return def; }

  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return def; }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return def;

  const fromFile = parsed.context_statusbar;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) return def;

  const safe = sanitizeConfig(fromFile);
  const merged = Object.assign({}, def, safe);

  // Normalize pressure_thresholds sub-object.
  if (safe.pressure_thresholds && typeof safe.pressure_thresholds === 'object' && !Array.isArray(safe.pressure_thresholds)) {
    merged.pressure_thresholds = Object.assign({}, def.pressure_thresholds, sanitizeConfig(safe.pressure_thresholds));
  } else {
    merged.pressure_thresholds = Object.assign({}, def.pressure_thresholds);
  }

  // Validate and warn on stderr — always return merged (fail-open).
  try {
    const result = validateContextStatusbarConfig(merged);
    if (!result.valid) {
      logStderr('context_statusbar config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) { /* must not throw */ }

  return merged;
}

/**
 * Validate a context_statusbar config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateContextStatusbarConfig(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['context_statusbar config must be an object'] };
  }
  if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
    errors.push('context_statusbar.enabled must be a boolean');
  }
  if ('unicode' in obj && typeof obj.unicode !== 'boolean') {
    errors.push('context_statusbar.unicode must be a boolean');
  }
  if ('color' in obj && typeof obj.color !== 'boolean') {
    errors.push('context_statusbar.color must be a boolean');
  }
  if ('width_cap' in obj) {
    if (!Number.isInteger(obj.width_cap) || obj.width_cap < 40) {
      errors.push('context_statusbar.width_cap must be an integer >= 40');
    }
  }
  if ('pressure_thresholds' in obj) {
    const pt = obj.pressure_thresholds;
    if (!pt || typeof pt !== 'object' || Array.isArray(pt)) {
      errors.push('context_statusbar.pressure_thresholds must be an object');
    } else {
      if ('warn' in pt && (!Number.isInteger(pt.warn) || pt.warn < 0 || pt.warn > 100)) {
        errors.push('context_statusbar.pressure_thresholds.warn must be 0-100');
      }
      if ('critical' in pt && (!Number.isInteger(pt.critical) || pt.critical < 0 || pt.critical > 100)) {
        errors.push('context_statusbar.pressure_thresholds.critical must be 0-100');
      }
    }
  }
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// federation section defaults and loader (B1 v2.1.0)
//
// federation.shared_dir_enabled — boolean, default false.
//   When false (the default), federation is entirely off: no shared tier is
//   consulted during pattern_find or kb_search, and promote/share commands will
//   not write to ~/.orchestray/shared/. Must be explicitly enabled by the user.
//   Matches W3 C8 (local-only default; no cloud, no implicit sharing).
//
// federation.sensitivity — enum "private" | "shareable", default "private".
//   "private"   — this project's patterns are NEVER eligible for promotion to the
//                 shared tier, regardless of shared_dir_enabled. The user must
//                 change this to "shareable" before any pattern from this project
//                 can be promoted. Default is "private" per W6 F07 (threat model
//                 demands opt-IN for sharing, not opt-OUT).
//   "shareable" — patterns from this project may be promoted when the user explicitly
//                 runs the promote/share command. Individual promotion is still an
//                 explicit per-pattern action (W3 C14).
//
// federation.shared_dir_path — string, default "~/.orchestray/shared".
//   Overridable for tests (see also ORCHESTRAY_TEST_SHARED_DIR env var in paths.js).
//   Tilde expansion is performed by the paths helpers, not here.
//
// NOTE: curator.* keys are NOT added here — B8 owns those. This block is
// intentionally left extensible for B8 to add curator.* as a sibling section.
// ---------------------------------------------------------------------------

const DEFAULT_FEDERATION = Object.freeze({
  shared_dir_enabled: false,
  sensitivity: 'private',
  shared_dir_path: '~/.orchestray/shared',
});

const VALID_FEDERATION_SENSITIVITY = ['private', 'shareable'];

/**
 * Load and merge the federation config section from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_FEDERATION so callers
 * always get a valid object with all three keys guaranteed present.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ shared_dir_enabled: boolean, sensitivity: string, shared_dir_path: string }}
 */
function loadFederationConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_FEDERATION);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_FEDERATION);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_FEDERATION);
  }

  let fromFile = parsed.federation;

  // Flat-key fallback (legacy compat): if the nested object is absent or non-object,
  // attempt to reconstruct it from top-level dotted keys written by older skill versions.
  // Nested form wins when both are present (no merge — flat keys are fully ignored).
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    const flatKeys = ['federation.shared_dir_enabled', 'federation.sensitivity', 'federation.shared_dir_path'];
    const hasFlatKeys = flatKeys.some(k => k in parsed);
    if (!hasFlatKeys) {
      return Object.assign({}, DEFAULT_FEDERATION);
    }
    // Emit one deprecation warning per process (guard with module-level Set).
    if (!_flatDeprecationWarned.has('federation')) {
      _flatDeprecationWarned.add('federation');
      logStderr(
        'config: federation.* keys found as flat top-level dotted strings.\n' +
        '  Nested form preferred: {"federation": {...}}.\n' +
        '  Run: /orchestray:config set federation.shared_dir_enabled <value> to migrate.'
      );
      recordDegradation({
        kind: 'flat_federation_keys_accepted',
        severity: 'warn',
        detail: {
          keys: Object.keys(parsed).filter(k => k.startsWith('federation.')),
          dedup_key: 'flat_federation_keys_accepted',
        },
      });
    }
    const flatObj = {};
    if ('federation.shared_dir_enabled' in parsed) flatObj.shared_dir_enabled = parsed['federation.shared_dir_enabled'];
    if ('federation.sensitivity'         in parsed) flatObj.sensitivity         = parsed['federation.sensitivity'];
    if ('federation.shared_dir_path'     in parsed) flatObj.shared_dir_path     = parsed['federation.shared_dir_path'];
    fromFile = sanitizeConfig(flatObj);
  }

  const merged = Object.assign({}, DEFAULT_FEDERATION, sanitizeConfig(fromFile));

  // Validate and warn — always return merged (fail-open).
  try {
    const result = validateFederationConfig(merged);
    if (!result.valid) {
      logStderr('federation config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw.
  }

  return {
    shared_dir_enabled: typeof merged.shared_dir_enabled === 'boolean'
      ? merged.shared_dir_enabled
      : DEFAULT_FEDERATION.shared_dir_enabled,
    sensitivity: VALID_FEDERATION_SENSITIVITY.includes(merged.sensitivity)
      ? merged.sensitivity
      : DEFAULT_FEDERATION.sensitivity,
    shared_dir_path: typeof merged.shared_dir_path === 'string' && merged.shared_dir_path.trim()
      ? merged.shared_dir_path
      : DEFAULT_FEDERATION.shared_dir_path,
  };
}

/**
 * Validate a federation config object (as returned by loadFederationConfig).
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateFederationConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['federation config must be an object'] };
  }

  if ('shared_dir_enabled' in obj && typeof obj.shared_dir_enabled !== 'boolean') {
    errors.push(
      'federation.shared_dir_enabled must be a boolean — got ' + JSON.stringify(obj.shared_dir_enabled)
    );
  }

  if ('sensitivity' in obj) {
    if (!VALID_FEDERATION_SENSITIVITY.includes(obj.sensitivity)) {
      errors.push(
        'federation.sensitivity must be one of: ' + VALID_FEDERATION_SENSITIVITY.join(', ') +
        ' — got ' + JSON.stringify(obj.sensitivity)
      );
    }
  }

  if ('shared_dir_path' in obj) {
    if (typeof obj.shared_dir_path !== 'string' || obj.shared_dir_path.trim().length === 0) {
      errors.push(
        'federation.shared_dir_path must be a non-empty string — got ' + JSON.stringify(obj.shared_dir_path)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// curator section defaults and loader (B8 v2.1.0)
//
// curator.enabled — boolean, default true.
//   Master kill-switch: false prevents /orchestray:learn curate from running.
//   Does NOT affect the tombstone store — existing tombstones remain readable.
//
// curator.self_escalation_enabled — boolean, default true.
//   When true, the curator may request opus tier for borderline merge decisions
//   (up to 3 escalations per run). Set to false to pin the curator to sonnet.
//
// curator.pm_recommendation_enabled — boolean, default true.
//   When true, the PM may surface a once-per-session recommendation to run curator
//   after observing corpus growth. Set to false to silence all PM nags.
//
// curator.tombstone_retention_runs — integer 1..10, default 3.
//   Number of curator runs whose tombstones are kept in the rolling undo window.
//   `undo-last` targets the most-recent run; `undo <action-id>` searches
//   across all N runs. At run N+1, the oldest run is archived to
//   .orchestray/curator/tombstones-archive/<run_id>.jsonl.
//
// curator.diff_enabled — boolean, default false.
//   Master toggle for the `--diff` flag. Opt-in for v2.1.4; set true to enable
//   incremental mode. If false, `curate --diff` is rejected with an actionable message.
//   Promotion to default-on is deferred to v2.2 pending telemetry review.
//
// curator.diff_cutoff_days — integer 1..365, default 30.
//   Patterns whose stamp is older than this many days are re-evaluated even if
//   the body hash is unchanged (stale-stamp signal). Default 30 (PM arbitration:
//   design default was 45, PM overrode to 30 for v2.1.4).
//
// Keys explicitly EXCLUDED (see ADR .orchestray/kb/decisions/2100b-curator-config-keys.md):
//   - self_escalation_budget: caps are constants in the curator agent code (W2 F09)
//   - tombstone_archive_dir: archive location is fixed (.orchestray/curator/tombstones-archive/)
//   - max_promotes_per_run, max_merges_per_run, max_deprecates_per_run: all constants (W2 F09)
//   - (diff_forced_full_every promoted to config in v2.1.5 — see DEFAULT_CURATOR below)
// ---------------------------------------------------------------------------

const DEFAULT_CURATOR = Object.freeze({
  /**
   * Master off-switch. Set false to disable /orchestray:learn curate.
   * @type {boolean}
   */
  enabled: true,
  /**
   * Allow curator to self-request opus tier for borderline merge decisions.
   * Capped at 3 escalations per run regardless of this setting.
   * @type {boolean}
   */
  self_escalation_enabled: true,
  /**
   * Allow the PM to surface a once-per-session recommendation to run curator.
   * @type {boolean}
   */
  pm_recommendation_enabled: true,
  /**
   * Number of curator runs kept in the active tombstone rollback window.
   * Range: 1..10. Default 3. At run N+1, oldest run is archived.
   * @type {number}
   */
  tombstone_retention_runs: 3,
  /**
   * Enable the `curate --diff` incremental mode (H6, v2.1.4).
   * Opt-in only for v2.1.4. When false, the --diff flag is rejected.
   * @type {boolean}
   */
  diff_enabled: false,
  /**
   * Stamp-age threshold (in days) for the stale-stamp dirty signal in --diff mode.
   * Patterns stamped more than this many days ago are re-evaluated even if body is unchanged.
   * Range: 1..365. Default 30.
   * @type {number}
   */
  diff_cutoff_days: 30,
  /**
   * Cadence for the self-healing forced-full sweep in --diff mode.
   * Every Nth --diff run evaluates the entire corpus regardless of dirty-set signals.
   * Range: 1..1000. Default 10.
   * @type {number}
   */
  diff_forced_full_every: 10,
});

/**
 * Load and merge the curator block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_CURATOR so the
 * curator still operates at safe defaults rather than crashing.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ enabled: boolean, self_escalation_enabled: boolean, pm_recommendation_enabled: boolean, tombstone_retention_runs: number, diff_enabled: boolean, diff_cutoff_days: number, diff_forced_full_every: number }}
 */
function loadCuratorConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_CURATOR);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_CURATOR);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_CURATOR);
  }

  let fromFile = parsed.curator;

  // Flat-key fallback (legacy compat): if the nested object is absent or non-object,
  // attempt to reconstruct it from top-level dotted keys written by older skill versions.
  // Nested form wins when both are present (no merge — flat keys are fully ignored).
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    const flatKeys = [
      'curator.enabled',
      'curator.self_escalation_enabled',
      'curator.pm_recommendation_enabled',
      'curator.tombstone_retention_runs',
      'curator.diff_enabled',
      'curator.diff_cutoff_days',
      'curator.diff_forced_full_every',
    ];
    const hasFlatKeys = flatKeys.some(k => k in parsed);
    if (!hasFlatKeys) {
      return Object.assign({}, DEFAULT_CURATOR);
    }
    // Emit one deprecation warning per process.
    if (!_flatDeprecationWarned.has('curator')) {
      _flatDeprecationWarned.add('curator');
      logStderr(
        'config: curator.* keys found as flat top-level dotted strings.\n' +
        '  Nested form preferred: {"curator": {...}}.\n' +
        '  Run: /orchestray:config set curator.enabled <value> to migrate.'
      );
      recordDegradation({
        kind: 'flat_curator_keys_accepted',
        severity: 'warn',
        detail: {
          keys: Object.keys(parsed).filter(k => k.startsWith('curator.')),
          dedup_key: 'flat_curator_keys_accepted',
        },
      });
    }
    const flatObj = {};
    if ('curator.enabled'                   in parsed) flatObj.enabled                   = parsed['curator.enabled'];
    if ('curator.self_escalation_enabled'   in parsed) flatObj.self_escalation_enabled   = parsed['curator.self_escalation_enabled'];
    if ('curator.pm_recommendation_enabled' in parsed) flatObj.pm_recommendation_enabled = parsed['curator.pm_recommendation_enabled'];
    if ('curator.tombstone_retention_runs'  in parsed) flatObj.tombstone_retention_runs  = parsed['curator.tombstone_retention_runs'];
    if ('curator.diff_enabled'              in parsed) flatObj.diff_enabled              = parsed['curator.diff_enabled'];
    if ('curator.diff_cutoff_days'          in parsed) flatObj.diff_cutoff_days          = parsed['curator.diff_cutoff_days'];
    if ('curator.diff_forced_full_every'    in parsed) flatObj.diff_forced_full_every    = parsed['curator.diff_forced_full_every'];
    fromFile = sanitizeConfig(flatObj);
  }

  const merged = Object.assign({}, DEFAULT_CURATOR, sanitizeConfig(fromFile));

  // Validate and warn — always return merged (fail-open).
  try {
    const result = validateCuratorConfig(merged);
    if (!result.valid) {
      logStderr('curator config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw.
  }

  return {
    enabled: typeof merged.enabled === 'boolean'
      ? merged.enabled
      : DEFAULT_CURATOR.enabled,
    self_escalation_enabled: typeof merged.self_escalation_enabled === 'boolean'
      ? merged.self_escalation_enabled
      : DEFAULT_CURATOR.self_escalation_enabled,
    pm_recommendation_enabled: typeof merged.pm_recommendation_enabled === 'boolean'
      ? merged.pm_recommendation_enabled
      : DEFAULT_CURATOR.pm_recommendation_enabled,
    tombstone_retention_runs:
      (Number.isInteger(merged.tombstone_retention_runs) &&
       merged.tombstone_retention_runs >= 1 &&
       merged.tombstone_retention_runs <= 10)
        ? merged.tombstone_retention_runs
        : DEFAULT_CURATOR.tombstone_retention_runs,
    diff_enabled: typeof merged.diff_enabled === 'boolean'
      ? merged.diff_enabled
      : DEFAULT_CURATOR.diff_enabled,
    diff_cutoff_days:
      (Number.isInteger(merged.diff_cutoff_days) &&
       merged.diff_cutoff_days >= 1 &&
       merged.diff_cutoff_days <= 365)
        ? merged.diff_cutoff_days
        : DEFAULT_CURATOR.diff_cutoff_days,
    diff_forced_full_every:
      (Number.isInteger(merged.diff_forced_full_every) &&
       merged.diff_forced_full_every >= 1 &&
       merged.diff_forced_full_every <= 1000)
        ? merged.diff_forced_full_every
        : DEFAULT_CURATOR.diff_forced_full_every,
  };
}

/**
 * Validate a curator config object (as returned by loadCuratorConfig).
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateCuratorConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['curator config must be an object'] };
  }

  if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
    errors.push(
      'curator.enabled must be a boolean — got ' + JSON.stringify(obj.enabled)
    );
  }

  if ('self_escalation_enabled' in obj && typeof obj.self_escalation_enabled !== 'boolean') {
    errors.push(
      'curator.self_escalation_enabled must be a boolean — got ' + JSON.stringify(obj.self_escalation_enabled)
    );
  }

  if ('pm_recommendation_enabled' in obj && typeof obj.pm_recommendation_enabled !== 'boolean') {
    errors.push(
      'curator.pm_recommendation_enabled must be a boolean — got ' + JSON.stringify(obj.pm_recommendation_enabled)
    );
  }

  if ('tombstone_retention_runs' in obj) {
    const v = obj.tombstone_retention_runs;
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      errors.push(
        'curator.tombstone_retention_runs must be an integer 1..10 — got ' + JSON.stringify(v)
      );
    }
  }

  if ('diff_enabled' in obj && typeof obj.diff_enabled !== 'boolean') {
    errors.push(
      'curator.diff_enabled must be a boolean — got ' + JSON.stringify(obj.diff_enabled)
    );
  }

  if ('diff_cutoff_days' in obj) {
    const v = obj.diff_cutoff_days;
    if (!Number.isInteger(v) || v < 1 || v > 365) {
      errors.push(
        'curator.diff_cutoff_days must be an integer 1..365 — got ' + JSON.stringify(v)
      );
    }
  }

  if ('diff_forced_full_every' in obj) {
    const v = obj.diff_forced_full_every;
    if (!Number.isInteger(v) || v < 1 || v > 1000) {
      errors.push(
        'curator.diff_forced_full_every must be an integer 1..1000 — got ' + JSON.stringify(v)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// retrieval section defaults and loader (RS v2.1.3, promoted v2.1.13 W8)
//
// retrieval.scorer_variant — enum, default "baseline".
//   v2.1.13 R-RET-PROMOTE: promoted from shadow-only to selectable. Valid
//   values: "baseline" (default, legacy behaviour), "skip-down" (down-rank
//   frequently-skipped patterns), "local-success" (boost patterns that worked
//   in this project), "composite" (both adjustments stacked).
//   The default remains "baseline"; v2.2.0 will revisit the default once we
//   have more cross-install telemetry.
//
// retrieval.shadow_scorers — array of strings, default [].
//   Names of scorers to run alongside the primary in shadow mode.
//   Shadow scorers emit telemetry only and NEVER affect pattern_find output.
//   Valid names (v2.1.3): "skip-down", "local-success".
//
// retrieval.top_k — integer 1..50, default 10.
//   Window size for rank-agreement telemetry (Kendall tau, displacement).
//
// retrieval.jsonl_max_bytes — integer 65536..10485760, default 1MB.
//   Size cap for scorer-shadow.jsonl before rotation.
//
// retrieval.jsonl_max_generations — integer 1..10, default 3.
//   Number of rotated JSONL generations to keep.
//
// retrieval.global_kill_switch — boolean, default false.
//   Emergency no-op: when true, all shadow work is silently skipped regardless
//   of shadow_scorers. Does not require session restart.
// ---------------------------------------------------------------------------

const DEFAULT_RETRIEVAL = Object.freeze({
  /**
   * Authoritative scorer for pattern_find ranking.
   * v2.1.13 R-RET-PROMOTE: accepts "baseline" | "skip-down" | "local-success" |
   * "composite". Default remains "baseline"; unknown values coerce to baseline.
   * @type {string}
   */
  scorer_variant: 'baseline',

  /**
   * Shadow scorers to run fire-and-forget alongside the baseline.
   * Default is empty — no shadow work unless explicitly opted in.
   * @type {string[]}
   */
  shadow_scorers: [],

  /**
   * Top-K window for Kendall tau / overlap / displacement telemetry.
   * @type {number}
   */
  top_k: 10,

  /**
   * JSONL telemetry file size cap in bytes.
   * @type {number}
   */
  jsonl_max_bytes: 1 * 1024 * 1024,

  /**
   * Number of rotated JSONL generations to retain.
   * @type {number}
   */
  jsonl_max_generations: 3,

  /**
   * Emergency kill switch: true → shadow seam is a pure no-op.
   * @type {boolean}
   */
  global_kill_switch: false,
});

const _VALID_SHADOW_SCORER_NAMES = ['skip-down', 'local-success'];

// W8 (v2.1.13 R-RET-PROMOTE): scorer_variant is now a selectable enum.
const _VALID_SCORER_VARIANTS = ['baseline', 'skip-down', 'local-success', 'composite'];

/**
 * Load and merge the retrieval block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_RETRIEVAL so that
 * pattern_find continues to work without any shadow overhead.
 *
 * Stateless: re-reads config.json on every call (matches existing loaders).
 * Hot-path note: when shadow_scorers is empty (the default), maybeRunShadowScorers
 * returns synchronously after this call — cost is one fs.readFileSync + JSON.parse,
 * cached by the OS page cache.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {object} Merged retrieval config with all keys guaranteed present.
 */
function loadRetrievalConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_RETRIEVAL, { shadow_scorers: [] });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_RETRIEVAL, { shadow_scorers: [] });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_RETRIEVAL, { shadow_scorers: [] });
  }

  const fromFile = parsed.retrieval;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_RETRIEVAL, { shadow_scorers: [] });
  }

  const safe   = sanitizeConfig(fromFile);
  const merged = Object.assign({}, DEFAULT_RETRIEVAL, safe);

  // Post-merge validation and coercions.
  const result = validateRetrievalConfig(merged);
  if (!result.valid) {
    logStderr('retrieval config warnings: ' + result.errors.join('; '));
  }

  // scorer_variant: coerce unknown values to "baseline" (v2.1.13 promotes
  // skip-down / local-success / composite alongside the legacy baseline).
  if (!_VALID_SCORER_VARIANTS.includes(merged.scorer_variant)) {
    logStderr(
      'retrieval.scorer_variant "' + merged.scorer_variant +
      '" not recognised; valid: ' + _VALID_SCORER_VARIANTS.join(', ') +
      '. Coercing to "baseline".'
    );
    merged.scorer_variant = 'baseline';
  }

  // shadow_scorers: dedup and drop unknown names.
  if (!Array.isArray(merged.shadow_scorers)) {
    merged.shadow_scorers = [];
  } else {
    const seen = new Set();
    const valid = [];
    for (const name of merged.shadow_scorers) {
      if (typeof name !== 'string') continue;
      if (seen.has(name)) continue;
      seen.add(name);
      if (_VALID_SHADOW_SCORER_NAMES.includes(name)) {
        valid.push(name);
      } else {
        try {
          recordDegradation({
            kind: 'shadow_scorer_failed',
            severity: 'warn',
            detail: {
              scorer_name: name,
              error:       'unknown scorer name in retrieval.shadow_scorers',
              dedup_key:   'shadow_scorer_failed_' + name,
            },
          });
        } catch (_) { /* swallow */ }
      }
    }
    merged.shadow_scorers = valid;
  }

  // Clamp top_k.
  if (!Number.isInteger(merged.top_k) || merged.top_k < 1)  merged.top_k = DEFAULT_RETRIEVAL.top_k;
  if (merged.top_k > 50) merged.top_k = 50;

  // Clamp jsonl_max_bytes.
  const MIN_BYTES = 64 * 1024;
  const MAX_BYTES = 10 * 1024 * 1024;
  if (!Number.isInteger(merged.jsonl_max_bytes) || merged.jsonl_max_bytes < MIN_BYTES) {
    merged.jsonl_max_bytes = DEFAULT_RETRIEVAL.jsonl_max_bytes;
  }
  if (merged.jsonl_max_bytes > MAX_BYTES) merged.jsonl_max_bytes = MAX_BYTES;

  // Clamp jsonl_max_generations.
  if (!Number.isInteger(merged.jsonl_max_generations) || merged.jsonl_max_generations < 1) {
    merged.jsonl_max_generations = DEFAULT_RETRIEVAL.jsonl_max_generations;
  }
  if (merged.jsonl_max_generations > 10) merged.jsonl_max_generations = 10;

  // global_kill_switch: coerce to boolean.
  if (typeof merged.global_kill_switch !== 'boolean') {
    merged.global_kill_switch = DEFAULT_RETRIEVAL.global_kill_switch;
  }

  return merged;
}

/**
 * Validate a retrieval config object.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateRetrievalConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['retrieval config must be an object'] };
  }

  if ('scorer_variant' in obj && !_VALID_SCORER_VARIANTS.includes(obj.scorer_variant)) {
    errors.push(
      'retrieval.scorer_variant must be one of: ' +
      _VALID_SCORER_VARIANTS.join(', ') + ' — got ' +
      JSON.stringify(obj.scorer_variant)
    );
  }

  if ('shadow_scorers' in obj) {
    if (!Array.isArray(obj.shadow_scorers)) {
      errors.push('retrieval.shadow_scorers must be an array');
    } else {
      for (const name of obj.shadow_scorers) {
        if (typeof name !== 'string') {
          errors.push('retrieval.shadow_scorers entries must be strings');
          break;
        }
        if (!_VALID_SHADOW_SCORER_NAMES.includes(name)) {
          errors.push(
            'retrieval.shadow_scorers: unknown scorer "' + name +
            '"; valid names: ' + _VALID_SHADOW_SCORER_NAMES.join(', ')
          );
        }
      }
    }
  }

  if ('top_k' in obj) {
    const v = obj.top_k;
    if (!Number.isInteger(v) || v < 1 || v > 50) {
      errors.push('retrieval.top_k must be an integer 1..50 — got ' + JSON.stringify(v));
    }
  }

  if ('jsonl_max_bytes' in obj) {
    const v = obj.jsonl_max_bytes;
    if (!Number.isInteger(v) || v < 64 * 1024 || v > 10 * 1024 * 1024) {
      errors.push('retrieval.jsonl_max_bytes must be an integer 65536..10485760 — got ' + JSON.stringify(v));
    }
  }

  if ('jsonl_max_generations' in obj) {
    const v = obj.jsonl_max_generations;
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      errors.push('retrieval.jsonl_max_generations must be an integer 1..10 — got ' + JSON.stringify(v));
    }
  }

  if ('global_kill_switch' in obj && typeof obj.global_kill_switch !== 'boolean') {
    errors.push('retrieval.global_kill_switch must be a boolean — got ' + JSON.stringify(obj.global_kill_switch));
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// auto_learning section defaults and loader (W7 v2.1.6)
//
// All features default OFF. The global_kill_switch is the single master gate.
// Env var ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1 overrides config (checked before
// config parse so even a malformed config block can be killed).
//
// Key table (from design §4):
//   global_kill_switch                               bool   false
//   extract_on_complete.enabled                      bool   false   (MUST stay false — opt-in)
//   extract_on_complete.shadow_mode                  bool   false
//   extract_on_complete.proposals_per_orchestration  int    3       clamp [1,10]
//   extract_on_complete.proposals_per_24h            int    10      clamp [1,50]
//   roi_aggregator.enabled                           bool   false
//   roi_aggregator.min_days_between_runs             int    1       clamp [1,90]
//   roi_aggregator.lookback_days                     int    30      clamp [1,365]
//   kb_refs_sweep.enabled                            bool   false
//   kb_refs_sweep.min_days_between_runs              int    7       clamp [1,90]
//   kb_refs_sweep.ignore_slugs                       string[] []    max 100 entries; each /^[a-z][a-z0-9-]{3,40}$/
//   safety.circuit_breaker.max_extractions_per_24h   int    10      clamp [1,100]
//   safety.circuit_breaker.cooldown_minutes_on_trip  int    60      clamp [5,1440]
//
// Caller responsibility for kill-switch cascade:
//   If loadAutoLearningConfig returns global_kill_switch === true, callers MUST
//   treat all sub-feature enabled flags as false regardless of their stored value.
//   The loader does NOT mutate sub-feature flags — it only surfaces the kill switch.
// ---------------------------------------------------------------------------

const DEFAULT_AUTO_LEARNING = Object.freeze({
  global_kill_switch: false,
  extract_on_complete: Object.freeze({
    enabled: false,
    shadow_mode: false,
    proposals_per_orchestration: 3,
    proposals_per_24h: 10,
    // v2.1.7 Bundle A: live Haiku backend config
    backend:          'haiku-cli', // 'haiku-cli' | 'stub' (haiku-sdk removed in v2.1.7 zero-deferral per K3)
    // Empirically, 60s was too tight for Haiku on archives with 30+ quarantined
    // events — the CLI routinely hit SIGTERM mid-reasoning (observed 2026-04-20
    // on a 40-event v2.1.9-design archive). Default raised to 180s; clamp
    // preserved at [5_000, 300_000] so operators can still cap aggressively.
    timeout_ms:        180_000,
    max_output_bytes:  65_536,     // hard stdout cap; clamp [1024, 1_048_576]
  }),
  roi_aggregator: Object.freeze({
    enabled: false,
    min_days_between_runs: 1,
    lookback_days: 30,
  }),
  kb_refs_sweep: Object.freeze({
    enabled: false,
    min_days_between_runs: 7,
    ignore_slugs: Object.freeze([]),
  }),
  safety: Object.freeze({
    circuit_breaker: Object.freeze({
      max_extractions_per_24h: 10,
      cooldown_minutes_on_trip: 60,
    }),
  }),
});

/**
 * Clamp an integer to [min, max]. Returns the default value if the input is not
 * a finite integer.
 *
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @param {number} defaultVal
 * @returns {number}
 */
function _clampInt(v, min, max, defaultVal) {
  if (!Number.isInteger(v)) return defaultVal;
  return Math.max(min, Math.min(max, v));
}

/**
 * Load and validate the auto_learning config block from
 * <cwd>/.orchestray/config.json.
 *
 * Fail-closed contract (diverges from other loaders):
 *   - Missing block → return all-off defaults; no degraded-journal entry (valid initial state).
 *   - Malformed block (type mismatches, non-object) → return all-off defaults AND emit a
 *     degraded-journal entry with kind 'auto_learning_config_malformed'.
 *
 * Env-var kill switch:
 *   ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1 → returns global_kill_switch:true regardless of
 *   config file content. Checked BEFORE config parse so even a malformed file can be killed.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{
 *   global_kill_switch: boolean,
 *   extract_on_complete: { enabled: boolean, shadow_mode: boolean, proposals_per_orchestration: number, proposals_per_24h: number, backend: string, timeout_ms: number, max_output_bytes: number },
 *   roi_aggregator: { enabled: boolean, min_days_between_runs: number, lookback_days: number },
 *   kb_refs_sweep: { enabled: boolean, min_days_between_runs: number, ignore_slugs: string[] },
 *   safety: { circuit_breaker: { max_extractions_per_24h: number, cooldown_minutes_on_trip: number } }
 * }}
 */
function loadAutoLearningConfig(cwd) {
  // Env-var kill switch takes unconditional precedence — check BEFORE anything else.
  if (process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH === '1') {
    return _buildAutoLearningAllOff(true);
  }

  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    // File missing or unreadable — all-off defaults, no journal entry.
    return _buildAutoLearningAllOff(false);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    // Malformed JSON — all-off defaults + journal.
    _recordAutoLearningMalformed(cwd, 'json_parse_error');
    return _buildAutoLearningAllOff(false);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    _recordAutoLearningMalformed(cwd, 'config_not_object');
    return _buildAutoLearningAllOff(false);
  }

  const fromFile = parsed.auto_learning;

  // Missing block → all-off defaults (valid initial state, no journal entry).
  if (fromFile === undefined || fromFile === null) {
    return _buildAutoLearningAllOff(false);
  }

  // Block present but wrong type → malformed.
  if (typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    _recordAutoLearningMalformed(cwd, 'block_wrong_type');
    return _buildAutoLearningAllOff(false);
  }

  // Parse and validate each sub-section. Any non-recoverable type error on a bool
  // key returns all-off + journal. Integer keys are clamped (recover gracefully).
  try {
    return _parseAutoLearningBlock(fromFile, cwd);
  } catch (_) {
    _recordAutoLearningMalformed(cwd, 'parse_threw');
    return _buildAutoLearningAllOff(false);
  }
}

/**
 * Build the all-off defaults shape, optionally with global_kill_switch forced on.
 *
 * @param {boolean} killSwitch
 * @returns {object}
 */
function _buildAutoLearningAllOff(killSwitch) {
  return {
    global_kill_switch: killSwitch,
    extract_on_complete: {
      enabled: false,
      shadow_mode: false,
      proposals_per_orchestration: DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_orchestration,
      proposals_per_24h:           DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_24h,
      backend:                     DEFAULT_AUTO_LEARNING.extract_on_complete.backend,
      timeout_ms:                  DEFAULT_AUTO_LEARNING.extract_on_complete.timeout_ms,
      max_output_bytes:            DEFAULT_AUTO_LEARNING.extract_on_complete.max_output_bytes,
    },
    roi_aggregator: {
      enabled: false,
      min_days_between_runs: DEFAULT_AUTO_LEARNING.roi_aggregator.min_days_between_runs,
      lookback_days: DEFAULT_AUTO_LEARNING.roi_aggregator.lookback_days,
    },
    kb_refs_sweep: {
      enabled: false,
      min_days_between_runs: DEFAULT_AUTO_LEARNING.kb_refs_sweep.min_days_between_runs,
      ignore_slugs: [],
    },
    safety: {
      circuit_breaker: {
        max_extractions_per_24h: DEFAULT_AUTO_LEARNING.safety.circuit_breaker.max_extractions_per_24h,
        cooldown_minutes_on_trip: DEFAULT_AUTO_LEARNING.safety.circuit_breaker.cooldown_minutes_on_trip,
      },
    },
  };
}

/**
 * Parse a validated (non-null, non-array object) auto_learning block from config.
 * Returns all-off defaults for any bool key with a non-boolean value, emitting a
 * degraded-journal entry.
 *
 * @param {object} fromFile
 * @param {string} cwd
 * @returns {object}
 */
function _parseAutoLearningBlock(fromFile, cwd) {
  // global_kill_switch
  let globalKill = DEFAULT_AUTO_LEARNING.global_kill_switch;
  if ('global_kill_switch' in fromFile) {
    if (typeof fromFile.global_kill_switch !== 'boolean') {
      _recordAutoLearningMalformed(cwd, 'global_kill_switch_wrong_type');
      return _buildAutoLearningAllOff(false);
    }
    globalKill = fromFile.global_kill_switch;
  }

  // extract_on_complete sub-block
  const eocSrc = (fromFile.extract_on_complete && typeof fromFile.extract_on_complete === 'object' && !Array.isArray(fromFile.extract_on_complete))
    ? fromFile.extract_on_complete
    : {};

  if ('enabled' in eocSrc && typeof eocSrc.enabled !== 'boolean') {
    _recordAutoLearningMalformed(cwd, 'extract_on_complete.enabled_wrong_type');
    return _buildAutoLearningAllOff(false);
  }
  if ('shadow_mode' in eocSrc && typeof eocSrc.shadow_mode !== 'boolean') {
    _recordAutoLearningMalformed(cwd, 'extract_on_complete.shadow_mode_wrong_type');
    return _buildAutoLearningAllOff(false);
  }

  // CHG-01 backward compat: `shadow` (legacy alias) falls back if `shadow_mode` absent.
  // `shadow_mode` takes precedence over `shadow`.
  let shadowMode = DEFAULT_AUTO_LEARNING.extract_on_complete.shadow_mode;
  if ('shadow_mode' in eocSrc) {
    shadowMode = eocSrc.shadow_mode;
  } else if ('shadow' in eocSrc && typeof eocSrc.shadow === 'boolean') {
    shadowMode = eocSrc.shadow;
  }

  // v2.1.7 Bundle A: backend field ('haiku-cli' | 'stub').
  // F4 (zero-deferral): 'haiku-sdk' removed from VALID_BACKENDS per K3 arbitration.
  // The SDK transport path is explicitly not implemented in v2.1.x; if a user sets
  // backend: 'haiku-sdk', we journal a warning and fall back to 'haiku-cli' rather
  // than silently aliasing. This gives operators a clear diagnostic signal.
  const VALID_BACKENDS = new Set(['haiku-cli', 'stub']);
  let backend = DEFAULT_AUTO_LEARNING.extract_on_complete.backend;
  if ('backend' in eocSrc) {
    if (eocSrc.backend === 'haiku-sdk') {
      // Loud fallback: journal a degradation so operators know their config is wrong.
      try {
        recordDegradation({
          kind: 'auto_extract_backend_unsupported_value',
          severity: 'warn',
          projectRoot: cwd,
          detail: {
            provided: eocSrc.backend,
            fallback: 'haiku-cli',
            reason: 'haiku-sdk transport not implemented in v2.1.x (K3 arbitration); use haiku-cli',
          },
        });
      } catch (_) { /* fail-open */ }
      backend = 'haiku-cli';
    } else if (!VALID_BACKENDS.has(eocSrc.backend)) {
      _recordAutoLearningMalformed(cwd, 'extract_on_complete.backend_invalid_value');
      return _buildAutoLearningAllOff(false);
    } else {
      backend = eocSrc.backend;
    }
  }

  const eoc = {
    enabled:                    ('enabled' in eocSrc) ? eocSrc.enabled : DEFAULT_AUTO_LEARNING.extract_on_complete.enabled,
    shadow_mode:                shadowMode,
    proposals_per_orchestration: _clampInt(eocSrc.proposals_per_orchestration, 1, 10, DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_orchestration),
    proposals_per_24h:           _clampInt(eocSrc.proposals_per_24h,           1, 50, DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_24h),
    // v2.1.7 Bundle A fields
    backend,
    timeout_ms:       _clampInt(eocSrc.timeout_ms,       5_000, 300_000, DEFAULT_AUTO_LEARNING.extract_on_complete.timeout_ms),
    max_output_bytes: _clampInt(eocSrc.max_output_bytes, 1024,  1_048_576, DEFAULT_AUTO_LEARNING.extract_on_complete.max_output_bytes),
  };

  // roi_aggregator sub-block
  const roiSrc = (fromFile.roi_aggregator && typeof fromFile.roi_aggregator === 'object' && !Array.isArray(fromFile.roi_aggregator))
    ? fromFile.roi_aggregator
    : {};

  if ('enabled' in roiSrc && typeof roiSrc.enabled !== 'boolean') {
    _recordAutoLearningMalformed(cwd, 'roi_aggregator.enabled_wrong_type');
    return _buildAutoLearningAllOff(false);
  }

  const roi = {
    enabled:              ('enabled' in roiSrc) ? roiSrc.enabled : DEFAULT_AUTO_LEARNING.roi_aggregator.enabled,
    min_days_between_runs: _clampInt(roiSrc.min_days_between_runs, 1, 90,  DEFAULT_AUTO_LEARNING.roi_aggregator.min_days_between_runs),
    lookback_days:         _clampInt(roiSrc.lookback_days,         1, 365, DEFAULT_AUTO_LEARNING.roi_aggregator.lookback_days),
  };

  // kb_refs_sweep sub-block
  const kbSrc = (fromFile.kb_refs_sweep && typeof fromFile.kb_refs_sweep === 'object' && !Array.isArray(fromFile.kb_refs_sweep))
    ? fromFile.kb_refs_sweep
    : {};

  if ('enabled' in kbSrc && typeof kbSrc.enabled !== 'boolean') {
    _recordAutoLearningMalformed(cwd, 'kb_refs_sweep.enabled_wrong_type');
    return _buildAutoLearningAllOff(false);
  }

  // ignore_slugs: array of slug strings (max 100; each must match /^[a-z][a-z0-9-]{3,40}$/).
  // Invalid entries are dropped with a non-blocking warning (flat_*_keys_accepted precedent).
  const SLUG_SHAPE = /^[a-z][a-z0-9-]{3,40}$/;
  const MAX_IGNORE_SLUGS = 100;
  let ignoreSlugs = [];
  if ('ignore_slugs' in kbSrc) {
    if (!Array.isArray(kbSrc.ignore_slugs)) {
      // Non-array value: emit non-blocking warning and use default.
      try {
        recordDegradation({
          kind: 'auto_learning_config_malformed',
          severity: 'warn',
          detail: { reason: 'kb_refs_sweep.ignore_slugs_wrong_type' },
          projectRoot: cwd,
        });
      } catch (_) { /* fail-open */ }
    } else {
      const rawSlugs = kbSrc.ignore_slugs.slice(0, MAX_IGNORE_SLUGS);
      const badSlugs = rawSlugs.filter((s) => typeof s !== 'string' || !SLUG_SHAPE.test(s));
      if (badSlugs.length > 0) {
        // Non-blocking: warn but continue with valid entries only.
        try {
          recordDegradation({
            kind: 'auto_learning_config_malformed',
            severity: 'warn',
            detail: { reason: 'kb_refs_sweep.ignore_slugs_invalid_entries', invalid: badSlugs.slice(0, 10) },
            projectRoot: cwd,
          });
        } catch (_) { /* fail-open */ }
      }
      ignoreSlugs = rawSlugs.filter((s) => typeof s === 'string' && SLUG_SHAPE.test(s));
    }
  }

  const kbRefs = {
    enabled:              ('enabled' in kbSrc) ? kbSrc.enabled : DEFAULT_AUTO_LEARNING.kb_refs_sweep.enabled,
    min_days_between_runs: _clampInt(kbSrc.min_days_between_runs, 1, 90, DEFAULT_AUTO_LEARNING.kb_refs_sweep.min_days_between_runs),
    ignore_slugs: ignoreSlugs,
  };

  // safety.circuit_breaker sub-block
  const safetySrc = (fromFile.safety && typeof fromFile.safety === 'object' && !Array.isArray(fromFile.safety))
    ? fromFile.safety
    : {};
  const cbSrc = (safetySrc.circuit_breaker && typeof safetySrc.circuit_breaker === 'object' && !Array.isArray(safetySrc.circuit_breaker))
    ? safetySrc.circuit_breaker
    : {};

  const cb = {
    max_extractions_per_24h:  _clampInt(cbSrc.max_extractions_per_24h,  1,   100,  DEFAULT_AUTO_LEARNING.safety.circuit_breaker.max_extractions_per_24h),
    cooldown_minutes_on_trip: _clampInt(cbSrc.cooldown_minutes_on_trip, 5,  1440, DEFAULT_AUTO_LEARNING.safety.circuit_breaker.cooldown_minutes_on_trip),
  };

  return {
    global_kill_switch: globalKill,
    extract_on_complete: eoc,
    roi_aggregator: roi,
    kb_refs_sweep: kbRefs,
    safety: { circuit_breaker: cb },
  };
}

/**
 * Emit a degraded-journal entry for a malformed auto_learning block.
 * Fail-open: never throws.
 *
 * @param {string} cwd
 * @param {string} detail
 */
function _recordAutoLearningMalformed(cwd, detail) {
  try {
    recordDegradation({
      kind: 'auto_learning_config_malformed',
      severity: 'warn',
      detail: { reason: detail },
      projectRoot: cwd,
    });
  } catch (_) {
    // Fail-open.
  }
}

// ---------------------------------------------------------------------------
// resilience section defaults and loader (v2.1.7 Bundle D)
//
// K1 (arbitration, BINDING): resilience ships LIVE by default —
//   enabled=true, shadow_mode=false on every fresh install. Source:
//   .orchestray/kb/decisions/v217-arbitration.md.
//
// The write-resilience-dossier.js Stop/SubagentStop hooks and the
// inject-resilience-dossier.js UserPromptSubmit hook honor the following
// kill-switches, in order of precedence:
//
//   1. ORCHESTRAY_RESILIENCE_DISABLED=1   env var, unconditional
//   2. resilience.kill_switch: true        hard-off, independent of enabled
//   3. resilience.enabled: false           soft-off
//   4. resilience.shadow_mode: true        dossier still written, NOT injected
// ---------------------------------------------------------------------------

const DEFAULT_RESILIENCE = Object.freeze({
  enabled: true,            // K1: LIVE by default
  shadow_mode: false,       // K1: NOT shadow by default
  inject_max_bytes: 12288,  // 12 KB hard cap on additionalContext payload (W3 §B2)
  max_inject_turns: 3,      // W3 §A3: post-compact turns that receive dossier
  kill_switch: false,       // config hard-off, independent of enabled
});

/**
 * Load the `resilience` config block with fail-open semantics. Missing /
 * malformed / wrong-type falls through to DEFAULT_RESILIENCE.
 *
 * Env var `ORCHESTRAY_RESILIENCE_DISABLED=1` forces `enabled:false,
 * kill_switch:true` regardless of disk state — mirrors the
 * `ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH` precedent.
 *
 * @param {string} cwd - Absolute project root.
 * @returns {{
 *   enabled: boolean,
 *   shadow_mode: boolean,
 *   inject_max_bytes: number,
 *   max_inject_turns: number,
 *   kill_switch: boolean,
 * }}
 */
function loadResilienceConfig(cwd) {
  if (process.env.ORCHESTRAY_RESILIENCE_DISABLED === '1') {
    return Object.assign({}, DEFAULT_RESILIENCE, { enabled: false, kill_switch: true });
  }

  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_RESILIENCE);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_RESILIENCE);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_RESILIENCE);
  }

  const fromFile = parsed.resilience;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_RESILIENCE);
  }

  const safe = sanitizeConfig(fromFile);
  const merged = Object.assign({}, DEFAULT_RESILIENCE);

  if (typeof safe.enabled === 'boolean')      merged.enabled = safe.enabled;
  if (typeof safe.shadow_mode === 'boolean')  merged.shadow_mode = safe.shadow_mode;
  if (typeof safe.kill_switch === 'boolean')  merged.kill_switch = safe.kill_switch;

  if (Number.isInteger(safe.inject_max_bytes)) {
    merged.inject_max_bytes = Math.max(512, Math.min(32 * 1024, safe.inject_max_bytes));
  }
  if (Number.isInteger(safe.max_inject_turns)) {
    merged.max_inject_turns = Math.max(1, Math.min(10, safe.max_inject_turns));
  }

  return merged;
}

/**
 * Validate a resilience block (for post-upgrade-sweep / config-repair paths).
 * Range-checks numerics per W3 §F3. Returns the list of problem strings.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateResilienceConfig(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['resilience must be an object'] };
  }
  if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
    errors.push('resilience.enabled must be a boolean');
  }
  if ('shadow_mode' in obj && typeof obj.shadow_mode !== 'boolean') {
    errors.push('resilience.shadow_mode must be a boolean');
  }
  if ('kill_switch' in obj && typeof obj.kill_switch !== 'boolean') {
    errors.push('resilience.kill_switch must be a boolean');
  }
  if ('inject_max_bytes' in obj) {
    if (!Number.isInteger(obj.inject_max_bytes) ||
        obj.inject_max_bytes < 512 || obj.inject_max_bytes > 32768) {
      errors.push('resilience.inject_max_bytes must be an integer in [512, 32768]');
    }
  }
  if ('max_inject_turns' in obj) {
    if (!Number.isInteger(obj.max_inject_turns) ||
        obj.max_inject_turns < 1 || obj.max_inject_turns > 10) {
      errors.push('resilience.max_inject_turns must be an integer in [1, 10]');
    }
  }
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// telemetry section defaults and loader (R-TGATE v2.1.14)
//
// telemetry.tier2_tracking.enabled — boolean, default true.
//   When false, all R-TGATE hooks (emit-tier2-load.js, gate-telemetry.js,
//   tier2-invoked-emitter.js) skip event emission. This is the config-level
//   kill switch for the v2.1.14 tier-2 telemetry layer.
//
// Env-var kill switch: ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1 overrides this
//   setting (checked before config parse so even a malformed config can be killed).
// ---------------------------------------------------------------------------

const DEFAULT_TELEMETRY = Object.freeze({
  tier2_tracking: Object.freeze({
    enabled: true,
  }),
});

/**
 * Load and merge the telemetry block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_TELEMETRY so hooks
 * still run at safe defaults (enabled=true).
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ tier2_tracking: { enabled: boolean } }}
 */
function loadTelemetryConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return { tier2_tracking: Object.assign({}, DEFAULT_TELEMETRY.tier2_tracking) };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { tier2_tracking: Object.assign({}, DEFAULT_TELEMETRY.tier2_tracking) };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tier2_tracking: Object.assign({}, DEFAULT_TELEMETRY.tier2_tracking) };
  }

  const fromFile = parsed.telemetry;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return { tier2_tracking: Object.assign({}, DEFAULT_TELEMETRY.tier2_tracking) };
  }

  // Merge tier2_tracking sub-section.
  const t2FromFile = fromFile.tier2_tracking;
  const t2Merged = Object.assign(
    {},
    DEFAULT_TELEMETRY.tier2_tracking,
    (t2FromFile && typeof t2FromFile === 'object' && !Array.isArray(t2FromFile))
      ? sanitizeConfig(t2FromFile)
      : {}
  );

  // Validate and warn — always return merged (fail-open).
  try {
    const result = validateTelemetryConfig({ tier2_tracking: t2Merged });
    if (!result.valid) {
      logStderr('telemetry config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return { tier2_tracking: t2Merged };
}

/**
 * Validate a telemetry config object (as returned by loadTelemetryConfig).
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateTelemetryConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['telemetry config must be an object'] };
  }

  if ('tier2_tracking' in obj) {
    const t2 = obj.tier2_tracking;
    if (!t2 || typeof t2 !== 'object' || Array.isArray(t2)) {
      errors.push('telemetry.tier2_tracking must be an object');
    } else if ('enabled' in t2 && typeof t2.enabled !== 'boolean') {
      errors.push(
        'telemetry.tier2_tracking.enabled must be a boolean — got ' + JSON.stringify(t2.enabled)
      );
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

// ---------------------------------------------------------------------------
// handoff_body_cap section defaults and loader (R-HCAP v2.1.14)
//
// handoff_body_cap.enabled — boolean, default true.
//   When false, the T15 hook skips all body-size checks (reverts to pre-v2.1.14).
//
// handoff_body_cap.warn_tokens — integer, default 2500.
//   Token count (4-bytes-per-token heuristic) at which handoff_body_warn is emitted.
//
// handoff_body_cap.block_tokens — integer, default 5000.
//   Token count above which a block is triggered when no detail_artifact is present.
//
// handoff_body_cap.hard_block — boolean, default false (v2.1.14).
//   When false: soft-warn-only (exit 0, threshold_breached: "block_would_have_fired").
//   When true: exit 2 blocks completion. Flip to true in v2.1.15.
// ---------------------------------------------------------------------------

const DEFAULT_HANDOFF_BODY_CAP = Object.freeze({
  enabled: true,
  warn_tokens: 2500,
  block_tokens: 5000,
  hard_block: false,
});

/**
 * Load and merge the handoff_body_cap block from <cwd>/.orchestray/config.json.
 *
 * Fail-open contract: missing/malformed returns DEFAULT_HANDOFF_BODY_CAP so
 * the hook still runs at safe defaults rather than crashing.
 *
 * @param {string} cwd - Project root directory (absolute path).
 * @returns {{ enabled: boolean, warn_tokens: number, block_tokens: number, hard_block: boolean }}
 */
function loadHandoffBodyCapConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_) {
    return Object.assign({}, DEFAULT_HANDOFF_BODY_CAP);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return Object.assign({}, DEFAULT_HANDOFF_BODY_CAP);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_HANDOFF_BODY_CAP);
  }

  const fromFile = parsed.handoff_body_cap;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_HANDOFF_BODY_CAP);
  }

  const merged = Object.assign({}, DEFAULT_HANDOFF_BODY_CAP, sanitizeConfig(fromFile));

  try {
    const result = validateHandoffBodyCapConfig(merged);
    if (!result.valid) {
      logStderr('handoff_body_cap config warnings: ' + result.errors.join('; '));
    }
  } catch (_e) {
    // Validation must never throw
  }

  return merged;
}

/**
 * Validate a handoff_body_cap config object.
 *
 * Did-you-mean suggestions follow the R-CONFIG-DRIFT (v2.1.13) pattern:
 * common misspellings are detected and a correction hint is emitted.
 *
 * @param {unknown} obj
 * @returns {{ valid: true } | { valid: false, errors: string[] }}
 */
function validateHandoffBodyCapConfig(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { valid: false, errors: ['handoff_body_cap must be an object'] };
  }

  // Did-you-mean suggestions for common misspellings (R-CONFIG-DRIFT pattern).
  const DID_YOU_MEAN = {
    body_cap_enabled:     'handoff_body_cap.enabled',
    cap_enabled:          'handoff_body_cap.enabled',
    warn_threshold:       'handoff_body_cap.warn_tokens',
    block_threshold:      'handoff_body_cap.block_tokens',
    hard_block_enabled:   'handoff_body_cap.hard_block',
    enable_hard_block:    'handoff_body_cap.hard_block',
  };
  for (const [misspelling, suggestion] of Object.entries(DID_YOU_MEAN)) {
    if (misspelling in obj) {
      errors.push(
        'handoff_body_cap.' + misspelling + ' is not a valid key — did you mean ' + suggestion + '?'
      );
    }
  }

  if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
    errors.push(
      'handoff_body_cap.enabled must be a boolean — got ' + JSON.stringify(obj.enabled)
    );
  }

  if ('warn_tokens' in obj) {
    const v = obj.warn_tokens;
    if (!Number.isInteger(v) || v < 1) {
      errors.push(
        'handoff_body_cap.warn_tokens must be a positive integer — got ' + JSON.stringify(v)
      );
    }
  }

  if ('block_tokens' in obj) {
    const v = obj.block_tokens;
    if (!Number.isInteger(v) || v < 1) {
      errors.push(
        'handoff_body_cap.block_tokens must be a positive integer — got ' + JSON.stringify(v)
      );
    }
    // Semantic check: block_tokens should be >= warn_tokens.
    const wt = ('warn_tokens' in obj && Number.isInteger(obj.warn_tokens)) ? obj.warn_tokens : DEFAULT_HANDOFF_BODY_CAP.warn_tokens;
    if (Number.isInteger(v) && v < wt) {
      errors.push(
        'handoff_body_cap.block_tokens (' + v + ') must be >= warn_tokens (' + wt + ')'
      );
    }
  }

  if ('hard_block' in obj && typeof obj.hard_block !== 'boolean') {
    errors.push(
      'handoff_body_cap.hard_block must be a boolean — got ' + JSON.stringify(obj.hard_block)
    );
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
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
  // C (v2.1.7): max_per_task schema loader + validator
  loadMcpServerConfig,
  validateMcpServerConfig,
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
  // W3 (v2.0.19): context statusbar config
  DEFAULT_CONTEXT_STATUSBAR,
  loadContextStatusbarConfig,
  validateContextStatusbarConfig,
  // B1 (v2.1.0): federation shared-dir config
  DEFAULT_FEDERATION,
  loadFederationConfig,
  validateFederationConfig,
  // B8 (v2.1.0): curator config
  DEFAULT_CURATOR,
  loadCuratorConfig,
  validateCuratorConfig,
  // RS (v2.1.3): retrieval shadow scorer config
  DEFAULT_RETRIEVAL,
  loadRetrievalConfig,
  validateRetrievalConfig,
  logStderr,
  // Exposed for test teardown only — clear between test runs to reset per-process guard.
  _flatDeprecationWarned,
  // W7 (v2.1.6): auto_learning config block
  DEFAULT_AUTO_LEARNING,
  loadAutoLearningConfig,
  // D (v2.1.7): resilience config block
  DEFAULT_RESILIENCE,
  loadResilienceConfig,
  validateResilienceConfig,
  // R-TGATE (v2.1.14): telemetry config block
  DEFAULT_TELEMETRY,
  loadTelemetryConfig,
  validateTelemetryConfig,
  // R-HCAP (v2.1.14): handoff body cap config
  DEFAULT_HANDOFF_BODY_CAP,
  loadHandoffBodyCapConfig,
  validateHandoffBodyCapConfig,
};
