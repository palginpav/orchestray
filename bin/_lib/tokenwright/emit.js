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
 *   dropped_sections        {string[]}  — headings of dropped sections
 *   layer1_dedup_blocks_dropped {number}
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
 *   actual_input_tokens         {number}  — from SubagentStop hook payload
 *   actual_savings_tokens       {number}  — estimated - actual
 *   estimation_error_pct        {number}  — |actual - estimated| / actual * 100
 *   technique_tag               {string}
 *
 * @param {object} payload
 */
function emitTokenwrightRealizedSavings(payload) {
  _emit('tokenwright_realized_savings', payload);
}

module.exports = {
  emitPromptCompression,
  emitTokenwrightRealizedSavings,
};
