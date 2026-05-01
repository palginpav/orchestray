#!/usr/bin/env node
'use strict';

/**
 * v222-bucket-a-fixes.test.js — v2.2.2 Bucket A fixes A2 / A3 / A4 / A5.
 *
 * One file covers four trivial parser/regex/rename fixes plus the
 * hooks.json phase-slice dedup. A1 is covered by an updated test in
 * `p21-cache-invariant.test.js`. B1 is in `v222-bucket-b-fixes.test.js`.
 * B2 is in `audit-event-writer-dedup.test.js`.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v222-bucket-a-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Fix A2 — gate-agent-spawn `model:` (was `default_model:`) frontmatter resolver
// ---------------------------------------------------------------------------

describe('v2.2.2 A2 — gate-agent-spawn frontmatter `model:` resolver', () => {

  // We test the Stage 2 helper logic directly by writing a fake agent file
  // and invoking the gate-agent-spawn module's relevant code path.
  // The cleanest entry is to read the file and check the regex match.

  function regexCheck(content) {
    // Mirror the Stage 2 regex from gate-agent-spawn.js after Fix A2.
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;
    const fmBlock = fmMatch[1];
    const m = fmBlock.match(/^model:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  }

  test('agent with `model: sonnet` frontmatter → resolves to "sonnet"', () => {
    const content = '---\nname: foo\nmodel: sonnet\n---\nbody';
    assert.equal(regexCheck(content), 'sonnet');
  });

  test('agent with `model: opus` frontmatter → resolves to "opus"', () => {
    const content = '---\nname: foo\nmodel: opus\n---\nbody';
    assert.equal(regexCheck(content), 'opus');
  });

  test('agent with `model: inherit` → matches but value is "inherit" (caller treats as miss)', () => {
    const content = '---\nname: foo\nmodel: inherit\n---\nbody';
    // Regex matches; downstream check at gate-agent-spawn.js:372 rejects 'inherit'.
    assert.equal(regexCheck(content), 'inherit');
  });

  test('agent with NO model line → null (Stage 2 misses, falls to Stage 3)', () => {
    const content = '---\nname: foo\ndescription: foo\n---\nbody';
    assert.equal(regexCheck(content), null);
  });

  test('legacy `default_model: opus` → null (rename is exclusive, NOT additive)', () => {
    // v2.2.2 Fix A2: the regex now reads `model:` only, so legacy `default_model:`
    // values are NOT picked up. Confirms the rename is a hard switch.
    const content = '---\nname: foo\ndefault_model: opus\n---\nbody';
    assert.equal(regexCheck(content), null);
  });

  test('actual reviewer.md file in this repo declares model: inherit (regression)', () => {
    const reviewerPath = path.join(REPO_ROOT, 'agents', 'reviewer.md');
    if (!fs.existsSync(reviewerPath)) return; // skip if file moved
    const content = fs.readFileSync(reviewerPath, 'utf8');
    const value = regexCheck(content);
    // Note: at v2.2.2 the reviewer agent declares `model: inherit`. Future
    // releases may flip this to opus or sonnet; the regression here is only
    // that the regex MUST find SOME value (not null).
    assert.ok(value !== null, 'reviewer.md must have a `model:` line that the regex finds');
  });
});

// ---------------------------------------------------------------------------
// Fix A3 — phase-slice parser accepts bold-list format
// ---------------------------------------------------------------------------

const phaseSliceMod = require('../inject-active-phase-slice.js');

describe('v2.2.2 A3 — phase-slice parser bold-list support', () => {

  function setupOrchFile(cwd, content) {
    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'orchestration.md'), content);
  }

  test('YAML frontmatter `current_phase: execute` → "execute" (regression)', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '---\ncurrent_phase: execute\n---\nbody');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'execute');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('bold-list `- **phase**: execute` → "execute"', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '# Orchestration\n\n- **orchestration_id**: orch-foo\n- **phase**: execute\n- **other**: x\n');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'execute');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('bold-list `- **current_phase**: verify` → "verify"', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '# Orch\n\n- **current_phase**: verify\n');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'verify');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('bold-list with quoted value → unwraps quotes', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '- **phase**: "decomp"\n');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'decomp');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('orchestration.md with neither format → null (existing fallback fires)', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '# Orchestration\n\nFreeform body with no phase reference.');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), null);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('missing orchestration.md → null', () => {
    const cwd = makeRepo();
    try {
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), null);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('YAML frontmatter takes precedence when both formats present', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '---\ncurrent_phase: close\n---\n\n- **phase**: execute\n');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'close');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fix A4 — reviewer-scope regex accepts backticked paths + heading FILE_MARKER
// ---------------------------------------------------------------------------

const reviewerScopeMod = require('../validate-reviewer-scope.js');

describe('v2.2.2 A4 — validate-reviewer-scope backtick + heading tolerance', () => {

  test('5 backticked-bullet paths → scoped (was: NOT scoped pre-A4)', () => {
    // Reproduces the W2 reviewer-spawn pattern that produced 0 bullet matches
    // in v2.2.1 (false-positive reviewer_scope_warn rate of 100%).
    const prompt = [
      '## Verification',
      '',
      '- `/home/palgin/orchestray/package.json` — confirm version',
      '- `/home/palgin/orchestray/.claude-plugin/plugin.json` — confirm plugin metadata',
      '- `/home/palgin/orchestray/agents/haiku-scout.md` — confirm exists',
      '- `/home/palgin/orchestray/agents/reviewer.md` — confirm exists',
      '- `/home/palgin/orchestray/CHANGELOG.md` — confirm v2.2.1 entry',
      '',
    ].join('\n');
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, true, 'expected scoped=true; evidence: ' + r.evidence);
  });

  test('5 un-backticked-bullet paths → still scoped (regression)', () => {
    const prompt = [
      'Please review:',
      '',
      '- src/foo.ts',
      '- src/bar.ts',
      '- src/baz.ts',
      '- src/qux.ts',
      '- src/quux.ts',
    ].join('\n');
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, true, 'expected scoped=true; evidence: ' + r.evidence);
  });

  test('`## Verification` heading + 0 bullets → scoped via new FILE_MARKER', () => {
    const prompt = '## Verification\n\nLook over things and report back.';
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, true, 'expected scoped=true; evidence: ' + r.evidence);
  });

  test('`### Files to verify` heading → scoped via new FILE_MARKER', () => {
    const prompt = '### Files to verify\n\n(see attachment).';
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, true, 'expected scoped=true');
  });

  test('`## Files to read` heading → scoped via new FILE_MARKER', () => {
    const prompt = '## Files to read\n\nList follows.';
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, true, 'expected scoped=true');
  });

  test('`## Files to review` heading → scoped via new FILE_MARKER', () => {
    const prompt = '## Files to review\n\nfoo';
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, true);
  });

  test('NO file references → still NOT scoped (warn fires; regression)', () => {
    const prompt = 'Please review the codebase for security issues. Look at everything.';
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, false);
  });

  test('2 backticked bullets → IS scoped (v2.2.21 W-CQ-6: threshold lowered from 3 to 1)', () => {
    // v2.2.21 T7: BULLET_PATH_THRESHOLD lowered from 3 to 1 to stop false-rejecting
    // 1-2 file hotfix/scoped reviews (W-CQ-6 finding). Two bullets are now accepted.
    const prompt = [
      'Just check these things:',
      '- `src/foo.ts`',
      '- `src/bar.ts`',
    ].join('\n');
    const r = reviewerScopeMod.evaluateScope(prompt);
    assert.equal(r.scoped, true, 'two bullets should now be scoped (threshold is 1); got ' + r.evidence);
  });
});

// ---------------------------------------------------------------------------
// Fix A5 — drop duplicate phase-slice hook registration
// ---------------------------------------------------------------------------

describe('v2.2.2 A5 — phase-slice hook registered exactly once', () => {

  test('inject-active-phase-slice.js appears exactly ONCE in hooks.json', () => {
    const hooksPath = path.join(REPO_ROOT, 'hooks', 'hooks.json');
    const text = fs.readFileSync(hooksPath, 'utf8');
    const matches = text.match(/inject-active-phase-slice\.js/g) || [];
    assert.equal(matches.length, 1,
      'expected exactly one registration of inject-active-phase-slice.js, got ' + matches.length);
  });

  test('inject-active-phase-slice.js appears in UserPromptSubmit chain (not SessionStart)', () => {
    const hooksPath = path.join(REPO_ROOT, 'hooks', 'hooks.json');
    const cfg = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const hooks = cfg.hooks || {};

    const inUserPromptSubmit = JSON.stringify(hooks.UserPromptSubmit || []).includes('inject-active-phase-slice.js');
    const inSessionStart     = JSON.stringify(hooks.SessionStart || []).includes('inject-active-phase-slice.js');

    assert.equal(inUserPromptSubmit, true, 'phase-slice hook must be in UserPromptSubmit');
    assert.equal(inSessionStart, false,
      'phase-slice hook must NOT be in SessionStart (v2.2.2 A5 dedup)');
  });
});
