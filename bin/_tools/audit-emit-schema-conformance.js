#!/usr/bin/env node
'use strict';

/**
 * audit-emit-schema-conformance.js — static payload/schema conformance sweep
 * (W7, v2.3.33).
 *
 * A prior regex-based attempt (a ±800-character window around each `type:`
 * literal) claimed 97 candidate violations but had an unacceptable
 * false-positive rate: it could not tell a literal object payload from one
 * built via a spread, a helper function, or several statements, so it
 * "found" fields that were in fact present via a route it couldn't see.
 *
 * This tool replaces that guess with a bounded, honest static technique:
 * brace-matched extraction of the literal object argument passed to each
 * known writer entry point, plus a narrow, explicitly-scoped trace of the
 * single-hop case where the payload is a local variable assigned an object
 * literal earlier in the same file. It does NOT parse JavaScript into an
 * AST — Node ships no AST parser in stdlib, the repo's only parser
 * dependency (`web-tree-sitter`) is wired for repo-map's multi-language
 * grammars and not for this kind of single-purpose lint, and the project's
 * stack rules (CLAUDE.md "What NOT to Add") forbid new heavy deps for a
 * dev/test tool. Brace-matching + single-hop identifier tracing is a
 * deliberately narrow technique with a known failure mode (see
 * UNANALYSABLE below) — it is honest about what it cannot prove rather than
 * asserting a false total.
 *
 * ---------------------------------------------------------------------
 * Writer entry points covered (found by grepping every file that requires
 * `audit-event-writer.js`, not assumed):
 *   - `writeEvent(payload, opts?)`
 *   - `writeEventWithAliases(payload, opts?)`
 *   - `writeAuditEvent(payload, opts?)`        (the module's default export,
 *                                                called directly by name in
 *                                                a few sites)
 *   - `_writeEvent(payload, opts?)`             (local aliases bound to
 *                                                `mod.writeEvent` /
 *                                                `mod.writeEventWithAliases`
 *                                                in context-telemetry-cache.js
 *                                                and repo-map.js)
 *   - local `emitAuditEvent(...)` wrappers — 16 files define their own
 *     `function emitAuditEvent(...)` that forwards to the writer above.
 *     Two call shapes exist and are detected per-file from the wrapper's
 *     own definition, not assumed:
 *       (a) `emitAuditEvent(cwd, record)` — record IS the payload.
 *       (b) `emitAuditEvent(cwd, eventType, extra)` — payload is
 *           `Object.assign({ type: eventType }, extra)`.
 *
 * ---------------------------------------------------------------------
 * Autofilled fields (excluded from the required-field check): verified
 * against `AUTOFILL_ALLOWLIST` in bin/_lib/audit-event-writer.js (not
 * trusted from the task prompt) — `version`, `timestamp`, `ts`,
 * `orchestration_id`, `session_id` — plus `schema_version`, which
 * `normalizeVersionFields()` in the same file cross-fills from `version`
 * whenever only one of the two is present.
 *
 * ---------------------------------------------------------------------
 * Classification (three-way, never collapsed):
 *   - CLEAN       — every required (non-autofilled) field is a provable
 *                    literal key in the payload.
 *   - VIOLATION   — the payload is fully literal (or single-hop-traced) and
 *                    provably lacks a required field.
 *   - UNANALYSABLE — the payload's shape cannot be statically proven, e.g.:
 *       * the writer argument is a function-call expression
 *         (`buildFoo({...})`, `Object.assign(base, dynamicVar)`);
 *       * the payload is an identifier with no traceable local `const`/`let`
 *         object-literal declaration in the same file;
 *       * the object literal (or the identifier's declaration) contains a
 *         top-level spread (`...x`) — a spread can supply additional
 *         required keys we cannot see, so an apparent "missing" key cannot
 *         be asserted as a real violation;
 *       * the `type` value itself is not a string literal (computed/
 *         variable), so which schema to check against is unknown.
 *     UNANALYSABLE sites are counted and reported, never silently folded
 *     into CLEAN or VIOLATION.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');

const { parseEventSchemas } = require('../_lib/event-schemas-parser');

// Verified against bin/_lib/audit-event-writer.js `AUTOFILL_ALLOWLIST`
// (version, timestamp, ts, orchestration_id, session_id) plus
// `normalizeVersionFields()`'s version<->schema_version cross-fill.
const AUTOFILLED_FIELDS = new Set([
  'version', 'schema_version', 'timestamp', 'ts', 'orchestration_id', 'session_id',
]);

const WRITER_CALL_NAMES = ['writeEvent', 'writeEventWithAliases', 'writeAuditEvent', '_writeEvent'];

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

function listJsFiles(dir) {
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (_e) {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__tests__') continue;
        walk(p);
      } else if (e.name.endsWith('.js')) {
        out.push(p);
      }
    }
  }
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Comment stripping (string-aware; preserves line numbers by replacing
// comment characters with spaces rather than deleting them)
// ---------------------------------------------------------------------------

/**
 * Heuristic for "is this `/` the start of a regex literal, not division?"
 * True when the last non-whitespace character emitted so far is an operator/
 * punctuation character a regex can legally follow (or output is empty —
 * start of file/statement), or the trailing token is a keyword regexes
 * commonly follow (`return`, `typeof`, `case`). False for anything that
 * looks like the end of an identifier/number/`)`/`]` — those contexts mean
 * `/` is division.
 */
function looksLikeRegexContext(outSoFar) {
  const trimmed = outSoFar.replace(/\s+$/, '');
  if (trimmed === '') return true;
  const last = trimmed[trimmed.length - 1];
  if ('([{,;:=!&|?+~^%<>-*'.includes(last)) return true;
  if (/\b(?:return|typeof|case|in|of|instanceof|new|do|else|yield|await)$/.test(trimmed)) return true;
  return false;
}

/**
 * Blank out `//` and `/* *\/` comments AND regex literals, leaving string/
 * template contents untouched. Without this, a comment containing a comma
 * or an unbalanced bracket (both common in this codebase's inline prose)
 * corrupts the top-level comma-split and brace-depth tracking used
 * everywhere below — and a regex literal's character class can contain a
 * bare `"` or `'` that would otherwise be misread as a string delimiter,
 * desyncing every subsequent quote/comment boundary in the file (found
 * empirically: bin/_lib/event-quarantine.js's secret-pattern regex
 * `[=:\s"']+` contains both quote characters inside a character class).
 * Regex literals are blanked wholesale (like comments) rather than passed
 * through — they never legitimately appear inside a `writeEvent(...)`
 * payload argument, so there is nothing structural to preserve.
 * Line numbers are preserved (newlines inside comments/regexes survive).
 */
function stripComments(src) {
  let out = '';
  let inStr = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const c2 = src[i + 1];
    if (inLineComment) {
      if (c === '\n') { inLineComment = false; out += c; } else { out += ' '; }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && c2 === '/') { inBlockComment = false; out += '  '; i += 1; }
      else { out += (c === '\n' ? '\n' : ' '); }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') { out += (src[i + 1] || ''); i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; continue; }
    if (c === '/' && c2 === '/') { inLineComment = true; out += '  '; i += 1; continue; }
    if (c === '/' && c2 === '*') { inBlockComment = true; out += '  '; i += 1; continue; }
    if (c === '/' && c2 !== undefined && looksLikeRegexContext(out)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < src.length) {
        const cj = src[j];
        if (cj === '\n') break; // regex literals cannot span a raw newline — bail, not a regex
        if (cj === '\\') { j += 2; continue; }
        if (cj === '[') { inClass = true; j += 1; continue; }
        if (cj === ']') { inClass = false; j += 1; continue; }
        if (cj === '/' && !inClass) { j += 1; closed = true; break; }
        j += 1;
      }
      if (closed) {
        while (j < src.length && /[a-z]/i.test(src[j])) j += 1;
        for (let k = i; k < j; k += 1) out += (src[k] === '\n' ? '\n' : ' ');
        i = j - 1;
        continue;
      }
      // Not a real regex literal (unterminated before newline) — fall
      // through and treat the `/` as an ordinary character (division).
    }
    out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Brace/paren-balanced extraction helpers
// ---------------------------------------------------------------------------

/** Find the index just past the matching close for the open bracket at `openIdx`. */
function findMatchingClose(src, openIdx, openCh, closeCh) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === openCh) depth += 1;
    else if (c === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a paren-balanced call's argument list (text between the outer
 * `(` and its matching `)`, exclusive) into top-level comma-separated
 * argument strings.
 */
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let inStr = null;
  let cur = '';
  for (let i = 0; i < argsText.length; i += 1) {
    const c = argsText[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += argsText[++i] || ''; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') args.push(cur);
  return args.map((s) => s.trim());
}

/** True when a call's own textual argument list begins with a `{`. */
function isObjectLiteral(argText) {
  return /^\{/.test(argText.trim());
}

/**
 * Extract top-level key names (and whether a top-level spread is present)
 * from an object-literal source string INCLUDING the outer `{`/`}`.
 */
function extractLiteralShape(objLiteralText) {
  const inner = objLiteralText.trim().replace(/^\{/, '').replace(/\}$/, '');
  const keys = [];
  let hasSpread = false;
  let depth = 0;
  let inStr = null;
  let cur = '';
  const stmts = [];
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (inStr) {
      cur += c;
      if (c === '\\') { cur += inner[++i] || ''; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '{' || c === '[' || c === '(') depth += 1;
    else if (c === '}' || c === ']' || c === ')') depth -= 1;
    if (c === ',' && depth === 0) { stmts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') stmts.push(cur);

  for (const stmt of stmts) {
    const s = stmt.replace(/\/\/.*$/m, '').trim();
    if (s === '') continue;
    if (s.startsWith('...')) { hasSpread = true; continue; }
    // `key: value` or shorthand `key` or computed `[expr]: value` (unanalysable key name).
    const km = s.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/) || s.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (km) { keys.push(km[1]); continue; }
    if (s.startsWith('[')) { hasSpread = true; continue; } // computed key — treat as unanalysable-widening
  }
  return { keys, hasSpread };
}

/** Get the string-literal value of a top-level `type:` key, or null. */
function extractTypeLiteral(objLiteralText) {
  const m = objLiteralText.match(/(?:^|[{,])\s*type\s*:\s*(['"])([a-z][a-z0-9_.-]*)\1/);
  return m ? m[2] : null;
}

// ---------------------------------------------------------------------------
// Per-file wrapper detection
// ---------------------------------------------------------------------------

/** Detect a local `function emitAuditEvent(...)` shape, or null if absent. */
function detectLocalWrapperShape(src) {
  const m = src.match(/function\s+emitAuditEvent\s*\(([^)]*)\)/);
  if (!m) return null;
  const params = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  if (params.length === 2) return 'record'; // emitAuditEvent(cwd, record)
  if (params.length === 3) return 'typeExtra'; // emitAuditEvent(cwd, eventType, extra)
  return null; // unrecognized shape — do not guess
}

// ---------------------------------------------------------------------------
// Single-hop identifier tracing
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve a bare identifier used as a writer argument to a
 * literal object by finding the nearest preceding `const/let IDENT = {`
 * declaration in the same file, then folding in any `IDENT.key = value;`
 * mutations between the declaration and the call site. Returns
 * `{ text, hasSpread }` or `null` if untraceable.
 */
function traceIdentifierLiteral(src, ident, callIdx) {
  const declRe = new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*\\{', 'g');
  let best = null;
  let m;
  while ((m = declRe.exec(src)) !== null) {
    if (m.index >= callIdx) break;
    best = m;
  }
  if (!best) return null;

  const openIdx = best.index + best[0].length - 1; // index of the `{`
  const closeIdx = findMatchingClose(src, openIdx, '{', '}');
  if (closeIdx === -1) return null;

  const { keys, hasSpread } = extractLiteralShape(src.slice(openIdx, closeIdx + 1));
  const mutKeys = [];
  const mutRe = new RegExp(ident + '\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*=', 'g');
  mutRe.lastIndex = closeIdx;
  let mm;
  let sawOtherMutation = false;
  while ((mm = mutRe.exec(src)) !== null) {
    if (mm.index >= callIdx) break;
    mutKeys.push(mm[1]);
  }
  // Object.assign(ident, ...) between decl and call widens the shape
  // unpredictably — bail to untraceable rather than guess.
  const assignRe = new RegExp('Object\\.assign\\(\\s*' + ident + '\\s*,', 'g');
  assignRe.lastIndex = closeIdx;
  const am = assignRe.exec(src);
  if (am && am.index < callIdx) sawOtherMutation = true;

  if (sawOtherMutation) return null;

  return { keys: keys.concat(mutKeys), hasSpread, typeLiteral: extractTypeLiteral(src.slice(openIdx, closeIdx + 1)) };
}

/**
 * `writeAuditEvent` is ambiguous: `bin/_lib/audit-event-writer.js` exports a
 * "legacy hook helper" factory of that exact name — `writeAuditEvent({
 * type, mode, extraFieldsPicker, additionalEventsPicker })` — which reads
 * stdin itself and builds the real payload at runtime by calling
 * `extraFieldsPicker(event)`. Its config-object argument is NOT the emitted
 * payload and must never be key-checked against the schema directly. A
 * handful of other files (e.g. bin/mcp-server/lib/audit.js) define their
 * OWN local `writeAuditEvent(event)` that simply forwards `event` to
 * `writeEvent` unchanged — for those, the generic first-arg-is-the-payload
 * handling is correct. Distinguish by checking whether the file's
 * `writeAuditEvent` binding traces back to a `require(...audit-event-writer)`
 * (default import or destructured) rather than guessing from call shape.
 */
function importsFactoryWriteAuditEvent(src) {
  return new RegExp(
    '(?:const|let|var)\\s+(?:\\{[^}]*\\bwriteAuditEvent\\b[^}]*\\}|writeAuditEvent)\\s*=\\s*require\\([^)]*audit-event-writer[^)]*\\)'
  ).test(src);
}

// ---------------------------------------------------------------------------
// Core sweep
// ---------------------------------------------------------------------------

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length;
}

function analyzeFile(relFile, rawSrc, schemaByType) {
  const results = [];
  const src = stripComments(rawSrc); // string-aware; line numbers preserved
  const wrapperShape = detectLocalWrapperShape(src);
  const factoryWriteAuditEvent = importsFactoryWriteAuditEvent(src);

  const names = WRITER_CALL_NAMES.slice();
  if (wrapperShape) names.push('emitAuditEvent');

  const callRe = new RegExp('(?:^|[^.\\w])(' + names.join('|') + ')\\s*\\(', 'g');
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const name = m[1];
    const callParenIdx = m.index + m[0].length - 1;

    // Skip the writer's own function declaration lines.
    const linePrefix = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(linePrefix)) continue;

    const closeParenIdx = findMatchingClose(src, callParenIdx, '(', ')');
    if (closeParenIdx === -1) continue;
    const argsText = src.slice(callParenIdx + 1, closeParenIdx);
    const args = splitTopLevelArgs(argsText);
    const line = lineOf(src, m.index);
    const site = { file: relFile, line, name };

    if (name === 'writeAuditEvent' && factoryWriteAuditEvent) {
      results.push(Object.assign({}, site, {
        status: 'UNANALYSABLE',
        reason: 'writeAuditEvent factory shape — real payload is assembled at runtime by extraFieldsPicker(event), not statically visible',
      }));
      continue;
    }

    let literalKeys = null;
    let hasSpread = false;
    let typeSlug = null;

    if (name === 'emitAuditEvent' && wrapperShape === 'record') {
      const payloadArg = args[1];
      if (payloadArg && isObjectLiteral(payloadArg)) {
        const shape = extractLiteralShape(payloadArg);
        literalKeys = shape.keys;
        hasSpread = shape.hasSpread;
        typeSlug = extractTypeLiteral(payloadArg);
      } else if (payloadArg && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(payloadArg)) {
        const traced = traceIdentifierLiteral(src, payloadArg, m.index);
        if (traced) { literalKeys = traced.keys; hasSpread = traced.hasSpread; typeSlug = traced.typeLiteral; }
      }
    } else if (name === 'emitAuditEvent' && wrapperShape === 'typeExtra') {
      const typeArg = args[1];
      const extraArg = args[2];
      const tm = typeArg && typeArg.match(/^(['"])([a-z][a-z0-9_.-]*)\1$/);
      typeSlug = tm ? tm[2] : null;
      if (typeSlug && extraArg) {
        if (isObjectLiteral(extraArg)) {
          const shape = extractLiteralShape(extraArg);
          literalKeys = shape.keys.concat(['type']);
          hasSpread = shape.hasSpread;
        } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(extraArg)) {
          const traced = traceIdentifierLiteral(src, extraArg, m.index);
          if (traced) { literalKeys = traced.keys.concat(['type']); hasSpread = traced.hasSpread; }
        }
      } else if (typeSlug && !extraArg) {
        literalKeys = ['type'];
      }
    } else {
      // Gateway entry points: payload is the first argument.
      const payloadArg = args[0];
      if (payloadArg && isObjectLiteral(payloadArg)) {
        const shape = extractLiteralShape(payloadArg);
        literalKeys = shape.keys;
        hasSpread = shape.hasSpread;
        typeSlug = extractTypeLiteral(payloadArg);
      } else if (payloadArg && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(payloadArg)) {
        const traced = traceIdentifierLiteral(src, payloadArg, m.index);
        if (traced) { literalKeys = traced.keys; hasSpread = traced.hasSpread; typeSlug = traced.typeLiteral; }
      }
    }

    if (literalKeys === null) {
      results.push(Object.assign({}, site, { status: 'UNANALYSABLE', reason: 'payload is not a literal object and not a single-hop-traceable identifier' }));
      continue;
    }
    if (!typeSlug) {
      results.push(Object.assign({}, site, { status: 'UNANALYSABLE', reason: 'event type is not a string literal (computed/variable)' }));
      continue;
    }
    const schema = schemaByType.get(typeSlug);
    if (!schema) {
      // Not declared in event-schemas.md at all — out of scope for this
      // sweep (covered by schema-declared-types-parseable.test.js, W5).
      results.push(Object.assign({}, site, { status: 'CLEAN', type: typeSlug, reason: 'no declared schema for this type (out of scope for W7)' }));
      continue;
    }
    const required = (schema.required || []).filter((f) => !AUTOFILLED_FIELDS.has(f));
    const missing = required.filter((f) => !literalKeys.includes(f));
    if (missing.length === 0) {
      results.push(Object.assign({}, site, { status: 'CLEAN', type: typeSlug }));
    } else if (hasSpread) {
      results.push(Object.assign({}, site, {
        status: 'UNANALYSABLE', type: typeSlug,
        reason: 'top-level spread may supply the apparently-missing field(s): ' + missing.join(', '),
      }));
    } else {
      results.push(Object.assign({}, site, { status: 'VIOLATION', type: typeSlug, missing }));
    }
  }

  return results;
}

function sweep() {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const schemas = parseEventSchemas(schemaContent);
  const schemaByType = new Map(schemas.map((s) => [s.slug, s]));

  const files = listJsFiles(path.join(REPO_ROOT, 'bin'));
  let all = [];
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs);
    const src = fs.readFileSync(abs, 'utf8');
    all = all.concat(analyzeFile(rel, src, schemaByType));
  }

  const violations = all.filter((r) => r.status === 'VIOLATION');
  const unanalysable = all.filter((r) => r.status === 'UNANALYSABLE');
  const clean = all.filter((r) => r.status === 'CLEAN');

  return { all, violations, unanalysable, clean };
}

function main() {
  const { violations, unanalysable, clean } = sweep();
  process.stdout.write(
    'Emit-site schema conformance sweep: ' +
    clean.length + ' CLEAN, ' + violations.length + ' VIOLATION, ' +
    unanalysable.length + ' UNANALYSABLE\n',
  );
  for (const v of violations) {
    process.stderr.write('  VIOLATION ' + v.file + ':' + v.line + ' [' + v.type + '] missing: ' + v.missing.join(', ') + '\n');
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  sweep, analyzeFile, listJsFiles, AUTOFILLED_FIELDS,
  _internal: { stripComments, extractLiteralShape, findMatchingClose, splitTopLevelArgs, extractTypeLiteral },
};
