#!/usr/bin/env node
'use strict';

/**
 * v2.3.10 Bucket C — resilience & telemetry fixes.
 *
 * C1 — stale state/tasks/*.md never leak into the current run's dossier.
 *      `ox state init` archives+clears prior live state; the dossier writer
 *      additionally scopes the task glob to the active orch-id.
 * C2 — collect-agent-metrics: a null-agent_type SubagentStop either recovers a
 *      real model from the transcript OR sets cost_confidence='estimated'
 *      (never 'measured' with a null model).
 * C3 — orchestration.md terminal vocab (`complete`/`closed`) normalises to the
 *      dossier-schema canonical (`completed`/`complete`) so the injector
 *      stale-skip fires.
 * C4 — live events.jsonl rotation is append-safe (rename, never truncate).
 *
 * Runner: node --test bin/__tests__/v2310-bucketC-resilience.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const OX_BIN          = path.resolve(__dirname, '..', 'ox.js');
const DOSSIER_WRITER  = path.resolve(__dirname, '..', 'write-resilience-dossier.js');
const METRICS_HOOK    = path.resolve(__dirname, '..', 'collect-agent-metrics.js');
const ARCHIVE_MOD     = require('../archive-orch-events.js');
const ORCH_STATE      = require('../_lib/orchestration-state.js');
const { buildDossier } = require('../_lib/resilience-dossier-schema.js');

let tmp;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-bucketC-')); });
afterEach(()  => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {} });

function stateDir() { return path.join(tmp, '.orchestray', 'state'); }
function tasksDir() { return path.join(tmp, '.orchestray', 'state', 'tasks'); }
function auditDir() { return path.join(tmp, '.orchestray', 'audit'); }

function writeTaskFile(name, fm) {
  fs.mkdirSync(tasksDir(), { recursive: true });
  const body = '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\nbody\n';
  fs.writeFileSync(path.join(tasksDir(), name), body, 'utf8');
}

function runOx(args, extraEnv) {
  return spawnSync(process.execPath, [OX_BIN, ...args], {
    env: { ...process.env, OX_CWD: tmp, ...(extraEnv || {}) },
    encoding: 'utf8',
  });
}

function runDossierWriter() {
  return spawnSync(process.execPath, [DOSSIER_WRITER], {
    input: JSON.stringify({ hook_event_name: 'Stop', cwd: tmp }),
    env: { ...process.env },
    cwd: tmp,
    encoding: 'utf8',
  });
}

function readDossier() {
  const p = path.join(stateDir(), 'resilience-dossier.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readEvents() {
  const p = path.join(auditDir(), 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// C1 — stale-task isolation
// ---------------------------------------------------------------------------

describe('C1 — stale task ledger does not leak into the current dossier', () => {
  test('ox state init archives+clears a prior run\'s task files', () => {
    // Seed stale May-29-style task files from a DIFFERENT, completed orch.
    writeTaskFile('task-1.md', { id: 'task-1', status: 'pending', orchestration_id: 'orch-OLD-run' });
    writeTaskFile('task-2.md', { id: 'task-2', status: 'in_progress', orchestration_id: 'orch-OLD-run' });
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'orchestration.md'), '---\nid: orch-OLD-run\nstatus: complete\n---\n', 'utf8');

    const r = runOx(['state', 'init', 'orch-NEW-run', '--task=fresh']);
    assert.equal(r.status, 0, 'state init should succeed: ' + r.stderr);

    // Live tasks dir must be emptied; snapshot filed under the new orch's history.
    assert.ok(!fs.existsSync(path.join(tasksDir(), 'task-1.md')), 'stale task-1 must be removed from live path');
    const snap = path.join(tmp, '.orchestray', 'history', 'orch-NEW-run', 'state-snapshot');
    assert.ok(fs.existsSync(snap), 'snapshot dir should exist');
    const snapFiles = fs.readdirSync(snap);
    assert.ok(snapFiles.some((f) => f.includes('task-1')), 'stale task archived, not destroyed');

    // stale_state_pruned audit event emitted.
    const ev = readEvents().find((e) => e.type === 'stale_state_pruned');
    assert.ok(ev, 'stale_state_pruned event should be emitted');
    assert.equal(ev.trigger, 'state_init');
  });

  test('dossier for a fresh init contains no stale pending task ids', () => {
    // Stale tasks present, then a fresh init, then build the dossier.
    writeTaskFile('task-1.md', { id: 'task-1', status: 'pending', orchestration_id: 'orch-OLD-run' });
    writeTaskFile('task-2.md', { id: 'task-2', status: 'pending', orchestration_id: 'orch-OLD-run' });

    let r = runOx(['state', 'init', 'orch-NEW-run', '--task=fresh']);
    assert.equal(r.status, 0, r.stderr);

    r = runDossierWriter();
    assert.equal(r.status, 0, 'dossier writer should exit 0: ' + r.stderr);

    const d = readDossier();
    assert.ok(d, 'dossier should be written');
    assert.equal(d.orchestration_id, 'orch-NEW-run');
    assert.deepEqual(d.pending_task_ids || [], [], 'no stale pending ids for a fresh init');
    assert.ok(!(d.pending_task_ids || []).includes('task-1'), 'must never carry orch-OLD-run task ids');
  });

  test('defense-in-depth: dossier writer skips tasks whose orch-id differs from the active run', () => {
    // Simulate a leaked stale file that survived cleanup (e.g. written after init).
    // Active orch via orchestration.md; a task file tagged for a different orch.
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'orchestration.md'), '---\nid: orch-ACTIVE\nstatus: in_progress\n---\n', 'utf8');
    writeTaskFile('task-active.md', { id: 'task-active', status: 'pending', orchestration_id: 'orch-ACTIVE' });
    writeTaskFile('task-stale.md',  { id: 'task-stale',  status: 'pending', orchestration_id: 'orch-OTHER' });

    const r = runDossierWriter();
    assert.equal(r.status, 0, r.stderr);
    const d = readDossier();
    assert.ok(d.pending_task_ids.includes('task-active'), 'active-run task included');
    assert.ok(!d.pending_task_ids.includes('task-stale'), 'cross-orch stale task scoped out');
  });
});

// ---------------------------------------------------------------------------
// C2 — model resolution / confidence flip
// ---------------------------------------------------------------------------

describe('C2 — null agent_type never yields measured-with-null model', () => {
  function seedOrch(orchId) {
    fs.mkdirSync(auditDir(), { recursive: true });
    fs.writeFileSync(path.join(auditDir(), 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId }), 'utf8');
  }

  function runMetrics(payload) {
    const env = { ...process.env };
    delete env.ORCHESTRAY_METRICS_DISABLED;
    return spawnSync(process.execPath, [METRICS_HOOK], {
      input: JSON.stringify(payload), env, cwd: tmp, encoding: 'utf8', timeout: 10000,
    });
  }

  test('agent_stop with null agent_type and no transcript → cost_confidence estimated', () => {
    const orchId = 'orch-c2-noresolve';
    seedOrch(orchId);
    const r = runMetrics({
      hook_event_name: 'SubagentStop', cwd: tmp,
      agent_id: 'a-1', session_id: 's-1',
      // NO agent_type, NO transcript_path
      usage: { input_tokens: 1000, output_tokens: 500 },
      last_assistant_message: 'done',
    });
    assert.equal(r.status, 0, r.stderr);
    const stop = readEvents().find((e) => e.type === 'agent_stop');
    assert.ok(stop, 'agent_stop emitted');
    assert.equal(stop.model_used, null, 'model unresolved');
    assert.equal(stop.cost_confidence, 'estimated',
      'null model MUST flip cost_confidence to estimated (never measured)');
    // Invariant: never measured-with-null.
    assert.ok(!(stop.model_used === null && stop.cost_confidence === 'measured'),
      'measured-with-null-model is forbidden');
  });

  test('null agent_type recovered from transcript spawn prompt resolves a real model', () => {
    const orchId = 'orch-c2-recover';
    seedOrch(orchId);
    // routing_outcome carries the real model keyed by agent_type.
    fs.appendFileSync(path.join(auditDir(), 'events.jsonl'),
      JSON.stringify({ type: 'routing_outcome', orchestration_id: orchId,
        agent_type: 'developer', model_assigned: 'opus' }) + '\n', 'utf8');
    // Transcript whose head names the role via the spawn-prompt convention.
    const tpath = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(tpath,
      JSON.stringify({ type: 'user', message: { role: 'user',
        content: 'You are a developer agent for the Orchestray plugin.' } }) + '\n' +
      JSON.stringify({ role: 'assistant', content: 'done',
        usage: { input_tokens: 10, output_tokens: 5 } }) + '\n', 'utf8');

    const r = runMetrics({
      hook_event_name: 'SubagentStop', cwd: tmp,
      agent_id: 'a-2', session_id: 's-2', agent_transcript_path: tpath,
      last_assistant_message: 'done',
    });
    assert.equal(r.status, 0, r.stderr);
    const stop = readEvents().find((e) => e.type === 'agent_stop');
    assert.ok(stop, 'agent_stop emitted');
    assert.equal(stop.agent_type, 'developer', 'role recovered from transcript');
    assert.equal(stop.model_used, 'opus', 'real model resolved via routing_outcome');
  });
});

// ---------------------------------------------------------------------------
// C3 — terminal-status normalization
// ---------------------------------------------------------------------------

describe('C3 — orchestration.md terminal vocab normalises to schema-canonical', () => {
  test('normalizeOrchStatus maps complete/closed/done → completed', () => {
    assert.equal(ORCH_STATE.normalizeOrchStatus('complete'), 'completed');
    assert.equal(ORCH_STATE.normalizeOrchStatus('closed'), 'completed');
    assert.equal(ORCH_STATE.normalizeOrchStatus('done'), 'completed');
    assert.equal(ORCH_STATE.normalizeOrchStatus('completed'), 'completed');
    assert.equal(ORCH_STATE.normalizeOrchStatus('in_progress'), 'in_progress');
    assert.equal(ORCH_STATE.normalizeOrchStatus(null), null);
  });

  test('normalizeOrchPhase maps closed → complete', () => {
    assert.equal(ORCH_STATE.normalizeOrchPhase('closed'), 'complete');
    assert.equal(ORCH_STATE.normalizeOrchPhase('complete'), 'complete');
    assert.equal(ORCH_STATE.normalizeOrchPhase('implementation'), 'implementation');
  });

  test('dossier built from a closed orchestration.md serializes status=completed (stale-skip can fire)', () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'orchestration.md'),
      '---\nid: orch-closed\nstatus: complete\nphase: closed\n---\n', 'utf8');
    const r = runDossierWriter();
    assert.equal(r.status, 0, r.stderr);
    const d = readDossier();
    assert.equal(d.status, 'completed', 'closed orch must serialize canonical completed, not null');
    assert.equal(d.phase, 'complete', 'closed phase normalised to canonical complete');
  });
});

// ---------------------------------------------------------------------------
// C4 — rotation append-safety
// ---------------------------------------------------------------------------

describe('C4 — live events.jsonl rotation is append-safe', () => {
  test('rotateLiveEvents below threshold is a no-op (no truncation)', () => {
    fs.mkdirSync(auditDir(), { recursive: true });
    const p = path.join(auditDir(), 'events.jsonl');
    fs.writeFileSync(p, 'line1\nline2\n', 'utf8');
    const res = ARCHIVE_MOD.rotateLiveEvents(p);
    assert.equal(res.rotated, false);
    assert.equal(fs.readFileSync(p, 'utf8'), 'line1\nline2\n', 'content untouched');
  });

  test('rotateLiveEvents past threshold renames (never truncates) and preserves every byte', () => {
    fs.mkdirSync(auditDir(), { recursive: true });
    const p = path.join(auditDir(), 'events.jsonl');
    const payload = 'x'.repeat(2048) + '\n';
    const lines = 40; // 40 * ~2KB > 16KB threshold (env-lowered below)
    let content = '';
    for (let i = 0; i < lines; i++) content += `{"n":${i},"pad":"${payload.trim()}"}` + '\n';
    fs.writeFileSync(p, content, 'utf8');

    // Lower threshold via env so the test stays fast.
    const prev = process.env.ORCHESTRAY_EVENTS_ROTATE_BYTES;
    process.env.ORCHESTRAY_EVENTS_ROTATE_BYTES = String(16 * 1024);
    try {
      const res = ARCHIVE_MOD.rotateLiveEvents(p);
      assert.equal(res.rotated, true, 'should roll past lowered threshold');
      // .1 holds the FULL original content — nothing truncated.
      assert.equal(fs.readFileSync(p + '.1', 'utf8'), content, 'rolled file is byte-identical to original');
      // Live path no longer exists (next append recreates it).
      assert.ok(!fs.existsSync(p), 'live path renamed away (append-create on next write)');
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_EVENTS_ROTATE_BYTES;
      else process.env.ORCHESTRAY_EVENTS_ROTATE_BYTES = prev;
    }
  });

  test('append after rotation lands a whole line in the fresh live log (O_APPEND semantics)', () => {
    fs.mkdirSync(auditDir(), { recursive: true });
    const p = path.join(auditDir(), 'events.jsonl');
    fs.writeFileSync(p, 'old\n', 'utf8');
    // Simulate a writer holding an fd to the old inode (opened with append).
    const fd = fs.openSync(p, 'a');
    try {
      fs.renameSync(p, p + '.1'); // rotation
      // The held fd still points to the old inode (now .1); its write lands there whole.
      fs.writeSync(fd, 'inflight-line\n');
      // A new appender opens by path → fresh live log.
      fs.appendFileSync(p, 'new-line\n');
    } finally { fs.closeSync(fd); }

    assert.equal(fs.readFileSync(p + '.1', 'utf8'), 'old\ninflight-line\n', 'inflight append whole in rolled file');
    assert.equal(fs.readFileSync(p, 'utf8'), 'new-line\n', 'new appends land in fresh live log');
  });

  test('runHousekeeping prunes orphaned task files older than the TTL', () => {
    fs.mkdirSync(tasksDir(), { recursive: true });
    const old = path.join(tasksDir(), 'old-task.md');
    const fresh = path.join(tasksDir(), 'fresh-task.md');
    fs.writeFileSync(old, 'old', 'utf8');
    fs.writeFileSync(fresh, 'fresh', 'utf8');
    // Backdate the old file 30 days.
    const past = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(old, past, past);

    const res = ORCH_STATE.pruneOrphanedTaskState(tmp, 14 * 24 * 60 * 60 * 1000);
    assert.ok(res.pruned >= 1, 'old file pruned');
    assert.ok(!fs.existsSync(old), 'old task removed');
    assert.ok(fs.existsSync(fresh), 'fresh task retained');
  });
});
