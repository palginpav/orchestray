'use strict';

/**
 * v2.3.17 regression test: resolveVendoredPackageDir (bin/install.js).
 *
 * Root cause: bin/install.js used to compute zodSrc as a naive
 * pkgRoot/node_modules/zod join. That only holds for `npm install -g`, where
 * deps nest under orchestray's own node_modules. `npx orchestray` — the
 * primary documented install path — hoists zod/web-tree-sitter as SIBLINGS
 * of node_modules/orchestray/, so the naive join silently missed them,
 * breaking the MCP server and ~30 hooks with MODULE_NOT_FOUND.
 *
 * This test extracts the live resolveVendoredPackageDir source straight out
 * of bin/install.js (brace-matched, not a hand-reimplementation) so the test
 * cannot silently drift out of sync with the shipped resolution logic, then
 * exercises it against real fixture directory trees for both layouts.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');

const INSTALL_JS = path.resolve(__dirname, '..', '..', 'bin', 'install.js');

// Brace-match extraction: find `function resolveVendoredPackageDir(` and walk
// forward counting { / } until the matching close, so the extracted source
// tracks whatever the function currently looks like in bin/install.js.
function extractFunctionSource(fileSrc, functionName) {
  const startIdx = fileSrc.indexOf(`function ${functionName}(`);
  if (startIdx === -1) {
    throw new Error(`${functionName} not found in bin/install.js — extraction is stale, update this test`);
  }
  let i = fileSrc.indexOf('{', startIdx);
  let depth = 0;
  for (; i < fileSrc.length; i++) {
    if (fileSrc[i] === '{') depth++;
    else if (fileSrc[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return fileSrc.slice(startIdx, i);
}

const installSrc = fs.readFileSync(INSTALL_JS, 'utf8');
const fnSrc = extractFunctionSource(installSrc, 'resolveVendoredPackageDir');
const resolveVendoredPackageDir = new Function(
  'path', 'fs', 'require',
  `${fnSrc}\nreturn resolveVendoredPackageDir;`
)(path, fs, require);

// Writes a minimal, require.resolve-able package directory (package.json +
// an entry file) at `dir`.
function writeFakePackage(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-test', main: 'index.js' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
}

describe('resolveVendoredPackageDir (bin/install.js, v2.3.17 fix)', () => {

  test('hoisted layout: dep is a sibling of pkgRoot under node_modules/ (npx orchestray)', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vendor-hoisted-'));
    try {
      const nodeModules = path.join(tmpBase, 'node_modules');
      const pkgRoot = path.join(nodeModules, 'fakepkg');
      const zodDir = path.join(nodeModules, 'zod');
      fs.mkdirSync(pkgRoot, { recursive: true });
      writeFakePackage(zodDir, 'zod');

      const resolved = resolveVendoredPackageDir('zod', pkgRoot);
      assert.equal(resolved, fs.realpathSync(zodDir), 'should resolve the hoisted sibling package dir');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test('hoisted layout resolves web-tree-sitter the same way', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vendor-hoisted-ts-'));
    try {
      const nodeModules = path.join(tmpBase, 'node_modules');
      const pkgRoot = path.join(nodeModules, 'fakepkg');
      const tsDir = path.join(nodeModules, 'web-tree-sitter');
      fs.mkdirSync(pkgRoot, { recursive: true });
      writeFakePackage(tsDir, 'web-tree-sitter');

      const resolved = resolveVendoredPackageDir('web-tree-sitter', pkgRoot);
      assert.equal(resolved, fs.realpathSync(tsDir), 'should resolve the hoisted sibling package dir');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test('nested layout still works (npm install -g)', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vendor-nested-'));
    try {
      const pkgRoot = path.join(tmpBase, 'fakepkg');
      const zodDir = path.join(pkgRoot, 'node_modules', 'zod');
      writeFakePackage(zodDir, 'zod');

      const resolved = resolveVendoredPackageDir('zod', pkgRoot);
      assert.equal(resolved, fs.realpathSync(zodDir), 'should resolve the nested package dir');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  test('dep missing from both layouts returns null', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-vendor-missing-'));
    try {
      const pkgRoot = path.join(tmpBase, 'fakepkg');
      fs.mkdirSync(pkgRoot, { recursive: true });

      const resolved = resolveVendoredPackageDir('zod', pkgRoot);
      assert.equal(resolved, null, 'should return null when the dep cannot be found anywhere');
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

});
