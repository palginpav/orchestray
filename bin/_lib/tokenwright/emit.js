'use strict';

/**
 * emit.js — Tokenwright audit-event wrappers.
 *
 * Two event types emitted by the tokenwright pipeline:
 *
 *   prompt_compression        — fired by inject-tokenwright.js (PreToolUse:Agent)
 *                               immediately after the compression pipeline runs.
 *   tokenwright_realized_savings — fired by capture-tokenwright-realized.js
 *                               (SubagentStop) once actual token counts are known.
 *
 * Both helpers are fail-safe: a failure to emit MUST NOT propagate — hook
 * code that calls these functions must not be disrupted by audit-channel
 * problems. Errors are reported to stderr only.
 *
 * Critical invariant (design §3.7 R11): version: 1 is NEVER auto-filled by
 * audit-event-writer.js — every emit site must stamp it explicitly. We do that
 * here so callers cannot accidentally omit it.
 */

const { writeEvent } = require('../audit-event-writer');

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Shared emit core — stamps version+type+timestamp, routes through the single
 * audit-event gateway, and swallows failures (fail-safe contract).
 *
 * @param {string} type   Canonical event type string.
 * @param {object} payload  Caller-supplied fields (merged on top of stamps).
 */
function _emit(type, payload) {
  try {
    const event = Object.assign({}, payload, {
      version:   1,                        // R11: must be explicit at every emit site
      type,
      timestamp: new Date().toISOString(), // belt-and-suspenders; writer also autofills
    });
    writeEvent(event);
  } catch (err) {
    try {
      process.stderr.write(
        '[tokenwright/emit] failed to emit ' + type + ': ' +
        String(err && err.message ? err.message : err) + '\n'
      );
    } catch (_e) { /* swallow stderr failures too */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a `prompt_compression` audit event.
 *
 * Expected payload fields (all optional for fail-safety, but should be
 * populated by inject-tokenwright.js):
 *   orchestration_id        {string|null}
 *   task_id                 {string|null}
 *   agent_type              {string}
 *   input_bytes             {number}
 *   output_bytes            {number}
 *   ratio                   {number}  — output_bytes / input_bytes
 *   technique_tag           {string}  — e.g. "safe-l1", "aggressive-l1l2"
 *   input_token_estimate    {number}  — bytes / 4
 *   output_token_estimate   {number}
 *   dropped_sections        {string[]}  — headings of dropped sections (legacy string[])
 *                           or Array<{heading,kind,body_bytes,dropped_reason}> (v2.2.6+)
 *   layer1_dedup_blocks_dropped {number}
 *
 * v2.2.6 additive fields (all optional):
 *   sections_total          {number}  — total parsed section count
 *   sections_dedup_eligible {number}  — count with kind === 'dedup-eligible'
 *   sections_score_eligible {number}  — count with kind === 'score-eligible'
 *   sections_preserve       {number}  — count with kind === 'preserve'
 *   eligibility_rate        {number}  — (dedup_eligible + score_eligible) / total, or 0
 *   dedup_drop_by_heading   {Record<string,number>}  — per-heading drop counts
 *   compression_skipped_path {string|null}  — skip-path name if no-op; null otherwise
 *   tokenwright_version     {string}  — "2.2.6-l1" (distinguishes layer mix)
 *
 * @param {object} payload
 */
function emitPromptCompression(payload) {
  _emit('prompt_compression', payload);
}

/**
 * Emit a `tokenwright_realized_savings` audit event.
 *
 * Expected payload fields:
 *   orchestration_id            {string|null}
 *   task_id                     {string|null}
 *   agent_type                  {string}
 *   estimated_input_tokens_pre  {number}  — from pending journal
 *   actual_input_tokens         {number|null}  — from SubagentStop hook payload; nullable (v2.2.6)
 *   actual_savings_tokens       {number|null}  — estimated - actual; nullable (v2.2.6)
 *   estimation_error_pct        {number|null}  — |actual - estimated| / actual * 100; nullable (v2.2.6)
 *   technique_tag               {string}
 *
 * v2.2.6 additive fields (all required per spec):
 *   realized_status    {"measured"|"unknown"}  — "measured" when actual tokens > 0
 *   usage_source       {"transcript"|"hook_event"|"tool_response"|"unknown"}
 *   drift_exceeded     {boolean}  — true when |estimation_error_pct| > drift_budget_pct
 *   drift_budget_pct   {number}   — echoes config compression.estimation_drift_budget_pct
 *   removed_pending_entry {boolean}  — confirms B2 fix worked
 *
 * @param {object} payload
 */
function emitTokenwrightRealizedSavings(payload) {
  _emit('tokenwright_realized_savings', payload);
}

/**
 * Emit a `tokenwright_realized_unknown` audit event.
 *
 * Emitted by capture-tokenwright-realized.js when a pending entry is matched
 * but no actual-token source could be resolved (no transcript, no hook usage,
 * no tool_response usage). Provides a lower-cardinality alarm signal for
 * dashboards.
 *
 * Required fields:
 *   orchestration_id        {string|null}
 *   agent_type              {string}
 *   spawn_key               {string}
 *   estimated_input_tokens_pre {number}
 *   reason                  {"no_token_source"|"transcript_unreadable"|"transcript_outside_containment"|"parse_failure"}
 *   transcript_path_present {boolean}
 *   hook_usage_present      {boolean}
 *
 * @param {object} payload
 */
function emitTokenwrightRealizedUnknown(payload) {
  _emit('tokenwright_realized_unknown', payload);
}

/**
 * Emit a `compression_invariant_violated` audit event.
 *
 * Emitted by inject-tokenwright.js when a load-bearing section is absent or
 * modified in the compressed prompt. Should be zero in healthy runs — any
 * emission indicates the classifier wrongly dropped a protected heading.
 *
 * Required fields:
 *   orchestration_id    {string|null}
 *   agent_type          {string}
 *   violated_section    {string}  — heading that was dropped/modified
 *   violation_kind      {"load_bearing_dropped"|"block_a_sentinel_missing"|"prefix_byte_drift"}
 *   input_bytes_pre     {number}
 *   input_bytes_post    {number}
 *   load_bearing_set    {string[]}  — the set that was checked
 *
 * @param {object} payload
 */
function emitCompressionInvariantViolated(payload) {
  _emit('compression_invariant_violated', payload);
}

/**
 * Emit a `tokenwright_estimation_drift` audit event.
 *
 * Emitted by capture-tokenwright-realized.js when |estimation_error_pct|
 * exceeds the configured drift budget (default 15%). Emitted alongside
 * (not replacing) the tokenwright_realized_savings event.
 *
 * Required fields:
 *   orchestration_id          {string|null}
 *   agent_type                {string}
 *   estimated_input_tokens_pre {number}
 *   actual_input_tokens       {number}
 *   estimation_error_pct      {number}
 *   drift_budget_pct          {number}
 *   direction                 {"underestimate"|"overestimate"}
 *
 * @param {object} payload
 */
function emitTokenwrightEstimationDrift(payload) {
  _emit('tokenwright_estimation_drift', payload);
}

/**
 * Emit a `tokenwright_spawn_coverage` audit event.
 *
 * Emitted once per orchestration at close time by coverage-probe.js.
 * Summarizes how many agent spawns produced compression/realized pairs.
 *
 * Required fields:
 *   orchestration_id          {string|null}
 *   agent_starts_total        {number}
 *   prompt_compression_emits  {number}
 *   realized_savings_emits    {number}
 *   realized_unknown_emits    {number}
 *   compression_skipped_emits {number}
 *   coverage_compression_pct  {number}
 *   coverage_realized_pct     {number}
 *   missing_pairs             {Array<{agent_type, spawn_key, missing_event}>}
 *
 * @param {object} payload
 */
function emitTokenwrightSpawnCoverage(payload) {
  _emit('tokenwright_spawn_coverage', payload);
}

/**
 * Emit a `compression_skipped` audit event.
 *
 * Replaces all silent no-op paths in inject-tokenwright.js. Every path
 * that previously silently passed through now emits this event so the
 * decision is observable in the audit trail.
 *
 * Required fields:
 *   orchestration_id  {string|null}
 *   agent_type        {string}
 *   reason            {"kill_switch_env"|"kill_switch_config"|"level_off"|"level_debug_passthrough"|"no_prompt_field"|"oversize_stdin"|"parse_failure"|"runtime_exception"|"agent_type_excluded"}
 *   skip_path         {string}  — e.g. "ORCHESTRAY_DISABLE_COMPRESSION=1" or error message prefix
 *
 * @param {object} payload
 */
function emitCompressionSkipped(payload) {
  _emit('compression_skipped', payload);
}

/**
 * Emit a `compression_double_fire_detected` audit event.
 *
 * Emitted when the same dedup_token is seen twice within the 100ms window,
 * indicating double hook registration (B3). One event per detection per
 * orchestration; subsequent detections are suppressed.
 *
 * Required fields:
 *   orchestration_id  {string|null}
 *   agent_type        {string}
 *   dedup_token       {string}
 *   delta_ms          {number}
 *   first_caller      {string}
 *   second_caller     {string}
 *
 * @param {object} payload
 */
function emitCompressionDoubleFireDetected(payload) {
  _emit('compression_double_fire_detected', payload);
}

/**
 * Emit a `tokenwright_journal_truncated` audit event.
 *
 * Emitted when the pending journal is truncated by the TTL sweep or hard cap.
 * Should be zero in healthy runs — any emission indicates journal buildup
 * (likely caused by B1/B2 bugs not being fully fixed, or very long runs).
 *
 * Required fields:
 *   orchestration_id  {string|null}
 *   entries_before    {number}
 *   entries_after     {number}
 *   bytes_before      {number}
 *   bytes_after       {number}
 *   trigger           {"size_cap_10kb"|"ttl_sweep"|"count_cap_100"}
 *
 * @param {object} payload
 */
function emitTokenwrightJournalTruncated(payload) {
  _emit('tokenwright_journal_truncated', payload);
}

/**
 * Emit a `tokenwright_self_probe` audit event.
 *
 * Emitted once on first session post-v2.2.6 install by self-probe.js.
 * Verifies the full instrumentation stack is wired correctly.
 *
 * Required fields:
 *   version_installed                 {string}  — e.g. "2.2.6"
 *   global_install_present            {boolean}
 *   local_install_present             {boolean}
 *   hook_dedup_clean                  {boolean}
 *   compression_block_in_config       {boolean}
 *   transcript_token_path_resolves    {boolean}
 *   fixture_compression_ran           {boolean}
 *   fixture_emitted_prompt_compression {boolean}
 *   fixture_emitted_realized_savings  {boolean}
 *   result                            {"pass"|"fail"|"skipped"}
 *   failures                          {string[]}
 *
 * @param {object} payload
 */
function emitTokenwrightSelfProbe(payload) {
  _emit('tokenwright_self_probe', payload);
}

module.exports = {
  emitPromptCompression,
  emitTokenwrightRealizedSavings,
  emitTokenwrightRealizedUnknown,
  emitCompressionInvariantViolated,
  emitTokenwrightEstimationDrift,
  emitTokenwrightSpawnCoverage,
  emitCompressionSkipped,
  emitCompressionDoubleFireDetected,
  emitTokenwrightJournalTruncated,
  emitTokenwrightSelfProbe,
};
