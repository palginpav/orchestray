#!/usr/bin/env node
'use strict';

/**
 * v2210-tier2-watcher.test.js — B2 acceptance tests.
 *
 * Verifies that pm-emit-state-watcher auto-emits tier2_invoked for 4
 * protocols that previously required manual Bash invocation by the PM.
 *
 * Tests:
 *   1. Write confidence/task-T1.json → 1 tier2_invoked(cognitive_backpressure)
 *   2. Write routing.jsonl with documenter entry → 1 tier2_invoked(auto_documenter)
 *   3. Write disagree-T1.json → 1 tier2_invoked(disagreement_protocol)
 *   4. Write replay-T1.json → 1 tier2_invoked(replay_analysis)
 *   5. ORCHESTRAY_TIER2_WATCHER_DISABLED=1 → 0 emits for all 4 paths
 *   6. Idempotency: same protocol+file written twice → 0 emits on second write
 *
 * Runner: cd /home/palgin/orchestray && npm test -- --testPathPattern=v2210-tier2-watcher
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WATCHER   = path.join(REPO_ROOT, 'bin', 'pm-emit-state-watcher.js');

const ORCH_ID = 'orch-20260429T062041Z-v2210-b2-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-b2-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),              { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state', 'confidence'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),               { recursive: true });

  // Active orchestration marker.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({
      orchestration_id: ORCH_ID,
      started_at:       new Date().toISOString(),
      phase:            'execute',
    }),
  );

  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function runWatcher(dir, relPath, env = {}) {
  const payload = {
    cwd:             dir,
    hook_event_name: 'PostToolUse',
    tool_name:       'Write',
    tool_input: {
      file_path: path.join(dir, relPath),
    },
    tool_response: { success: true },
    session_id:    'test-sess-b2',
  };
  return spawnSync('node', [WATCHER], {
    cwd:      dir,
    env:      { ...process.env, ...env },
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  8000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.10 B2 — tier2 protocol watcher', () => {

  test('case 1: write confidence/task-T1.json → 1 tier2_invoked(cognitive_backpressure)', () => {
    const dir     = makeRepo();
    const relPath = '.orchestray/state/confidence/task-T1.json';
    fs.writeFileSync(
      path.join(dir, relPath),
      JSON.stringify({ task_id: 'task-T1', confidence: 0.42, signal: 'low' }),
    );

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const hits = events.filter(e =>
      e.type === 'tier2_invoked' && e.protocol === 'cognitive_backpressure'
    );
    assert.equal(hits.length, 1, 'must emit exactly 1 tier2_invoked(cognitive_backpressure)');
    assert.equal(hits[0].source, 'state_watcher_backstop');
  });

  test('case 2: routing.jsonl with documenter entry → 1 tier2_invoked(auto_documenter)', () => {
    const dir     = makeRepo();
    const relPath = '.orchestray/state/routing.jsonl';
    // Write a routing.jsonl that contains a documenter delegation.
    const entry = JSON.stringify({
      task_id:    'task-D1',
      agent_type: 'documenter',
      model:      'sonnet',
      reason:     'auto-document detected feature addition',
    });
    fs.writeFileSync(path.join(dir, relPath), entry + '\n');

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const hits = events.filter(e =>
      e.type === 'tier2_invoked' && e.protocol === 'auto_documenter'
    );
    assert.equal(hits.length, 1, 'must emit exactly 1 tier2_invoked(auto_documenter)');
    assert.equal(hits[0].source, 'state_watcher_backstop');
  });

  test('case 2b: routing.jsonl without documenter → 0 emits', () => {
    const dir     = makeRepo();
    const relPath = '.orchestray/state/routing.jsonl';
    const entry = JSON.stringify({
      task_id:    'task-D2',
      agent_type: 'developer',
      model:      'sonnet',
    });
    fs.writeFileSync(path.join(dir, relPath), entry + '\n');

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const hits = events.filter(e =>
      e.type === 'tier2_invoked' && e.protocol === 'auto_documenter'
    );
    assert.equal(hits.length, 0, 'must NOT emit when no documenter in routing.jsonl');
  });

  test('case 3: write disagree-T1.json → 1 tier2_invoked(disagreement_protocol)', () => {
    const dir     = makeRepo();
    const relPath = '.orchestray/state/disagree-T1.json';
    fs.writeFileSync(
      path.join(dir, relPath),
      JSON.stringify({ task_id: 'task-T1', finding: 'design trade-off', classification: 'design' }),
    );

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const hits = events.filter(e =>
      e.type === 'tier2_invoked' && e.protocol === 'disagreement_protocol'
    );
    assert.equal(hits.length, 1, 'must emit exactly 1 tier2_invoked(disagreement_protocol)');
    assert.equal(hits[0].source, 'state_watcher_backstop');
  });

  test('case 4: write replay-T1.json → 1 tier2_invoked(replay_analysis)', () => {
    const dir     = makeRepo();
    const relPath = '.orchestray/state/replay-T1.json';
    fs.writeFileSync(
      path.join(dir, relPath),
      JSON.stringify({ task_id: 'task-T1', friction_signals: ['rework', 'timeout'] }),
    );

    const r = runWatcher(dir, relPath);
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const hits = events.filter(e =>
      e.type === 'tier2_invoked' && e.protocol === 'replay_analysis'
    );
    assert.equal(hits.length, 1, 'must emit exactly 1 tier2_invoked(replay_analysis)');
    assert.equal(hits[0].source, 'state_watcher_backstop');
  });

  test('case 5: ORCHESTRAY_TIER2_WATCHER_DISABLED=1 → 0 emits for all 4 paths', () => {
    const dir = makeRepo();

    // Write all 4 trigger files.
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'confidence', 'task-T1.json'),
      JSON.stringify({ task_id: 'task-T1', confidence: 0.1 }),
    );
    const routingEntry = JSON.stringify({ task_id: 'task-D1', agent_type: 'documenter' });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'routing.jsonl'),
      routingEntry + '\n',
    );
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'disagree-T1.json'),
      JSON.stringify({ task_id: 'task-T1' }),
    );
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'replay-T1.json'),
      JSON.stringify({ task_id: 'task-T1' }),
    );

    const paths = [
      '.orchestray/state/confidence/task-T1.json',
      '.orchestray/state/routing.jsonl',
      '.orchestray/state/disagree-T1.json',
      '.orchestray/state/replay-T1.json',
    ];

    for (const relPath of paths) {
      const r = runWatcher(dir, relPath, { ORCHESTRAY_TIER2_WATCHER_DISABLED: '1' });
      assert.equal(r.status, 0, `watcher exit=${r.status} for ${relPath} stderr=${r.stderr}`);
    }

    const events = readEvents(dir);
    const tier2 = events.filter(e => e.type === 'tier2_invoked');
    assert.equal(tier2.length, 0, 'kill-switch must suppress all tier2_invoked emits');
  });

  test('case 6: same file written twice (same protocol+orchestration) → idempotent — 0 emits on second write', () => {
    const dir     = makeRepo();
    const relPath = '.orchestray/state/disagree-T1.json';
    const content = JSON.stringify({ task_id: 'task-T1', finding: 'design trade-off' });

    // First write — should emit.
    fs.writeFileSync(path.join(dir, relPath), content);
    const r1 = runWatcher(dir, relPath);
    assert.equal(r1.status, 0, `first run exit=${r1.status} stderr=${r1.stderr}`);

    const afterFirst = readEvents(dir).filter(e =>
      e.type === 'tier2_invoked' && e.protocol === 'disagreement_protocol'
    );
    assert.equal(afterFirst.length, 1, 'first write must emit 1 tier2_invoked');

    // Second write — identical file, same orchestration. Must NOT re-emit.
    fs.writeFileSync(path.join(dir, relPath), content);
    const r2 = runWatcher(dir, relPath);
    assert.equal(r2.status, 0, `second run exit=${r2.status} stderr=${r2.stderr}`);

    const afterSecond = readEvents(dir).filter(e =>
      e.type === 'tier2_invoked' && e.protocol === 'disagreement_protocol'
    );
    assert.equal(afterSecond.length, 1, 'second write must NOT add another tier2_invoked (idempotent)');
  });

});
