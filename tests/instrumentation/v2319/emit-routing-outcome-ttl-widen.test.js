'use strict';

/**
 * emit-routing-outcome.js — post-fire guard window widen (v2.3.19 W4).
 *
 * v2319-guard-window-analysis.md §1 found the guard's ttlMs (100) too tight
 * for real dual-install spawn latency under CPU contention — the same class
 * of defect fixed for inject-delegation-delta.js in a17d9ce. Widened here to
 * 2000ms, matching that site's window.
 *
 * The dedup journal entry that would represent "install A's earlier fire" is
 * fabricated directly (ts_ms in the past, distinct caller_path) rather than
 * produced by a real racing process — mirrors the existing TTL-expiry test
 * in generalized-double-fire-guard.test.js (test 9). This makes the window
 * boundary deterministic instead of depending on real wall-clock racing.
 *
 * Tests:
 *   1. A sibling-install entry 500ms old is now caught (was missed at 100ms)
 *      — no duplicate routing_outcome is written.
 *   2. A genuinely distinct task ~4.8s apart (near the analysis's measured
 *      4757ms floor for the closest real distinct-task pair) is NOT falsely
 *      suppressed at 2000ms — both directions of the width tradeoff.
 *   3. Wiring: the literal ttlMs value at this call site is 2000, not 100.
 */

const test          = require('node:test');
const assert        = require('node:assert/strict');
const fs            = require('node:fs');
const os            = require('node:os');
const path          = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT    = path.join(REPO_ROOT, 'bin', 'emit-routing-outcome.js');

function makeProject(t, orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ero-ttl-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  return dir;
}

function seedJournal(dir, entry) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'emit-routing-outcome-dedup.jsonl'),
    JSON.stringify(entry) + '\n'
  );
}

function runHook(dir) {
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'developer',
      model:         'sonnet',
      effort:        'high',
      description:   'test task',
    },
    cwd: dir,
  };
  return spawnSync(process.execPath, [SCRIPT], {
    input:    JSON.stringify(payload),
    encoding: 'utf8',
    timeout:  8000,
    cwd:      dir,
    // Isolate the post-fire guard under test from the unrelated entry-level
    // stdin-claim dedup layer (bin/_lib/hook-stdin.js), which has its own
    // 2000ms window and would otherwise decide this single-process test
    // before emit-routing-outcome.js's own guard runs.
    env: Object.assign({}, process.env, { ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP: '1' }),
  });
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

test('emit-routing-outcome: sibling-install entry 500ms old is caught at ttlMs=2000 (was missed at 100ms)', (t) => {
  const orchId = 'orch-ero-ttl-catch-' + Date.now();
  const dir = makeProject(t, orchId);
  seedJournal(dir, {
    dedup_key:        orchId + ':developer:routing',
    ts_ms:            Date.now() - 500,
    caller_path:      '/other-install/bin/emit-routing-outcome.js',
    orchestration_id: orchId,
  });

  const r = runHook(dir);
  assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);

  const events = readEvents(dir);
  const doubleFire = events.filter(e => e.type === 'hook_double_fire_detected' && e.guard_name === 'emit-routing-outcome');
  const routing    = events.filter(e => e.type === 'routing_outcome');

  assert.equal(doubleFire.length, 1, 'a 500ms-old sibling-install entry must be recognised as a duplicate');
  assert.equal(routing.length, 0, 'no duplicate routing_outcome should be written once caught');
});

test('emit-routing-outcome: a genuinely distinct task ~4.8s apart is NOT falsely suppressed at ttlMs=2000', (t) => {
  const orchId = 'orch-ero-ttl-distinct-' + Date.now();
  const dir = makeProject(t, orchId);
  seedJournal(dir, {
    dedup_key:        orchId + ':developer:routing',
    ts_ms:            Date.now() - 4800,
    caller_path:      '/other-install/bin/emit-routing-outcome.js',
    orchestration_id: orchId,
  });

  const r = runHook(dir);
  assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);

  const events = readEvents(dir);
  const doubleFire = events.filter(e => e.type === 'hook_double_fire_detected' && e.guard_name === 'emit-routing-outcome');
  const routing    = events.filter(e => e.type === 'routing_outcome');

  assert.equal(doubleFire.length, 0, 'a genuinely distinct task well outside the window must not be suppressed');
  assert.equal(routing.length, 1, 'the distinct task must still produce its own routing_outcome');
});

test('emit-routing-outcome: ttlMs at this call site is 2000, not 100', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const m = src.match(/guardName:\s*'emit-routing-outcome'[\s\S]{0,1200}?ttlMs:\s*(\d+)/);
  assert.ok(m, 'could not locate ttlMs for the emit-routing-outcome guard call');
  assert.equal(m[1], '2000', 'ttlMs must be widened to 2000ms');
});
