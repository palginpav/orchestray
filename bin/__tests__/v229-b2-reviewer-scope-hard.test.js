#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.2.9 B-2.3 — reviewer-scope warn→hard flip.
 *
 * Coverage:
 *   - Reviewer with no file list against non-empty upstream files_changed → exit 2
 *   - reviewer_scope_blocked event emitted (not reviewer_scope_warn)
 *   - ORCHESTRAY_REVIEWER_SCOPE_HARD_DISABLED=1 reverts to warn-only (exit 0)
 *   - Reviewer with explicit file list → exit 0 (no block)
 *   - Non-reviewer subagent → pass-through (exit 0)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'validate-reviewer-scope.js');

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b23-'));
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

describe('v229-b2.3 — reviewer-scope hard-reject', () => {
  test('reviewer with no file list → exit 2 (hard block)', () => {
    const r = runHook({
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'reviewer',
        prompt: 'Please review my recent work for issues.',
      },
    });
    assert.equal(r.status, 2, 'should block (exit 2). stderr=' + r.stderr.slice(0, 200));
    const events = readAuditEvents(r.tmp);
    const blocked = events.find(e => e.type === 'reviewer_scope_blocked');
    assert.ok(blocked, 'reviewer_scope_blocked event must be emitted');
    assert.equal(blocked.hard_disabled, false, 'hard_disabled must be false');
    assert.equal(blocked.missing_block, '## Files to Review');
    cleanup(r.tmp);
  });

  test('kill switch ORCHESTRAY_REVIEWER_SCOPE_HARD_DISABLED=1 reverts to warn-only (exit 0)', () => {
    const r = runHook(
      {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'reviewer',
          prompt: 'Please review my recent work.',
        },
      },
      { ORCHESTRAY_REVIEWER_SCOPE_HARD_DISABLED: '1' }
    );
    assert.equal(r.status, 0, 'kill switch must revert to warn-only');
    const events = readAuditEvents(r.tmp);
    // With kill switch: reviewer_scope_warn (not reviewer_scope_blocked)
    const warned = events.find(e => e.type === 'reviewer_scope_warn');
    assert.ok(warned, 'reviewer_scope_warn event must be emitted when kill switch is active');
    assert.equal(warned.hard_disabled, true, 'hard_disabled flag must be true');
    cleanup(r.tmp);
  });

  test('reviewer with explicit ## Files to Review section → exit 0', () => {
    const prompt = [
      'Please review the following changes.',
      '',
      '## Files to Review',
      '- bin/validate-task-completion.js',
      '- bin/_lib/role-schemas.js',
      '',
      'Check for correctness.',
    ].join('\n');
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    assert.equal(r.status, 0, 'explicit file list should pass');
    const events = readAuditEvents(r.tmp);
    const blocked = events.find(e => e.type === 'reviewer_scope_blocked');
    assert.ok(!blocked, 'reviewer_scope_blocked must NOT be emitted when scope is explicit');
    cleanup(r.tmp);
  });

  test('reviewer with explicit files: marker → exit 0', () => {
    const prompt = 'Review this work.\n\nfiles:\n- bin/foo.js\n- bin/bar.js\n- bin/baz.js\n';
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'reviewer', prompt },
    });
    assert.equal(r.status, 0);
    cleanup(r.tmp);
  });

  test('developer subagent → pass-through exit 0 (not gated)', () => {
    const r = runHook({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'Do some work' },
    });
    assert.equal(r.status, 0, 'non-reviewer subagent must always pass');
    cleanup(r.tmp);
  });

  test('non-Agent tool → pass-through exit 0', () => {
    const r = runHook({
      tool_name: 'Task',
      tool_input: { subagent_type: 'reviewer', prompt: 'Review everything' },
    });
    assert.equal(r.status, 0, 'non-Agent tool must pass through');
    cleanup(r.tmp);
  });
});

// Unit tests for the exported evaluateScope function (unchanged behavior)
describe('v229-b2.3 — evaluateScope still works correctly', () => {
  const mod = require('../validate-reviewer-scope.js');

  test('detects ## Files to Review heading', () => {
    const r = mod.evaluateScope('# Review\n\n## Files to Review\n- foo.ts\n');
    assert.equal(r.scoped, true);
  });

  test('detects files: marker', () => {
    const r = mod.evaluateScope('files:\n- src/auth.ts\n- src/login.ts\n');
    assert.equal(r.scoped, true);
  });

  test('returns scoped=false without markers', () => {
    const r = mod.evaluateScope('Review my recent code changes for issues.');
    assert.equal(r.scoped, false);
  });
});
