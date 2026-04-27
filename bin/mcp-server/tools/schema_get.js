'use strict';

/**
 * `schema_get` MCP tool (P1.3, v2.2.0).
 *
 * Returns the 200–600 token markdown chunk for a single event_type from
 * agents/pm-reference/event-schemas.md. Use this verb whenever the PM is
 * about to emit an event whose payload shape is not already in context.
 *
 * D-8 enforcement (event_schemas.full_load_disabled, default true):
 *   - Chunk-miss returns {found: false} — there is NO silent fallback to
 *     full-file Read of event-schemas.md.
 *   - getChunk() in bin/_lib/tier2-index.js RETURNS only the [start,end]
 *     line slice; the verb's response payload is bounded by chunk size, not
 *     by source file size. The slug-regex (`^[a-z][a-z0-9_.-]*$`) blocks
 *     path-traversal before any line-range is resolved.
 *
 * Input:  { event_type: string (^[a-z][a-z0-9_.-]*$) }
 * Output (hit):  { found: true, event_type, chunk, line_range: [n,n],
 *                  short_doc, citation_anchor, source: 'mcp_schema_get' }
 * Output (miss): { found: false, event_type, error: 'event_type_unknown' | ...,
 *                  message }
 *
 * Auth gating: standard isToolEnabled('schema_get') path in server.js.
 * Audit: emits `schema_get_call` AND `tier2_index_lookup` on every call
 * (mirrors pattern_read's audit pattern).
 */

const path = require('node:path');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError }            = require('../lib/tool-result');
const { logStderr }                         = require('../lib/rpc');
const { writeAuditEvent, readOrchestrationId } = require('../lib/audit');

const { getChunk } = require('../../_lib/tier2-index');
const { TIER2_INDEX_REL_PATH } = require('../../_lib/tier2-index');

const fs = require('node:fs');

const INPUT_SCHEMA = {
  type: 'object',
  required: ['event_type'],
  properties: {
    event_type: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      pattern: '^[a-z][a-z0-9_.-]*$',
    },
  },
};

const definition = deepFreeze({
  name: 'schema_get',
  description:
    'Return the 200–600 token markdown chunk for a single event_type from ' +
    'agents/pm-reference/event-schemas.md. Use this verb whenever the PM is ' +
    'about to emit an event whose payload shape is not already in context. ' +
    'D-8 enforcement: chunk-miss returns {found: false} — full-file Read of ' +
    'event-schemas.md is disabled when event_schemas.full_load_disabled is ' +
    'true (the v2.2.0 default).',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('schema_get: ' + validation.errors.join('; '));
  }

  const cwd = (context && context.projectRoot) || process.cwd();
  const event_type = input.event_type;

  // v2.2.3 P2 W4: every emit MUST carry caller_context. The MCP tool path is
  // by definition mcp_tool_call — pass it explicitly so resolveCallerContext()
  // doesn't fall through to test-env detection in CI runs.
  let result;
  let parserError = null;
  try {
    result = getChunk(event_type, { cwd, callerContext: 'mcp_tool_call' });
  } catch (err) {
    parserError = err && err.message;
    logStderr('schema_get: getChunk threw: ' + parserError);
    result = {
      found: false,
      event_type,
      error: 'parser_error',
      message: parserError,
    };
  }

  // F-008 (v2.2.0 pre-ship cross-phase fix-pass): emit schema_get_call AFTER
  // the validation gate AND after getChunk(). Belt-and-suspenders against a
  // future regression that might drop the upstream pattern validator
  // (M-001 in lib/schemas.js). Slug-format-only failures are already rejected
  // at line 67-70 above (validateAgainstSchema returns toolError without
  // reaching here); emitting only on content-relevant outcomes keeps the
  // audit stream from logging attacker-supplied malformed slugs even if the
  // upstream validator regresses. Mirrors pattern_read's audit pattern.
  try {
    writeAuditEvent({
      version: 1,
      timestamp: new Date().toISOString(),
      type: 'schema_get_call',
      tool: 'schema_get',
      event_type,
      orchestration_id: readOrchestrationId(),
      found: !!(result && result.found),
      error: (result && result.error) || null,
    });
  } catch (_e) { /* non-fatal */ }

  if (parserError) {
    // Parser failures still return a structured response; just short-circuit
    // before computing tier2_index_lookup telemetry (no slot to count).
    return toolSuccess(result);
  }

  // Determine bytes-avoided from the sidecar _meta.source_bytes (best-effort).
  let fullFileBytesAvoided = 0;
  try {
    const indexPath = path.join(cwd, TIER2_INDEX_REL_PATH);
    const sidecar = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    fullFileBytesAvoided = (sidecar && sidecar._meta && sidecar._meta.source_bytes) || 0;
  } catch (_e) { /* non-fatal */ }

  // Audit: tier2_index_lookup with hit/miss telemetry. Fail-open.
  // v2.2.3 P2 W4: stamp caller_context from the getChunk() result. The MCP
  // path always passes 'mcp_tool_call' explicitly above; the field on result
  // is the resolved value (test-env markers can override during unit tests).
  try {
    writeAuditEvent({
      version: 1,
      timestamp: new Date().toISOString(),
      type: 'tier2_index_lookup',
      orchestration_id: readOrchestrationId(),
      file: 'event-schemas.md',
      event_type,
      fingerprint_only_bytes: 0,
      full_file_bytes_avoided: fullFileBytesAvoided,
      found: !!result.found,
      source: 'mcp_schema_get',
      caller_context: (result && result.caller_context) || 'unknown',
    });
  } catch (_e) { /* non-fatal */ }

  return toolSuccess(result);
}

module.exports = { definition, handle };
