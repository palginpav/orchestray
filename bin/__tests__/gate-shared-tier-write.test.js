#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.3.30 W1 D7 — gate-shared-tier-write.js.
 *
 * IMPORTANT: every fixture points the shared root at a per-test tmpdir via
 * ORCHESTRAY_TEST_SHARED_DIR. No test may resolve to, or write under, the
 * operator's real ~/.orchestray/shared/.
 *
 * Coverage:
 *   - subagent (role present) writing under the shared root → blocked (exit 2)
 *   - operator (no role) writing under the shared root → NOT blocked
 *   - "shared-old" sibling directory is not treated as "under" the shared root
 *     (boundary check, not prefix check)
 *   - stdin overflow fails CLOSED
 *   - unparseable JSON fails OPEN
 *   - env kill switch (ORCHESTRAY_SHARED_TIER_WRITE_GATE_DISABLED=1)
 *   - config kill switch (.orchestray/config.json shared_tier_write_gate.enabled=false)
 *   - shared_tier_write_blocked event emitted on block, naming pattern_promote
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mod = require('../gate-shared-tier-write.js');
const HOOK = path.resolve(__dirname, '..', 'gate-shared-tier-write.js');

// ---------------------------------------------------------------------------
// Unit: isUnderRoot boundary check
// ---------------------------------------------------------------------------

describe('v2330-w1 — isUnderRoot boundary check', () => {
  const { isUnderRoot } = mod;

  test('exact root matches', () => {
    assert.ok(isUnderRoot('/home/x/.orchestray/shared', '/home/x/.orchestray/shared'));
  });

  test('nested path matches', () => {
    assert.ok(isUnderRoot('/home/x/.orchestray/shared/patterns/foo.md', '/home/x/.orchestray/shared'));
  });

  test('"shared-old" sibling does NOT match (boundary, not prefix)', () => {
    assert.ok(!isUnderRoot('/home/x/.orchestray/shared-old/patterns/foo.md', '/home/x/.orchestray/shared'));
  });

  test('unrelated path does not match', () => {
    assert.ok(!isUnderRoot('/home/x/project/bin/foo.js', '/home/x/.orchestray/shared'));
  });
});

// ---------------------------------------------------------------------------
// Integration harness
// ---------------------------------------------------------------------------

function setupTmp() {
  const projectTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2330-w1-proj-'));
  const sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2330-w1-shared-'));
  return { projectTmp, sharedTmp };
}

function runHook(payload, { projectTmp, sharedTmp, extraEnv = {}, rawInput = null } = {}) {
  const env = { ...process.env, ...extraEnv };
  if (sharedTmp) env.ORCHESTRAY_TEST_SHARED_DIR = sharedTmp;
  const res = spawnSync('node', [HOOK], {
    input: rawInput !== null ? rawInput : JSON.stringify(payload),
    cwd: projectTmp,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  return res;
}

function readAuditEvents(projectTmp) {
  const p = path.join(projectTmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
}

// ORCHESTRAY_TEST_SHARED_DIR/patterns is the resolved patterns dir; the
// "root" the gate guards is its parent, i.e. sharedTmp itself.
function sharedPatternFile(sharedTmp, name) {
  return path.join(sharedTmp, 'patterns', name);
}

describe('v2330-w1 — integration: subagent blocked, operator not blocked', () => {
  test('subagent (curator) writing under shared root → exit 2', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    const target = sharedPatternFile(sharedTmp, 'some-pattern.md');
    const r = runHook(
      { tool_name: 'Write', agent_role: 'curator', tool_input: { file_path: target } },
      { projectTmp, sharedTmp }
    );
    assert.equal(r.status, 2, 'expected exit 2. stderr=' + r.stderr.slice(0, 300));
    assert.match(r.stderr, /mcp__orchestray__pattern_promote/);
    const events = readAuditEvents(projectTmp);
    const blocked = events.find(e => e.type === 'shared_tier_write_blocked');
    assert.ok(blocked, 'shared_tier_write_blocked event must be emitted');
    assert.equal(blocked.agent_role, 'curator');
    assert.equal(blocked.hook, 'gate-shared-tier-write');
    cleanup(projectTmp, sharedTmp);
  });

  test('operator (no role) writing under shared root → exit 0 (NOT blocked)', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    const target = sharedPatternFile(sharedTmp, 'some-pattern.md');
    const r = runHook(
      { tool_name: 'Write', tool_input: { file_path: target } },
      { projectTmp, sharedTmp }
    );
    assert.equal(r.status, 0, 'operator session must never be blocked. stderr=' + r.stderr.slice(0, 300));
    const events = readAuditEvents(projectTmp);
    assert.equal(events.find(e => e.type === 'shared_tier_write_blocked'), undefined);
    cleanup(projectTmp, sharedTmp);
  });

  test('any other subagent role (e.g. developer) writing under shared root → exit 2', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    const target = sharedPatternFile(sharedTmp, 'some-pattern.md');
    const r = runHook(
      { tool_name: 'Edit', agent_role: 'developer', tool_input: { file_path: target } },
      { projectTmp, sharedTmp }
    );
    assert.equal(r.status, 2, 'every subagent, not just curator, must be blocked');
    cleanup(projectTmp, sharedTmp);
  });

  test('subagent writing OUTSIDE the shared root → exit 0', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    const r = runHook(
      { tool_name: 'Write', agent_role: 'curator', tool_input: { file_path: path.join(projectTmp, 'notes.md') } },
      { projectTmp, sharedTmp }
    );
    assert.equal(r.status, 0);
    cleanup(projectTmp, sharedTmp);
  });
});

describe('v2330-w1 — integration: shared-old boundary bypass resists', () => {
  test('"shared-old" sibling of the ORCHESTRAY_TEST_SHARED_DIR root is not blocked', () => {
    // ORCHESTRAY_TEST_SHARED_DIR resolves to <sharedTmp>/patterns; the guarded
    // root is <sharedTmp>. A sibling directory <sharedTmp>-old must not match.
    const { projectTmp, sharedTmp } = setupTmp();
    const siblingOld = sharedTmp + '-old';
    fs.mkdirSync(siblingOld, { recursive: true });
    const target = path.join(siblingOld, 'patterns', 'foo.md');
    const r = runHook(
      { tool_name: 'Write', agent_role: 'curator', tool_input: { file_path: target } },
      { projectTmp, sharedTmp }
    );
    assert.equal(r.status, 0, 'a sibling "-old" dir must not be treated as under the shared root');
    cleanup(projectTmp, sharedTmp, siblingOld);
  });
});

describe('v2330-w1 — integration: fail-closed / fail-open behavior', () => {
  test('stdin overflow fails CLOSED (exit 2)', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    // MAX_INPUT_BYTES is 1MB; build an oversized raw payload.
    const oversized = 'x'.repeat(1024 * 1024 + 10);
    const r = runHook(null, { projectTmp, sharedTmp, rawInput: oversized });
    assert.equal(r.status, 2, 'oversized stdin must fail closed');
    cleanup(projectTmp, sharedTmp);
  });

  test('unparseable JSON fails OPEN (exit 0)', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    const r = runHook(null, { projectTmp, sharedTmp, rawInput: '{not valid json' });
    assert.equal(r.status, 0, 'malformed JSON must fail open, not wedge the write');
    cleanup(projectTmp, sharedTmp);
  });

  test('no shared dir configured (ORCHESTRAY_TEST_SHARED_DIR unset) → exit 0', () => {
    const { projectTmp } = setupTmp();
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Write',
        agent_role: 'curator',
        tool_input: { file_path: path.join(projectTmp, 'notes.md') },
      }),
      cwd: projectTmp,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, ORCHESTRAY_TEST_SHARED_DIR: '' },
    });
    assert.equal(r.status, 0);
    cleanup(projectTmp);
  });
});

describe('v2330-w1 — integration: kill switches', () => {
  test('ORCHESTRAY_SHARED_TIER_WRITE_GATE_DISABLED=1 bypasses the gate', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    const target = sharedPatternFile(sharedTmp, 'some-pattern.md');
    const r = runHook(
      { tool_name: 'Write', agent_role: 'curator', tool_input: { file_path: target } },
      { projectTmp, sharedTmp, extraEnv: { ORCHESTRAY_SHARED_TIER_WRITE_GATE_DISABLED: '1' } }
    );
    assert.equal(r.status, 0, 'env kill switch must bypass the gate');
    cleanup(projectTmp, sharedTmp);
  });

  test('config shared_tier_write_gate.enabled=false bypasses the gate', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    fs.mkdirSync(path.join(projectTmp, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(projectTmp, '.orchestray', 'config.json'),
      JSON.stringify({ shared_tier_write_gate: { enabled: false } }, null, 2)
    );
    const target = sharedPatternFile(sharedTmp, 'some-pattern.md');
    const r = runHook(
      { tool_name: 'Write', agent_role: 'curator', tool_input: { file_path: target } },
      { projectTmp, sharedTmp }
    );
    assert.equal(r.status, 0, 'config kill switch must bypass the gate');
    cleanup(projectTmp, sharedTmp);
  });

  test('default (no config, no env) is ON — gate still blocks', () => {
    const { projectTmp, sharedTmp } = setupTmp();
    const target = sharedPatternFile(sharedTmp, 'some-pattern.md');
    const r = runHook(
      { tool_name: 'Write', agent_role: 'curator', tool_input: { file_path: target } },
      { projectTmp, sharedTmp }
    );
    assert.equal(r.status, 2, 'gate must default to enabled');
    cleanup(projectTmp, sharedTmp);
  });
});
