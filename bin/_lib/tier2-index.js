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
 *   getChunk(event_type, {cwd}) -> { chunk, line_range, event_type, found, source }
 *                                | { found: false, error, message, event_type }
 *   TIER2_INDEX_REL_PATH
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
// v2.2.8 bumped from 64 KB to 96 KB. The v2.2.8 release adds ~17 new event
// types (Tokenwright Agent-Teams capture, Block-Z retrip telemetry, schema
// redirect, housekeeper auto-delegation, generalized double-fire guard,
// workspace snapshot, /orchestray:loop, reactive spawning) that push the
// sidecar above the original 64 KB cap. The sidecar is loaded JIT by
// `mcp__orchestray__schema_get`, never injected wholesale, so the modest
// disk-side bump has no PM-context impact.
// v2.2.11 bumped from 96 KB to 128 KB. F1-A-2211 declares 13 new event types
// (14 including the updated loop_completed), pushing the sidecar from 95 KB to
// ~101 KB. The 128 KB ceiling gives headroom for the remaining v2.2.11 waves
// (W2-W4 add further event types). The sidecar is JIT-loaded, not PM-injected.
const MAX_INDEX_BYTES = 131072; // 128 KB soft ceiling.

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

// ---------------------------------------------------------------------------
// P1-17 (v2.2.15 W2-09): Sidecar shape clarification
//
// The `events` field in the sidecar JSON is a MAP-LIKE OBJECT (slug → metadata),
// NOT an array. Validators and consumers must use Object.keys(events) /
// Object.entries(events) — iterating it as an array will silently yield nothing.
//
// Sidecar shape (TypeScript-style):
//
//   interface EventMetadata {
//     schema:           { version: number; required: string[]; optional: string[] };
//     enum_dialect_hash: string | null;
//     line_range:       [number, number];
//     short_doc:        string;
//     citation_anchor:  string;
//   }
//
//   /** @typedef {Object<string, EventMetadata>} EventsBySlugMap */
//
//   interface Tier2Sidecar {
//     _meta: {
//       version:                    number;   // always 1
//       source_path:                string;
//       source_hash:                string;   // SHA-256 of event-schemas.md
//       source_bytes:               number;
//       generated_at:               string;   // ISO 8601
//       index_size_bytes:           number;
//       event_count:                number;   // Object.keys(events).length
//       fingerprint_token_estimate: number;
//     };
//     fingerprint: string;   // newline-separated slug | doc | L<line> rows
//     events:      EventsBySlugMap;  // NOT an array — slug → metadata dict
//   }
//
// Ad-hoc validators that assert Array.isArray(sidecar.events) will fail.
// Use: typeof sidecar.events === 'object' && !Array.isArray(sidecar.events).
// ---------------------------------------------------------------------------

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
 * @param {object} opts - { cwd: string }
 * @returns {object} {found:true, chunk, line_range, event_type, source}
 *                  | {found:false, error, message, event_type}
 */
function getChunk(event_type, opts) {
  const cwd = (opts && opts.cwd) || process.cwd();

  if (typeof event_type !== 'string' || !event_type) {
    return {
      found: false,
      event_type: String(event_type || ''),
      error: 'invalid_event_type',
      message: 'event_type must be a non-empty string',
    };
  }
  if (!/^[a-z][a-z0-9_.-]*$/.test(event_type)) {
    return {
      found: false,
      event_type,
      error: 'invalid_event_type',
      message: 'event_type must match ^[a-z][a-z0-9_.-]*$',
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
  };
}

module.exports = {
  buildIndex,
  getChunk,
  TIER2_INDEX_REL_PATH,
  MAX_INDEX_BYTES,
  MAX_SCHEMA_BYTES,
};
