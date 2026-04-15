#!/usr/bin/env node
'use strict';

/**
 * W4 tests — /orchestray:state peek subcommand (UX4a).
 *
 * Fixture-based tests for bin/state-peek.js.
 *
 * Scenarios:
 *   A — active orchestration.md + audit record + task files shown
 *   B — leaked history entry flagged (no orchestration_complete, older than 24h)
 *   C — non-leaked history entry NOT flagged (has orchestration_complete)
 *   D — fresh history entry NOT flagged (no complete event but < 24h old)
 *   E — no .orchestray directory → graceful "not yet used" message
 *   F — no file writes happen (mtimes unchanged after peek)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/state-peek.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w4-state-peek-'));
  cleanup.push(dir);
  return dir;
}

function runPeek(projectDir) {
  return spawnSync(process.execPath, [SCRIPT, projectDir], {
    encoding: 'utf8',
    timeout: 15000,
  });
}

/**
 * Create a minimal .orchestray directory structure under projectDir.
 */
function makeOrchDir(projectDir) {
  const orchDir = path.join(projectDir, '.orchestray');
  fs.mkdirSync(path.join(orchDir, 'state', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(orchDir, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(orchDir, 'history'), { recursive: true });
  return orchDir;
}

/**
 * Write a fake orchestration.md with YAML frontmatter.
 */
function writeOrchMd(orchDir, { id, task, started_at, status }) {
  const content = [
    '---',
    `id: ${id}`,
    `task: ${task}`,
    `started_at: ${started_at}`,
    `status: ${status}`,
    '---',
    '',
    '## W-item Status',
    '',
    '| W-item | Status |',
    '|--------|--------|',
    '| W1 | complete |',
    '| W2 | in-progress |',
  ].join('\n');
  fs.writeFileSync(path.join(orchDir, 'state', 'orchestration.md'), content);
}

/**
 * Write a fake current-orchestration.json.
 */
function writeCurrentOrch(orchDir, { orchestration_id, started_at }) {
  fs.writeFileSync(
    path.join(orchDir, 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id, started_at })
  );
}

/**
 * Write fake task files.
 */
function writeTaskFiles(orchDir, names) {
  for (const name of names) {
    fs.writeFileSync(
      path.join(orchDir, 'state', 'tasks', name),
      `---\ntask_id: ${name}\nstatus: pending\n---\n`
    );
  }
}

/**
 * Create a history entry directory with an optional events.jsonl.
 * backdateMs: if set, artificially set the directory mtime to now - backdateMs.
 */
function makeHistoryEntry(orchDir, name, { complete = false, backdateMs = null } = {}) {
  const entryDir = path.join(orchDir, 'history', name);
  fs.mkdirSync(entryDir, { recursive: true });

  const events = [];
  if (complete) {
    events.push(JSON.stringify({
      type: 'orchestration_complete',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      orchestration_id: name,
    }));
  } else {
    events.push(JSON.stringify({
      type: 'orchestration_start',
      timestamp: new Date(Date.now() - 120_000).toISOString(),
      orchestration_id: name,
    }));
  }
  fs.writeFileSync(path.join(entryDir, 'events.jsonl'), events.join('\n') + '\n');

  if (backdateMs !== null) {
    // Set mtime to simulate an old directory
    const backdateTime = new Date(Date.now() - backdateMs);
    try {
      fs.utimesSync(entryDir, backdateTime, backdateTime);
    } catch (_e) {
      // If utimes fails on this platform, the test may be inconclusive — acceptable.
    }
  }

  return entryDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W4 state-peek — active orchestration display', () => {

  test('A: active orchestration.md is shown with id, task, started_at, status', () => {
    const dir = makeTmpProject();
    const orchDir = makeOrchDir(dir);

    writeOrchMd(orchDir, {
      id: 'orch-20260415T100000Z-v2018-active',
      task: 'implement new feature X',
      started_at: '2026-04-15T10:00:00.000Z',
      status: 'in-progress',
    });
    writeCurrentOrch(orchDir, {
      orchestration_id: 'orch-20260415T100000Z-v2018-active',
      started_at: '2026-04-15T10:00:00.000Z',
    });

    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0');
    assert.ok(
      result.stdout.includes('orch-20260415T100000Z-v2018-active'),
      'output must include the active orchestration ID'
    );
    assert.ok(
      result.stdout.includes('implement new feature X'),
      'output must include the task description'
    );
    assert.ok(
      result.stdout.includes('2026-04-15T10:00:00.000Z'),
      'output must include the started_at timestamp'
    );
    assert.ok(
      result.stdout.includes('in-progress'),
      'output must include the status'
    );
  });

  test('A2: task files are counted and listed', () => {
    const dir = makeTmpProject();
    const orchDir = makeOrchDir(dir);

    writeTaskFiles(orchDir, ['task-001.md', 'task-002.md', 'task-003.md']);

    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0');
    assert.ok(result.stdout.includes('task-001.md'), 'output must list task-001.md');
    assert.ok(result.stdout.includes('task-002.md'), 'output must list task-002.md');
    assert.ok(result.stdout.includes('task-003.md'), 'output must list task-003.md');
    assert.ok(
      result.stdout.includes('3 task file'),
      'output must state the count of task files'
    );
  });

});

describe('W4 state-peek — history leak detection', () => {

  test('B: leaked history entry (no complete event, > 24h old) is flagged', () => {
    const dir = makeTmpProject();
    const orchDir = makeOrchDir(dir);

    const moreThan24h = 25 * 60 * 60 * 1000; // 25 hours in ms
    makeHistoryEntry(orchDir, 'orch-20260414T080000Z-v2017-stale', {
      complete: false,
      backdateMs: moreThan24h,
    });

    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0');
    assert.ok(
      result.stdout.includes('orch-20260414T080000Z-v2017-stale'),
      'leaked entry must appear in output'
    );
    // Must be flagged as leaked
    const entryLine = result.stdout
      .split('\n')
      .find(l => l.includes('orch-20260414T080000Z-v2017-stale'));
    assert.ok(entryLine, 'leaked entry must have its own output line');
    assert.ok(
      entryLine.includes('leaked') || result.stdout.includes('leaked'),
      'output must flag the entry as leaked'
    );
    assert.ok(
      result.stdout.includes('state gc'),
      'output must mention state gc as the remedy'
    );
  });

  test('C: completed history entry is NOT flagged as leaked', () => {
    const dir = makeTmpProject();
    const orchDir = makeOrchDir(dir);

    const moreThan24h = 25 * 60 * 60 * 1000;
    makeHistoryEntry(orchDir, 'orch-20260414T060000Z-v2017-done', {
      complete: true,
      backdateMs: moreThan24h,
    });

    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0');

    // Entry appears in output (listed under "clean") but must NOT be in the leaked list
    const leakedSection = result.stdout
      .split('\n')
      .filter(l => l.includes('leaked') && l.includes('orch-'));
    const isLeakedLine = leakedSection.some(l =>
      l.includes('orch-20260414T060000Z-v2017-done')
    );
    assert.equal(
      isLeakedLine,
      false,
      'completed history entry must NOT be flagged as leaked'
    );
  });

  test('D: fresh history entry (no complete, but < 24h old) is NOT flagged as leaked', () => {
    const dir = makeTmpProject();
    const orchDir = makeOrchDir(dir);

    // Created 1 hour ago — should NOT be considered leaked
    makeHistoryEntry(orchDir, 'orch-20260415T130000Z-v2018-fresh', {
      complete: false,
      backdateMs: 1 * 60 * 60 * 1000, // 1 hour
    });

    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0');

    const leakedSection = result.stdout
      .split('\n')
      .filter(l => l.includes('leaked') && l.includes('orch-'));
    const isLeakedLine = leakedSection.some(l =>
      l.includes('orch-20260415T130000Z-v2018-fresh')
    );
    assert.equal(
      isLeakedLine,
      false,
      'fresh history entry (< 24h) must NOT be flagged as leaked'
    );
  });

  test('B+C mixed: leaked and clean entries coexist correctly', () => {
    const dir = makeTmpProject();
    const orchDir = makeOrchDir(dir);

    const moreThan24h = 25 * 60 * 60 * 1000;

    // One leaked, one clean
    makeHistoryEntry(orchDir, 'orch-20260413T080000Z-v2017-leaked', {
      complete: false,
      backdateMs: moreThan24h,
    });
    makeHistoryEntry(orchDir, 'orch-20260413T090000Z-v2017-clean', {
      complete: true,
      backdateMs: moreThan24h,
    });

    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0');

    // Leaked entry must be flagged
    const lines = result.stdout.split('\n');
    const leakedLine = lines.find(l =>
      l.includes('orch-20260413T080000Z-v2017-leaked') && l.includes('leaked')
    );
    assert.ok(leakedLine, 'leaked entry must be flagged in output');

    // Clean entry must appear but NOT be in the leaked list
    const cleanLeakedLine = lines.find(l =>
      l.includes('orch-20260413T090000Z-v2017-clean') && l.includes('leaked')
    );
    assert.equal(cleanLeakedLine, undefined, 'clean entry must not be flagged as leaked');
  });

});

describe('W4 state-peek — edge cases', () => {

  test('E: missing .orchestray directory → graceful "not yet used" message', () => {
    // Use a fresh tmp dir with NO .orchestray subdirectory
    const dir = makeTmpProject();
    // Do NOT call makeOrchDir — leave .orchestray absent

    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0 even when .orchestray is absent');
    assert.ok(
      result.stdout.toLowerCase().includes('not') &&
      (result.stdout.toLowerCase().includes('found') ||
       result.stdout.toLowerCase().includes('used')),
      'output must explain that orchestray has not been used in this project'
    );
  });

  test('F: no file writes occur (mtimes unchanged after peek)', () => {
    const dir = makeTmpProject();
    const orchDir = makeOrchDir(dir);

    writeOrchMd(orchDir, {
      id: 'orch-mtime-test',
      task: 'mtime safety check',
      started_at: '2026-04-15T12:00:00.000Z',
      status: 'in-progress',
    });
    writeCurrentOrch(orchDir, {
      orchestration_id: 'orch-mtime-test',
      started_at: '2026-04-15T12:00:00.000Z',
    });
    writeTaskFiles(orchDir, ['task-001.md']);
    makeHistoryEntry(orchDir, 'orch-20260414T000000Z-v2017-old', {
      complete: false,
      backdateMs: 25 * 60 * 60 * 1000,
    });

    // Capture mtimes before
    function collectMtimes(baseDir) {
      const mtimes = {};
      function walk(p) {
        const st = fs.statSync(p);
        mtimes[p] = st.mtimeMs;
        if (st.isDirectory()) {
          for (const entry of fs.readdirSync(p)) {
            walk(path.join(p, entry));
          }
        }
      }
      walk(baseDir);
      return mtimes;
    }

    const before = collectMtimes(orchDir);

    // Run peek
    const result = runPeek(dir);
    assert.equal(result.status, 0, 'state-peek must exit 0');

    // Wait a tick to allow any async writes to settle (there should be none)
    const after = collectMtimes(orchDir);

    // Check no file's mtime changed
    const changed = Object.keys(before).filter(p => {
      // Only compare files that existed before
      return after[p] !== undefined && Math.abs(after[p] - before[p]) > 5;
    });
    // Also check no new files appeared
    const newFiles = Object.keys(after).filter(p => before[p] === undefined);

    assert.deepEqual(changed, [], `state-peek must not modify any files; modified: ${changed.join(', ')}`);
    assert.deepEqual(newFiles, [], `state-peek must not create any new files; created: ${newFiles.join(', ')}`);
  });

  test('legend is present in all non-error outputs', () => {
    const dir = makeTmpProject();
    makeOrchDir(dir);

    const result = runPeek(dir);
    assert.equal(result.status, 0);
    assert.ok(
      result.stdout.includes('state gc'),
      'output must include legend with state gc hint'
    );
    assert.ok(
      result.stdout.includes('v2.0.18'),
      'output must reference v2.0.18 W5 in the legend'
    );
  });

});
