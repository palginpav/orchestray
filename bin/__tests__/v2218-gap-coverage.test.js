#!/usr/bin/env node
'use strict';

/**
 * v2218-gap-coverage.test.js — G6 gap analysis for v2.2.18 W-items.
 *
 * Covers 5 high-value gaps identified during tester gap analysis:
 *
 *   GAP-1 (W1): Config kill switch `worktree_auto_commit.enabled: false` in
 *               .orchestray/config.json prevents auto-commit. Only the env-var
 *               kill switch was tested; the config path was untested.
 *
 *   GAP-2 (W1+W3 independence): W1 disabled (env var) does NOT prevent W3 from
 *               committing master-tree edits. The two kill switches are fully
 *               independent — disabling worktree commits must not affect master
 *               commits and vice versa.
 *
 *   GAP-3 (W1+W2 cross-W): W1 auto-commit trailer in HEAD causes W2's
 *               validate-commit-handoff.js to be silent (no commit_handoff_body_missing
 *               event). Integration test exercising BOTH hooks sequentially.
 *
 *   GAP-4 (W9): orchestration_start with task=null emits ZERO schema_shadow_validation_block
 *               events. The W9 test asserts doesNotThrow + event written, but never
 *               verifies the schema validator did not block and emit a surrogate.
 *
 *   GAP-5 (W3+W1 combo): Both kill switches simultaneously engaged (W1 disabled AND
 *               W3 disabled) leaves master and worktree trees unchanged — the dual-kill
 *               scenario must not panic or leave partial state.
 *
 * Runner: node --test bin/__tests__/v2218-gap-coverage.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NODE = process.execPath;

const W1_HOOK = path.join(REPO_ROOT, 'bin', 'auto-commit-worktree-on-subagent-stop.js');
const W3_HOOK = path.join(REPO_ROOT, 'bin', 'auto-commit-master-on-pm-stop.js');
const W2_HOOK = path.join(REPO_ROOT, 'bin', 'validate-commit-handoff.js');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Create a master git repo + a linked worktree.
 * Returns { base, masterDir, worktreeDir, cleanup }.
 */
function makeWorktreeSetup({ orchId = 'orch-gap-001' } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-gap-'));
  const masterDir = path.join(base, 'master');
  fs.mkdirSync(masterDir, { recursive: true });

  const gitOpts = {
    cwd: masterDir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: base },
  };

  execSync('git init -b main', gitOpts);
  execSync('git config user.email test@local', gitOpts);
  execSync('git config user.name test', gitOpts);

  // .gitignore .orchestray so state files don't pollute git status
  fs.writeFileSync(path.join(masterDir, '.gitignore'), '.orchestray/\n');
  fs.writeFileSync(path.join(masterDir, 'README.md'), 'init');
  execSync('git add -A', gitOpts);
  execSync('git commit -m "init"', gitOpts);

  const worktreeDir = path.join(base, 'worktree');
  execSync(`git worktree add -b wt-branch "${worktreeDir}"`, gitOpts);

  // Scaffold .orchestray in worktree (gitignored, so no commit needed).
  // Add a tracked file so the worktree branch has at least one commit
  // (the initial checkout creates the worktree from the HEAD of master,
  // so there is already a commit — we just need to create the audit dir).
  scaffoldOrchestray(worktreeDir, orchId);

  return {
    base,
    masterDir,
    worktreeDir,
    cleanup: () => {
      try { fs.rmSync(base, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

function scaffoldOrchestray(dir, orchId = 'test-orch-001') {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function writeOrchestrationMd(dir, opts = {}) {
  const status = opts.status || 'active';
  const orchestrationId = opts.orchestration_id || 'orch-gap-001';
  const currentPhase = opts.current_phase || 'execute';
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'orchestration.md'),
    [
      '---',
      'orchestration_id: ' + orchestrationId,
      'status: ' + status,
      'current_phase: ' + currentPhase,
      '---',
      '',
      '# Test orchestration',
    ].join('\n')
  );
}

function countCommits(dir) {
  try {
    return parseInt(
      execSync('git rev-list --count HEAD', { cwd: dir, encoding: 'utf8' }).trim(),
      10
    );
  } catch (_e) {
    return 0;
  }
}

function gitLog1Body(dir) {
  try {
    return execSync('git log -1 --format=%B HEAD', { cwd: dir, encoding: 'utf8' }).trim();
  } catch (_e) {
    return '';
  }
}

function runHookStdin(scriptPath, stdinData, envOverrides = {}, cwdOverride) {
  const r = spawnSync(NODE, [scriptPath], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 15000,
    cwd: cwdOverride,
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status || 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// GAP-1: W1 config kill switch — worktree_auto_commit.enabled: false
// ---------------------------------------------------------------------------

describe('GAP-1: W1 config kill switch (worktree_auto_commit.enabled: false)', () => {
  test('config.enabled=false in .orchestray/config.json prevents auto-commit on dirty worktree', () => {
    const { worktreeDir, cleanup } = makeWorktreeSetup();
    try {
      // Write a dirty file so the worktree has something to commit.
      fs.writeFileSync(path.join(worktreeDir, 'dirty-gap1.txt'), 'should not be committed');

      // Write config with worktree_auto_commit.enabled = false
      const configDir = path.join(worktreeDir, '.orchestray');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ worktree_auto_commit: { enabled: false } })
      );

      const commitsBefore = countCommits(worktreeDir);

      const r = runHookStdin(
        W1_HOOK,
        JSON.stringify({ hook_event_name: 'SubagentStop', agent_role: 'developer', cwd: worktreeDir, session_id: 'sess-gap1' }),
        {} // no env kill switch — only config
      );

      assert.equal(r.status, 0, 'hook must exit 0 even when config kill switch is set; stderr: ' + r.stderr);
      assert.equal(
        countCommits(worktreeDir),
        commitsBefore,
        'config kill switch must prevent auto-commit; hook incorrectly committed'
      );

      // No worktree_auto_commit_emitted event should appear
      const events = readEvents(worktreeDir);
      const emitted = events.filter(e => e.type === 'worktree_auto_commit_emitted');
      assert.equal(emitted.length, 0, 'no worktree_auto_commit_emitted event when config kill switch is set');
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// GAP-2: W1 + W3 independence — disabling W1 does NOT prevent W3 master commit
// ---------------------------------------------------------------------------

describe('GAP-2: W1+W3 independence — W1 kill switch does not affect W3', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-gap2-'));
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.local"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.orchestray/\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'init\n');
    execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore', shell: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
  });

  test('W1 env kill switch set — W3 master hook still commits dirty master tree', () => {
    writeOrchestrationMd(tmpDir, { status: 'active', orchestration_id: 'orch-gap2-001' });
    // Dirty master tree
    fs.writeFileSync(path.join(tmpDir, 'master-dirty.txt'), 'master edits');

    const commitsBefore = countCommits(tmpDir);

    // Run W3 with W1's kill switch set (should be irrelevant to W3)
    const r = runHookStdin(
      W3_HOOK,
      JSON.stringify({ cwd: tmpDir }),
      { ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED: '1' } // W1 kill switch, not W3's
    );

    assert.equal(r.status, 0, 'W3 hook must exit 0; stderr: ' + r.stderr.slice(0, 400));
    assert.equal(
      countCommits(tmpDir),
      commitsBefore + 1,
      'W3 must commit master tree even when W1 env kill switch is set'
    );

    const body = gitLog1Body(tmpDir);
    assert.match(body, /^wip\(orch orch-gap2-001 stop /, 'W3 commit subject must be wip(orch ...) pattern');
    assert.ok(
      body.includes('Generated-By: orchestray-auto-commit-master'),
      'W3 commit body must contain Generated-By: orchestray-auto-commit-master'
    );
  });

  test('W3 env kill switch set — W3 does NOT commit master tree', () => {
    writeOrchestrationMd(tmpDir, { status: 'active', orchestration_id: 'orch-gap2-002' });
    fs.writeFileSync(path.join(tmpDir, 'master-dirty2.txt'), 'master edits');

    const commitsBefore = countCommits(tmpDir);

    const r = runHookStdin(
      W3_HOOK,
      JSON.stringify({ cwd: tmpDir }),
      { ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED: '1' } // W3's own kill switch
    );

    assert.equal(r.status, 0, 'W3 hook must exit 0 with its own kill switch');
    assert.equal(
      countCommits(tmpDir),
      commitsBefore,
      'W3 kill switch must prevent master commit'
    );
  });
});

// ---------------------------------------------------------------------------
// GAP-3: W1+W2 cross-W — W1 auto-commit trailer silences W2 gate
// ---------------------------------------------------------------------------

describe('GAP-3: W1+W2 integration — auto-commit trailer silences validate-commit-handoff gate', () => {
  test('W1 auto-commit HEAD causes W2 validate-commit-handoff to emit no commit_handoff_body_missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-gap3-'));
    try {
      // Set up a git repo where HEAD commit has the W1 trailer (as W1 would produce)
      execSync('git init --initial-branch=main', { cwd: tmp, stdio: 'ignore' });

      // Commit body: matches what W1 produces (wip(auto): subject + Generated-By trailer)
      const autoCommitBody = [
        'wip(auto): developer uncommitted edits captured by orchestray',
        '',
        'Agent: developer',
        'Orchestration: orch-gap3-001',
        'Session: sess-gap3',
        'Worktree: agent-xyz',
        'Files: 2 changed',
        'Generated-By: orchestray-auto-commit-worktree',
      ].join('\n');

      execSync(
        `git -c user.email=orchestray@local -c user.name=orchestray-auto-commit commit --allow-empty -m "${autoCommitBody.replace(/"/g, '\\"')}"`,
        { cwd: tmp, stdio: 'ignore' }
      );

      // Build a valid Structured Result as the W2 hook expects
      const sr = {
        status: 'success',
        files_changed: [{ path: 'output.md' }],
        summary: 'auto-commit by framework',
        issues: [],
        assumptions: [],
      };

      const hookEvent = JSON.stringify({
        tool_name: 'Agent',
        tool_input: { subagent_type: 'developer' },
        tool_response: {
          output: '## Structured Result\n```json\n' + JSON.stringify(sr, null, 2) + '\n```\n',
        },
        cwd: tmp,
      });

      const result = spawnSync(NODE, [W2_HOOK], {
        input: hookEvent,
        cwd: tmp,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED: '1', // prevent exit-2 from blocking test
        },
      });

      // Read events from the temp dir
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      let bodyMissingEvents = [];
      if (fs.existsSync(eventsPath)) {
        bodyMissingEvents = fs.readFileSync(eventsPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
          .filter(e => e && e.type === 'commit_handoff_body_missing');
      }

      assert.equal(
        bodyMissingEvents.length,
        0,
        'W2 gate must NOT emit commit_handoff_body_missing when HEAD has W1 auto-commit trailer. ' +
        'stderr: ' + result.stderr.slice(0, 400)
      );
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ---------------------------------------------------------------------------
// GAP-4: W9 end-to-end — orchestration_start with task=null must NOT produce
//         schema_shadow_validation_block events
// ---------------------------------------------------------------------------

describe('GAP-4: W9 orchestration_start task=null — no schema_shadow_validation_block emitted', () => {
  test('writeEvent with orchestration_start and task=null emits zero schema_shadow_validation_block events', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-gap4-'));
    try {
      fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });

      // Fresh require to avoid module cache from other tests
      const writerKey = require.resolve('../_lib/audit-event-writer');
      delete require.cache[writerKey];
      const { writeEvent } = require('../_lib/audit-event-writer');

      writeEvent({
        type: 'orchestration_start',
        version: 1,
        orchestration_id: 'orch-gap4-001',
        task: null,
        started_at: new Date().toISOString(),
        schema_version: 1,
      }, { cwd: tmp });

      // Assert the event was actually written (not just silently dropped)
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath), 'events.jsonl must be created');

      const events = fs.readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);

      // The orchestration_start event must be written
      const startEvent = events.find(e => e.type === 'orchestration_start');
      assert.ok(startEvent, 'orchestration_start event must be present in events.jsonl');
      assert.equal(startEvent.task, null, 'task field must be null as written');

      // CRITICAL: no schema_shadow_validation_block for orchestration_start
      const blocks = events.filter(e =>
        e.type === 'schema_shadow_validation_block' &&
        e.blocked_event_type === 'orchestration_start'
      );
      assert.equal(
        blocks.length,
        0,
        'schema_shadow_validation_block must NOT be emitted for orchestration_start with task=null. ' +
        'This would indicate W9.2 relax is not working. blocks found: ' + JSON.stringify(blocks)
      );

      // Also no schema_shape_violation for orchestration_start
      const violations = events.filter(e =>
        e.type === 'schema_shape_violation' &&
        e.event_type === 'orchestration_start'
      );
      assert.equal(
        violations.length,
        0,
        'schema_shape_violation must NOT be emitted for orchestration_start with task=null. ' +
        'violations: ' + JSON.stringify(violations)
      );
    } finally {
      const writerKey = require.resolve('../_lib/audit-event-writer');
      delete require.cache[writerKey];
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ---------------------------------------------------------------------------
// GAP-5: W1+W3 dual kill switch combo — both disabled, system stays stable
// ---------------------------------------------------------------------------

describe('GAP-5: W1+W3 dual kill switch — both disabled simultaneously, no panic or partial state', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-gap5-'));
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.local"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.orchestray/\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), 'init\n');
    execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore', shell: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) {}
  });

  test('W3 hook exits 0 with both W1 and W3 env kill switches set and dirty master tree', () => {
    writeOrchestrationMd(tmpDir, { status: 'active', orchestration_id: 'orch-gap5-001' });
    fs.writeFileSync(path.join(tmpDir, 'master-dual-kill.txt'), 'should stay uncommitted');

    const commitsBefore = countCommits(tmpDir);

    // Run W3 with BOTH kill switches enabled simultaneously
    const r = runHookStdin(
      W3_HOOK,
      JSON.stringify({ cwd: tmpDir }),
      {
        ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED: '1',
        ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED: '1',
      }
    );

    assert.equal(r.status, 0, 'W3 hook must exit 0 with dual kill switches; stderr: ' + r.stderr.slice(0, 400));
    assert.equal(
      countCommits(tmpDir),
      commitsBefore,
      'dual kill switches: no commit must be made to master tree'
    );

    // No events emitted for master commit
    const events = readEvents(tmpDir);
    const masterEmitted = events.filter(e => e.type === 'master_auto_commit_emitted');
    assert.equal(masterEmitted.length, 0, 'no master_auto_commit_emitted event when both kill switches are set');
  });

  test('W1 hook exits 0 with both W1 and W3 env kill switches set and dirty worktree', () => {
    const { worktreeDir, cleanup } = makeWorktreeSetup({ orchId: 'orch-gap5-002' });
    try {
      fs.writeFileSync(path.join(worktreeDir, 'wt-dual-kill.txt'), 'should stay uncommitted');

      const commitsBefore = countCommits(worktreeDir);

      const r = runHookStdin(
        W1_HOOK,
        JSON.stringify({ hook_event_name: 'SubagentStop', agent_role: 'developer', cwd: worktreeDir }),
        {
          ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED: '1',
          ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED: '1',
        }
      );

      assert.equal(r.status, 0, 'W1 hook must exit 0 with dual kill switches; stderr: ' + r.stderr.slice(0, 400));
      assert.equal(
        countCommits(worktreeDir),
        commitsBefore,
        'dual kill switches: no commit must be made to worktree'
      );
    } finally {
      cleanup();
    }
  });
});
