#!/usr/bin/env node
'use strict';

/**
 * v2212-w2a-contracts-hardfail.test.js
 *
 * W2a (v2.2.12): Tests for contracts parse-fail hard-fail promotion and
 * boot-validate-config.js upgrade banner.
 *
 * Test matrix:
 *
 *  1. Bad contracts → exit 2 (hard-fail default).
 *  2. Bad contracts + ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED=1 → exit 0, still
 *     emits contracts_parse_failed.
 *  3. Bad contracts + ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED=1 → exit 0, no
 *     contracts_parse_failed emitted.
 *  4. Banner: no sentinel + version 2.2.12 → stderr contains banner string +
 *     sentinel created.
 *  5. Banner: sentinel exists → no second emit.
 *  6. semverGte helper covers edge cases.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK      = path.join(REPO_ROOT, 'bin', 'validate-task-contracts.js');
const BOOT      = path.join(REPO_ROOT, 'bin', 'boot-validate-config.js');

const { semverGte, maybeEmitContractsHardfailBanner } = require(BOOT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-hardfail-'));
  const tasksDir = path.join(tmp, '.orchestray', 'state', 'tasks');
  const auditDir = path.join(tmp, '.orchestray', 'audit');
  const stateDir = path.join(tmp, '.orchestray', 'state');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  if (opts.orchestrationId) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: opts.orchestrationId }),
    );
  }

  if (opts.taskId && opts.taskYaml) {
    fs.writeFileSync(
      path.join(tasksDir, opts.taskId + '.yaml'),
      opts.taskYaml,
    );
  }

  return tmp;
}

function readEvents(tmp) {
  const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

// YAML with an empty contracts block — triggers the parse-fail path because
// parseContractsBlock returns { contracts: null, error: '...' } when the
// contracts: key is present but the block has no indented children.
// This is the simplest reliable way to trigger emitParseFailed.
const MALFORMED_CONTRACTS_YAML = `id: W-bad-parse
agent: developer
contracts:
id_after: will-trigger-empty-block-error
`;

// ---------------------------------------------------------------------------
// Helpers: spawn the hook with a given env and return {status, stderr, events}
// ---------------------------------------------------------------------------
function runHook(tmp, taskId, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // Unset any inherited kill switches unless explicitly set
  if (!('ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED' in extraEnv)) {
    delete env.ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED;
  }
  if (!('ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED' in extraEnv)) {
    delete env.ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED;
  }

  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { task_id: taskId, subagent_type: 'developer' },
      cwd: tmp,
    }),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
  return {
    status: res.status,
    stderr: res.stderr || '',
    events: readEvents(tmp),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Bad contracts (parse-fail) → exit 2 (hard-fail default)
// ---------------------------------------------------------------------------
describe('W2a — hard-fail default on contracts_parse_failed', () => {
  test('Test 1: malformed contracts → exit 2', () => {
    const tmp = makeTmpProject({
      orchestrationId: 'orch-hardfail-t1',
      taskId: 'W-bad-parse',
      taskYaml: MALFORMED_CONTRACTS_YAML,
    });
    try {
      const { status, events } = runHook(tmp, 'W-bad-parse');
      // Should exit 2 — hard-fail
      assert.equal(status, 2, 'contracts parse-fail must exit 2 (hard-fail)');
      // contracts_parse_failed must still be emitted
      const parseFailEvents = events.filter(e => e.type === 'contracts_parse_failed');
      assert.ok(parseFailEvents.length >= 1, 'contracts_parse_failed event must emit');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: Bad contracts + ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED=1 → exit 0
//         but contracts_parse_failed still emits
// ---------------------------------------------------------------------------
describe('W2a — ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED=1 reverts to soft-warn', () => {
  test('Test 2: parse-fail + PARSE_GATE_DISABLED=1 → exit 0, event still emits', () => {
    const tmp = makeTmpProject({
      orchestrationId: 'orch-hardfail-t2',
      taskId: 'W-bad-parse',
      taskYaml: MALFORMED_CONTRACTS_YAML,
    });
    try {
      const { status, events } = runHook(tmp, 'W-bad-parse', {
        ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED: '1',
      });
      assert.equal(status, 0, 'soft-warn mode must exit 0');
      const parseFailEvents = events.filter(e => e.type === 'contracts_parse_failed');
      assert.ok(parseFailEvents.length >= 1, 'contracts_parse_failed must still emit in soft-warn mode');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: Bad contracts + ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED=1 → exit 0,
//         no contracts_parse_failed emitted at all
// ---------------------------------------------------------------------------
describe('W2a — ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED=1 skips entirely', () => {
  test('Test 3: validator disabled → exit 0, no events', () => {
    const tmp = makeTmpProject({
      orchestrationId: 'orch-hardfail-t3',
      taskId: 'W-bad-parse',
      taskYaml: MALFORMED_CONTRACTS_YAML,
    });
    try {
      const { status, events } = runHook(tmp, 'W-bad-parse', {
        ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED: '1',
      });
      assert.equal(status, 0, 'disabled validator must exit 0');
      const parseFailEvents = events.filter(e => e.type === 'contracts_parse_failed');
      assert.equal(parseFailEvents.length, 0, 'no events when validator fully disabled');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: Banner — no sentinel + version >= 2.2.12 → stderr has banner + sentinel created
// ---------------------------------------------------------------------------
describe('W2a — contracts_hardfail_banner_shown (unit)', () => {
  test('Test 4: no sentinel + v2.2.12 → stderr banner + sentinel written', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-banner-'));
    const stateDir = path.join(tmp, '.orchestray', 'state');
    const auditDir = path.join(tmp, '.orchestray', 'audit');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });

    // Temporarily monkey-patch package.json path by writing a local package.json
    // Actually maybeEmitContractsHardfailBanner reads __dirname/../package.json.
    // We test via a subprocess that sets the version via a temp package.json override,
    // OR we call the exported function directly after patching require.
    //
    // Direct unit approach: patch fs.readFileSync for the specific path.
    // Instead, write a mini package.json in the real repo root backup approach.
    // Simplest: just call the function and check it reads the real package.json.
    // Real package.json is 2.2.11 → banner won't fire. Patch needed.
    //
    // Use a script approach: spawn a node process with a temp package.json that
    // has version 2.2.12 and verify stderr + sentinel.

    const sentinelPath = path.join(stateDir, '.contracts-hardfail-banner-shown');
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel must not exist before test');

    const script = `
      'use strict';
      const path = require('path');
      const fs = require('fs');
      // Override: inject a fake pkg resolution
      const Module = require('module');
      const origLoad = Module._resolveFilename.bind(Module);
      const BOOT = path.join(${JSON.stringify(REPO_ROOT)}, 'bin', 'boot-validate-config.js');
      // Patch: intercept readFileSync for package.json
      const origReadFileSync = fs.readFileSync.bind(fs);
      const pkgTarget = path.join(${JSON.stringify(REPO_ROOT)}, 'package.json');
      fs.readFileSync = (p, opts) => {
        if (p === pkgTarget) return JSON.stringify({ version: '2.2.12' });
        return origReadFileSync(p, opts);
      };
      const { maybeEmitContractsHardfailBanner } = require(BOOT);
      maybeEmitContractsHardfailBanner(${JSON.stringify(tmp)});
    `;

    const res = spawnSync('node', ['-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env },
    });

    try {
      assert.ok(
        res.stderr.includes('Contracts validation is now hard-fail by default'),
        'stderr must contain banner string; got: ' + res.stderr.slice(0, 300),
      );
      assert.ok(fs.existsSync(sentinelPath), 'sentinel must be created after banner');
      const sentinelContent = fs.readFileSync(sentinelPath, 'utf8').trim();
      // Should be an ISO timestamp
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(sentinelContent), 'sentinel content must be ISO timestamp');
    } finally {
      cleanup(tmp);
    }
  });

  // ---------------------------------------------------------------------------
  // Test 5: Sentinel exists → no second banner emit
  // ---------------------------------------------------------------------------
  test('Test 5: sentinel exists → banner not emitted again', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w2a-banner2-'));
    const stateDir = path.join(tmp, '.orchestray', 'state');
    const auditDir = path.join(tmp, '.orchestray', 'audit');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });

    // Pre-create sentinel
    const sentinelPath = path.join(stateDir, '.contracts-hardfail-banner-shown');
    fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n');

    const script = `
      'use strict';
      const path = require('path');
      const fs = require('fs');
      const origReadFileSync = fs.readFileSync.bind(fs);
      const pkgTarget = path.join(${JSON.stringify(REPO_ROOT)}, 'package.json');
      fs.readFileSync = (p, opts) => {
        if (p === pkgTarget) return JSON.stringify({ version: '2.2.12' });
        return origReadFileSync(p, opts);
      };
      const { maybeEmitContractsHardfailBanner } = require(${JSON.stringify(BOOT)});
      maybeEmitContractsHardfailBanner(${JSON.stringify(tmp)});
    `;

    const res = spawnSync('node', ['-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env },
    });

    try {
      assert.ok(
        !res.stderr.includes('Contracts validation is now hard-fail'),
        'banner must not re-emit when sentinel exists; stderr: ' + res.stderr.slice(0, 200),
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: semverGte helper
// ---------------------------------------------------------------------------
describe('W2a — semverGte helper', () => {
  test('Test 6a: 2.2.12 >= 2.2.12', () => {
    assert.ok(semverGte('2.2.12', '2.2.12'));
  });
  test('Test 6b: 2.2.13 >= 2.2.12', () => {
    assert.ok(semverGte('2.2.13', '2.2.12'));
  });
  test('Test 6c: 2.2.11 < 2.2.12 → false', () => {
    assert.equal(semverGte('2.2.11', '2.2.12'), false);
  });
  test('Test 6d: 3.0.0 >= 2.2.12', () => {
    assert.ok(semverGte('3.0.0', '2.2.12'));
  });
  test('Test 6e: 2.3.0 >= 2.2.12', () => {
    assert.ok(semverGte('2.3.0', '2.2.12'));
  });
  test('Test 6f: 2.2.11 < 2.2.12', () => {
    assert.equal(semverGte('2.2.11', '2.2.12'), false);
  });
});
