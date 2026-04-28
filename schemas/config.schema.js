'use strict';

/**
 * schemas/config.schema.js — zod schema for `.orchestray/config.json`.
 *
 * v2.1.13 R-ZOD. Validates the top-level shape and types of the known sections
 * of `.orchestray/config.json`. Unknown TOP-LEVEL keys pass through so that
 * R-CONFIG-DRIFT (v2.1.13 W9, runs after this schema) can emit "did you mean…?"
 * suggestions instead of this schema failing the boot.
 *
 * Sub-sections use `.passthrough()` on nested objects for the same reason:
 * historical configs may contain extra keys we don't want to reject at boot.
 *
 * The shape mirrors `bin/_lib/config-schema.js` (~3,280 lines of ad-hoc
 * validation) but is a single, declarative, self-describing schema. Per the
 * v2.1.13 plan §2 R-ZOD AC: "reverting to v2.1.x ad-hoc validation is not
 * supported" — the zod check is now authoritative for boot-time type
 * correctness.
 *
 * NOTE on shape choices:
 *   - numbers that are logically "ids / small naturals / booleans in disguise"
 *     are typed `z.number()` rather than `z.number().int()` where the existing
 *     ad-hoc validator accepted any number (to preserve back-compat on shipped
 *     configs).
 *   - nullable settings that tolerate `null` as "unset" use `.nullable()`.
 *   - optional top-level keys use `.optional()` so a partial config is valid.
 */

// Inline rationale (per v2.1.13 plan AC): the prior ad-hoc section validators
// in bin/_lib/config-schema.js ran fail-open per-section and never enforced
// type invariants at boot — so a misspelled or mis-typed key would silently
// fall back to defaults. A declarative schema gives us one source of truth
// and a loud boot failure on malformed input. The validator runtime is a
// handwritten ~250-line module (schemas/_validator.js) rather than zod:
// zod's on-disk footprint was ~5 MB, 20x over the v2.1.13 install-size budget.
const { z } = require('./_validator');

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const modelAlias = z.enum(['haiku', 'sonnet', 'opus', 'inherit']);
const effortLevel = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

// mcp_enforcement per-tool policy values (see bin/_lib/config-schema.js
// VALID_PER_TOOL_VALUES)
const perToolPolicy = z.enum(['hook', 'hook-warn', 'hook-strict', 'prompt', 'allow']);
const unknownToolPolicy = z.enum(['block', 'warn', 'allow']);

// ---------------------------------------------------------------------------
// mcp_server
// ---------------------------------------------------------------------------

const askUserToolSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean().optional(),
    max_per_task: z.number().int().min(0).optional(),
    default_timeout_seconds: z.number().int().min(1).optional(),
  }).passthrough(),
]);

const mcpServerSchema = z.object({
  enabled: z.boolean().optional(),
  tools: z.object({
    pattern_find: z.boolean().optional(),
    pattern_record_application: z.boolean().optional(),
    pattern_record_skip_reason: z.boolean().optional(),
    cost_budget_check: z.boolean().optional(),
    history_query_events: z.boolean().optional(),
    history_find_similar_tasks: z.boolean().optional(),
    kb_search: z.boolean().optional(),
    ask_user: askUserToolSchema.optional(),
    kb_write: z.boolean().optional(),
    routing_lookup: z.boolean().optional(),
    cost_budget_reserve: z.boolean().optional(),
    pattern_deprecate: z.boolean().optional(),
    metrics_query: z.boolean().optional(),
    spawn_agent: z.boolean().optional(),
  }).passthrough().optional(),
  cost_budget_check: z.object({
    pricing_table: z.record(
      z.string(),
      z.object({
        input_per_1m: z.number().min(0),
        output_per_1m: z.number().min(0),
      }).passthrough()
    ).optional(),
    last_verified: z.string().nullable().optional(),
    effort_multipliers: z.record(z.string(), z.number()).nullable().optional(),
  }).passthrough().optional(),
  max_per_task: z.record(
    z.string(),
    z.union([
      z.number().int().min(0),
      z.object({
        enabled: z.boolean().optional(),
        max: z.number().int().min(0).optional(),
        default: z.number().int().min(0).optional(),
      }).passthrough(),
    ])
  ).optional(),
  cost_budget_reserve: z.object({
    ttl_minutes: z.number().int().min(1).max(1440).optional(),
  }).passthrough().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Top-level section schemas
// ---------------------------------------------------------------------------

const mcpEnforcementSchema = z.object({
  pattern_find: perToolPolicy.optional(),
  kb_search: perToolPolicy.optional(),
  history_find_similar_tasks: perToolPolicy.optional(),
  pattern_record_application: perToolPolicy.optional(),
  pattern_record_skip_reason: perToolPolicy.optional(),
  cost_budget_check: perToolPolicy.optional(),
  kb_write: perToolPolicy.optional(),
  routing_lookup: perToolPolicy.optional(),
  cost_budget_reserve: perToolPolicy.optional(),
  pattern_deprecate: perToolPolicy.optional(),
  metrics_query: perToolPolicy.optional(),
  unknown_tool_policy: unknownToolPolicy.optional(),
  global_kill_switch: z.boolean().optional(),
  // Required (non-empty string) when global_kill_switch is true — checked by
  // the .refine() below so we can produce a targeted error message.
  kill_switch_reason: z.string().optional(),
}).passthrough().refine(
  (v) => {
    if (v.global_kill_switch !== true) return true;
    return typeof v.kill_switch_reason === 'string' && v.kill_switch_reason.trim().length > 0;
  },
  {
    message: 'mcp_enforcement.kill_switch_reason is required (non-empty string) when global_kill_switch is true',
    path: ['kill_switch_reason'],
  }
);

const costBudgetEnforcementSchema = z.object({
  enabled: z.boolean().optional(),
  hard_block: z.boolean().optional(),
}).passthrough();

const routingGateSchema = z.object({
  auto_seed_on_miss: z.boolean().optional(),
}).passthrough();

const v2017ExperimentsSchema = z.object({
  __schema_version: z.number().int().optional(),
  global_kill_switch: z.boolean().optional(),
  prompt_caching: z.enum(['on', 'off']).optional(),
  adaptive_verbosity: z.enum(['on', 'off']).optional(),
}).passthrough();

const cacheChoreographySchema = z.object({
  pre_commit_guard_enabled: z.boolean().optional(),
  drift_warn_threshold_hex_changes: z.number().int().min(0).optional(),
}).passthrough();

const adaptiveVerbositySchema = z.object({
  enabled: z.boolean().optional(),
  base_response_tokens: z.number().int().min(0).optional(),
  reducer_on_late_phase: z.number().min(0).max(1).optional(),
}).passthrough();

const patternDecaySchema = z.object({
  default_half_life_days: z.number().min(0).optional(),
  category_overrides: z.record(z.string(), z.number().min(0)).optional(),
}).passthrough();

const antiPatternGateSchema = z.object({
  enabled: z.boolean().optional(),
  min_decayed_confidence: z.number().min(0).max(1).optional(),
  max_advisories_per_spawn: z.number().int().min(1).optional(),
}).passthrough();

const stateSentinelSchema = z.object({
  pause_check_enabled: z.boolean().optional(),
  cancel_grace_seconds: z.number().int().min(0).max(3600).optional(),
}).passthrough();

const redoFlowSchema = z.object({
  max_cascade_depth: z.number().int().min(1).optional(),
  commit_prefix: z.string().optional(),
}).passthrough();

const contextStatusbarSchema = z.object({
  enabled: z.boolean().optional(),
  unicode: z.boolean().optional(),
  color: z.boolean().optional(),
  width_cap: z.number().int().min(20).optional(),
  pressure_thresholds: z.object({
    warn: z.number().min(0).max(100).optional(),
    critical: z.number().min(0).max(100).optional(),
  }).passthrough().optional(),
}).passthrough();

const federationSchema = z.object({
  shared_dir_enabled: z.boolean().optional(),
  sensitivity: z.enum(['private', 'shareable', 'public']).optional(),
  shared_dir_path: z.string().optional(),
}).passthrough();

const retrievalSchema = z.object({
  scorer_variant: z.enum(['baseline', 'skip-down', 'local-success', 'composite']).optional(),
  shadow_scorers: z.array(z.string()).optional(),
  global_kill_switch: z.boolean().optional(),
  top_k: z.number().int().min(1).optional(),
  jsonl_max_bytes: z.number().int().min(0).optional(),
  jsonl_max_generations: z.number().int().min(1).optional(),
  // v2.1.13 R-RET-EXPAND: synonyms kill-switch (forward-compat — the key may
  // not yet be present in v2.1.12 installs).
  synonyms_enabled: z.boolean().optional(),
}).passthrough();

const autoLearningExtractOnCompleteSchema = z.object({
  enabled: z.boolean().optional(),
  shadow_mode: z.boolean().optional(),
  proposals_per_orchestration: z.number().int().min(1).max(10).optional(),
  proposals_per_24h: z.number().int().min(1).max(50).optional(),
  backend: z.enum(['haiku-cli', 'stub']).optional(),
  timeout_ms: z.number().int().min(5_000).max(300_000).optional(),
  max_output_bytes: z.number().int().min(1024).max(1_048_576).optional(),
}).passthrough();

const autoLearningSafetySchema = z.object({
  circuit_breaker: z.object({
    max_extractions_per_24h: z.number().int().min(1).max(100).optional(),
    cooldown_minutes_on_trip: z.number().int().min(5).max(1440).optional(),
  }).passthrough().optional(),
}).passthrough();

const autoLearningSchema = z.object({
  global_kill_switch: z.boolean().optional(),
  extract_on_complete: autoLearningExtractOnCompleteSchema.optional(),
  roi_aggregator: z.object({
    enabled: z.boolean().optional(),
    min_days_between_runs: z.number().int().min(1).max(90).optional(),
    lookback_days: z.number().int().min(1).max(365).optional(),
  }).passthrough().optional(),
  kb_refs_sweep: z.object({
    enabled: z.boolean().optional(),
    min_days_between_runs: z.number().int().min(1).max(90).optional(),
  }).passthrough().optional(),
  safety: autoLearningSafetySchema.optional(),
}).passthrough();

const contextCompressionSchema = z.object({
  enabled: z.boolean().optional(),
  cite_cache: z.boolean().optional(),
  spec_sketch: z.boolean().optional(),
  repo_map_delta: z.boolean().optional(),
  archetype_cache: z.object({
    enabled: z.boolean().optional(),
    min_prior_applications: z.number().int().min(0).optional(),
    confidence_floor: z.number().min(0).max(1).optional(),
    max_entries: z.number().int().min(0).optional(),
    ttl_days: z.number().int().min(0).optional(),
    blacklist: z.array(z.string()).optional(),
  }).passthrough().optional(),
}).passthrough();

const resilienceSchema = z.object({
  enabled: z.boolean().optional(),
  shadow_mode: z.boolean().optional(),
  kill_switch: z.boolean().optional(),
  inject_max_bytes: z.number().int().min(512).max(32768).optional(),
  max_inject_turns: z.number().int().min(1).max(10).optional(),
}).passthrough();

const curatorSchema = z.object({
  enabled: z.boolean().optional(),
  self_escalation_enabled: z.boolean().optional(),
  pm_recommendation_enabled: z.boolean().optional(),
  tombstone_retention_runs: z.number().int().min(1).optional(),
  diff_enabled: z.boolean().optional(),
  diff_cutoff_days: z.number().int().min(1).optional(),
  diff_forced_full_every: z.number().int().min(1).optional(),
}).passthrough();

const auditSchema = z.object({
  max_events_bytes_for_scan: z.number().int().positive().nullable().optional(),
}).passthrough();

const shieldSchema = z.object({
  r14_dedup_reads: z.object({
    enabled: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

// R-CONFIG-DRIFT (v2.1.13 W9) reserved key — listed so zod tolerates it today.
const configDriftSilenceSchema = z.array(z.string());

// R-AT-FLAG (v2.1.16): namespaced agent_teams block. Supersedes the top-level
// `enable_agent_teams` boolean (kept for one release as a deprecated fallback).
const agentTeamsSchema = z.object({
  enabled: z.boolean().optional(),
}).passthrough();

// v2.2.8 Item 5 (L): reactive worker-initiated agent spawning. Ships default-on.
// Kill switches: ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1 (env) or enabled: false.
// per_orchestration_quota: max reactive spawns per orchestration run (default 5).
// auto_approve_threshold_pct: fraction of remaining budget for auto-approve (default 0.20).
// max_depth: max spawn chain depth — 1 means only top-level workers can spawn, etc. (default 2).
const reactiveSpawnSchema = z.object({
  enabled: z.boolean().optional(),
  auto_approve_threshold_pct: z.number().min(0).max(1).optional(),
  max_depth: z.number().int().min(1).optional(),
  per_orchestration_quota: z.number().int().min(1).optional(),
}).passthrough();

// v2.2.9 B-7.1 (W1 F-PM-18): Agent() maxTurns hard cap. Mechanises the
// prose-only base_turns table at pm.md:872-885. The hook
// (bin/gate-agent-spawn.js) blocks any spawn whose maxTurns parameter
// exceeds `max_turns_hard_cap` and emits `agent_max_turns_violation`.
// Operator override: raise the cap in config (no env kill switch — per-call
// permission is the only escape hatch).
const spawnSchema = z.object({
  max_turns_hard_cap: z.number().int().min(1).optional(),
}).passthrough();

// v2.2.9 B-7.2 (W1 F-PM-11, F-PM-19): repo-map drift validator. Numeric
// thresholds documented in pm.md / phase-*.md prose are scanned and
// compared against `max_size_kb`; any drift emits
// `repo_map_threshold_drift`. v2.2.9 ships in shadow-mode (warn-only);
// v2.2.10 will flip `shadow_mode` to false. Distinct from the existing
// `repo_map` block which owns languages/cache_dir/cold_init_async.
const repoMapThresholdsSchema = z.object({
  max_size_kb: z.number().int().min(1).optional(),
  shadow_mode: z.boolean().optional(),
}).passthrough();

// R-PHASE-INJ (v2.1.16): phase-slice loader knobs. F-004 (W12-fix) added the
// `telemetry_enabled` documented kill switch declared in
// bin/inject-active-phase-slice.js. Schema is passthrough so older configs
// with extra keys don't fail validation.
const phaseSliceLoadingSchema = z.object({
  enabled: z.boolean().optional(),
  telemetry_enabled: z.boolean().optional(),
}).passthrough();

// R-RV-DIMS (v2.1.16): reviewer-dimension scoping kill switch. F-002 (W12-fix)
// added to KNOWN_TOP_LEVEL_KEYS; schema declaration mirrors that for the
// cross-ref test in tests/unit/config-drift.test.js.
const reviewDimensionScopingSchema = z.object({
  enabled: z.boolean().optional(),
}).passthrough();

// R-AIDER-FULL (v2.1.17 W8): Aider-style tree-sitter + PageRank repo-map.
// Top-level kill switch (`enabled: false`), language opt-out, cache-dir
// override, and async cold-init knob. Mirrors KNOWN_TOP_LEVEL_KEYS entry in
// bin/_lib/config-drift.js so the bidirectional cross-ref test stays green.
const repoMapSchema = z.object({
  enabled:         z.boolean().optional(),
  languages:       z.array(z.enum(['js', 'ts', 'py', 'go', 'rs', 'sh'])).optional(),
  cache_dir:       z.string().optional(),
  cold_init_async: z.boolean().optional(),
}).passthrough();

// v2.2.0 P2.1: Block-Z + engineered-breakpoint manifest. Top-level `caching`
// block with two sub-sections (`block_z`, `engineered_breakpoints`). Both
// ship default-on; kill switches are env vars (ORCHESTRAY_DISABLE_BLOCK_Z=1,
// ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS=1) and the per-section
// `enabled: false`. Schema mirrors KNOWN_TOP_LEVEL_KEYS entry in
// bin/_lib/config-drift.js for the bidirectional cross-ref test (S-004).
const cachingSchema = z.object({
  block_z: z.object({
    enabled: z.boolean().optional(),
  }).passthrough().optional(),
  engineered_breakpoints: z.object({
    enabled: z.boolean().optional(),
    strict_invariant: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

// v2.2.0 P2.2: Haiku scout for PM I/O. Top-level `haiku_routing` block.
// Default-on; per-session kill switch is ORCHESTRAY_HAIKU_ROUTING_DISABLED=1.
// Mirrors KNOWN_TOP_LEVEL_KEYS for the cross-ref test (S-004).
const haikuRoutingSchema = z.object({
  enabled:             z.boolean().optional(),
  scout_min_bytes:     z.number().int().min(1).optional(),
  scout_blocked_ops:   z.array(z.string()).optional(),
  scout_blocked_paths: z.array(z.string()).optional(),
}).passthrough();

// v2.2.0 P1.3 + P3.2: top-level `pm_protocol` block. Holds the chunked
// tier-2 index switch (P1.3) and the delegation-delta switch (P3.2).
// Both ship default-on; per-section `enabled: false` is the kill switch.
// F-001 (v2.2.0 pre-ship cross-phase fix-pass): mirrors KNOWN_TOP_LEVEL_KEYS.
const pmProtocolSchema = z.object({
  delegation_delta: z.object({
    enabled: z.boolean().optional(),
  }).passthrough().optional(),
  tier2_index: z.object({
    enabled: z.boolean().optional(),
  }).passthrough().optional(),
}).passthrough();

// v2.2.0 P1.3 D-8: top-level `event_schemas` block. Carries the
// `full_load_disabled` flag that blocks legacy full-file Reads of
// agents/pm-reference/event-schemas.md (chunked-only enforcement).
// Default-on. F-001 (v2.2.0 pre-ship cross-phase fix-pass).
const eventSchemasSchema = z.object({
  full_load_disabled: z.boolean().optional(),
}).passthrough();

// v2.2.5 W1+W2: top-level `compression` block (tokenwright). Layered
// per-spawn delegation-prompt compressor. Layer 1 (MinHash dedup) ships
// in v2.2.5 default-on at level "safe"; Layer 2 (Haiku block-scoring)
// and Layer 3 (map-reduce summary) come in later releases gated by the
// preserve_sections list and the cost cap. Per project rule
// `feedback_default_on_shipping.md`, defaults on. Env kill switches:
// ORCHESTRAY_DISABLE_COMPRESSION=1 (full bypass),
// ORCHESTRAY_COMPRESSION_LEVEL=off|safe|aggressive|experimental|debug-passthrough.
const compressionSchema = z.object({
  enabled: z.boolean().optional(),
  level: z.enum(['off', 'safe', 'aggressive', 'experimental', 'debug-passthrough']).optional(),
  bm25_prefilter: z.boolean().optional(),
  bm25_top_k: z.number().min(0).max(1).optional(),
  keep_threshold: z.number().min(0).max(1).optional(),
  haiku_score_max_cost_usd_per_orchestration: z.number().min(0).optional(),
  preserve_sections: z.array(z.string()).optional(),
  sliding_window_size: z.number().int().min(0).optional(),
  minhash_jaccard_threshold: z.number().min(0).max(1).optional(),
  // v2.2.6: tokenwright instrumentation extensions
  realized_savings_no_silent_skip: z.boolean().optional(),
  invariant_check_enabled: z.boolean().optional(),
  invariant_check_fallback_to_original: z.boolean().optional(),
  estimation_drift_enabled: z.boolean().optional(),
  estimation_drift_budget_pct: z.number().optional(),
  coverage_probe_enabled: z.boolean().optional(),
  skip_event_enabled: z.boolean().optional(),
  double_fire_guard_enabled: z.boolean().optional(),
  pending_journal_ttl_hours: z.number().optional(),
  pending_journal_max_bytes: z.number().int().optional(),
  pending_journal_max_entries: z.number().int().optional(),
  self_probe_enabled: z.boolean().optional(),
  transcript_token_resolution_enabled: z.boolean().optional(),
  load_bearing_sections: z.array(z.string()).optional(),
}).passthrough();

// v2.2.0 P1.2: top-level `output_shape` block. Caveman + length-cap +
// structured-outputs pipeline applied to prose-heavy roles. Default-on.
// `staged_flip_allowlist` is the list of role names that pre-flip
// structured outputs in v2.2.0; the rest stay on the legacy free-form
// shape. F-001 (v2.2.0 pre-ship cross-phase fix-pass).
const outputShapeSchema = z.object({
  enabled: z.boolean().optional(),
  caveman_enabled: z.boolean().optional(),
  structured_outputs_enabled: z.boolean().optional(),
  length_cap_enabled: z.boolean().optional(),
  staged_flip_allowlist: z.array(z.string()).optional(),
}).passthrough();

// v2.1.16 W14-fix F-W14-001: declarations for v2.1.14/v2.1.15 carryover sections
// that ship in .orchestray/config.json but were never registered in the schema.
// Closes the bidirectional cross-ref test gap (KNOWN_TOP_LEVEL_KEYS vs schema).
const deltaHandoffSchema = z.object({
  enabled: z.boolean().optional(),
  force_full: z.boolean().optional(),
}).passthrough();

const featureDemandGateSchema = z.object({
  shadow_mode: z.boolean().optional(),
}).passthrough();

const roleBudgetsSchema = z.record(
  z.string(),
  z.object({
    budget_tokens: z.number().int().min(0).optional(),
    source: z.string().optional(),
    calibrated_at: z.string().optional(),
  }).passthrough()
);

const budgetEnforcementSchema = z.object({
  enabled: z.boolean().optional(),
  hard_block: z.boolean().optional(),
}).passthrough();

const curatorSliceLoadingSchema = z.object({
  enabled: z.boolean().optional(),
}).passthrough();

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

const configSchema = z.object({
  // --- Core scalars ---
  auto_review: z.boolean().optional(),
  max_retries: z.number().int().min(0).optional(),
  default_delegation: z.enum(['sequential', 'parallel']).optional(),
  verbose: z.boolean().optional(),
  complexity_threshold: z.number().int().min(0).max(20).optional(),
  force_orchestrate: z.boolean().optional(),
  force_solo: z.boolean().optional(),
  replan_budget: z.number().int().min(0).optional(),
  verify_fix_max_rounds: z.number().int().min(0).optional(),

  // Model routing
  model_floor: modelAlias.optional(),
  force_model: modelAlias.nullable().optional(),
  haiku_max_score: z.number().int().min(0).max(20).optional(),
  opus_min_score: z.number().int().min(0).max(20).optional(),
  default_effort: effortLevel.nullable().optional(),
  force_effort: effortLevel.nullable().optional(),
  effort_routing: z.boolean().optional(),
  // R-AT-FLAG (v2.1.16): legacy top-level flag — DEPRECATED. Prefer
  // `agent_teams.enabled`. Honored for one release as a fallback with a
  // one-time stderr deprecation warning emitted by post-upgrade-sweep.
  enable_agent_teams: z.boolean().optional(),
  agent_teams: agentTeamsSchema.optional(),

  // Cost
  max_cost_usd: z.number().positive().nullable().optional(),
  daily_cost_limit_usd: z.number().positive().nullable().optional(),
  weekly_cost_limit_usd: z.number().positive().nullable().optional(),

  // Reviewer / tester / docs
  security_review: z.enum(['auto', 'always', 'never']).optional(),
  tdd_mode: z.boolean().optional(),
  enable_prescan: z.boolean().optional(),
  test_timeout: z.number().int().positive().optional(),
  confirm_before_execute: z.boolean().optional(),
  enable_checkpoints: z.boolean().optional(),
  ci_command: z.string().nullable().optional(),
  ci_max_retries: z.number().int().min(0).optional(),
  post_to_issue: z.boolean().optional(),
  auto_document: z.boolean().optional(),
  adversarial_review: z.boolean().optional(),
  contract_strictness: z.enum(['loose', 'standard', 'strict']).optional(),
  enable_consequence_forecast: z.boolean().optional(),
  enable_repo_map: z.boolean().optional(),
  post_pr_comments: z.boolean().optional(),
  enable_introspection: z.boolean().optional(),
  enable_backpressure: z.boolean().optional(),
  surface_disagreements: z.boolean().optional(),
  enable_drift_sentinel: z.boolean().optional(),
  enable_visual_review: z.boolean().optional(),
  enable_threads: z.boolean().optional(),
  enable_outcome_tracking: z.boolean().optional(),
  enable_personas: z.boolean().optional(),
  enable_replay_analysis: z.boolean().optional(),
  max_turns_overrides: z.record(z.string(), z.number().int().min(1)).nullable().optional(),

  // R-CAT-DEFAULT (v2.1.16): pattern-find catalog-mode default flip. Boolean
  // flag — true = catalog-only by default, false = full body. F-002 (W12-fix).
  catalog_mode_default: z.boolean().optional(),

  // Nested sections
  mcp_server: mcpServerSchema.optional(),
  mcp_enforcement: mcpEnforcementSchema.optional(),
  cost_budget_enforcement: costBudgetEnforcementSchema.optional(),
  routing_gate: routingGateSchema.optional(),
  v2017_experiments: v2017ExperimentsSchema.optional(),
  cache_choreography: cacheChoreographySchema.optional(),
  adaptive_verbosity: adaptiveVerbositySchema.optional(),
  pattern_decay: patternDecaySchema.optional(),
  anti_pattern_gate: antiPatternGateSchema.optional(),
  state_sentinel: stateSentinelSchema.optional(),
  redo_flow: redoFlowSchema.optional(),
  context_statusbar: contextStatusbarSchema.optional(),
  federation: federationSchema.optional(),
  retrieval: retrievalSchema.optional(),
  auto_learning: autoLearningSchema.optional(),
  context_compression_v218: contextCompressionSchema.optional(),
  resilience: resilienceSchema.optional(),
  curator: curatorSchema.optional(),
  audit: auditSchema.optional(),
  shield: shieldSchema.optional(),
  // R-PHASE-INJ (v2.1.16, F-004 W12-fix): declare phase_slice_loading so the
  // documented `telemetry_enabled` kill switch is discoverable via schema.
  phase_slice_loading: phaseSliceLoadingSchema.optional(),
  // R-RV-DIMS (v2.1.16, F-002 W12-fix): reviewer-dimension scoping kill switch.
  review_dimension_scoping: reviewDimensionScopingSchema.optional(),
  // R-AIDER-FULL (v2.1.17 W8): Aider-style repo-map kill switch + knobs.
  repo_map: repoMapSchema.optional(),
  // v2.2.0 P2.1 / P2.2: Block-Z + engineered-breakpoint manifest +
  // Haiku scout for PM I/O. Both ship default-on; per-session env-var
  // kill switches and per-section `enabled: false` documented in
  // post-upgrade-sweep.js banner (S-004).
  caching: cachingSchema.optional(),
  haiku_routing: haikuRoutingSchema.optional(),
  // v2.2.0 P1.2 / P1.3 / P3.2: output-shape pipeline + tier-2 index +
  // delegation-delta + D-8 full-load-disabled. All four ship default-on
  // and have per-section `enabled: false` (or the boolean flag itself
  // for event_schemas) as kill switches. F-001 (v2.2.0 pre-ship
  // cross-phase fix-pass).
  output_shape: outputShapeSchema.optional(),
  pm_protocol: pmProtocolSchema.optional(),
  event_schemas: eventSchemasSchema.optional(),
  // v2.2.5 W1+W2: tokenwright (per-spawn delegation-prompt compressor).
  compression: compressionSchema.optional(),
  // v2.1.16 W14-fix F-W14-001: declare v2.1.14/15 carryover sections so the
  // bidirectional cross-ref test (KNOWN_TOP_LEVEL_KEYS == schema fields) holds
  // and fresh-install boot stops emitting "unknown config key" drift warnings.
  delta_handoff: deltaHandoffSchema.optional(),
  feature_demand_gate: featureDemandGateSchema.optional(),
  role_budgets: roleBudgetsSchema.optional(),
  budget_enforcement: budgetEnforcementSchema.optional(),
  curator_slice_loading: curatorSliceLoadingSchema.optional(),
  config_drift_silence: configDriftSilenceSchema.optional(),
  // v2.2.8 Item 5 (L): reactive worker-initiated agent spawning.
  reactive_spawn: reactiveSpawnSchema.optional(),
  // v2.2.9 B-7.1: hard cap on Agent() maxTurns parameter (default 200).
  spawn: spawnSchema.optional(),
  // v2.2.9 B-7.2: repo-map drift validator (default shadow-mode true; flips false in v2.2.10).
  repo_map_thresholds: repoMapThresholdsSchema.optional(),
  // v2.2.9 B-7.6: TTL for `.orchestray/auto-trigger.json` (seconds; default 3600).
  auto_trigger_ttl_seconds: z.number().int().min(1).optional(),
}).passthrough(); // R-CONFIG-DRIFT (W9) owns unknown-key warnings; this schema tolerates them.

module.exports = {
  configSchema,
  // Leaf schemas exposed so other code (e.g., R-CONFIG-DRIFT in W9) can reuse
  // the per-section shape without duplicating it.
  mcpEnforcementSchema,
  mcpServerSchema,
  costBudgetEnforcementSchema,
  routingGateSchema,
  v2017ExperimentsSchema,
  cacheChoreographySchema,
  adaptiveVerbositySchema,
  patternDecaySchema,
  antiPatternGateSchema,
  stateSentinelSchema,
  redoFlowSchema,
  contextStatusbarSchema,
  federationSchema,
  retrievalSchema,
  autoLearningSchema,
  contextCompressionSchema,
  resilienceSchema,
  curatorSchema,
  auditSchema,
  shieldSchema,
  phaseSliceLoadingSchema,
  repoMapSchema,
  // v2.2.0 P1.2 / P1.3 / P3.2 — F-001 cross-phase fix.
  outputShapeSchema,
  pmProtocolSchema,
  eventSchemasSchema,
  // v2.2.5 W1+W2: tokenwright compressor.
  compressionSchema,
  // v2.2.8 Item 5 (L): reactive spawning.
  reactiveSpawnSchema,
  // v2.2.9 B-7: numeric thresholds out of prose (single config schema).
  spawnSchema,
  repoMapThresholdsSchema,
};
