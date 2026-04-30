'use strict';

/**
 * lint-doesnotthrow-orphan.js — C-01 mechanisation (v2.2.15 P1-02).
 *
 * Mechanises anti-pattern `doesnotthrow-only-masks-behavior`. A call to
 * `assert.doesNotThrow` / `assert.doesNotThrowAsync` only proves the callee
 * did not throw — it says nothing about the value the callee returned, the
 * stderr it wrote, or the side-effect it produced. Tests whose ONLY assertion
 * is `doesNotThrow` therefore mask behavioural regressions: the function can
 * silently return the wrong value while the test still passes.
 *
 * Lint rule: walk every `.test.js` file. For each `assert.doesNotThrow(...)`
 * or `assert.doesNotThrowAsync(...)` call, locate the enclosing `test(...)`
 * block. Within that block, scan for at least one of:
 *   - `assert.deepStrictEqual` / `assert.strictEqual` / `assert.equal`
 *      against a value other than `undefined`
 *   - `assert.match` against a `RegExp`
 *   - `assert.ok` against a non-trivial expression (not `assert.ok(true)`)
 *
 * If none found, emit a finding `{file, line, test_name}`.
 *
 * Telemetry-first ramp (per `feedback_mechanical_over_prose.md`):
 *   v2.2.15: warn-only via `lint_doesnotthrow_orphan_warn` event; exit 0.
 *   v2.2.16: promote to exit-2 if false-positive ratio in v2.2.15 stays low.
 *
 * Kill switch: `ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED=1`. Default-on.
 *
 * Heuristic parser, NOT a full JS AST. Tolerates nested arrow functions and
 * multi-line tests. Block boundaries derived from balanced `{...}` after
 * `test(...)` opening — sufficient for the homogeneous shape of files under
 * `bin/__tests__/`.
 *
 * Exports:
 *   isDisabled()                 — kill-switch check
 *   findOrphans(source, file)    — pure function: returns [{ file, line, test_name }]
 *   lintFile(filepath)           — reads file from disk, returns findings
 */

const fs = require('node:fs');

function isDisabled() {
  return process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED === '1';
}

// ---------------------------------------------------------------------------
// Block-boundary helpers
// ---------------------------------------------------------------------------

/**
 * Match each `test('name', ...)` (or `it('name', ...)`) opening. Returns a
 * list of `{ name, openIndex }`. `openIndex` is the file offset of the `(`
 * after `test`/`it`.
 *
 * We tolerate `t.test(...)`, `node:test`'s `test(...)`, and Mocha-style
 * `it(...)`. Names extracted from a single- or double-quoted string literal.
 */
function _findTestOpeners(src) {
  const RE = /\b(?:t\.test|test|it)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,/g;
  const found = [];
  let m;
  while ((m = RE.exec(src)) !== null) {
    // m.index is the start of the test/it identifier. We need the offset of
    // the opening `(`. Walk forward from the identifier to find it.
    const idEnd = m.index + (m[0].match(/^(?:t\.test|test|it)/) || [''])[0].length;
    let parenIdx = src.indexOf('(', idEnd);
    if (parenIdx < 0) continue;
    found.push({ name: m[2], openIndex: parenIdx });
  }
  return found;
}

/**
 * Given a source string and the index of a `(` that opens a test() call,
 * walk forward respecting paired `{...}`/`(...)`/strings/regex/comments and
 * return the offset of the matching closing `)`. Returns -1 if unmatched.
 *
 * The body of `test('name', () => { ... })` is inside the closing `)`; the
 * caller can use `[openIndex, closeIndex]` to slice the test invocation
 * (including its callback body).
 */
function _findMatchingClose(src, openIndex) {
  // The openIndex points AT the opening `(`. Start by consuming that paren
  // so depthParen reflects its presence; otherwise the first inner `()` (e.g.
  // arrow-function `() =>`) wrongly returns to depth 0.
  if (src[openIndex] !== '(') return -1;
  let depthParen = 1;
  let depthBrace = 0;
  let i = openIndex + 1;
  let inSingle = false;
  let inDouble = false;
  let inTpl = false;
  let inLine = false;
  let inBlock = false;
  let inRe = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (inLine) {
      if (ch === '\n') inLine = false;
      i++; continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 2; continue; }
      i++; continue;
    }
    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
      i++; continue;
    }
    if (inTpl) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') inTpl = false;
      i++; continue;
    }
    if (inRe) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '/') inRe = false;
      i++; continue;
    }

    if (ch === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '"') { inDouble = true; i++; continue; }
    if (ch === '`') { inTpl = true; i++; continue; }
    // Conservative regex detection: only when previous non-space char is one
    // of  ( , = : ; ! & | ? { }  return  — i.e. positions that cannot start
    // an arithmetic division.
    if (ch === '/' && _looksLikeRegexStart(src, i)) {
      inRe = true; i++; continue;
    }

    if (ch === '(') depthParen++;
    else if (ch === ')') {
      depthParen--;
      if (depthParen === 0 && depthBrace === 0) return i;
    }
    else if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace--;

    i++;
  }
  return -1;
}

function _looksLikeRegexStart(src, idx) {
  for (let j = idx - 1; j >= 0; j--) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    return /[(,=:;!&|?{}]/.test(c);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Finding scanner
// ---------------------------------------------------------------------------

const DOESNOTTHROW_RE = /\bassert\.doesNotThrow(?:Async)?\s*\(/g;

// Strong assertions that prove behaviour, not mere non-throw.
const STRONG_ASSERT_RES = [
  /\bassert\.deepStrictEqual\s*\(/,
  /\bassert\.strictEqual\s*\(\s*[^,]+,\s*(?!undefined\s*[,)])/,
  /\bassert\.equal\s*\(\s*[^,]+,\s*(?!undefined\s*[,)])/,
  /\bassert\.match\s*\([^,]+,\s*\//,        // regex literal as 2nd arg
  /\bassert\.match\s*\([^,]+,\s*new\s+RegExp/,
  /\bassert\.notStrictEqual\s*\(/,
  /\bassert\.notDeepStrictEqual\s*\(/,
  /\bassert\.throws\s*\(/,
  /\bassert\.rejects\s*\(/,
  // assert.ok(<non-trivial>) — i.e. not assert.ok(true) / assert.ok(1)
  /\bassert\.ok\s*\(\s*(?!true\s*\)|1\s*\)|!?[a-zA-Z_$][\w$]*\s*\)$)/,
];

function _hasStrongAssertion(blockSrc) {
  for (const re of STRONG_ASSERT_RES) {
    if (re.test(blockSrc)) return true;
  }
  return false;
}

function _offsetToLine(src, offset) {
  if (offset <= 0) return 1;
  let line = 1;
  const lim = Math.min(offset, src.length);
  for (let i = 0; i < lim; i++) {
    if (src.charCodeAt(i) === 10 /* \n */) line++;
  }
  return line;
}

/**
 * Find orphan doesNotThrow calls in source.
 *
 * @param {string} src   — file source text
 * @param {string} file  — file path (for finding records)
 * @returns {Array<{file:string, line:number, test_name:string}>}
 */
function findOrphans(src, file) {
  if (typeof src !== 'string' || src.length === 0) return [];

  const openers = _findTestOpeners(src);
  const findings = [];

  for (const opener of openers) {
    const close = _findMatchingClose(src, opener.openIndex);
    if (close < 0) continue;
    const blockSrc = src.slice(opener.openIndex, close + 1);

    // Find each doesNotThrow inside this block.
    const re = new RegExp(DOESNOTTHROW_RE.source, DOESNOTTHROW_RE.flags);
    let m;
    let foundAny = false;
    while ((m = re.exec(blockSrc)) !== null) {
      foundAny = true;
    }
    if (!foundAny) continue;

    if (_hasStrongAssertion(blockSrc)) continue;

    // Report at the line of the FIRST doesNotThrow inside the block.
    const localIdx = blockSrc.search(DOESNOTTHROW_RE);
    const fileIdx = opener.openIndex + (localIdx >= 0 ? localIdx : 0);
    findings.push({
      file,
      line: _offsetToLine(src, fileIdx),
      test_name: opener.name,
    });
  }

  return findings;
}

function lintFile(filepath) {
  const src = fs.readFileSync(filepath, 'utf8');
  return findOrphans(src, filepath);
}

module.exports = {
  isDisabled,
  findOrphans,
  lintFile,
  // exported for tests
  _findTestOpeners,
  _findMatchingClose,
  _hasStrongAssertion,
};
