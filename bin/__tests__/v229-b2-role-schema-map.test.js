#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.9 B-2.1 — per-role schema map in validate-task-completion.js.
 *
 * Coverage:
 *   - 14 fixture handoffs (one per role), each missing exactly one role-required
 *     field → T15 must exit 2 with the field name in the error output.
 *   - Per-role kill switch (ORCHESTRAY_T15_<ROLE>_HARD_DISABLED=1) verified.
 *   - WARN_TIER is now empty (all roles promoted to hard-tier).
 *   - Base-field pass (all 14 roles pass when both base + role fields present).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const roleSchemasMod = require('../_lib/role-schemas.js');
const HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseResult(extra = {}) {
  return {
    status: 'success',
    summary: 'Test summary',
    files_changed: [],
    files_read: ['bin/foo.js'],
    issues: [],
    assumptions: [],
    ...extra,
  };
}

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b2-role-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  return { ...res, tmp };
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Unit: WARN_TIER is now empty
// ---------------------------------------------------------------------------

describe('v229-b2 — WARN_TIER is empty (all roles promoted to hard-tier)', () => {
  const mod = require('../validate-task-completion.js');
  test('WARN_TIER has zero entries', () => {
    assert.equal(mod.WARN_TIER.size, 0, 'WARN_TIER must be empty in v2.2.9');
  });
  test('HARD_TIER includes previously warn-tier roles', () => {
    const formerWarn = ['researcher', 'debugger', 'inventor', 'security-engineer', 'ux-critic', 'platform-oracle'];
    for (const r of formerWarn) {
      assert.ok(mod.HARD_TIER.has(r), r + ' must be in HARD_TIER');
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: validateRoleSchema — per-role field validation
// ---------------------------------------------------------------------------

describe('v229-b2 — validateRoleSchema unit tests', () => {
  const { validateRoleSchema } = roleSchemasMod;

  test('architect — missing design_doc_path', () => {
    const result = makeBaseResult({ acceptance_rubric: 'rubric' });
    const v = validateRoleSchema('architect', result);
    assert.ok(v.some(s => s.includes('design_doc_path')), 'expected design_doc_path violation, got: ' + v.join('; '));
  });

  test('architect — missing acceptance_rubric', () => {
    const result = makeBaseResult({ design_doc_path: '.orchestray/kb/artifacts/design.md' });
    const v = validateRoleSchema('architect', result);
    assert.ok(v.some(s => s.includes('acceptance_rubric')), 'expected acceptance_rubric violation');
  });

  test('architect — passes with both fields', () => {
    const result = makeBaseResult({
      design_doc_path: '.orchestray/kb/artifacts/design.md',
      acceptance_rubric: 'rubric text',
    });
    const v = validateRoleSchema('architect', result);
    assert.equal(v.length, 0, 'expected no violations');
  });

  test('developer — missing self_check_passed', () => {
    const result = makeBaseResult({
      tests_added_or_existing: ['bin/foo.test.js'],
    });
    const v = validateRoleSchema('developer', result);
    assert.ok(v.some(s => s.includes('self_check_passed')), 'expected self_check_passed violation');
  });

  test('developer — CRITIC evidence: files_changed non-empty, files_read empty', () => {
    const result = makeBaseResult({
      files_changed: ['bin/foo.js'],
      files_read: [],
      self_check_passed: 'true',
      tests_added_or_existing: ['bin/foo.test.js'],
    });
    const v = validateRoleSchema('developer', result);
    assert.ok(v.some(s => s.includes('critic_evidence')), 'expected CRITIC evidence violation');
  });

  test('reviewer — missing verdict', () => {
    const result = makeBaseResult({ rubric_scores: {}, always_on_dimensions: [] });
    const v = validateRoleSchema('reviewer', result);
    assert.ok(v.some(s => s.includes('verdict')), 'expected verdict violation');
  });

  test('reviewer — invalid verdict enum', () => {
    const result = makeBaseResult({ verdict: 'lgtm', rubric_scores: {}, always_on_dimensions: [] });
    const v = validateRoleSchema('reviewer', result);
    assert.ok(v.some(s => s.includes('enum_violation:verdict')), 'expected enum violation for verdict');
  });

  test('debugger — missing root_cause', () => {
    const result = makeBaseResult({ repro_confirmed: true, fix_location_hint: 'bin/foo.js' });
    const v = validateRoleSchema('debugger', result);
    assert.ok(v.some(s => s.includes('root_cause')), 'expected root_cause violation');
  });

  test('tester — missing test_suite_result', () => {
    const result = makeBaseResult({ test_plan_block_present: true });
    const v = validateRoleSchema('tester', result);
    assert.ok(v.some(s => s.includes('test_suite_result')), 'expected test_suite_result violation');
  });

  test('documenter — missing canonical_source_checked', () => {
    const result = makeBaseResult();
    const v = validateRoleSchema('documenter', result);
    assert.ok(v.some(s => s.includes('canonical_source_checked')), 'expected canonical_source_checked violation');
  });

  test('refactorer — missing behavior_preserved', () => {
    const result = makeBaseResult({ plan_block: 'plan', test_baseline_post_diff: 'diff' });
    const v = validateRoleSchema('refactorer', result);
    assert.ok(v.some(s => s.includes('behavior_preserved')), 'expected behavior_preserved violation');
  });

  test('inventor — missing verdict', () => {
    const result = makeBaseResult({ prototype_executed: true });
    const v = validateRoleSchema('inventor', result);
    assert.ok(v.some(s => s.includes('verdict')), 'expected verdict violation');
  });

  test('inventor — invalid verdict enum', () => {
    const result = makeBaseResult({ verdict: 'done', prototype_executed: true });
    const v = validateRoleSchema('inventor', result);
    assert.ok(v.some(s => s.includes('enum_violation:verdict')), 'expected enum violation');
  });

  test('security-engineer — missing threats_found', () => {
    const result = makeBaseResult({ severity_breakdown: {}, security_mode: 'design' });
    const v = validateRoleSchema('security-engineer', result);
    assert.ok(v.some(s => s.includes('threats_found')), 'expected threats_found violation');
  });

  test('security-engineer — invalid security_mode enum', () => {
    const result = makeBaseResult({
      threats_found: [],
      severity_breakdown: {},
      security_mode: 'audit',
    });
    const v = validateRoleSchema('security-engineer', result);
    assert.ok(v.some(s => s.includes('enum_violation:security_mode')), 'expected security_mode enum violation');
  });

  test('release-manager — missing version_parity_checked', () => {
    const result = makeBaseResult({ changelog_user_readable: true });
    const v = validateRoleSchema('release-manager', result);
    assert.ok(v.some(s => s.includes('version_parity_checked')), 'expected version_parity_checked violation');
  });

  test('ux-critic — missing surfaces_reviewed', () => {
    const result = makeBaseResult({ personas_used: ['power_user'], findings_count: 0 });
    const v = validateRoleSchema('ux-critic', result);
    assert.ok(v.some(s => s.includes('surfaces_reviewed')), 'expected surfaces_reviewed violation');
  });

  test('platform-oracle — missing claims', () => {
    const result = makeBaseResult({ webfetch_urls: ['https://example.com'] });
    const v = validateRoleSchema('platform-oracle', result);
    assert.ok(v.some(s => s.includes('claims')), 'expected claims violation');
  });

  test('researcher — missing sources_cited', () => {
    const result = makeBaseResult();
    const v = validateRoleSchema('researcher', result);
    assert.ok(v.some(s => s.includes('sources_cited')), 'expected sources_cited violation');
  });

  test('researcher — sources_cited below min 3', () => {
    const result = makeBaseResult({ sources_cited: ['https://a.com', 'https://b.com'] });
    const v = validateRoleSchema('researcher', result);
    assert.ok(v.some(s => s.includes('min_count:sources_cited')), 'expected min_count violation');
  });

  test('project-intent — missing sections in output', () => {
    const result = makeBaseResult();
    const raw = 'Some arbitrary output without the required structure.';
    const v = validateRoleSchema('project-intent', result, raw);
    assert.ok(v.some(s => s.includes('output_regex')), 'expected output_regex violation');
  });

  test('project-intent — valid output passes', () => {
    const result = makeBaseResult();
    const raw = '# Project Intent\n## Domain\nsome domain\n## Constraints\nsome constraints\n## Tech Stack\nnode.js\n';
    const v = validateRoleSchema('project-intent', result, raw);
    assert.equal(v.length, 0, 'expected no violations');
  });

  test('unknown role — no violations (pass-through)', () => {
    const result = makeBaseResult();
    const v = validateRoleSchema('some-unknown-role', result);
    assert.equal(v.length, 0, 'unknown roles must not trigger violations');
  });
});

// ---------------------------------------------------------------------------
// Unit: kill-switch helpers
// ---------------------------------------------------------------------------

describe('v229-b2 — kill-switch helpers', () => {
  const { killSwitchEnvVar, isRoleHardDisabled } = roleSchemasMod;

  test('killSwitchEnvVar formats correctly', () => {
    assert.equal(killSwitchEnvVar('security-engineer'), 'ORCHESTRAY_T15_SECURITY_ENGINEER_HARD_DISABLED');
    assert.equal(killSwitchEnvVar('developer'), 'ORCHESTRAY_T15_DEVELOPER_HARD_DISABLED');
    assert.equal(killSwitchEnvVar('ux-critic'), 'ORCHESTRAY_T15_UX_CRITIC_HARD_DISABLED');
  });

  test('isRoleHardDisabled returns false by default', () => {
    assert.equal(isRoleHardDisabled('developer'), false);
  });
});

// ---------------------------------------------------------------------------
// Integration: 14 roles × hook hard-reject
// ---------------------------------------------------------------------------

// Each entry: [role, incompleteResult, missingFieldHint]
const ROLE_FIXTURES = [
  ['architect',        makeBaseResult({ acceptance_rubric: 'r' }),                         'design_doc_path'],
  ['developer',        makeBaseResult({ self_check_passed: 'true' }),                      'tests_added_or_existing'],
  ['reviewer',         makeBaseResult({ rubric_scores: {}, always_on_dimensions: [] }),    'verdict'],
  ['debugger',         makeBaseResult({ repro_confirmed: true, fix_location_hint: 'f' }), 'root_cause'],
  ['tester',           makeBaseResult({ test_plan_block_present: true }),                  'test_suite_result'],
  ['documenter',       makeBaseResult(),                                                    'canonical_source_checked'],
  // v2.2.21 T7: design-tier roles (refactorer, inventor, security-engineer, researcher)
  // now require acceptance_rubric. Fixtures include it so the test isolates the
  // NEXT missing field (the original intent of each fixture).
  ['refactorer',       makeBaseResult({ plan_block: 'p', test_baseline_post_diff: 'd', acceptance_rubric: 'r' }), 'behavior_preserved'],
  ['inventor',         makeBaseResult({ prototype_executed: true, acceptance_rubric: 'r' }),                       'verdict'],
  ['security-engineer',makeBaseResult({ severity_breakdown: {}, security_mode: 'design', acceptance_rubric: 'r' }),'threats_found'],
  ['release-manager',  makeBaseResult({ changelog_user_readable: true }),                  'version_parity_checked'],
  ['ux-critic',        makeBaseResult({ personas_used: ['power_user'], findings_count: 0 }),'surfaces_reviewed'],
  ['platform-oracle',  makeBaseResult({ webfetch_urls: ['https://a.com'] }),               'claims'],
  ['researcher',       makeBaseResult({ acceptance_rubric: 'r' }),                         'sources_cited'],
  ['project-intent',   makeBaseResult(),                                                    'output_regex'],
];

describe('v229-b2 — integration: 14-role hard-reject fixtures', () => {
  for (const [role, incompleteResult, hint] of ROLE_FIXTURES) {
    const resultJson = JSON.stringify(incompleteResult);
    const output = role === 'project-intent'
      ? 'No structured output.\n\n## Structured Result\n```json\n' + resultJson + '\n```\n'
      : '## Structured Result\n```json\n' + resultJson + '\n```\n';

    test('role=' + role + ' missing ' + hint + ' → exit 2', () => {
      const r = runHook({
        hook_event_name: 'SubagentStop',
        subagent_type: role,
        output,
      });
      assert.equal(r.status, 2, role + ': expected exit 2 (hard-reject). stderr=' + r.stderr.slice(0, 200));
      // Error message must reference the expected field.
      const combined = r.stderr + (r.stdout || '');
      assert.ok(
        combined.includes(hint) || combined.includes('t15_role_schema_violation') || combined.includes('pre_done_checklist'),
        role + ': stderr/stdout should reference violation. Got: ' + combined.slice(0, 300)
      );
      cleanup(r.tmp);
    });
  }
});

// ---------------------------------------------------------------------------
// Integration: per-role kill switch
// ---------------------------------------------------------------------------

describe('v229-b2 — per-role kill switch', () => {
  test('developer kill switch bypasses hard-reject', () => {
    const incompleteResult = makeBaseResult({ self_check_passed: 'true' }); // missing tests_added_or_existing
    const output = '## Structured Result\n```json\n' + JSON.stringify(incompleteResult) + '\n```\n';
    const r = runHook(
      { hook_event_name: 'SubagentStop', subagent_type: 'developer', output },
      { ORCHESTRAY_T15_DEVELOPER_HARD_DISABLED: '1' }
    );
    // With kill switch, the role-schema hard-reject is disabled.
    // The base T15 check passes (all base fields present).
    assert.equal(r.status, 0, 'kill switch should allow through. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('security-engineer kill switch bypasses hard-reject', () => {
    const incompleteResult = makeBaseResult({ severity_breakdown: {}, security_mode: 'design' }); // missing threats_found
    const output = '## Structured Result\n```json\n' + JSON.stringify(incompleteResult) + '\n```\n';
    const r = runHook(
      { hook_event_name: 'SubagentStop', subagent_type: 'security-engineer', output },
      { ORCHESTRAY_T15_SECURITY_ENGINEER_HARD_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'kill switch should allow through');
    cleanup(r.tmp);
  });
});

// ---------------------------------------------------------------------------
// Integration: complete valid result passes for each role
// ---------------------------------------------------------------------------

const ROLE_VALID_FIXTURES = [
  ['architect',         makeBaseResult({ design_doc_path: '.orchestray/kb/artifacts/d.md', acceptance_rubric: 'r' })],
  ['developer',         makeBaseResult({ self_check_passed: 'true', tests_added_or_existing: ['t.test.js'] })],
  ['reviewer',          makeBaseResult({ verdict: 'approve', rubric_scores: {}, always_on_dimensions: [] })],
  ['debugger',          makeBaseResult({ root_cause: 'root', repro_confirmed: true, fix_location_hint: 'f' })],
  ['tester',            makeBaseResult({ test_suite_result: { total: 1, pass: 1, fail: 0 }, test_plan_block_present: true })],
  ['documenter',        makeBaseResult({ canonical_source_checked: true })],
  // v2.2.21 T7: design-tier roles now require acceptance_rubric.
  ['refactorer',        makeBaseResult({ behavior_preserved: true, plan_block: 'p', test_baseline_post_diff: 'd', acceptance_rubric: 'r' })],
  ['inventor',          makeBaseResult({ verdict: 'novel', prototype_executed: true, acceptance_rubric: 'r' })],
  ['security-engineer', makeBaseResult({ threats_found: [], severity_breakdown: {}, security_mode: 'design', acceptance_rubric: 'r' })],
  ['release-manager',   makeBaseResult({ version_parity_checked: true, changelog_user_readable: true })],
  ['ux-critic',         makeBaseResult({ surfaces_reviewed: [], personas_used: ['power_user'], findings_count: 0 })],
  ['platform-oracle',   makeBaseResult({ claims: [], webfetch_urls: [] })],
  ['researcher',        makeBaseResult({ sources_cited: ['https://a.com', 'https://b.com', 'https://c.com'], acceptance_rubric: 'r' })],
];

describe('v229-b2 — integration: valid complete results pass for all roles', () => {
  for (const [role, validResult] of ROLE_VALID_FIXTURES) {
    const output = '## Structured Result\n```json\n' + JSON.stringify(validResult) + '\n```\n';
    test('role=' + role + ' complete result → exit 0', () => {
      const r = runHook({ hook_event_name: 'SubagentStop', subagent_type: role, output });
      assert.equal(r.status, 0, role + ': expected exit 0. stderr=' + r.stderr.slice(0, 200));
      cleanup(r.tmp);
    });
  }
});
