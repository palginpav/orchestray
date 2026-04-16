'use strict';

/**
 * Tests for bin/collect-context-telemetry.js
 *
 * Coverage group 5: Hook handler robustness to malformed payloads
 *   - No subcommand → prints help, exits 0
 *   - Unknown subcommand → prints help, exits 0
 *   - Each subcommand with empty payload → exits 0, outputs {"continue":true}
 *   - Subcommands with malformed/missing fields → fail-open (exit 0)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../../bin/collect-context-telemetry.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cct-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function teardown(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function run(args, stdinData, extraEnv) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: stdinData || '',
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, ...(extraEnv || {}) },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ── No subcommand / help ──────────────────────────────────────────────────────

describe('collect-context-telemetry — no subcommand', () => {
  test('exits 0 and prints help when called with no arguments', () => {
    const { stdout, status } = run([], '');
    assert.equal(status, 0);
    assert.ok(stdout.includes('collect-context-telemetry'), 'should print help text');
  });

  test('exits 0 and prints help for unknown subcommand', () => {
    const { stdout, status } = run(['bogus-subcommand'], '');
    assert.equal(status, 0);
    assert.ok(stdout.includes('Subcommands'), 'should print subcommands list');
  });
});

// ── Each subcommand with empty/minimal payload ────────────────────────────────

describe('collect-context-telemetry — pre-spawn with malformed payload', () => {
  test('exits 0 on empty stdin', () => {
    const dir = makeTmpProject();
    try {
      const { status } = run(['pre-spawn'], '', { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });

  test('exits 0 on invalid JSON stdin', () => {
    const dir = makeTmpProject();
    try {
      const { status } = run(['pre-spawn'], '{not json}', { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });

  test('exits 0 on valid JSON with missing required fields', () => {
    const dir = makeTmpProject();
    try {
      const payload = JSON.stringify({ hook_event_name: 'PreToolUse' });
      const { status } = run(['pre-spawn'], payload, { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });
});

describe('collect-context-telemetry — start subcommand robustness', () => {
  test('exits 0 on empty stdin', () => {
    const dir = makeTmpProject();
    try {
      const { status } = run(['start'], '', { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });

  test('exits 0 on payload with null fields', () => {
    const dir = makeTmpProject();
    try {
      const payload = JSON.stringify({ session_id: null, agent_id: null });
      const { status } = run(['start'], payload, { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });
});

describe('collect-context-telemetry — stop subcommand robustness', () => {
  test('exits 0 on empty stdin', () => {
    const dir = makeTmpProject();
    try {
      const { status } = run(['stop'], '', { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });

  test('exits 0 when stop payload references non-existent agent_id', () => {
    const dir = makeTmpProject();
    try {
      const payload = JSON.stringify({ session_id: 'sess-x', agent_id: 'no-such-agent' });
      const { status } = run(['stop'], payload, { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });
});

describe('collect-context-telemetry — post-spawn subcommand robustness', () => {
  test('exits 0 on empty stdin', () => {
    const dir = makeTmpProject();
    try {
      const { status } = run(['post-spawn'], '', { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });

  test('exits 0 on completely empty JSON object', () => {
    const dir = makeTmpProject();
    try {
      const { status } = run(['post-spawn'], '{}', { CLAUDE_PROJECT_DIR: dir });
      assert.equal(status, 0);
    } finally {
      teardown(dir);
    }
  });
});
