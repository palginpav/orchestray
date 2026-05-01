#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.21 T7 W-OP-5 — validate-task-completion.js acceptance_rubric
 * enforcement for design-producing roles.
 *
 * handoff-contract.md §3 requires `acceptance_rubric` for design-producing roles:
 *   architect, inventor, refactorer, researcher, security-engineer
 *
 * Developer (and other non-design roles) must NOT be blocked for missing it.
 *
 * Tests:
 * 1. architect spawn missing acceptance_rubric → hard-blocked (exit 2).
 * 2. inventor spawn missing acceptance_rubric → hard-blocked.
 * 3. refactorer spawn missing acceptance_rubric → hard-blocked.
 * 4. researcher spawn missing acceptance_rubric → hard-blocked.
 * 5. security-engineer spawn missing acceptance_rubric → hard-blocked.
 * 6. developer spawn missing acceptance_rubric → passes (not design-tier).
 * 7. architect spawn WITH acceptance_rubric → passes.
 * 8. ORCHESTRAY_T15_ACCEPTANCE_RUBRIC_DISABLED=1 reverts enforcement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/validate-task-completion.js');

function run(stdinData, env) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env || {}),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function makeSubagentStopPayload(agentRole, structuredResult, cwd) {
  // Build a valid SubagentStop payload that has all base required fields,
  // then override acceptance_rubric per test case.
  const sr = Object.assign({
    status: 'success',
    summary: 'Design produced.',
    files_changed: [],
    files_read: ['agents/pm.md'],
    issues: [],
    assumptions: [],
  }, structuredResult);

  const output = `Some agent output.\n\n## Structured Result\n\`\`\`json\n${JSON.stringify(sr, null, 2)}\n\`\`\`\n`;

  return JSON.stringify({
    hook_event_name: 'SubagentStop',
    subagent_type: agentRole,
    agent_role: agentRole,
    output,
    cwd: cwd || os.tmpdir(),
  });
}

// ---------------------------------------------------------------------------
// Design-tier roles: missing acceptance_rubric → hard-block
// ---------------------------------------------------------------------------

const DESIGN_ROLES = ['architect', 'inventor', 'refactorer', 'researcher', 'security-engineer'];

for (const role of DESIGN_ROLES) {
  test(`${role} spawn missing acceptance_rubric is hard-blocked with reason acceptance_rubric_required_for_design_role`, () => {
    const payload = makeSubagentStopPayload(role, {
      // No acceptance_rubric field
    });
    const { status, stderr, stdout } = run(payload);
    assert.equal(status, 2, `${role} should exit 2 when acceptance_rubric is missing`);
    assert.ok(
      stderr.includes('acceptance_rubric'),
      `stderr should mention acceptance_rubric for ${role}`
    );
    let output;
    try { output = JSON.parse(stdout.trim()); } catch (_) { output = {}; }
    assert.ok(
      output.reason === 'acceptance_rubric_required_for_design_role',
      `reason should be acceptance_rubric_required_for_design_role for ${role}, got: ${output.reason}`
    );
  });
}

// ---------------------------------------------------------------------------
// Developer (non-design role): missing acceptance_rubric → passes
// ---------------------------------------------------------------------------

test('developer spawn missing acceptance_rubric passes (not design-tier)', () => {
  const payload = makeSubagentStopPayload('developer', {
    // No acceptance_rubric field
  });
  const { status } = run(payload);
  // Developer is a hard-tier role for the base required fields — it passes
  // the base check. And it should NOT be blocked for missing acceptance_rubric.
  // If it fails for other reasons (e.g., T15 base fields), that's not our concern here.
  // We check: if exit 2, stderr must NOT mention acceptance_rubric.
  if (status === 2) {
    const { stderr } = run(payload);
    assert.ok(
      !stderr.includes('acceptance_rubric_required_for_design_role'),
      'developer should not be blocked for missing acceptance_rubric'
    );
  }
  // The ideal case: developer with valid base fields exits 0.
  assert.notEqual(
    run(payload).stderr.includes('acceptance_rubric_required_for_design_role'),
    true,
    'developer must not receive acceptance_rubric_required_for_design_role error'
  );
});

// ---------------------------------------------------------------------------
// Architect WITH acceptance_rubric passes
// ---------------------------------------------------------------------------

test('architect spawn WITH acceptance_rubric passes', () => {
  const payload = makeSubagentStopPayload('architect', {
    acceptance_rubric: {
      passed_count: 3,
      total_count: 3,
      rubric_ref: 'See ## Acceptance Rubric in delegation prompt',
    },
  });
  const { status, stderr } = run(payload);
  // Should not be blocked for acceptance_rubric reason.
  assert.ok(
    !stderr.includes('acceptance_rubric_required_for_design_role'),
    'architect with acceptance_rubric should not be blocked for rubric reason'
  );
  assert.notEqual(
    status === 2 && stderr.includes('acceptance_rubric'),
    true,
    'should not exit 2 due to acceptance_rubric when field is present'
  );
});

// ---------------------------------------------------------------------------
// Kill switch: ORCHESTRAY_T15_ACCEPTANCE_RUBRIC_DISABLED=1
// ---------------------------------------------------------------------------

test('ORCHESTRAY_T15_ACCEPTANCE_RUBRIC_DISABLED=1 disables rubric enforcement', () => {
  const payload = makeSubagentStopPayload('architect', {
    // No acceptance_rubric
  });
  const { status, stderr } = run(payload, {
    ORCHESTRAY_T15_ACCEPTANCE_RUBRIC_DISABLED: '1',
  });
  assert.ok(
    !stderr.includes('acceptance_rubric_required_for_design_role'),
    'kill switch should disable the acceptance_rubric block'
  );
  // Must not exit 2 due to acceptance_rubric (may exit 2 for other reasons — not tested here).
  if (status === 2) {
    assert.ok(
      !stderr.includes('acceptance_rubric_required_for_design_role'),
      'must not block for acceptance_rubric when kill switch is active'
    );
  }
});

// ---------------------------------------------------------------------------
// Empty string acceptance_rubric is treated as missing
// ---------------------------------------------------------------------------

test('empty string acceptance_rubric is treated as missing for architect', () => {
  const payload = makeSubagentStopPayload('architect', {
    acceptance_rubric: '',
  });
  const { status, stderr } = run(payload);
  assert.equal(status, 2, 'empty string acceptance_rubric should exit 2');
  assert.ok(stderr.includes('acceptance_rubric'), 'stderr should mention acceptance_rubric');
});

// ---------------------------------------------------------------------------
// Empty array acceptance_rubric is treated as missing
// ---------------------------------------------------------------------------

test('empty array acceptance_rubric is treated as missing for architect', () => {
  const payload = makeSubagentStopPayload('architect', {
    acceptance_rubric: [],
  });
  const { status, stderr } = run(payload);
  assert.equal(status, 2, 'empty array acceptance_rubric should exit 2');
  assert.ok(stderr.includes('acceptance_rubric'), 'stderr should mention acceptance_rubric');
});
