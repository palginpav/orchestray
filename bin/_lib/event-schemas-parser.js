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
 *   parseEventSchemasFromFile()— mtime-aware cached parse of the canonical
 *                                event-schemas.md. Use this instead of reading
 *                                the file manually — it re-parses automatically
 *                                when the file changes mid-session.
 *   clearFileCache()           — reset the file-level cache (for testing).
 *
 * The two parse functions share the same section walk so they cannot diverge
 * on slug coverage. parseEventSchemasWithRanges is a strict superset; the
 * shadow generator deliberately ignores the extra fields.
 *
 * W5 (v2.2.18) — mtime-based cache invalidation:
 *   parseEventSchemasFromFile() stat()s the schema file on every call and
 *   re-parses only when mtimeMs changes. This ensures that mid-session edits
 *   to event-schemas.md take effect immediately on the next validate() call
 *   without requiring a process restart.
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ---------------------------------------------------------------------------
// File-level mtime cache (W5, v2.2.18)
// ---------------------------------------------------------------------------

// Candidate paths to the schema source file, tried in order (W5, v2.3.32).
//
// Two on-disk layouts exist for this module, and which one is active cannot
// be assumed at require-time:
//   1. Source repo:     <repo>/bin/_lib/event-schemas-parser.js
//                        → <repo>/agents/pm-reference/event-schemas.md
//                        (two levels up from bin/_lib/, then agents/pm-reference/).
//   2. Installed tree:   bin/install.js copies agents/** into
//                        <targetDir>/agents/pm-reference/* (install() step 1)
//                        and bin/_lib/** into
//                        <targetDir>/orchestray/bin/_lib/* (install() step 3,
//                        via the `dstLibDir` copy). __dirname is therefore
//                        <targetDir>/orchestray/bin/_lib, so the schema file
//                        lives THREE levels up (…/_lib → …/bin → …/orchestray
//                        → <targetDir>), then agents/pm-reference/event-schemas.md.
//
// Before this fix SCHEMA_PATH only ever tried candidate (1). In an installed
// tree that resolves to <targetDir>/orchestray/agents/pm-reference/…, which
// never exists — schema validation silently no-oped on every hook invocation
// outside the source repo. See the `event_schema_unreadable` degraded-journal
// kind and the once-per-process stderr warning in audit-event-writer.js.
//
// Candidate (1) is tried first so source/test behaviour is byte-identical to
// before this change.
const SCHEMA_PATH_CANDIDATES = [
  path.resolve(__dirname, '..', '..', 'agents', 'pm-reference', 'event-schemas.md'),
  path.resolve(__dirname, '..', '..', '..', 'agents', 'pm-reference', 'event-schemas.md'),
];

/**
 * First candidate that exists on disk, or the repo-layout candidate (index 0)
 * if neither exists — giving callers a stable path to stat/read either way.
 * Fail-open behaviour on a missing file is handled by callers (statSync/
 * readFileSync throw ENOENT, which parseEventSchemasFromFile()'s caller
 * catches — see schema-emit-validator.js getSchemas()).
 */
function _resolveSchemaPath() {
  for (const candidate of SCHEMA_PATH_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return SCHEMA_PATH_CANDIDATES[0];
}

// Resolved once at require-time — a plain string, as existing callers
// (schema-emit-validator.js, tests) read SCHEMA_PATH as a value, not a
// function. This does not conflict with the mtime-aware cache below: that
// cache invalidates on the *content* of the resolved file changing; the
// candidate *search* only needs to run once per process because a process's
// own install layout does not change during its lifetime.
const SCHEMA_PATH = _resolveSchemaPath();

let _fileCachedSchemas  = null;  // Array<EventSchema> | null
let _fileCachedMtimeMs  = 0;     // mtimeMs of the file at last parse
let _lastStatHitMs      = 0;     // Date.now() when last stat confirmed cache hit (S-3 rate-limit)

/**
 * Minimum interval between stat calls in milliseconds when the prior stat
 * confirmed the cache is still fresh (S-3 defense-in-depth for slow disks).
 * Only applies after a confirmed cache-hit; a cache miss always re-stats immediately.
 */
const STAT_TTL_MS = 100;

/**
 * Emit a schema_cache_invalidated event to the audit log.
 * Must never throw under any error condition.
 *
 * @param {{ prior_mtime: number, new_mtime: number|null, cause: string, error_code?: string, schema_event_count?: number }} payload
 */
function _emitCacheInvalidation(payload) {
  if (process.env.ORCHESTRAY_SCHEMA_CACHE_EMIT_DISABLED === '1') return; // documented kill switch
  try {
    const evt = Object.assign(
      { type: 'schema_cache_invalidated', ts: new Date().toISOString(), version: 1 },
      payload
    );
    // Route through the canonical audit writer when available.
    // Use a dynamic require to avoid circular-dependency issues at module load
    // time (audit-event-writer → schema-emit-validator → event-schemas-parser).
    let wrote = false;
    try {
      const writer = require('./audit-event-writer');
      if (typeof writer.writeEvent === 'function') {
        writer.writeEvent(evt, { skipValidation: true });
        wrote = true;
      }
    } catch (_) { /* writer unavailable — fall through to raw append */ }

    if (!wrote) {
      // Fallback: direct fs.appendFileSync to the events.jsonl
      // process.cwd() gives the project root inside Claude Code hooks.
      const eventsPath = path.join(process.cwd(), '.orchestray', 'audit', 'events.jsonl');
      try {
        fs.appendFileSync(eventsPath, JSON.stringify(evt) + '\n');
      } catch (_) { /* silently ignore — audit writer is best-effort */ }
    }
  } catch (_) { /* outer safety net — _emitCacheInvalidation must never throw */ }
}

/**
 * Return parsed event schemas, re-reading event-schemas.md only when its
 * mtime has changed since the last parse.
 *
 * Env override: if ORCHESTRAY_SCHEMA_CACHE_INVALIDATION_DISABLED=1, the
 * mtime check is skipped and the first-parse cache is used for the process
 * lifetime (legacy behavior, useful for profiling or debugging).
 *
 * @returns {Array<EventSchema>} — same shape as parseEventSchemas(content).
 * @throws  {Error}             — only when no cache exists AND stat/read fails.
 */
function parseEventSchemasFromFile() {
  // Legacy mode: skip mtime checks (opt-in escape hatch).
  if (process.env.ORCHESTRAY_SCHEMA_CACHE_INVALIDATION_DISABLED === '1') {
    if (_fileCachedSchemas !== null) return _fileCachedSchemas;
    const content = fs.readFileSync(SCHEMA_PATH, 'utf8');
    _fileCachedSchemas = parseEventSchemas(content);
    _fileCachedMtimeMs = 0; // sentinel: mtime tracking disabled
    return _fileCachedSchemas;
  }

  // S-3: rate-limit stat calls — only skip stat when the prior stat confirmed
  // a cache hit (mtime unchanged) within the last STAT_TTL_MS (100 ms).
  // A cache miss always forces an immediate stat on the next call.
  const now = Date.now();
  if (_fileCachedSchemas !== null && _lastStatHitMs > 0 && now - _lastStatHitMs < STAT_TTL_MS) {
    return _fileCachedSchemas;
  }

  // Stat the file to get current mtime (≤5ms budget per spec).
  let currentMtimeMs;
  try {
    currentMtimeMs = fs.statSync(SCHEMA_PATH).mtimeMs;
  } catch (statErr) {
    if (_fileCachedSchemas !== null) {
      // Degraded: file deleted or unreadable mid-session — keep last-known cache.
      _emitCacheInvalidation({
        prior_mtime:        _fileCachedMtimeMs,
        new_mtime:          null,
        cause:              'stat_failed',
        error_code:         statErr.code || 'UNKNOWN',
        schema_event_count: _fileCachedSchemas.length,
      });
      return _fileCachedSchemas;
    }
    // No cache at all — hard fail so callers can handle gracefully.
    throw statErr;
  }

  // Cache hit: mtime unchanged.
  if (_fileCachedSchemas !== null && currentMtimeMs === _fileCachedMtimeMs) {
    _lastStatHitMs = now; // S-3: record hit time to gate next stat
    return _fileCachedSchemas;
  }

  // Cache miss: re-parse.
  const priorMtime = _fileCachedMtimeMs;
  const content    = fs.readFileSync(SCHEMA_PATH, 'utf8');
  _fileCachedSchemas = parseEventSchemas(content);
  _fileCachedMtimeMs = currentMtimeMs;

  // Emit invalidation event only on a real mid-session cache miss (not on
  // the very first parse where priorMtime is 0).
  if (priorMtime > 0) {
    _emitCacheInvalidation({
      prior_mtime:        priorMtime,
      new_mtime:          currentMtimeMs,
      cause:              'mtime_changed',
      schema_event_count: _fileCachedSchemas.length,
    });
  }

  return _fileCachedSchemas;
}

/**
 * Reset the file-level mtime cache.  For testing only.
 */
function clearFileCache() {
  _fileCachedSchemas = null;
  _fileCachedMtimeMs = 0;
  _lastStatHitMs     = 0;
}

// ---------------------------------------------------------------------------
// Heading patterns
// ---------------------------------------------------------------------------
//
// We recognize four header shapes:
//   ### `<slug>` ...               — backtick-wrapped slug (most common)
//   ### <slug> event ...           — bare slug followed by "event" or "Event"
//   ### archetype_cache_* ...      — no backticks, underscore slugs
//   ### <prefix prose> — `<slug>`  — prefix prose then backtick slug
//                                    (e.g. `### Variant D — \`routing_decision\``)
//
// Slugs are restricted to `^[a-z][a-z0-9_.-]*$`.
//
// FN-32 (v2.2.15) — The strict `SECTION_RE` only catches the first three
// shapes. Sections written as `### Variant <X> — \`slug\`` were silently
// skipped, leaving the slug undeclared and the shadow short by ~30 events.
// `SECTION_RE_PREFIXED` recovers them as a backstop pass: any heading that
// contains a backtick-wrapped slug regardless of leading prose. Slug-shape
// validation in the parse loop and the requirement that the section contain
// a `\`\`\`json` fence with a matching `"type":` value still apply, so this
// looser pattern cannot pollute the slug set.

const SECTION_RE          = /^### [`]?([a-z][a-z0-9_.-]*)(?:[`]| event| Event)/mg;
const SECTION_RE_PREFIXED = /^### [^`\n]*[`]([a-z][a-z0-9_.-]*)[`]/mg;

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

  // v2.3.33 W8: only capture keys of the TOP-LEVEL object. Previously every
  // `"key": value` line was captured regardless of nesting, so keys inside a
  // nested array/object (e.g. contract_check's `checks: [{target, result,
  // detail}]`) were hoisted into the event's own required list. That made
  // correctly-shaped emitters look like schema violations.
  let depth = 0;

  for (const line of lines) {
    const m = line.match(KEY_VALUE_RE);
    const openers = (line.match(/[{[]/g) || []).length;
    const closers = (line.match(/[}\]]/g) || []).length;
    // depth BEFORE this line's own brackets decides whether its key is top-level:
    // the outermost `{` sits on its own line, putting real top-level keys at depth 1.
    const depthAtKey = depth;
    depth += openers - closers;

    if (!m) continue;
    if (depthAtKey !== 1) continue; // nested key — belongs to a sub-object, not the event
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
 * F3 (v2.2.9) — detect the `feature_optional: true` flag in a section's
 * Field-notes block. Used by `bin/audit-promised-events.js` to skip events
 * that are legitimately dark (opt-in slash commands, negative-path guards,
 * untriggered failure-recovery paths).
 *
 * The flag is conventional Field-notes text:
 *   `- feature_optional: true (...)`
 * The leading bullet marker, surrounding whitespace, and trailing parenthesised
 * justification are all optional. Only `true` triggers; `false` or missing
 * leaves the event subject to the F3 dark-surface alarm.
 *
 * @param {string} sectionText — the raw markdown of one event-section.
 * @returns {boolean}
 */
function parseFeatureOptional(sectionText) {
  if (typeof sectionText !== 'string' || sectionText.length === 0) return false;
  // Match a line like:  - feature_optional: true (...)
  // Allow leading whitespace, optional bullet, and trailing prose.
  const re = /^\s*[-*]?\s*feature_optional\s*:\s*true\b/m;
  return re.test(sectionText);
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
 *
 * Two-pass walk (FN-32, v2.2.15):
 *   1. Strict `SECTION_RE` catches the canonical heading shapes.
 *   2. Fallback `SECTION_RE_PREFIXED` recovers headings whose slug appears
 *      after prefix prose (e.g. `### Variant D — \`routing_decision\``).
 *
 * Each `index` is unique per heading line — duplicates from pass 2 are dropped
 * when pass 1 already anchored the same line. The downstream slug-shape filter
 * and `\`\`\`json` fence requirement guarantee that loose pass-2 matches whose
 * sections do not declare a `"type":` are silently skipped (no slug pollution).
 */
function _enumerateSections(content) {
  const anchors = [];
  const seenIndexes = new Set();

  // Pass 1: strict canonical shape (existing behaviour). fromFallback: false
  // because the heading itself IS the event declaration ("### `slug`" /
  // "### slug event") — a missing "type" match in the section's json fence
  // may safely fall back to this heading-captured slug.
  // Re-create the regex per call so concurrent callers do not race on lastIndex.
  let m;
  const re1 = new RegExp(SECTION_RE.source, SECTION_RE.flags);
  while ((m = re1.exec(content)) !== null) {
    if (!seenIndexes.has(m.index)) {
      anchors.push({ index: m.index, slug: m[1], fromFallback: false });
      seenIndexes.add(m.index);
    }
  }

  // Pass 2: fallback for prefix-prose headings (e.g. Variant D). fromFallback:
  // true — the backtick token here is incidental prose (e.g. "Tombstone
  // `rationale` field", "Degraded-journal `kind` additions"), not necessarily
  // a declared event type. Callers must NOT fall back to this heading slug
  // when the section's json fence lacks a matching "type" key (see D6,
  // v2.3.18 W1b — 4 prose headings were being scraped as bogus event types:
  // rationale, kind, manifest.json, rationale.similarity_score).
  const re2 = new RegExp(SECTION_RE_PREFIXED.source, SECTION_RE_PREFIXED.flags);
  while ((m = re2.exec(content)) !== null) {
    if (!seenIndexes.has(m.index)) {
      anchors.push({ index: m.index, slug: m[1], fromFallback: true });
      seenIndexes.add(m.index);
    }
  }

  // Sort by file offset so section-end calculations remain monotonic.
  anchors.sort(function (a, b) { return a.index - b.index; });
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
    const { slug, fromFallback } = anchors[i];
    const sectionEnd = i + 1 < anchors.length ? anchors[i + 1].index : content.length;
    const sectionContent = content.slice(anchors[i].index, sectionEnd);

    const fenceStart = sectionContent.indexOf('```json');
    if (fenceStart === -1) continue;
    const fenceContentStart = fenceStart + '```json'.length;
    const fenceEnd = sectionContent.indexOf('```', fenceContentStart);
    if (fenceEnd === -1) continue;

    const jsonBlock = sectionContent.slice(fenceContentStart, fenceEnd);

    const typeMatch = jsonBlock.match(/"type"\s*:\s*"([^"]+)"/);
    // A pass-2 (prefix-prose) anchor with no matching "type" key is prose
    // discussing a field/file name, not an event declaration — skip it
    // rather than registering it under the heading's incidental slug.
    if (!typeMatch && fromFallback) continue;
    const effectiveSlug = typeMatch ? typeMatch[1] : slug;

    if (seenSlugs.has(effectiveSlug)) continue;
    seenSlugs.add(effectiveSlug);

    if (!/^[a-z][a-z0-9_.-]*$/.test(effectiveSlug)) continue;

    const { required, optional, version } = extractFields(jsonBlock);
    const enum_dialect_hash = computeEnumDialectHash(jsonBlock);
    const feature_optional  = parseFeatureOptional(sectionContent);

    events.push({ slug: effectiveSlug, version, required, optional, enum_dialect_hash, feature_optional });
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
    const { slug, fromFallback } = anchors[i];
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
    // See parseEventSchemas() above — fallback anchors without a matching
    // "type" key are prose, not a schema declaration.
    if (!typeMatch && fromFallback) continue;
    const effectiveSlug = typeMatch ? typeMatch[1] : slug;

    if (seenSlugs.has(effectiveSlug)) continue;
    seenSlugs.add(effectiveSlug);

    if (!/^[a-z][a-z0-9_.-]*$/.test(effectiveSlug)) continue;

    const { required, optional, version } = extractFields(jsonBlock);
    const enum_dialect_hash = computeEnumDialectHash(jsonBlock);
    const feature_optional  = parseFeatureOptional(sectionContent);

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
      feature_optional,
      line_range: [startLine, endLine],
      short_doc: shortDoc,
      section_text: sectionContent,
    });
  }

  return events;
}

module.exports = {
  SECTION_RE,
  SECTION_RE_PREFIXED,
  extractFields,
  computeEnumDialectHash,
  parseFeatureOptional,
  parseEventSchemas,
  parseEventSchemasWithRanges,
  parseEventSchemasFromFile,
  clearFileCache,
  // Expose for testing only — not part of the public API.
  _getFileCacheState: () => ({ mtimeMs: _fileCachedMtimeMs, hasCache: _fileCachedSchemas !== null }),
  SCHEMA_PATH,
};
