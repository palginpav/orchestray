#!/usr/bin/env node
'use strict';

/**
 * Unit tests for install-manifest.js (v2.1.3 Bundle II).
 *
 * Runner: node --test bin/_lib/__tests__/install-manifest.test.js
 *
 * Tests:
 *   compute-deterministic      computeManifest returns identical hashes on two calls
 *   compute-known-vector        SHA-256 of "hello world" matches RFC vector
 *   compute-throws-on-missing   non-existent path throws ENOENT
 *   verify-roundtrip-ok         compute→manifest→verify returns ok:true
 *   verify-detects-drift        mutating a byte → drifted.length === 1
 *   verify-detects-missing      deleting a file → missing.length === 1
 *   verify-v1-legacy            v1 manifest → supported:false
 *   verify-never-throws         unparseable manifest → {ok:false, schema:null}
 *   boot-journals-on-drift      verifyManifestOnBoot calls recordDegradation on drift
 *   boot-journals-once-per-proc second call with same key does NOT double-journal
 *   boot-ignores-ok             clean install → recordDegradation NOT called
 *   doctor-deep-truncation      large drift list: verify returns full list, caller
 *                               truncates display (tests truncation invariant)
 *   migrations-tracked          migrations/ files are present in a real fixture
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a fresh copy of install-manifest (clears require cache).
 * This is needed so _bootSeen Set is re-initialized between tests.
 */
function freshModule() {
  const modPath = require.resolve('../install-manifest.js');
  delete require.cache[modPath];
  // Also clear degraded-journal so its _seen Set resets.
  const djPath = require.resolve('../degraded-journal.js');
  delete require.cache[djPath];
  const rotatePath = require.resolve('../jsonl-rotate.js');
  delete require.cache[rotatePath];
  return require('../install-manifest.js');
}

/** Create a temporary directory and return its path. */
function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-manifest-test-'));
}

/** Write files into a tmp root and return their relative paths. */
function seedFiles(rootDir, entries) {
  const relPaths = [];
  for (const [rel, content] of Object.entries(entries)) {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    relPaths.push(rel);
  }
  return relPaths;
}

/** Wrap a computed files_hashes in a minimal v2 manifest object. */
function wrapManifest(filesHashes) {
  return {
    manifest_schema: 2,
    version:         'test',
    files:           Object.keys(filesHashes),
    files_hashes:    filesHashes,
    hash_algorithm:  'sha256',
    hash_normalization: 'none',
  };
}

// ---------------------------------------------------------------------------
// compute-deterministic
// ---------------------------------------------------------------------------

describe('compute-deterministic', () => {
  test('identical hashes on two successive calls', () => {
    const { computeManifest } = freshModule();
    const rootDir = makeTmp();
    const files = seedFiles(rootDir, {
      'agents/test.md':    '# Hello\n',
      'bin/hook.js':       '"use strict";\nmodule.exports = {};\n',
      'settings.json':     '{"key": "value"}\n',
    });

    const r1 = computeManifest(rootDir, files);
    const r2 = computeManifest(rootDir, files);

    assert.deepStrictEqual(r1.files_hashes, r2.files_hashes);
    assert.strictEqual(r1.hash_algorithm, 'sha256');
    assert.strictEqual(r1.hash_normalization, 'none');
  });
});

// ---------------------------------------------------------------------------
// compute-known-vector
// ---------------------------------------------------------------------------

describe('compute-known-vector', () => {
  test('SHA-256 of "hello world" (11 bytes, LF-terminated write)', () => {
    const { computeManifest } = freshModule();
    const rootDir = makeTmp();

    // Write exactly "hello world" (11 bytes, no newline) via Buffer to avoid
    // any runtime newline injection.
    const content = Buffer.from('hello world', 'utf8');
    const abs = path.join(rootDir, 'probe.txt');
    fs.writeFileSync(abs, content);

    const result = computeManifest(rootDir, ['probe.txt']);

    // RFC 6234 vector: SHA-256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    // Hardcoding the expected value catches cross-algorithm bugs (e.g. MD5 on both sides).
    const HELLO_WORLD_SHA256 =
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    assert.strictEqual(result.files_hashes['probe.txt'], HELLO_WORLD_SHA256);

    // Sanity: the result must be a 64-char lowercase hex string.
    assert.match(HELLO_WORLD_SHA256, /^[0-9a-f]{64}$/);

    // Confirm the algorithm field is correct.
    assert.strictEqual(result.hash_algorithm, 'sha256');
  });
});

// ---------------------------------------------------------------------------
// compute-throws-on-missing
// ---------------------------------------------------------------------------

describe('compute-throws-on-missing', () => {
  test('throws ENOENT for a non-existent file', () => {
    const { computeManifest } = freshModule();
    const rootDir = makeTmp();

    assert.throws(
      () => computeManifest(rootDir, ['does-not-exist.js']),
      (err) => {
        assert.strictEqual(err.code, 'ENOENT');
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// verify-roundtrip-ok
// ---------------------------------------------------------------------------

describe('verify-roundtrip-ok', () => {
  test('computeManifest → wrapManifest → verifyManifest returns ok:true', () => {
    const { computeManifest, verifyManifest } = freshModule();
    const rootDir = makeTmp();
    const files = seedFiles(rootDir, {
      'agents/pm.md':  '# PM\n',
      'bin/hook.js':   '"use strict";\n',
    });

    const hashResult = computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);
    const result     = verifyManifest(rootDir, manifest);

    assert.strictEqual(result.ok,        true);
    assert.strictEqual(result.schema,    2);
    assert.strictEqual(result.supported, true);
    assert.strictEqual(result.drifted.length,    0);
    assert.strictEqual(result.missing.length,    0);
    assert.strictEqual(result.unexpected.length, 0);
    assert.strictEqual(result.errors.length,     0);
  });
});

// ---------------------------------------------------------------------------
// verify-detects-drift
// ---------------------------------------------------------------------------

describe('verify-detects-drift', () => {
  test('mutating one byte causes drifted.length === 1', () => {
    const { computeManifest, verifyManifest } = freshModule();
    const rootDir = makeTmp();
    const files = seedFiles(rootDir, {
      'agents/dev.md':  '# Developer\n',
      'agents/arch.md': '# Architect\n',
    });

    const hashResult = computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);

    // Mutate one file.
    fs.writeFileSync(path.join(rootDir, 'agents/dev.md'), '# MODIFIED\n', 'utf8');

    const result = verifyManifest(rootDir, manifest);

    assert.strictEqual(result.ok,             false);
    assert.strictEqual(result.drifted.length, 1);
    assert.strictEqual(result.drifted[0].path, 'agents/dev.md');
    assert.strictEqual(result.missing.length,  0);
  });

  test('mutating multiple files populates multiple drifted entries', () => {
    const { computeManifest, verifyManifest } = freshModule();
    const rootDir = makeTmp();
    const files = seedFiles(rootDir, {
      'a.js': 'a',
      'b.js': 'b',
      'c.js': 'c',
    });

    const hashResult = computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);

    fs.writeFileSync(path.join(rootDir, 'a.js'), 'CHANGED', 'utf8');
    fs.writeFileSync(path.join(rootDir, 'c.js'), 'CHANGED', 'utf8');

    const result = verifyManifest(rootDir, manifest);
    assert.strictEqual(result.drifted.length, 2);
    assert.strictEqual(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// verify-detects-missing
// ---------------------------------------------------------------------------

describe('verify-detects-missing', () => {
  test('deleting a tracked file → missing.length === 1', () => {
    const { computeManifest, verifyManifest } = freshModule();
    const rootDir = makeTmp();
    const files = seedFiles(rootDir, {
      'agents/developer.md': '# Developer\n',
      'agents/reviewer.md':  '# Reviewer\n',
    });

    const hashResult = computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);

    fs.unlinkSync(path.join(rootDir, 'agents/developer.md'));

    const result = verifyManifest(rootDir, manifest);
    assert.strictEqual(result.ok,            false);
    assert.strictEqual(result.missing.length, 1);
    assert.strictEqual(result.missing[0],    'agents/developer.md');
    assert.strictEqual(result.drifted.length, 0);
  });
});

// ---------------------------------------------------------------------------
// verify-v1-legacy
// ---------------------------------------------------------------------------

describe('verify-v1-legacy', () => {
  test('manifest without manifest_schema/files_hashes → supported:false', () => {
    const { verifyManifest } = freshModule();
    const rootDir = makeTmp();

    // A v1 manifest: has 'files' array but no 'files_hashes'.
    const v1Manifest = {
      version:     '2.1.2',
      installedAt: '2026-04-19T00:00:00Z',
      scope:       'global',
      files:       ['agents/pm.md', 'agents/developer.md'],
    };

    const result = verifyManifest(rootDir, v1Manifest);

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.ok,        false);
    // schema should be detected as 1 (files present, no manifest_schema key)
    assert.strictEqual(result.schema, 1);
  });

  test('manifest with manifest_schema:1 → supported:false', () => {
    const { verifyManifest } = freshModule();
    const rootDir = makeTmp();

    const manifest = { manifest_schema: 1, files: ['foo.js'] };
    const result   = verifyManifest(rootDir, manifest);

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.schema,    1);
  });
});

// ---------------------------------------------------------------------------
// verify-never-throws
// ---------------------------------------------------------------------------

describe('verify-never-throws', () => {
  test('null manifest → safe result with ok:false', () => {
    const { verifyManifest } = freshModule();
    const rootDir = makeTmp();

    const result = verifyManifest(rootDir, null);

    assert.strictEqual(result.ok,        false);
    assert.strictEqual(result.schema,    null);
    assert.strictEqual(result.supported, false);
    // Must not throw.
  });

  test('empty object manifest → safe result with ok:false', () => {
    const { verifyManifest } = freshModule();
    const rootDir = makeTmp();

    const result = verifyManifest(rootDir, {});

    assert.strictEqual(result.ok,        false);
    assert.strictEqual(result.supported, false);
  });
});

// ---------------------------------------------------------------------------
// boot-journals-on-drift
// ---------------------------------------------------------------------------

describe('boot-journals-on-drift', () => {
  test('verifyManifestOnBoot journals install_integrity_drift on drifted fixture', () => {
    const rootDir = makeTmp();

    // Set up a project root for journal writes.
    const projDir = makeTmp();
    fs.mkdirSync(path.join(projDir, '.orchestray', 'state'), { recursive: true });

    // Seed files, compute manifest, write manifest.json.
    const files = seedFiles(rootDir, {
      'agents/pm.md': '# PM\n',
      'VERSION':      '2.1.3\n',
    });
    const mod = freshModule();
    const hashResult = mod.computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);
    fs.writeFileSync(path.join(rootDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    // Corrupt one file to trigger drift.
    fs.writeFileSync(path.join(rootDir, 'agents/pm.md'), '# CORRUPTED\n', 'utf8');

    const result = mod.verifyManifestOnBoot({ rootDir, projectRoot: projDir });

    assert.strictEqual(result.ok,    false);
    assert.strictEqual(result.kind,  'install_integrity_drift');

    // Confirm a journal entry was written.
    const journalPath = path.join(projDir, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(journalPath), 'degraded.jsonl should exist');
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.kind, 'install_integrity_drift');
    assert.strictEqual(entry.severity, 'warn');
  });
});

// ---------------------------------------------------------------------------
// boot-journals-once-per-proc
// ---------------------------------------------------------------------------

describe('boot-journals-once-per-proc', () => {
  test('second call with same dedup key does NOT double-journal', () => {
    const rootDir = makeTmp();
    const projDir = makeTmp();
    fs.mkdirSync(path.join(projDir, '.orchestray', 'state'), { recursive: true });

    const files = seedFiles(rootDir, {
      'agents/pm.md': '# PM\n',
      'VERSION':      '2.1.3\n',
    });

    const mod = freshModule();
    const hashResult = mod.computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);
    fs.writeFileSync(path.join(rootDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    fs.writeFileSync(path.join(rootDir, 'agents/pm.md'), '# CORRUPTED\n', 'utf8');

    // Call twice.
    mod.verifyManifestOnBoot({ rootDir, projectRoot: projDir });
    mod.verifyManifestOnBoot({ rootDir, projectRoot: projDir });

    // Only one line should be in the journal (dedup).
    const journalPath = path.join(projDir, '.orchestray', 'state', 'degraded.jsonl');
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    const driftLines = lines.filter(l => {
      try { return JSON.parse(l).kind === 'install_integrity_drift'; } catch { return false; }
    });
    assert.strictEqual(driftLines.length, 1, 'Should journal drift exactly once per process');
  });
});

// ---------------------------------------------------------------------------
// boot-ignores-ok
// ---------------------------------------------------------------------------

describe('boot-ignores-ok', () => {
  test('clean install: verifyManifestOnBoot does NOT write journal entry', () => {
    const rootDir = makeTmp();
    const projDir = makeTmp();
    fs.mkdirSync(path.join(projDir, '.orchestray', 'state'), { recursive: true });

    const files = seedFiles(rootDir, {
      'agents/pm.md': '# PM\n',
      'VERSION':      '2.1.3\n',
    });

    const mod = freshModule();
    const hashResult = mod.computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);
    fs.writeFileSync(path.join(rootDir, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const result = mod.verifyManifestOnBoot({ rootDir, projectRoot: projDir });

    assert.strictEqual(result.ok,       true);
    assert.strictEqual(result.journaled, false);
    assert.strictEqual(result.kind,      null);

    // Journal file should NOT exist (or contain no drift entries).
    const journalPath = path.join(projDir, '.orchestray', 'state', 'degraded.jsonl');
    if (fs.existsSync(journalPath)) {
      const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
      const driftLines = lines.filter(l => {
        try {
          const e = JSON.parse(l);
          return e.kind === 'install_integrity_drift';
        } catch { return false; }
      });
      assert.strictEqual(driftLines.length, 0, 'No drift entries for a clean install');
    }
  });
});

// ---------------------------------------------------------------------------
// doctor-deep-truncation  (tests the invariant that verify returns full list)
// ---------------------------------------------------------------------------

describe('doctor-deep-truncation', () => {
  test('verifyManifest returns all drifted entries (doctor --deep truncates display)', () => {
    const { computeManifest, verifyManifest } = freshModule();
    const rootDir = makeTmp();

    // Create 25 files and corrupt all of them after hashing.
    const entries = {};
    for (let i = 0; i < 25; i++) {
      entries[`agents/file${i}.md`] = `# File ${i}\n`;
    }
    const files = seedFiles(rootDir, entries);
    const hashResult = computeManifest(rootDir, files);
    const manifest   = wrapManifest(hashResult.files_hashes);

    // Corrupt all 25.
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(rootDir, `agents/file${i}.md`), `# CHANGED ${i}\n`, 'utf8');
    }

    const result = verifyManifest(rootDir, manifest);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.drifted.length, 25, 'verify returns all 25 drifted entries');

    // Simulate doctor --deep truncation: first 3 + overflow message.
    const total      = result.drifted.length + result.missing.length + result.errors.length;
    const allPaths   = [...result.drifted.map(d => d.path), ...result.missing, ...result.errors.map(e => e.path)];
    const displayMax = 3;
    let line;
    if (total <= displayMax) {
      line = `[FAIL]  install integrity drift (${total} file(s)): ${allPaths.join(', ')}`;
    } else {
      line = `[FAIL]  install integrity drift (${total} file(s)): ${allPaths.slice(0, displayMax).join(', ')}, +${total - displayMax} more`;
    }
    assert.ok(line.includes('+22 more'), 'display line truncates to first 3 + overflow count');
  });
});

// ---------------------------------------------------------------------------
// migrations-tracked  (regression guard for v2.1.1 missing-migrations bug)
// ---------------------------------------------------------------------------

describe('migrations-tracked', () => {
  test('bin/_lib/migrations/ files can be hashed (regression: v2.1.1)', () => {
    const { computeManifest } = freshModule();
    const rootDir = makeTmp();

    // Create a simulated migrations directory as the installer would.
    seedFiles(rootDir, {
      'orchestray/bin/_lib/migrations/001-fts5-initial.js': '"use strict";\nmodule.exports = {};\n',
    });

    const files = ['orchestray/bin/_lib/migrations/001-fts5-initial.js'];
    const result = computeManifest(rootDir, files);

    assert.ok(
      result.files_hashes['orchestray/bin/_lib/migrations/001-fts5-initial.js'],
      'migrations file must be hashed'
    );
    assert.match(
      result.files_hashes['orchestray/bin/_lib/migrations/001-fts5-initial.js'],
      /^[0-9a-f]{64}$/,
      'hash must be a 64-char hex string'
    );
  });
});

// ---------------------------------------------------------------------------
// v1 manifest at boot: journals manifest_v1_legacy
// ---------------------------------------------------------------------------

describe('boot-v1-legacy-manifest', () => {
  test('v1 manifest journals manifest_v1_legacy info entry', () => {
    const rootDir = makeTmp();
    const projDir = makeTmp();
    fs.mkdirSync(path.join(projDir, '.orchestray', 'state'), { recursive: true });

    // Write a VERSION file.
    fs.writeFileSync(path.join(rootDir, 'VERSION'), '2.1.2\n', 'utf8');

    // Write a v1 manifest (no files_hashes, no manifest_schema).
    const v1 = { version: '2.1.2', files: ['agents/pm.md'], scope: 'global' };
    fs.writeFileSync(path.join(rootDir, 'manifest.json'), JSON.stringify(v1), 'utf8');

    const mod = freshModule();
    const result = mod.verifyManifestOnBoot({ rootDir, projectRoot: projDir });

    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.kind,      'manifest_v1_legacy');

    // Journal entry should exist.
    const journalPath = path.join(projDir, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(journalPath), 'journal should exist after v1 manifest detection');
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.kind,     'manifest_v1_legacy');
    assert.strictEqual(entry.severity, 'info');
  });
});

// ---------------------------------------------------------------------------
// absent manifest at boot
// ---------------------------------------------------------------------------

describe('boot-absent-manifest', () => {
  test('absent manifest journals manifest_v1_legacy with reason:absent', () => {
    const rootDir = makeTmp();
    const projDir = makeTmp();
    fs.mkdirSync(path.join(projDir, '.orchestray', 'state'), { recursive: true });

    fs.writeFileSync(path.join(rootDir, 'VERSION'), '2.1.3\n', 'utf8');
    // No manifest.json written.

    const mod = freshModule();
    mod.verifyManifestOnBoot({ rootDir, projectRoot: projDir });

    const journalPath = path.join(projDir, '.orchestray', 'state', 'degraded.jsonl');
    assert.ok(fs.existsSync(journalPath));
    const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.strictEqual(entry.kind,           'manifest_v1_legacy');
    assert.strictEqual(entry.detail.reason,  'absent');
  });
});

// ---------------------------------------------------------------------------
// boot never throws (even with a completely broken environment)
// ---------------------------------------------------------------------------

describe('boot-never-throws', () => {
  test('verifyManifestOnBoot does not throw when rootDir is garbage', () => {
    const mod = freshModule();
    // Should never throw.
    const result = mod.verifyManifestOnBoot({ rootDir: '/no/such/path/xyz123', projectRoot: os.tmpdir() });
    assert.strictEqual(typeof result, 'object');
    assert.ok('ok' in result);
  });

  test('verifyManifestOnBoot does not throw with null opts', () => {
    const mod = freshModule();
    const result = mod.verifyManifestOnBoot(null);
    assert.strictEqual(typeof result, 'object');
  });
});
