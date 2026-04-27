'use strict';

/**
 * output-shape.js — P1.2 Output Shape Pipeline decision module (v2.2.0).
 *
 * Maps every non-PM agent role to one of four output-shape categories
 * (`structured-only`, `hybrid`, `prose-heavy`, `none`) and returns the
 * P1.2 levers to inject at delegation time:
 *
 *   - `caveman_text`         — the 85-token smart-caveman addendum
 *   - `output_config_format` — Anthropic structured-output JSON-schema
 *   - `length_cap`           — output-token cap from p95 calibration
 *
 * Single source of truth for category assignment (`ROLE_CATEGORY_MAP`)
 * and the verbatim caveman literal (`CAVEMAN_TEXT`). Drift from the
 * agent frontmatter `output_shape:` declarations is detected by the
 * `kb-refs-sweep` test extension.
 *
 * Length caps source from `bin/calibrate-role-budgets.js` p95 telemetry
 * via the operator-emitted cache file
 * `.orchestray/state/role-budgets.json`. Cache miss falls back to
 * model-tier defaults (haiku 30K / sonnet 50K / opus 80K). The fallback
 * is recorded in the `reason` field for telemetry diagnostics.
 *
 * Caveman applies ONLY to the prose body. The Structured Result JSON
 * block, code fences, and tool-call payloads are exempt — see
 * `bin/_lib/proposal-validator.js` for the runtime contract.
 *
 * Structured-output enforcement (`output_config.format`) is gated to
 * the `staged_flip_allowlist` config field. v2.2.0 shipped with
 * researcher + tester only; v2.2.3 P3-W1 (A4) expands the allowlist to
 * include all 8 hybrid roles (developer, debugger, reviewer, architect,
 * documenter, refactorer, inventor, release-manager). Hybrid roles
 * receive a SHARED `HYBRID_ROLE_SCHEMA` matching the universal
 * Handoff Contract (§2 of agents/pm-reference/handoff-contract.md);
 * role-specific optional fields (per §4) survive via
 * `additionalProperties: true`.
 *
 * Public API: { decideShape, CAVEMAN_TEXT, ROLE_CATEGORY_MAP, getRoleLengthCap }
 */

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// CAVEMAN_TEXT — verbatim 85-token literal from W2 §3.3 (Kuba Guzik benchmark,
// Apr 2026; -21% Opus output / -14% Sonnet output, 100% accuracy retained).
// DO NOT paraphrase or "clean up" — the benchmark measured THIS exact literal.
//
// SECURITY / CACHE CONTRACT: this literal is byte-pinned by
// `bin/__tests__/p12-caveman-prose-body-only.test.js`. CI fails on drift.
// CAVEMAN_TEXT is interpolated into the spawn prompt via the PM's step 9.7
// (declared in agents/pm.md, which IS a Zone-1 input via the dynamic
// prefix-drift hash at bin/cache-prefix-lock.js); editing this literal in
// isolation does NOT invalidate the prefix-cache by itself, so the byte-pin
// test is the gate — never deviate without updating the test fixture in the
// same commit.
// ---------------------------------------------------------------------------

const CAVEMAN_TEXT = [
  'Respond like smart caveman. Cut all filler, keep technical substance.',
  '',
  'Drop articles (a, an, the), filler (just, really, basically, actually).',
  'Drop pleasantries (sure, certainly, happy to).',
  'No hedging. Fragments fine. Short synonyms.',
  'Technical terms stay exact. Code blocks unchanged.',
  'Pattern: [thing] [action] [reason]. [next step].',
].join('\n');

// ---------------------------------------------------------------------------
// ROLE_CATEGORY_MAP — single source of truth for category assignment.
// Mirrors §1 of `.orchestray/kb/artifacts/v220-impl-p12-design.md` verbatim.
// The 14 listed agent files each receive an `output_shape:` frontmatter line
// that MUST equal the value here; CI drift-detector enforces.
// ---------------------------------------------------------------------------

const ROLE_CATEGORY_MAP = Object.freeze({
  // structured-only — entire output is the schema (canary roles for v2.2.0)
  'researcher':         'structured-only',
  'tester':             'structured-only',
  // hybrid — prose body + Structured Result JSON; caveman + cap from day-1
  'developer':          'hybrid',
  'debugger':           'hybrid',
  'reviewer':           'hybrid',
  'architect':          'hybrid',
  'documenter':         'hybrid',
  'refactorer':         'hybrid',
  'inventor':           'hybrid',
  'release-manager':    'hybrid',
  // prose-heavy — long narrative artifact, no structured-output flip
  'security-engineer':  'prose-heavy',
  'ux-critic':          'prose-heavy',
  // none — formats are load-bearing (URLs, locked Haiku block); no compression
  'platform-oracle':    'none',
  'project-intent':     'none',
});

// Excluded roles (return null from decideShape):
//   pm                       — composes the fragment, never receives it
//   haiku-scout              — I/O wrapper, output is verbatim payload
//   orchestray-housekeeper   — frontmatter byte-frozen by D-5 hardening
//   pattern-extractor        — internal Haiku helper, schema already constrained

const EXCLUDED_ROLES = new Set([
  'pm',
  'haiku-scout',
  'orchestray-housekeeper',
  'pattern-extractor',
]);

// ---------------------------------------------------------------------------
// Model-tier fallback for thin telemetry (mirrors
// `bin/calibrate-role-budgets.js:97-101` MODEL_TIER_DEFAULTS).
// ---------------------------------------------------------------------------

const MODEL_TIER_DEFAULTS = Object.freeze({
  haiku:  30000,
  sonnet: 50000,
  opus:   80000,
});

const ROLE_MODEL_TIER = Object.freeze({
  'pm':                'opus',
  'architect':         'opus',
  'developer':         'sonnet',
  'refactorer':        'sonnet',
  'reviewer':          'sonnet',
  'debugger':          'sonnet',
  'tester':            'sonnet',
  'documenter':        'sonnet',
  'inventor':          'opus',
  'researcher':        'sonnet',
  'security-engineer': 'sonnet',
  'release-manager':   'sonnet',
  'ux-critic':         'sonnet',
  'project-intent':    'haiku',
  'platform-oracle':   'sonnet',
});

// ---------------------------------------------------------------------------
// Per-role JSON schemas for structured-only roles. Inlined as JS objects so
// there is no runtime dependency on agent-common-protocol.md parsing.
// Schemas are additive (`additionalProperties: true`) per Open Question #2 —
// strict mode would make any future contract addition a breaking change.
// The T15 hook remains the enforcer of required-field shape; this schema is
// the no-narration-tokens enforcer.
// ---------------------------------------------------------------------------

const RESEARCHER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['status', 'summary', 'files_changed', 'files_read', 'issues', 'assumptions', 'research_summary'],
  properties: {
    status:        { type: 'string', enum: ['success', 'partial', 'failure'] },
    summary:       { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    files_read:    { type: 'array', items: { type: 'string' } },
    issues:        { type: 'array' },
    assumptions:   { type: 'array', items: { type: 'string' } },
    research_summary: {
      type: 'object',
      additionalProperties: true,
      required: ['goal', 'candidates_surveyed', 'verdict', 'top_pick', 'artifact_location', 'next_agent_hint'],
      properties: {
        goal:                { type: 'string' },
        candidates_surveyed: { type: 'integer', minimum: 3, maximum: 7 },
        verdict:             { type: 'string', enum: ['recommend_existing', 'recommend_build_custom', 'no_clear_fit', 'inconclusive'] },
        top_pick:            { type: ['string', 'null'] },
        artifact_location:   { type: 'string' },
        next_agent_hint:     { type: 'string', enum: ['architect', 'inventor', 'debugger', 'stop'] },
      },
    },
  },
});

const TESTER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['status', 'summary', 'files_changed', 'files_read', 'issues', 'assumptions', 'test_summary'],
  properties: {
    status:        { type: 'string', enum: ['success', 'partial', 'failure'] },
    summary:       { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    files_read:    { type: 'array', items: { type: 'string' } },
    issues:        { type: 'array' },
    assumptions:   { type: 'array', items: { type: 'string' } },
    test_summary: {
      type: 'object',
      additionalProperties: true,
      required: ['tests_added', 'tests_modified', 'coverage_gaps_remaining'],
      properties: {
        tests_added:             { type: 'integer', minimum: 0 },
        tests_modified:          { type: 'integer', minimum: 0 },
        coverage_gaps_remaining: { type: 'array', items: { type: 'string' } },
      },
    },
  },
});

// ---------------------------------------------------------------------------
// HYBRID_ROLE_SCHEMA — shared schema for the 8 hybrid roles (v2.2.3 P3-W1 A4).
// Mirrors the universal Handoff Contract §2 required-field set
// (agents/pm-reference/handoff-contract.md and HANDOFF_REQUIRED_SECTIONS in
// bin/_lib/handoff-contract-text.js). One schema covers all 8 hybrids; per-role
// optional fields documented in handoff-contract.md §4 (e.g.
// architect.design_decisions, developer.tests_passing,
// reviewer.verdict, refactorer.behavior_preserved, release-manager.version_bumped)
// pass through via `additionalProperties: true`. Authoring 8 distinct schemas
// would over-constrain the wide variance in role-specific extensions and
// turn every contract addition into a breaking change.
// ---------------------------------------------------------------------------

const HYBRID_ROLE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: true,
  required: ['status', 'summary', 'files_changed', 'files_read', 'issues', 'assumptions'],
  properties: {
    status:        { type: 'string', enum: ['success', 'partial', 'failure'] },
    summary:       { type: 'string' },
    files_changed: { type: 'array' },
    files_read:    { type: 'array', items: { type: 'string' } },
    issues:        { type: 'array' },
    assumptions:   { type: 'array', items: { type: 'string' } },
  },
});

const ROLE_SCHEMA_MAP = Object.freeze({
  'researcher':      RESEARCHER_SCHEMA,
  'tester':          TESTER_SCHEMA,
  // v2.2.3 P3-W1 A4: the 8 hybrid roles share HYBRID_ROLE_SCHEMA. Reusing one
  // schema keeps the allowlist additive — adding a 9th hybrid role only needs
  // a ROLE_CATEGORY_MAP + staged_flip_allowlist entry.
  'developer':       HYBRID_ROLE_SCHEMA,
  'debugger':        HYBRID_ROLE_SCHEMA,
  'reviewer':        HYBRID_ROLE_SCHEMA,
  'architect':       HYBRID_ROLE_SCHEMA,
  'documenter':      HYBRID_ROLE_SCHEMA,
  'refactorer':      HYBRID_ROLE_SCHEMA,
  'inventor':        HYBRID_ROLE_SCHEMA,
  'release-manager': HYBRID_ROLE_SCHEMA,
});

// ---------------------------------------------------------------------------
// Default config (mirrors bin/_lib/config-schema.js OUTPUT_SHAPE_DEFAULTS;
// kept inline so this module remains self-contained for unit testing).
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT_SHAPE_CONFIG = Object.freeze({
  enabled:                    true,
  caveman_enabled:            true,
  structured_outputs_enabled: true,
  length_cap_enabled:         true,
  // v2.2.3 P3-W1 A4: expanded from ['researcher','tester'] to include all
  // 8 hybrid roles. v2.2.0–v2.2.2 telemetry confirmed zero T15 rejection on
  // the canary roles. Hybrid roles share HYBRID_ROLE_SCHEMA above.
  staged_flip_allowlist:      [
    'researcher', 'tester',
    'developer', 'debugger', 'reviewer', 'architect',
    'documenter', 'refactorer', 'inventor', 'release-manager',
  ],
});

// ---------------------------------------------------------------------------
// getRoleLengthCap — sources length caps from operator-emitted p95 cache,
// falls back to model-tier default on cache miss.
//
// Cache file: <cwd>/.orchestray/state/role-budgets.json
// Cache schemas (both supported — cache writer is
// `bin/calibrate-role-budgets.js` which historically writes the
// `role_budgets` form; the `--emit-cache` extension writes the flat form):
//
//   Flat form:    { "<role>": { "p95": <integer>, ... }, ... }
//   Wrapped form: { "role_budgets": { "<role>": { "budget_tokens": <int>, ... } }, ... }
//
// On hit, prefers `p95` over `budget_tokens` (p95 is the truer signal).
// Cache miss → model-tier default (haiku 30K / sonnet 50K / opus 80K).
// ---------------------------------------------------------------------------

function getRoleLengthCap(role, opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();
  const cachePath = path.join(cwd, '.orchestray', 'state', 'role-budgets.json');

  let cache = null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    cache = JSON.parse(raw);
  } catch (_e) {
    cache = null;
  }

  if (cache && typeof cache === 'object') {
    // Flat form: cache[role].p95
    if (cache[role] && typeof cache[role] === 'object') {
      if (typeof cache[role].p95 === 'number') {
        return { cap: cache[role].p95, source: 'p95_cache' };
      }
      if (typeof cache[role].budget_tokens === 'number') {
        return { cap: cache[role].budget_tokens, source: 'budget_tokens_cache' };
      }
    }
    // Wrapped form: cache.role_budgets[role].{p95|budget_tokens}
    if (cache.role_budgets && typeof cache.role_budgets === 'object' && cache.role_budgets[role]) {
      const entry = cache.role_budgets[role];
      if (entry && typeof entry === 'object') {
        if (typeof entry.p95 === 'number') {
          return { cap: entry.p95, source: 'p95_cache' };
        }
        if (typeof entry.budget_tokens === 'number') {
          return { cap: entry.budget_tokens, source: 'budget_tokens_cache' };
        }
      }
    }
  }

  const tier = ROLE_MODEL_TIER[role] || 'sonnet';
  const fallback = MODEL_TIER_DEFAULTS[tier];
  return { cap: fallback, source: 'tier_default' };
}

// ---------------------------------------------------------------------------
// _loadConfig — reads .orchestray/config.json for output_shape block; merges
// over DEFAULT_OUTPUT_SHAPE_CONFIG. Fail-open: any error returns defaults.
// ---------------------------------------------------------------------------

function _loadConfig(cwd) {
  const configPath = path.join(cwd, '.orchestray', 'config.json');
  let parsed;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (_e) {
    return Object.assign({}, DEFAULT_OUTPUT_SHAPE_CONFIG);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return Object.assign({}, DEFAULT_OUTPUT_SHAPE_CONFIG);
  }
  const fromFile = parsed.output_shape;
  if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return Object.assign({}, DEFAULT_OUTPUT_SHAPE_CONFIG);
  }
  return Object.assign({}, DEFAULT_OUTPUT_SHAPE_CONFIG, fromFile);
}

// ---------------------------------------------------------------------------
// decideShape — primary entry point.
//
// @param {string} agentRole — canonical role name.
// @param {object} [opts]
// @param {object} [opts.config] — pre-loaded config; if absent, loaded from
//                                 .orchestray/config.json under opts.cwd.
// @param {string} [opts.cwd]    — project root (defaults to process.cwd()).
//
// @returns {{
//   category:             "structured-only"|"hybrid"|"prose-heavy"|"none",
//   caveman_text:         string|null,
//   output_config_format: object|null,
//   length_cap:           number|null,
//   reason:               string,
// } | null}
//
// Returns null when:
//   - agentRole is unknown AND not explicitly excluded
//   - agentRole is in EXCLUDED_ROLES
// Returns category="none" with all levers null when output_shape.enabled=false.
// ---------------------------------------------------------------------------

function decideShape(agentRole, opts) {
  opts = opts || {};
  const cwd = opts.cwd || process.cwd();

  if (typeof agentRole !== 'string' || agentRole.length === 0) return null;
  if (EXCLUDED_ROLES.has(agentRole)) return null;

  const category = ROLE_CATEGORY_MAP[agentRole];
  if (!category) return null;

  // Resolve config — caller-supplied wins, else read from disk.
  const cfgFromOpts = opts.config && typeof opts.config === 'object' ? opts.config : null;
  let config;
  if (cfgFromOpts && cfgFromOpts.output_shape && typeof cfgFromOpts.output_shape === 'object') {
    config = Object.assign({}, DEFAULT_OUTPUT_SHAPE_CONFIG, cfgFromOpts.output_shape);
  } else if (cfgFromOpts && Object.prototype.hasOwnProperty.call(cfgFromOpts, 'enabled')) {
    // Direct output_shape block passed.
    config = Object.assign({}, DEFAULT_OUTPUT_SHAPE_CONFIG, cfgFromOpts);
  } else {
    config = _loadConfig(cwd);
  }

  // Master kill switch.
  if (config.enabled !== true) {
    return {
      category: 'none',
      caveman_text: null,
      output_config_format: null,
      length_cap: null,
      reason: 'kill_switch=output_shape.enabled=false',
    };
  }

  // category=none — no levers fire (still returns a shape so PM telemetry
  // can record the intentional opt-out).
  if (category === 'none') {
    return {
      category: 'none',
      caveman_text: null,
      output_config_format: null,
      length_cap: null,
      reason: 'category=none',
    };
  }

  const reasonParts = [];
  let cavemanText        = null;
  let outputConfigFormat = null;
  let lengthCap          = null;

  // -- Caveman lever --------------------------------------------------------
  if (category === 'hybrid' || category === 'prose-heavy') {
    if (config.caveman_enabled !== false) {
      cavemanText = CAVEMAN_TEXT;
      reasonParts.push('caveman=on');
    } else {
      reasonParts.push('caveman=off_disabled');
    }
  } else {
    // structured-only never gets caveman (output IS the schema)
    reasonParts.push('caveman=off_structured-only');
  }

  // -- Length cap lever -----------------------------------------------------
  if (category === 'hybrid' || category === 'prose-heavy') {
    if (config.length_cap_enabled !== false) {
      const capInfo = getRoleLengthCap(agentRole, { cwd });
      lengthCap = capInfo.cap;
      reasonParts.push('length_cap=' + capInfo.source);
    } else {
      reasonParts.push('length_cap=off_disabled');
    }
  } else {
    // structured-only is exempt — schema bounds output naturally
    reasonParts.push('length_cap=off_structured-only');
  }

  // -- Structured outputs lever ---------------------------------------------
  if (category === 'structured-only' || category === 'hybrid') {
    if (config.structured_outputs_enabled === true) {
      const allowlist = Array.isArray(config.staged_flip_allowlist)
        ? config.staged_flip_allowlist
        : DEFAULT_OUTPUT_SHAPE_CONFIG.staged_flip_allowlist;
      if (allowlist.indexOf(agentRole) !== -1) {
        const schema = ROLE_SCHEMA_MAP[agentRole] || null;
        if (schema) {
          outputConfigFormat = schema;
          reasonParts.push('structured=on');
        } else {
          reasonParts.push('structured=staged_off_no_schema');
        }
      } else {
        reasonParts.push('structured=staged_off');
      }
    } else {
      reasonParts.push('structured=off_disabled');
    }
  } else {
    reasonParts.push('structured=off_prose-heavy');
  }

  return {
    category: category,
    caveman_text: cavemanText,
    output_config_format: outputConfigFormat,
    length_cap: lengthCap,
    reason: reasonParts.join(','),
  };
}

module.exports = {
  decideShape,
  CAVEMAN_TEXT,
  ROLE_CATEGORY_MAP,
  EXCLUDED_ROLES,
  ROLE_SCHEMA_MAP,
  HYBRID_ROLE_SCHEMA,
  MODEL_TIER_DEFAULTS,
  ROLE_MODEL_TIER,
  DEFAULT_OUTPUT_SHAPE_CONFIG,
  getRoleLengthCap,
};
