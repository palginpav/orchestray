#!/usr/bin/env node
'use strict';

/**
 * Tests for W8 (UX3): bin/redo-wave-item.js
 *
 * Covers:
 *   - Unknown W-id → exit 1 with clear message.
 *   - Cascade closure: A→B, B→C, A→D → redo A with cascade → [A, B, C, D] (topo order).
 *   - Cascade depth limit: 15-chain, max_cascade_depth: 3 → closure capped with warning.
 *   - Confirmation prompt: y proceeds, N aborts, no-input defaults to N.
 *   - --dry-run: no redo.pending written, no events emitted.
 *   - Prompt override: --prompt=<file> → redo.pending includes prompt_override_file.
 *   - Canonical event shape for w_item_redo_requested.
 *   - config-schema: loadRedoFlowConfig returns defaults on missing/malformed config.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..');
const REDO_SCRIPT = path.join(REPO_ROOT, 'bin', 'redo-wave-item.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a temp project dir with .orchestray/state/ and an optional task-graph.
 * @param {object} opts
 * @param {string} [opts.graphText]  - Contents of task-graph.md
 * @param {string[]} [opts.wIds]     - W-ids to create stub task files for
 * @param {object|null} [opts.config] - config.json content for .orchestray/
 */
function makeProject({ graphText = '', wIds = [], config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w8-redo-test-'));
  cleanup.push(dir);

  const stateDir = path.join(dir, '.orchestray', 'state');
  const tasksDir = path.join(stateDir, 'tasks');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  if (graphText) {
    fs.writeFileSync(path.join(stateDir, 'task-graph.md'), graphText);
  }

  for (const wId of wIds) {
    fs.writeFileSync(
      path.join(tasksDir, wId + '.md'),
      `---\nw_id: ${wId}\nstatus: complete\n---\n`
    );
  }

  if (config !== null) {
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(config)
    );
  }

  return {
    dir,
    stateDir,
    tasksDir,
    auditDir,
    redoPendingPath: path.join(stateDir, 'redo.pending'),
    eventsPath: path.join(auditDir, 'events.jsonl'),
  };
}

/**
 * Run redo-wave-item.js with given args and optional stdin.
 * @param {string[]} args
 * @param {object} opts
 * @param {string} [opts.stdin]
 */
function run(args, { stdin = 'N\n' } = {}) {
  const result = spawnSync(process.execPath, [REDO_SCRIPT, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Read events.jsonl, return array of parsed objects.
 */
function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

/**
 * Build a task-graph.md with a chain: W1 → W2 → ... → WN (linear deps)
 * and optionally extra branches.
 */
function buildLinearGraph(length) {
  const lines = ['# Task Graph\n', '## Dependencies\n'];
  for (let i = 2; i <= length; i++) {
    lines.push(`- W${i} depends on W${i - 1}`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Tests: unknown W-id
// ---------------------------------------------------------------------------

describe('unknown W-id', () => {
  test('exits 1 with clear message when no state dir exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w8-nostate-'));
    cleanup.push(dir);

    const r = run(['W99', dir]);
    assert.strictEqual(r.status, 1, 'exits 1');
    assert.ok(
      r.stderr.includes('currently active orchestration') ||
      r.stderr.includes('Completed orchestrations'),
      'stderr explains the guard'
    );
  });

  test('exits 1 with clear message when state dir exists but W-id unknown', () => {
    const { dir } = makeProject({
      graphText: '# Task Graph\n## Dependencies\n- W2 depends on W1\n',
      wIds: ['W1', 'W2'],
    });

    const r = run(['W99', dir]);
    assert.strictEqual(r.status, 1, 'exits 1');
    assert.ok(
      r.stderr.includes('Unknown W-id') || r.stderr.includes('currently active'),
      'stderr mentions unknown W-id or orchestration guard'
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: cascade closure computation
// ---------------------------------------------------------------------------

describe('cascade closure computation', () => {
  test('A→B, B→C, A→D: redo A --cascade → closure [A, B, C, D] or [A, B, D, C]', () => {
    // A is depended on by B and D; B is depended on by C
    const graphText = [
      '# Task Graph',
      '## Dependencies',
      '- WB depends on WA',
      '- WC depends on WB',
      '- WD depends on WA',
    ].join('\n') + '\n';

    const { dir, redoPendingPath } = makeProject({
      graphText,
      wIds: ['WA', 'WB', 'WC', 'WD'],
    });

    const r = run(['WA', '--cascade', dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0, 'exits 0 on y');

    assert.ok(fs.existsSync(redoPendingPath), 'redo.pending was written');
    const pending = JSON.parse(fs.readFileSync(redoPendingPath, 'utf8'));
    assert.ok(Array.isArray(pending.w_ids), 'w_ids is array');

    // WA must be first
    assert.strictEqual(pending.w_ids[0], 'WA', 'WA is first in closure');
    // All 4 items must appear
    for (const id of ['WA', 'WB', 'WC', 'WD']) {
      assert.ok(pending.w_ids.includes(id), id + ' is in closure');
    }
    assert.strictEqual(pending.w_ids.length, 4, 'closure has exactly 4 items');

    // Topological ordering: WB and WD must come after WA; WC must come after WB
    const pos = (id) => pending.w_ids.indexOf(id);
    assert.ok(pos('WA') < pos('WB'), 'WA before WB');
    assert.ok(pos('WA') < pos('WD'), 'WA before WD');
    assert.ok(pos('WB') < pos('WC'), 'WB before WC');
  });

  test('no cascade: only the requested W-id in closure', () => {
    const graphText = '# Task Graph\n## Dependencies\n- WB depends on WA\n';
    const { dir, redoPendingPath } = makeProject({
      graphText,
      wIds: ['WA', 'WB'],
    });

    const r = run(['WA', dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(redoPendingPath), 'redo.pending written');
    const pending = JSON.parse(fs.readFileSync(redoPendingPath, 'utf8'));
    assert.deepStrictEqual(pending.w_ids, ['WA'], 'only WA in closure without --cascade');
  });
});

// ---------------------------------------------------------------------------
// Tests: cascade depth limit
// ---------------------------------------------------------------------------

describe('cascade depth limit', () => {
  test('15-long chain with max_cascade_depth:3 → closure capped with warning', () => {
    const graphText = buildLinearGraph(15);
    const { dir, redoPendingPath } = makeProject({
      graphText,
      wIds: Array.from({ length: 15 }, (_, i) => 'W' + (i + 1)),
      config: { redo_flow: { max_cascade_depth: 3 } },
    });

    const r = run(['W1', '--cascade', dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0, 'exits 0');

    // Warning about depth cap must appear in stdout
    assert.ok(
      r.stdout.includes('capped') || r.stdout.includes('Warning'),
      'warning about depth cap in stdout'
    );

    assert.ok(fs.existsSync(redoPendingPath), 'redo.pending written');
    const pending = JSON.parse(fs.readFileSync(redoPendingPath, 'utf8'));
    // Closure should be W1 + up to 3 levels of dependents (so ≤ 4 items total,
    // exact count depends on BFS cutoff at depth)
    assert.ok(pending.w_ids.length <= 4, 'closure size is ≤ max_cascade_depth + 1');
    assert.ok(pending.w_ids.length > 1, 'closure includes at least one dependent');
  });
});

// ---------------------------------------------------------------------------
// Tests: confirmation prompt
// ---------------------------------------------------------------------------

describe('confirmation prompt', () => {
  test('y confirms and writes redo.pending', () => {
    const { dir, redoPendingPath } = makeProject({ wIds: ['W1'] });
    const r = run(['W1', dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(redoPendingPath), 'redo.pending written on y');
  });

  test('N aborts and does NOT write redo.pending', () => {
    const { dir, redoPendingPath } = makeProject({ wIds: ['W1'] });
    const r = run(['W1', dir], { stdin: 'N\n' });
    assert.strictEqual(r.status, 0, 'exits 0 on N (clean abort)');
    assert.ok(!fs.existsSync(redoPendingPath), 'redo.pending NOT written on N');
    assert.ok(r.stdout.includes('aborted'), 'stdout says aborted');
  });

  test('empty input defaults to N (no redo.pending)', () => {
    const { dir, redoPendingPath } = makeProject({ wIds: ['W1'] });
    const r = run(['W1', dir], { stdin: '\n' });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(redoPendingPath), 'redo.pending NOT written on empty input');
  });

  test('non-y input defaults to N', () => {
    const { dir, redoPendingPath } = makeProject({ wIds: ['W1'] });
    const r = run(['W1', dir], { stdin: 'maybe\n' });
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(redoPendingPath), 'redo.pending NOT written on non-y input');
  });
});

// ---------------------------------------------------------------------------
// Tests: --dry-run
// ---------------------------------------------------------------------------

describe('--dry-run', () => {
  test('does not write redo.pending and emits no events', () => {
    const { dir, redoPendingPath, eventsPath } = makeProject({ wIds: ['W1'] });
    const r = run(['W1', '--dry-run', dir]);
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(redoPendingPath), 'redo.pending NOT written in dry-run');
    assert.ok(!fs.existsSync(eventsPath), 'events.jsonl NOT written in dry-run');
    assert.ok(r.stdout.includes('DRY RUN'), 'stdout says DRY RUN');
  });

  test('--dry-run with --cascade prints closure without writing files', () => {
    const graphText = '# Graph\n## Dependencies\n- W2 depends on W1\n- W3 depends on W2\n';
    const { dir, redoPendingPath } = makeProject({ graphText, wIds: ['W1', 'W2', 'W3'] });

    const r = run(['W1', '--cascade', '--dry-run', dir]);
    assert.strictEqual(r.status, 0);
    assert.ok(!fs.existsSync(redoPendingPath), 'no redo.pending in dry-run');
    assert.ok(r.stdout.includes('DRY RUN'), 'dry run label');
    // Should mention dependents
    assert.ok(r.stdout.includes('W2') || r.stdout.includes('dependent'), 'mentions dependents');
  });
});

// ---------------------------------------------------------------------------
// Tests: prompt override
// ---------------------------------------------------------------------------

describe('prompt override', () => {
  test('--prompt=<file> is stored in redo.pending', () => {
    const { dir, redoPendingPath } = makeProject({ wIds: ['W1'] });

    // Create a temp override file
    const overrideTmp = path.join(os.tmpdir(), 'redo-override-test-' + Date.now() + '.txt');
    fs.writeFileSync(overrideTmp, 'Focus only on the auth module');
    cleanup.push(overrideTmp);

    const r = run(['W1', '--prompt=' + overrideTmp, dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0);
    assert.ok(fs.existsSync(redoPendingPath), 'redo.pending written');
    const pending = JSON.parse(fs.readFileSync(redoPendingPath, 'utf8'));
    assert.strictEqual(pending.prompt_override_file, overrideTmp, 'override file path stored');
  });

  test('no --prompt flag → prompt_override_file is null in redo.pending', () => {
    const { dir, redoPendingPath } = makeProject({ wIds: ['W1'] });
    const r = run(['W1', dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0);
    const pending = JSON.parse(fs.readFileSync(redoPendingPath, 'utf8'));
    assert.strictEqual(pending.prompt_override_file, null, 'no override → null');
  });
});

// ---------------------------------------------------------------------------
// Tests: w_item_redo_requested event shape
// ---------------------------------------------------------------------------

describe('w_item_redo_requested event', () => {
  test('event has canonical timestamp/type shape', () => {
    const { dir, eventsPath } = makeProject({ wIds: ['W1'] });
    const r = run(['W1', dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0);

    const events = readEvents(eventsPath);
    assert.ok(events.length >= 1, 'at least one event emitted');
    const evt = events.find(e => e.type === 'w_item_redo_requested');
    assert.ok(evt, 'w_item_redo_requested event present');
    assert.strictEqual(typeof evt.timestamp, 'string', 'timestamp is a string');
    assert.ok(evt.timestamp.includes('T'), 'timestamp is ISO 8601');
    assert.strictEqual(evt.w_id, 'W1', 'w_id matches requested W-id');
    assert.strictEqual(typeof evt.cascade, 'boolean', 'cascade is boolean');
    assert.strictEqual(typeof evt.dry_run, 'boolean', 'dry_run is boolean');
    assert.ok('prompt_override_file' in evt, 'prompt_override_file field present');
  });

  test('cascade emits one event per W-id in closure', () => {
    const graphText = '# Graph\n## Dependencies\n- W2 depends on W1\n';
    const { dir, eventsPath } = makeProject({ graphText, wIds: ['W1', 'W2'] });

    const r = run(['W1', '--cascade', dir], { stdin: 'y\n' });
    assert.strictEqual(r.status, 0);

    const events = readEvents(eventsPath);
    const redoEvents = events.filter(e => e.type === 'w_item_redo_requested');
    assert.strictEqual(redoEvents.length, 2, 'one event per W-id in closure');

    const wIds = redoEvents.map(e => e.w_id);
    assert.ok(wIds.includes('W1'), 'W1 event present');
    assert.ok(wIds.includes('W2'), 'W2 event present');
  });
});

// ---------------------------------------------------------------------------
// Tests: config-schema loadRedoFlowConfig
// ---------------------------------------------------------------------------

describe('config-schema: loadRedoFlowConfig', () => {
  const { loadRedoFlowConfig, DEFAULT_REDO_FLOW } = require('../bin/_lib/config-schema');

  test('returns defaults when config.json is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-schema-test-'));
    cleanup.push(dir);
    const cfg = loadRedoFlowConfig(dir);
    assert.strictEqual(cfg.max_cascade_depth, DEFAULT_REDO_FLOW.max_cascade_depth);
    assert.strictEqual(cfg.commit_prefix, DEFAULT_REDO_FLOW.commit_prefix);
  });

  test('returns defaults when config.json has no redo_flow block', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-schema-test-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), JSON.stringify({ audit: {} }));
    const cfg = loadRedoFlowConfig(dir);
    assert.strictEqual(cfg.max_cascade_depth, DEFAULT_REDO_FLOW.max_cascade_depth);
  });

  test('returns defaults when config.json is malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-schema-test-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), '{invalid json}');
    const cfg = loadRedoFlowConfig(dir);
    assert.strictEqual(cfg.max_cascade_depth, DEFAULT_REDO_FLOW.max_cascade_depth);
  });

  test('reads custom max_cascade_depth and commit_prefix', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-schema-test-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ redo_flow: { max_cascade_depth: 5, commit_prefix: 'retry' } })
    );
    const cfg = loadRedoFlowConfig(dir);
    assert.strictEqual(cfg.max_cascade_depth, 5);
    assert.strictEqual(cfg.commit_prefix, 'retry');
  });

  test('clamps out-of-range max_cascade_depth to default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-schema-test-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ redo_flow: { max_cascade_depth: 9999 } })
    );
    const cfg = loadRedoFlowConfig(dir);
    assert.strictEqual(cfg.max_cascade_depth, DEFAULT_REDO_FLOW.max_cascade_depth,
      'out-of-range value falls back to default');
  });
});
