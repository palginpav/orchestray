#!/usr/bin/env node
'use strict';

/**
 * R-PFX (v2.1.14) — pattern_find fields_used checkpoint tests.
 *
 * Verifies that the checkpoint row written by bin/record-mcp-checkpoint.js
 * contains fields_used: true when the caller passes a non-empty `fields`
 * projection argument to pattern_find, and fields_used: false otherwise.
 *
 * Test plan:
 *   T1. fields: ["slug","confidence","one_line"] → checkpoint row has fields_used: true
 *   T2. fields omitted → checkpoint row has fields_used: false
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CHECKPOINT_SCRIPT = path.resolve(__dirname, '../../../../bin/record-mcp-checkpoint.js');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeDir(orchestrationId = 'orch-pfx-pf-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pfx-pf-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchestrationId })
  );
  return { dir, stateDir };
}

function runHook(dir, toolInput) {
  const payload = {
    session_id: 'test-session-pfx',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__orchestray__pattern_find',
    tool_input: toolInput,
    tool_use_id: 'toolu_pfx_pf_test',
    tool_response: JSON.stringify({ matches: [], considered: 0, filtered_out: 0 }),
  };
  return spawnSync(process.execPath, [CHECKPOINT_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
}

function readCheckpoint(stateDir) {
  const p = path.join(stateDir, 'mcp-checkpoint.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

describe('R-PFX pattern_find — fields_used in checkpoint', () => {

  test('T1: fields=["slug","confidence","one_line"] → fields_used: true', () => {
    const { dir, stateDir } = makeDir();
    runHook(dir, { task_summary: 'test decomposition', fields: ['slug', 'confidence', 'one_line'] });
    const rows = readCheckpoint(stateDir);
    assert.equal(rows.length, 1, 'should write one checkpoint row');
    assert.equal(rows[0].fields_used, true, 'fields_used must be true when fields array is non-empty');
  });

  test('T2: fields omitted → fields_used: false', () => {
    const { dir, stateDir } = makeDir();
    runHook(dir, { task_summary: 'test decomposition' });
    const rows = readCheckpoint(stateDir);
    assert.equal(rows.length, 1, 'should write one checkpoint row');
    assert.equal(rows[0].fields_used, false, 'fields_used must be false when fields is omitted');
  });

});
