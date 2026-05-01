#!/usr/bin/env node
'use strict';

/**
 * preflight-spawn-budget-quoted-keys.test.js — PM-1 fix: HINT_RE_OBJ accepts quoted keys.
 *
 * Verifies that context_size_hint in JSON-with-quoted-keys form is parsed from
 * the prompt body (parseSource === 'prompt_body'), avoiding a false hard-block.
 *
 * Runner: node --test tests/preflight-spawn-budget-quoted-keys.test.js
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

/**
 * Create a minimal project tmpdir with a config that has budget_enforcement enabled
 * but hard_block=false (so budget overages don't interfere with parse tests).
 */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-quoted-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  // Minimal config: budget_enforcement enabled soft-only, generous budget
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({
      budget_enforcement: { enabled: true, hard_block: false },
      role_budgets: {
        developer: { budget_tokens: 999999, source: 'test_fixture' },
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
    env: Object.assign({}, process.env, {
      ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED: '0',
    }, extraEnv),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Quoted-key form parses successfully (PM-1 fix)
// ---------------------------------------------------------------------------

describe('HINT_RE_OBJ — quoted-key form (PM-1 fix v2.2.21)', () => {
  test('context_size_hint with quoted keys is accepted (parseSource: prompt_body)', () => {
    const dir = makeProject();
    const prompt = [
      '## Task',
      'Do something useful.',
      '',
      'context_size_hint: { "system": 22000, "tier2": 0, "handoff": 12000 }',
      '',
      'More instructions here.',
    ].join('\n');

    const payload = {
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        prompt,
      },
    };

    const { stdout, stderr, status } = run(payload);

    // Must not block — quoted-key hint is present and non-zero
    assert.notEqual(status, 2, `Expected exit 0 (pass), got exit 2. stdout=${stdout} stderr=${stderr}`);
    assert.equal(status, 0, `Expected exit 0 (pass). stdout=${stdout} stderr=${stderr}`);

    // Must not emit a block envelope on stdout
    assert.ok(!stdout.includes('"type":"block"') && !stdout.includes('"type": "block"'),
      `Unexpected block on stdout: ${stdout}`);
  });

  test('context_size_hint with unquoted keys still parses (regression guard)', () => {
    const dir = makeProject();
    const prompt = 'context_size_hint: { system: 22000, tier2: 0, handoff: 12000 }\nDo work.';

    const payload = {
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        prompt,
      },
    };

    const { stdout, status } = run(payload);
    assert.equal(status, 0, `Unquoted form must still pass. stdout=${stdout}`);
    assert.ok(!stdout.includes('"type":"block"') && !stdout.includes('"type": "block"'),
      `Unexpected block on stdout: ${stdout}`);
  });

  test('flat form (key=value) still parses (regression guard)', () => {
    const dir = makeProject();
    const prompt = 'context_size_hint: system=22000 tier2=0 handoff=12000\nDo work.';

    const payload = {
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        prompt,
      },
    };

    const { stdout, status } = run(payload);
    assert.equal(status, 0, `Flat form must still pass. stdout=${stdout}`);
  });
});
