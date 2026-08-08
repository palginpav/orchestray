#!/usr/bin/env node
'use strict';

/**
 * v2.3.21 — TaskCompleted is an unverified payload contract.
 *
 * `bin/validate-task-completion.js` runs on SubagentStop (579 captures) AND
 * TaskCompleted (zero captures, ever). Every field it reads off a TaskCompleted
 * payload is a guess, and two of its branches had never executed:
 *
 *   (a) a payload whose only role-ish field is `teammate_name` silently no-ops
 *       the whole T15 handoff-contract gate;
 *   (b) a payload carrying `agent_type` but no raw output text hard-blocks an
 *       agent whose Structured Result was valid.
 *
 * The fix: on an uncaptured event contract, every gate degrades to advisory and
 * says so; the payload is captured so the eventual tightening is evidence-backed.
 * SubagentStop — the path with the evidence — is untouched.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const HOOK = path.resolve(__dirname, '../validate-task-completion.js');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vtc-unverified-'));
}

function runHook(payload, opts = {}) {
  const cwd = opts.cwd || tmpRepo();
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, ...payload }),
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { ...res, cwd, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function readEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return {}; }
  });
}

// A hard-tier role with a Structured Result missing every required field —
// the exact input that made the T15 tier exit 2 before this change.
const MALFORMED_DEVELOPER = {
  subagent_type: 'developer',
  output: '## Structured Result\n```json\n{"status":"success"}\n```\n',
};

describe('v2.3.21 — no TaskCompleted path hard-blocks while the contract is uncaptured', () => {

  test('T15 hard tier degrades to advisory on TaskCompleted', () => {
    const r = runHook({ hook_event_name: 'TaskCompleted', ...MALFORMED_DEVELOPER });
    assert.equal(r.status, 0, 'must not block an unverified event; stderr=' + r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.continue, true, 'continuation payload must not carry continue:false');
    assert.equal(out.advisory, true);
    assert.equal(out.unverified_event, 'TaskCompleted');
    assert.match(r.stderr, /ADVISORY, NOT BLOCKED/);
    assert.match(r.stderr, /no TaskCompleted payload has ever been captured/);
    // The finding is still detected and recorded — advisory, not disabled.
    const rows = readEvents(r.cwd).filter((e) => e.type === 'pre_done_checklist_failed');
    assert.ok(rows.length > 0, 'the finding must still be emitted');
    assert.equal(rows[0].enforcement, 'advisory');
    assert.equal(rows[0].event_contract, 'unverified');
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('legacy team gate degrades to advisory on TaskCompleted', () => {
    const r = runHook({ hook_event_name: 'TaskCompleted', teammate_name: 'W3' });
    assert.equal(r.status, 0, 'legacy gate must not block an unverified event');
    assert.equal(JSON.parse(r.stdout.trim()).continue, true);
    assert.match(r.stderr, /ADVISORY, NOT BLOCKED/);
    const rows = readEvents(r.cwd).filter((e) => e.type === 'task_validation_failed');
    assert.ok(rows.length > 0, 'the missing-task_id finding must still be emitted');
    assert.equal(rows[0].enforcement, 'advisory');
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('tightening switch restores blocking once the contract is verified', () => {
    const r = runHook({ hook_event_name: 'TaskCompleted', ...MALFORMED_DEVELOPER },
      { env: { ORCHESTRAY_UNVERIFIED_EVENT_ADVISORY_DISABLED: '1' } });
    assert.equal(r.status, 2, 'explicit operator opt-in must restore exit 2');
    assert.equal(JSON.parse(r.stdout.trim()).continue, false);
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });
});

describe('v2.3.21 — an unidentifiable role on a team completion is observable', () => {

  test('teammate_name-only payload emits a skip diagnostic instead of silence', () => {
    // task_id + task_subject present so the legacy gate passes and execution
    // reaches the T15 classification — isolating branch (a).
    const r = runHook({
      hook_event_name: 'TaskCompleted',
      task_id: 'task-001',
      task_subject: 'implement auth',
      teammate_name: 'W3-developer',
      output: '## Structured Result\n```json\n{"status":"success"}\n```\n',
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /T15 gate SKIPPED on this TaskCompleted/);
    assert.match(r.stderr, /teammate_name is excluded by design/);
    const rows = readEvents(r.cwd).filter((e) => e.reason_code === 'agent_role_unidentified');
    assert.equal(rows.length, 1, 'exactly one skip diagnostic expected');
    assert.equal(rows[0].type, 'task_completion_warn');
    assert.equal(rows[0].hook_event_name, 'TaskCompleted');
    assert.ok(rows[0].payload_keys.includes('teammate_name'), 'payload keys must be recorded');
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('SubagentStop with an identifiable role emits no skip diagnostic', () => {
    const r = runHook({ hook_event_name: 'SubagentStop', ...MALFORMED_DEVELOPER });
    const rows = readEvents(r.cwd).filter((e) => e.reason_code === 'agent_role_unidentified');
    assert.equal(rows.length, 0, 'diagnostic is scoped to unverified events');
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });
});

describe('v2.3.21 — SubagentStop (579 captures) is unchanged', () => {

  test('hard-tier agent with a malformed Structured Result still exits 2', () => {
    const r = runHook({ hook_event_name: 'SubagentStop', ...MALFORMED_DEVELOPER });
    assert.equal(r.status, 2, 'the evidenced path must keep blocking');
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.continue, false);
    assert.match(String(out.reason), /pre_done_checklist_failed/);
    assert.doesNotMatch(r.stderr, /ADVISORY, NOT BLOCKED/);
    const rows = readEvents(r.cwd).filter((e) => e.type === 'pre_done_checklist_failed');
    assert.ok(rows.length > 0);
    assert.equal(rows[0].enforcement, undefined, 'no advisory annotation on a real block');
    assert.equal(rows[0].event_contract, undefined);
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('valid Structured Result still passes', () => {
    const r = runHook({
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'success', summary: 'ok', files_changed: [], files_read: [], issues: [],
        assumptions: [], self_check_passed: true, tests_added_or_existing: true,
      }) + '\n```\n',
    });
    assert.equal(r.status, 0, 'stderr=' + r.stderr);
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('SubagentStop writes no capture fixture', () => {
    const r = runHook({ hook_event_name: 'SubagentStop', ...MALFORMED_DEVELOPER },
      { env: { ORCHESTRAY_UNVERIFIED_EVENT_CAPTURE: '1' } });
    assert.equal(fs.existsSync(path.join(r.cwd, '.orchestray', 'fixtures')), false);
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });
});

describe('v2.3.21 — the first real TaskCompleted payload gets captured', () => {

  function fixtures(cwd) {
    const dir = path.join(cwd, '.orchestray', 'fixtures', 'validate-task-completion');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  test('captures a redacted {stdin,state} fixture for the uncaptured event', () => {
    const r = runHook({
      hook_event_name: 'TaskCompleted',
      task_id: 'task-001',
      task_subject: 'implement auth',
      teammate_name: 'W3-developer',
      transcript_path: '/home/someone/.claude/projects/x/transcript.jsonl',
      output: 'x'.repeat(200),
    }, { env: { ORCHESTRAY_UNVERIFIED_EVENT_CAPTURE: '1' } });

    const names = fixtures(r.cwd);
    assert.equal(names.length, 1, 'exactly one fixture expected, got ' + JSON.stringify(names));
    assert.match(names[0], /^taskcompleted-[0-9a-f]{12}\.json$/,
      'name must carry the event so the cap is scoped to uncaptured events');

    const fx = JSON.parse(fs.readFileSync(
      path.join(r.cwd, '.orchestray', 'fixtures', 'validate-task-completion', names[0]), 'utf8'));
    assert.equal(fx.stdin.hook_event_name, 'TaskCompleted', 'fixture must claim its own event');
    assert.ok('state' in fx, 'fixture shape is {stdin,state}, not a bare payload');
    assert.match(fx.stdin.output, /^<str:\d+>$/, 'long prose must be redacted');
    assert.doesNotMatch(fx.stdin.transcript_path, /someone/, 'paths must be redacted');
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('capture is idempotent per payload shape', () => {
    const cwd = tmpRepo();
    const payload = { hook_event_name: 'TaskCompleted', task_id: 'a', task_subject: 'b', teammate_name: 'W1' };
    runHook(payload, { cwd, env: { ORCHESTRAY_UNVERIFIED_EVENT_CAPTURE: '1' } });
    runHook({ ...payload, task_id: 'c', task_subject: 'd', teammate_name: 'W2' },
      { cwd, env: { ORCHESTRAY_UNVERIFIED_EVENT_CAPTURE: '1' } });
    assert.equal(fixtures(cwd).length, 1, 'same shape must not write twice');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('capture is independent of the tightening switch', () => {
    // An operator who restores blocking early must still collect the evidence
    // that would justify it.
    const r = runHook({ hook_event_name: 'TaskCompleted', teammate_name: 'W1' }, {
      env: {
        ORCHESTRAY_UNVERIFIED_EVENT_CAPTURE: '1',
        ORCHESTRAY_UNVERIFIED_EVENT_ADVISORY_DISABLED: '1',
      },
    });
    assert.equal(r.status, 2, 'tightening switch restores the block');
    assert.equal(fixtures(r.cwd).length, 1, 'and the payload is still captured');
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('capture kill switch suppresses the write', () => {
    const r = runHook({ hook_event_name: 'TaskCompleted', teammate_name: 'W1' }, {
      env: {
        ORCHESTRAY_UNVERIFIED_EVENT_CAPTURE: '1',
        ORCHESTRAY_UNVERIFIED_EVENT_CAPTURE_DISABLED: '1',
      },
    });
    assert.equal(fixtures(r.cwd).length, 0);
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('synthetic test payloads are not captured by default', () => {
    // ORCHESTRAY_TEST=1 is set by tests/helpers/setup.js and inherited here;
    // hand-authored shapes must never pollute the corpus.
    const r = runHook({ hook_event_name: 'TaskCompleted', teammate_name: 'W1' });
    assert.equal(fixtures(r.cwd).length, 0);
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });
});

describe('v2.3.21 — legacy team gate kill switch', () => {

  test('ORCHESTRAY_TEAM_EVENT_GATE_DISABLED=1 makes the gate a no-op', () => {
    const r = runHook({ hook_event_name: 'TaskCompleted', teammate_name: 'W3' },
      { env: { ORCHESTRAY_TEAM_EVENT_GATE_DISABLED: '1' } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /Task completion rejected/);
    const rows = readEvents(r.cwd).filter((e) => e.type === 'task_validation_failed');
    assert.equal(rows.length, 0, 'disabled gate must not emit a finding');
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });

  test('the gate names its kill switch in the rejection message', () => {
    // Payload without hook_event_name keeps the pre-v2.3.21 blocking path:
    // absence is not a live shape (1763/1769 captures carry hook_event_name;
    // the 6 that do not are non-hook producers).
    const r = runHook({ task_subject: 'implement auth' });
    assert.equal(r.status, 2, 'unlabelled legacy payloads keep blocking');
    assert.match(r.stderr, /ORCHESTRAY_TEAM_EVENT_GATE_DISABLED=1/);
    fs.rmSync(r.cwd, { recursive: true, force: true });
  });
});
