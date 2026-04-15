#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/replay-last-n.sh  (T-S2 — v2.0.17)
 *
 * Contracts under test:
 *  - N=2 with two fixture orchestrations → correct output format, two ORCH blocks
 *  - Routing decisions appear in chronological (event) order
 *  - escalated: true produces :esc suffix
 *  - --save writes a reference file matching stdout
 *  - --compare with matching reference → exit 0
 *  - --compare with differing reference → exit 1
 *  - Orchestration with 0 routing_outcome events → skipped from output
 *  - Missing .orchestray/history/ → exit 0 with empty stdout + stderr note (fail-open)
 *  - Default N=10: more history than 10 → only 10 most-recent returned
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/replay-last-n.sh');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-rln-'));
}

/**
 * Create a synthetic .orchestray/history/<name>/events.jsonl in tmpDir.
 * @param {string} historyDir - absolute path to history/ dir
 * @param {string} orchName   - directory name (used when no orchestration_id in events)
 * @param {object[]} events   - array of event objects to write as JSONL
 */
function writeOrchHistory(historyDir, orchName, events) {
  const orchDir = path.join(historyDir, orchName);
  fs.mkdirSync(orchDir, { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(orchDir, 'events.jsonl'), lines, 'utf8');
}

/**
 * Run the shell script with optional args and env overrides.
 * ORCHESTRAY_HISTORY_DIR is always set to point at the tmp history dir.
 * @param {string[]} args
 * @param {string}   historyDir  - override ORCHESTRAY_HISTORY_DIR
 * @param {object}   [extraEnv]
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function run(args, historyDir, extraEnv = {}) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      ORCHESTRAY_HISTORY_DIR: historyDir,
      ...extraEnv,
    },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function makeRoutingEvent(orchestration_id, agent_type, model_assigned, extras = {}) {
  return {
    timestamp: new Date().toISOString(),
    type: 'routing_outcome',
    orchestration_id,
    agent_type,
    tool_name: 'Agent',
    model_assigned,
    effort_assigned: null,
    description: `${agent_type} task`,
    score: null,
    source: 'hook',
    ...extras,
  };
}

function makeOtherEvent(type = 'orchestration_start') {
  return {
    timestamp: new Date().toISOString(),
    type,
    orchestration_id: 'orch-other',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replay-last-n.sh', () => {

  test('N=2 with two fixture orchestrations → two ORCH blocks in output', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    // Write two orchestrations. ls -t returns newest first, so we need the
    // filesystem mtime to differ. We create them sequentially; mtime granularity
    // on most filesystems is 1s, so we stagger creation or touch them explicitly.
    const orch1 = '20260101T000001Z-orch-alpha';
    const orch2 = '20260101T000002Z-orch-beta';

    writeOrchHistory(historyDir, orch1, [
      makeRoutingEvent('orch-alpha', 'developer', 'sonnet'),
      makeRoutingEvent('orch-alpha', 'reviewer', 'sonnet'),
    ]);

    // Ensure orch2 has a newer mtime by sleeping or touching.
    // Use a 10ms delay via Date.now() spin to ensure different mtime in ms.
    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }

    writeOrchHistory(historyDir, orch2, [
      makeRoutingEvent('orch-beta', 'architect', 'opus'),
    ]);

    // Touch orch2 to ensure it has a newer mtime than orch1
    const now = new Date();
    fs.utimesSync(path.join(historyDir, orch2), now, now);

    const { stdout, status } = run(['2'], historyDir);
    assert.equal(status, 0, `exit code should be 0, stderr: ${stdout}`);

    // Should have two ORCH blocks
    const orchBlocks = stdout.match(/^ORCH /gm) || [];
    assert.equal(orchBlocks.length, 2, `expected 2 ORCH blocks, got: ${stdout}`);

    assert.match(stdout, /ORCH orch-beta/);
    assert.match(stdout, /ORCH orch-alpha/);
    assert.match(stdout, /architect:opus/);
    assert.match(stdout, /developer:sonnet/);
    assert.match(stdout, /reviewer:sonnet/);
  });

  test('routing decisions appear in chronological (event file) order', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    writeOrchHistory(historyDir, '20260101T000001Z-orch-order', [
      makeRoutingEvent('orch-order', 'developer', 'sonnet'),
      makeRoutingEvent('orch-order', 'reviewer', 'haiku'),
      makeRoutingEvent('orch-order', 'architect', 'opus'),
    ]);

    const { stdout, status } = run(['1'], historyDir);
    assert.equal(status, 0);

    // Extract the lines after the ORCH header
    const lines = stdout.split('\n').filter(l => l.trim().length > 0);
    const orchIdx = lines.findIndex(l => l.startsWith('ORCH'));
    assert.notEqual(orchIdx, -1, 'ORCH header not found');

    const decisions = lines.slice(orchIdx + 1);
    assert.equal(decisions[0].trim(), 'developer:sonnet', `first decision: ${decisions[0]}`);
    assert.equal(decisions[1].trim(), 'reviewer:haiku',   `second decision: ${decisions[1]}`);
    assert.equal(decisions[2].trim(), 'architect:opus',   `third decision: ${decisions[2]}`);
  });

  test('escalated: true produces :esc suffix', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    writeOrchHistory(historyDir, '20260101T000001Z-orch-esc', [
      makeRoutingEvent('orch-esc', 'developer', 'sonnet', { escalated: true }),
      makeRoutingEvent('orch-esc', 'reviewer', 'haiku'),
    ]);

    const { stdout, status } = run(['1'], historyDir);
    assert.equal(status, 0);
    assert.match(stdout, /developer:sonnet:esc/, 'escalated decision should have :esc suffix');
    // Non-escalated should NOT have :esc
    const reviewerLine = stdout.split('\n').find(l => l.includes('reviewer:'));
    assert.ok(reviewerLine, 'reviewer line not found');
    assert.ok(!reviewerLine.includes(':esc'), `reviewer line should not have :esc: ${reviewerLine}`);
  });

  test('orchestration with 0 routing_outcome events is skipped', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    // One orch with no routing events
    writeOrchHistory(historyDir, '20260101T000001Z-orch-empty', [
      makeOtherEvent('orchestration_start'),
      makeOtherEvent('agent_stop'),
    ]);

    const { stdout, status } = run(['5'], historyDir);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '', `output should be empty for no routing events, got: ${stdout}`);
  });

  test('mixed: orch with events and orch without → only events orch appears', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    writeOrchHistory(historyDir, '20260101T000001Z-orch-norouting', [
      makeOtherEvent('orchestration_start'),
    ]);

    const start = Date.now();
    while (Date.now() - start < 50) { /* spin */ }

    writeOrchHistory(historyDir, '20260101T000002Z-orch-withrouting', [
      makeRoutingEvent('orch-withrouting', 'developer', 'sonnet'),
    ]);

    const now = new Date();
    fs.utimesSync(path.join(historyDir, '20260101T000002Z-orch-withrouting'), now, now);

    const { stdout, status } = run(['5'], historyDir);
    assert.equal(status, 0);

    const orchBlocks = stdout.match(/^ORCH /gm) || [];
    assert.equal(orchBlocks.length, 1, `only one ORCH block expected, got: ${stdout}`);
    assert.match(stdout, /ORCH orch-withrouting/);
  });

  test('missing .orchestray/history/ → exit 0, empty stdout, stderr note (fail-open)', () => {
    const tmpDir = makeTmpDir();
    const nonExistentHistory = path.join(tmpDir, 'does-not-exist', 'history');

    const { stdout, stderr, status } = run([], nonExistentHistory);
    assert.equal(status, 0, 'should exit 0 when history dir is missing (fail-open)');
    assert.equal(stdout, '', 'stdout should be empty when history dir is missing');
    assert.match(stderr, /history directory not found|not found/i, 'stderr should note missing dir');
  });

  test('--save writes a reference file matching stdout', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    writeOrchHistory(historyDir, '20260101T000001Z-orch-save', [
      makeRoutingEvent('orch-save', 'developer', 'sonnet'),
    ]);

    const refFile = path.join(tmpDir, 'routing-reference.txt');

    // First run: capture stdout
    const run1 = run(['1'], historyDir);
    assert.equal(run1.status, 0);
    const expectedStdout = run1.stdout;

    // Second run: --save
    const run2 = run(['1', '--save', refFile], historyDir);
    assert.equal(run2.status, 0, `--save should exit 0, stderr: ${run2.stderr}`);
    assert.ok(fs.existsSync(refFile), 'reference file should be created');

    const saved = fs.readFileSync(refFile, 'utf8');
    assert.equal(saved, expectedStdout, 'saved file content should match stdout from plain run');
  });

  test('--compare with matching reference → exit 0', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    writeOrchHistory(historyDir, '20260101T000001Z-orch-compare-ok', [
      makeRoutingEvent('orch-compare-ok', 'developer', 'sonnet'),
      makeRoutingEvent('orch-compare-ok', 'reviewer', 'haiku'),
    ]);

    const refFile = path.join(tmpDir, 'ref-ok.txt');

    // Save first
    const saveRun = run(['1', '--save', refFile], historyDir);
    assert.equal(saveRun.status, 0);

    // Compare — should match
    const compareRun = run(['1', '--compare', refFile], historyDir);
    assert.equal(compareRun.status, 0, `--compare should exit 0 on match, stderr: ${compareRun.stderr}`);
    assert.match(compareRun.stderr, /match|OK/i, 'stderr should confirm match');
  });

  test('--compare with differing reference → exit 1', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    writeOrchHistory(historyDir, '20260101T000001Z-orch-diff', [
      makeRoutingEvent('orch-diff', 'developer', 'sonnet'),
    ]);

    // Write a stale reference with different content
    const refFile = path.join(tmpDir, 'ref-stale.txt');
    fs.writeFileSync(refFile, 'ORCH orch-old\n  architect:opus\n', 'utf8');

    const { stdout, stderr, status } = run(['1', '--compare', refFile], historyDir);
    assert.equal(status, 1, `--compare should exit 1 on mismatch, stdout: ${stdout}, stderr: ${stderr}`);
    assert.match(stderr, /differ|DIFFER/i, 'stderr should report difference');
  });

  test('default N=10: with 12 orchestrations only 10 appear in output', () => {
    const tmpDir = makeTmpDir();
    const historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    // Create 12 orchestrations with unique IDs
    for (let i = 1; i <= 12; i++) {
      const name = `20260101T${String(i).padStart(6, '0')}Z-orch-multi-${i}`;
      writeOrchHistory(historyDir, name, [
        makeRoutingEvent(`orch-multi-${i}`, 'developer', 'sonnet'),
      ]);
      // Stagger mtimes
      const t = new Date(Date.now() + i * 100);
      fs.utimesSync(path.join(historyDir, name), t, t);
    }

    const { stdout, status } = run([], historyDir); // default N=10
    assert.equal(status, 0);

    const orchBlocks = stdout.match(/^ORCH /gm) || [];
    assert.equal(orchBlocks.length, 10, `default N=10 should return 10 ORCH blocks, got ${orchBlocks.length}`);
  });

});
