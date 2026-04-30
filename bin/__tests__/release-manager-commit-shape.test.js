'use strict';

/**
 * release-manager-commit-shape.test.js — v2.2.17 W5 (C-05)
 *
 * Asserts that the cumulative diff from the previous release tag to HEAD
 * touches ≥10 files (operator-visible release content, not just version-bump
 * bookkeeping). The test self-skips when no previous release tag exists.
 *
 * Per `.orchestray/kb/artifacts/v2217-plan.md` §4 ruling: scope is
 * `git diff <previous-release-tag>...HEAD`, NOT `HEAD~1` (which would only
 * cover the 2-file version-bump commit) and NOT `origin/master...HEAD`
 * (which is empty when HEAD lives on master).
 *
 * Default-off in `npm test` (env-gated) so partial dev work doesn't fail
 * CI; default-on in the release-manager spawn via `npm run test:release-shape`
 * which sets ORCHESTRAY_RELEASE_SHAPE_TEST_ENABLED=1.
 *
 * Kill switch: leaving the env var unset (or =0) disables the test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const ENABLED = process.env.ORCHESTRAY_RELEASE_SHAPE_TEST_ENABLED === '1';

test(
  'release commit shape: ≥10 files changed between prev release tag and HEAD',
  { skip: !ENABLED && 'env-gated; set ORCHESTRAY_RELEASE_SHAPE_TEST_ENABLED=1 to run' },
  () => {
    // Resolve the previous release tag — most recent v*.*.* tag that is NOT
    // the tag pointing at HEAD (covers the post-tag case where HEAD is itself
    // a release tag and the divergence range to HEAD~itself is zero).
    const tagsRaw = execFileSync('git', ['tag', '--sort=-creatordate'], { encoding: 'utf8' });
    const allTags = tagsRaw.split('\n').filter(t => /^v\d+\.\d+\.\d+$/.test(t));

    if (allTags.length === 0) {
      // Fresh repo — no prior release tag. Skip silently rather than fail.
      return;
    }

    let currentTag = '';
    try {
      currentTag = execFileSync(
        'git', ['describe', '--exact-match', '--tags', 'HEAD'],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
      ).trim();
    } catch (_) {
      // HEAD is not on a tag — currentTag stays empty.
    }

    const prevTag = allTags.find(t => t !== currentTag);
    assert.ok(prevTag, 'no previous release tag found');

    // Count files changed since the previous release tag.
    const filesRaw = execFileSync(
      'git', ['diff', `${prevTag}...HEAD`, '--name-only'],
      { encoding: 'utf8' },
    );
    const fileCount = filesRaw.split('\n').filter(Boolean).length;

    assert.ok(
      fileCount >= 10,
      `release shape gate FAIL: ${prevTag}...HEAD changed ${fileCount} files (need ≥10). ` +
      `If this is a hotfix-style narrow release, tag a hotfix variant (e.g., 2.2.16.1) ` +
      `instead of bumping the patch number.`,
    );
  },
);
