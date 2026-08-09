'use strict';

/**
 * v2.3.22: orphan-file pruning.
 *
 * Root cause: v2.3.20 shipped `orchestray/CLAUDE.md` inside the install
 * directory; v2.3.21 dropped it from `package.json`'s `files`. On upgrade
 * the installer wrote every new file but left the orphaned `CLAUDE.md`
 * behind — nothing diffed the previous install's manifest against the new
 * one, so anything a version stops shipping just accumulates forever.
 *
 * `pruneOrphanedFiles` (bin/_lib/install-manifest.js) closes this: it diffs
 * the PREVIOUS manifest's `files` against the CURRENT install's tracked-file
 * set and deletes only the orphans whose on-disk content still matches the
 * hash recorded at install time. Anything the user touched is reported and
 * left alone; anything outside the installer's own tracked footprint
 * (custom-agents/, vendored node_modules/, a `..`-escaping path) is never
 * even considered.
 *
 * This file covers the pure function directly (fast, precise) and the full
 * wiring end-to-end via a real `bin/install.js` invocation (kill switches,
 * installer output, and the real-world manifest-N-vs-N+1 scenario).
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path                = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'bin', 'install.js');

const {
  pruneOrphanedFiles,
  _isPruneSafePath,
  _hashFile,
} = require(path.join(REPO_ROOT, 'bin', '_lib', 'install-manifest.js'));

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('pruneOrphanedFiles (bin/_lib/install-manifest.js)', () => {

  function withTmpDir(fn) {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-'));
    try {
      return fn(targetDir);
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }

  test('an orphan whose on-disk hash matches the recorded hash is deleted', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'orphan.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'untouched since install\n');
      const hash = _hashFile(absPath);

      const prevManifest = {
        manifest_schema: 2,
        files: [relPath],
        files_hashes: { [relPath]: hash },
      };

      const result = pruneOrphanedFiles(targetDir, prevManifest, []);

      assert.deepEqual(result.deleted, [relPath]);
      assert.deepEqual(result.skipped, []);
      assert.ok(!fs.existsSync(absPath), 'orphan must be deleted');
    });
  });

  test('an orphan the user modified since install is kept and reported (hash_mismatch)', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'orphan.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'user edited this after install\n');

      const prevManifest = {
        manifest_schema: 2,
        files: [relPath],
        // Deliberately wrong — simulates content drift since install.
        files_hashes: { [relPath]: 'deadbeef'.repeat(8) },
      };

      const result = pruneOrphanedFiles(targetDir, prevManifest, []);

      assert.deepEqual(result.deleted, []);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].path, relPath);
      assert.equal(result.skipped[0].reason, 'hash_mismatch');
      assert.ok(fs.existsSync(absPath), 'modified orphan must survive');
    });
  });

  test('an orphan with no recorded hash is kept and reported (no_recorded_hash)', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'orphan.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'content\n');

      const prevManifest = {
        manifest_schema: 2,
        files: [relPath],
        files_hashes: {}, // no entry for relPath
      };

      const result = pruneOrphanedFiles(targetDir, prevManifest, []);

      assert.deepEqual(result.deleted, []);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, 'no_recorded_hash');
      assert.ok(fs.existsSync(absPath));
    });
  });

  test('an orphan already gone from disk is silently ignored (not deleted, not skipped)', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'already-gone.md');
      // File never created.
      const prevManifest = {
        manifest_schema: 2,
        files: [relPath],
        files_hashes: { [relPath]: 'a'.repeat(64) },
      };

      const result = pruneOrphanedFiles(targetDir, prevManifest, []);

      assert.deepEqual(result.deleted, []);
      assert.deepEqual(result.skipped, [], 'nothing to prune, nothing to report');
    });
  });

  test('a file still tracked by the current install is left untouched entirely', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'still-shipped.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'still shipped\n');
      const hash = _hashFile(absPath);

      const prevManifest = {
        manifest_schema: 2,
        files: [relPath],
        files_hashes: { [relPath]: hash },
      };

      // relPath IS in the current tracked-file set -> not an orphan at all.
      const result = pruneOrphanedFiles(targetDir, prevManifest, [relPath]);

      assert.deepEqual(result.deleted, []);
      assert.deepEqual(result.skipped, []);
      assert.ok(fs.existsSync(absPath));
    });
  });

  test('currentFiles accepts both a Set and a plain array', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'still-shipped.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'x\n');
      const hash = _hashFile(absPath);
      const prevManifest = { manifest_schema: 2, files: [relPath], files_hashes: { [relPath]: hash } };

      const withArray = pruneOrphanedFiles(targetDir, prevManifest, [relPath]);
      assert.deepEqual(withArray.deleted, []);

      const withSet = pruneOrphanedFiles(targetDir, prevManifest, new Set([relPath]));
      assert.deepEqual(withSet.deleted, []);
    });
  });

  test('missing previous manifest (null) is a no-op — never throws', () => {
    withTmpDir((targetDir) => {
      assert.doesNotThrow(() => {
        const result = pruneOrphanedFiles(targetDir, null, []);
        assert.deepEqual(result, { deleted: [], skipped: [] });
      });
    });
  });

  test('a legacy (schema 1, no files_hashes) previous manifest is a no-op', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'orphan.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'content\n');

      const legacyManifest = { files: [relPath] }; // v1 shape: no manifest_schema, no files_hashes
      const result = pruneOrphanedFiles(targetDir, legacyManifest, []);

      assert.deepEqual(result, { deleted: [], skipped: [] });
      assert.ok(fs.existsSync(absPath), 'legacy manifest must not trigger any deletion');
    });
  });

  test('a malformed previous manifest (not an object) is a no-op', () => {
    withTmpDir((targetDir) => {
      for (const bad of [undefined, 'not an object', 42, [], true]) {
        assert.doesNotThrow(() => {
          const result = pruneOrphanedFiles(targetDir, bad, []);
          assert.deepEqual(result, { deleted: [], skipped: [] });
        });
      }
    });
  });

  test('custom-agents/ entries are never pruned even with a matching hash', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'custom-agents', 'user-agent.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'user content\n');
      const hash = _hashFile(absPath);

      const prevManifest = { manifest_schema: 2, files: [relPath], files_hashes: { [relPath]: hash } };
      const result = pruneOrphanedFiles(targetDir, prevManifest, []);

      assert.deepEqual(result.deleted, []);
      assert.equal(result.skipped[0].reason, 'unsafe_path');
      assert.ok(fs.existsSync(absPath), 'custom-agents/ content must survive');
    });
  });

  test('vendored node_modules/ entries are never pruned (own sweep owns this)', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', 'node_modules', 'zod', 'index.js');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'module.exports = {};\n');
      const hash = _hashFile(absPath);

      const prevManifest = { manifest_schema: 2, files: [relPath], files_hashes: { [relPath]: hash } };
      const result = pruneOrphanedFiles(targetDir, prevManifest, []);

      assert.deepEqual(result.deleted, []);
      assert.equal(result.skipped[0].reason, 'unsafe_path');
      assert.ok(fs.existsSync(absPath));
    });
  });

  test('a path-escape attempt (.. segment) is rejected, never resolved outside targetDir', () => {
    withTmpDir((targetDir) => {
      const victimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-victim-'));
      try {
        const victimFile = path.join(victimDir, 'victim.txt');
        fs.writeFileSync(victimFile, 'do not delete me\n');

        // targetDir/../<victimDir basename>/victim.txt style escape.
        const escapeRel = path.join('..', path.basename(victimDir), 'victim.txt');
        const prevManifest = {
          manifest_schema: 2,
          files: [escapeRel],
          files_hashes: { [escapeRel]: _hashFile(victimFile) },
        };

        const result = pruneOrphanedFiles(targetDir, prevManifest, []);

        assert.deepEqual(result.deleted, []);
        assert.equal(result.skipped[0].reason, 'unsafe_path');
        assert.ok(fs.existsSync(victimFile), 'escape target must survive');
      } finally {
        fs.rmSync(victimDir, { recursive: true, force: true });
      }
    });
  });

  test('an absolute path in files[] is rejected as unsafe', () => {
    withTmpDir((targetDir) => {
      const absOutside = path.join(os.tmpdir(), 'orch-prune-abs-path-victim.txt');
      fs.writeFileSync(absOutside, 'x\n');
      try {
        const prevManifest = {
          manifest_schema: 2,
          files: [absOutside],
          files_hashes: { [absOutside]: _hashFile(absOutside) },
        };
        const result = pruneOrphanedFiles(targetDir, prevManifest, []);
        assert.deepEqual(result.deleted, []);
        assert.equal(result.skipped[0].reason, 'unsafe_path');
        assert.ok(fs.existsSync(absOutside));
      } finally {
        fs.rmSync(absOutside, { force: true });
      }
    });
  });

  // F5-equivalent: a literal directory/file name that merely starts with
  // '..' (no traversal component) is a normal prunable orphan, not an
  // escape attempt.
  test('a filename literally starting with ".." is treated as a normal orphan', () => {
    withTmpDir((targetDir) => {
      const relPath = path.join('orchestray', '..hidden-orphan.md');
      const absPath = path.join(targetDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, 'x\n');
      const hash = _hashFile(absPath);

      const prevManifest = { manifest_schema: 2, files: [relPath], files_hashes: { [relPath]: hash } };
      const result = pruneOrphanedFiles(targetDir, prevManifest, []);

      assert.deepEqual(result.deleted, [relPath]);
      assert.ok(!fs.existsSync(absPath));
    });
  });
});

describe('_isPruneSafePath', () => {
  test('rejects non-string / empty / absolute paths', () => {
    const targetReal = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-safe-path-'));
    try {
      assert.equal(_isPruneSafePath(targetReal, ''), false);
      assert.equal(_isPruneSafePath(targetReal, undefined), false);
      assert.equal(_isPruneSafePath(targetReal, path.join(targetReal, 'x')), false);
    } finally {
      fs.rmSync(targetReal, { recursive: true, force: true });
    }
  });

  test('accepts an ordinary nested relative path', () => {
    const targetReal = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-safe-path-'));
    try {
      assert.equal(_isPruneSafePath(targetReal, path.join('agents', 'foo.md')), true);
    } finally {
      fs.rmSync(targetReal, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end — real bin/install.js wiring
// ---------------------------------------------------------------------------

function runInstall(tmp, extraEnv) {
  const env = Object.assign({}, process.env, { HOME: tmp }, extraEnv || {});
  return spawnSync('node', [INSTALL_SCRIPT, '--global'], {
    env, cwd: tmp, encoding: 'utf8', timeout: 60_000,
  });
}

// Seeds {tmp}/.claude/orchestray/manifest.json (the "previous install") with
// one deletable orphan (matching hash) so a fresh run of the real installer
// exercises the full wiring: readPreviousManifest -> pruneOrphanedFiles ->
// recordDegradation -> installer stderr output.
function seedDeletableOrphan(tmp) {
  const targetDir = path.join(tmp, '.claude');
  const orphanRel = path.join('orchestray', 'v2320-orphan-fixture.md');
  const orphanAbs = path.join(targetDir, orphanRel);
  fs.mkdirSync(path.dirname(orphanAbs), { recursive: true });
  fs.writeFileSync(orphanAbs, '# stale doc from a prior version\n');
  const hash = _hashFile(orphanAbs);

  fs.mkdirSync(path.join(targetDir, 'orchestray'), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'orchestray', 'manifest.json'),
    JSON.stringify({
      manifest_schema: 2,
      version: '2.3.21',
      files: [orphanRel],
      files_hashes: { [orphanRel]: hash },
      hash_algorithm: 'sha256',
      hash_normalization: 'none',
    }, null, 2) + '\n',
  );
  return { targetDir, orphanRel, orphanAbs };
}

describe('bin/install.js end-to-end — orphan pruning', () => {

  test('CLAUDE.md scenario: a file in manifest N absent from manifest N+1 is removed', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-e2e-'));
    try {
      const { orphanAbs } = seedDeletableOrphan(tmp);
      const res = runInstall(tmp);
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

      assert.ok(!fs.existsSync(orphanAbs), 'orphaned fixture must be pruned');
      assert.match(res.stderr, /Pruned 1 orphaned file no longer shipped by this version\./);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an orphan modified since install is kept, reported, and not deleted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-mod-'));
    try {
      const targetDir = path.join(tmp, '.claude');
      const orphanRel = path.join('orchestray', 'v2320-orphan-fixture.md');
      const orphanAbs = path.join(targetDir, orphanRel);
      fs.mkdirSync(path.dirname(orphanAbs), { recursive: true });
      fs.writeFileSync(orphanAbs, '# user edited this file after install\n');

      fs.mkdirSync(path.join(targetDir, 'orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'orchestray', 'manifest.json'),
        JSON.stringify({
          manifest_schema: 2,
          version: '2.3.21',
          files: [orphanRel],
          files_hashes: { [orphanRel]: 'f'.repeat(64) }, // stale/wrong hash
          hash_algorithm: 'sha256',
          hash_normalization: 'none',
        }, null, 2) + '\n',
      );

      const res = runInstall(tmp);
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

      assert.ok(fs.existsSync(orphanAbs), 'modified orphan must survive');
      assert.match(
        res.stderr,
        /Kept 1 orphaned file no longer shipped by this version but modified since install/,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a missing previous manifest (fresh install) is a silent no-op', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-fresh-'));
    try {
      const res = runInstall(tmp);
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);
      assert.doesNotMatch(res.stderr, /orphaned file/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a corrupt previous manifest.json skips pruning without throwing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-corrupt-'));
    try {
      const targetDir = path.join(tmp, '.claude');
      const orphanRel = path.join('orchestray', 'v2320-orphan-fixture.md');
      const orphanAbs = path.join(targetDir, orphanRel);
      fs.mkdirSync(path.dirname(orphanAbs), { recursive: true });
      fs.writeFileSync(orphanAbs, 'would have been prunable if the manifest parsed\n');

      fs.mkdirSync(path.join(targetDir, 'orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'orchestray', 'manifest.json'),
        '{ this is not valid json,,,',
      );

      const res = runInstall(tmp);
      assert.equal(res.status, 0, 'a corrupt manifest.json must not crash the installer: ' + res.stderr);
      assert.doesNotMatch(res.stderr, /orphaned file/, 'pruning must be skipped entirely, not attempted');
      assert.ok(fs.existsSync(orphanAbs), 'file must survive since pruning never ran');
      // Sanity: the install itself still completed and wrote its own manifest.
      assert.ok(fs.existsSync(path.join(targetDir, 'orchestray', 'VERSION')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('kill switch: ORCHESTRAY_INSTALL_ORPHAN_PRUNE_DISABLED=1 skips the sweep', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-env-killswitch-'));
    try {
      const { orphanAbs } = seedDeletableOrphan(tmp);
      const res = runInstall(tmp, { ORCHESTRAY_INSTALL_ORPHAN_PRUNE_DISABLED: '1' });
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

      assert.ok(fs.existsSync(orphanAbs), 'env kill switch must prevent pruning');
      assert.doesNotMatch(res.stderr, /orphaned file/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('kill switch: .orchestray/config.json install_orphan_prune.enabled:false skips the sweep', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-config-killswitch-'));
    try {
      const { orphanAbs } = seedDeletableOrphan(tmp);
      fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify({ install_orphan_prune: { enabled: false } }, null, 2) + '\n',
      );

      const res = runInstall(tmp);
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

      assert.ok(fs.existsSync(orphanAbs), 'config kill switch must prevent pruning');
      assert.doesNotMatch(res.stderr, /orphaned file/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Vendored node_modules/ off-limits behavior is covered at the pure-function
  // level ('vendored node_modules/ entries are never pruned' above), not here:
  // orchestray/node_modules/ is ALSO the live target of the pre-existing
  // pruneStaleVendoredDeps sweep (bin/install.js), which deletes any directory
  // there not on its own allowlist regardless of the orphan sweep. Seeding a
  // fake vendored dir in this e2e fixture would get removed by that unrelated
  // sweep and prove nothing about pruneOrphanedFiles specifically.
  test('custom-agents/ content survives a real install even if listed as an orphan', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prune-orphan-offlimits-'));
    try {
      const targetDir = path.join(tmp, '.claude');
      const customAgentRel = path.join('orchestray', 'custom-agents', 'my-agent.md');
      const customAgentAbs = path.join(targetDir, customAgentRel);

      fs.mkdirSync(path.dirname(customAgentAbs), { recursive: true });
      fs.writeFileSync(customAgentAbs, '# user-authored specialist\n');

      fs.mkdirSync(path.join(targetDir, 'orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'orchestray', 'manifest.json'),
        JSON.stringify({
          manifest_schema: 2,
          version: '2.3.21',
          files: [customAgentRel],
          files_hashes: { [customAgentRel]: _hashFile(customAgentAbs) },
          hash_algorithm: 'sha256',
          hash_normalization: 'none',
        }, null, 2) + '\n',
      );

      const res = runInstall(tmp);
      assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

      assert.ok(fs.existsSync(customAgentAbs), 'custom-agents/ content must never be pruned');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
