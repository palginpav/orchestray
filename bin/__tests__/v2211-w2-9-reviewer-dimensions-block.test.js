#!/usr/bin/env node
'use strict';

/**
 * Tests for W2-9 (v2.2.11) — reviewer_dimensions_block_missing warn-event.
 *
 * Coverage:
 *   1. Reviewer prompt WITH ## Dimensions to Apply → 0 emits.
 *   2. Reviewer prompt WITHOUT the block → 1 reviewer_dimensions_block_missing event with spawn_id.
 *   3. Reviewer prompt with ## Dimensions To Apply (mixed case) → 0 emits.
 *   4. Reviewer prompt with ## dimensions to apply (lowercase) → 0 emits.
 *   5. Non-reviewer spawn (architect, developer) without the block → 0 emits.
 *   6. ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED=1 → 0 emits.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'validate-reviewer-scope.js');

// Scoped reviewer prompt baseline — has files: marker so it won't hard-block on scope check.
const SCOPED_PROMPT_BASE = [
  'Review the following files for issues.',
  '',
  'files:',
  '- bin/validate-reviewer-scope.js',
  '- bin/__tests__/v2211-w2-9-reviewer-dimensions-block.test.js',
  '',
].join('\n');

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-rdimblock-'));
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

describe('v2211-W2-9 — reviewer_dimensions_block_missing warn-event', () => {
  test('Test 1: reviewer prompt WITH ## Dimensions to Apply → 0 reviewer_dimensions_block_missing emits', () => {
    const prompt = SCOPED_PROMPT_BASE + '\n## Dimensions to Apply\n- correctness\n- security\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const blockEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(blockEvents.length, 0, 'No reviewer_dimensions_block_missing when header present. events=' + JSON.stringify(events));
    assert.equal(r.status, 0, 'Exit 0 when scoped + has dimensions. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 2: reviewer prompt WITHOUT ## Dimensions to Apply → 1 emit with spawn_id', () => {
    const prompt = SCOPED_PROMPT_BASE; // has files: so scope passes, but no dimensions block
    const r = runHook({
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'reviewer',
        prompt,
        agent_id: 'spawn-abc-123',
      },
    });
    const events = readAuditEvents(r.tmp);
    const blockEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(blockEvents.length, 1, 'Exactly 1 reviewer_dimensions_block_missing event. events=' + JSON.stringify(events));
    assert.equal(blockEvents[0].spawn_id, 'spawn-abc-123', 'spawn_id must be propagated from agent_id');
    assert.equal(blockEvents[0].version, 1, 'version must be 1');
    assert.equal(blockEvents[0].schema_version, 1, 'schema_version must be 1');
    assert.equal(r.status, 0, 'Warn-only in v2.2.11 — spawn still succeeds (exit 0). stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 3: reviewer prompt with ## Dimensions To Apply (mixed case) → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE + '\n## Dimensions To Apply\n- correctness\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const blockEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(blockEvents.length, 0, 'Mixed-case heading must be accepted (case-insensitive). events=' + JSON.stringify(events));
    assert.equal(r.status, 0, 'Exit 0 with mixed-case heading. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 4: reviewer prompt with ## dimensions to apply (lowercase) → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE + '\n## dimensions to apply\n- correctness\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const blockEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(blockEvents.length, 0, 'Lowercase heading must be accepted (case-insensitive). events=' + JSON.stringify(events));
    assert.equal(r.status, 0, 'Exit 0 with lowercase heading. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 5a: non-reviewer spawn (architect) without the block → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE; // no dimensions block
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'architect', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const blockEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(blockEvents.length, 0, 'Non-reviewer subagent must not emit reviewer_dimensions_block_missing.');
    assert.equal(r.status, 0, 'Exit 0 for architect. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 5b: non-reviewer spawn (developer) without the block → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE; // no dimensions block
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt },
    });
    const events = readAuditEvents(r.tmp);
    const blockEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(blockEvents.length, 0, 'Non-reviewer subagent must not emit reviewer_dimensions_block_missing.');
    assert.equal(r.status, 0, 'Exit 0 for developer. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });

  test('Test 6: ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED=1 → 0 emits', () => {
    const prompt = SCOPED_PROMPT_BASE; // no dimensions block
    const r = runHook(
      {
        tool_name: 'Agent',
        tool_input: { subagent_type: 'reviewer', prompt },
      },
      { ORCHESTRAY_REVIEWER_DIMENSIONS_CHECK_DISABLED: '1' }
    );
    const events = readAuditEvents(r.tmp);
    const blockEvents = events.filter(e => e.type === 'reviewer_dimensions_block_missing');
    assert.equal(blockEvents.length, 0, 'Kill switch must suppress reviewer_dimensions_block_missing emit.');
    assert.equal(r.status, 0, 'Exit 0 with kill switch. stderr=' + r.stderr.slice(0, 200));
    cleanup(r.tmp);
  });
});
