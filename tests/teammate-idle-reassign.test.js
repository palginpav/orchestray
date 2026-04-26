#!/usr/bin/env node
'use strict';

/**
 * tests/teammate-idle-reassign.test.js — v2.1.16 R-AT-FLAG (W10)
 *
 * Focused smoke test for `bin/reassign-idle-teammate.js` exit codes:
 *
 *   - Pending work in task-graph.md → exit 2 (block stop, redirect teammate)
 *   - No pending work / file absent → exit 0 (allow stop)
 *
 * The exhaustive test suite for this hook lives in
 * `tests/reassign-idle-teammate.test.js`. This file is a minimal contract
 * smoke test that ships alongside R-AT-FLAG so the dual-gate change has its
 * own focused regression guard.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', 'bin', 'reassign-idle-teammate.js');

function run(stdinData) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-r-at-flag-'));
}

function seedTaskGraph(tmpDir, content) {
  const stateDir = path.join(tmpDir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'task-graph.md'), content);
}

describe('R-AT-FLAG W10: reassign-idle-teammate.js exit-code contract', () => {
  test('script file exists at the registered hooks/hooks.json path', () => {
    assert.ok(fs.existsSync(SCRIPT), `expected hook script at ${SCRIPT}`);
  });

  test('remaining work case: unchecked checkbox blocks the idle teammate (exit 2)', () => {
    const tmpDir = makeTmpDir();
    seedTaskGraph(tmpDir, '## Tasks\n- [ ] still TODO\n');
    try {
      const { status, stdout } = run(JSON.stringify({ cwd: tmpDir }));
      assert.equal(status, 2, 'remaining work must produce exit 2 (block stop)');
      const out = JSON.parse(stdout.trim());
      assert.equal(out.continue, false, 'stdout must be { continue: false } when blocking');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('no remaining work case: all-checked task graph allows stop (exit 0)', () => {
    const tmpDir = makeTmpDir();
    seedTaskGraph(tmpDir, '## Tasks\n- [x] done A\n- [x] done B\n');
    try {
      const { status, stdout } = run(JSON.stringify({ cwd: tmpDir }));
      assert.equal(status, 0, 'no remaining work must produce exit 0 (allow stop)');
      const out = JSON.parse(stdout.trim());
      assert.equal(out.continue, true, 'stdout must be { continue: true } when allowing stop');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('absent task-graph.md: hook fails open with exit 0 (allow stop)', () => {
    const tmpDir = makeTmpDir();
    try {
      const { status } = run(JSON.stringify({ cwd: tmpDir }));
      assert.equal(status, 0, 'absent graph file must not block teammate stop');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('malformed stdin: hook fails open with exit 0 (no permanent wedge)', () => {
    const { status } = run('{not json');
    assert.equal(status, 0, 'malformed stdin must never block — fail-open contract');
  });
});
