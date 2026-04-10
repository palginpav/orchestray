#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/pre-compact-archive.js
 *
 * PreCompact hook. Snapshots .orchestray/state/ + .orchestray/audit/ into
 * .orchestray/history/pre-compact-<timestamp>/ before Claude Code compacts
 * the session. Non-blocking: must always exit 0 with { continue: true }.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/pre-compact-archive.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-precompact-test-'));
}

function run(cwd, stdinData = '{}') {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    cwd,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function parseOutput(stdout) {
  return JSON.parse(stdout.trim());
}

function findSnapshotDir(tmpDir) {
  const historyDir = path.join(tmpDir, '.orchestray', 'history');
  if (!fs.existsSync(historyDir)) return null;
  const dirs = fs.readdirSync(historyDir)
    .filter(d => d.startsWith('pre-compact-'));
  if (dirs.length === 0) return null;
  return path.join(historyDir, dirs[0]);
}

// ---------------------------------------------------------------------------
// Smoke: empty .orchestray/ — exits 0, no archive created
// ---------------------------------------------------------------------------

describe('pre-compact-archive — smoke', () => {

  test('empty .orchestray/ exits 0 with no archive', () => {
    const tmpDir = makeTmpDir();
    // Create an empty .orchestray dir so the script doesn't early-bail, but
    // leaves no state/audit data to archive.
    fs.mkdirSync(path.join(tmpDir, '.orchestray'), { recursive: true });

    try {
      const payload = JSON.stringify({ cwd: tmpDir, trigger: 'manual' });
      const { stdout, status } = run(tmpDir, payload);
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);

      // The script will still create a snapshot dir with an empty manifest
      // because .orchestray exists. The snapshot must exist but contain no
      // archived files beyond the manifest.
      const snap = findSnapshotDir(tmpDir);
      assert.ok(snap, 'snapshot dir should be created even with no state');
      const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.archived_files, [], 'no files archived');
      assert.equal(manifest.trigger, 'manual');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Happy path: populated state
// ---------------------------------------------------------------------------

describe('pre-compact-archive — happy path', () => {

  test('populated state is archived with manifest listing all files', () => {
    const tmpDir = makeTmpDir();
    const stateDir = path.join(tmpDir, '.orchestray', 'state');
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    const tasksDir = path.join(stateDir, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });

    fs.writeFileSync(path.join(stateDir, 'orchestration.md'), '# orchestration\n');
    fs.writeFileSync(path.join(stateDir, 'task-graph.md'), '# graph\n');
    fs.writeFileSync(path.join(tasksDir, 'task-1.md'), '# task 1\n');
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-happy' })
    );

    try {
      const payload = JSON.stringify({ cwd: tmpDir, trigger: 'auto' });
      const { status } = run(tmpDir, payload);
      assert.equal(status, 0);

      const snap = findSnapshotDir(tmpDir);
      assert.ok(snap, 'snapshot dir created');
      assert.ok(fs.existsSync(path.join(snap, 'orchestration.md')));
      assert.ok(fs.existsSync(path.join(snap, 'task-graph.md')));
      assert.ok(fs.existsSync(path.join(snap, 'tasks', 'task-1.md')));
      assert.ok(fs.existsSync(path.join(snap, 'current-orchestration.json')));

      const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
      assert.equal(manifest.orchestration_id, 'orch-happy');
      assert.equal(manifest.trigger, 'auto');
      assert.ok(manifest.archived_files.includes('orchestration.md'));
      assert.ok(manifest.archived_files.includes('task-graph.md'));
      assert.ok(manifest.archived_files.includes('tasks/task-1.md'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Nested tasks (DEF-8 coverage)
// ---------------------------------------------------------------------------

describe('pre-compact-archive — nested task subdirs (DEF-8)', () => {

  test('nested task files preserve their relative paths in the snapshot', () => {
    const tmpDir = makeTmpDir();
    const tasksDir = path.join(tmpDir, '.orchestray', 'state', 'tasks');
    const nested = path.join(tasksDir, 'sub');
    const deeper = path.join(tasksDir, 'sub', 'deeper');
    fs.mkdirSync(deeper, { recursive: true });

    fs.writeFileSync(path.join(tasksDir, 'top-level.md'), 'top\n');
    fs.writeFileSync(path.join(nested, 'task-1.md'), 'nested 1\n');
    fs.writeFileSync(path.join(deeper, 'task-2.md'), 'nested 2\n');

    try {
      const payload = JSON.stringify({ cwd: tmpDir });
      const { status } = run(tmpDir, payload);
      assert.equal(status, 0);

      const snap = findSnapshotDir(tmpDir);
      assert.ok(snap, 'snapshot dir created');

      // Top-level file copied
      assert.ok(
        fs.existsSync(path.join(snap, 'tasks', 'top-level.md')),
        'top-level task file should be copied'
      );
      // Nested one-level file copied
      assert.ok(
        fs.existsSync(path.join(snap, 'tasks', 'sub', 'task-1.md')),
        'nested task file should preserve its sub/ path'
      );
      // Nested two-level file copied
      assert.ok(
        fs.existsSync(path.join(snap, 'tasks', 'sub', 'deeper', 'task-2.md')),
        'deeply nested task file should preserve its sub/deeper/ path'
      );

      const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
      assert.ok(manifest.archived_files.includes('tasks/top-level.md'));
      assert.ok(manifest.archived_files.includes('tasks/sub/task-1.md'));
      assert.ok(manifest.archived_files.includes('tasks/sub/deeper/task-2.md'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Missing state dir — graceful skip
// ---------------------------------------------------------------------------

describe('pre-compact-archive — missing .orchestray/', () => {

  test('exits 0 and creates no archive when .orchestray/ does not exist', () => {
    const tmpDir = makeTmpDir();
    // Note: do NOT create .orchestray/ — the script should early-bail.

    try {
      const payload = JSON.stringify({ cwd: tmpDir });
      const { stdout, status } = run(tmpDir, payload);
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);

      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.orchestray', 'history')),
        'no history dir should be created when .orchestray is absent'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Audit trail: existing events.jsonl is copied into snapshot
// ---------------------------------------------------------------------------

describe('pre-compact-archive — audit trail', () => {

  test('existing events.jsonl is copied into the snapshot', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    const existingEvents = [
      JSON.stringify({ type: 'agent_start', timestamp: '2026-04-10T00:00:00Z' }),
      JSON.stringify({ type: 'agent_stop', timestamp: '2026-04-10T00:00:05Z' }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(auditDir, 'events.jsonl'), existingEvents);

    try {
      const payload = JSON.stringify({ cwd: tmpDir });
      const { status } = run(tmpDir, payload);
      assert.equal(status, 0);

      const snap = findSnapshotDir(tmpDir);
      assert.ok(snap);
      const copied = fs.readFileSync(path.join(snap, 'events.jsonl'), 'utf8');
      // The script will itself append a pre_compact_archive event to the
      // LIVE events.jsonl after taking the snapshot — but the snapshot copy
      // reflects the state at the time of copyFileSync. Either the two
      // original lines OR three lines (if the append somehow raced into the
      // snapshot file) would be a bug. We assert the snapshot contains both
      // original events.
      assert.ok(copied.includes('"type":"agent_start"'));
      assert.ok(copied.includes('"type":"agent_stop"'));

      const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
      assert.ok(manifest.archived_files.includes('events.jsonl'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});
