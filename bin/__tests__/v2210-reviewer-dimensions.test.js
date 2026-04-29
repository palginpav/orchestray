#!/usr/bin/env node
'use strict';

/**
 * Tests for B5 — reviewer_dimensions_missing warn-event.
 *
 * Coverage:
 *   1. Reviewer prompt WITH ## Dimensions to Apply → 0 emits.
 *   2. Reviewer prompt WITHOUT header → 1 emit of reviewer_dimensions_missing, exit 0 (still succeeds if scoped).
 *   3. Non-reviewer subagent (developer) → 0 emits regardless.
 *   4. ORCHESTRAY_REVIEWER_DIMENSIONS_WARN_DISABLED=1 → 0 emits.
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

describe('v2210-B5 — reviewer_dimensions_missing warn-event', () => {
  test('Test 1: reviewer prompt WITH ## Dimensions to Apply → 0 reviewer_dimensions_missing emits', () => {
    const prompt = SCOPED_PROMPT_BASE + '\n## Dimensions to Apply\n- correctness\n- security\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_missing');
    assert.equal(dimEvents.length, 0, 'No reviewer_dimensions_missing when header present. events=' + JSON.stringify(events));
    assert.equal(r.status, 0, 'Exit 0 when scoped + has dimensions. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 2: reviewer prompt WITHOUT ## Dimensions to Apply → 1 emit, spawn still succeeds (exit 0)', () => {
    const prompt = SCOPED_PROMPT_BASE; // has files: so scope check passes, but no dimensions header
    const r = runHook({
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'reviewer',
        prompt,
        agent_id: 'test-agent-id',
        task_id: 'T-test',
      },
    });
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_missing');
    assert.equal(dimEvents.length, 1, 'Exactly 1 reviewer_dimensions_missing event. events=' + JSON.stringify(events));
    assert.equal(dimEvents[0].agent_id, 'test-agent-id', 'agent_id propagated');
    assert.equal(dimEvents[0].task_id, 'T-test', 'task_id propagated');
    assert.equal(r.status, 0, 'Spawn still succeeds (warn-only, no exit 2). stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 3: non-reviewer (developer) spawn → 0 emits regardless', () => {
    const prompt = SCOPED_PROMPT_BASE; // no dimensions header but not a reviewer
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_missing');
    assert.equal(dimEvents.length, 0, 'Non-reviewer subagent must not emit reviewer_dimensions_missing.');
    assert.equal(r.status, 0, 'Exit 0 for non-reviewer. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 4: ORCHESTRAY_REVIEWER_DIMENSIONS_WARN_DISABLED=1 → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE; // no dimensions header
    const r = runHook(
      {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'reviewer', prompt },
      },
      { ORCHESTRAY_REVIEWER_DIMENSIONS_WARN_DISABLED: '1' }
    );
    const events = readAuditEvents(r.tmp);
    const dimEvents = events.filter(e => e.type === 'reviewer_dimensions_missing');
    assert.equal(dimEvents.length, 0, 'Kill switch must suppress reviewer_dimensions_missing emit.');
    assert.equal(r.status, 0, 'Exit 0 with kill switch. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});
