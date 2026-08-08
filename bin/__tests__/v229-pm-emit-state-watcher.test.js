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

// ---------------------------------------------------------------------------
// v2.3.19 dark-event-triage item 2: verify_fix_pass/fail were shadowed by
// task_verify_fix_round (both targets matched every state/tasks/*.md write;
// WATCH_TARGETS.find() only ever ran the FIRST match, so the B1 target below
// was dead code since v2.2.10 despite passing its own isolated unit tests).
// ---------------------------------------------------------------------------

describe('v2.3.19 item 2 — verify_fix_pass/fail no longer shadowed', () => {
  test('status: resolved on a round_history-bearing file fires BOTH verify_fix_start AND verify_fix_pass', () => {
    const dir = makeRepo();
    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-9.md');
    fs.writeFileSync(taskFile, [
      '---',
      'task_id: task-9',
      'verify_fix:',
      '  rounds_completed: 2',
      '  max_rounds: 3',
      '  round_history:',
      '    - round: 1',
      '      reviewer_issues: 4',
      '    - round: 2',
      '      reviewer_issues: 0',
      '  status: resolved',
      '---',
    ].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-9.md'));
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const startEvt = events.filter(e => e.type === 'verify_fix_start' && e.source === 'state_watcher_backstop');
    const passEvt  = events.filter(e => e.type === 'verify_fix_pass'  && e.source === 'state_watcher_backstop');

    assert.equal(startEvt.length, 1, 'round_history append must still backstop verify_fix_start');
    assert.equal(passEvt.length, 1, 'status: resolved must ALSO backstop verify_fix_pass (was shadowed pre-fix — 0/0 on unpatched code)');
    assert.equal(passEvt[0].task_id, 'task-9');
    assert.equal(passEvt[0].round, 2);
    assert.equal(passEvt[0].rounds_total, 2);
  });

  test('status: escalated fires verify_fix_fail', () => {
    const dir = makeRepo();
    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-10.md');
    fs.writeFileSync(taskFile, [
      '---',
      'task_id: task-10',
      'verify_fix:',
      '  rounds_completed: 3',
      '  max_rounds: 3',
      '  round_history:',
      '    - round: 1',
      '      reviewer_issues: 3',
      '    - round: 2',
      '      reviewer_issues: 2',
      '    - round: 3',
      '      reviewer_issues: 2',
      '  status: escalated',
      '---',
    ].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-10.md'));
    assert.equal(r.status, 0);

    const events  = readEvents(dir);
    const failEvt = events.filter(e => e.type === 'verify_fix_fail' && e.source === 'state_watcher_backstop');
    assert.equal(failEvt.length, 1, 'status: escalated must backstop verify_fix_fail (was shadowed pre-fix)');
    assert.equal(failEvt[0].task_id, 'task-10');
    assert.equal(failEvt[0].round, 3);
    assert.equal(failEvt[0].remaining_errors, 2);
  });

  test('PM-emitted verify_fix_pass within the recent window suppresses the backstop (pairing window still respected)', () => {
    const dir = makeRepo();
    const nowIso = new Date().toISOString();
    appendEvent(dir, {
      version: 1, type: 'verify_fix_pass', timestamp: nowIso, orchestration_id: ORCH_ID,
      task_id: 'task-11', round: 1, rounds_total: 1,
    });

    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-11.md');
    fs.writeFileSync(taskFile, [
      '---',
      'task_id: task-11',
      'verify_fix:',
      '  rounds_completed: 1',
      '  max_rounds: 3',
      '  round_history:',
      '    - round: 1',
      '      reviewer_issues: 0',
      '  status: resolved',
      '---',
    ].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-11.md'));
    assert.equal(r.status, 0);

    const events  = readEvents(dir);
    const passEvt = events.filter(e => e.type === 'verify_fix_pass' && e.source === 'state_watcher_backstop');
    assert.equal(passEvt.length, 0, 'PM already emitted verify_fix_pass → no backstop');
  });
});

// ---------------------------------------------------------------------------
// v2.3.19 dark-event-triage item 1: replan — PM-prose-only manual emit
// (phase-verify.md §16 step 5), confirmed 0 emits ever.
// ---------------------------------------------------------------------------

describe('v2.3.19 item 1 — replan backstop', () => {
  test('orchestration.md replan_count: 1 fires a replan backstop', () => {
    const dir = makeRepo();
    const orchFile = path.join(dir, '.orchestray', 'state', 'orchestration.md');
    fs.writeFileSync(orchFile, [
      '---',
      'orchestration_id: ' + ORCH_ID,
      'phase: verify',
      'replan_count: 1',
      '---',
    ].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/orchestration.md'));
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events    = readEvents(dir);
    const backstop  = events.filter(e => e.type === 'replan' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1, 'replan_count: 1 must fire exactly one replan backstop');
    assert.equal(backstop[0].reason, 'state_watcher_backstop');
    assert.equal(backstop[0].old_task_count, 0);
    assert.equal(typeof backstop[0].new_task_count, 'number');
    assert.deepEqual(backstop[0].tasks_invalidated, []);
  });

  test('a second replan (replan_count 1 -> 2) fires a second, distinct backstop; unchanged count does not re-fire', () => {
    const dir = makeRepo();
    const orchFile = path.join(dir, '.orchestray', 'state', 'orchestration.md');

    fs.writeFileSync(orchFile, ['---', 'orchestration_id: ' + ORCH_ID, 'replan_count: 1', '---'].join('\n') + '\n');
    assert.equal(runWatcher(dir, makeEditPayload(dir, '.orchestray/state/orchestration.md')).status, 0);

    // Re-write with the SAME count — must NOT re-fire.
    assert.equal(runWatcher(dir, makeEditPayload(dir, '.orchestray/state/orchestration.md')).status, 0);

    fs.writeFileSync(orchFile, ['---', 'orchestration_id: ' + ORCH_ID, 'replan_count: 2', '---'].join('\n') + '\n');
    assert.equal(runWatcher(dir, makeEditPayload(dir, '.orchestray/state/orchestration.md')).status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'replan' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 2, 'two distinct replan_count increases must fire two backstops, not suppressed by dedup');
  });

  test('ordinary orchestration.md edit without a replan_count field → no backstop', () => {
    const dir = makeRepo();
    const orchFile = path.join(dir, '.orchestray', 'state', 'orchestration.md');
    fs.writeFileSync(orchFile, ['---', 'orchestration_id: ' + ORCH_ID, 'phase: execute', '---'].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/orchestration.md'));
    assert.equal(r.status, 0);

    const events = readEvents(dir);
    assert.equal(events.filter(e => e.type === 'replan').length, 0, 'no replan_count field means no replan signal');
  });

  test('PM emits replan itself within the recent window → no backstop', () => {
    const dir = makeRepo();
    const nowIso = new Date().toISOString();
    appendEvent(dir, {
      version: 1, type: 'replan', timestamp: nowIso, orchestration_id: ORCH_ID,
      reason: 'scope_expansion', old_task_count: 3, new_task_count: 5, tasks_invalidated: [],
    });

    const orchFile = path.join(dir, '.orchestray', 'state', 'orchestration.md');
    fs.writeFileSync(orchFile, ['---', 'orchestration_id: ' + ORCH_ID, 'replan_count: 1', '---'].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/orchestration.md'));
    assert.equal(r.status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'replan' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 0, 'PM already emitted replan → no backstop');
  });
});

// ---------------------------------------------------------------------------
// v2.3.20 item 1: verify_fix_oscillation — PM-prose-only manual emit
// (phase-verify.md §"Regression Prevention"), confirmed 0 emits ever.
// ---------------------------------------------------------------------------

describe('v2.3.20 item 1 — verify_fix_oscillation backstop', () => {
  test('round 2 errors >= round 1 errors fires a verify_fix_oscillation backstop', () => {
    const dir = makeRepo();
    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-20.md');
    fs.writeFileSync(taskFile, [
      '---',
      'task_id: task-20',
      'verify_fix:',
      '  rounds_completed: 2',
      '  max_rounds: 3',
      '  round_history:',
      '    - round: 1',
      '      reviewer_issues: 2',
      '    - round: 2',
      '      reviewer_issues: 3',
      '  status: in_progress',
      '---',
    ].join('\n') + '\n');

    // Unpatched code has no oscillation target — this assertion fails without the fix.
    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-20.md'));
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'verify_fix_oscillation' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1, 'non-decreasing error count round-over-round must fire the oscillation backstop');
    assert.equal(backstop[0].task_id, 'task-20');
    assert.equal(backstop[0].round, 2);
    assert.equal(backstop[0].errors_current, 3);
    assert.equal(backstop[0].errors_previous, 2);
  });

  test('round 2 errors < round 1 errors (normal convergence) → no oscillation backstop', () => {
    const dir = makeRepo();
    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-21.md');
    fs.writeFileSync(taskFile, [
      '---',
      'task_id: task-21',
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

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-21.md'));
    assert.equal(r.status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'verify_fix_oscillation' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 0, 'decreasing error count must NOT fire oscillation');
  });

  test('PM-emitted verify_fix_oscillation within the recent window suppresses the backstop', () => {
    const dir = makeRepo();
    const nowIso = new Date().toISOString();
    appendEvent(dir, {
      version: 1, type: 'verify_fix_oscillation', timestamp: nowIso, orchestration_id: ORCH_ID,
      task_id: 'task-22', round: 2, errors_current: 3, errors_previous: 2,
    });

    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-22.md');
    fs.writeFileSync(taskFile, [
      '---',
      'task_id: task-22',
      'verify_fix:',
      '  rounds_completed: 2',
      '  max_rounds: 3',
      '  round_history:',
      '    - round: 1',
      '      reviewer_issues: 2',
      '    - round: 2',
      '      reviewer_issues: 3',
      '  status: in_progress',
      '---',
    ].join('\n') + '\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-22.md'));
    assert.equal(r.status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'verify_fix_oscillation' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 0, 'PM already emitted verify_fix_oscillation → no backstop');
  });

  test('a NEW oscillating round re-fires a second, distinct backstop', () => {
    const dir = makeRepo();
    const taskFile = path.join(dir, '.orchestray', 'state', 'tasks', 'task-23.md');

    fs.writeFileSync(taskFile, [
      '---', 'task_id: task-23', 'verify_fix:', '  round_history:',
      '    - round: 1', '      reviewer_issues: 2',
      '    - round: 2', '      reviewer_issues: 2',
      '  status: in_progress', '---',
    ].join('\n') + '\n');
    assert.equal(runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-23.md')).status, 0);

    fs.writeFileSync(taskFile, [
      '---', 'task_id: task-23', 'verify_fix:', '  round_history:',
      '    - round: 1', '      reviewer_issues: 2',
      '    - round: 2', '      reviewer_issues: 2',
      '    - round: 3', '      reviewer_issues: 2',
      '  status: in_progress', '---',
    ].join('\n') + '\n');
    assert.equal(runWatcher(dir, makeEditPayload(dir, '.orchestray/state/tasks/task-23.md')).status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'verify_fix_oscillation' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 2, 'two distinct oscillating rounds must fire two backstops, not suppressed by dedup');
    assert.deepEqual(backstop.map(b => b.round), [2, 3]);
  });
});

// ---------------------------------------------------------------------------
// v2.3.21 item 1: state_cancel_aborted — PM-prose-only manual emit
// (tier1-orchestration-rare.md §"Cancel" step 3), confirmed 0 emits ever.
// Unlike the other backstops, the trigger is a Bash `mv`, not an Edit/Write,
// so it's exercised via the coverage script's orch-close fan-out, not the
// watcher's Edit/Write hook.
// ---------------------------------------------------------------------------

describe('v2.3.21 item 1 — state_cancel_aborted backstop', () => {
  test('archived cancelled dir exists with no state_cancel_aborted in the audit log → backstop fires', () => {
    // Realistic fixture: NO events.jsonl is written inside archivedDir — nothing
    // in the codebase ever puts one there (audit events live in the sibling
    // .orchestray/audit/ dir, untouched by the cancel `mv`). checkOrchRoiPresence
    // runs earlier in the same orch-close fan-out and, finding no orchestration_roi
    // row, writes orchestration_roi_missing to the LIVE audit log first — so by
    // the time checkStateCancelCompleteness runs, the live log genuinely exists.
    const dir = makeRepo();
    const archivedDir = path.join(dir, '.orchestray', 'history', 'orch-' + ORCH_ID + '-cancelled');
    fs.mkdirSync(archivedDir, { recursive: true });

    const r = runCoverage(dir);
    assert.equal(r.status, 0, `coverage exit=${r.status} stderr=${r.stderr}`);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1, 'archived-dir ground truth without a matching audit row must fire exactly one backstop');
    assert.equal(backstop[0].orchestration_id, ORCH_ID);
    assert.equal(backstop[0].archived_to, '.orchestray/history/orch-' + ORCH_ID + '-cancelled');
    // E1 regression: events_jsonl_preserved must derive from the LIVE audit log
    // (which genuinely exists here — checkOrchRoiPresence just wrote to it), not
    // from archivedDir/events.jsonl (which no code path ever creates — that check
    // reported constant-false on every real cancellation before the fix).
    assert.equal(backstop[0].events_jsonl_preserved, true);
    // Defect 1: every sibling emit in this file stamps version:1 explicitly
    // (grep confirms 20/20 other writeEvent calls do); state_cancel_aborted
    // was the lone exception, a schema-conformance gap on a never-fired event.
    assert.equal(backstop[0].version, 1, 'state_cancel_aborted must carry version:1 like every sibling emit');
  });

  test('defect 2 pin: archived_to keeps the doubled orch- prefix — collapsing it on either side would break discovery', () => {
    // orchId already starts with "orch-" per bin/ox.js, and the PM's own
    // clean-abort prose (tier1-orchestration-rare.md step 2) literally
    // substitutes the full orchId into ".orchestray/history/orch-<id>-cancelled/",
    // so both the writer (PM's manual mv) and the reader (this check) agree on
    // the doubled "orch-orch-..." form. This is NOT a bug — do not "fix" it.
    const dir = makeRepo();
    const doubledDir = path.join(dir, '.orchestray', 'history', 'orch-' + ORCH_ID + '-cancelled');
    fs.mkdirSync(doubledDir, { recursive: true });

    const r = runCoverage(dir);
    assert.equal(r.status, 0);
    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1, 'the real (doubled-prefix) archive dir must be discovered');
    assert.equal(backstop[0].archived_to, '.orchestray/history/orch-' + ORCH_ID + '-cancelled');

    // Negative control: a "corrected" single-prefix dir (what a well-meaning
    // fix might rename it to) is a DIFFERENT path the check does not look for.
    // Demonstrates that collapsing the prefix on one side silently breaks
    // discovery rather than "fixing" anything.
    const dir2 = makeRepo();
    const singlePrefixDir = path.join(dir2, '.orchestray', 'history', ORCH_ID + '-cancelled');
    fs.mkdirSync(singlePrefixDir, { recursive: true });
    const r2 = runCoverage(dir2);
    assert.equal(r2.status, 0);
    const backstop2 = readEvents(dir2).filter(e => e.type === 'state_cancel_aborted');
    assert.equal(backstop2.length, 0, 'single-prefix dir is invisible to the check — proves the doubling is load-bearing');
  });

  test('E1 regression: live audit log absent at check time → events_jsonl_preserved is honestly false, not hardcoded', () => {
    // Disable the ROI watcher so nothing writes to the live audit log ahead of
    // checkStateCancelCompleteness — isolates the field's derivation from
    // fs.existsSync(livePath) rather than any other fan-out step's side effect.
    const dir = makeRepo();
    const archivedDir = path.join(dir, '.orchestray', 'history', 'orch-' + ORCH_ID + '-cancelled');
    fs.mkdirSync(archivedDir, { recursive: true });

    const r = runCoverage(dir, { ORCHESTRAY_ROI_WATCHED_DISABLED: '1' });
    assert.equal(r.status, 0, `coverage exit=${r.status} stderr=${r.stderr}`);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1);
    assert.equal(backstop[0].events_jsonl_preserved, false, 'no live audit log existed yet — must not manufacture true');
  });

  test('archived cancelled dir exists AND PM already emitted state_cancel_aborted → no backstop', () => {
    const dir = makeRepo();
    const archivedDir = path.join(dir, '.orchestray', 'history', 'orch-' + ORCH_ID + '-cancelled');
    fs.mkdirSync(archivedDir, { recursive: true });

    appendEvent(dir, {
      version: 1, type: 'state_cancel_aborted', timestamp: new Date().toISOString(),
      orchestration_id: ORCH_ID,
      archived_to: '.orchestray/history/orch-' + ORCH_ID + '-cancelled',
      events_jsonl_preserved: true,
    });

    const r = runCoverage(dir);
    assert.equal(r.status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 0, 'PM already emitted state_cancel_aborted → no backstop');
    // Idempotency: a second coverage run must not double-emit either.
    assert.equal(runCoverage(dir).status, 0);
    const eventsAgain = readEvents(dir).filter(e => e.type === 'state_cancel_aborted');
    assert.equal(eventsAgain.length, 1, 'only the one PM-emitted row exists after a second run');
  });

  test('no cancelled dir on disk (orchestration never cancelled) → no backstop', () => {
    const dir = makeRepo();

    const r = runCoverage(dir);
    assert.equal(r.status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'state_cancel_aborted');
    assert.equal(backstop.length, 0, 'no archived-cancelled dir means the abort sequence never ran');
  });

  test('kill switch (ORCHESTRAY_CANCEL_ABORT_WATCHER_DISABLED) silences the backstop', () => {
    const dir = makeRepo();
    const archivedDir = path.join(dir, '.orchestray', 'history', 'orch-' + ORCH_ID + '-cancelled');
    fs.mkdirSync(archivedDir, { recursive: true });

    const r = runCoverage(dir, { ORCHESTRAY_CANCEL_ABORT_WATCHER_DISABLED: '1' });
    assert.equal(r.status, 0);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'state_cancel_aborted');
    assert.equal(backstop.length, 0, 'kill switch must prevent the backstop emit');
  });

  test('a repeated coverage run without the abort ever landing keeps re-firing (self-healing, not silently dropped)', () => {
    // Confirms the check has NO lock-file suppression (unlike checkOrchRoiPresence) —
    // each run independently re-derives "is state_cancel_aborted present yet?" from
    // disk, so a transient writeEvent failure on one run is retried on the next.
    const dir = makeRepo();
    const archivedDir = path.join(dir, '.orchestray', 'history', 'orch-' + ORCH_ID + '-cancelled');
    fs.mkdirSync(archivedDir, { recursive: true });

    assert.equal(runCoverage(dir).status, 0);
    const firstRun = readEvents(dir).filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.equal(firstRun.length, 1);

    // Second run: the backstop's own prior emission now satisfies "already present" — no duplicate.
    assert.equal(runCoverage(dir).status, 0);
    const secondRun = readEvents(dir).filter(e => e.type === 'state_cancel_aborted' && e.source === 'state_watcher_backstop');
    assert.equal(secondRun.length, 1, 'self-healing dedup via the same presence check — no duplicate on re-run');
  });
});

// ---------------------------------------------------------------------------
// E3 (reviewer finding): processTarget's read(lastSeen)->check->write(lastSeen)
// ->pmAlreadyEmitted->emit sequence must run under an exclusive lock so two
// concurrent PostToolUse:Edit fires on the same relPath+target cannot both
// pass the idempotency check and double-fire.
// ---------------------------------------------------------------------------

describe('E3 — processTarget critical section is lock-protected', () => {
  test('a live, held advisory lock on the last-seen file blocks the emit (fail-closed on contention, not a race-past)', () => {
    // Simulates "another process is mid-critical-section": pre-create the
    // SAME lock file processTarget now acquires, with a PID that is
    // genuinely alive for the test's duration (this test runner's own pid)
    // so _isLockStale sees a live, non-stale holder and the child watcher
    // process exhausts its retries rather than reclaiming a stale lock.
    const dir = makeRepo();
    const decisionPath = path.join(dir, '.orchestray', 'kb', 'decisions', 'D-901.md');
    fs.writeFileSync(decisionPath, '# Decision 901\n');

    const lockPath = path.join(dir, '.orchestray', 'state', 'pm-emit-watcher.last-seen.json.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, String(process.pid), 'utf8');

    try {
      const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/kb/decisions/D-901.md'));
      assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

      // Without the fix, processTarget never looks at this lock file at all,
      // so the emit proceeds regardless of who holds it. With the fix, lock
      // contention makes the watcher skip the emit rather than race past the
      // held lock — proving the critical section is actually gated by it.
      const events   = readEvents(dir);
      const backstop = events.filter(e => e.type === 'tier2_invoked' && e.source === 'state_watcher_backstop');
      assert.equal(backstop.length, 0, 'contended lock must skip the emit, not race past it');
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  });

  test('once the lock is free, the same edit fires normally (contention is transient, not a permanent block)', () => {
    const dir = makeRepo();
    const decisionPath = path.join(dir, '.orchestray', 'kb', 'decisions', 'D-902.md');
    fs.writeFileSync(decisionPath, '# Decision 902\n');

    const r = runWatcher(dir, makeEditPayload(dir, '.orchestray/kb/decisions/D-902.md'));
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events   = readEvents(dir);
    const backstop = events.filter(e => e.type === 'tier2_invoked' && e.source === 'state_watcher_backstop');
    assert.equal(backstop.length, 1, 'an uncontended lock must still allow exactly one backstop');
  });
});

// ---------------------------------------------------------------------------
// E5 (reviewer finding): checkOversizedInputCompleteness's oversized_* backstop
// rows must carry explicit orchestration_id/timestamp so withAutofill has
// nothing to fill — each autofilled field previously routed through a SECOND
// advisory lock cycle (audit-autofill-sample.json.lock) on top of the primary
// events.jsonl lock, doubling locked I/O for up to OVERSIZED_SLICE_SCAN_CAP
// iterations.
// ---------------------------------------------------------------------------

describe('E5 — oversized_* backstop rows carry explicit orchestration_id/timestamp', () => {
  test('oversized_slice_skipped/map_dispatched/synthesis_complete are stamped explicitly, not autofilled', () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'kb', 'artifacts', 'oversized-buffer-c0ffee123456.md'),
      '# kept slices\noi-c0ffee123456-slice-0\n',
    );
    appendEvent(dir, {
      version: 1, type: 'oversized_input_detected', timestamp: new Date().toISOString(),
      orchestration_id: ORCH_ID, corpus_id: 'c0ffee123456', trigger: 'file',
      total_bytes: 1600000, est_tokens: 400000, natural_slices: 2,
      mode: 'hierarchical', threshold_bytes: 1572864,
    });

    const r = runCoverage(dir);
    assert.equal(r.status, 0, `coverage exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const oversizedRows = events.filter(e =>
      e.source === 'state_watcher_backstop' &&
      ['oversized_map_dispatched', 'oversized_slice_skipped', 'oversized_synthesis_complete'].includes(e.type)
    );
    assert.ok(oversizedRows.length >= 2, 'expects at least the dispatched + one skipped slice row');
    for (const row of oversizedRows) {
      assert.equal(row.orchestration_id, ORCH_ID, `${row.type} must carry the real orchestration_id, not an autofilled one`);
      assert.equal(typeof row.timestamp, 'string');
    }

    // The actual measurable claim: withAutofill never ran for these types, so
    // it never touched the autofill-sample counter file — a SECOND advisory
    // lock cycle this fix eliminates. `audit_event_autofilled` itself isn't a
    // reliable probe here (it's sampled at 1-per-10 occurrences; a single row
    // per type in this fixture never crosses that threshold either way), so
    // check the counter's raw state directly instead.
    let sample = {};
    try {
      sample = JSON.parse(fs.readFileSync(
        path.join(dir, '.orchestray', 'state', 'audit-autofill-sample.json'), 'utf8'));
    } catch (_e) { /* file never created — also a pass (no autofill ever ran) */ }
    const byType = (sample && sample.by_type) || {};
    for (const t of ['oversized_map_dispatched', 'oversized_slice_skipped', 'oversized_synthesis_complete']) {
      assert.ok(!byType[t], `${t} must not appear in the autofill-sample counter — explicit fields make autofill a no-op`);
    }
  });
});

// ---------------------------------------------------------------------------
// Defect 3: oversized_map_dispatched/_slice_skipped/_synthesis_complete were
// unreachable for real-world detections because their only backstop
// (checkOversizedInputCompleteness) required an active orchestration marker,
// but 15/15 measured oversized_input_detected rows on this machine carry no
// orchestration_id — detection happens on UserPromptSubmit, before/without
// any orchestration ever starting. Fix: key the reconciliation on the
// oversized-buffer artifact write (the one real file-write signal in the
// map/synthesis protocol) via the PostToolUse watcher, independent of orchId.
// ---------------------------------------------------------------------------

describe('defect 3 — oversized_* backstop reachable without an active orchestration', () => {
  function makeRepoNoOrch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-oversized-noorch-'));
    fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
    // Deliberately NO current-orchestration.json marker.
    return dir;
  }

  test('buffer-artifact write with no orchestration marker still reconstructs the three events, tagged orchestration_id="unknown"', () => {
    const dir = makeRepoNoOrch();

    appendEvent(dir, {
      version: 1, type: 'oversized_input_detected', timestamp: new Date().toISOString(),
      orchestration_id: 'unknown', corpus_id: 'deadbeef0001', trigger: 'file',
      total_bytes: 1600000, est_tokens: 400000, natural_slices: 2,
      mode: 'hierarchical', threshold_bytes: 1572864,
    });

    const bufferRel = '.orchestray/kb/artifacts/oversized-buffer-deadbeef0001.md';
    fs.writeFileSync(path.join(dir, bufferRel), '# kept\noi-deadbeef0001-slice-0\n');

    const r = runWatcher(dir, makeEditPayload(dir, bufferRel));
    assert.equal(r.status, 0, `watcher exit=${r.status} stderr=${r.stderr}`);

    const events = readEvents(dir);
    const rows = events.filter(e => e.source === 'state_watcher_backstop' &&
      ['oversized_map_dispatched', 'oversized_slice_skipped', 'oversized_synthesis_complete'].includes(e.type));
    assert.ok(rows.length >= 2, 'expects at least dispatched + one skipped-slice row with no orchestration active');
    for (const row of rows) {
      assert.equal(row.orchestration_id, 'unknown', `${row.type} must use the established 'unknown' sentinel, not be omitted`);
    }
  });

  test('kill switch (ORCHESTRAY_OVERSIZED_WATCHER_DISABLED) silences the no-orchestration reconciliation too', () => {
    const dir = makeRepoNoOrch();
    appendEvent(dir, {
      version: 1, type: 'oversized_input_detected', timestamp: new Date().toISOString(),
      orchestration_id: 'unknown', corpus_id: 'deadbeef0002', trigger: 'file',
      total_bytes: 1600000, est_tokens: 400000, natural_slices: 1,
      mode: 'direct', threshold_bytes: 1572864,
    });
    const bufferRel = '.orchestray/kb/artifacts/oversized-buffer-deadbeef0002.md';
    fs.writeFileSync(path.join(dir, bufferRel), '# kept\n');

    const r = runWatcher(dir, makeEditPayload(dir, bufferRel), { ORCHESTRAY_OVERSIZED_WATCHER_DISABLED: '1' });
    assert.equal(r.status, 0);
    const rows = readEvents(dir).filter(e => e.source === 'state_watcher_backstop' &&
      e.type.startsWith('oversized_'));
    assert.equal(rows.length, 0, 'kill switch must silence the no-orchestration reconciliation path too');
  });
});

// ---------------------------------------------------------------------------
// v2.3.21 item 2: misshapen-emit detection — `event:` instead of `type:`.
// Surfaced by verify_fix_attempt (no code emitter; all 19 historical rows
// used the wrong field name, invisible to the ratio-based check above).
// ---------------------------------------------------------------------------

describe('v2.3.21 item 2 — misshapen emit detection (event: vs type:)', () => {
  test('a row shaped {event: "verify_fix_attempt", ...} flags pm_emit_prose_rotting with wrong_field_shape', () => {
    const dir = makeRepo();
    appendEvent(dir, {
      event: 'verify_fix_attempt',
      timestamp: new Date().toISOString(),
      orchestration_id: ORCH_ID,
      task_id: 'task-30',
      round: 1,
    });

    const r = runCoverage(dir);
    assert.equal(r.status, 0, `coverage exit=${r.status} stderr=${r.stderr}`);

    const events  = readEvents(dir);
    const rotting = events.filter(e => e.type === 'pm_emit_prose_rotting' && e.wrong_field_shape === true);
    assert.equal(rotting.length, 1, 'a single misshapen row is enough to flag — no floor');
    assert.equal(rotting[0].event_type, 'verify_fix_attempt');
    assert.equal(rotting[0].misshapen_count, 1);
    assert.equal(rotting[0].zero_emission, true);
  });

  test('only well-shaped rows (type:, not event:) → no misshapen flag', () => {
    const dir = makeRepo();
    appendEvent(dir, {
      type: 'verify_fix_start', timestamp: new Date().toISOString(),
      orchestration_id: ORCH_ID, task_id: 'task-31', round: 1, error_count: 0,
    });

    const r = runCoverage(dir);
    assert.equal(r.status, 0);

    const events  = readEvents(dir);
    const rotting = events.filter(e => e.type === 'pm_emit_prose_rotting' && e.wrong_field_shape === true);
    assert.equal(rotting.length, 0, 'well-shaped rows must not trip the misshapen scan');
  });

  test('a prior wrong_field_shape flag for the same name suppresses re-emission on the next run', () => {
    const dir = makeRepo();
    appendEvent(dir, { event: 'verify_fix_attempt', timestamp: new Date().toISOString(), orchestration_id: ORCH_ID });

    assert.equal(runCoverage(dir).status, 0);
    const firstRun = readEvents(dir).filter(e => e.type === 'pm_emit_prose_rotting' && e.wrong_field_shape === true);
    assert.equal(firstRun.length, 1);

    assert.equal(runCoverage(dir).status, 0);
    const secondRun = readEvents(dir).filter(e => e.type === 'pm_emit_prose_rotting' && e.wrong_field_shape === true);
    assert.equal(secondRun.length, 1, 'idempotent — prior flag is itself well-shaped and visible on re-scan');
  });

  test('kill switch (ORCHESTRAY_MISSHAPEN_EMIT_SCAN_DISABLED) silences the scan', () => {
    const dir = makeRepo();
    appendEvent(dir, { event: 'verify_fix_attempt', timestamp: new Date().toISOString(), orchestration_id: ORCH_ID });

    const r = runCoverage(dir, { ORCHESTRAY_MISSHAPEN_EMIT_SCAN_DISABLED: '1' });
    assert.equal(r.status, 0);

    const events  = readEvents(dir);
    const rotting = events.filter(e => e.type === 'pm_emit_prose_rotting' && e.wrong_field_shape === true);
    assert.equal(rotting.length, 0, 'kill switch must prevent the misshapen-scan emit');
  });
});
