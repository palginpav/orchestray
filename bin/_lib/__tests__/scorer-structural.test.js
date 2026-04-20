#!/usr/bin/env node
'use strict';

/**
 * Tests for scorer-structural.js (B4 Eval Layer 1).
 *
 * Runner: node --test bin/_lib/__tests__/scorer-structural.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { scoreStructural, _internal } = require('../scorer-structural');
const { extractStructuredResult } = _internal;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-structural-test-'));
}

function makeEvent(overrides) {
  return Object.assign({
    hook_event_name:        'SubagentStop',
    agent_type:             'developer',
    agent_id:               'agent-abc',
    orchestration_id:       'orch-test-123',
    last_assistant_message: '',
    cwd:                    makeTmpDir(),
  }, overrides);
}

function wrapResult(obj) {
  return `## Structured Result\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}

// ---------------------------------------------------------------------------
// Case (a): 100% pass — valid structured result, all checks pass
// ---------------------------------------------------------------------------

describe('scorer-structural: (a) 100% pass', () => {
  test('all 6 checks pass → score === 1.0', () => {
    const sr = {
      status:        'success',
      summary:       'Implemented feature X',
      files_changed: ['src/foo.js'],
      files_read:    ['src/foo.js', 'src/bar.js'],
      issues:        [],
      assumptions:   ['No breaking changes expected'],
    };
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.strictEqual(result.passed, result.total, 'all checks should pass');
    assert.strictEqual(result.score, 1.0, 'score should be 1.0');
    assert.deepStrictEqual(result.failures, [], 'no failures');
  });
});

// ---------------------------------------------------------------------------
// Case (b): missing status field
// ---------------------------------------------------------------------------

describe('scorer-structural: (b) missing status', () => {
  test('missing status field → check2 fails', () => {
    const sr = {
      // no status
      summary:       'Done',
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [],
      assumptions:   ['one assumption'],
    };
    const event = makeEvent({
      agent_type:             'refactorer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.startsWith('check2_invalid_status')),
      'should have check2 failure for missing status');
    assert.ok(result.score < 1.0, 'score should be less than 1.0');
  });

  test('invalid status value → check2 fails', () => {
    const sr = {
      status:        'done', // not a valid status
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [],
      assumptions:   ['one'],
    };
    const event = makeEvent({
      agent_type:             'refactorer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.includes('check2')));
  });
});

// ---------------------------------------------------------------------------
// Case (c): files_changed > 0 & files_read === 0 (CRITIC fail)
// ---------------------------------------------------------------------------

describe('scorer-structural: (c) files_changed without files_read', () => {
  test('CRITIC evidence check fails when files_changed but no files_read', () => {
    const sr = {
      status:        'success',
      files_changed: ['src/a.js', 'src/b.js'],
      files_read:    [], // empty — CRITIC violation
      issues:        [],
      assumptions:   ['one assumption'],
    };
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.startsWith('check4_files_changed_without_files_read')),
      'should have CRITIC evidence failure');
    assert.ok(result.score < 1.0);
  });

  test('files_changed=0 & files_read=0 → check4 passes (no violation)', () => {
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    [],
      issues:        [],
      assumptions:   ['one'],
    };
    const event = makeEvent({
      agent_type:             'refactorer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(!result.failures.some((f) => f.startsWith('check4')),
      'check4 should pass when no files_changed');
  });
});

// ---------------------------------------------------------------------------
// Case (d): status=success with severity=error issue (inconsistent)
// ---------------------------------------------------------------------------

describe('scorer-structural: (d) status success with error issue', () => {
  test('status=success + issues[severity=error] → check5 fails', () => {
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [{ severity: 'error', description: 'Critical bug found' }],
      assumptions:   ['one'],
    };
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.startsWith('check5_status_success_with_error_issues')),
      'should detect inconsistent status');
  });

  test('status=failure + issues[severity=error] → check5 passes', () => {
    const sr = {
      status:        'failure',
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [{ severity: 'error', description: 'Critical bug found' }],
      assumptions:   ['one'],
    };
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(!result.failures.some((f) => f.startsWith('check5')),
      'check5 should pass when status=failure and errors present');
  });
});

// ---------------------------------------------------------------------------
// Case (e): missing assumptions — hard-tier (blocked)
// ---------------------------------------------------------------------------

describe('scorer-structural: (e) missing assumptions hard-tier', () => {
  test('developer with empty assumptions → check3 fails', () => {
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [],
      assumptions:   [], // empty → hard-tier fail
    };
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.startsWith('check3_assumptions_empty_hard_tier')),
      'should fail check3 for hard-tier with empty assumptions');
  });

  test('architect with empty assumptions → check3 fails', () => {
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    ['design.md'],
      issues:        [],
      assumptions:   [],
    };
    const event = makeEvent({
      agent_type:             'architect',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.startsWith('check3_assumptions_empty_hard_tier')));
  });

  test('reviewer with non-empty assumptions → check3 passes', () => {
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [],
      assumptions:   ['Reviewing only changed files'],
    };
    const event = makeEvent({
      agent_type:             'reviewer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(!result.failures.some((f) => f.startsWith('check3')),
      'check3 should pass for reviewer with non-empty assumptions');
  });
});

// ---------------------------------------------------------------------------
// Case (f): missing assumptions warn-tier (doesn't block score)
// ---------------------------------------------------------------------------

describe('scorer-structural: (f) missing assumptions warn-tier', () => {
  test('tester with empty assumptions → check3 passes (warn-tier)', () => {
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [],
      assumptions:   [], // empty — but tester is warn-tier, should be fine
    };
    const event = makeEvent({
      agent_type:             'tester',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(!result.failures.some((f) => f.startsWith('check3')),
      'tester (warn-tier) should not fail check3 for empty assumptions');
  });

  test('debugger with empty assumptions → check3 passes (warn-tier)', () => {
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    ['src/x.js'],
      issues:        [],
      assumptions:   [],
    };
    const event = makeEvent({
      agent_type:             'debugger',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(!result.failures.some((f) => f.startsWith('check3')));
  });
});

// ---------------------------------------------------------------------------
// Case (g): unparseable Structured Result
// ---------------------------------------------------------------------------

describe('scorer-structural: (g) unparseable Structured Result', () => {
  test('no JSON block → check1 fails, score < 1.0', () => {
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: 'I have completed the task. No structured result block here.',
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.startsWith('check1_unparseable_structured_result')),
      'should fail check1 for missing JSON');
    assert.ok(result.score < 1.0);
    assert.ok(result.score >= 0);
  });

  test('malformed JSON → check1 fails', () => {
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: '## Structured Result\n\n```json\n{ not valid json\n```\n',
    });

    const result = scoreStructural(event);

    assert.ok(result.failures.some((f) => f.startsWith('check1_unparseable_structured_result')));
  });

  test('total = 6, failed checks cascade gracefully', () => {
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: '',
    });

    const result = scoreStructural(event);

    assert.strictEqual(result.total, 6, 'always 6 checks');
    assert.ok(result.passed >= 0 && result.passed <= result.total);
    assert.ok(result.score >= 0 && result.score <= 1.0);
  });
});

// ---------------------------------------------------------------------------
// Case (h): hard-tier vs warn-tier behavior
// ---------------------------------------------------------------------------

describe('scorer-structural: (h) hard-tier vs warn-tier assumptions', () => {
  test('developer (hard-tier) with assumptions → passes check3', () => {
    const sr = {
      status:        'success',
      files_changed: ['src/x.js'],
      files_read:    ['src/x.js'],
      issues:        [],
      assumptions:   ['Existing tests cover the interface'],
    };
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    assert.ok(!result.failures.some((f) => f.startsWith('check3')),
      'developer with non-empty assumptions passes check3');
  });

  test('documenter (warn-tier) without assumptions key → check3 fails (array absent)', () => {
    // assumptions key is entirely missing — not just empty
    const sr = {
      status:        'success',
      files_changed: [],
      files_read:    ['README.md'],
      issues:        [],
      // no assumptions key
    };
    const event = makeEvent({
      agent_type:             'documenter',
      last_assistant_message: wrapResult(sr),
    });

    const result = scoreStructural(event);

    // assumptions array must be present (even empty is OK for warn-tier)
    // but if the key is entirely absent → fails check3
    assert.ok(result.failures.some((f) => f.startsWith('check3_assumptions_not_array')),
      'missing assumptions key entirely → check3 fails');
  });

  test('score is a number between 0 and 1 inclusive', () => {
    const event = makeEvent({
      agent_type:             'developer',
      last_assistant_message: 'garbage',
    });

    const result = scoreStructural(event);

    assert.ok(typeof result.score === 'number');
    assert.ok(result.score >= 0 && result.score <= 1.0);
  });
});

// ---------------------------------------------------------------------------
// extractStructuredResult unit tests
// ---------------------------------------------------------------------------

describe('extractStructuredResult', () => {
  test('valid JSON block extracted correctly', () => {
    const text = '## Structured Result\n\n```json\n{"status":"success"}\n```\n';
    const r = extractStructuredResult(text);
    assert.ok(r.ok);
    assert.strictEqual(r.result.status, 'success');
  });

  test('no JSON block → ok=false', () => {
    const r = extractStructuredResult('no structured result here');
    assert.ok(!r.ok);
  });

  test('malformed JSON → ok=false with reason', () => {
    const text = '## Structured Result\n\n```json\n{ bad\n```\n';
    const r = extractStructuredResult(text);
    assert.ok(!r.ok);
    assert.ok(r.reason.startsWith('parse_error'));
  });

  test('null/undefined input → ok=false', () => {
    assert.ok(!extractStructuredResult(null).ok);
    assert.ok(!extractStructuredResult(undefined).ok);
    assert.ok(!extractStructuredResult('').ok);
  });
});
