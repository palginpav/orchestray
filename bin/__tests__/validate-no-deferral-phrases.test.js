#!/usr/bin/env node
'use strict';

/**
 * v2.2.15 FN-50 — regression tests for FN-49's three new DEFERRAL_PATTERNS
 * entries (`+ candidate`, `left as v`, `next-release candidate`).
 *
 * Coverage (≥4 cases per spec):
 *   1. v2.2.14 CHANGELOG line-53 string ("left as v2.2.15+ candidate") in a
 *      release-tagged orchestration → exit 2.
 *   2. Bare "+ candidate" near a release cue (release/ship/v2.x) → exit 2.
 *   3. "next-release candidate" (strict:true; requires no release-cue) → exit 2.
 *   4. Happy path: release-phase output without deferral language → exit 0.
 *   5. Outside release-phase: deferral language is harmless → exit 0.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'validate-no-deferral.js');
const NODE = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot({ release = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn50-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  if (release) {
    // Write an orchestration.md frontmatter that flags the orch as release-phase.
    const frontmatter = [
      '---',
      'title: v2.2.15 release ceremony',
      'phase: release',
      'task_flags: ["release"]',
      '---',
      '',
      '# v2.2.15 release',
      '',
    ].join('\n');
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'state', 'orchestration.md'),
      frontmatter,
      'utf8'
    );
  }
  return dir;
}

function runHook(payload, env = {}) {
  const cwd = makeTmpRoot({ release: payload._release !== false });
  const eventPayload = { ...payload, cwd };
  delete eventPayload._release;
  const baseEnv = Object.assign({}, process.env);
  // Clear any operator-side kill switches.
  delete baseEnv.ORCHESTRAY_NO_DEFERRAL_DISABLED;
  const r = spawnSync(NODE, [HOOK], {
    input: JSON.stringify(eventPayload),
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...baseEnv, ...env },
  });
  return { ...r, tmp: cwd };
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.15 FN-50 — DEFERRAL_PATTERNS regression for FN-49 phrases', () => {
  test('Test 1: v2.2.14 line-53 string "left as v2.2.15+ candidate" → exit 2 in release phase', () => {
    const r = runHook({
      output: 'G-17 MCP audit cwd misroute is left as v2.2.15+ candidate per the deferral note.',
      task_flags: ['release'],
    });
    assert.equal(r.status, 2, 'must block. stderr=' + r.stderr.slice(0, 300));
    assert.match(r.stderr, /deferral language/, 'stderr should explain block reason');
    cleanup(r.tmp);
  });

  test('Test 2: bare "+ candidate" near a release cue → exit 2 in release phase', () => {
    const r = runHook({
      output: 'For v2.2.15 release: this finding is + candidate for follow-up triage.',
      task_flags: ['release'],
    });
    assert.equal(r.status, 2, 'must block "+ candidate" near release cue. stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('Test 3: strict phrase "next-release candidate" → exit 2 in release phase', () => {
    const r = runHook({
      output: 'F-2 is a next-release candidate.',
      task_flags: ['release'],
    });
    assert.equal(r.status, 2, 'strict phrase must block unconditionally. stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('Test 4 (happy path): release output without deferral language → exit 0', () => {
    const r = runHook({
      output: 'v2.2.15 ships with all 51 FIX-NOW items applied. CHANGELOG is operator-readable.',
      task_flags: ['release'],
    });
    assert.equal(r.status, 0, 'clean release output must pass. stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('Test 5: outside release-phase, deferral phrases are harmless → exit 0', () => {
    const r = runHook({
      output: 'Refactor: this routing tier is left as v2.0.18 placeholder for future cleanup.',
      // No task_flags=release; no release-phase orchestration state.
      _release: false,
    });
    assert.equal(r.status, 0, 'non-release-phase must never block. stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });

  test('Test 6: "left as v" pairs with a version-cue inside the context window → exit 2', () => {
    const r = runHook({
      output: 'B-7 is left as v2.2.16 follow-up; rest ships in v2.2.15.',
      task_flags: ['release'],
    });
    assert.equal(r.status, 2, 'left-as version idiom must block in release phase. stderr=' + r.stderr.slice(0, 300));
    cleanup(r.tmp);
  });
});
