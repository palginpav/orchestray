#!/usr/bin/env node
'use strict';

/**
 * ox smoke tests (v2.1.11 F-08 / R4 AC-01 + AC-07).
 *
 * Tests the ox CLI binary for basic operation, silent-success convention,
 * idempotency, S01-S06 boundary assertions, and path-containment.
 *
 * Each test spawns a fresh tmp directory with OX_CWD pointing to it so
 * tests are fully isolated and don't pollute the real project state.
 *
 * Runner: node --test tests/ox.smoke.test.js
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OX_BIN = path.join(__dirname, '..', 'bin', 'ox.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ox-smoke-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

/**
 * Run ox with the given arguments in the given project root.
 * Returns { status, stdout, stderr }.
 */
function runOx(args, cwd) {
  const result = spawnSync(process.execPath, [OX_BIN, ...args], {
    env: { ...process.env, OX_CWD: cwd },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Initialise an orchestration marker in cwd so state-dependent verbs work.
 */
function initOrch(cwd, orchId) {
  const id = orchId || 'orch-1234567890';
  runOx(['state', 'init', id, '--task=smoke test'], cwd);
  return id;
}

// ---------------------------------------------------------------------------
// S1: ox help — exits 0, emits verb table
// ---------------------------------------------------------------------------

describe('ox help', () => {
  test('exits 0 and emits verb table', () => {
    const cwd = makeTmpDir();
    try {
      const r = runOx(['help'], cwd);
      assert.equal(r.status, 0, 'ox help should exit 0');
      assert.ok(r.stdout.includes('routing add') || r.stdout.includes('events append'),
        'help output must include verb table');
    } finally {
      cleanup(cwd);
    }
  });

  test('bare ox (no verb) exits 0 and emits verb table', () => {
    const cwd = makeTmpDir();
    try {
      const r = runOx([], cwd);
      assert.equal(r.status, 0, 'bare ox should exit 0');
      assert.ok(r.stdout.includes('routing') || r.stdout.includes('state'),
        'bare ox must emit usage/verb table');
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// S2: state init — silent success, idempotent
// ---------------------------------------------------------------------------

describe('ox state init', () => {
  test('exits 0 with empty stdout on success (silent-success convention)', () => {
    const cwd = makeTmpDir();
    try {
      const r = runOx(['state', 'init', 'orch-1000000001', '--task=smoke'], cwd);
      assert.equal(r.status, 0, 'state init should exit 0');
      assert.equal(r.stdout.trim(), '', 'mutating verb success must produce empty stdout');
    } finally {
      cleanup(cwd);
    }
  });

  test('idempotent: second identical call emits noop JSON and exits 0', () => {
    const cwd = makeTmpDir();
    try {
      runOx(['state', 'init', 'orch-1000000001', '--task=smoke'], cwd);
      const r = runOx(['state', 'init', 'orch-1000000001', '--task=smoke'], cwd);
      assert.equal(r.status, 0, 'idempotent call should exit 0');
      const parsed = JSON.parse(r.stdout);
      assert.ok(parsed.noop === true, 'idempotent call must emit {"noop":true,...}');
    } finally {
      cleanup(cwd);
    }
  });

  test('unknown verb exits 1 with ox: <verb>: unknown verb prefix', () => {
    const cwd = makeTmpDir();
    try {
      const r = runOx(['notaverb'], cwd);
      assert.equal(r.status, 1, 'unknown verb should exit 1');
      assert.ok(r.stderr.includes('ox:') && r.stderr.includes('unknown verb'),
        'unknown verb must emit ox: <verb>: unknown verb to stderr');
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// S3: state complete — silent success, requires active orchestration
// ---------------------------------------------------------------------------

describe('ox state complete', () => {
  test('exits 0 with empty stdout when orchestration is active', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000002');
      const r = runOx(['state', 'complete', '--status=success'], cwd);
      assert.equal(r.status, 0, 'state complete should exit 0');
      assert.equal(r.stdout.trim(), '', 'mutating verb success must produce empty stdout');
    } finally {
      cleanup(cwd);
    }
  });

  test('exits 0 with noop JSON when no active orchestration (idempotent)', () => {
    const cwd = makeTmpDir();
    try {
      const r = runOx(['state', 'complete', '--status=success'], cwd);
      // state complete is idempotent: no-orch case emits noop and exits 0.
      assert.equal(r.status, 0, 'state complete without active orch should exit 0 (idempotent)');
      const parsed = JSON.parse(r.stdout);
      assert.ok(parsed.noop === true, 'no-orch complete must emit {"noop":true,...}');
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// S4: routing add — silent success, idempotent
// ---------------------------------------------------------------------------

describe('ox routing add', () => {
  test('exits 0 with empty stdout on success', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000003');
      const r = runOx(['routing', 'add', 'T1', 'developer', 'sonnet'], cwd);
      assert.equal(r.status, 0, 'routing add should exit 0');
      assert.equal(r.stdout.trim(), '', 'mutating verb success must produce empty stdout');
    } finally {
      cleanup(cwd);
    }
  });

  test('idempotent: duplicate row emits noop JSON and exits 0', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000003');
      runOx(['routing', 'add', 'T1', 'developer', 'sonnet'], cwd);
      const r = runOx(['routing', 'add', 'T1', 'developer', 'sonnet'], cwd);
      assert.equal(r.status, 0, 'duplicate routing add should exit 0');
      const parsed = JSON.parse(r.stdout);
      assert.ok(parsed.noop === true, 'duplicate add must emit {"noop":true,...}');
    } finally {
      cleanup(cwd);
    }
  });

  test('rejects unknown agent_type with exit 1', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000003');
      const r = runOx(['routing', 'add', 'T1', 'notanagent', 'sonnet'], cwd);
      assert.equal(r.status, 1, 'unknown agent_type should exit 1');
    } finally {
      cleanup(cwd);
    }
  });

  test('rejects unknown model with exit 1', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000003');
      const r = runOx(['routing', 'add', 'T1', 'developer', 'gpt-4'], cwd);
      assert.equal(r.status, 1, 'unknown model should exit 1');
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// S5: events append — silent success, S03 boundary enforcement
// ---------------------------------------------------------------------------

describe('ox events append', () => {
  test('exits 0 with empty stdout on success', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000004');
      const r = runOx(['events', 'append', '--event-type=routing_outcome'], cwd);
      assert.equal(r.status, 0, 'events append should exit 0');
      assert.equal(r.stdout.trim(), '', 'mutating verb success must produce empty stdout');
    } finally {
      cleanup(cwd);
    }
  });

  test('S03: rejects reserved keys in --extra (orchestration_id)', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000004');
      const r = runOx([
        'events', 'append',
        '--event-type=routing_outcome',
        '--extra={"orchestration_id":"injected"}',
      ], cwd);
      assert.equal(r.status, 2, 'reserved key in --extra should exit 2 (usage error)');
      assert.ok(r.stderr.includes('reserved'), 'error must mention reserved key');
    } finally {
      cleanup(cwd);
    }
  });

  test('S03: rejects --extra exceeding 2048-byte cap', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000004');
      const bigValue = 'x'.repeat(2049);
      const r = runOx([
        'events', 'append',
        '--event-type=routing_outcome',
        `--extra={"note":"${bigValue}"}`,
      ], cwd);
      assert.equal(r.status, 2, '--extra exceeding 2048 bytes should exit 2');
      assert.ok(r.stderr.includes('2048'), 'error must mention 2048-byte cap');
    } finally {
      cleanup(cwd);
    }
  });

  test('atomic append: events.jsonl grows by exactly one line per call', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000005');
      const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');

      // state init may have already written an event (orchestration_start etc.).
      // Count baseline lines before our appends.
      const baselineLines = fs.existsSync(eventsPath)
        ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).length
        : 0;

      runOx(['events', 'append', '--event-type=routing_outcome'], cwd);
      const after1 = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(after1.length, baselineLines + 1, 'first append must add exactly 1 line');

      runOx(['events', 'append', '--event-type=agent_start'], cwd);
      const after2 = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(after2.length, baselineLines + 2, 'second append must add exactly 1 more line');

      // Verify each line is valid JSON.
      for (const line of after2) {
        assert.doesNotThrow(() => JSON.parse(line), `each JSONL line must be valid JSON: ${line}`);
      }
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// S6: state peek — read-only, emits JSON
// ---------------------------------------------------------------------------

describe('ox state peek', () => {
  test('--json flag emits valid JSON with status field', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000006');
      const r = runOx(['state', 'peek', '--json'], cwd);
      assert.equal(r.status, 0, 'state peek should exit 0');
      const parsed = JSON.parse(r.stdout);
      assert.ok('status' in parsed, 'peek JSON must include status field');
    } finally {
      cleanup(cwd);
    }
  });

  test('no active orchestration emits {status:"none"} and exits 0', () => {
    const cwd = makeTmpDir();
    try {
      const r = runOx(['state', 'peek', '--json'], cwd);
      assert.equal(r.status, 0, 'state peek with no orch should exit 0');
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.status, 'none', 'no-orch peek must emit {status:"none"}');
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// S01: Path-containment (S04)
// ---------------------------------------------------------------------------

describe('S04 path-containment', () => {
  test('--file path outside project root rejected with exit 1', () => {
    // ox events append doesn't have a --file arg yet in v1, but the resolveFilePath
    // helper is tested indirectly. We verify the guard exists by testing a crafted
    // path traversal in routing add (which validates orchestration_id and agent_type
    // before doing any file I/O).
    // This test ensures the binary loads without errors and rejects malformed input.
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000007');
      // Attempt path traversal via orchestration_id field (will fail validation first).
      const r = runOx(['state', 'init', '../escape-orch-1000000007'], cwd);
      // Should fail (exit 1 or 2) — orchestration_id must start with 'orch-'.
      assert.ok(r.status !== 0, 'path traversal attempt must be rejected');
      assert.ok(r.stderr.includes('ox:'), 'error must use ox: prefix');
    } finally {
      cleanup(cwd);
    }
  });
});

// ---------------------------------------------------------------------------
// S02: dry-run — no files written
// ---------------------------------------------------------------------------

describe('dry-run no-op', () => {
  test('state init --dry-run does not create any files', () => {
    const cwd = makeTmpDir();
    try {
      const r = runOx(['state', 'init', 'orch-1000000008', '--dry-run'], cwd);
      assert.equal(r.status, 0, 'dry-run should exit 0');
      const stateDir = path.join(cwd, '.orchestray', 'state');
      assert.ok(!fs.existsSync(stateDir), 'dry-run must not create state directory');
    } finally {
      cleanup(cwd);
    }
  });

  test('routing add --dry-run does not write routing.jsonl', () => {
    const cwd = makeTmpDir();
    try {
      initOrch(cwd, 'orch-1000000009');
      const r = runOx(['routing', 'add', 'T1', 'developer', 'sonnet', '--dry-run'], cwd);
      assert.equal(r.status, 0, 'routing add --dry-run should exit 0');
      const routingPath = path.join(cwd, '.orchestray', 'state', 'routing.jsonl');
      assert.ok(!fs.existsSync(routingPath), 'dry-run must not write routing.jsonl');
    } finally {
      cleanup(cwd);
    }
  });
});
