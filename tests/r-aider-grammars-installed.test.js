#!/usr/bin/env node
'use strict';

/**
 * r-aider-grammars-installed.test.js — coverage for the v2.1.17 install.js
 * `copyJsTree` allow-list extension (R-AIDER-FULL, W8). Confirms that a
 * `--local` install copies the tree-sitter grammar payload (manifest.json,
 * `queries/*.scm`, and `*.wasm` files) from the source tree into the
 * install target under `bin/_lib/repo-map-grammars/`.
 *
 * This complements the pre-existing install-lib-migrations.test.js (which
 * only covers `_lib/migrations/`) by asserting the W8 allow-list extension
 * (.scm, .json, .wasm) actually moves files into the install target.
 *
 * Tests:
 *   1. After --local install, bin/_lib/repo-map-grammars/manifest.json is
 *      present and parses as JSON.
 *   2. queries/*.scm files are copied (at least one .scm under queries/).
 *   3. At least one tree-sitter-*.wasm file is copied next to manifest.json.
 *   4. After --uninstall --local, the grammars directory is removed cleanly.
 *
 * The .wasm assertion only runs if the source repo actually ships .wasm
 * payloads under bin/_lib/repo-map-grammars/. On a checkout where wasm
 * files are absent (e.g., a CI image that strips binaries), the .wasm
 * sub-test skips with a marker rather than failing — the .scm + manifest.json
 * coverage is the primary regression guard.
 *
 * Runner: node --test tests/r-aider-grammars-installed.test.js
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, '..', 'bin', 'install.js');
const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_GRAMMARS_DIR = path.join(
  REPO_ROOT, 'bin', '_lib', 'repo-map-grammars'
);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-grammars-test-'));
}

function installLocal(tmpDir) {
  return spawnSync(process.execPath, [SCRIPT, '--local'], {
    encoding: 'utf8',
    timeout: 30000,
    cwd: tmpDir,
    env: { ...process.env },
  });
}

function uninstallLocal(tmpDir) {
  return spawnSync(process.execPath, [SCRIPT, '--local', '--uninstall'], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: tmpDir,
    env: { ...process.env },
  });
}

// ---------------------------------------------------------------------------
// Sanity: source tree must actually contain the grammar payload to copy.
// If this fails, the test is meaningless on this checkout — skip the suite.
// ---------------------------------------------------------------------------

const SRC_HAS_GRAMMARS =
  fs.existsSync(SRC_GRAMMARS_DIR) &&
  fs.existsSync(path.join(SRC_GRAMMARS_DIR, 'manifest.json'));

const SRC_HAS_QUERIES =
  SRC_HAS_GRAMMARS &&
  fs.existsSync(path.join(SRC_GRAMMARS_DIR, 'queries')) &&
  fs.readdirSync(path.join(SRC_GRAMMARS_DIR, 'queries'))
    .some((f) => f.endsWith('.scm'));

const SRC_HAS_WASM =
  SRC_HAS_GRAMMARS &&
  fs.readdirSync(SRC_GRAMMARS_DIR).some((f) => f.endsWith('.wasm'));

// ---------------------------------------------------------------------------
// Test 1 — manifest.json + queries/*.scm copied by --local install
// ---------------------------------------------------------------------------

describe('R-AIDER-FULL — grammars copied by --local install', () => {
  let tmpDir;
  let installResult;

  before(() => {
    if (!SRC_HAS_GRAMMARS) {
      // Nothing to copy from source tree — entire suite trivially passes.
      // Sub-tests below all skip on `!SRC_HAS_GRAMMARS`.
      return;
    }
    tmpDir = makeTmpDir();
    installResult = installLocal(tmpDir);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('source repo ships manifest.json (precondition)', (t) => {
    if (!SRC_HAS_GRAMMARS) {
      t.skip('source repo has no bin/_lib/repo-map-grammars/ payload');
      return;
    }
    assert.ok(
      fs.existsSync(path.join(SRC_GRAMMARS_DIR, 'manifest.json')),
      'source manifest.json must exist for this regression to be meaningful'
    );
  });

  test('--local install exits 0', (t) => {
    if (!SRC_HAS_GRAMMARS) {
      t.skip('source repo has no grammar payload to copy');
      return;
    }
    assert.equal(
      installResult.status, 0,
      `install failed:\nstdout: ${installResult.stdout}\nstderr: ${installResult.stderr}`
    );
  });

  test('manifest.json present in install target', (t) => {
    if (!SRC_HAS_GRAMMARS) {
      t.skip('source repo has no grammar payload to copy');
      return;
    }
    const dst = path.join(
      tmpDir, '.claude', 'orchestray', 'bin', '_lib',
      'repo-map-grammars', 'manifest.json'
    );
    assert.ok(
      fs.existsSync(dst),
      `manifest.json must be copied to install target; expected ${dst}`
    );
    const body = fs.readFileSync(dst, 'utf8');
    // Must parse as JSON — the install.js allow-list copies the bytes
    // verbatim, so corruption would be a real regression.
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(body); },
      'installed manifest.json must be valid JSON'
    );
    // Value-assertion on the parsed result (per I-08) — manifest must be
    // an object, not null/array/scalar.
    assert.equal(
      typeof parsed, 'object',
      'parsed manifest.json must be a JSON object'
    );
    assert.ok(
      parsed && !Array.isArray(parsed),
      'parsed manifest.json must be a non-array object'
    );
  });

  test('at least one queries/*.scm file present in install target', (t) => {
    if (!SRC_HAS_QUERIES) {
      t.skip('source repo has no queries/*.scm files');
      return;
    }
    const queriesDir = path.join(
      tmpDir, '.claude', 'orchestray', 'bin', '_lib',
      'repo-map-grammars', 'queries'
    );
    assert.ok(
      fs.existsSync(queriesDir),
      `queries/ subdirectory must be created at ${queriesDir}`
    );
    const scmFiles = fs.readdirSync(queriesDir).filter((f) => f.endsWith('.scm'));
    assert.ok(
      scmFiles.length >= 1,
      `expected >= 1 .scm file under queries/; got ${scmFiles.length}: ${scmFiles.join(', ')}`
    );
  });

  test('at least one tree-sitter-*.wasm present (when source ships wasm)', (t) => {
    if (!SRC_HAS_WASM) {
      t.skip('source repo has no tree-sitter-*.wasm payload');
      return;
    }
    const grammarsDir = path.join(
      tmpDir, '.claude', 'orchestray', 'bin', '_lib', 'repo-map-grammars'
    );
    const wasmFiles = fs.readdirSync(grammarsDir).filter((f) => f.endsWith('.wasm'));
    assert.ok(
      wasmFiles.length >= 1,
      `expected >= 1 .wasm file in repo-map-grammars/; got ${wasmFiles.length}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2 — uninstall removes the grammars directory cleanly
// ---------------------------------------------------------------------------

describe('R-AIDER-FULL — uninstall removes grammars cleanly', () => {
  test('after install + uninstall, the install target is removed', (t) => {
    if (!SRC_HAS_GRAMMARS) {
      t.skip('source repo has no grammar payload to install');
      return;
    }
    const tmpDir = makeTmpDir();
    try {
      const inst = installLocal(tmpDir);
      assert.equal(inst.status, 0, `install failed: ${inst.stderr}`);

      const grammarsDir = path.join(
        tmpDir, '.claude', 'orchestray', 'bin', '_lib', 'repo-map-grammars'
      );
      assert.ok(
        fs.existsSync(grammarsDir),
        'precondition: grammars dir must exist after install'
      );

      const un = uninstallLocal(tmpDir);
      assert.equal(
        un.status, 0,
        `uninstall failed:\nstdout: ${un.stdout}\nstderr: ${un.stderr}`
      );

      // After uninstall, the orchestray subtree is gone (or at least the
      // grammars dir is gone). The pre-existing install.test.js already
      // covers the broader "uninstall is clean" invariant; here we only
      // need to assert the .scm / .wasm payload is gone — i.e., the W8
      // allow-list extension didn't introduce files the uninstaller misses.
      const stillThere = fs.existsSync(grammarsDir);
      assert.equal(
        stillThere, false,
        `grammars dir must be removed after uninstall; still found at ${grammarsDir}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
