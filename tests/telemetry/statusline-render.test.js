'use strict';

/**
 * Tests for statusline.js render logic and formatting helpers.
 *
 * Coverage group 3: statusline render
 *   - Idle state → shows session token count only
 *   - 1 subagent active → shows type + model + effort + tokens
 *   - 3+ subagents → truncation rule applied
 *   - Context >75% → '!' marker present
 *   - Context >90% → '!!' marker present
 *   - Performance: single invocation < 200ms (loosened from 50ms in v2.1.14 W6.6 — Node child-process cold-start variance under parallel test load)
 *
 * Coverage group 4: Config flag
 *   - context_statusbar.enabled: false → render returns empty string
 *
 * Note: statusline.js does not export its functions. We test via child_process
 * stdin/stdout for integration coverage, and we inline the pure helpers here
 * to avoid the module being untestable. The integration tests cover the full
 * render path including config loading and cache reading.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../../bin/statusline.js');
const { resetCache, updateCache } = require('../../bin/_lib/context-telemetry-cache');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpProject(configOverrides) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-statusline-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

  // F-19 (v2.2.21): these legacy tests pre-date idle suppression and assert
  // the always-render shape. Pin idle_suppression: false so the legacy
  // assertions stay valid; F-19 behaviour has its own dedicated suite at
  // tests/statusline-idle-suppress.test.js + tests/statusline-active-block.test.js.
  const config = Object.assign(
    { context_statusbar: { enabled: true, width_cap: 120, pressure_thresholds: { warn: 75, critical: 90 }, idle_suppression: false } },
    configOverrides
  );
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(config),
    'utf8'
  );
  return dir;
}

function teardown(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runStatusline(projectDir, payloadExtra) {
  const payload = Object.assign({ cwd: projectDir, session_id: 'test-session' }, payloadExtra);
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
  return {
    stdout: (result.stdout || '').trim(),
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ── Integration: statusline process ──────────────────────────────────────────

describe('statusline render — idle state', () => {
  test('exits 0 and emits a single line in idle state (no active subagents)', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      const { stdout, status } = runStatusline(dir);
      assert.equal(status, 0);
      assert.ok(stdout.startsWith('[ctx'), 'idle line should start with [ctx');
      assert.ok(!stdout.includes('>'), 'idle line should not contain subagent separator');
    } finally {
      teardown(dir);
    }
  });

  test('emits 0% and 0/200K in idle state with empty cache', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      const { stdout } = runStatusline(dir);
      assert.ok(stdout.includes('0%'), 'should show 0% fill');
      assert.ok(stdout.includes('0/200K'), 'should show 0/200K token display');
    } finally {
      teardown(dir);
    }
  });
});

describe('statusline render — 1 active subagent', () => {
  test('shows subagent separator and type code when 1 subagent is active', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      updateCache(dir, (cache) => {
        cache.active_subagents.push({
          agent_id: 'ag-001',
          agent_type: 'developer',
          model: 'claude-sonnet-4-6',
          effort: 'medium',
          tokens: { input: 1000, output: 500, cache_read: 0, cache_creation: 0, total_prompt: 1500 },
          context_window: 200000,
        });
        return cache;
      });
      const { stdout } = runStatusline(dir);
      assert.ok(stdout.includes(' > '), 'should show subagent separator');
      assert.ok(stdout.includes('dev'), 'should show developer type code');
      assert.ok(stdout.includes('son-4-6'), 'should show model short code');
      assert.ok(stdout.includes('md'), 'should show medium effort code');
    } finally {
      teardown(dir);
    }
  });
});

describe('statusline render — 3+ subagents', () => {
  test('output is truncated to width_cap when 3+ subagents are active', () => {
    const dir = makeTmpProject({ context_statusbar: { enabled: true, width_cap: 80 } });
    try {
      resetCache(dir, 'test-session');
      updateCache(dir, (cache) => {
        cache.active_subagents.push(
          { agent_id: 'ag-1', agent_type: 'developer', model: 'claude-sonnet-4-6', effort: 'medium',
            tokens: { total_prompt: 5000 }, context_window: 200000 },
          { agent_id: 'ag-2', agent_type: 'reviewer', model: 'claude-haiku-4-5', effort: 'low',
            tokens: { total_prompt: 3000 }, context_window: 200000 },
          { agent_id: 'ag-3', agent_type: 'architect', model: 'claude-opus-4-6', effort: 'high',
            tokens: { total_prompt: 8000 }, context_window: 200000 }
        );
        return cache;
      });
      const { stdout } = runStatusline(dir);
      assert.ok(stdout.length <= 80, `output length ${stdout.length} should be <= width_cap 80`);
    } finally {
      teardown(dir);
    }
  });
});

describe('statusline render — pressure markers', () => {
  test('shows ! marker when session tokens exceed 75% of context window', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      // 155K of 200K = 77.5%
      updateCache(dir, (cache) => {
        cache.session.tokens.total_prompt = 155000;
        return cache;
      });
      const { stdout } = runStatusline(dir);
      assert.ok(stdout.includes('!'), 'should show pressure marker at >75%');
    } finally {
      teardown(dir);
    }
  });

  test('shows !! marker when session tokens exceed 90% of context window', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      // 185K of 200K = 92.5%
      updateCache(dir, (cache) => {
        cache.session.tokens.total_prompt = 185000;
        return cache;
      });
      const { stdout } = runStatusline(dir);
      assert.ok(stdout.includes('!!'), 'should show critical pressure marker at >90%');
    } finally {
      teardown(dir);
    }
  });
});

describe('statusline render — performance', () => {
  test('single invocation completes in less than 200ms', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      const start = process.hrtime.bigint();
      runStatusline(dir);
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms
      assert.ok(elapsed < 200, `statusline took ${elapsed.toFixed(1)}ms, should be < 200ms`);
    } finally {
      teardown(dir);
    }
  });
});

// ── Coverage group 4: config flag context_statusbar.enabled: false ─────────────

describe('statusline render — config flag disabled', () => {
  test('emits empty output when context_statusbar.enabled is false', () => {
    const dir = makeTmpProject({ context_statusbar: { enabled: false } });
    try {
      resetCache(dir, 'test-session');
      const { stdout, status } = runStatusline(dir);
      assert.equal(status, 0);
      assert.equal(stdout, '', 'disabled statusbar should emit empty output');
    } finally {
      teardown(dir);
    }
  });
});

// ── Coverage group 5: robustness to malformed payloads ────────────────────────

describe('statusline render — malformed stdin', () => {
  test('exits 0 when stdin is empty', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      const result = spawnSync(process.execPath, [SCRIPT], {
        input: '',
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      });
      assert.equal(result.status, 0);
    } finally {
      teardown(dir);
    }
  });

  test('exits 0 when stdin is invalid JSON', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      const result = spawnSync(process.execPath, [SCRIPT], {
        input: '{not valid json',
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      });
      assert.equal(result.status, 0);
    } finally {
      teardown(dir);
    }
  });

  test('exits 0 when stdin is null-value JSON object', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'test-session');
      const result = spawnSync(process.execPath, [SCRIPT], {
        input: '{"session_id":null,"model":null,"cwd":null}',
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      });
      assert.equal(result.status, 0);
    } finally {
      teardown(dir);
    }
  });
});
