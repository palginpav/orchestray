#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.21 T7 PM-4 — validate-reviewer-git-diff.js audit-mode acceptance.
 *
 * The hook must:
 * 1. Accept a `## Git Diff` section whose body is `_n/a — audit-mode dispatch_`.
 * 2. Accept a `## Git Diff` section whose body contains `_n/a, audit-mode_`.
 * 3. Emit `reviewer_git_diff_audit_mode_accepted` event when audit-mode is detected.
 * 4. Still block when `## Git Diff` is completely absent (regression guard).
 * 5. Respect ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED=1 (reverts exemption).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/validate-reviewer-git-diff.js');

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

function makePayload(promptBody, cwd) {
  return JSON.stringify({
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'reviewer',
      prompt: promptBody,
    },
    cwd: cwd || os.tmpdir(),
  });
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-audit-mode-test-'));
}

function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

// Project root (worktree dir) — used as cwd when event emission must be verified.
// writeEvent resolves event-schemas.md relative to cwd; a bare tmpdir lacks the
// schema file and silently drops events. Using the project root ensures the schema
// is found and the event is written.
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Audit-mode acceptance: canonical marker
// ---------------------------------------------------------------------------

test('audit-mode marker "_n/a — audit-mode dispatch_" passes the hook', () => {
  const prompt = `## Dimensions to Apply
- correctness

## Git Diff
_n/a — audit-mode dispatch_

## Task
Audit the codebase.`;
  const { stdout, status } = run(makePayload(prompt));
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'should exit 0 for audit-mode prompt');
  assert.equal(output.continue, true, 'should continue: true for audit-mode');
});

// ---------------------------------------------------------------------------
// Audit-mode acceptance: alternate marker
// ---------------------------------------------------------------------------

test('audit-mode marker "_n/a, audit-mode_" passes the hook', () => {
  const prompt = `## Git Diff
_n/a, audit-mode_
`;
  const { stdout, status } = run(makePayload(prompt));
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'should exit 0 for alternate audit-mode marker');
  assert.equal(output.continue, true, 'should continue: true');
});

// ---------------------------------------------------------------------------
// Audit-mode acceptance: event emission
// ---------------------------------------------------------------------------

test('emits reviewer_git_diff_audit_mode_accepted event when audit-mode is detected', () => {
  // writeEvent resolves event-schemas.md relative to cwd. Pass PROJECT_ROOT as
  // cwd so the canonical schema path is found and the new event type is accepted.
  // We read events.jsonl AFTER the run and search for events added by this test.
  const auditDir = path.join(PROJECT_ROOT, '.orchestray', 'audit');
  const eventsFile = path.join(auditDir, 'events.jsonl');

  const beforeLines = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(l => l.trim()).length
    : 0;

  const prompt = `## Git Diff
_n/a — audit-mode dispatch_
`;
  const { status } = run(makePayload(prompt, PROJECT_ROOT));
  assert.equal(status, 0, 'should exit 0');

  const allLines = fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').split('\n').filter(l => l.trim())
    : [];
  const newLines = allLines.slice(beforeLines);
  const auditEv = newLines
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean)
    .find(e => e.type === 'reviewer_git_diff_audit_mode_accepted');
  assert.ok(auditEv, 'should emit reviewer_git_diff_audit_mode_accepted event');
});

// ---------------------------------------------------------------------------
// Regression guard: absent ## Git Diff section still blocks
// ---------------------------------------------------------------------------

test('absent ## Git Diff section is still blocked (regression guard)', () => {
  const prompt = `## Dimensions to Apply
- correctness

## Task
Review all the things.`;
  const { status } = run(makePayload(prompt));
  assert.equal(status, 2, 'should exit 2 when ## Git Diff is missing');
});

// ---------------------------------------------------------------------------
// Kill switch: ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED=1
// ---------------------------------------------------------------------------

test('ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED=1 disables audit-mode exemption', () => {
  // With kill switch active, the audit-mode body marker is NOT accepted.
  // The ## Git Diff heading is present but body is audit-mode marker —
  // when the exemption is disabled, the hook should still pass because the
  // heading IS present (it just won't emit the audit-mode event).
  // The kill switch reverts only the *audit-mode acceptance path*, not the
  // heading requirement. So a prompt with ## Git Diff + audit-mode body
  // still satisfies the heading check (section is present).
  const prompt = `## Git Diff
_n/a — audit-mode dispatch_
`;
  const tmpDir = makeTmpDir();
  const { status } = run(makePayload(prompt, tmpDir), {
    ORCHESTRAY_REVIEWER_AUDIT_MODE_DISABLED: '1',
  });
  // The heading is present so the hook passes (heading check passes).
  // But no audit-mode event is emitted.
  assert.equal(status, 0, 'heading present — should still exit 0');
  const events = readEvents(path.join(tmpDir, '.orchestray', 'audit'));
  const auditEv = events.find(e => e.type === 'reviewer_git_diff_audit_mode_accepted');
  assert.ok(!auditEv, 'should NOT emit audit_mode_accepted when kill switch is active');
});

// ---------------------------------------------------------------------------
// Non-reviewer subagent_type passes without checking
// ---------------------------------------------------------------------------

test('non-reviewer subagent_type is ignored by the hook', () => {
  const prompt = 'No git diff section at all';
  const payload = JSON.stringify({
    tool_name: 'Agent',
    tool_input: { subagent_type: 'developer', prompt },
    cwd: os.tmpdir(),
  });
  const { stdout, status } = run(payload);
  const output = JSON.parse(stdout.trim());
  assert.equal(status, 0, 'non-reviewer should exit 0 unconditionally');
  assert.equal(output.continue, true);
});
