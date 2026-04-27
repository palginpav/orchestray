'use strict';

/**
 * event-schemas-parser.js — shared parser for agents/pm-reference/event-schemas.md (P1.3, v2.2.0).
 *
 * Refactor-extract from bin/regen-schema-shadow.js. Both the schema-shadow
 * generator and the new tier2-index generator (bin/_lib/tier2-index.js) consume
 * this module so the two outputs can never disagree about which slugs the
 * source file declares.
 *
 * The parser is heuristic: it walks every level-3 heading whose text matches
 * SECTION_RE, finds the first `json` code-fence in the section, and extracts
 * the slug + required/optional/version fields from that block.
 *
 * Exports:
 *   SECTION_RE                 — RegExp used to enumerate sections.
 *   extractFields(jsonBlock)   — { required, optional, version }
 *   computeEnumDialectHash(jb) — short hash of array/enum-shaped values.
 *   parseEventSchemas(content) — base shape compatible with regen-schema-shadow.js.
 *   parseEventSchemasWithRanges(content) — extended shape adding line_range +
 *                                          short_doc + section_text for the
 *                                          tier2-index sidecar.
 *
 * The two parse functions share the same section walk so they cannot diverge
 * on slug coverage. parseEventSchemasWithRanges is a strict superset; the
 * shadow generator deliberately ignores the extra fields.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Heading patterns
// ---------------------------------------------------------------------------
//
// We recognize three header shapes:
//   ### `<slug>` ...      — backtick-wrapped slug (most common)
//   ### <slug> event ...  — bare slug followed by "event" or "Event"
//   ### archetype_cache_* — no backticks, underscore slugs
//
// Slugs are restricted to `^[a-z][a-z0-9_.-]*$`.

const SECTION_RE = /^### [`]?([a-z][a-z0-9_.-]*)(?:[`]| event| Event)/mg;

/**
 * Extract fields from a JSON sample block.
 * Returns { required: string[], optional: string[], version: number }.
 *
 * Hand-written JSON-like text inside the code fence is parsed conservatively:
 *   - Any `"key": value` line is captured.
 *   - `version` is always required and parsed as an int when possible.
 *   - The `type` discriminator key is excluded.
 *   - A line is "optional" if its value text mentions optional/null/?
 */
function extractFields(jsonBlock) {
  const required = [];
  const optional = [];
  let version = 1;

  const lines = jsonBlock.split('\n').filter((l) => !l.match(/^```/));
  const KEY_VALUE_RE = /^\s+"([^"]+)"\s*:\s*(.+?)(?:,\s*)?$/;

  for (const line of lines) {
    const m = line.match(KEY_VALUE_RE);
    if (!m) continue;
    const key = m[1];
    const valText = m[2].trim();

    if (key === 'type') continue;

    if (key === 'version') {
      const v = parseInt(valText, 10);
      if (!isNaN(v)) version = v;
      required.push(key);
      continue;
    }

    const isOptional =
      /optional|null|undefined|\?/.test(valText) ||
      valText === 'null' ||
      (valText.startsWith('"') && valText.includes('optional'));

    if (isOptional) optional.push(key);
    else required.push(key);
  }

  return { required, optional, version };
}

/**
 * Compute a short hash of enum-like field values within a JSON block.
 * Used as enum_dialect_hash: changes when enum lists drift.
 */
function computeEnumDialectHash(jsonBlock) {
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
 * Walk the markdown content and return the section anchors. Each entry is
 *   { index, slug }
 * where `index` is the byte offset of the heading line.
 */
function _enumerateSections(content) {
  const anchors = [];
  let m;
  // Re-create the regex per call so concurrent callers do not race on lastIndex.
  const re = new RegExp(SECTION_RE.source, SECTION_RE.flags);
  while ((m = re.exec(content)) !== null) {
    anchors.push({ index: m.index, slug: m[1] });
  }
  return anchors;
}

/**
 * Convert a byte offset to a 1-based line number.
 */
function _offsetToLine(content, offset) {
  if (offset <= 0) return 1;
  // count newline chars before the offset
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Parse event-schemas.md content into the legacy shadow shape:
 *   [{ slug, version, required, optional, enum_dialect_hash }]
 *
 * Sections that do not contain a JSON code fence are silently skipped.
 */
function parseEventSchemas(content) {
  const events = [];
  const seenSlugs = new Set();
  const anchors = _enumerateSections(content);

  for (let i = 0; i < anchors.length; i++) {
    const { slug } = anchors[i];
    const sectionEnd = i + 1 < anchors.length ? anchors[i + 1].index : content.length;
    const sectionContent = content.slice(anchors[i].index, sectionEnd);

    const fenceStart = sectionContent.indexOf('```json');
    if (fenceStart === -1) continue;
    const fenceContentStart = fenceStart + '```json'.length;
    const fenceEnd = sectionContent.indexOf('```', fenceContentStart);
    if (fenceEnd === -1) continue;

    const jsonBlock = sectionContent.slice(fenceContentStart, fenceEnd);

    const typeMatch = jsonBlock.match(/"type"\s*:\s*"([^"]+)"/);
    const effectiveSlug = typeMatch ? typeMatch[1] : slug;

    if (seenSlugs.has(effectiveSlug)) continue;
    seenSlugs.add(effectiveSlug);

    if (!/^[a-z][a-z0-9_.-]*$/.test(effectiveSlug)) continue;

    const { required, optional, version } = extractFields(jsonBlock);
    const enum_dialect_hash = computeEnumDialectHash(jsonBlock);

    events.push({ slug: effectiveSlug, version, required, optional, enum_dialect_hash });
  }

  return events;
}

/**
 * Parse event-schemas.md into the richer tier2-index shape:
 *   [{ slug, version, required, optional, enum_dialect_hash,
 *      line_range:[startLine,endLine], short_doc, section_text }]
 *
 * `line_range` is 1-based and inclusive; `endLine` is the last line of the
 * section (i.e. the line just before the next ### heading, or EOF).
 *
 * `short_doc` is the first non-blank, non-heading line of the section, capped
 * at 200 characters; null if no prose precedes the JSON fence.
 *
 * `section_text` is the raw markdown slice for that section. Callers that
 * only need metadata can drop this field.
 */
function parseEventSchemasWithRanges(content) {
  const events = [];
  const seenSlugs = new Set();
  const anchors = _enumerateSections(content);
  const totalLines = (content.match(/\n/g) || []).length + 1;

  for (let i = 0; i < anchors.length; i++) {
    const { slug } = anchors[i];
    const startOffset = anchors[i].index;
    const sectionEnd = i + 1 < anchors.length ? anchors[i + 1].index : content.length;
    const sectionContent = content.slice(startOffset, sectionEnd);

    const fenceStart = sectionContent.indexOf('```json');
    if (fenceStart === -1) continue;
    const fenceContentStart = fenceStart + '```json'.length;
    const fenceEnd = sectionContent.indexOf('```', fenceContentStart);
    if (fenceEnd === -1) continue;

    const jsonBlock = sectionContent.slice(fenceContentStart, fenceEnd);

    const typeMatch = jsonBlock.match(/"type"\s*:\s*"([^"]+)"/);
    const effectiveSlug = typeMatch ? typeMatch[1] : slug;

    if (seenSlugs.has(effectiveSlug)) continue;
    seenSlugs.add(effectiveSlug);

    if (!/^[a-z][a-z0-9_.-]*$/.test(effectiveSlug)) continue;

    const { required, optional, version } = extractFields(jsonBlock);
    const enum_dialect_hash = computeEnumDialectHash(jsonBlock);

    const startLine = _offsetToLine(content, startOffset);
    // endLine is the line of the last byte of the section (excluding the next
    // heading). If sectionEnd hit EOF, use totalLines; else compute one less
    // than the line of the next heading so the ranges are inclusive and
    // non-overlapping.
    let endLine;
    if (i + 1 < anchors.length) {
      const nextLine = _offsetToLine(content, anchors[i + 1].index);
      endLine = Math.max(startLine, nextLine - 1);
    } else {
      endLine = totalLines;
    }

    // short_doc: first non-blank, non-heading line of the section.
    const sectionLines = sectionContent.split('\n');
    let shortDoc = null;
    for (let j = 1; j < sectionLines.length; j++) {
      const ln = sectionLines[j].trim();
      if (!ln) continue;
      if (ln.startsWith('#')) continue;
      if (ln.startsWith('```')) break;
      shortDoc = ln.length > 200 ? ln.slice(0, 200) : ln;
      break;
    }

    events.push({
      slug: effectiveSlug,
      version,
      required,
      optional,
      enum_dialect_hash,
      line_range: [startLine, endLine],
      short_doc: shortDoc,
      section_text: sectionContent,
    });
  }

  return events;
}

module.exports = {
  SECTION_RE,
  extractFields,
  computeEnumDialectHash,
  parseEventSchemas,
  parseEventSchemasWithRanges,
};
