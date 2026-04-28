#!/usr/bin/env node
'use strict';

/**
 * v229-pm-emit-state-watcher.test.js — B-8 acceptance test.
 *
 * Anti-regression contract:
 *   1. Edit on a watched state file WITHOUT a paired PM emit in same turn
 *      → backstop emit fires + `pm_emit_backstop_engaged` row.
 *   2. Edit on a watched file WITH a paired PM emit in same turn
 *      → no backstop, no extra event.
 *   3. Edit on an unwatched file → no watcher activity.
 *   4. After a heavy backstop ratio at orch close,
 *      `audit-pm-emit-coverage.js` emits `pm_emit_prose_rotting` with
 *      `ratio > 0.5`.
 *   5. Kill switch (`ORCHESTRAY_PM_EMIT_WATCHER_DISABLED=1`) silences both
 *      the watcher and the coverage tail.
 *
 * Runner: node --test bin/__tests__/v229-pm-emit-state-watcher.test.js
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WATCHER   = path.join(REPO_ROOT, 'bin', 'pm-emit-state-watcher.js');
const COVERAGE  = path.join(REPO_ROOT, 'bin', 'audit-pm-emit-coverage.js');

const ORCH_ID = 'orch-20260428T180000Z-b8-test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b8-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'),  { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'),   { recursive: true });

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
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

function appendEvent(dir, evt) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  fs.appendFileSync(p, JSON.stringify(evt) + '\n', 'utf8');
}

function runWatcher(dir, payload, env = {}) {
  return spawnSync('node', [WATCHER], {
    cwd: dir,
    env: { ...process.env, ...env },
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 8000,
  });
}

function runCoverage(dir, env = {}) {
  return spawnSync('node', [COVERAGE], {
    cwd: dir,
    env: { ...process.env, ...env },
    input: JSON.stringify({ cwd: dir, hook_event_name: 'Stop' }),
    encoding: 'utf8',
    timeout: 8000,
  });
}

function makeEditPayload(dir, relPath, opts = {}) {
  return {
    cwd:             dir,
    hook_event_name: 'PostToolUse',
    tool_name:       opts.tool || 'Edit',
    tool_input: {
      file_path:  path.join(dir, relPath),
      ...(opts.toolInputExtra || {}),
    },
    tool_response: { success: true },
    session_id:    opts.sessionId || 'test-sess-1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.9 B-8 — pm-emit-state-watcher', () => {

  test('case 1: Edit on watched state file (kb/decisions) WITHOUT paired PM emit fires backstop + pm_emit_backstop_engaged', () => {
    const dir = makeRepo();

    // Mutate the state file as if PM had written it.
    const decisionPath = path.join(dir, '.orchestray', 'kb', 'decisions', 'D-001.md');
    fs.writeFileSync(decisionPath, '# Decision 001\n\nInvariant: foo\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/kb/decisions/D-001.md'));
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const backstop = events.filter(e => e.type === 'tier2_invoked' && e.source === 'state_watcher_backstop');
    const engaged  = events.filter(e => e.type === 'pm_emit_backstop_engaged');

    assert.equal(backstop.length, 1, 'must emit exactly one backstop tier2_invoked row');
    assert.equal(backstop[0].protocol, 'drift_sentinel');
    assert.equal(backstop[0].original_state_file, '.orchestray/kb/decisions/D-001.md');
    assert.equal(typeof backstop[0].mutated_at, 'string');

    assert.equal(engaged.length, 1, 'must emit exactly one pm_emit_backstop_engaged row');
    assert.equal(engaged[0].original_event_type, 'tier2_invoked');
    assert.equal(engaged[0].finding_ref, 'F-PM-7');
  });

  test('case 2: PM emits the event itself within the recent window → no backstop fires', () => {
    const dir = makeRepo();

    // Pre-populate live audit log with a PM-emitted tier2_invoked row,
    // timestamped now so it's inside the 30-s recent-emit window.
    const nowIso = new Date().toISOString();
    appendEvent(dir, {
      version:          1,
      type:             'tier2_invoked',
      timestamp:        nowIso,
      orchestration_id: ORCH_ID,
      protocol:         'drift_sentinel',
      trigger_signal:   'enable_drift_sentinel true; architect completed',
    });

    // Now mutate the state file (PM has already done its job).
    const decisionPath = path.join(dir, '.orchestray', 'kb', 'decisions', 'D-002.md');
    fs.writeFileSync(decisionPath, '# Decision 002\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/kb/decisions/D-002.md'));
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const backstop = events.filter(e => e.type === 'tier2_invoked' && e.source === 'state_watcher_backstop');
    const engaged  = events.filter(e => e.type === 'pm_emit_backstop_engaged');

    assert.equal(backstop.length, 0, 'must NOT emit a backstop row when PM already did');
    assert.equal(engaged.length,  0, 'must NOT engage when PM emit is paired');

    // Sanity: original PM emit still in the log.
    const all = events.filter(e => e.type === 'tier2_invoked');
    assert.equal(all.length, 1, 'PM emit is the only tier2_invoked row');
  });

  test('case 3: Edit on an unwatched file → no watcher activity at all', () => {
    const dir = makeRepo();

    // Mutate something the watcher does not care about.
    const irrelevant = path.join(dir, 'README.md');
    fs.writeFileSync(irrelevant, '# Hello\n');

    const r = runWatcher(dir, makeEditPayload(dir, 'README.md'));
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    assert.equal(events.length, 0, 'no events must be appended for unwatched paths');

    // Last-seen file must not have grown an entry for the irrelevant path.
    const lastSeenPath = path.join(dir, '.orchestray', 'state', 'pm-emit-watcher.last-seen.json');
    if (fs.existsSync(lastSeenPath)) {
      const seen = JSON.parse(fs.readFileSync(lastSeenPath, 'utf8'));
      assert.ok(!('README.md' in seen), 'README.md must not be tracked');
    }
  });

  test('case 4: heavy backstop ratio → audit-pm-emit-coverage emits pm_emit_prose_rotting at orch close', () => {
    const dir = makeRepo();

    // Fabricate the orchestration's event log: 8 backstop emits + 2 PM emits
    // for tier2_invoked (ratio 0.8). Below threshold for the others.
    const baseIso = '2026-04-28T18:00:00.000Z';
    for (let i = 0; i < 8; i++) {
      appendEvent(dir, {
        version:             1,
        type:                'tier2_invoked',
        timestamp:           baseIso,
        orchestration_id:    ORCH_ID,
        protocol:            'drift_sentinel',
        trigger_signal:      'state_watcher_backstop:.orchestray/kb/decisions/D-N.md',
        source:              'state_watcher_backstop',
        original_state_file: '.orchestray/kb/decisions/D-N.md',
        mutated_at:          baseIso,
      });
    }
    for (let i = 0; i < 2; i++) {
      appendEvent(dir, {
        version:          1,
        type:             'tier2_invoked',
        timestamp:        baseIso,
        orchestration_id: ORCH_ID,
        protocol:         'drift_sentinel',
        trigger_signal:   'pm-prose emit',
      });
    }

    const r = runCoverage(dir);
    assert.equal(r.status, 0, `coverage exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const rotting = events.filter(e => e.type === 'pm_emit_prose_rotting');
    assert.equal(rotting.length, 1, 'exactly one pm_emit_prose_rotting must be emitted for tier2_invoked');
    assert.equal(rotting[0].event_type, 'tier2_invoked');
    assert.equal(rotting[0].pm_count,        2);
    assert.equal(rotting[0].backstop_count,  8);
    assert.ok(rotting[0].ratio > 0.5,  `ratio must exceed 0.5 (got ${rotting[0].ratio})`);
    assert.ok(rotting[0].ratio < 0.9,  `ratio must be < 0.9 (got ${rotting[0].ratio})`);
  });

  test('case 5: kill switch silences both watcher and coverage tail', () => {
    const dir = makeRepo();

    // Edit a watched file with kill switch on — must NOT emit backstop.
    const decisionPath = path.join(dir, '.orchestray', 'kb', 'decisions', 'D-003.md');
    fs.writeFileSync(decisionPath, '# Decision\n');

    const r1 = runWatcher(
      dir,
      makeEditPayload(dir, '.orchestray/kb/decisions/D-003.md'),
      { ORCHESTRAY_PM_EMIT_WATCHER_DISABLED: '1' },
    );
    assert.equal(r1.status, 0);

    // Pre-populate a heavy backstop ratio in the live log so coverage WOULD
    // alarm without the kill switch.
    const baseIso = '2026-04-28T18:00:00.000Z';
    for (let i = 0; i < 5; i++) {
      appendEvent(dir, {
        version:             1,
        type:                'consequence_forecast',
        timestamp:           baseIso,
        orchestration_id:    ORCH_ID,
        predictions:         [],
        accuracy:            { total: 0, addressed: 0, missed: 0, wrong: 0 },
        source:              'state_watcher_backstop',
        original_state_file: '.orchestray/state/consequences.md',
        mutated_at:          baseIso,
      });
    }

    const r2 = runCoverage(dir, { ORCHESTRAY_PM_EMIT_WATCHER_DISABLED: '1' });
    assert.equal(r2.status, 0);

    const events = readEvents(dir);
    const backstop = events.filter(e => e.type === 'consequence_forecast' && e.source === 'state_watcher_backstop' && e.original_state_file === '.orchestray/kb/decisions/D-003.md');
    assert.equal(backstop.length, 0, 'kill switch must prevent watcher emit');
    const rotting = events.filter(e => e.type === 'pm_emit_prose_rotting');
    assert.equal(rotting.length, 0, 'kill switch must prevent coverage emit');
  });

  test('bonus: roi-snapshot.json write fires backstop pattern_roi_snapshot with derived patterns_scanned', () => {
    const dir = makeRepo();
    const roiPath = path.join(dir, '.orchestray', 'patterns', 'roi-snapshot.json');
    fs.writeFileSync(roiPath, JSON.stringify({
      window_days: 30,
      patterns: [{ slug: 'p-a' }, { slug: 'p-b' }, { slug: 'p-c' }],
      top_roi: ['p-a', 'p-b'],
      bottom_roi: ['p-c'],
    }));

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/patterns/roi-snapshot.json', { tool: 'Write' }));
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const backstop = events.filter(e => e.type === 'pattern_roi_snapshot' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1);
    assert.equal(backstop[0].patterns_scanned, 3);
    assert.equal(backstop[0].artefact_path, '.orchestray/patterns/roi-snapshot.json');
    assert.deepEqual(backstop[0].top_roi, ['p-a', 'p-b']);
  });

  test('bonus: state/tasks/<id>.md with verify_fix.round_history fires backstop verify_fix_start with synthesised round/error_count', () => {
    const dir = makeRepo();
    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-7.md');
    fs.writeFileSync(taskFile, [
      '---',
      'task_id: task-7',
      'verify_fix:',
      '  rounds_completed: 2',
      '  max_rounds: 3',
      '  round_history:',
      '    - round: 1',
      '      reviewer_issues: 4',
      '    - round: 2',
      '      reviewer_issues: 1',
      '  status: in_progress',
      '---',
    ].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-7.md'));
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const backstop = events.filter(e => e.type === 'verify_fix_start' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1);
    assert.equal(backstop[0].task_id,     'task-7');
    assert.equal(backstop[0].round,       2);
    assert.equal(backstop[0].error_count, 1);
  });

  test('bonus: state/tasks/<id>.md WITHOUT verify_fix block → no backstop', () => {
    const dir = makeRepo();
    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-99.md');
    fs.writeFileSync(taskFile, '---\ntask_id: task-99\nstatus: pending\n---\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-99.md'));
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const backstop = events.filter(e => e.type === 'verify_fix_start' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 0, 'task file with no verify_fix block must not fire backstop');
  });

  test('bonus: consequences.md write fires backstop consequence_forecast with parsed predictions', () => {
    const dir = makeRepo();
    const cFile = path.join(dir, '.orchestray', 'state', 'consequences.md');
    fs.writeFileSync(cFile, [
      '---',
      'orchestration_id: ' + ORCH_ID,
      '---',
      '',
      '## Consequence Predictions',
      '',
      '- [direct] src/auth.ts — return type change may break callers',
      '- [test] tests/auth.test.ts — test assertions may break',
      '- [convention] src/payment.ts — same pattern as auth.ts',
      '',
    ].join('\n'));

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/consequences.md', { tool: 'Write' }));
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    const backstop = events.filter(e => e.type === 'consequence_forecast' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1);
    assert.equal(backstop[0].predictions.length, 3);
    assert.equal(backstop[0].accuracy.total, 3);
    assert.equal(backstop[0].predictions[0].category, 'direct');
    assert.equal(backstop[0].predictions[0].target_file, 'src/auth.ts');
  });
});
