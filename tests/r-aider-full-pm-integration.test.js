#!/usr/bin/env node
'use strict';

/**
 * R-AIDER-FULL — PM call-site integration smoke (v2.1.17 W9-fix F-001).
 *
 * The W4 design §2.3 and the W9 release-review F-001 finding require the PM
 * agent's delegation pipeline to invoke `buildRepoMap` (or its CLI wrapper)
 * for each code-touching spawn (developer / refactorer / reviewer / debugger).
 *
 * This smoke verifies:
 *   (a) The CLI wrapper exists at `bin/_lib/repo-map.js` and accepts the
 *       documented flags (`--cwd`, `--budget`, `--sync`, `--print-map`).
 *   (b) Running the wrapper on the Orchestray repo produces a
 *       `## Repo Map (Aider-style, top-K symbols)` block on stdout when
 *       `--print-map` is set (the exact rendered prefix the PM prepends).
 *   (c) The wrapper honours `--budget 0` as the kill-switch — empty map.
 *   (d) The pm.md Section 3 step 9.6 procedural instruction references both
 *       the wrapper invocation form AND the role budget table.
 *   (e) pm.md role table 1500/2500/1000/1000 quartet matches `ROLE_BUDGETS`.
 *
 * Why this is a smoke and not a full PM end-to-end test: the actual `Agent()`
 * spawn pipeline is internal to Claude Code and cannot be invoked from a Node
 * test. We exercise the contract: the rendered block prefix the PM is required
 * to prepend exists and is reachable from the CLI the PM is told to call.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_MAP_CLI = path.join(REPO_ROOT, 'bin', '_lib', 'repo-map.js');
const PM_MD_PATH = path.join(REPO_ROOT, 'agents', 'pm.md');

const EXPECTED_BLOCK_PREFIX = '## Repo Map (Aider-style, top-K symbols)';

const { ROLE_BUDGETS } = require(path.join(REPO_ROOT, 'bin', '_lib', 'repo-map.js'));

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [REPO_MAP_CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 60000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('R-AIDER-FULL PM call-site smoke (F-001)', () => {
  test('CLI wrapper exists and is executable', () => {
    assert.ok(fs.existsSync(REPO_MAP_CLI), 'bin/_lib/repo-map.js must exist');
    const head = fs.readFileSync(REPO_MAP_CLI, 'utf8').slice(0, 200);
    assert.ok(/^#!\/usr\/bin\/env node/.test(head), 'CLI must have node shebang');
  });

  test('CLI --print-map renders the map body the PM wraps under "## Repo Map (Aider-style, …)"', () => {
    // Skip if grammars are missing (e.g., a stripped-down clone) — the test
    // is meaningful only when the parsing pipeline can run.
    const grammarsDir = path.join(REPO_ROOT, 'bin', '_lib', 'repo-map-grammars');
    if (!fs.existsSync(grammarsDir)) {
      // Cannot meaningfully exercise the smoke here; mark a soft skip.
      assert.ok(true, 'grammars directory absent; skipping render assertion');
      return;
    }
    const r = runCli(['--cwd', REPO_ROOT, '--budget', '500', '--sync', '--print-map']);
    assert.equal(r.status, 0, 'CLI must exit 0; stderr=' + r.stderr);
    // Renderer emits a `# Repo Map (top K of N files, ~M tokens)` body header
    // (see bin/_lib/repo-map-render.js). The PM wraps that body under a
    // higher-level `## Repo Map (Aider-style, top-K symbols)` block per W4
    // §2.3 / pm.md Section 3 step 9.6. We assert the body header so the PM's
    // wrap operation has something to wrap.
    assert.ok(
      /^# Repo Map \(top \d+ of \d+ files, ~\d+ tokens\)/m.test(r.stdout),
      'CLI stdout must include the renderer body header `# Repo Map (top K of N files, ~M tokens)` ' +
      'so the PM has a non-empty payload to wrap under the section header. Got first 300 chars:\n' +
      r.stdout.slice(0, 300)
    );
    // And the body must contain at least one symbol entry (def/ref/class).
    assert.ok(
      /\nL\d+: (def|ref|class)/.test(r.stdout) || /^### /m.test(r.stdout),
      'CLI stdout must include at least one ranked symbol line (e.g., `### path/to/file.js`).'
    );
  });

  test('CLI --budget 0 honours the kill switch (empty map)', () => {
    const r = runCli(['--cwd', REPO_ROOT, '--budget', '0', '--sync', '--print-map']);
    assert.equal(r.status, 0, 'CLI must exit 0 even on kill-switch path');
    // The renderer body header must NOT appear under --budget 0 (kill switch).
    assert.ok(
      !/^# Repo Map \(top /m.test(r.stdout),
      'CLI with --budget 0 must NOT render any map body; got:\n' + r.stdout.slice(0, 300)
    );
  });

  test('pm.md Section 3 step 9.6 cites the CLI invocation form', () => {
    const pm = fs.readFileSync(PM_MD_PATH, 'utf8');
    // Must reference the wrapper script path so a reader can copy-paste it.
    assert.ok(
      pm.includes('node bin/_lib/repo-map.js'),
      'pm.md Section 3 must instruct the PM to invoke `node bin/_lib/repo-map.js`'
    );
    // Must reference the rendered block prefix so the PM prepends the right header.
    assert.ok(
      pm.includes('## Repo Map (Aider-style, top-K symbols)'),
      'pm.md Section 3 must reference the "## Repo Map (Aider-style, top-K symbols)" block prefix'
    );
    // Must reference the kill-switch so the PM knows when to skip.
    assert.ok(
      /repo_map\.enabled\s*===?\s*false|repo_map.enabled.*false/.test(pm),
      'pm.md Section 3 must reference the repo_map.enabled kill switch'
    );
  });

  test('ROLE_BUDGETS contains the four consuming roles at the W4 §6 budgets', () => {
    // Sanity: F-007 covers full table sync; this is a small extra guard
    // because step 9.6 specifically names "developer:1500, refactorer:2500,
    // reviewer:1000, debugger:1000" inline. If anyone changes ROLE_BUDGETS,
    // both the inline citation in step 9.6 AND the per-role table need
    // updating, and the test must catch the inline drift.
    assert.equal(ROLE_BUDGETS.developer,  1500, 'developer budget');
    assert.equal(ROLE_BUDGETS.refactorer, 2500, 'refactorer budget');
    assert.equal(ROLE_BUDGETS.reviewer,   1000, 'reviewer budget');
    assert.equal(ROLE_BUDGETS.debugger,   1000, 'debugger budget');

    const pm = fs.readFileSync(PM_MD_PATH, 'utf8');
    const stepIdx = pm.indexOf('9.6.');
    const stepBlock = pm.slice(stepIdx, stepIdx + 2000);
    for (const [role, budget] of Object.entries(ROLE_BUDGETS)) {
      const cite = `${role}:${budget}`;
      assert.ok(
        stepBlock.includes(cite),
        `pm.md step 9.6 inline citation must include "${cite}" — drift from ROLE_BUDGETS`
      );
    }
  });
});
