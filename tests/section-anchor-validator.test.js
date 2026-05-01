#!/usr/bin/env node
'use strict';

/**
 * section-anchor-validator.test.js — v2.2.21 G3-W3-T9.
 *
 * Tests the `--scan-pm` mode of `bin/_tools/phase-split-validate-refs.js`,
 * which scans `agents/pm.md` for inline cross-references of the form
 *   "Section N (in <file>.md)"  /  "Section N, in <file>.md"
 * and verifies each anchor exists in the named target file.
 *
 * The validator's job is to lock in the cross-reference rot fixes shipped
 * by G3-W3-T9 (E-CO-1..3 + I-DO-1..3 + W-OP-3..4) so future drift is
 * caught mechanically instead of via prose review.
 *
 * Coverage:
 *   1. The live tree passes scan-pm with zero failures (the "would fail
 *      if any anchor were removed" lock).
 *   2. A synthetic pm.md with a known-bad anchor reports exactly one failure
 *      and exits non-zero (the validator actually catches drift, not just
 *      green-rubber-stamps everything).
 *   3. Alphanumeric section suffixes ("40b", "22a", "43c") resolve correctly
 *      against headings like `## 40b: Thread Matching`.
 *   4. Both pointer styles resolve: `(in foo.md)` AND `, in foo.md`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/_tools/phase-split-validate-refs.js');
const REPO_ROOT = path.resolve(__dirname, '..');

function runScanPm(extraArgs = [], cwd = REPO_ROOT) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--scan-pm', ...extraArgs],
    { encoding: 'utf8', cwd },
  );
}

describe('phase-split-validate-refs --scan-pm', () => {
  test('live agents/pm.md passes (zero unresolved Section N refs)', () => {
    const r = runScanPm();
    assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.status, 'pass');
    assert.equal(out.summary.total_failures, 0);
  });

  test('catches synthetic missing anchor (regression: would fail if rot reintroduced)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-anchor-test-'));
    try {
      const slicesDir = path.join(tmpDir, 'agents', 'pm-reference');
      fs.mkdirSync(slicesDir, { recursive: true });
      // Target file with NO matching heading for "Section 999".
      fs.writeFileSync(
        path.join(slicesDir, 'phase-fake.md'),
        '# Phase: Fake\n\n## 1. Real Heading\n\nbody\n',
      );
      const pmPath = path.join(tmpDir, 'agents', 'pm.md');
      fs.mkdirSync(path.dirname(pmPath), { recursive: true });
      fs.writeFileSync(
        pmPath,
        '# PM\n\nFollow Section 999 (in phase-fake.md) for the protocol.\n',
      );
      const r = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--scan-pm',
          '--pm-path', pmPath,
          '--slices-dir', slicesDir,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 1, 'validator must exit 1 when anchor is missing');
      // Failure detail should mention the target file.
      assert.match(r.stderr, /phase-fake\.md/);
      assert.match(r.stderr, /Section 999/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('alphanumeric section suffixes resolve (40b, 22a, 43c)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-anchor-test-'));
    try {
      const slicesDir = path.join(tmpDir, 'agents', 'pm-reference');
      fs.mkdirSync(slicesDir, { recursive: true });
      fs.writeFileSync(
        path.join(slicesDir, 'thread-x.md'),
        '# Thread\n\n## 40b: Thread Matching\n\nbody\n',
      );
      fs.writeFileSync(
        path.join(slicesDir, 'replay-x.md'),
        '# Replay\n\n## 43c. Replay Pattern Writing\n\nbody\n',
      );
      const pmPath = path.join(tmpDir, 'agents', 'pm.md');
      fs.mkdirSync(path.dirname(pmPath), { recursive: true });
      fs.writeFileSync(
        pmPath,
        '# PM\n\nUse Section 40b (in thread-x.md) and Section 43c (in replay-x.md).\n',
      );
      const r = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--scan-pm',
          '--pm-path', pmPath,
          '--slices-dir', slicesDir,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.summary.total_failures, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('both pointer styles resolve: "(in foo.md)" and ", in foo.md"', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'section-anchor-test-'));
    try {
      const slicesDir = path.join(tmpDir, 'agents', 'pm-reference');
      fs.mkdirSync(slicesDir, { recursive: true });
      fs.writeFileSync(
        path.join(slicesDir, 'a.md'),
        '## 14. Parallel Execution Protocol\n\nbody\n',
      );
      fs.writeFileSync(
        path.join(slicesDir, 'b.md'),
        '## 24. Security Integration Protocol\n\nbody\n',
      );
      const pmPath = path.join(tmpDir, 'agents', 'pm.md');
      fs.mkdirSync(path.dirname(pmPath), { recursive: true });
      fs.writeFileSync(
        pmPath,
        '# PM\n\nA: Section 14 (Parallel Execution Protocol, in a.md).\n' +
        'B: Section 24 (in b.md) for security.\n',
      );
      const r = spawnSync(
        process.execPath,
        [
          SCRIPT,
          '--scan-pm',
          '--pm-path', pmPath,
          '--slices-dir', slicesDir,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(r.status, 0, `expected exit 0; stderr=${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.summary.total_failures, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exposes scanInlineSectionRefs from module.exports', () => {
    const mod = require(SCRIPT);
    assert.equal(typeof mod.scanInlineSectionRefs, 'function');
    assert.equal(typeof mod.headingResolves, 'function');
    assert.equal(typeof mod.readHeadings, 'function');
  });
});
