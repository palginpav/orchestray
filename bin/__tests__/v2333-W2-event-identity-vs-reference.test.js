#!/usr/bin/env node
'use strict';

/**
 * v2333-W2-event-identity-vs-reference.test.js — regression tests for the
 * `type` (row identity) vs `event_type` (advisory reference) conflation
 * defect (v2.3.33 W2).
 *
 * Each case builds an events.jsonl-style fixture containing BOTH a real
 * event of type X and an advisory row that merely *references* X via its
 * `event_type` field (own identity `type` is the advisory name). Consumers
 * must count/identify exactly the real event, ignoring the advisory row.
 */

const { test, describe } = require('node:test');
const assert              = require('node:assert/strict');
const fs                  = require('node:fs');
const os                  = require('node:os');
const path                = require('node:path');

const { spawnSync } = require('node:child_process');

const { hasOrchComplete } = require('../audit-on-orch-complete.js');
const { runCoverageProbe } = require('../_lib/tokenwright/coverage-probe.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CALIBRATE_SCRIPT = path.join(REPO_ROOT, 'bin', 'calibrate-role-budgets.js');

function makeTmpEventsFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2333-w2-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
  return file;
}

describe('v2.3.33 W2 — bin/audit-on-orch-complete.js hasOrchComplete()', () => {
  test('advisory row referencing orchestration_complete alone must not count as complete', () => {
    const orchId = 'orch-w2-1';
    const eventsPath = makeTmpEventsFile([
      { type: 'orchestration_start', version: 1, orchestration_id: orchId },
      // Advisory row: identity is audit_event_autofilled; event_type merely
      // references orchestration_complete. Must be ignored for identity checks.
      {
        type: 'audit_event_autofilled', version: 1, orchestration_id: orchId,
        event_type: 'orchestration_complete', fields_autofilled: ['status'], sample_count: 1,
      },
    ]);
    assert.equal(hasOrchComplete(eventsPath, orchId), false,
      'advisory reference to orchestration_complete must not be counted as the real event');
  });

  test('real orchestration_complete row is still detected', () => {
    const orchId = 'orch-w2-2';
    const eventsPath = makeTmpEventsFile([
      { type: 'orchestration_start', version: 1, orchestration_id: orchId },
      {
        type: 'audit_event_autofilled', version: 1, orchestration_id: orchId,
        event_type: 'orchestration_complete', fields_autofilled: ['status'], sample_count: 1,
      },
      { type: 'orchestration_complete', version: 1, orchestration_id: orchId, status: 'success' },
    ]);
    assert.equal(hasOrchComplete(eventsPath, orchId), true,
      'the real orchestration_complete row must still be found alongside the advisory row');
  });
});

describe('v2.3.33 W2 — bin/_lib/tokenwright/coverage-probe.js runCoverageProbe()', () => {
  test('advisory rows referencing agent_start/prompt_compression must not inflate counts', () => {
    const orchId = 'orch-w2-3';
    const eventsPath = makeTmpEventsFile([
      { type: 'agent_start', version: 1, orchestration_id: orchId, agent_type: 'developer' },
      { type: 'prompt_compression', version: 1, orchestration_id: orchId },
      // Advisory rows referencing agent_start / compression_skipped via
      // event_type — must NOT be counted as real occurrences of those types.
      {
        type: 'audit_event_autofilled', version: 1, orchestration_id: orchId,
        event_type: 'agent_start', fields_autofilled: ['agent_id'], sample_count: 1,
      },
      {
        type: 'audit_event_autofilled', version: 1, orchestration_id: orchId,
        event_type: 'compression_skipped', fields_autofilled: ['reason'], sample_count: 1,
      },
    ]);

    const result = runCoverageProbe({ orchestrationId: orchId, eventsPath });
    assert.equal(result.agent_starts_total, 1, 'exactly one real agent_start, advisory row must not double-count');
    assert.equal(result.prompt_compression_emits, 1, 'exactly one real prompt_compression');
    assert.equal(result.compression_skipped_emits, 0, 'no real compression_skipped row exists — advisory reference must not count');
  });
});

describe('v2.3.33 W2 — bin/calibrate-role-budgets.js budget_warn sample collection', () => {
  test('advisory row referencing budget_warn via event_type must not be counted as a sample', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2333-w2-calibrate-'));
    fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

    const now = new Date().toISOString();
    const lines = [
      { type: 'budget_warn', event_type: 'budget_warn', version: 1, timestamp: now,
        agent_role: 'developer', computed_size: 40000 },
      // Advisory row: real identity is audit_event_autofilled; event_type
      // merely references budget_warn. Must not be counted as a real sample.
      { type: 'audit_event_autofilled', version: 1, timestamp: now,
        event_type: 'budget_warn', fields_autofilled: ['source'], sample_count: 1 },
    ];
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
      lines.map(JSON.stringify).join('\n') + '\n',
    );

    const r = spawnSync('node', [
      CALIBRATE_SCRIPT, '--cwd', dir, '--emit-cache', '--min-samples', '1',
    ], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0, `calibrate-role-budgets.js exit=${r.status} stderr=${r.stderr}`);

    const cache = JSON.parse(fs.readFileSync(path.join(dir, '.orchestray', 'state', 'role-budgets.json'), 'utf8'));
    assert.equal(cache.role_budgets.developer.n, 1,
      'exactly one real budget_warn sample; the advisory row referencing budget_warn must not be counted');
  });
});
