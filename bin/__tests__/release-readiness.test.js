#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/release-readiness.js.
 *
 * Runner: node --test bin/__tests__/release-readiness.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../release-readiness.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'release-readiness-test-'));
}

/**
 * Run the script with --json and return parsed output.
 * @param {string} projectRoot
 * @returns {{ exitCode: number, output: object }}
 */
function runScript(projectRoot, extraArgs) {
  const args = ['--json', '--project-root=' + projectRoot, ...(extraArgs || [])];
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout:  10000,
  });
  let output = null;
  try {
    output = JSON.parse(result.stdout);
  } catch (_e) {
    output = { raw: result.stdout, stderr: result.stderr };
  }
  return { exitCode: result.status, output };
}

/**
 * Build a minimal fixture directory that passes all checks.
 */
function buildPassingFixture() {
  const root = makeTmpDir();

  // (a) + (b): hooks.json with all required wiring
  const hooksDir = path.join(root, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hooks = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Agent|Explore|Task',
          hooks: [
            { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-task-subject.js' },
          ],
        },
      ],
      TaskCompleted: [
        {
          hooks: [
            { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-task-completion.js' },
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-task-completion.js' },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(hooks), 'utf8');

  // (c): 10 agent prompts that reference handoff-contract.md
  const agentsDir = path.join(root, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const agentFiles = [
    'pm.md', 'architect.md', 'developer.md', 'reviewer.md', 'refactorer.md',
    'tester.md', 'debugger.md', 'documenter.md', 'inventor.md', 'researcher.md',
  ];
  for (const f of agentFiles) {
    fs.writeFileSync(
      path.join(agentsDir, f),
      `# Agent\nSee agents/pm-reference/handoff-contract.md for output schema.\n`,
      'utf8'
    );
  }
  // These 3 don't reference it (but we only need 10/13 to pass)
  for (const f of ['security-engineer.md', 'release-manager.md', 'ux-critic.md']) {
    fs.writeFileSync(path.join(agentsDir, f), '# Agent\nNo contract ref.\n', 'utf8');
  }

  // (d): 5 specialists
  const specialistsDir = path.join(root, 'specialists');
  fs.mkdirSync(specialistsDir, { recursive: true });
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(specialistsDir, `specialist-${i}.md`), `# Specialist ${i}\n`, 'utf8');
  }

  // (e): agent_metrics.jsonl with fewer than 5 entries (so check is skipped)
  // This ensures the fixture passes without needing a live B4 run
  const metricsDir = path.join(root, '.orchestray', 'metrics');
  fs.mkdirSync(metricsDir, { recursive: true });
  // Write 2 entries (< 5 threshold)
  const metricsPath = path.join(metricsDir, 'agent_metrics.jsonl');
  fs.writeFileSync(metricsPath,
    JSON.stringify({ row_type: 'agent_spawn', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ row_type: 'agent_spawn', timestamp: new Date().toISOString() }) + '\n',
    'utf8'
  );

  return root;
}

// ---------------------------------------------------------------------------
// Test: passing fixture exits 0
// ---------------------------------------------------------------------------

describe('release-readiness: passing fixture', () => {
  test('exits 0 when all checks pass or are skipped', () => {
    const root = buildPassingFixture();
    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 0, 'should exit 0');
    assert.strictEqual(output.ok, true, 'ok should be true');
    assert.strictEqual(output.summary.failed, 0, 'no failed checks');
  });
});

// ---------------------------------------------------------------------------
// Test: check (a) — validate-task-subject.js not wired
// ---------------------------------------------------------------------------

describe('release-readiness: check (a) failure', () => {
  test('exits 1 when validate-task-subject.js is not in hooks.json', () => {
    const root = buildPassingFixture();
    // Rewrite hooks.json without validate-task-subject.js
    const hooksDir = path.join(root, 'hooks');
    const hooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Agent|Explore|Task',
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/other-hook.js' },
            ],
          },
        ],
        TaskCompleted: [
          {
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-task-completion.js' },
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-task-completion.js' },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(hooks), 'utf8');

    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 1, 'should exit 1');
    assert.strictEqual(output.ok, false);

    const checkA = output.results.find((r) => r.id === 'a');
    assert.ok(checkA, 'check (a) result should exist');
    assert.strictEqual(checkA.pass, false, 'check (a) should fail');
  });
});

// ---------------------------------------------------------------------------
// Test: check (b) — validate-task-completion.js not wired under SubagentStop
// ---------------------------------------------------------------------------

describe('release-readiness: check (b) failure', () => {
  test('exits 1 when validate-task-completion.js missing from SubagentStop', () => {
    const root = buildPassingFixture();
    const hooksDir = path.join(root, 'hooks');
    const hooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Agent|Explore|Task',
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-task-subject.js' },
            ],
          },
        ],
        TaskCompleted: [
          {
            hooks: [
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-task-completion.js' },
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              // Missing validate-task-completion.js here
              { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/collect-agent-metrics.js' },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(hooks), 'utf8');

    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 1);
    const checkB = output.results.find((r) => r.id === 'b');
    assert.ok(checkB);
    assert.strictEqual(checkB.pass, false);
    assert.ok(checkB.note.includes('SubagentStop'));
  });
});

// ---------------------------------------------------------------------------
// Test: check (c) — fewer than 10 agents reference handoff-contract
// ---------------------------------------------------------------------------

describe('release-readiness: check (c) failure', () => {
  test('exits 1 when fewer than 10 agents reference handoff-contract.md', () => {
    const root = buildPassingFixture();
    // Remove handoff-contract reference from most agents
    const agentsDir = path.join(root, 'agents');
    for (const f of ['developer.md', 'reviewer.md', 'refactorer.md', 'tester.md']) {
      fs.writeFileSync(path.join(agentsDir, f), '# Agent\nNo contract reference.\n', 'utf8');
    }

    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 1);
    const checkC = output.results.find((r) => r.id === 'c');
    assert.ok(checkC);
    assert.strictEqual(checkC.pass, false);
  });
});

// ---------------------------------------------------------------------------
// Test: check (d) — fewer than 5 specialists
// ---------------------------------------------------------------------------

describe('release-readiness: check (d) failure', () => {
  test('exits 1 when fewer than 5 specialists exist', () => {
    const root = buildPassingFixture();
    // Remove some specialist files
    const specDir = path.join(root, 'specialists');
    fs.unlinkSync(path.join(specDir, 'specialist-4.md'));
    fs.unlinkSync(path.join(specDir, 'specialist-5.md'));

    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 1);
    const checkD = output.results.find((r) => r.id === 'd');
    assert.ok(checkD);
    assert.strictEqual(checkD.pass, false);
    assert.ok(checkD.note.includes('3'));
  });
});

// ---------------------------------------------------------------------------
// Test: check (e) — structural_score check skipped when <5 entries
// ---------------------------------------------------------------------------

describe('release-readiness: check (e) skipped', () => {
  test('check (e) is skipped when agent_metrics.jsonl has fewer than 5 entries', () => {
    const root = buildPassingFixture();
    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 0, 'should still pass when check (e) is skipped');
    const checkE = output.results.find((r) => r.id === 'e');
    assert.ok(checkE);
    assert.strictEqual(checkE.skipped, true, 'check (e) should be skipped');
    assert.ok(checkE.note.includes('skipping'));
  });

  test('check (e) fails when ≥5 entries but none have structural_score', () => {
    const root = buildPassingFixture();
    const metricsPath = path.join(root, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    // Write 6 agent_spawn rows (no structural_score)
    let content = '';
    for (let i = 0; i < 6; i++) {
      content += JSON.stringify({ row_type: 'agent_spawn', timestamp: new Date().toISOString() }) + '\n';
    }
    fs.writeFileSync(metricsPath, content, 'utf8');

    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 1);
    const checkE = output.results.find((r) => r.id === 'e');
    assert.ok(checkE);
    assert.strictEqual(checkE.pass, false);
    assert.ok(!checkE.skipped);
  });

  test('check (e) passes when structural_score row present', () => {
    const root = buildPassingFixture();
    const metricsPath = path.join(root, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    let content = '';
    for (let i = 0; i < 5; i++) {
      content += JSON.stringify({ row_type: 'agent_spawn', timestamp: new Date().toISOString() }) + '\n';
    }
    // Add a structural_score row
    content += JSON.stringify({
      row_type: 'structural_score',
      structural_score: 0.833,
      checks_total: 6,
      checks_passed: 5,
      timestamp: new Date().toISOString(),
    }) + '\n';
    fs.writeFileSync(metricsPath, content, 'utf8');

    const { exitCode, output } = runScript(root);

    assert.strictEqual(exitCode, 0);
    const checkE = output.results.find((r) => r.id === 'e');
    assert.ok(checkE);
    assert.strictEqual(checkE.pass, true);
    assert.ok(!checkE.skipped);
  });
});

// ---------------------------------------------------------------------------
// Test: JSON output format
// ---------------------------------------------------------------------------

describe('release-readiness: JSON output format', () => {
  test('--json flag produces parseable JSON with expected fields', () => {
    const root = buildPassingFixture();
    const { exitCode, output } = runScript(root, ['--json']);

    assert.ok(typeof output.ok === 'boolean');
    assert.ok(Array.isArray(output.results));
    assert.ok(typeof output.summary === 'object');
    assert.ok(typeof output.summary.total === 'number');
    assert.ok(typeof output.summary.passed === 'number');
    assert.ok(typeof output.summary.failed === 'number');
    assert.ok(typeof output.summary.skipped === 'number');
    assert.strictEqual(output.results.length, 5, 'should have 5 check results');
  });
});
