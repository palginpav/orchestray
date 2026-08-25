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
 * Split an object-literal's inner text (no outer `{`/`}`) into top-level
 * `key: value` / shorthand-`key` / `...spread` statement strings. Shared by
 * `extractLiteralShape` and the `type`/`event_type` value-text lookups below
 * so both walk the same brace/string-aware split exactly once.
 */
function splitObjectStatements(inner) {
  const stmts = [];
  let depth = 0;
  let inStr = null;
  let cur = '';
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
  return stmts;
}

/**
 * Extract top-level key names (and whether a top-level spread is present)
 * from an object-literal source string INCLUDING the outer `{`/`}`. Also
 * returns the raw RHS text of a `type:`/`event_type:` key when present, for
 * type-slug resolution by the caller. `event_type` and `type` are treated as
 * aliases in the returned `keys` list: `bin/_lib/audit-event-writer.js`
 * (`normalizeVersionFields`, ~line 438) cross-fills whichever of the two is
 * missing from whichever is present before the write, so a payload carrying
 * only one of them satisfies a schema's requirement for either name.
 */
function extractLiteralShape(objLiteralText) {
  const inner = objLiteralText.trim().replace(/^\{/, '').replace(/\}$/, '');
  const keys = [];
  let hasSpread = false;
  let typeValueText = null;
  let eventTypeValueText = null;

  for (const stmt of splitObjectStatements(inner)) {
    const s = stmt.replace(/\/\/.*$/m, '').trim();
    if (s === '') continue;
    if (s.startsWith('...')) { hasSpread = true; continue; }
    // `key: value` or shorthand `key` or computed `[expr]: value` (unanalysable key name).
    const kvm = s.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.+)$/s);
    const shorthandM = !kvm && s.match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (kvm) {
      keys.push(kvm[1]);
      if (kvm[1] === 'type') typeValueText = kvm[2].trim();
      if (kvm[1] === 'event_type') eventTypeValueText = kvm[2].trim();
      continue;
    }
    if (shorthandM) {
      keys.push(shorthandM[1]);
      if (shorthandM[1] === 'type') typeValueText = 'type'; // shorthand: value IS the identifier `type`
      if (shorthandM[1] === 'event_type') eventTypeValueText = 'event_type';
      continue;
    }
    if (s.startsWith('[')) { hasSpread = true; continue; } // computed key — treat as unanalysable-widening
  }
  if (keys.includes('event_type') && !keys.includes('type')) keys.push('type');
  if (keys.includes('type') && !keys.includes('event_type')) keys.push('event_type');
  return { keys, hasSpread, typeValueText, eventTypeValueText };
}

/**
 * Split a top-level ternary `COND ? A : B` into its three parts, ignoring
 * `?`/`:` nested inside parens/brackets/braces/strings, or `null` if the
 * text isn't a simple top-level ternary. Deliberately does not special-case
 * `?.` / `??` — those never appear as the split point of a real ternary
 * condition in this codebase's emit sites, and a false split would just
 * fail downstream candidate resolution rather than mis-report a type.
 */
function splitTernary(text) {
  let depth = 0;
  let inStr = null;
  let qIdx = -1;
  let cIdx = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i += 1; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth === 0 && c === '?' && qIdx === -1) qIdx = i;
    else if (depth === 0 && c === ':' && qIdx !== -1 && cIdx === -1) cIdx = i;
  }
  if (qIdx === -1 || cIdx === -1) return null;
  return [text.slice(0, qIdx).trim(), text.slice(qIdx + 1, cIdx).trim(), text.slice(cIdx + 1).trim()];
}

/**
 * Resolve a `type:` value-text expression to the set of candidate event-type
 * string literals it could evaluate to, or `null` if that can't be proven.
 * Handles a plain quoted literal, and a ternary (possibly chained) whose
 * every leaf is a quoted literal — e.g.
 * `won ? 'orchestration_start' : 'orchestration_start_denied'`. Any leaf
 * that isn't itself a literal or a further ternary of literals makes the
 * whole expression unresolvable (returns `null`), since the analyzer cannot
 * prove which value fires.
 */
function resolveTypeCandidates(valueText) {
  if (!valueText) return null;
  const text = valueText.trim().replace(/[,;]\s*$/, '').trim();
  const lit = text.match(/^(['"])([a-z][a-z0-9_.-]*)\1$/);
  if (lit) return [lit[2]];
  const tern = splitTernary(text);
  if (tern) {
    const a = resolveTypeCandidates(tern[1]);
    const b = resolveTypeCandidates(tern[2]);
    if (a && b) return Array.from(new Set(a.concat(b)));
  }
  return null;
}

/**
 * Trace a bare identifier used as a `type:` value back to the nearest
 * preceding `const/let IDENT = <expr>;` in the same file and resolve
 * `<expr>` via `resolveTypeCandidates`. Mirrors `traceIdentifierLiteral`'s
 * single-hop, same-file, nearest-preceding-declaration approach but for a
 * scalar (string/ternary) rather than an object literal.
 */
function traceScalarTypeValue(src, ident, refIdx) {
  const declRe = new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*([^;]+);', 'g');
  let best = null;
  let m;
  while ((m = declRe.exec(src)) !== null) {
    if (m.index >= refIdx) break;
    best = m;
  }
  if (!best) return null;
  return resolveTypeCandidates(best[1]);
}

/**
 * Resolve a `type:`/`event_type:` value-text expression to its candidate
 * list: a direct literal or inline ternary-of-literals first, else one hop
 * through a scalar `const`/`let` identifier declaration. Returns `null` if
 * unresolvable.
 */
function resolveTypeValueText(valueText, src, refIdx) {
  if (!valueText) return null;
  const direct = resolveTypeCandidates(valueText);
  if (direct) return direct;
  const identM = valueText.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)$/);
  if (identM && src && typeof refIdx === 'number') {
    return traceScalarTypeValue(src, identM[1], refIdx);
  }
  return null;
}

/**
 * Resolve the event-type candidate list for an object-literal payload,
 * following `type:`/`event_type:` (aliases), inline ternaries, and one hop
 * through a scalar `const`/`let` identifier. Returns `null` if unresolvable.
 */
function extractTypeCandidates(objLiteralText, src, refIdx) {
  const shape = extractLiteralShape(objLiteralText);
  return resolveTypeValueText(shape.typeValueText || shape.eventTypeValueText, src, refIdx);
}

/** Get the string-literal value of a top-level `type:` key, or null. Back-compat single-candidate helper. */
function extractTypeLiteral(objLiteralText) {
  const m = objLiteralText.match(/(?:^|[{,])\s*type\s*:\s*(['"])([a-z][a-z0-9_.-]*)\1/);
  return m ? m[2] : null;
}

// ---------------------------------------------------------------------------
// Single-hop identifier tracing
// ---------------------------------------------------------------------------

/**
 * Attempt to resolve a bare identifier used as a writer argument to a
 * literal object by finding the nearest preceding `const/let IDENT = {`
 * declaration in the same file, then folding in any `IDENT.key = value;`
 * mutations between the declaration and the call site. Returns
 * `{ keys, hasSpread, typeValueText }` or `null` if untraceable.
 */
function traceIdentifierLiteral(src, ident, callIdx) {
  // W9: also trace `const IDENT = Object.assign(...)` declarations — the
  // audit-event-writer.js rename-cycle-alias emitters build their payload
  // this way (`const attemptEvent = Object.assign({}, baseFields, {type: ...})`).
  const assignDeclRe = new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*(Object\\.assign\\s*\\()', 'g');
  let bestAssign = null;
  let am2;
  while ((am2 = assignDeclRe.exec(src)) !== null) {
    if (am2.index >= callIdx) break;
    bestAssign = am2;
  }

  const declRe = new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*\\{', 'g');
  let best = null;
  let m;
  while ((m = declRe.exec(src)) !== null) {
    if (m.index >= callIdx) break;
    best = m;
  }

  // Whichever declaration form is nearer to callIdx wins (matches "nearest
  // preceding declaration" semantics used for the plain-literal case).
  if (bestAssign && (!best || bestAssign.index > best.index)) {
    const openParenIdx = bestAssign.index + bestAssign[0].length - 1;
    const closeParenIdx = findMatchingClose(src, openParenIdx, '(', ')');
    if (closeParenIdx === -1) return null;
    const innerArgs = splitTopLevelArgs(src.slice(openParenIdx + 1, closeParenIdx));
    const merged = resolveAssignArgs(innerArgs, src, callIdx);
    return { keys: merged.keys, hasSpread: merged.hasSpread, typeValueText: merged.typeValueText };
  }

  if (!best) return null;

  const openIdx = best.index + best[0].length - 1; // index of the `{`
  const closeIdx = findMatchingClose(src, openIdx, '{', '}');
  if (closeIdx === -1) return null;

  const shape = extractLiteralShape(src.slice(openIdx, closeIdx + 1));
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

  return {
    keys: shape.keys.concat(mutKeys),
    hasSpread: shape.hasSpread,
    typeValueText: shape.typeValueText || shape.eventTypeValueText,
  };
}

/**
 * Extract the top-level argument texts of an `Object.assign(...)` call
 * given the call's own source text (e.g. `Object.assign({}, a, {b: 1})`),
 * or `null` if `argText` isn't an `Object.assign(` call.
 */
function objectAssignInnerArgs(argText) {
  const t = argText.trim();
  const m = /^Object\.assign\s*\(/.exec(t);
  if (!m) return null;
  const openIdx = m[0].length - 1;
  const closeIdx = findMatchingClose(t, openIdx, '(', ')');
  if (closeIdx === -1) return null;
  return splitTopLevelArgs(t.slice(openIdx + 1, closeIdx));
}

/**
 * Merge a concrete (non-parameterized) list of `Object.assign(...)` argument
 * texts — each either an object literal, a single-hop-traceable identifier,
 * or unknown — into `{ keys, hasSpread, typeValueText }`. An unknown source
 * (a function call, member access, or an identifier with no traceable
 * declaration) can supply arbitrary additional keys at runtime, so it widens
 * the shape (`hasSpread: true`) rather than invalidating what IS known from
 * the literal/traced portions — Object.assign never removes a key already
 * known to be present from an earlier argument, it can only add or override
 * values, so union-of-known-keys is safe for a presence check. `type`/
 * `event_type` resolution follows Object.assign's real semantics: the LAST
 * argument that defines the key wins.
 */
function resolveAssignArgs(argTexts, src, callIdx) {
  let keys = [];
  let hasSpread = false;
  let typeValueText = null;
  for (const argText of argTexts) {
    const t = argText.trim();
    if (isObjectLiteral(t)) {
      const shape = extractLiteralShape(t);
      keys = keys.concat(shape.keys);
      hasSpread = hasSpread || shape.hasSpread;
      const vt = shape.typeValueText || shape.eventTypeValueText;
      if (vt) typeValueText = vt;
      continue;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) {
      const traced = traceIdentifierLiteral(src, t, callIdx);
      if (traced) {
        keys = keys.concat(traced.keys);
        hasSpread = hasSpread || traced.hasSpread;
        if (traced.typeValueText) typeValueText = traced.typeValueText;
        continue;
      }
    }
    hasSpread = true; // unknown source (param, call, member expr, ...) — may supply more keys
  }
  return { keys: Array.from(new Set(keys)), hasSpread, typeValueText };
}

/**
 * Resolve a single writer-call payload argument's text to
 * `{ keys, hasSpread, typeValueText }`, or `null` if fully unresolvable.
 * Handles, in order: an object literal; an `Object.assign(...)` merge of
 * literals/traced-identifiers/unknowns (W9); a single-hop traced identifier;
 * and a call to a same-file "literal-returning helper" (W9) — a local
 * function whose entire body resolves to exactly one `return {literal};`
 * (all other return paths being bare/`null`/`undefined`), so its result
 * shape is invariant regardless of the caller's own arguments.
 */
function resolvePayloadArg(argText, src, callIdx, helperLiterals) {
  if (!argText) return null;
  const t = argText.trim();
  if (isObjectLiteral(t)) {
    const shape = extractLiteralShape(t);
    return { keys: shape.keys, hasSpread: shape.hasSpread, typeValueText: shape.typeValueText || shape.eventTypeValueText };
  }
  const assignArgs = objectAssignInnerArgs(t);
  if (assignArgs) return resolveAssignArgs(assignArgs, src, callIdx);
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t)) {
    const traced = traceIdentifierLiteral(src, t, callIdx);
    if (traced) return { keys: traced.keys, hasSpread: traced.hasSpread, typeValueText: traced.typeValueText };
    // Not an object-literal/Object.assign declaration — check whether it's
    // `const IDENT = helperName(...)` where `helperName` is a literal-
    // returning helper (W9): `const payload = buildHousekeeperActionEvent(event, cwd);
    // writeEvent(payload, {cwd})` in audit-housekeeper-action.js is exactly
    // this one hop further than the direct-call-expression case below.
    if (helperLiterals) {
      const declRe = new RegExp('(?:const|let|var)\\s+' + t + '\\s*=\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\(', 'g');
      let best = null;
      let dm;
      while ((dm = declRe.exec(src)) !== null) {
        if (dm.index >= callIdx) break;
        best = dm;
      }
      if (best && helperLiterals.has(best[1])) {
        const h = helperLiterals.get(best[1]);
        return { keys: h.keys, hasSpread: h.hasSpread, typeValueText: null, typeCandidates: h.typeCandidates };
      }
    }
  }
  const callM = t.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (callM && helperLiterals && helperLiterals.has(callM[1])) {
    const h = helperLiterals.get(callM[1]);
    return { keys: h.keys, hasSpread: h.hasSpread, typeValueText: null, typeCandidates: h.typeCandidates };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Local function discovery, wrapper templates, and literal-returning helpers
// ---------------------------------------------------------------------------

/**
 * Find every `function NAME(params) { ... }` declaration in the file.
 * Skips destructured parameter lists (`{`/`[` in the param text) — those
 * belong to shapes like the `writeAuditEvent` legacy factory
 * (`{ type, mode, extraFieldsPicker, ... }`), which is handled by its own
 * dedicated factory-shape logic and must never be treated as a simple
 * positional-parameter wrapper.
 */
function findLocalFunctions(src) {
  const funcs = [];
  const re = /function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (/[{[]/.test(m[2])) continue;
    const params = m[2].split(',').map((s) => s.trim()).filter(Boolean);
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingClose(src, openIdx, '{', '}');
    if (closeIdx === -1) continue;
    funcs.push({ name: m[1], params, declIndex: m.index, bodyStart: openIdx, bodyEnd: closeIdx });
  }
  return funcs;
}

/** Find writer-call occurrences (from `writerNames`) strictly inside `[start, end]`. */
function findWriterCallsInRange(src, start, end, writerNames) {
  const re = new RegExp('(?:^|[^.\\w])(' + Array.from(writerNames).join('|') + ')\\s*\\(', 'g');
  re.lastIndex = start;
  const calls = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index >= end) break;
    const nameStart = m.index + m[0].indexOf(m[1]);
    calls.push({ name: m[1], parenIdx: m.index + m[0].length - 1, nameStart });
  }
  return calls;
}

/**
 * Build a caller-substitutable "wrapper template" for a local function whose
 * body forwards its own parameters into exactly one writer call — the
 * generalized form of the two shapes this tool special-cased for functions
 * literally named `emitAuditEvent` before W9. Any function of any name that
 * fits one of the two recognized shapes below is now covered:
 *
 *   'direct' — `function f(a, PAYLOAD) { writer(PAYLOAD, ...) }`: the
 *     payload is exactly one of the function's own parameters, forwarded
 *     unchanged. (Old `emitAuditEvent(cwd, record)` "record" shape.)
 *
 *   'assign' — `function f(a, TYPE, EXTRA) { writer(Object.assign(<literal
 *     base, possibly with a type:/event_type: key that is itself TYPE>,
 *     EXTRA)) }`: the payload is an Object.assign merge whose literal
 *     portions are fixed and whose remaining source(s) are the function's
 *     own parameters. (Old `emitAuditEvent(cwd, eventType, extra)`
 *     "typeExtra" shape, generalized to arbitrary arg order/count and to
 *     any function name.)
 *
 * Returns `null` when the body doesn't fit either shape (kept exactly as
 * before: the internal forwarding call stays a normal, individually-flagged
 * unanalysable site — this function only ever narrows coverage loss, never
 * risks a false CLEAN/VIOLATION).
 */
/**
 * Find the RHS expression text of a `const/let/var IDENT = <expr>;`
 * declaration scoped to a function body (search starts at `bodyStart`, not
 * the whole file — this is the local-variable counterpart of
 * `traceIdentifierLiteral`'s file-scope search). Returns the raw text of
 * `<expr>` when it's an object literal or an `Object.assign(...)` call
 * (the two shapes this tool can merge), else `null`.
 */
function findLocalDeclExprText(src, ident, bodyStart, refIdx) {
  const declRe = new RegExp('(?:const|let|var)\\s+' + ident + '\\s*=\\s*', 'g');
  declRe.lastIndex = bodyStart;
  let best = null;
  let m;
  while ((m = declRe.exec(src)) !== null) {
    if (m.index >= refIdx) break;
    best = m;
  }
  if (!best) return null;
  const exprStart = best.index + best[0].length;
  const rest = src.slice(exprStart);
  if (/^\{/.test(rest)) {
    const closeIdx = findMatchingClose(src, exprStart, '{', '}');
    return closeIdx === -1 ? null : src.slice(exprStart, closeIdx + 1);
  }
  const am = /^Object\.assign\s*\(/.exec(rest);
  if (am) {
    const openIdx = exprStart + am[0].length - 1;
    const closeIdx = findMatchingClose(src, openIdx, '(', ')');
    return closeIdx === -1 ? null : src.slice(exprStart, closeIdx + 1);
  }
  return null;
}

/**
 * Build the 'assign'-shape template pieces from a list of merge-source
 * texts (either the inner args of an `Object.assign(...)` call, or a
 * single-element list holding one plain object literal) against a
 * function's own parameter list. Shared by the inline-`Object.assign(...)`
 * case and the local-variable case (`const event = Object.assign(...)`,
 * `const entry = {...}`) so both get the same param-aware `type:`
 * resolution — critical for shapes like tokenwright's
 * `_emit(type, payload) { const event = Object.assign({}, payload,
 * {type, ...}); writeEvent(event); }`, where the literal's `type` key is a
 * shorthand for the function's OWN `type` parameter, not a fixed value.
 * Returns `null` when a source can't be attributed to either a literal or
 * a parameter (do not guess), or when no `type`/`event_type` key is ever
 * seen, or when a `type` key is seen but resolves to neither a param nor a
 * literal.
 */
function buildAssignShapeFromSources(sourceTexts, params) {
  let literalKeys = [];
  let literalHasSpread = false;
  let typeParamIndex = null;
  let typeLiteralCandidates = null;
  let sawUnresolvedType = false;
  const widenParamIndices = [];

  for (const argText of sourceTexts) {
    const t = argText.trim();
    if (isObjectLiteral(t)) {
      const shape = extractLiteralShape(t);
      literalKeys = literalKeys.concat(shape.keys);
      literalHasSpread = literalHasSpread || shape.hasSpread;
      const vt = shape.typeValueText || shape.eventTypeValueText;
      if (vt) {
        const pIdx = params.indexOf(vt);
        if (pIdx !== -1) { typeParamIndex = pIdx; typeLiteralCandidates = null; sawUnresolvedType = false; }
        else {
          const cands = resolveTypeCandidates(vt);
          if (cands) { typeLiteralCandidates = cands; typeParamIndex = null; sawUnresolvedType = false; }
          else { typeParamIndex = null; typeLiteralCandidates = null; sawUnresolvedType = true; }
        }
      }
      continue;
    }
    const pIdx = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(t) ? params.indexOf(t) : -1;
    if (pIdx !== -1) { widenParamIndices.push(pIdx); continue; }
    return null; // an argument we can't attribute to a param or a literal — bail, do not guess
  }

  if (sawUnresolvedType) return null; // a type key exists but resolves to neither a param nor a literal
  if (typeParamIndex === null && typeLiteralCandidates === null) return null; // no type key seen at all

  return {
    literalKeys: Array.from(new Set(literalKeys)),
    literalHasSpread,
    typeParamIndex,
    typeLiteralCandidates,
    widenParamIndices,
  };
}

function buildWrapperTemplate(src, func, writerNameSet) {
  const calls = findWriterCallsInRange(src, func.bodyStart, func.bodyEnd + 1, writerNameSet);
  if (calls.length !== 1) return null;
  const call = calls[0];
  const closeParenIdx = findMatchingClose(src, call.parenIdx, '(', ')');
  if (closeParenIdx === -1) return null;
  const callArgs = splitTopLevelArgs(src.slice(call.parenIdx + 1, closeParenIdx));
  const payloadArgText = (callArgs[0] || '').trim();

  // W9: a wrapper that always forwards `skipValidation: true` in its own
  // internal writer call has, by construction, opted every one of its
  // callers out of schema conformance at RUNTIME too (see
  // `writeEvent`'s skip-validation branch in audit-event-writer.js) — the
  // static gate honors the same explicit, visible-in-source bypass rather
  // than asserting a violation the runtime itself will never check.
  const skipsValidation = /skipValidation\s*:\s*true\b/.test(callArgs[1] || '');

  // Shape 'direct': payload is exactly one of this function's own params.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(payloadArgText) && func.params.includes(payloadArgText)) {
    return { kind: 'direct', paramIndex: func.params.indexOf(payloadArgText), skipsValidation };
  }

  // Shape 'assign': payload is an object literal, an inline
  // `Object.assign(...)`, or a local `const`/`let` bound to either of
  // those within this same function body — all resolved param-aware so a
  // `type:` (or `event_type:`) key that's shorthand for one of the
  // function's own params is recognized as such rather than treated as an
  // unresolvable fixed value.
  let sourceTexts = null;
  if (isObjectLiteral(payloadArgText)) {
    sourceTexts = [payloadArgText];
  } else {
    sourceTexts = objectAssignInnerArgs(payloadArgText);
  }
  if (!sourceTexts && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(payloadArgText)) {
    const localExpr = findLocalDeclExprText(src, payloadArgText, func.bodyStart, call.parenIdx);
    if (localExpr) {
      sourceTexts = isObjectLiteral(localExpr) ? [localExpr] : objectAssignInnerArgs(localExpr);
    }
  }
  if (!sourceTexts) return null;

  const shape = buildAssignShapeFromSources(sourceTexts, func.params);
  if (!shape) return null;

  return Object.assign({ kind: 'assign', skipsValidation }, shape);
}

/** Resolve a built wrapper `template` against the concrete args of one call to it. */
function resolveWrapperCallSite(template, callArgs, src, callIdx, helperLiterals) {
  if (template.kind === 'direct') {
    const resolved = resolvePayloadArg(callArgs[template.paramIndex], src, callIdx, helperLiterals);
    if (!resolved) return { keys: null, hasSpread: false, typeCandidates: null, skipsValidation: template.skipsValidation };
    const typeCandidates = resolved.typeCandidates || resolveTypeValueText(resolved.typeValueText, src, callIdx);
    return { keys: resolved.keys, hasSpread: resolved.hasSpread, typeCandidates, skipsValidation: template.skipsValidation };
  }

  let keys = template.literalKeys.slice();
  let hasSpread = template.literalHasSpread;
  for (const pIdx of template.widenParamIndices) {
    const argText = callArgs[pIdx];
    const resolved = argText ? resolvePayloadArg(argText, src, callIdx, helperLiterals) : null;
    if (resolved) { keys = keys.concat(resolved.keys); hasSpread = hasSpread || resolved.hasSpread; }
    else hasSpread = true;
  }
  keys = Array.from(new Set(keys));

  let typeCandidates;
  if (template.typeLiteralCandidates) {
    typeCandidates = template.typeLiteralCandidates;
  } else if (template.typeParamIndex !== null) {
    const argText = callArgs[template.typeParamIndex];
    typeCandidates = argText ? resolveTypeValueText(argText.trim(), src, callIdx) : null;
  } else {
    typeCandidates = null;
  }
  return { keys, hasSpread, typeCandidates, skipsValidation: template.skipsValidation };
}

/**
 * Detect whether `func`'s body is a "literal-returning helper": exactly one
 * `return { literal };` and every other `return` statement (if any) is bare
 * (`return;`), `return null;`, or `return undefined;` — the common
 * validate-then-build-a-fixed-shape-event pattern (early-out on invalid
 * input, one real payload shape at the end). When this holds, the helper's
 * result shape is the same no matter what the caller passes in, so a call
 * `helper(anything)` used as a writer payload can be resolved from the
 * helper's own body alone (W9) — including across files, since the caller
 * doesn't influence the shape.
 */
function detectLiteralReturningHelper(src, func) {
  const bodyText = src.slice(func.bodyStart, func.bodyEnd + 1);
  const literalRe = /\breturn\s*\{/g;
  const literalReturns = [];
  let m;
  while ((m = literalRe.exec(bodyText)) !== null) {
    const openIdx = func.bodyStart + m.index + m[0].length - 1;
    const closeIdx = findMatchingClose(src, openIdx, '{', '}');
    if (closeIdx === -1) return null;
    literalReturns.push({ start: func.bodyStart + m.index, end: closeIdx, text: src.slice(openIdx, closeIdx + 1) });
  }
  if (literalReturns.length !== 1) return null;

  const allReturnRe = /\breturn\b/g;
  let rm;
  while ((rm = allReturnRe.exec(bodyText)) !== null) {
    const absIdx = func.bodyStart + rm.index;
    if (absIdx >= literalReturns[0].start && absIdx <= literalReturns[0].end) continue;
    const after = bodyText.slice(rm.index + 6, rm.index + 30).trim();
    if (!/^(;|null\s*;|undefined\s*;)/.test(after)) return null;
  }

  const shape = extractLiteralShape(literalReturns[0].text);
  const typeCandidates = extractTypeCandidates(literalReturns[0].text, src, literalReturns[0].start);
  return { keys: shape.keys, hasSpread: shape.hasSpread, typeCandidates };
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

const WRITER_CALL_NAME_SET = new Set(WRITER_CALL_NAMES);

/**
 * Classify one resolved emit site against its schema(s). `typeCandidates` is
 * normally a single-element array, but a traced ternary (W9) can yield more
 * than one candidate type — the payload must satisfy EVERY candidate's
 * required fields to be CLEAN, since static analysis cannot prove which
 * branch fires; a shortfall against only some candidates is reported as
 * UNANALYSABLE (not VIOLATION) precisely because that ambiguity cannot be
 * resolved without executing the code.
 */
function classifySite(site, literalKeys, hasSpread, typeCandidates, schemaByType) {
  if (literalKeys === null) {
    return Object.assign({}, site, { status: 'UNANALYSABLE', reason: 'payload is not a literal object and not a single-hop-traceable identifier' });
  }
  if (!typeCandidates || typeCandidates.length === 0) {
    return Object.assign({}, site, { status: 'UNANALYSABLE', reason: 'event type is not a string literal (computed/variable)' });
  }

  const perCandidate = typeCandidates.map((t) => ({ type: t, schema: schemaByType.get(t) }));
  if (perCandidate.every((c) => !c.schema)) {
    // None of the candidates are declared in event-schemas.md — out of
    // scope for this sweep (covered by schema-declared-types-parseable.test.js, W5).
    return Object.assign({}, site, { status: 'CLEAN', type: typeCandidates.join('|'), reason: 'no declared schema for this type (out of scope for W7)' });
  }

  const shortfalls = [];
  for (const c of perCandidate) {
    if (!c.schema) continue;
    const required = (c.schema.required || []).filter((f) => !AUTOFILLED_FIELDS.has(f));
    const missing = required.filter((f) => !literalKeys.includes(f));
    if (missing.length > 0) shortfalls.push({ type: c.type, missing });
  }

  if (shortfalls.length === 0) {
    return Object.assign({}, site, { status: 'CLEAN', type: typeCandidates.join('|') });
  }
  const detail = shortfalls.map((s) => s.type + ': ' + s.missing.join(', ')).join('; ');
  if (hasSpread) {
    return Object.assign({}, site, {
      status: 'UNANALYSABLE', type: typeCandidates.join('|'),
      reason: 'top-level spread may supply the apparently-missing field(s): ' + detail,
    });
  }
  if (typeCandidates.length > 1) {
    return Object.assign({}, site, {
      status: 'UNANALYSABLE', type: typeCandidates.join('|'),
      reason: 'event type resolves to one of several literals (' + typeCandidates.join(', ') + ') and static analysis ' +
        'cannot prove which branch fires; required field(s) missing for at least one candidate: ' + detail,
    });
  }
  return Object.assign({}, site, { status: 'VIOLATION', type: shortfalls[0].type, missing: shortfalls[0].missing });
}

function analyzeFile(relFile, rawSrc, schemaByType, globalHelperLiterals) {
  const results = [];
  const src = stripComments(rawSrc); // string-aware; line numbers preserved
  const factoryWriteAuditEvent = importsFactoryWriteAuditEvent(src);

  // --- Local wrapper templates + literal-returning helpers (W9) ---
  const localFuncs = findLocalFunctions(src);
  const wrapperTemplates = new Map(); // name -> template
  const subsumedRanges = []; // [start, end] body ranges whose internal writer call is covered via caller-site analysis
  const helperLiterals = new Map(globalHelperLiterals || []); // name -> {keys, hasSpread, typeCandidates}; file-local overrides global

  for (const func of localFuncs) {
    if (WRITER_CALL_NAME_SET.has(func.name)) continue; // e.g. a local `writeAuditEvent(event)` forwarder — handled below by range
    const template = buildWrapperTemplate(src, func, WRITER_CALL_NAME_SET);
    if (template) {
      wrapperTemplates.set(func.name, template);
      subsumedRanges.push([func.bodyStart, func.bodyEnd]);
    }
  }
  // A local function literally named one of the WRITER_CALL_NAMES (e.g. a
  // file's own `function writeAuditEvent(event) { writeEvent(event, ...) }`
  // forwarder) is already covered generically: every OTHER call to
  // `writeAuditEvent(...)` in the file is analyzed via the normal gateway
  // path below regardless of which implementation it resolves to at
  // runtime. Its own internal forwarding call is therefore redundant and
  // safe to subsume, provided the forwarded argument is a direct pass-
  // through of one of its own params (never a re-shaped or partial one).
  for (const func of localFuncs) {
    if (!WRITER_CALL_NAME_SET.has(func.name)) continue;
    const template = buildWrapperTemplate(src, func, WRITER_CALL_NAME_SET);
    if (template && template.kind === 'direct') subsumedRanges.push([func.bodyStart, func.bodyEnd]);
  }

  for (const func of localFuncs) {
    if (helperLiterals.has(func.name)) continue;
    const helper = detectLiteralReturningHelper(src, func);
    if (helper) helperLiterals.set(func.name, helper);
  }

  const isSubsumed = (idx) => subsumedRanges.some(([s, e]) => idx >= s && idx <= e);

  const names = new Set(WRITER_CALL_NAMES);
  for (const name of wrapperTemplates.keys()) names.add(name);

  const callRe = new RegExp('(?:^|[^.\\w])(' + Array.from(names).join('|') + ')\\s*\\(', 'g');
  let m;
  while ((m = callRe.exec(src)) !== null) {
    const name = m[1];
    const callParenIdx = m.index + m[0].length - 1;

    // Skip the writer's own function declaration lines.
    const linePrefix = src.slice(Math.max(0, m.index - 20), m.index);
    if (/function\s*$/.test(linePrefix)) continue;

    if (WRITER_CALL_NAME_SET.has(name) && isSubsumed(m.index)) continue; // subsumed by caller-site wrapper analysis (W9)

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

    let keys = null;
    let hasSpread = false;
    let typeCandidates = null;
    let skipsValidation = false;

    if (wrapperTemplates.has(name)) {
      const resolved = resolveWrapperCallSite(wrapperTemplates.get(name), args, src, m.index, helperLiterals);
      keys = resolved.keys;
      hasSpread = resolved.hasSpread;
      typeCandidates = resolved.typeCandidates;
      skipsValidation = !!resolved.skipsValidation;
    } else {
      const resolved = resolvePayloadArg(args[0], src, m.index, helperLiterals);
      if (resolved) {
        keys = resolved.keys;
        hasSpread = resolved.hasSpread;
        typeCandidates = resolved.typeCandidates || resolveTypeValueText(resolved.typeValueText, src, m.index);
      }
      // W9: a call whose own options argument sets skipValidation: true
      // bypasses runtime schema checking exactly the way the wrapper case
      // above does — see the comment on `buildWrapperTemplate`.
      skipsValidation = /skipValidation\s*:\s*true\b/.test(args[1] || '');
    }

    const classified = classifySite(site, keys, hasSpread, typeCandidates, schemaByType);
    if (classified.status === 'VIOLATION' && skipsValidation) {
      // Only downgrade an otherwise-provable violation: a call site that
      // already satisfies its schema stays CLEAN (more informative, and
      // still true), skipValidation just means the runtime wouldn't have
      // caught it if it HADN'T been satisfied.
      results.push(Object.assign({}, site, {
        status: 'UNANALYSABLE',
        type: classified.type,
        reason: 'call site passes skipValidation: true — the runtime itself never checks this payload against its schema (missing: ' +
          classified.missing.join(', ') + '), so the static gate does not assert a violation either',
      }));
      continue;
    }
    results.push(classified);
  }

  return results;
}

function sweep() {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const schemas = parseEventSchemas(schemaContent);
  const schemaByType = new Map(schemas.map((s) => [s.slug, s]));

  const files = listJsFiles(path.join(REPO_ROOT, 'bin'));

  // Pre-pass: literal-returning helpers (W9) are resolved regardless of
  // which file calls them — e.g. `bin/mcp-server/lib/audit.js` exports
  // `buildAuditEvent`/`buildResourceAuditEvent`, consumed from
  // `bin/mcp-server/server.js`. Building this map once, across every file,
  // lets a payload argument like `buildAuditEvent({...})` resolve without
  // requiring the callee to live in the same file. Name collisions are rare
  // for this narrow pattern (validated helper builders); the map keeps the
  // first definition found, matching this tool's other "narrow, honest"
  // single-hop tracing rather than attempting real cross-file import
  // resolution.
  const globalHelperLiterals = new Map();
  const parsedByFile = new Map();
  for (const abs of files) {
    const rawSrc = fs.readFileSync(abs, 'utf8');
    const src = stripComments(rawSrc);
    parsedByFile.set(abs, { rawSrc, src });
    for (const func of findLocalFunctions(src)) {
      if (WRITER_CALL_NAME_SET.has(func.name) || globalHelperLiterals.has(func.name)) continue;
      const helper = detectLiteralReturningHelper(src, func);
      if (helper) globalHelperLiterals.set(func.name, helper);
    }
  }

  let all = [];
  for (const abs of files) {
    const rel = path.relative(REPO_ROOT, abs);
    const { rawSrc } = parsedByFile.get(abs);
    all = all.concat(analyzeFile(rel, rawSrc, schemaByType, globalHelperLiterals));
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
