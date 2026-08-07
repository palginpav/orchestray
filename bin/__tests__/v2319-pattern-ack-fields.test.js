#!/usr/bin/env node
'use strict';

/**
 * Tests for pattern-application-evidence-design.md §4.2 (Phase 2) —
 * patterns_used/patterns_rejected entry-shape validation and grace-mode
 * field-presence enforcement in bin/validate-task-completion.js.
 *
 * This is the mechanical fix for the 6,945:26 self-report gradient
 * (.orchestray/kb/decisions/times-applied-undercount-diagnosis.md): both
 * branches (used, rejected) now cost exactly one well-formed entry per
 * offered pattern — no cheaper null action is available.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-task-completion.js');
const HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

function validPayload(overrides = {}) {
  return {
    status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [],
    ...overrides,
  };
}

describe('isValidPatternAckEntry', () => {
  test('accepts a well-formed entry', () => {
    assert.equal(mod.isValidPatternAckEntry({ slug: 'foo', how: 'it shaped the decomposition' }, 'how'), true);
  });

  test('rejects a bare string (the cheap-null-action shape)', () => {
    assert.equal(mod.isValidPatternAckEntry('foo', 'how'), false);
  });

  test('rejects missing slug', () => {
    assert.equal(mod.isValidPatternAckEntry({ how: 'a real reason here' }, 'how'), false);
  });

  test('rejects prose shorter than 10 chars', () => {
    assert.equal(mod.isValidPatternAckEntry({ slug: 'foo', how: 'short' }, 'how'), false);
  });

  test('rejects prose longer than 300 chars', () => {
    assert.equal(mod.isValidPatternAckEntry({ slug: 'foo', how: 'x'.repeat(301) }, 'how'), false);
  });

  test('rejects empty-string prose (the other cheap-null-action shape)', () => {
    assert.equal(mod.isValidPatternAckEntry({ slug: 'foo', how: '' }, 'how'), false);
  });
});

describe('validateStructuredResult — patterns_used/patterns_rejected', () => {
  test('grace: absent fields do not block by default', () => {
    const v = mod.validateStructuredResult(validPayload());
    assert.equal(v.valid, true, 'absence must not block during the grace window');
  });

  test('enforced mode: absent fields DO block when opted in', () => {
    const v = mod.validateStructuredResult(validPayload(), { enforcePatternAckFields: true });
    assert.equal(v.valid, false);
    assert.ok(v.missing.includes('patterns_used'));
    assert.ok(v.missing.includes('patterns_rejected'));
  });

  test('present + well-formed entries pass regardless of grace mode', () => {
    const v = mod.validateStructuredResult(validPayload({
      patterns_used: [{ slug: 'decomposition-audit-fix-verify-cycle', how: 'drove the retry-loop structure' }],
      patterns_rejected: [{ slug: 'user-correction-no-deferral-rule', why: 'not applicable to this task' }],
    }));
    assert.equal(v.valid, true);
  });

  test('present but malformed entry blocks even during the grace window (shape is never graced)', () => {
    const v = mod.validateStructuredResult(validPayload({
      patterns_used: [{ slug: 'foo' }], // missing `how`
      patterns_rejected: [],
    }));
    assert.equal(v.valid, false, 'a malformed entry must not be cheaper than a well-formed one');
    assert.ok(v.missing.includes('patterns_used'));
  });

  test('symmetry rule: partial coverage via a bare-string array does not satisfy the contract', () => {
    // Proves the fix for the diagnosed gradient — an array of strings (the old
    // pattern_record_skip_reason-style cheap answer) cannot discharge the obligation.
    const v = mod.validateStructuredResult(validPayload({
      patterns_used: ['decomposition-audit-fix-verify-cycle'],
      patterns_rejected: ['user-correction-no-deferral-rule'],
    }));
    assert.equal(v.valid, false);
    assert.ok(v.missing.includes('patterns_used'));
    assert.ok(v.missing.includes('patterns_rejected'));
  });

  test('non-array patterns_used still flagged (base array-shape check preserved)', () => {
    const v = mod.validateStructuredResult(validPayload({ patterns_used: 'bad', patterns_rejected: [] }));
    assert.equal(v.valid, false);
    assert.ok(v.missing.includes('patterns_used'));
  });
});

describe('patternAckFieldsEnforced', () => {
  function withTmp(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-ack-grace-'));
    try {
      return fn(tmp);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('defaults to false with no config and no env override', () => {
    withTmp((tmp) => {
      assert.equal(mod.patternAckFieldsEnforced(tmp), false);
    });
  });

  test('config pattern_evidence.enforce_ack_fields=true flips it on', () => {
    withTmp((tmp) => {
      fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify({ pattern_evidence: { enforce_ack_fields: true } })
      );
      assert.equal(mod.patternAckFieldsEnforced(tmp), true);
    });
  });

  test('env kill switch overrides config in both directions', () => {
    withTmp((tmp) => {
      fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify({ pattern_evidence: { enforce_ack_fields: true } })
      );
      process.env.ORCHESTRAY_T15_PATTERN_ACK_FIELDS_ENFORCED = '0';
      try {
        assert.equal(mod.patternAckFieldsEnforced(tmp), false);
      } finally {
        delete process.env.ORCHESTRAY_T15_PATTERN_ACK_FIELDS_ENFORCED;
      }
    });
  });
});

function runHook(payload, cwd) {
  const tmp = cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-ack-hook-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { ...res, tmp };
}

describe('validate-task-completion — integration: pattern-ack grace + enforcement', () => {
  test('SubagentStop: old-shape payload (no patterns_used/patterns_rejected) passes during grace', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [],
        self_check_passed: true, tests_added_or_existing: true,
      }) + '\n```\n',
    });
    assert.equal(r.status, 0, 'in-flight/legacy agents must not be broken by the new fields');
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('SubagentStop: malformed patterns_used blocks even during grace', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [],
        self_check_passed: true, tests_added_or_existing: true,
        patterns_used: ['bare-string-slug'], patterns_rejected: [],
      }) + '\n```\n',
    });
    assert.equal(r.status, 2, 'malformed entries must block regardless of the presence grace window');
    const auditPath = path.join(r.tmp, '.orchestray', 'audit', 'events.jsonl');
    const content = fs.readFileSync(auditPath, 'utf8');
    assert.match(content, /patterns_used/);
    fs.rmSync(r.tmp, { recursive: true, force: true });
  });

  test('SubagentStop: enforced mode blocks a legacy payload missing the fields entirely', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-ack-enforced-'));
    fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'config.json'),
      JSON.stringify({ pattern_evidence: { enforce_ack_fields: true } })
    );
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [], assumptions: [],
        self_check_passed: true, tests_added_or_existing: true,
      }) + '\n```\n',
    }, tmp);
    assert.equal(r.status, 2, 'once enforced, absence of patterns_used/patterns_rejected must block');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
