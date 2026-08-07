'use strict';

/**
 * D2 regression test: pruneStaleVendoredDeps (bin/install.js).
 *
 * Root cause: bin/install.js copies the current vendored dependency set into
 * `{target}/orchestray/node_modules/` on every install but never removed
 * entries it no longer vendors. ajv (and its four transitive deps —
 * fast-deep-equal, fast-uri, json-schema-traverse, require-from-string) was
 * dropped in v2.3.8 for the in-house json-schema-subset.js, but installs
 * that predate that release still carry those five directories on every
 * upgrade since, because nothing ever swept them.
 *
 * This test extracts the live pruneStaleVendoredDeps source straight out of
 * bin/install.js (brace-matched, not a hand-reimplementation) so the test
 * cannot silently drift out of sync with the shipped pruning logic, then
 * exercises it against real fixture directory trees. A separate end-to-end
 * describe block runs the full installer against a fixture with pre-seeded
 * stale deps to confirm the wiring (VENDORED_DEP_NAMES → prune call → log)
 * works, not just the helper in isolation.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'bin', 'install.js');

// Brace-match extraction: find `function pruneStaleVendoredDeps(` and walk
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

const installSrc = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
const fnSrc = extractFunctionSource(installSrc, 'pruneStaleVendoredDeps');
const pruneStaleVendoredDeps = new Function(
  'path', 'fs',
  `${fnSrc}\nreturn pruneStaleVendoredDeps;`
)(path, fs);

// Builds `{targetDir}/orchestray/node_modules/<name>/package.json` so each
// fixture dir looks like a real vendored package, not just an empty dir.
function makeVendoredDir(nmDir, name) {
  const dir = path.join(nmDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-test' }));
  return dir;
}

describe('pruneStaleVendoredDeps (bin/install.js, D2)', () => {

  test('removes dirs not in the allowlist, leaves allowlisted dirs untouched', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-stale-'));
    try {
      const nmDir = path.join(targetDir, 'orchestray', 'node_modules');
      makeVendoredDir(nmDir, 'ajv');
      makeVendoredDir(nmDir, 'fast-uri');
      makeVendoredDir(nmDir, 'fast-deep-equal');
      makeVendoredDir(nmDir, 'json-schema-traverse');
      makeVendoredDir(nmDir, 'require-from-string');
      makeVendoredDir(nmDir, 'zod');
      makeVendoredDir(nmDir, 'web-tree-sitter');

      const result = pruneStaleVendoredDeps(targetDir, ['zod', 'web-tree-sitter']);

      assert.deepEqual(
        result.pruned.slice().sort(),
        ['ajv', 'fast-deep-equal', 'fast-uri', 'json-schema-traverse', 'require-from-string'].sort(),
        'should report exactly the 5 stale dirs as pruned'
      );
      assert.deepEqual(result.failed, [], 'no prune should fail in this fixture');

      assert.ok(!fs.existsSync(path.join(nmDir, 'ajv')), 'ajv should be gone');
      assert.ok(!fs.existsSync(path.join(nmDir, 'fast-uri')), 'fast-uri should be gone');
      assert.ok(!fs.existsSync(path.join(nmDir, 'fast-deep-equal')), 'fast-deep-equal should be gone');
      assert.ok(!fs.existsSync(path.join(nmDir, 'json-schema-traverse')), 'json-schema-traverse should be gone');
      assert.ok(!fs.existsSync(path.join(nmDir, 'require-from-string')), 'require-from-string should be gone');

      assert.ok(fs.existsSync(path.join(nmDir, 'zod')), 'zod must survive');
      assert.ok(fs.existsSync(path.join(nmDir, 'web-tree-sitter')), 'web-tree-sitter must survive');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('a name added to the allowlist is kept — proves the allowlist is the single source', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-future-dep-'));
    try {
      const nmDir = path.join(targetDir, 'orchestray', 'node_modules');
      makeVendoredDir(nmDir, 'zod');
      makeVendoredDir(nmDir, 'some-future-dep');

      // Without the future dep in the allowlist, it would be pruned.
      const withoutFutureDep = pruneStaleVendoredDeps(targetDir, ['zod']);
      assert.deepEqual(withoutFutureDep.pruned, ['some-future-dep']);
      makeVendoredDir(nmDir, 'some-future-dep'); // reset for the next call

      // Once the allowlist includes it, prune leaves it alone.
      const withFutureDep = pruneStaleVendoredDeps(targetDir, ['zod', 'some-future-dep']);
      assert.deepEqual(withFutureDep.pruned, [], 'nothing should be pruned once allowlisted');
      assert.ok(fs.existsSync(path.join(nmDir, 'some-future-dep')), 'future dep must survive once allowlisted');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('a symlink pointing outside the install root is not followed; its target survives', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-symlink-'));
    const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-victim-'));
    try {
      const nmDir = path.join(targetDir, 'orchestray', 'node_modules');
      fs.mkdirSync(nmDir, { recursive: true });
      makeVendoredDir(nmDir, 'zod');

      const victimFile = path.join(victimDir, 'victim-secret.txt');
      fs.writeFileSync(victimFile, 'do not delete me');

      const evilLink = path.join(nmDir, 'evil-escape');
      fs.symlinkSync(victimDir, evilLink, 'dir');

      const result = pruneStaleVendoredDeps(targetDir, ['zod']);

      assert.deepEqual(result.pruned, [], 'the symlink must not be reported as pruned');
      assert.ok(fs.existsSync(victimFile), 'the symlink target file must survive untouched');
      // The symlink entry itself is left in place (never traversed, never deleted).
      assert.ok(fs.lstatSync(evilLink).isSymbolicLink(), 'the symlink itself must be left alone');
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.rmSync(victimDir, { recursive: true, force: true });
    }
  });

  test('no node_modules/ directory at all is a no-op', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-empty-'));
    try {
      const result = pruneStaleVendoredDeps(targetDir, ['zod', 'web-tree-sitter']);
      assert.deepEqual(result, { pruned: [], failed: [] });
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

});

describe('bin/install.js end-to-end — prunes stale vendored deps on install', () => {
  test('a fixture install carrying pre-v2.3.8 ajv leftovers is swept clean', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-e2e-'));
    try {
      // Seed a stale node_modules/ tree as if a pre-v2.3.8 install had run
      // here before, and never been swept.
      const nmDir = path.join(tmp, '.claude', 'orchestray', 'node_modules');
      makeVendoredDir(nmDir, 'ajv');
      makeVendoredDir(nmDir, 'fast-uri');

      const env = Object.assign({}, process.env, { HOME: tmp });
      const res = spawnSync('node', [INSTALL_SCRIPT, '--global'], {
        env, cwd: tmp, encoding: 'utf8', timeout: 60_000,
      });
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

      assert.ok(!fs.existsSync(path.join(nmDir, 'ajv')), 'stale ajv must be pruned by install');
      assert.ok(!fs.existsSync(path.join(nmDir, 'fast-uri')), 'stale fast-uri must be pruned by install');

      // Current vendored deps must still be present and functional.
      assert.ok(fs.existsSync(path.join(nmDir, 'zod')), 'zod must be installed');
      assert.ok(fs.existsSync(path.join(nmDir, 'web-tree-sitter')), 'web-tree-sitter must be installed');

      // The prune must be visible in installer output.
      assert.match(res.stderr, /Pruned stale vendored dependency: node_modules\/ajv/);
      assert.match(res.stderr, /Pruned stale vendored dependency: node_modules\/fast-uri/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a fresh install with no prior node_modules/ is unaffected (no prune output)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-fresh-'));
    try {
      const env = Object.assign({}, process.env, { HOME: tmp });
      const res = spawnSync('node', [INSTALL_SCRIPT, '--global'], {
        env, cwd: tmp, encoding: 'utf8', timeout: 60_000,
      });
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);
      assert.doesNotMatch(res.stderr, /Pruned stale vendored dependency/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
