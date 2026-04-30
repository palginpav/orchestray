#!/usr/bin/env node
'use strict';

/**
 * Tests for reviewer-dimensions warn-event in validate-reviewer-scope.js.
 *
 * History:
 *   - v2.2.10 B5: introduced `reviewer_dimensions_missing` (strict regex).
 *   - v2.2.11 W2-9: added `reviewer_dimensions_block_missing` (looser regex).
 *   - v2.2.15 FN-41: retired the v2.2.10 B5 block as a duplicate of W2-9.
 *     The canonical event is `reviewer_dimensions_block_missing`.
 *     The hard gate is FN-43 (bin/validate-reviewer-dimensions.js).
 *
 * Coverage:
 *   1. Reviewer prompt WITH ## Dimensions to Apply → 0 emits.
 *   2. Reviewer prompt WITHOUT header → 1 reviewer_dimensions_block_missing emit, exit 0 (warn-only at this layer).
 *   3. Non-reviewer (developer) → 0 emits regardless.
 *   4. ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED=1 → 0 emits.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'validate-reviewer-scope.js');

// Scoped reviewer prompt baseline — has the files: marker so it won't hard-block.
const SCOPED_PROMPT_BASE = [
  'Review the following files for issues.',
  '',
  'files:',
  '- bin/validate-reviewer-scope.js',
  '- bin/__tests__/v2210-reviewer-dimensions.test.js',
  '',
].join('\n');

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-rdim-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  return { ...res, tmp };
}

function readAuditEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

describe('v2.2.15 FN-41 — reviewer_dimensions_block_missing (canonical replacement of retired reviewer_dimensions_missing)', () => {
  test('Test 1: reviewer prompt WITH ## Dimensions to Apply → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE + '\n## Dimensions to Apply\n- correctness\n- security\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    const legacyEvents = events.filter(e => e.type === 'reviewer_dimensions_missing');
    assert.equal(dimEvents.length, 0, 'No emit when header present. events=' + JSON.stringify(events));
    assert.equal(legacyEvents.length, 0, 'Retired event must never fire (FN-41).');
    assert.equal(r.status, 0, 'Exit 0 when scoped + has dimensions. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 2: reviewer prompt WITHOUT ## Dimensions to Apply → 1 reviewer_dimensions_block_missing emit, exit 0', () => {
    const prompt = SCOPED_PROMPT_BASE; // has files: so scope check passes, but no dimensions header
    const r = runHook({
      tool_name: 'Agent',
      // FN-36: agent_id / task_id at event TOP-LEVEL (Claude Code position).
      agent_id: 'test-agent-id',
      task_id: 'T-test',
      tool_input: {
        subagent_type: 'reviewer',
        prompt,
      },
    });
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    const legacyEvents = events.filter(e => e.type === 'reviewer_dimensions_missing');
    assert.equal(dimEvents.length, 1, 'Exactly 1 reviewer_dimensions_block_missing event. events=' + JSON.stringify(events));
    assert.equal(legacyEvents.length, 0, 'Retired event must never fire (FN-41).');
    assert.equal(dimEvents[0].spawn_id, 'test-agent-id', 'spawn_id resolves from event.agent_id (FN-36)');
    assert.equal(r.status, 0, 'Spawn still succeeds at this layer (warn-only; FN-43 owns hard block). stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 3: non-reviewer (developer) spawn → 0 emits regardless', () => {
    const prompt = SCOPED_PROMPT_BASE; // no dimensions header but not a reviewer
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(dimEvents.length, 0, 'Non-reviewer subagent must not emit reviewer_dimensions_block_missing.');
    assert.equal(r.status, 0, 'Exit 0 for non-reviewer. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 4: ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED=1 → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE; // no dimensions header
    const r = runHook(
      {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'reviewer', prompt },
      },
      { ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED: '1' }
    );
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(dimEvents.length, 0, 'Kill switch must suppress reviewer_dimensions_block_missing emit.');
    assert.equal(r.status, 0, 'Exit 0 with kill switch. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});
