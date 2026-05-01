#!/usr/bin/env node
'use strict';

/**
 * v2219-dual-install-pass2-allowlist.test.js — v2.2.19 T8 Fix 2 tests.
 *
 * Tests that pass 2 of `checkParity` in `bin/release-manager/dual-install-parity-check.js`
 * now honors `SOURCE_ONLY_ALLOWLIST` identically to pass 1.
 *
 * 3 cases:
 *   Case 1: `install.js` has different content between source and local install
 *           → pass 2 SKIPS it (allowlisted, not a content_mismatch).
 *   Case 2: Non-allowlisted file with content mismatch → pass 2 still flags it.
 *   Case 3: Allowlist values from SOURCE_ONLY_ALLOWLIST constant are applied
 *           identically in pass 1 (absent-from-target) and pass 2 (content mismatch).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const PARITY_MODULE = path.resolve(__dirname, '..', 'release-manager', 'dual-install-parity-check.js');
const { checkParity, isSourceOnlyAllowed } = require(PARITY_MODULE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal fixture with:
 *   cwd/bin/             — source tree
 *   cwd/.claude/orchestray/bin/ — local install (target)
 *
 * @param {Array<{name: string, sourceContent: string, targetContent?: string}>} files
 *   - sourceContent: content in source bin/
 *   - targetContent: content in target bin/ (omit to not create in target)
 * @returns {string} cwd
 */
function makeFixture(files) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'v2219-pass2-'));
  const sourceRoot = path.join(cwd, 'bin');
  const targetRoot = path.join(cwd, '.claude', 'orchestray', 'bin');

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  fs.mkdirSync(path.join(cwd, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.orchestray', 'state'), { recursive: true });

  for (const { name, sourceContent, targetContent } of files) {
    fs.writeFileSync(path.join(sourceRoot, name), sourceContent, 'utf8');
    if (targetContent !== undefined) {
      fs.writeFileSync(path.join(targetRoot, name), targetContent, 'utf8');
    }
  }

  return cwd;
}

// ---------------------------------------------------------------------------
// Case 1: install.js with different content → pass 2 skips (allowlisted)
// ---------------------------------------------------------------------------

describe('v2.2.19 T8 Fix 2 — Case 1: install.js mismatch is skipped by pass 2', () => {
  test('install.js with different content between source and target produces no divergences', () => {
    const cwd = makeFixture([
      {
        name: 'install.js',
        sourceContent: '// source version\nconsole.log("source");\n',
        targetContent: '// installed version\nconsole.log("installed");\n',
      },
    ]);

    const result = checkParity(cwd);

    assert.equal(result.skipped, false, 'checkParity should not skip (install tree exists)');
    assert.equal(result.divergences.length, 0,
      'install.js content mismatch should be filtered by SOURCE_ONLY_ALLOWLIST in pass 2');
  });

  test('install.js absent from target is also skipped (pass 1 allowlist behavior is preserved)', () => {
    const cwd = makeFixture([
      {
        name: 'install.js',
        sourceContent: '// source only\n',
        // No targetContent — file only in source
      },
    ]);

    const result = checkParity(cwd);

    // Pass 1 checks target-side orphans (present in target, absent from source).
    // Pass 2 checks content mismatches for files present in both.
    // install.js is source-only, so it won't appear in target at all — not flagged by either pass.
    assert.equal(result.divergences.length, 0,
      'install.js source-only (not in target) should produce no divergences');
  });
});

// ---------------------------------------------------------------------------
// Case 2: Non-allowlisted file with content mismatch → still flagged by pass 2
// ---------------------------------------------------------------------------

describe('v2.2.19 T8 Fix 2 — Case 2: non-allowlisted content mismatch is still flagged', () => {
  test('a regular script file with different content between source and target is flagged as content_mismatch', () => {
    const cwd = makeFixture([
      {
        name: 'my-tool.js',
        sourceContent: '// source\nconsole.log("v2");\n',
        targetContent: '// old version\nconsole.log("v1");\n',
      },
    ]);

    const result = checkParity(cwd);

    assert.equal(result.skipped, false, 'should not skip');
    const mismatches = result.divergences.filter((d) => d.divergence_type === 'content_mismatch');
    assert.equal(mismatches.length, 1,
      'non-allowlisted file with content mismatch should be flagged');
    assert.equal(mismatches[0].file_path, 'my-tool.js',
      'flagged file should be my-tool.js');
  });

  test('allowlisted and non-allowlisted files coexist: only non-allowlisted is flagged', () => {
    const cwd = makeFixture([
      {
        name: 'install.js',
        sourceContent: '// source install\n',
        targetContent: '// old install\n',
      },
      {
        name: 'collect-agent-metrics.js',
        sourceContent: '// new metrics\n',
        targetContent: '// old metrics\n',
      },
    ]);

    const result = checkParity(cwd);

    assert.equal(result.skipped, false);
    const mismatches = result.divergences.filter((d) => d.divergence_type === 'content_mismatch');
    assert.equal(mismatches.length, 1,
      'only the non-allowlisted file should be flagged');
    assert.equal(mismatches[0].file_path, 'collect-agent-metrics.js',
      'install.js should be filtered out; collect-agent-metrics.js should be flagged');
  });
});

// ---------------------------------------------------------------------------
// Case 3: SOURCE_ONLY_ALLOWLIST behavior is identical for pass 1 and pass 2
// ---------------------------------------------------------------------------

describe('v2.2.19 T8 Fix 2 — Case 3: SOURCE_ONLY_ALLOWLIST applied identically in pass 1 and pass 2', () => {
  test('isSourceOnlyAllowed returns true for all files in the allowlist constant', () => {
    // Files explicitly in SOURCE_ONLY_ALLOWLIST set.
    const allowlistedFiles = [
      'install.js',
      'install-pre-commit-guard.sh',
      'replay-last-n.sh',
    ];
    for (const f of allowlistedFiles) {
      assert.equal(isSourceOnlyAllowed(f), true,
        `${f} must be allowed by isSourceOnlyAllowed`);
    }
  });

  test('isSourceOnlyAllowed returns true for files under SOURCE_ONLY_DIR_PREFIXES', () => {
    const allowlistedDirFiles = [
      '__tests__/my.test.js',
      '_tools/helper.js',
      'learn-commands/cmd.js',
      '_lib/__tests__/lib.test.js',
      'release-manager/dual-install-parity-check.js',
    ];
    for (const f of allowlistedDirFiles) {
      assert.equal(isSourceOnlyAllowed(f), true,
        `${f} under a source-only dir prefix must be allowed`);
    }
  });

  test('isSourceOnlyAllowed returns false for regular installable files', () => {
    const nonAllowlisted = [
      'audit-dossier-orphan.js',
      'collect-agent-metrics.js',
      'inject-resilience-dossier.js',
      '_lib/audit-event-writer.js',
    ];
    for (const f of nonAllowlisted) {
      assert.equal(isSourceOnlyAllowed(f), false,
        `${f} must NOT be in the source-only allowlist`);
    }
  });

  test('pass 1 and pass 2 produce identical results for allowlisted files regardless of presence', () => {
    // Create a fixture where install.js is present in both with different content
    // AND a non-allowlisted file is present in both with different content.
    const cwd = makeFixture([
      {
        name: 'install.js',
        sourceContent: '// fresh source\n',
        targetContent: '// stale target\n',
      },
      {
        name: 'emit-orchestration-rollup.js',
        sourceContent: '// new rollup\n',
        targetContent: '// old rollup\n',
      },
    ]);

    const result = checkParity(cwd);

    // install.js should be skipped by both passes.
    const installJsDivergences = result.divergences.filter((d) => d.file_path === 'install.js');
    assert.equal(installJsDivergences.length, 0,
      'install.js should appear in zero divergences (skipped by allowlist in pass 2)');

    // The non-allowlisted file should be flagged.
    const rollupDivergences = result.divergences.filter(
      (d) => d.file_path === 'emit-orchestration-rollup.js'
    );
    assert.equal(rollupDivergences.length, 1,
      'emit-orchestration-rollup.js should be flagged as content_mismatch');
    assert.equal(rollupDivergences[0].divergence_type, 'content_mismatch');
  });
});
