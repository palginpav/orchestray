#!/usr/bin/env node
'use strict';

/**
 * Tests for W2 of the v2.2.18 release — prose de-conflict.
 *
 * Validates:
 *   1. agents/developer.md has no "Never commit" lines.
 *   2. agents/refactorer.md has no "Never commit" lines.
 *   3. agents/pm-reference/agent-common-protocol.md contains the
 *      "Worktree Auto-Commit Safety Net" subsection.
 *   4. validate-commit-handoff.js trailer exemption (positive):
 *      a commit body with the W1 trailer skips commit_handoff_body_missing.
 *   5. validate-commit-handoff.js trailer exemption (negative):
 *      a commit body WITHOUT the trailer still emits commit_handoff_body_missing.
 *
 * Runner: node --test bin/__tests__/v2218-w2-prose-deconflict.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const cp   = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK      = path.resolve(__dirname, '..', 'validate-commit-handoff.js');

const AUTO_COMMIT_TRAILER = 'Generated-By: orchestray-auto-commit-worktree';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSrBlock(sr) {
  return '## Structured Result\n```json\n' + JSON.stringify(sr, null, 2) + '\n```\n';
}

/**
 * Run validate-commit-handoff.js against a tmp dir with a fake git repo.
 * `commitBody` is written as the HEAD commit body.
 * Returns { status, bodyMissingEvents, stdout, stderr }.
 */
function runHookWithCommit(role, sr, commitBody, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vch-w2-'));
  try {
    // Init a bare git repo so git log -1 works.
    cp.execFileSync('git', ['init', '--initial-branch=main'], { cwd: tmp, stdio: 'ignore' });
    cp.execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=T', 'commit',
      '--allow-empty', '-m', commitBody], { cwd: tmp, stdio: 'ignore' });

    const event = {
      tool_name: 'Agent',
      tool_input: { subagent_type: role },
      tool_response: { output: makeSrBlock(sr) },
      cwd: tmp,
    };

    const res = cp.spawnSync('node', [HOOK], {
      input: JSON.stringify(event),
      cwd: tmp,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED: '1', // avoid exit-2 in tests
        ...env,
      },
    });

    const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    let bodyMissingEvents = [];
    if (fs.existsSync(eventsPath)) {
      bodyMissingEvents = fs.readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(e => e && e.type === 'commit_handoff_body_missing');
    }

    return { status: res.status, bodyMissingEvents, stdout: res.stdout, stderr: res.stderr };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. developer.md — no "Never commit"
// ---------------------------------------------------------------------------

describe('agents/developer.md — never-commit removal', () => {
  test('grep returns 0 lines for "Never commit"', () => {
    const devMd = path.join(REPO_ROOT, 'agents', 'developer.md');
    const content = fs.readFileSync(devMd, 'utf8');
    const matches = content.match(/Never commit/g);
    assert.equal(matches, null,
      'developer.md still contains "Never commit" — W2 deletion incomplete');
  });
});

// ---------------------------------------------------------------------------
// 2. refactorer.md — no "Never commit"
// ---------------------------------------------------------------------------

describe('agents/refactorer.md — never-commit removal', () => {
  test('grep returns 0 lines for "Never commit"', () => {
    const refMd = path.join(REPO_ROOT, 'agents', 'refactorer.md');
    const content = fs.readFileSync(refMd, 'utf8');
    const matches = content.match(/Never commit/g);
    assert.equal(matches, null,
      'refactorer.md still contains "Never commit" — W2 deletion incomplete');
  });
});

// ---------------------------------------------------------------------------
// 3. agent-common-protocol.md — subsection presence
// ---------------------------------------------------------------------------

describe('agents/pm-reference/agent-common-protocol.md — safety-net subsection', () => {
  test('contains "Worktree Auto-Commit Safety Net" heading', () => {
    const acp = path.join(REPO_ROOT, 'agents', 'pm-reference', 'agent-common-protocol.md');
    const content = fs.readFileSync(acp, 'utf8');
    assert.ok(
      content.includes('Worktree Auto-Commit Safety Net'),
      'agent-common-protocol.md missing the W2 safety-net subsection'
    );
  });

  test('subsection mentions the W1 trailer string', () => {
    const acp = path.join(REPO_ROOT, 'agents', 'pm-reference', 'agent-common-protocol.md');
    const content = fs.readFileSync(acp, 'utf8');
    assert.ok(
      content.includes(AUTO_COMMIT_TRAILER),
      'agent-common-protocol.md safety-net subsection does not mention the W1 trailer'
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Trailer exemption — positive: auto-commit trailer suppresses body-missing event
// ---------------------------------------------------------------------------

describe('validate-commit-handoff — trailer exemption (positive)', () => {
  test('commit body with W1 trailer skips commit_handoff_body_missing', () => {
    const sr = {
      status: 'success',
      files_changed: [{ path: 'foo.js' }],
      summary: 'wip auto-commit',
      issues: [],
      assumptions: [],
    };
    // Body includes the W1 trailer but no `## Handoff` block.
    const commitBody = 'wip: auto-commit by orchestray\n\n' + AUTO_COMMIT_TRAILER + '\n';

    const { bodyMissingEvents } = runHookWithCommit('developer', sr, commitBody);
    assert.equal(bodyMissingEvents.length, 0,
      'commit_handoff_body_missing event was emitted for an auto-commit (should be exempted)');
  });
});

// ---------------------------------------------------------------------------
// 5. Trailer exemption — negative: no trailer still emits body-missing
// ---------------------------------------------------------------------------

describe('validate-commit-handoff — trailer exemption (negative)', () => {
  test('commit body without trailer still emits commit_handoff_body_missing', () => {
    const sr = {
      status: 'success',
      files_changed: [{ path: 'bar.js' }],
      summary: 'some work',
      issues: [],
      assumptions: [],
    };
    // Body has no W1 trailer and no `## Handoff` block — should trigger event.
    const commitBody = 'fix: something important\n\nDid a thing.\n';

    const { bodyMissingEvents } = runHookWithCommit('developer', sr, commitBody);
    assert.equal(bodyMissingEvents.length, 1,
      'commit_handoff_body_missing event was NOT emitted for a regular commit missing ## Handoff');
  });
});
