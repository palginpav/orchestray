#!/usr/bin/env node
'use strict';

/**
 * Integration test — end-to-end compaction-resilience simulator.
 *
 * Drives the three hooks in sequence without spawning subprocesses:
 *   1. writeDossierSnapshot(cwd) on a seeded orchestration
 *   2. handleSessionStart({source:"compact"})
 *   3. handleUserPromptSubmit() × 4 — expect injection on turns 1–3,
 *      skip on turn 4 (counter exhausted at max_inject_turns=3).
 *
 * Covers W3 §H3 integration suite requirements:
 *   - post-compact injection flow works end-to-end
 *   - /clear is silently dropped (K2)
 *   - max_inject_turns cap is honored
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshAll() {
  // Clear every module in the resilience chain so each test has a fresh
  // per-process dedup state.
  for (const m of [
    '../../bin/write-resilience-dossier',
    '../../bin/mark-compact-signal',
    '../../bin/inject-resilience-dossier',
    '../../bin/_lib/resilience-dossier-schema',
    '../../bin/_lib/config-schema',
    '../../bin/_lib/degraded-journal',
  ]) {
    try { delete require.cache[require.resolve(m)]; } catch (_e) {}
  }
  return {
    writer: require('../../bin/write-resilience-dossier'),
    signaler: require('../../bin/mark-compact-signal'),
    injector: require('../../bin/inject-resilience-dossier'),
  };
}

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state', 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  const fm = [
    '---',
    'id: orch-E2E',
    'status: in_progress',
    'current_phase: implementation',
    'complexity_score: 8',
    'delegation_pattern: parallel',
    'current_group_id: group-1',
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, '.orchestray', 'state', 'orchestration.md'), fm);
  return dir;
}

function readEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return {}; }
  });
}

describe('E2E compact simulator', () => {
  test('Stop → compact → UserPromptSubmit×4 → injection cap honored', () => {
    const cwd = mkProject();
    const { writer, signaler, injector } = freshAll();

    // 1. Simulate PM Stop: writer produces the dossier.
    const w = writer.writeDossierSnapshot(cwd, { trigger: 'stop' });
    assert.equal(w.written, true);

    // 2. Simulate SessionStart(compact).
    const s = signaler.handleSessionStart({ cwd, source: 'compact' });
    assert.equal(s.dropped, true);

    // 3. Four successive UserPromptSubmit turns.
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(injector.handleUserPromptSubmit({ cwd }));
    }

    assert.equal(results[0].action, 'injected');
    assert.equal(results[1].action, 'injected');
    assert.equal(results[2].action, 'injected');
    assert.equal(results[3].action, 'skipped_no_lock',
      'turn 4 should have no lock remaining (counter was exhausted after turn 3)');

    // Audit trail contains the expected event types.
    const evts = readEvents(cwd);
    assert.ok(evts.some((e) => e.type === 'dossier_written'));
    assert.ok(evts.some((e) => e.type === 'compaction_detected'));
    const injected = evts.filter((e) => e.type === 'dossier_injected');
    assert.equal(injected.length, 3, 'exactly 3 dossier_injected events');
  });

  test('K2: SessionStart(clear) → no injection on subsequent turns', () => {
    const cwd = mkProject();
    const { writer, signaler, injector } = freshAll();
    writer.writeDossierSnapshot(cwd, { trigger: 'stop' });

    const s = signaler.handleSessionStart({ cwd, source: 'clear' });
    assert.equal(s.dropped, false, '/clear must NOT drop a lock');

    // Subsequent turn: injector finds no lock, stays silent.
    const r = injector.handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'skipped_no_lock');
    assert.ok(!r.output.hookSpecificOutput);

    // Audit: NO compaction_detected event from the /clear.
    const evts = readEvents(cwd);
    assert.ok(!evts.some((e) => e.type === 'compaction_detected'),
      'K2 violation: compaction_detected fired on /clear');
  });

  test('resume path behaves identically to compact', () => {
    const cwd = mkProject();
    const { writer, signaler, injector } = freshAll();
    writer.writeDossierSnapshot(cwd, { trigger: 'stop' });
    signaler.handleSessionStart({ cwd, source: 'resume' });
    const r = injector.handleUserPromptSubmit({ cwd });
    assert.equal(r.action, 'injected');
    const evts = readEvents(cwd);
    const cd = evts.find((e) => e.type === 'compaction_detected');
    assert.ok(cd);
    assert.equal(cd.source, 'resume');
  });

  test('no orchestration → writer no-ops, injector silent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-empty-'));
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
    const { writer, signaler, injector } = freshAll();
    const w = writer.writeDossierSnapshot(dir, { trigger: 'stop' });
    assert.equal(w.written, false);
    signaler.handleSessionStart({ cwd: dir, source: 'compact' });
    const r = injector.handleUserPromptSubmit({ cwd: dir });
    // Lock was dropped (signaler doesn't require orchestration) but dossier is missing.
    assert.equal(r.action, 'skipped_no_dossier');
  });
});
