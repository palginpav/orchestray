#!/usr/bin/env node
'use strict';

/**
 * detect-oversized-input-orch-id.test.js — defect 3 (part A).
 *
 * `oversized_input_detected` (and `oversized_refused_cap`) never stamped an
 * explicit orchestration_id — autofill only fills it when a live orchestration
 * marker exists, and detection runs on UserPromptSubmit, before/without any
 * orchestration ever starting. Measured: 15/15 real rows on this machine carry
 * no orchestration_id. Fix: stamp `peekOrchestrationId(cwd) || 'unknown'`
 * explicitly, matching the sentinel convention already used by
 * record-pattern-offers.js / validate-pattern-ack.js.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/__tests__/detect-oversized-input-orch-id.test.js
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path                = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK      = path.join(REPO_ROOT, 'bin', 'detect-oversized-input.js');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-oi-orchid-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

// >200000 estimated tokens (CHARS_PER_TOKEN=4) without tripping the 1MB
// stdin cap (MAX_INPUT_BYTES) — stays under it with margin for JSON overhead.
function bigPastedPrompt() {
  return 'x'.repeat(850000);
}

function runHook(dir, prompt) {
  return spawnSync('node', [HOOK], {
    cwd: dir,
    env: process.env,
    input: JSON.stringify({ cwd: dir, prompt }),
    encoding: 'utf8',
    timeout: 8000,
  });
}

describe('defect 3 (part A) — oversized_input_detected carries explicit orchestration_id', () => {
  test('no active orchestration marker → orchestration_id is the "unknown" sentinel, not omitted', () => {
    const dir = makeRepo();
    const r = runHook(dir, bigPastedPrompt());
    assert.equal(r.status, 0, `hook exit=${r.status} stderr=${r.stderr}`);

    const detected = readEvents(dir).filter(e => e.type === 'oversized_input_detected');
    assert.equal(detected.length, 1);
    assert.equal(detected[0].orchestration_id, 'unknown', 'must use the established unknown sentinel, not leave the field absent');
  });

  test('active orchestration marker present → orchestration_id is the real id', () => {
    const dir = makeRepo();
    const ORCH_ID = 'orch-20260808T000000Z-oi-test';
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: ORCH_ID, started_at: new Date().toISOString(), phase: 'execute' }),
    );

    const r = runHook(dir, bigPastedPrompt());
    assert.equal(r.status, 0, `hook exit=${r.status} stderr=${r.stderr}`);

    const detected = readEvents(dir).filter(e => e.type === 'oversized_input_detected');
    assert.equal(detected.length, 1);
    assert.equal(detected[0].orchestration_id, ORCH_ID);
  });
});
