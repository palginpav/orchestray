#!/usr/bin/env node
'use strict';

/**
 * v223-small-fixes.test.js -- batched coverage for v2.2.3 P0-5 + P0-6.
 *
 *   P0-5: bin/validate-task-completion.js MUST be ASCII text. Embedded
 *         non-ASCII bytes (em-dash, en-dash, section sign, box drawing,
 *         stray NUL) caused file(1) to misclassify the script as binary
 *         and broke downstream tools that key on text-vs-binary heuristics.
 *
 *   P0-6: bin/inject-delegation-delta.js#nextSpawnN previously returned
 *         the fallback spawn_n=1 silently when the .count sidecar write
 *         failed. v2.2.3 keeps the fail-open semantics (spawns are never
 *         blocked) but emits a `spawn_counter_write_failed` audit event so
 *         the failure is observable.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const VALIDATOR   = path.join(REPO_ROOT, 'bin', 'validate-task-completion.js');
const HOOK_PATH   = path.join(REPO_ROOT, 'bin', 'inject-delegation-delta.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE        = process.execPath;

// ---------------------------------------------------------------------------
// P0-5 -- ASCII fold
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-5 -- validate-task-completion.js ASCII fold', () => {
  test('contains zero non-ASCII bytes', () => {
    const buf = fs.readFileSync(VALIDATOR);
    const offending = [];
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] >= 0x80) offending.push({ offset: i, byte: buf[i] });
    }
    if (offending.length > 0) {
      const sample = offending.slice(0, 5)
        .map((x) => 'offset=' + x.offset + ' byte=0x' + x.byte.toString(16))
        .join('; ');
      throw new Error(
        'validate-task-completion.js contains ' + offending.length +
        ' non-ASCII byte(s); first samples: ' + sample
      );
    }
    assert.equal(offending.length, 0);
  });

  test('contains no stray control bytes (excl. tab/LF/CR)', () => {
    const buf = fs.readFileSync(VALIDATOR);
    const ctrl = [];
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (b < 32 && b !== 9 && b !== 10 && b !== 13) {
        ctrl.push({ offset: i, byte: b });
      }
    }
    assert.equal(
      ctrl.length, 0,
      'unexpected control byte(s): ' + JSON.stringify(ctrl.slice(0, 5))
    );
  });

  test('node --check parses cleanly', () => {
    const r = cp.spawnSync(NODE, ['--check', VALIDATOR], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(r.status, 0, 'node --check failed; stderr=' + r.stderr);
  });
});

// ---------------------------------------------------------------------------
// P0-6 -- spawn-counter audit emit
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p06-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // Schema validator needs the source available so the audit-event-writer's
  // schema check finds the event-schemas.md and validates the new event.
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  return root;
}

function writeOrchMarker(root, orchId) {
  const file = path.join(root, '.orchestray', 'audit', 'current-orchestration.json');
  fs.writeFileSync(file, JSON.stringify({ orchestration_id: orchId }), 'utf8');
}

function buildMarkedPrompt(staticBody, perSpawnBody) {
  return (
    '<!-- delta:static-begin -->\n' +
    staticBody +
    '\n<!-- delta:static-end -->\n' +
    '<!-- delta:per-spawn-begin -->\n' +
    perSpawnBody +
    '\n<!-- delta:per-spawn-end -->'
  );
}

function runHook(payload, env) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env: Object.assign({}, process.env, env || {}),
    encoding: 'utf8',
    timeout: 8000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter((e) => e !== null);
}

const STATIC_BODY = (
  '## Handoff Contract\nfollow contract.md\n\n' +
  '## Pre-Flight\n- read repo map\n- list files\n\n' +
  '## Repo Map\n' + ('[entry]\n'.repeat(40))
);
const PER_SPAWN_V1 = '## Task\nimplement feature X\n';

describe('v2.2.3 P0-6 -- spawn-counter sidecar emit on failure', () => {
  test('write-failure emits spawn_counter_write_failed and falls back to spawn_n=1', () => {
    if (process.platform === 'win32' || process.getuid && process.getuid() === 0) {
      // chmod-based write protection does not work as root or on Windows.
      // Skip rather than produce false positives.
      return;
    }

    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-v223-p06');

    // Pre-create the spawn-prefix-cache directory and lock it read-only so
    // mkdirSync({recursive:true}) succeeds (idempotent on existing dirs) but
    // writeFileSync inside fails with EACCES. This exercises the inner
    // write-fail catch on a fresh counter.
    const cacheDir = path.join(root, '.orchestray', 'state', 'spawn-prefix-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.chmodSync(cacheDir, 0o555);

    try {
      const r = runHook({
        tool_name: 'Agent',
        cwd: root,
        tool_input: {
          subagent_type: 'developer',
          prompt: buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1),
        },
      });
      assert.equal(r.status, 0, 'hook exits 0 even on counter write failure; stderr=' + r.stderr);

      const evs = readEvents(root);
      const fail = evs.find((e) => e.type === 'spawn_counter_write_failed');
      assert.ok(fail, 'spawn_counter_write_failed event must be emitted');
      assert.equal(fail.version, 1);
      assert.equal(fail.orchestration_id, 'orch-v223-p06');
      assert.equal(fail.agent_type, 'developer');
      assert.equal(fail.fallback_spawn_n, 1);
      assert.equal(typeof fail.error_message, 'string');
      assert.ok(fail.error_message.length > 0, 'error_message must be non-empty');
      assert.equal(typeof fail.error_class, 'string');
      assert.ok(
        typeof fail.counter_path === 'string' && fail.counter_path.length > 0,
        'counter_path must be a non-empty string'
      );
      assert.ok(
        fail.counter_path.endsWith('orch-v223-p06-developer.count'),
        'counter_path must point at the expected sidecar'
      );

      // The delegation_delta_emit row that goes out must still carry a usable
      // spawn_n (fallback 1) so downstream rollups never see a hole.
      const emit = evs.find((e) => e.type === 'delegation_delta_emit');
      assert.ok(emit, 'delegation_delta_emit must still be written');
      assert.equal(emit.spawn_n, 1, 'fallback spawn_n must reach the emit row');
    } finally {
      // Always restore perms so the tmpdir cleanup does not bleed.
      try { fs.chmodSync(cacheDir, 0o755); } catch (_e) { /* swallow */ }
    }
  });

  test('happy-path write does NOT emit spawn_counter_write_failed', () => {
    const root = makeTmpRoot();
    writeOrchMarker(root, 'orch-v223-p06-happy');

    const r = runHook({
      tool_name: 'Agent',
      cwd: root,
      tool_input: {
        subagent_type: 'developer',
        prompt: buildMarkedPrompt(STATIC_BODY, PER_SPAWN_V1),
      },
    });
    assert.equal(r.status, 0, 'happy-path hook exits 0; stderr=' + r.stderr);

    const evs = readEvents(root);
    const fail = evs.find((e) => e.type === 'spawn_counter_write_failed');
    assert.equal(fail, undefined, 'no failure event on healthy filesystem');

    // Sidecar must exist and contain "1" -- proves the write succeeded.
    const counterPath = path.join(
      root, '.orchestray', 'state', 'spawn-prefix-cache',
      'orch-v223-p06-happy-developer.count'
    );
    assert.ok(fs.existsSync(counterPath), 'counter sidecar must exist on happy path');
    assert.equal(fs.readFileSync(counterPath, 'utf8').trim(), '1');
  });
});
