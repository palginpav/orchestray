'use strict';

/**
 * v2.2.9 B-7.1 — Agent maxTurns hard-cap gate.
 *
 * Covers: bin/gate-agent-spawn.js (maxTurns block) and
 * bin/_lib/numeric-thresholds.js loader.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE = path.resolve(__dirname, '..', 'gate-agent-spawn.js');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b71-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  // Active orchestration marker is required for the model gate (and our
  // maxTurns gate runs inside that block).
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'b71-test' })
  );
  return root;
}

function runGate(cwd, payload) {
  try {
    return execFileSync('node', [GATE], {
      cwd,
      input: JSON.stringify(payload),
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    });
  } catch (err) {
    return err;
  }
}

test('B-7.1: loadMaxTurnsHardCap returns default 200 when config missing', () => {
  const root = makeSandbox();
  const { loadMaxTurnsHardCap } = require('../_lib/numeric-thresholds');
  const cap = loadMaxTurnsHardCap(root);
  assert.equal(cap, 200);
});

test('B-7.1: loadMaxTurnsHardCap honours config override', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ spawn: { max_turns_hard_cap: 50 } })
  );
  const { loadMaxTurnsHardCap } = require('../_lib/numeric-thresholds');
  const cap = loadMaxTurnsHardCap(root);
  assert.equal(cap, 50);
});

test('B-7.1: maxTurns at the cap is allowed', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ spawn: { max_turns_hard_cap: 100 } })
  );
  const result = runGate(root, {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'developer', model: 'sonnet', maxTurns: 100 },
  });
  // status 0 is allow; if the gate exits 2, runGate returns the error and result.status === 2.
  assert.notEqual(result && result.status, 2, 'spawn at cap should not be blocked');
});

test('B-7.1: maxTurns above the cap is hard-blocked', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ spawn: { max_turns_hard_cap: 50 } })
  );
  const result = runGate(root, {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'developer', model: 'sonnet', maxTurns: 999 },
  });
  assert.equal(result && result.status, 2, 'spawn above cap must exit 2');
  const stderr = (result && result.stderr || '').toString();
  assert.match(stderr, /maxTurns=999/);
  assert.match(stderr, /max_turns_hard_cap=50/);
});

test('B-7.1: agent_max_turns_violation event is emitted on block', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ spawn: { max_turns_hard_cap: 30 } })
  );
  runGate(root, {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'reviewer', model: 'sonnet', maxTurns: 200 },
  });
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  assert.ok(fs.existsSync(eventsPath), 'events.jsonl must exist after a block');
  const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const emit = lines.map(l => JSON.parse(l)).find(e => e.type === 'agent_max_turns_violation');
  assert.ok(emit, 'agent_max_turns_violation event must be present');
  assert.equal(emit.spawn_target, 'reviewer');
  assert.equal(emit.requested_turns, 200);
  assert.equal(emit.hard_cap, 30);
});

test('B-7.1: missing maxTurns parameter is allowed (no policy without value)', () => {
  const root = makeSandbox();
  const result = runGate(root, {
    cwd: root,
    tool_name: 'Agent',
    tool_input: { subagent_type: 'developer', model: 'sonnet' },
  });
  // Should not exit 2 due to maxTurns gate (model present, maxTurns absent → allow).
  assert.notEqual(result && result.status, 2, 'no-maxTurns spawn must not be blocked by B-7.1');
});
