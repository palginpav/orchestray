'use strict';

/**
 * v2.2.9 B-7.4 — ORCHESTRAY_STRICT_MODEL_REQUIRED default-flip.
 *
 * Default = hard-block on missing model.
 * `ORCHESTRAY_STRICT_MODEL_REQUIRED=0` disables the gate (legacy auto-resolve).
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE = path.resolve(__dirname, '..', 'gate-agent-spawn.js');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b74-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'b74-test' })
  );
  return root;
}

function runGate(cwd, payload, env) {
  try {
    return execFileSync('node', [GATE], {
      cwd,
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...(env || {}) },
    });
  } catch (err) {
    return err;
  }
}

test('B-7.4: default — Agent() without model is hard-blocked', () => {
  const root = makeSandbox();
  // Strip the env var to make sure the test runs with the default semantic.
  const env = { ...process.env };
  delete env.ORCHESTRAY_STRICT_MODEL_REQUIRED;
  const result = runGate(root, {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'developer' },
  }, env);
  assert.equal(result && result.status, 2, 'must exit 2 by default');
  const stderr = (result && result.stderr || '').toString();
  assert.match(stderr, /missing required 'model' parameter/);
});

test('B-7.4: ORCHESTRAY_STRICT_MODEL_REQUIRED=0 disables the gate (legacy auto-resolve)', () => {
  const root = makeSandbox();
  const result = runGate(root, {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'developer' },
  }, { ORCHESTRAY_STRICT_MODEL_REQUIRED: '0' });
  // Legacy auto-resolve cascades to global default 'sonnet' and proceeds; must NOT exit 2.
  assert.notEqual(result && result.status, 2, 'env=0 must opt out of the hard-block');
});

test('B-7.4: agent_model_unspecified_blocked event is emitted on hard-block', () => {
  const root = makeSandbox();
  const env = { ...process.env };
  delete env.ORCHESTRAY_STRICT_MODEL_REQUIRED;
  runGate(root, {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'developer' },
  }, env);
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  assert.ok(fs.existsSync(eventsPath));
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const emit = lines.map(l => JSON.parse(l)).find(e => e.type === 'agent_model_unspecified_blocked');
  assert.ok(emit, 'agent_model_unspecified_blocked event must be present');
  assert.equal(emit.spawn_target, 'developer');
});

test('B-7.4: explicit model parameter is always allowed (any env value)', () => {
  const root = makeSandbox();
  for (const envValue of [undefined, '0', '1', 'foo']) {
    const env = { ...process.env };
    if (envValue === undefined) delete env.ORCHESTRAY_STRICT_MODEL_REQUIRED;
    else env.ORCHESTRAY_STRICT_MODEL_REQUIRED = envValue;
    const result = runGate(root, {
      cwd: root,
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', model: 'sonnet' },
    }, env);
    assert.notEqual(result && result.status, 2,
      'explicit model with env=' + JSON.stringify(envValue) + ' must not block');
  }
});
