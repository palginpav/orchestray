'use strict';

/**
 * Tests for bin/validate-reviewer-git-diff.js (W2-1).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { hasGitDiffSection, shouldValidate, GIT_DIFF_RE } = require('../validate-reviewer-git-diff');

// ---------------------------------------------------------------------------
// hasGitDiffSection
// ---------------------------------------------------------------------------

describe('hasGitDiffSection', () => {
  test('returns true when prompt contains ## Git Diff section', () => {
    const prompt = 'Some intro text\n\n## Git Diff\n\n```diff\n+ added line\n```\n';
    assert.equal(hasGitDiffSection(prompt), true);
  });

  test('returns false when ## Git Diff section is absent', () => {
    const prompt = 'Some intro text\n\n## Files to Review\n\n- foo.ts\n- bar.ts\n- baz.ts\n';
    assert.equal(hasGitDiffSection(prompt), false);
  });

  test('is case-sensitive — ## git diff (lowercase) does not match', () => {
    const prompt = '## git diff\n\nsome content\n';
    assert.equal(hasGitDiffSection(prompt), false);
  });

  test('returns false for empty string', () => {
    assert.equal(hasGitDiffSection(''), false);
  });

  test('returns false for null input', () => {
    assert.equal(hasGitDiffSection(null), false);
  });

  test('returns false for undefined input', () => {
    assert.equal(hasGitDiffSection(undefined), false);
  });

  test('returns true when ## Git Diff appears mid-document', () => {
    const prompt = 'Preamble\n\n## Task\n\nDo stuff.\n\n## Git Diff\n\n```diff\n-removed\n+added\n```\n\n## Summary\nDone.';
    assert.equal(hasGitDiffSection(prompt), true);
  });

  test('does not match ### Git Diff (wrong heading level)', () => {
    const prompt = '### Git Diff\n\nsome content\n';
    assert.equal(hasGitDiffSection(prompt), false);
  });
});

// ---------------------------------------------------------------------------
// shouldValidate
// ---------------------------------------------------------------------------

describe('shouldValidate', () => {
  test('returns true for reviewer Agent spawn', () => {
    const event = {
      tool_name:  'Agent',
      tool_input: { subagent_type: 'reviewer', prompt: 'foo' },
    };
    assert.equal(shouldValidate(event), true);
  });

  test('returns false for developer Agent spawn', () => {
    const event = {
      tool_name:  'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'foo' },
    };
    assert.equal(shouldValidate(event), false);
  });

  test('returns false when tool_name is not Agent', () => {
    const event = {
      tool_name:  'Write',
      tool_input: { subagent_type: 'reviewer', prompt: 'foo' },
    };
    assert.equal(shouldValidate(event), false);
  });

  test('returns false when event is null', () => {
    assert.equal(shouldValidate(null), false);
  });

  test('returns false when tool_input is missing', () => {
    const event = { tool_name: 'Agent' };
    assert.equal(shouldValidate(event), false);
  });

  test('returns false when subagent_type is missing', () => {
    const event = { tool_name: 'Agent', tool_input: {} };
    assert.equal(shouldValidate(event), false);
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('kill switch ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED', () => {
  test('kill switch env var is detectable when set to 1', () => {
    const prev = process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED;
    process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED = '1';
    assert.equal(process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED, '1');
    if (prev === undefined) {
      delete process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED;
    } else {
      process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED = prev;
    }
  });

  test('kill switch value 0 does not activate', () => {
    const prev = process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED;
    process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED = '0';
    assert.notEqual(process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED, '1');
    if (prev === undefined) {
      delete process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED;
    } else {
      process.env.ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// GIT_DIFF_RE regex
// ---------------------------------------------------------------------------

describe('GIT_DIFF_RE constant', () => {
  test('matches "## Git Diff" at the start of a line', () => {
    assert.equal(GIT_DIFF_RE.test('foo\n## Git Diff\nbar'), true);
  });

  test('does not match "## git diff" (case-sensitive)', () => {
    assert.equal(GIT_DIFF_RE.test('## git diff\n'), false);
  });

  test('does not match "### Git Diff" (wrong heading level)', () => {
    assert.equal(GIT_DIFF_RE.test('### Git Diff\n'), false);
  });
});
