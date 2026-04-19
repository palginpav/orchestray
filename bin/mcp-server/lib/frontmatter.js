'use strict';

/**
 * Flat-YAML frontmatter parser, stringifier, and atomic field rewriter for
 * Orchestray pattern files.
 *
 * See CHANGELOG.md §2.0.11 (Stage 2 MCP tools & resources) for design context.
 *
 * Supported frontmatter syntax (the subset Orchestray actually writes):
 *   key: string            foo: bar baz
 *   key: number            times_applied: 3
 *   key: decimal           confidence: 0.75
 *   key: boolean           active: true
 *   key: null              last_applied: null
 *   key: "quoted"          description: "A string with: colons"
 *   key: 'single-quoted'
 *   key: [a, b, c]        layer_b_markers: [marker1, marker2]  (inline array)
 *
 * NOT supported: nested objects, multi-line scalars, anchors, tags.
 * Unknown types are preserved as strings so round-trip rewrites don't
 * destroy data.
 *
 * v2.1.6 additions (W4):
 *   Optional proposed-pattern fields: tip_type, proposed, proposed_at,
 *   proposed_from, schema_version, layer_b_markers. All are optional and
 *   never required for existing patterns/*.md files.
 *   layer_b_markers uses inline YAML array syntax: [item1, item2].
 *
 * Exports:
 *   parse(content)                    -> { frontmatter, body, hasFrontmatter }
 *   stringify({ frontmatter, body })  -> string
 *   rewriteField(filepath, field, v)  -> { ok: true } | { ok: false, error }
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

function parse(content) {
  if (typeof content !== 'string') {
    return { frontmatter: {}, body: '', hasFrontmatter: false };
  }

  // File must start with "---" followed by a newline. If it doesn't, treat
  // as bodyless (no frontmatter).
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  // Find the closing "---" line. Split on newlines and walk.
  const firstBreak = content.indexOf('\n');
  // After the first "---\n" line, the rest is the candidate frontmatter + body.
  let searchFrom = firstBreak + 1;
  const closingMatch = _findClosingDelimiter(content, searchFrom);

  if (closingMatch === -1) {
    // Malformed: opening --- with no closing. Return partial. Per §6, this
    // is tolerant: parse must not throw. hasFrontmatter is false (we
    // couldn't close it), and body is the entire original content so the
    // caller can decide whether to error.
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const fmText = content.slice(searchFrom, closingMatch.start);
  const body = content.slice(closingMatch.end);

  const frontmatter = _parseFlatYaml(fmText);
  return { frontmatter, body, hasFrontmatter: true };
}

function _findClosingDelimiter(content, from) {
  // Scan line-by-line starting at offset `from`. A line that consists of
  // exactly "---" (optionally followed by trailing whitespace then newline
  // or EOF) is the closing delimiter.
  let i = from;
  while (i < content.length) {
    const lineEnd = content.indexOf('\n', i);
    const nextIdx = lineEnd === -1 ? content.length : lineEnd;
    const line = content.slice(i, nextIdx).replace(/\r$/, '');
    if (line.trim() === '---') {
      // `start` points at the `-` of the delimiter; `end` at the newline
      // character itself (the body includes that newline so round-trips
      // don't mutate whitespace).
      return { start: i, end: lineEnd === -1 ? content.length : lineEnd };
    }
    if (lineEnd === -1) break;
    i = lineEnd + 1;
  }
  return -1;
}

function _parseFlatYaml(text) {
  const out = {};
  if (!text || text.length === 0) return out;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    // A valid key line has the form `key: value`. A line without `:` is
    // malformed and is skipped silently (parse must be tolerant — see §6).
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key.length === 0) continue;
    // Also: skip keys that contain whitespace — those are not valid YAML
    // scalar keys and indicate malformation.
    if (/\s/.test(key)) continue;
    let rawValue = line.slice(colonIdx + 1).trim();
    out[key] = _parseValue(rawValue);
  }
  return out;
}

function _parseValue(raw) {
  // Empty / "null" / "~" -> null
  if (raw === '' || raw === 'null' || raw === '~') return null;
  // Booleans (case-sensitive — matches Stage 2 plan §6)
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Inline array: [item1, item2, ...] — used by layer_b_markers (v2.1.6 W4)
  // Tolerant: elements may be quoted or unquoted scalars. Nested arrays are
  // not supported — they are preserved as strings.
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return _parseInlineArray(raw);
  }
  // Quoted strings — strip the matching pair.
  if (raw.length >= 2) {
    if (raw.startsWith('"') && raw.endsWith('"')) {
      // B4-05: decode all JSON string escape sequences so that values written
      // via JSON.stringify (e.g. multi-line approach/description fields) round-
      // trip correctly. The inner slice is a valid JSON string literal so
      // JSON.parse is the authoritative decoder.
      try {
        return JSON.parse(raw);
      } catch (_) {
        // Malformed JSON literal — fall back to simple unquoting so existing
        // behaviour for simple values is preserved.
        return raw.slice(1, -1).replace(/\\"/g, '"');
      }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) {
      return raw.slice(1, -1);
    }
  }
  // Numeric: integer or decimal with optional sign.
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  // Fallback: treat as string (preserve unknown scalars verbatim).
  return raw;
}

/**
 * Parse an inline YAML array literal of the form `[item1, item2, ...]`.
 * Supports unquoted strings and single/double-quoted strings as elements.
 * Empty array `[]` returns [].
 * Returns an array of strings (or the original raw string on parse failure).
 *
 * @param {string} raw  - The raw string including leading `[` and trailing `]`.
 * @returns {string[]|string}
 */
function _parseInlineArray(raw) {
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];

  const items = [];
  let i = 0;
  while (i < inner.length) {
    // Skip leading whitespace / commas.
    if (inner[i] === ',' || inner[i] === ' ' || inner[i] === '\t') {
      i++;
      continue;
    }
    // Quoted element.
    if (inner[i] === '"' || inner[i] === "'") {
      const quote = inner[i];
      i++;
      let val = '';
      while (i < inner.length && inner[i] !== quote) {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          i++; // skip backslash
          val += inner[i];
        } else {
          val += inner[i];
        }
        i++;
      }
      i++; // consume closing quote
      items.push(val);
    } else {
      // Unquoted element — read until comma or end.
      const start = i;
      while (i < inner.length && inner[i] !== ',') i++;
      items.push(inner.slice(start, i).trim());
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// stringify
// ---------------------------------------------------------------------------

function stringify(parts) {
  const frontmatter = (parts && parts.frontmatter) || {};
  const body = (parts && parts.body) || '';
  const keys = Object.keys(frontmatter);
  if (keys.length === 0) return body;

  const lines = ['---'];
  for (const k of keys) {
    lines.push(k + ': ' + _serializeValue(frontmatter[k]));
  }
  lines.push('---');
  // The closing --- has no trailing newline in the block itself; the body
  // (if non-empty) supplies its own leading newline per the parse contract.
  // If body is empty, emit a trailing newline so the file ends on a clean
  // line.
  const fmBlock = lines.join('\n');
  if (body.length === 0) return fmBlock + '\n';
  // If body doesn't start with a newline (unusual — would happen if a
  // caller constructs one by hand), insert one so the closing --- is still
  // on its own line.
  if (body[0] !== '\n' && body[0] !== '\r') return fmBlock + '\n' + body;
  return fmBlock + body;
}

function _serializeValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) {
    // Serialize as inline YAML array: [item1, item2, ...]
    // Each element is serialized with the scalar rules (no nested arrays).
    const elems = v.map((el) => {
      if (el === null) return 'null';
      if (typeof el === 'boolean') return el ? 'true' : 'false';
      if (typeof el === 'number' && Number.isFinite(el)) return String(el);
      const s = String(el);
      // Quote if the element contains commas, brackets, or quotes.
      if (s === '' || s.includes(',') || s.includes('[') || s.includes(']') ||
          s.includes('"') || s.includes("'") || s !== s.trim()) {
        return JSON.stringify(s);
      }
      return s;
    });
    return '[' + elems.join(', ') + ']';
  }
  if (typeof v === 'string') {
    // Only quote if needed: empty, leading/trailing whitespace, contains
    // a leading `#`, or would otherwise be reinterpreted on round-trip.
    if (v === '') return '""';
    if (v !== v.trim()) return JSON.stringify(v);
    if (v === 'true' || v === 'false' || v === 'null' || v === '~') return JSON.stringify(v);
    if (/^-?\d+(\.\d+)?$/.test(v)) return JSON.stringify(v);
    // B4-05: strings containing newlines, carriage returns, tabs, or backslashes
    // must be JSON-quoted so they occupy exactly one YAML line and round-trip
    // correctly through _parseValue's JSON.parse branch.
    if (/[\n\r\t\\]/.test(v)) return JSON.stringify(v);
    return v;
  }
  // Fallback: toString.
  return String(v);
}

// ---------------------------------------------------------------------------
// rewriteField
// ---------------------------------------------------------------------------

/**
 * Concurrent-writer race intentional in Stage 2; acceptable because PM serializes
 * pattern_record_application calls. To fix: wrap in bin/_lib/atomic-append.js
 * lockfile helper. See CHANGELOG.md §2.0.11 for the original rationale.
 */
function rewriteField(filepath, fieldName, newValue) {
  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, error: 'ENOENT' };
    if (err && err.code === 'EACCES') return { ok: false, error: 'EACCES' };
    return { ok: false, error: err && err.code ? err.code : 'read_failed' };
  }

  // Detect the malformed-frontmatter case BEFORE calling parse(), since
  // parse() is tolerant and silently degrades to { hasFrontmatter: false }.
  // We need to distinguish "no frontmatter at all" from "opening --- with
  // no closing ---" so we return the right error.
  const hasOpening = content.startsWith('---\n') || content.startsWith('---\r\n');
  if (hasOpening) {
    const firstBreak = content.indexOf('\n');
    const closing = _findClosingDelimiter(content, firstBreak + 1);
    if (closing === -1) {
      try {
        process.stderr.write(
          '[orchestray-mcp] frontmatter: malformed (no closing ---) ' + filepath + '\n'
        );
      } catch (_e) { /* swallow */ }
      return { ok: false, error: 'malformed_frontmatter' };
    }
  }

  const parsed = parse(content);
  // At this point we either had real frontmatter or had none — both are
  // valid for rewriteField; the field is simply added in the latter case.
  const nextFm = {};
  let replaced = false;
  for (const [k, v] of Object.entries(parsed.frontmatter)) {
    if (k === fieldName) {
      nextFm[k] = newValue;
      replaced = true;
    } else {
      nextFm[k] = v;
    }
  }
  if (!replaced) {
    nextFm[fieldName] = newValue;
  }

  const next = stringify({ frontmatter: nextFm, body: parsed.body });

  // Atomic tmp+rename. Same-directory tmp file so rename is a single fs op.
  // Predictable `.tmp` suffix is acceptable for a single-user local plugin:
  // the project directory has the same trust boundary as the process writing
  // to it. If the plugin is ever used in a multi-user or network-mounted
  // setting, replace with fs.mkdtempSync. Per T14 audit.
  const tmp = filepath + '.tmp';
  try {
    fs.writeFileSync(tmp, next, 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    return { ok: false, error: err && err.code ? err.code : 'write_failed' };
  }
  try {
    fs.renameSync(tmp, filepath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    try {
      process.stderr.write(
        '[orchestray-mcp] frontmatter: rename failed for ' + filepath + ': ' +
        (err && err.message ? err.message : String(err)) + '\n'
      );
    } catch (_e) { /* swallow */ }
    return { ok: false, error: 'rename_failed' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// writeFrontmatter (B1 v2.1.0)
// ---------------------------------------------------------------------------

/**
 * Atomically write a complete frontmatter + body to a file.
 *
 * Behaviour:
 *   - If the file already exists, the new frontmatter is written with keys in
 *     the SAME ORDER as the existing frontmatter (preserving round-trip key order
 *     for human-readable files). Any keys in `frontmatter` that were not in the
 *     original are appended after the preserved keys in their original argument
 *     order. Any keys in the original that are NOT in `frontmatter` are omitted
 *     (i.e., writeFrontmatter fully replaces the frontmatter, it does not merge).
 *   - If the file does not exist (or cannot be read), the frontmatter keys are
 *     written in their argument order.
 *   - The write is atomic: a `.tmp` sibling is written then renamed.
 *   - The body is written as-is. If body is null/undefined, empty string is used.
 *
 * This function does NOT perform any validation of the frontmatter values —
 * that is the caller's responsibility. It only handles YAML serialisation.
 *
 * YAML edge-case handling (delegated to the existing _serializeValue helper):
 *   - Strings containing colons are double-quoted.
 *   - Multi-line values are stringified via JSON.stringify (yields single-line
 *     escaped string). Full block-scalar support is out of scope for this format.
 *   - This matches the existing `stringify`/`rewriteField` behaviour — no
 *     regression for consumers that were already using those paths.
 *
 * @param {string} filePath - Absolute path to write.
 * @param {object} frontmatter - Key-value map of frontmatter fields.
 * @param {string|null} body - Markdown body (after the closing ---).
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function writeFrontmatter(filePath, frontmatter, body) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'filePath must be a non-empty string' };
  }
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { ok: false, error: 'frontmatter must be a plain object' };
  }

  const bodyStr = (body == null) ? '' : String(body);

  // Attempt to load existing file to preserve key order.
  let existingKeyOrder = [];
  try {
    const existingContent = fs.readFileSync(filePath, 'utf8');
    const parsed = parse(existingContent);
    if (parsed.hasFrontmatter) {
      existingKeyOrder = Object.keys(parsed.frontmatter);
    }
  } catch (_e) {
    // File absent or unreadable — use argument order.
    existingKeyOrder = [];
  }

  // Build the ordered frontmatter object:
  // 1. Existing keys that appear in the new frontmatter (preserves order).
  // 2. New keys that did NOT appear in the existing frontmatter (appended).
  const newKeys = Object.keys(frontmatter);
  const ordered = {};
  for (const k of existingKeyOrder) {
    if (k in frontmatter) {
      ordered[k] = frontmatter[k];
    }
  }
  for (const k of newKeys) {
    if (!(k in ordered)) {
      ordered[k] = frontmatter[k];
    }
  }

  const content = stringify({ frontmatter: ordered, body: bodyStr });

  const tmp = filePath + '.tmp';
  try {
    // Ensure the parent directory exists (common when writing to a new shared dir).
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    return { ok: false, error: err && err.code ? err.code : 'write_failed' };
  }

  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    return { ok: false, error: 'rename_failed' };
  }

  return { ok: true, path: filePath };
}

module.exports = {
  parse,
  stringify,
  rewriteField,
  // B1 (v2.1.0): full frontmatter+body write for the promote pipeline
  writeFrontmatter,
};
