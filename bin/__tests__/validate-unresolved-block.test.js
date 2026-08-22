#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/validate-unresolved-block.js — v2.3.31 W1 (amended).
 *
 * Fixtures under bin/__tests__/fixtures/unresolved-block/ are REAL
 * transcript slices captured from this project's own session history (see
 * .orchestray/kb/artifacts/v2331-w1-blocked-call-visibility.md), not
 * hand-authored synthetic shapes, except for `synthetic-acknowledged.jsonl`
 * which is explicitly labelled as such (no real self-acknowledged-without-
 * human example was found in the source transcript for this diagnostic).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-unresolved-block.js');
const HOOK = path.resolve(__dirname, '..', 'validate-unresolved-block.js');
const FIXTURES = path.resolve(__dirname, 'fixtures', 'unresolved-block');

function loadFixtureEntries(name) {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'unresolved-block-'));
}

function runHook(payload, cwd, env) {
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: cwd || process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: Object.assign({}, process.env, env || {}),
  });
  return res;
}

// ---------------------------------------------------------------------------
// Unit-level classifier tests against real transcript fixtures
// ---------------------------------------------------------------------------

describe('validate-unresolved-block — classifier, real fixtures', () => {
  test('real subagent transcript ending at the block: unresolved (dev-d1-gate)', () => {
    const entries = loadFixtureEntries('real-subagent-unresolved.jsonl');
    const blocks = mod.findBlocks(entries);
    assert.equal(blocks.length, 1);
    const r = mod.classifyResolution(entries, blocks[blocks.length - 1].index);
    assert.equal(r.resolved, false);
  });

  test('real PM transcript, immediate retry-with-alternative: resolved', () => {
    const entries = loadFixtureEntries('real-pm-resolved-by-retry.jsonl');
    const blocks = mod.findBlocks(entries);
    assert.equal(blocks.length, 1);
    const r = mod.classifyResolution(entries, blocks[blocks.length - 1].index);
    assert.equal(r.resolved, true);
    assert.equal(r.type, 'retry');
  });

  test('real PM transcript, human "status?" re-prompt: NOT counted as resolution', () => {
    const entries = loadFixtureEntries('real-pm-human-rescue.jsonl');
    const blocks = mod.findBlocks(entries);
    assert.equal(blocks.length, 1);
    // Confirm the fixture actually contains the human turn the classifier
    // must stop at, so this test cannot pass vacuously.
    assert.ok(entries.some(mod.isHumanTurn), 'fixture must contain a human-origin turn');
    const r = mod.classifyResolution(entries, blocks[blocks.length - 1].index);
    assert.equal(r.resolved, false);
  });

  test('agent self-acknowledgement (no human involved): resolved', () => {
    const entries = loadFixtureEntries('synthetic-acknowledged.jsonl');
    const blocks = mod.findBlocks(entries);
    assert.equal(blocks.length, 1);
    const r = mod.classifyResolution(entries, blocks[blocks.length - 1].index);
    assert.equal(r.resolved, true);
    assert.equal(r.type, 'acknowledgement');
  });

  test('ordinary tool error (is_error alone, no toolDenialKind) is not a block', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', content: 'command failed: exit 1', is_error: true, tool_use_id: 'x' },
      ] } },
    ];
    assert.equal(mod.findBlocks(entries).length, 0);
  });

  test('permission-rule denial NOT from an Orchestray gate is not scoped in', () => {
    const entries = [
      {
        type: 'user',
        toolDenialKind: 'permission-rule',
        message: { role: 'user', content: [
          { type: 'tool_result', content: 'PreToolUse:Read hook error: orchestray-shield: already read at turn 0', is_error: true, tool_use_id: 'x' },
        ] },
      },
    ];
    assert.equal(mod.findBlocks(entries).length, 0);
  });
});

// ---------------------------------------------------------------------------
// End-to-end hook invocation (spawnSync), both Stop paths
// ---------------------------------------------------------------------------

describe('validate-unresolved-block — end-to-end, SubagentStop', () => {
  test('unresolved block: exits 2 and nudges (dev-d1-gate transcript)', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.copyFileSync(path.join(FIXTURES, 'real-subagent-unresolved.jsonl'), transcriptPath);
    const res = runHook({
      hook_event_name: 'SubagentStop',
      session_id: 'e2e-sub-1',
      cwd: tmp,
      transcript_path: transcriptPath,
      agent_id: 'adev-d1-gate',
      agent_type: 'developer',
    }, tmp);
    assert.equal(res.status, 2);
    const out = JSON.parse(res.stdout);
    assert.equal(out.continue, false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('fires at most once: second SubagentStop for the same block does not re-block', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.copyFileSync(path.join(FIXTURES, 'real-subagent-unresolved.jsonl'), transcriptPath);
    const payload = {
      hook_event_name: 'SubagentStop',
      session_id: 'e2e-sub-2',
      cwd: tmp,
      transcript_path: transcriptPath,
      agent_id: 'adev-d1-gate-repeat',
    };
    const first = runHook(payload, tmp);
    assert.equal(first.status, 2, 'first call nudges');

    // Same transcript, unchanged (no retry, no ack) — simulates the agent
    // producing nothing new in its forced turn.
    const second = runHook(payload, tmp);
    assert.equal(second.status, 0, 'second call for the same block must not re-block');
    const out = JSON.parse(second.stdout);
    assert.equal(out.continue, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('stop_hook_active=true is never re-blocked even without prior state', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.copyFileSync(path.join(FIXTURES, 'real-subagent-unresolved.jsonl'), transcriptPath);
    const res = runHook({
      hook_event_name: 'SubagentStop',
      session_id: 'e2e-sub-3',
      cwd: tmp,
      transcript_path: transcriptPath,
      stop_hook_active: true,
    }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('resolved-by-retry transcript: exits 0, no nudge', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.copyFileSync(path.join(FIXTURES, 'real-pm-resolved-by-retry.jsonl'), transcriptPath);
    const res = runHook({
      hook_event_name: 'SubagentStop',
      session_id: 'e2e-sub-4',
      cwd: tmp,
      transcript_path: transcriptPath,
    }, tmp);
    assert.equal(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.continue, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('validate-unresolved-block — end-to-end, PM Stop', () => {
  test('PM Stop, human-rescue transcript: block classified unresolved, still nudges once', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.copyFileSync(path.join(FIXTURES, 'real-pm-human-rescue.jsonl'), transcriptPath);
    const res = runHook({
      hook_event_name: 'Stop',
      session_id: 'e2e-pm-1',
      cwd: tmp,
      transcript_path: transcriptPath,
    }, tmp);
    // The human message in this real transcript occurs AFTER the block with
    // no self-resolution before it — the exact case this hook exists to
    // catch — so on a fresh Stop (stop_hook_active unset) it must nudge.
    assert.equal(res.status, 2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('kill switch (env) disables the gate entirely', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.copyFileSync(path.join(FIXTURES, 'real-subagent-unresolved.jsonl'), transcriptPath);
    const res = runHook({
      hook_event_name: 'Stop',
      session_id: 'e2e-pm-2',
      cwd: tmp,
      transcript_path: transcriptPath,
    }, tmp, { ORCHESTRAY_UNRESOLVED_BLOCK_GATE_DISABLED: '1' });
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('kill switch (config.json) disables the gate entirely', () => {
    const tmp = mkTmp();
    fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'config.json'),
      JSON.stringify({ unresolved_block_gate: { enabled: false } }),
      'utf8'
    );
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.copyFileSync(path.join(FIXTURES, 'real-subagent-unresolved.jsonl'), transcriptPath);
    const res = runHook({
      hook_event_name: 'Stop',
      session_id: 'e2e-pm-3',
      cwd: tmp,
      transcript_path: transcriptPath,
    }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('non-Stop event (e.g. PostToolUse) passes through untouched', () => {
    const tmp = mkTmp();
    const res = runHook({ hook_event_name: 'PostToolUse', session_id: 'e2e-pm-7', cwd: tmp }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('missing transcript_path fails open', () => {
    const tmp = mkTmp();
    const res = runHook({ hook_event_name: 'Stop', session_id: 'e2e-pm-4', cwd: tmp }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('malformed transcript JSON fails open, not crash', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '{not json\n{"also":"not json"\n', 'utf8');
    const res = runHook({
      hook_event_name: 'Stop',
      session_id: 'e2e-pm-5',
      cwd: tmp,
      transcript_path: transcriptPath,
    }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('empty stdin fails open', () => {
    const tmp = mkTmp();
    const res = spawnSync('node', [HOOK], { input: '', cwd: tmp, encoding: 'utf8', timeout: 10_000 });
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('clean transcript with no blocks at all: exits 0', () => {
    const tmp = mkTmp();
    const transcriptPath = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] },
    }) + '\n', 'utf8');
    const res = runHook({
      hook_event_name: 'Stop',
      session_id: 'e2e-pm-6',
      cwd: tmp,
      transcript_path: transcriptPath,
    }, tmp);
    assert.equal(res.status, 0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
