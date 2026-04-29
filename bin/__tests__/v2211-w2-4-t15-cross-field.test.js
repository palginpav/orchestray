'use strict';

/**
 * Tests for bin/_lib/t15-cross-field.js (v2.2.11 W2-4).
 *
 * Covers:
 *   1. R1 violation: success_with_error_severity
 *   2. R2 violation: wrote_without_reading
 *   3. R3 violation: failure_without_issues
 *   4. No violation: clean success result
 *   5. Multiple violations: R1 + R3 in one input
 *   6. Malformed input: fail-open
 *   7. Hook integration: validate-task-completion emits t15_role_schema_violation
 *      with violation_kind:"cross_field" for an R1-violating result
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { validateCrossField } = require('../_lib/t15-cross-field');
const HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

// ---------------------------------------------------------------------------
// Unit tests for validateCrossField
// ---------------------------------------------------------------------------

describe('validateCrossField — R1: success_with_error_severity', () => {
  test('detects single error-severity issue when status is success', () => {
    const result = validateCrossField({
      status: 'success',
      issues: [{ severity: 'error', text: 'x' }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'success_with_error_severity');
    assert.equal(result.violations[0].field, 'issues[].severity');
  });

  test('no violation when status is success and all issues are warnings', () => {
    const result = validateCrossField({
      status: 'success',
      issues: [{ severity: 'warning', text: 'x' }],
    });
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
  });

  test('no violation when status is partial with error-severity issue', () => {
    const result = validateCrossField({
      status: 'partial',
      issues: [{ severity: 'error', text: 'x' }],
    });
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
  });
});

describe('validateCrossField — R2: wrote_without_reading', () => {
  test('detects non-empty files_changed with empty files_read', () => {
    const result = validateCrossField({
      status: 'success',
      files_changed: [{ path: 'a.js', description: 'x' }],
      files_read: [],
    });
    assert.equal(result.valid, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'wrote_without_reading');
    assert.equal(result.violations[0].field, 'files_read');
  });

  test('no violation when files_changed is non-empty and files_read is non-empty', () => {
    const result = validateCrossField({
      status: 'success',
      files_changed: [{ path: 'a.js', description: 'x' }],
      files_read: ['b.js'],
    });
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
  });

  test('no violation when both files_changed and files_read are empty', () => {
    const result = validateCrossField({
      status: 'success',
      files_changed: [],
      files_read: [],
    });
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
  });
});

describe('validateCrossField — R3: failure_without_issues', () => {
  test('detects failure status with empty issues array', () => {
    const result = validateCrossField({
      status: 'failure',
      issues: [],
    });
    assert.equal(result.valid, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'failure_without_issues');
    assert.equal(result.violations[0].field, 'issues');
  });

  test('no violation when failure has at least one issue', () => {
    const result = validateCrossField({
      status: 'failure',
      issues: [{ severity: 'error', text: 'blocked' }],
    });
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
  });
});

describe('validateCrossField — clean result', () => {
  test('no violations for fully clean success result', () => {
    const result = validateCrossField({
      status: 'success',
      issues: [{ severity: 'warning', text: 'x' }],
      files_changed: [{ path: 'a.js', description: 'x' }],
      files_read: ['b.js'],
    });
    assert.equal(result.valid, true);
    assert.equal(result.violations.length, 0);
  });
});

describe('validateCrossField — multiple violations', () => {
  test('combines R1 + R3 in one input — 2 violations', () => {
    // R1: status=success + error severity
    // R3 cannot combine with success (R3 requires status=failure), so combine R1 + R2 instead.
    // Actually: R1 = success + error-severity; R2 = files_changed>0 + files_read=0.
    // Let's combine R2 + R3 (failure + empty issues + files_changed without files_read).
    // But R3 requires failure. R2 just needs files_changed>0 and files_read=0.
    // Combine them: status=failure, issues=[], files_changed=[x], files_read=[] → R2+R3.
    const result = validateCrossField({
      status: 'failure',
      issues: [],
      files_changed: [{ path: 'a.js', description: 'x' }],
      files_read: [],
    });
    assert.equal(result.valid, false);
    assert.equal(result.violations.length, 2);
    const rules = result.violations.map(v => v.rule).sort();
    assert.deepEqual(rules, ['failure_without_issues', 'wrote_without_reading']);
  });

  test('R1 + R2 in one success input — 2 violations', () => {
    const result = validateCrossField({
      status: 'success',
      issues: [{ severity: 'error', text: 'x' }],
      files_changed: [{ path: 'a.js', description: 'x' }],
      files_read: [],
    });
    assert.equal(result.valid, false);
    assert.equal(result.violations.length, 2);
    const rules = result.violations.map(v => v.rule).sort();
    assert.deepEqual(rules, ['success_with_error_severity', 'wrote_without_reading']);
  });
});

describe('validateCrossField — malformed input (fail-open)', () => {
  test('null input → {valid:true, violations:[]}', () => {
    const r = validateCrossField(null);
    assert.equal(r.valid, true);
    assert.deepEqual(r.violations, []);
  });

  test('undefined input → {valid:true, violations:[]}', () => {
    const r = validateCrossField(undefined);
    assert.equal(r.valid, true);
    assert.deepEqual(r.violations, []);
  });

  test('non-object (string) → {valid:true, violations:[]}', () => {
    const r = validateCrossField('bad input');
    assert.equal(r.valid, true);
    assert.deepEqual(r.violations, []);
  });

  test('empty object (missing all keys) → {valid:true, violations:[]}', () => {
    const r = validateCrossField({});
    assert.equal(r.valid, true);
    assert.deepEqual(r.violations, []);
  });

  test('array input → {valid:true, violations:[]}', () => {
    const r = validateCrossField([{ status: 'success' }]);
    assert.equal(r.valid, true);
    assert.deepEqual(r.violations, []);
  });

  test('wrong types for array fields → {valid:true, violations:[]}', () => {
    // files_changed and files_read not arrays — R2 check should be skipped
    const r = validateCrossField({
      status: 'success',
      files_changed: 'not-array',
      files_read: 42,
      issues: [],
    });
    assert.equal(r.valid, true);
    assert.deepEqual(r.violations, []);
  });
});

// ---------------------------------------------------------------------------
// Integration test: hook emits t15_role_schema_violation with violation_kind:"cross_field"
// ---------------------------------------------------------------------------

describe('hook integration — cross-field violation emits correct event', () => {
  test('R1-violating input: hook emits t15_role_schema_violation with violation_kind cross_field', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-hook-test-'));
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    const orchState = { orchestration_id: 'test-orch-cross-field' };
    const stateDir = path.join(tmpDir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'orchestration.json'), JSON.stringify(orchState));

    const structuredResult = {
      status: 'success',
      summary: 'Done',
      // R1 violation: success with error-severity issue
      issues: [{ severity: 'error', text: 'something failed' }],
      files_changed: [],
      files_read: ['some-file.js'],
      assumptions: [],
    };

    const payload = {
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      cwd: tmpDir,
      output: '## Structured Result\n\n```json\n' + JSON.stringify(structuredResult) + '\n```\n',
    };

    const proc = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        // Disable role-schema blocking so we reach the cross-field check.
        // (developer role requires files_read, self_check_passed, etc.)
        ORCHESTRAY_T15_DEVELOPER_HARD_DISABLED: '1',
        // Disable artifact-path validation to avoid false blocks on empty paths.
        ORCHESTRAY_ARTIFACT_PATH_ENFORCEMENT: 'warn',
      },
    });

    // Hook should continue (cross-field is observability-only, not blocking).
    let out;
    try {
      out = JSON.parse(proc.stdout);
    } catch (_) {
      out = null;
    }
    assert.ok(out && out.continue === true,
      'hook must continue (cross-field is non-blocking). stdout: ' + proc.stdout + ' stderr: ' + proc.stderr);

    // Read the audit events file.
    const auditFiles = fs.readdirSync(auditDir).filter(f => f.endsWith('.jsonl'));
    assert.ok(auditFiles.length > 0, 'at least one audit events file should exist');

    const eventsRaw = fs.readFileSync(path.join(auditDir, auditFiles[0]), 'utf8');
    const events = eventsRaw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

    const cfEvent = events.find(e =>
      e.type === 't15_role_schema_violation' && e.violation_kind === 'cross_field'
    );
    assert.ok(cfEvent, 'should find a t15_role_schema_violation event with violation_kind:"cross_field"');
    assert.equal(cfEvent.violation_kind, 'cross_field');
    assert.ok(Array.isArray(cfEvent.violations), 'violations must be an array');
    assert.ok(cfEvent.violations.length >= 1, 'should have at least 1 cross-field violation');
    const cfRules = cfEvent.violations.map(v => v.rule);
    assert.ok(cfRules.includes('success_with_error_severity'),
      'should include success_with_error_severity rule. Got: ' + cfRules.join(', '));

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
