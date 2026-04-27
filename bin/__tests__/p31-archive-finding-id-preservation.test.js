#!/usr/bin/env node
'use strict';

/**
 * P3.1 audit-round archive — finding-ID preservation gate (AR-7).
 *
 * The "zero deferrals" safety rail (feedback_preship_audit_loop.md).
 * This is the test that earns the right to remove verbatim findings
 * from Block-A Zone 2: the digest MUST contain every input finding's
 * id, every input finding's id MUST be returned in result.findingIds,
 * and the array order MUST be deterministic.
 *
 * Fixture: 12 findings of mixed event types
 * (verify_fix_pass / verify_fix_fail / verify_fix_oscillation /
 *  pm_finding) for the same orch+round.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { archiveRound } = require('../_lib/audit-round-archive.js');

const ORCH = 'orch-finding-id-test';
const ROUND = 3;

let tmpDir;

function buildFindings() {
  const types = ['verify_fix_pass', 'verify_fix_fail',
                 'verify_fix_oscillation', 'pm_finding'];
  const out = [];
  for (let i = 0; i < 12; i++) {
    const t = types[i % types.length];
    out.push({
      version: 1,
      type: t,
      timestamp: '2026-04-26T10:00:' + String(i).padStart(2, '0') + '.000Z',
      orchestration_id: ORCH,
      round: ROUND,
      task_id: 'task-' + (i % 3),
      message: 'finding ' + i + ' of type ' + t,
    });
  }
  return out;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p31-finding-id-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'kb', 'artifacts'), { recursive: true });

  const events = buildFindings();
  const lines  = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'),
                   lines, 'utf8');
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('P3.1 archiveRound — finding-ID preservation', () => {
  test('every input finding-id appears in result.findingIds AND digest body', () => {
    const result = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    assert.equal(result.skipped, undefined,
                 'archiveRound should succeed: ' + JSON.stringify(result));
    assert.equal(result.findingIds.length, 12,
                 'expected 12 finding ids; got ' + result.findingIds.length);

    const digestBody = fs.readFileSync(path.join(tmpDir, result.digestPath), 'utf8');

    const missing = [];
    for (const id of result.findingIds) {
      if (!digestBody.includes(id)) missing.push(id);
    }
    if (missing.length > 0) {
      assert.fail('digest body is missing finding ids:\n' + missing.join('\n') +
                  '\n--- digest body ---\n' + digestBody);
    }
  });

  test('result.findingIds covers every event type emitted in the round', () => {
    const result = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    assert.equal(result.skipped, undefined);

    const types = ['verify_fix_pass', 'verify_fix_fail',
                   'verify_fix_oscillation', 'pm_finding'];
    for (const t of types) {
      const seen = result.findingIds.some(id => id.endsWith('.' + t));
      assert.ok(seen, 'no finding-id covers event type ' + t);
    }
  });

  test('finding-id ordering is deterministic across re-runs', () => {
    const r1 = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    fs.unlinkSync(path.join(tmpDir, r1.digestPath));
    const r2 = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    assert.deepEqual(r1.findingIds, r2.findingIds,
                     'finding-id ordering must be deterministic');
  });

  test('result.findingIds deep-equals the exact set synthesized from the fixture (F-004 fix)', () => {
    // Architect §6b: "the array equals the set of fixture ids in deterministic
    // order." Pre-compute the EXPECTED finding-id set using the same synthesis
    // formula the production code uses (`audit-round-archive.js::synthesizeFindingId`):
    //   `${roundN}.${ordinalIndex}.${task_id}.${event.type}`
    // Closes the only gap that distinguished "right count + right presence"
    // from "right ids".
    const fixture = buildFindings();
    const expected = fixture.map((ev, idx) => (
      ROUND + '.' + (idx + 1) + '.' + ev.task_id + '.' + ev.type
    ));
    const result = archiveRound(ORCH, ROUND, { cwd: tmpDir });
    assert.equal(result.skipped, undefined);
    assert.deepEqual(result.findingIds, expected,
      'result.findingIds must deep-equal the fixture-synthesized id list. ' +
      'A bug that drops one input event AND synthesizes one spurious id ' +
      'would otherwise pass the count+presence assertions. Expected: ' +
      JSON.stringify(expected) + '; Actual: ' + JSON.stringify(result.findingIds));
  });
});
