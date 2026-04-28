#!/usr/bin/env node
'use strict';

/**
 * v229-context-shield-bypass-emit.test.js — B-5.2 unit tests.
 *
 * Verifies bin/context-shield.js emits `schema_redirect_bypassed` whenever
 * a Read of agents/pm-reference/event-schemas.md bypasses the redirect via
 * the FULL_READ_ALLOWED_AGENTS allowlist or via null/absent agent_type.
 * Pure observability — bypass behavior itself is unchanged.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'context-shield.js');
const SCHEMA_SRC = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE       = process.execPath;

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b5-2-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // Seed orchestration marker for orchestration_id resolution.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-b5-2' }),
    'utf8'
  );
  // Place a synthetic event-schemas.md so the file_path is real (the hook
  // resolves to fs.statSync — but for context-shield it uses string match
  // on path). Copy real schema for fidelity.
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  if (fs.existsSync(SCHEMA_SRC)) {
    fs.copyFileSync(SCHEMA_SRC, path.join(pmRefDir, 'event-schemas.md'));
  } else {
    fs.writeFileSync(path.join(pmRefDir, 'event-schemas.md'), '# stub\n', 'utf8');
  }
  return root;
}

function runShield(root, payload, envOverrides) {
  const env = Object.assign({}, process.env, envOverrides || {}, {
    ORCHESTRAY_PROJECT_ROOT: root,
  });
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
    cwd: root,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readEvents(root) {
  const p = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

describe('v229 B-5.2 — context-shield bypass observability', () => {
  test('Read by allowlisted agent (architect) → schema_redirect_bypassed{allowlist}', () => {
    const root = makeTmpRoot();
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: 'agents/pm-reference/event-schemas.md' },
      agent_type: 'architect',
      cwd: root,
    };
    const r = runShield(root, payload);
    assert.equal(r.status, 0);
    // Should be allowed (not deny).
    const resp = JSON.parse(r.stdout || '{}');
    assert.equal(
      resp.hookSpecificOutput.permissionDecision, 'allow',
      'allowlisted role bypasses redirect (allow)'
    );
    const events = readEvents(root);
    const bypass = events.filter(e => e.type === 'schema_redirect_bypassed');
    assert.equal(bypass.length, 1, 'exactly one bypass event for architect');
    assert.equal(bypass[0].bypass_reason, 'allowlist');
    assert.equal(bypass[0].agent_type, 'architect');
    assert.match(bypass[0].file_path, /event-schemas\.md$/);
  });

  test('Read by null agent_type (orchestrator) → schema_redirect_bypassed{null_agent}', () => {
    const root = makeTmpRoot();
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: 'agents/pm-reference/event-schemas.md' },
      // agent_type omitted — orchestrator/PM path
      cwd: root,
    };
    const r = runShield(root, payload);
    assert.equal(r.status, 0);
    const resp = JSON.parse(r.stdout || '{}');
    assert.equal(resp.hookSpecificOutput.permissionDecision, 'allow');
    const events = readEvents(root);
    const bypass = events.filter(e => e.type === 'schema_redirect_bypassed');
    assert.equal(bypass.length, 1, 'exactly one null_agent bypass');
    assert.equal(bypass[0].bypass_reason, 'null_agent');
    assert.equal(bypass[0].agent_type, 'null');
  });

  test('Read by non-bypassed agent (developer) → redirect denies, NO bypass event', () => {
    const root = makeTmpRoot();
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: 'agents/pm-reference/event-schemas.md' },
      agent_type: 'developer',
      cwd: root,
    };
    const r = runShield(root, payload);
    assert.equal(r.status, 0);
    const resp = JSON.parse(r.stdout || '{}');
    assert.equal(
      resp.hookSpecificOutput.permissionDecision, 'deny',
      'developer is not in allowlist — redirect denies'
    );
    const events = readEvents(root);
    const bypass = events.filter(e => e.type === 'schema_redirect_bypassed');
    assert.equal(bypass.length, 0, 'no bypass event for non-allowlisted agent');
    // The original schema_redirect_emitted path still fires.
    const emitted = events.filter(e => e.type === 'schema_redirect_emitted');
    assert.equal(emitted.length, 1, 'original redirect path still fires');
  });

  test('Read of unrelated file by allowlisted agent → no bypass event (scope guard)', () => {
    const root = makeTmpRoot();
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      agent_type: 'architect',
      cwd: root,
    };
    const r = runShield(root, payload);
    assert.equal(r.status, 0);
    const events = readEvents(root);
    const bypass = events.filter(e => e.type === 'schema_redirect_bypassed');
    assert.equal(bypass.length, 0, 'unrelated file → no bypass event');
  });

  test('kill switch ORCHESTRAY_SCHEMA_REDIRECT_BYPASS_TELEMETRY_DISABLED=1 → no bypass event, but bypass still works', () => {
    const root = makeTmpRoot();
    const payload = {
      tool_name: 'Read',
      tool_input: { file_path: 'agents/pm-reference/event-schemas.md' },
      agent_type: 'release-manager',
      cwd: root,
    };
    const r = runShield(root, payload, {
      ORCHESTRAY_SCHEMA_REDIRECT_BYPASS_TELEMETRY_DISABLED: '1',
    });
    assert.equal(r.status, 0);
    const resp = JSON.parse(r.stdout || '{}');
    assert.equal(
      resp.hookSpecificOutput.permissionDecision, 'allow',
      'bypass STILL works even when telemetry is suppressed'
    );
    const events = readEvents(root);
    const bypass = events.filter(e => e.type === 'schema_redirect_bypassed');
    assert.equal(bypass.length, 0, 'kill switch suppresses telemetry');
  });
});
