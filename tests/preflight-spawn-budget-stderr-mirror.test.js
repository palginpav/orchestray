#!/usr/bin/env node
'use strict';

/**
 * preflight-spawn-budget-stderr-mirror.test.js — PM-2 fix: block paths mirror message to stderr.
 *
 * Verifies that every hard-block path emits the actionable message to BOTH:
 *   - stdout: JSON envelope { type: "block", message: "..." } (Claude Code hook protocol)
 *   - stderr: the same message string (visible in Claude Code error reporter)
 *
 * Runner: node --test tests/preflight-spawn-budget-stderr-mirror.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/preflight-spawn-budget.js');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeProject({ hardBlock = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-stderr-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({
      budget_enforcement: { enabled: true, hard_block: hardBlock },
      role_budgets: {
        developer: { budget_tokens: hardBlock ? 1 : 999999, source: 'test_fixture' },
      },
    })
  );
  return dir;
}

function run(payload, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, extraEnv),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Block path 1: missing context_size_hint → hard-block (PM-2 fix)
// ---------------------------------------------------------------------------

describe('stderr mirror — missing context_size_hint block path (PM-2 fix v2.2.21)', () => {
  test('block emits JSON envelope on stdout AND message on stderr', () => {
    const dir = makeProject();
    const payload = {
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        // No context_size_hint in tool_input and no hint in prompt
        prompt: 'Do something without any hint.',
      },
    };

    const { stdout, stderr, status } = run(payload, {
      ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED: '0',
    });

    // Must hard-block
    assert.equal(status, 2, `Expected exit 2 (hard-block). stdout=${stdout} stderr=${stderr}`);

    // stdout must contain the JSON block envelope
    assert.ok(
      stdout.includes('"type":"block"') || stdout.includes('"type": "block"'),
      `stdout must contain JSON {type:"block"} envelope. stdout=${stdout}`
    );

    // Parse the JSON envelope and extract the message
    let blockMessage = '';
    try {
      const parsed = JSON.parse(stdout.trim());
      blockMessage = parsed.message || '';
    } catch (_e) {
      assert.fail(`stdout is not valid JSON: ${stdout}`);
    }

    assert.ok(blockMessage.length > 0, 'JSON envelope must have non-empty message');

    // stderr must contain the same message (PM-2 mirror)
    assert.ok(
      stderr.includes(blockMessage.slice(0, 40)),
      `stderr must mirror the block message. stderr=${stderr}\nmessage starts with=${blockMessage.slice(0, 40)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Block path 2: budget hard-block → must also mirror to stderr (PM-2 fix)
// ---------------------------------------------------------------------------

describe('stderr mirror — budget hard-block path (PM-2 fix v2.2.21)', () => {
  test('budget hard-block emits JSON envelope on stdout AND message on stderr', () => {
    // Budget of 1 token + hard_block=true guarantees this path fires
    const dir = makeProject({ hardBlock: true });
    const prompt = 'context_size_hint: system=22000 tier2=0 handoff=12000\nDo work.';
    const payload = {
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        prompt,
      },
    };

    const { stdout, stderr, status } = run(payload, {
      ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED: '0',
    });

    // Must hard-block
    assert.equal(status, 2, `Expected exit 2 (budget hard-block). stdout=${stdout} stderr=${stderr}`);

    // stdout must contain the JSON block envelope
    assert.ok(
      stdout.includes('"type":"block"') || stdout.includes('"type": "block"'),
      `stdout must contain JSON {type:"block"} envelope. stdout=${stdout}`
    );

    // Parse and extract message
    let blockMessage = '';
    try {
      const parsed = JSON.parse(stdout.trim());
      blockMessage = parsed.message || '';
    } catch (_e) {
      assert.fail(`stdout is not valid JSON: ${stdout}`);
    }

    assert.ok(blockMessage.length > 0, 'JSON envelope must have non-empty message');

    // stderr must contain the same message
    assert.ok(
      stderr.includes(blockMessage.slice(0, 40)),
      `stderr must mirror the block message. stderr=${stderr}\nmessage starts with=${blockMessage.slice(0, 40)}`
    );
  });
});
