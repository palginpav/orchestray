#!/usr/bin/env node
'use strict';

/**
 * R-PFX (v2.1.14) — kb_search fields_used checkpoint tests.
 *
 * Verifies that the checkpoint row written by bin/record-mcp-checkpoint.js
 * contains fields_used: true when the caller passes a non-empty `fields`
 * projection argument to kb_search, and fields_used: false otherwise.
 *
 * Test plan:
 *   T1. fields: ["uri","section","excerpt"] → checkpoint row has fields_used: true
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

function makeDir(orchestrationId = 'orch-pfx-ks-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pfx-ks-'));
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
    session_id: 'test-session-pfx-ks',
    cwd: dir,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__orchestray__kb_search',
    tool_input: toolInput,
    tool_use_id: 'toolu_pfx_ks_test',
    tool_response: JSON.stringify({ matches: [] }),
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

describe('R-PFX kb_search — fields_used in checkpoint', () => {

  test('T1: fields=["uri","section","excerpt"] → fields_used: true', () => {
    const { dir, stateDir } = makeDir();
    runHook(dir, { query: 'test query', fields: ['uri', 'section', 'excerpt'] });
    const rows = readCheckpoint(stateDir);
    assert.equal(rows.length, 1, 'should write one checkpoint row');
    assert.equal(rows[0].fields_used, true, 'fields_used must be true when fields array is non-empty');
  });

  test('T2: fields omitted → fields_used: false', () => {
    const { dir, stateDir } = makeDir();
    runHook(dir, { query: 'test query' });
    const rows = readCheckpoint(stateDir);
    assert.equal(rows.length, 1, 'should write one checkpoint row');
    assert.equal(rows[0].fields_used, false, 'fields_used must be false when fields is omitted');
  });

});
