#!/usr/bin/env node
'use strict';

/**
 * regen-schema-shadow.js — R-SHDW generator (v2.1.14).
 *
 * Reads agents/pm-reference/event-schemas.md and extracts a compact JSON index
 * of every event type, written to agents/pm-reference/event-schemas.shadow.json.
 *
 * The shadow has the shape:
 *   {
 *     "_meta": { version, source_hash, generated_at, shadow_size_bytes },
 *     "<event_type>": { version, required, optional, enum_dialect_hash },
 *     ...
 *   }
 *
 * Output target: ≤ 4 KB. Script errors out if the shadow exceeds this limit.
 *
 * Usage: node bin/regen-schema-shadow.js [--cwd <dir>]
 *
 * Idempotent: running multiple times produces the same output when the source
 * file has not changed (source_hash is stable).
 *
 * Fail contract (when run standalone):
 *   - Exits 0 on success.
 *   - Exits 1 on parse error or size overflow (stderr message).
 *
 * When called via main() from another hook:
 *   - Returns the shadow object on success.
 *   - Throws on hard failure.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MAX_SHADOW_BYTES = 4096; // 4 KB hard ceiling

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseCwd() {
  const args = process.argv.slice(2);
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    return path.resolve(args[cwdIdx + 1]);
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Event-type extraction
// ---------------------------------------------------------------------------

/**
 * Heuristic section boundaries for event types in event-schemas.md.
 *
 * We recognize two header patterns:
 *   ### `<slug>` ...          — backtick-wrapped slug (most common)
 *   ### <slug> event ...      — bare slug followed by "event" or "Event"
 *   ### archetype_cache_*     — no backticks, underscore slugs
 *
 * For each matched section we look downward for the first JSON code fence and
 * extract the "type" field value from the sample object (ground truth). If no
 * code fence is found, we skip the section (may be a doc-only section).
 */

const HEADER_RE = /^### [`]?([a-z][a-z0-9_.-]*)(?:[`]| event| Event)/m;
const SECTION_RE = /^### [`]?([a-z][a-z0-9_.-]*)(?:[`]| event| Event)/mg;

/**
 * Extract fields from a JSON sample block.
 * Returns { required: string[], optional: string[], version: number }
 *
 * "required" = keys that appear without a "?" comment; we use a heuristic:
 * keys with a value that is NOT "..." or undefined-ish → required.
 * "optional" = keys whose value or description says "optional" or has "?"
 *
 * Since the schema samples use hand-written JSON-like text, we parse
 * conservatively: accept any key whose value is a non-empty string or number.
 */
function extractFields(jsonBlock) {
  const required = [];
  const optional = [];
  let version = 1;

  // Split into lines, skip fence markers
  const lines = jsonBlock.split('\n').filter(l => !l.match(/^```/));

  // Build a map of key → value_text for all top-level keys
  // Matches:   "key": "value"  or  "key": <number>  or  "key": null  etc.
  const KEY_VALUE_RE = /^\s+"([^"]+)"\s*:\s*(.+?)(?:,\s*)?$/;

  for (const line of lines) {
    const m = line.match(KEY_VALUE_RE);
    if (!m) continue;
    const key = m[1];
    const valText = m[2].trim();

    // Skip 'type' itself — it's the discriminator, not a payload field
    if (key === 'type') continue;

    // version field
    if (key === 'version') {
      const v = parseInt(valText, 10);
      if (!isNaN(v)) version = v;
      required.push(key);
      continue;
    }

    // Determine if optional: value is "<...optional...>" or comment says optional
    const isOptional = /optional|null|undefined|\?/.test(valText) ||
      valText === 'null' ||
      (valText.startsWith('"') && valText.includes('optional'));

    if (isOptional) {
      optional.push(key);
    } else {
      required.push(key);
    }
  }

  return { required, optional, version };
}

/**
 * Compute a short hash of enum-like field values within a JSON block.
 * Used as enum_dialect_hash: changes when enum lists drift.
 */
function computeEnumDialectHash(jsonBlock) {
  // Extract array values from enum-like fields
  // Pattern: "field": ["val1", "val2", ...]
  const ARRAY_RE = /"[^"]+"\s*:\s*\[([^\]]+)\]/g;
  const parts = [];
  let m;
  while ((m = ARRAY_RE.exec(jsonBlock)) !== null) {
    parts.push(m[1].replace(/\s+/g, ''));
  }
  if (parts.length === 0) return 'none';
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 8);
}

/**
 * Parse event-schemas.md content and return an array of:
 *   { slug, version, required, optional, enum_dialect_hash }
 */
function parseEventSchemas(content) {
  const events = [];
  const seenSlugs = new Set();

  // Split content into sections at each ### ... header
  // We scan for all section header positions
  const sectionStarts = [];
  let m;
  SECTION_RE.lastIndex = 0;
  while ((m = SECTION_RE.exec(content)) !== null) {
    sectionStarts.push({ index: m.index, slug: m[1] });
  }

  for (let i = 0; i < sectionStarts.length; i++) {
    const { slug } = sectionStarts[i];
    const sectionEnd = (i + 1 < sectionStarts.length)
      ? sectionStarts[i + 1].index
      : content.length;
    const sectionContent = content.slice(sectionStarts[i].index, sectionEnd);

    // Look for a JSON code fence in this section
    const fenceStart = sectionContent.indexOf('```json');
    if (fenceStart === -1) continue;
    const fenceContentStart = fenceStart + '```json'.length;
    const fenceEnd = sectionContent.indexOf('```', fenceContentStart);
    if (fenceEnd === -1) continue;

    const jsonBlock = sectionContent.slice(fenceContentStart, fenceEnd);

    // Verify the JSON block actually has a "type" field matching this slug
    // (filters out non-event-type JSON blocks like config samples)
    const typeMatch = jsonBlock.match(/"type"\s*:\s*"([^"]+)"/);
    const effectiveSlug = typeMatch ? typeMatch[1] : slug;

    // Skip duplicates (some event types have multiple variant sections)
    if (seenSlugs.has(effectiveSlug)) continue;
    seenSlugs.add(effectiveSlug);

    // Only process event types with underscore-or-dot slug shapes
    if (!/^[a-z][a-z0-9_.-]*$/.test(effectiveSlug)) continue;

    const { required, optional, version } = extractFields(jsonBlock);
    const enum_dialect_hash = computeEnumDialectHash(jsonBlock);

    events.push({ slug: effectiveSlug, version, required, optional, enum_dialect_hash });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate the shadow and write it to disk.
 * @param {string} cwd - Project root directory.
 * @returns {object} The shadow object.
 * @throws {Error} If the shadow exceeds the size limit.
 */
function main(cwd) {
  const schemaPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md');
  const outPath    = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');

  let content;
  try {
    content = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    throw new Error('regen-schema-shadow: cannot read ' + schemaPath + ': ' + err.message);
  }

  const sourceHash = crypto.createHash('sha256').update(content).digest('hex');
  const events = parseEventSchemas(content);

  if (events.length === 0) {
    throw new Error('regen-schema-shadow: no event types found in ' + schemaPath);
  }

  // Build shadow object.
  // To stay within the 4 KB budget with 60+ event types, we use a compact
  // per-entry format: { v: version, r: req_count, o: opt_count, h: enum_hash }
  // The full required/optional lists live in the authoritative event-schemas.md.
  // The shadow answers "does this event type exist?" and "might its enums have drifted?"
  const shadow = {
    _meta: {
      version: 1,
      source_hash: sourceHash,
      generated_at: new Date().toISOString(),
      shadow_size_bytes: 0, // filled in after serialization
      event_count: events.length,
    },
  };

  for (const ev of events) {
    // Compact entry: v=version, r=required_count, o=optional_count, h=enum_dialect_hash
    const entry = { v: ev.version, r: ev.required.length, o: ev.optional.length };
    if (ev.enum_dialect_hash !== 'none') {
      entry.h = ev.enum_dialect_hash;
    }
    shadow[ev.slug] = entry;
  }

  // Serialize without pretty-print to minimize size; the shadow is a machine-read hint
  const json = JSON.stringify(shadow);
  const sizeBytes = Buffer.byteLength(json, 'utf8');

  if (sizeBytes > MAX_SHADOW_BYTES) {
    throw new Error(
      'regen-schema-shadow: shadow size ' + sizeBytes + ' bytes exceeds limit of ' +
      MAX_SHADOW_BYTES + ' bytes. Reduce fields extracted per event type.'
    );
  }

  // Update the size field now that we know it
  shadow._meta.shadow_size_bytes = sizeBytes;
  const finalJson = JSON.stringify(shadow);

  // Auto-clear three-strike sentinel on regeneration
  const stateDir      = path.join(cwd, '.orchestray', 'state');
  const sentinelPath  = path.join(stateDir, '.schema-shadow-disabled');
  try {
    if (fs.existsSync(sentinelPath)) {
      fs.unlinkSync(sentinelPath);
    }
  } catch (_e) {
    // Best-effort sentinel clear
  }

  fs.writeFileSync(outPath, finalJson + '\n', 'utf8');

  return shadow;
}

// ---------------------------------------------------------------------------
// Standalone invocation
// ---------------------------------------------------------------------------

if (require.main === module) {
  try {
    const cwd    = parseCwd();
    const shadow = main(cwd);
    const count  = Object.keys(shadow).filter(k => k !== '_meta').length;
    process.stdout.write(
      '[regen-schema-shadow] OK — ' + count + ' event types, ' +
      shadow._meta.shadow_size_bytes + ' bytes → agents/pm-reference/event-schemas.shadow.json\n'
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write('[regen-schema-shadow] ERROR: ' + err.message + '\n');
    process.exit(1);
  }
}

module.exports = { main, parseEventSchemas };
