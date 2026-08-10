#!/usr/bin/env node
'use strict';

/**
 * degraded-journal-call-site-guard.test.js — v2.3.24.
 *
 * A full enumeration of every `recordDegradation()` call site in the repo found
 * 14 unthreaded call sites: the caller never passed `projectRoot`, so the journal
 * write silently fell back to `process.cwd()` — the wrong root under any caller
 * whose cwd differs from the project it is journaling for (a test's temp dir, a
 * spawned child process, etc). Two of those sites were proven to leak: 72 rows
 * in the live journal survived a 528-row purge because nothing on the row itself
 * said which repo it came from.
 *
 * This is the fence: every `recordDegradation(` call under `bin/**\/*.js`
 * (excluding `__tests__`) must carry `projectRoot` in its argument object
 * literal. It does not matter whether the resolved value is defined at
 * runtime — `recordDegradation()` itself stamps `process.cwd()` as a last
 * resort and now stamps the resolved root on every row (see
 * degraded-journal.test.js "W-project-root"). What this guard catches is the
 * caller silently *never trying* — the actual bug class that produced the 14
 * sites and the unrecoverable 72-row purge gap.
 *
 * Runner: node --test bin/_lib/__tests__/degraded-journal-call-site-guard.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Recursively collect .js files under dir, skipping node_modules and any
 * directory named __tests__ (this guard checks production call sites only —
 * test fixtures legitimately construct incomplete call shapes).
 *
 * @param {string} dir
 * @param {string[]} out
 */
function _collectJsFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      _collectJsFiles(p, out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(p);
    }
  }
}

/**
 * Find every `recordDegradation(...)` (or `<expr>.recordDegradation(...)`)
 * call in `src` and return its full call text plus 1-based line number.
 * Balanced-paren extraction (not a regex slice) so multi-line, nested-object
 * call sites are captured correctly regardless of formatting. Skips bare
 * `recordDegradation()` no-arg mentions — those only occur in prose/JSDoc,
 * never in a real call (the function always takes an event object).
 *
 * @param {string} src
 * @returns {Array<{ text: string, line: number }>}
 */
function _extractCallSites(src) {
  const sites = [];
  const callRe = /recordDegradation\s*\(/g;
  let m;
  while ((m = callRe.exec(src))) {
    const startIdx = m.index;
    const openParenIdx = m.index + m[0].length - 1;
    let depth = 1;
    let i = openParenIdx + 1;
    let inStr = null;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    const text = src.slice(startIdx, i);
    if (/^recordDegradation\(\s*\)$/.test(text)) continue; // prose mention, not a call
    const line = src.slice(0, startIdx).split('\n').length;
    sites.push({ text, line });
  }
  return sites;
}

/**
 * Scan every .js file under rootDir/bin (excluding __tests__) for
 * recordDegradation() call sites lacking `projectRoot` in the argument
 * object literal.
 *
 * @param {string} rootDir
 * @returns {Array<{ file: string, line: number }>}
 */
function findUnthreadedCallSites(rootDir) {
  const binDir = path.join(rootDir, 'bin');
  const files = [];
  _collectJsFiles(binDir, files);

  const offenders = [];
  for (const file of files) {
    if (path.resolve(file) === path.resolve(__dirname, '..', 'degraded-journal.js')) {
      continue; // the definition itself, not a caller
    }
    const src = fs.readFileSync(file, 'utf8');
    for (const site of _extractCallSites(src)) {
      if (!/\bprojectRoot\s*(:|,|\))/.test(site.text)) {
        offenders.push({ file: path.relative(rootDir, file), line: site.line });
      }
    }
  }
  return offenders;
}

module.exports = { findUnthreadedCallSites, _extractCallSites, _collectJsFiles };

// ---------------------------------------------------------------------------

describe('degraded-journal call-site guard — every recordDegradation() threads projectRoot', () => {
  test('zero unthreaded call sites under bin/**/*.js', () => {
    const offenders = findUnthreadedCallSites(REPO_ROOT);
    assert.deepEqual(
      offenders,
      [],
      'recordDegradation() call(s) missing projectRoot:\n' +
        offenders.map(o => '  - ' + o.file + ':' + o.line).join('\n')
    );
  });

  test('teeth check: a call site missing projectRoot is flagged in a fixture tree', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-teeth-'));
    try {
      const fixtureDir = path.join(tmpRoot, 'bin', '_lib');
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureDir, 'violator.js'),
        [
          "'use strict';",
          "const { recordDegradation } = require('./degraded-journal');",
          'function bad() {',
          '  recordDegradation({',
          "    kind: 'something_happened',",
          "    severity: 'warn',",
          '  });', // no projectRoot — the violation
          '}',
          'module.exports = { bad };',
          '',
        ].join('\n'),
        'utf8'
      );

      const offenders = findUnthreadedCallSites(tmpRoot);
      assert.equal(offenders.length, 1, 'expected exactly one flagged call site');
      assert.equal(offenders[0].file, path.join('bin', '_lib', 'violator.js'));
      assert.equal(offenders[0].line, 4);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('teeth check: a threaded call site in the same fixture tree is not flagged', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-teeth-ok-'));
    try {
      const fixtureDir = path.join(tmpRoot, 'bin', '_lib');
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureDir, 'compliant.js'),
        [
          "'use strict';",
          "const { recordDegradation } = require('./degraded-journal');",
          'function good(projectRoot) {',
          '  recordDegradation({',
          "    kind: 'something_happened',",
          "    severity: 'warn',",
          '    projectRoot,',
          '  });',
          '}',
          'module.exports = { good };',
          '',
        ].join('\n'),
        'utf8'
      );

      const offenders = findUnthreadedCallSites(tmpRoot);
      assert.deepEqual(offenders, []);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
