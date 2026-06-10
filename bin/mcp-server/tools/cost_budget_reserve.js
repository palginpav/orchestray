'use strict';

/**
 * `cost_budget_reserve` MCP tool.
 *
 * Creates a 30-minute forward reservation for a projected Agent() spawn cost.
 * The reservation is appended to .orchestray/state/cost-reservations.jsonl.
 * Subsequent cost_budget_check calls sum unexpired reservations into their
 * accumulated spend estimate via a sibling accumulator file.
 *
 * Input:
 *   orchestration_id   — required
 *   task_id            — required
 *   agent_type         — required
 *   model              — required (haiku | sonnet | opus | full model ID)
 *   effort             — optional (low | medium | high | max)
 *   estimated_input_tokens  — optional
 *   estimated_output_tokens — optional
 *
 * Output:
 *   { reservation_id, orchestration_id, task_id, agent_type, model,
 *     model_tier, effort, projected_cost_usd, expires_at, created_at }
 *
 * Per v2016-release-plan.md §W4.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');

// Reuse pricing helpers from cost_budget_check (read-only — no circular dep
// because cost_budget_check exports these helpers explicitly).
const {
  resolveModelTier,
  resolvePricingTable,
  computeCost,
  resolveEffortMultiplier,
} = require('./cost_budget_check');

// Shared cost helpers — canonical pricing table, token estimates, TTL constant/loader,
// and GC thresholds (F09: de-duplicated from three callers; F13: named TTL constant;
//  D5: loadReservationTTLMs reads configurable TTL from config;
//  A2-I1: GC_OPPORTUNISTIC_TRIGGER_BYTES eliminates magic-number drift).
const {
  BUILTIN_PRICING_TABLE,
  DEFAULT_TOKEN_ESTIMATES,
  DEFAULT_RESERVATION_TTL_MS,
  GC_OPPORTUNISTIC_TRIGGER_BYTES,
  loadReservationTTLMs,
} = require('../../_lib/cost-helpers');

// Atomic append + advisory lock primitives.
// F05: atomicAppendJsonl replaces non-atomic fs.appendFileSync.
// B1: _withAdvisoryLock wraps the idempotency find→append critical section.
const { atomicAppendJsonl, _withAdvisoryLock } = require('../../_lib/atomic-append');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

// File that holds reservation records (append-only JSONL)
const RESERVATIONS_FILE = '.orchestray/state/cost-reservations.jsonl';

const EFFORT_VALUES = ['low', 'medium', 'high', 'max'];

const INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['orchestration_id', 'task_id', 'agent_type', 'model'],
  additionalProperties: false,
  properties: {
    orchestration_id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Current orchestration ID.',
    },
    task_id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Task ID being reserved for (e.g. "task-1").',
    },
    agent_type: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'Agent role for the proposed spawn (standard roles or dynamic specialist names).',
    },
    reservation_id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      // F04: When provided, the tool is idempotent — if a record with this
      // reservation_id already exists in the ledger, it is returned unchanged
      // and no duplicate row is written.
      description: 'Optional caller-supplied idempotency key. If provided and a reservation with this ID already exists, the existing record is returned unchanged (no duplicate write).',
    },
    model: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Model name or tier (haiku, sonnet, opus, or full model ID).',
    },
    effort: {
      type: 'string',
      enum: EFFORT_VALUES,
      description: 'Effort level (low, medium, high, max). Optional — applies cost multiplier.',
    },
    estimated_input_tokens: {
      type: 'integer',
      minimum: 0,
      maximum: 2_000_000,
      description: 'Estimated input tokens. If omitted, historical averages are used.',
    },
    estimated_output_tokens: {
      type: 'integer',
      minimum: 0,
      maximum: 2_000_000,
      description: 'Estimated output tokens. If omitted, historical averages are used.',
    },
  },
});

const definition = deepFreeze({
  name: 'cost_budget_reserve',
  description:
    'Create a 30-minute forward cost reservation for a proposed Agent() spawn. ' +
    'The reservation is appended to .orchestray/state/cost-reservations.jsonl. ' +
    'Subsequent cost_budget_check calls count unexpired reservations against the ' +
    'cost caps, preventing over-allocation when spawning agents in parallel. ' +
    'Per v2016-release-plan.md §W4.',
  inputSchema: INPUT_SCHEMA,
});

/**
 * Resolve token estimates from explicit inputs or model-tier defaults.
 *
 * @param {string} tier
 * @param {number|undefined} inputTokens
 * @param {number|undefined} outputTokens
 * @returns {{ input: number, output: number, from_defaults: boolean }}
 */
function resolveTokenEstimates(tier, inputTokens, outputTokens) {
  const defaults = DEFAULT_TOKEN_ESTIMATES[tier] || DEFAULT_TOKEN_ESTIMATES.sonnet;
  const input = (typeof inputTokens === 'number' && inputTokens >= 0) ? inputTokens : defaults.input;
  const output = (typeof outputTokens === 'number' && outputTokens >= 0) ? outputTokens : defaults.output;
  const fromDefaults = !(typeof inputTokens === 'number' && typeof outputTokens === 'number');
  return { input, output, from_defaults: fromDefaults };
}

/**
 * Append a single reservation record to cost-reservations.jsonl using the
 * project-standard atomic-append primitive (F05: replaces non-atomic
 * fs.appendFileSync). Creates the parent directory if absent.
 *
 * @param {string} reservationsPath - Absolute path to cost-reservations.jsonl
 * @param {object} record - The reservation record to append
 */
function appendReservation(reservationsPath, record) {
  fs.mkdirSync(path.dirname(reservationsPath), { recursive: true });
  atomicAppendJsonl(reservationsPath, record);
}

/**
 * Scan cost-reservations.jsonl for a record matching the given reservation_id.
 * Returns the parsed record object if found, or null if not found.
 * Fail-open: returns null on any I/O or parse error.
 *
 * @param {string} reservationsPath - Absolute path to cost-reservations.jsonl
 * @param {string} reservationId
 * @returns {object|null}
 */
function findReservationById(reservationsPath, reservationId) {
  let raw;
  try {
    raw = fs.readFileSync(reservationsPath, 'utf8');
  } catch (_e) {
    return null;
  }
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch (_e) { continue; }
    if (row && row.reservation_id === reservationId) return row;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  emitHandlerEntry('cost_budget_reserve', context);
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('cost_budget_reserve: ' + validation.errors.join('; '));
  }

  // Resolve project root
  let projectRoot;
  try {
    if (context && context.projectRoot) {
      projectRoot = context.projectRoot;
    } else {
      const paths = require('../lib/paths');
      projectRoot = paths.getProjectRoot();
    }
  } catch (err) {
    return toolError('cost_budget_reserve: cannot resolve project root');
  }

  const config = (context && context.config) || null;

  const reservationsPath = path.join(projectRoot, RESERVATIONS_FILE);

  // D4 (v2.0.16): opportunistic GC — trim expired rows when the ledger is oversized.
  // Fail-silent: any GC error must not block a reservation write.
  try {
    const stat = fs.statSync(reservationsPath);
    if (stat.size > GC_OPPORTUNISTIC_TRIGGER_BYTES) {
      require('../../_lib/cost-helpers').gcReservations(projectRoot);
    }
  } catch (_e) { /* File absent or stat error — skip GC. */ }

  // --- Resolve pricing / token estimates outside the lock (pure computation) ---

  let table, pricingSource, effortMultipliersConfig;
  try {
    const { loadCostBudgetCheckConfig } = require('../../_lib/config-schema');
    const { resolveSafeCwd } = require('../../_lib/resolve-project-cwd');
    const cwd = resolveSafeCwd(projectRoot);
    const loaded = loadCostBudgetCheckConfig(cwd);
    table = loaded.pricing_table;
    // F21: pass config effort_multipliers so reservation cost matches cost_budget_check cost.
    effortMultipliersConfig = (loaded && loaded.effort_multipliers) || null;
    const hasCbcBlock = config &&
      config.mcp_server &&
      config.mcp_server.cost_budget_check &&
      typeof config.mcp_server.cost_budget_check.pricing_table === 'object';
    pricingSource = hasCbcBlock ? 'config' : 'builtin';
  } catch (_e) {
    // Fall back to config-context or builtin
    const resolved = resolvePricingTable(config);
    table = resolved.table;
    pricingSource = resolved.source;
    effortMultipliersConfig = (config && config.mcp_server &&
      config.mcp_server.cost_budget_check &&
      config.mcp_server.cost_budget_check.effort_multipliers) || null;
  }

  // Resolve model tier
  const tier = resolveModelTier(input.model);

  // Resolve rates — use shared getRatesForTier from cost-helpers (F09: no inline BUILTIN).
  const { getRatesForTier } = require('../../_lib/cost-helpers');
  const rates = getRatesForTier(table, tier);

  // Resolve token estimates
  const { input: inputTokens, output: outputTokens, from_defaults: fromDefaults } =
    resolveTokenEstimates(tier, input.estimated_input_tokens, input.estimated_output_tokens);

  // Compute projected cost with effort multiplier.
  // F21: pass effortMultipliersConfig so config-supplied multipliers are applied
  // (previously passed null, causing divergence from cost_budget_check results).
  const baseCost = computeCost(inputTokens, outputTokens, rates);
  const effortMultiplier = resolveEffortMultiplier(input.effort || null, effortMultipliersConfig);
  const projectedCostUsd = baseCost * effortMultiplier;

  // Build reservation record (before lock — IDs and timestamps are fine outside).
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  // D5: use loadReservationTTLMs(projectRoot) to read configurable TTL from config.
  // Falls back to DEFAULT_RESERVATION_TTL_MS (30 min) when key is absent — preserving
  // existing behaviour for installs that have not set mcp_server.cost_budget_reserve.ttl_minutes.
  const reservationTTLMs = loadReservationTTLMs(projectRoot);
  const expiresAt = new Date(now + reservationTTLMs).toISOString();
  // Use caller-supplied reservation_id when provided for idempotency; otherwise generate one.
  const reservationId = input.reservation_id || ('res-' + crypto.randomBytes(6).toString('hex'));

  const record = {
    reservation_id: reservationId,
    orchestration_id: input.orchestration_id,
    task_id: input.task_id,
    agent_type: input.agent_type,
    model: input.model,
    model_tier: tier,
    effort: input.effort || null,
    effort_multiplier: effortMultiplier,
    projected_cost_usd: projectedCostUsd,
    input_tokens_used: inputTokens,
    output_tokens_used: outputTokens,
    token_estimates_from_defaults: fromDefaults,
    pricing_source: pricingSource,
    created_at: createdAt,
    expires_at: expiresAt,
  };

  // B1: acquire advisory lock for the full idempotency find→append critical section.
  // Without this lock, two concurrent calls with the same reservation_id can both
  // see null from findReservationById (TOCTOU) and both append, violating uniqueness.
  // The lock is keyed to the reservations file so all writers share the same mutex.
  const reservationsLockPath = reservationsPath + '.lock';
  let writeErr = null;
  let existingRecord = null;
  const lockOutcome = _withAdvisoryLock(reservationsLockPath, () => {
    // Re-check idempotency inside the lock (F04 + B1).
    if (input.reservation_id) {
      const existing = findReservationById(reservationsPath, input.reservation_id);
      if (existing) {
        existingRecord = existing;
        return 'found';
      }
    }
    // Append to reservations file (F05: atomicAppendJsonl via appendReservation).
    try {
      appendReservation(reservationsPath, record);
    } catch (err) {
      writeErr = err;
    }
    return 'appended';
  });

  if (lockOutcome && lockOutcome.skipped) {
    // Lock contention — do NOT append outside the lock: an unlocked append here
    // would reintroduce the B1 reservation_id TOCTOU (two concurrent same-id
    // calls could both skip and both append, violating uniqueness). Surface
    // contention to the caller instead; the reservation is safely retryable.
    return toolError(
      'cost_budget_reserve: reservation lock contention — another orchestray ' +
      'process is writing cost-reservations.jsonl; retry the reservation'
    );
  }

  if (existingRecord) {
    return toolSuccess({
      reservation_id: existingRecord.reservation_id,
      orchestration_id: existingRecord.orchestration_id,
      task_id: existingRecord.task_id,
      agent_type: existingRecord.agent_type,
      model: existingRecord.model,
      model_tier: existingRecord.model_tier,
      effort: existingRecord.effort || null,
      projected_cost_usd: existingRecord.projected_cost_usd,
      pricing_source: existingRecord.pricing_source,
      token_estimates_from_defaults: existingRecord.token_estimates_from_defaults,
      created_at: existingRecord.created_at,
      expires_at: existingRecord.expires_at,
    });
  }

  if (writeErr) {
    return toolError(
      'cost_budget_reserve: failed to write reservation: ' +
      (writeErr && writeErr.message ? writeErr.message : String(writeErr))
    );
  }

  return toolSuccess({
    reservation_id: reservationId,
    orchestration_id: input.orchestration_id,
    task_id: input.task_id,
    agent_type: input.agent_type,
    model: input.model,
    model_tier: tier,
    effort: input.effort || null,
    projected_cost_usd: projectedCostUsd,
    pricing_source: pricingSource,
    token_estimates_from_defaults: fromDefaults,
    created_at: createdAt,
    expires_at: expiresAt,
  });
}

module.exports = {
  definition,
  handle,
};
