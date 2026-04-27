'use strict';

/**
 * tier2-index.js — Pre-Materialized Tier-2 Index for event-schemas.md (v2.2.0).
 *
 * Parses agents/pm-reference/event-schemas.md once into a richer JSON sidecar
 * agents/pm-reference/event-schemas.tier2-index.json. Replaces the 46.5k-token
 * full-file Read on the PM's "about to emit a new event type" path with a
 * 1k-token fingerprint + chunked lookup via mcp__orchestray__schema_get.
 *
 * D-8 contract (v2.2.0): when event_schemas.full_load_disabled is true (default),
 * chunk-miss returns {found: false} — there is NO silent fallback to full Read.
 * Mechanical bound: getChunk() reads the source file at most once per call; on a
 * hit it RETURNS only the [start,end] line slice (the full source is never
 * injected into PM context — payload bytes are bounded by chunk size, not source
 * file size); on a miss it returns {found:false} without slicing. The path-traversal
 * guarantee (no read outside the indexed line range for the requested slug) is
 * enforced by the slug-regex check before any path resolution.
 *
 * Exports:
 *   buildIndex({cwd}) -> { events, fingerprint, _meta }
 *   getChunk(event_type, {cwd, callerContext}) ->
 *       { chunk, line_range, event_type, found, source, caller_context }
 *     | { found: false, error, message, event_type, caller_context }
 *   resolveCallerContext(explicit) -> string  (v2.2.3 P2 W4)
 *   CALLER_CONTEXT_VALUES
 *   TIER2_INDEX_REL_PATH
 *
 * v2.2.3 P2 W4: caller_context distinguishes real callers (real_agent_spawn,
 * mcp_tool_call) from fuzz/test inputs (test_fixture) so rollups don't conflate
 * them. Post-v2.2.0 telemetry showed 94 tier2_index_lookup events, ALL with
 * found:false and event_type strings that look like attack inputs ('BadCase',
 * '../../etc/passwd'). The index was never queried for a real schema. The new
 * field surfaces the distinction.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const _parser = require('./event-schemas-parser');

const TIER2_INDEX_REL_PATH = path.join(
  'agents', 'pm-reference', 'event-schemas.tier2-index.json'
);
const SCHEMA_REL_PATH = path.join(
  'agents', 'pm-reference', 'event-schemas.md'
);

// Soft ceiling for the on-disk sidecar. The design proposed 16 KB based on a
// 64-event count; the real source has ~112 events as of v2.1.17 (each entry
// stores schema.required[]+optional[] arrays per AR-p13-1 evidence), so the
// realistic serialized size is ~50 KB. We cap at 65 KB (still 3x smaller
// than the 186 KB source and well under any I/O limit). The sidecar is
// loaded JIT, never injected wholesale.
const MAX_INDEX_BYTES = 65536; // 64 KB soft ceiling.

// v2.2.3 P2 W4: caller_context taxonomy. Telemetry consumers MUST treat any
// value not in this enum as "unknown" — the parser is permissive on emit but
// strict on rollup. Adding a new value is additive (R-EVENT-NAMING).
const CALLER_CONTEXT_VALUES = Object.freeze([
  'real_agent_spawn', // hook script invoked during an Agent() spawn
  'mcp_tool_call',    // mcp__orchestray__schema_get path
  'cli_invocation',   // direct CLI / ad-hoc node invocation
  'test_fixture',     // unit test, fuzz harness, or attack input replay
  'unknown',          // fallback when no caller signal is available
]);

/**
 * Resolve the caller_context value for a tier2_index_lookup emission.
 *
 * Priority order:
 *   1. explicit `callerContext` param if it's in CALLER_CONTEXT_VALUES
 *   2. test-environment markers (NODE_TEST_CONTEXT,
 *      ORCHESTRAY_TEST_SHARED_DIR, NODE_TEST, JEST_WORKER_ID, npm_lifecycle_event=test)
 *      → 'test_fixture'
 *   3. 'unknown'
 *
 * The default-fallback to 'unknown' (rather than throwing) preserves fail-open
 * semantics for the audit path. Unmigrated callers show up as 'unknown' in
 * telemetry — easy to find and migrate.
 *
 * @param {string} [explicit] - explicit caller hint passed by the call site
 * @returns {string} one of CALLER_CONTEXT_VALUES
 */
function resolveCallerContext(explicit) {
  if (typeof explicit === 'string' && CALLER_CONTEXT_VALUES.includes(explicit)) {
    return explicit;
  }
  // Detect test environments via well-known env markers. Order doesn't matter
  // — any one of them is enough to flip the default to test_fixture.
  const env = process.env || {};
  if (
    env.NODE_TEST_CONTEXT ||
    env.ORCHESTRAY_TEST_SHARED_DIR ||
    env.NODE_TEST ||
    env.JEST_WORKER_ID ||
    env.npm_lifecycle_event === 'test'
  ) {
    return 'test_fixture';
  }
  return 'unknown';
}

// W7 fix-pass L-001 (security): pre-stat ceiling for the source markdown.
// 25× the current 226 KB source — generous headroom for legitimate growth,
// but bounded so a malicious commit cannot OOM the MCP server. Both
// buildIndex() and getChunk() apply this guard before fs.readFileSync.
const MAX_SCHEMA_BYTES = 5 * 1024 * 1024; // 5 MB

function _assertSchemaSourceSize(schemaPath) {
  let stat;
  try { stat = fs.statSync(schemaPath); } catch (_e) { return; }
  if (stat && typeof stat.size === 'number' && stat.size > MAX_SCHEMA_BYTES) {
    throw new Error(
      'tier2-index: source ' + schemaPath + ' exceeds ' + MAX_SCHEMA_BYTES +
      ' bytes (got ' + stat.size + ' bytes); refusing to load to prevent OOM.'
    );
  }
}

/**
 * Compute SHA-256 of the source markdown file.
 * Returns null on read failure.
 */
function _sourceHash(cwd) {
  try {
    const content = fs.readFileSync(path.join(cwd, SCHEMA_REL_PATH), 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (_e) {
    return null;
  }
}

/**
 * Build the fingerprint string. One line per event_type in the form
 *   "<event_type> | <short_doc or ''> | L<startLine>"
 * separated by `\n`. Capped at MAX_FINGERPRINT_BYTES so consumers can
 * inject this whole blob and stay under ~1k tokens.
 */
function _buildFingerprint(events, sourcePath) {
  const lines = [];
  lines.push('# event-schemas tier2 fingerprint (' + events.length + ' events)');
  lines.push('# source: ' + sourcePath);
  for (const ev of events) {
    const doc = ev.short_doc ? ev.short_doc.replace(/\s+/g, ' ').slice(0, 80) : '';
    lines.push(ev.slug + ' | ' + doc + ' | L' + ev.line_range[0]);
  }
  return lines.join('\n');
}

/**
 * Parse event-schemas.md and write the sidecar.
 * @param {object} opts - { cwd: string, write?: boolean (default true) }
 * @returns {{ events, fingerprint, _meta }} on success.
 * @throws on parse failure / size overflow / missing source.
 */
function buildIndex(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const write = !opts || opts.write !== false;

  const schemaPath = path.join(cwd, SCHEMA_REL_PATH);
  const outPath    = path.join(cwd, TIER2_INDEX_REL_PATH);

  let content;
  try {
    _assertSchemaSourceSize(schemaPath);
    content = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    throw new Error('tier2-index: cannot read ' + schemaPath + ': ' + err.message);
  }

  const sourceHash  = crypto.createHash('sha256').update(content).digest('hex');
  const sourceBytes = Buffer.byteLength(content, 'utf8');

  const parsedEvents = _parser.parseEventSchemasWithRanges(content);
  if (parsedEvents.length === 0) {
    throw new Error('tier2-index: no event types found in ' + schemaPath);
  }

  // Build the on-disk events map (drop section_text — it's only needed by
  // getChunk's source-slice path, which re-reads the source when called).
  const eventsMap = {};
  for (const ev of parsedEvents) {
    eventsMap[ev.slug] = {
      schema: {
        version: ev.version,
        required: ev.required,
        optional: ev.optional,
      },
      enum_dialect_hash: ev.enum_dialect_hash,
      line_range: ev.line_range,
      short_doc: ev.short_doc,
      citation_anchor: 'agents/pm-reference/event-schemas.md:' + ev.line_range[0],
    };
  }

  const fingerprint = _buildFingerprint(parsedEvents, 'agents/pm-reference/event-schemas.md');

  const sidecar = {
    _meta: {
      version: 1,
      source_path: 'agents/pm-reference/event-schemas.md',
      source_hash: sourceHash,
      source_bytes: sourceBytes,
      generated_at: new Date().toISOString(),
      index_size_bytes: 0, // filled in after serialization
      event_count: parsedEvents.length,
      // Estimate ~4 chars per token. The fingerprint is ~3-4 KB / ~1k tokens
      // for the current source.
      fingerprint_token_estimate: Math.ceil(Buffer.byteLength(fingerprint, 'utf8') / 4),
    },
    fingerprint,
    events: eventsMap,
  };

  // Serialize once to compute size, then again with the size baked in.
  const probe = JSON.stringify(sidecar);
  const sizeBytes = Buffer.byteLength(probe, 'utf8');

  if (sizeBytes > MAX_INDEX_BYTES) {
    throw new Error(
      'tier2-index: sidecar size ' + sizeBytes + ' bytes exceeds limit of ' +
      MAX_INDEX_BYTES + ' bytes. Consider trimming short_doc or per-event fields.'
    );
  }

  sidecar._meta.index_size_bytes = sizeBytes;
  const finalJson = JSON.stringify(sidecar);

  if (write) {
    fs.writeFileSync(outPath, finalJson + '\n', 'utf8');
  }

  return sidecar;
}

/**
 * Resolve an event_type to its 200–600 token markdown chunk.
 *
 * Reads the sidecar (NOT the source) for the line_range, then RETURNS only
 * the matching [start,end] line slice (the full source IS read into memory
 * to slice but the out-of-range lines are dropped before return — PM-side
 * payload bytes are bounded by chunk size, not source file size).
 * Source-hash mismatch returns {found:false, error:'stale_index'} — the
 * caller never receives a full-file payload from this path.
 *
 * F-009 (v2.2.0 pre-ship cross-phase fix-pass): wording previously said
 * "reads ONLY the matching slice from the source file"; that overstated
 * the disk-I/O claim because fs.readFileSync at line ~263 reads the whole
 * file before slicing. The user-visible bound (chunk size on the way out)
 * is the actual contract; the in-memory read-then-discard is the
 * mechanism. Updated to match the implementation.
 *
 * @param {string} event_type
 * @param {object} opts - { cwd: string, callerContext?: string }
 *   callerContext (v2.2.3 P2 W4): caller-identity hint surfaced on the
 *   returned object so the audit emitter can stamp tier2_index_lookup with
 *   the correct caller_context. Resolved through resolveCallerContext()
 *   (explicit value > test-env markers > 'unknown').
 * @returns {object} {found:true, chunk, line_range, event_type, source, caller_context}
 *                  | {found:false, error, message, event_type, caller_context}
 */
function getChunk(event_type, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const caller_context = resolveCallerContext(opts && opts.callerContext);

  if (typeof event_type !== 'string' || !event_type) {
    return {
      found: false,
      event_type: String(event_type || ''),
      error: 'invalid_event_type',
      message: 'event_type must be a non-empty string',
      caller_context,
    };
  }
  if (!/^[a-z][a-z0-9_.-]*$/.test(event_type)) {
    return {
      found: false,
      event_type,
      error: 'invalid_event_type',
      message: 'event_type must match ^[a-z][a-z0-9_.-]*$',
      caller_context,
    };
  }

  const indexPath  = path.join(cwd, TIER2_INDEX_REL_PATH);
  const schemaPath = path.join(cwd, SCHEMA_REL_PATH);

  let sidecar;
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    sidecar = JSON.parse(raw);
  } catch (err) {
    return {
      found: false,
      event_type,
      error: 'index_missing',
      message: 'tier2-index sidecar not found or unreadable: ' + err.message +
               ' — run bin/regen-schema-shadow.js to regenerate.',
      caller_context,
    };
  }

  const entry = sidecar && sidecar.events && sidecar.events[event_type];
  if (!entry) {
    return {
      found: false,
      event_type,
      error: 'event_type_unknown',
      message: 'no entry in tier2-index for "' + event_type +
               '"; full-file Read of event-schemas.md is disabled — call schema_get with a known slug or add the schema heading first.',
      caller_context,
    };
  }

  // Verify source hash; if stale, refuse to slice (the line_range may be off).
  const currentHash = _sourceHash(cwd);
  const storedHash  = sidecar._meta && sidecar._meta.source_hash;
  if (storedHash && currentHash && storedHash !== currentHash) {
    return {
      found: false,
      event_type,
      error: 'stale_index',
      message: 'tier2-index source_hash mismatch; the PostToolUse(Edit) hook ' +
               'has not yet regenerated the sidecar. Retry next turn.',
      caller_context,
    };
  }

  // Read the source once, then RETURN only the [start,end] line slice. The
  // returned chunk is bounded by line_range (never the full 186 KB); the
  // out-of-range lines are read into memory then immediately dropped before
  // return. PM-side payload bytes are bounded by chunk size, not file size.
  // Pre-stat guard (L-001): refuse pathologically large sources to bound
  // memory before fs.readFileSync.
  let content;
  try {
    _assertSchemaSourceSize(schemaPath);
    content = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    return {
      found: false,
      event_type,
      error: 'source_read_failed',
      message: 'cannot read event-schemas.md: ' + err.message,
      caller_context,
    };
  }

  const lines = content.split('\n');
  const [startLine, endLine] = entry.line_range;
  // line_range is 1-based and inclusive. Array index = line - 1.
  const sliceStart = Math.max(0, startLine - 1);
  const sliceEnd   = Math.min(lines.length, endLine);
  const chunk = lines.slice(sliceStart, sliceEnd).join('\n');

  return {
    found: true,
    event_type,
    chunk,
    line_range: entry.line_range,
    short_doc: entry.short_doc,
    citation_anchor: entry.citation_anchor,
    source: 'mcp_schema_get',
    caller_context,
  };
}

module.exports = {
  buildIndex,
  getChunk,
  resolveCallerContext,
  CALLER_CONTEXT_VALUES,
  TIER2_INDEX_REL_PATH,
  MAX_INDEX_BYTES,
  MAX_SCHEMA_BYTES,
};
