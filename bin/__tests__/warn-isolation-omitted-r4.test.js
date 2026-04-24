#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.1.10 R4 — worktree isolation omission warning hook.
 *
 * Covers all 7 items from the F-02 fix requirement:
 *   1. WRITE_CAPABLE_AGENTS membership (write-capable in; read-only out)
 *   2. agentFrontmatterHasIsolation: true for valid frontmatter; false for missing file; false for absent field
 *   3. isWarnEnabled: returns false under ORCHESTRAY_ISOLATION_WARN_DISABLED=1
 *   4. isWarnEnabled: returns false when config sets worktree_isolation.warn_on_omission: false
 *   5. Full hook: non-Agent tool_name → exits 0, continue:true, no event emitted
 *   6. Full hook: write-capable agent with tool_input.isolation = "worktree" → exits 0, no event
 *   7. Full hook: write-capable agent without isolation AND without frontmatter isolation → exits 0 AND emits isolation_omitted_warn event
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'warn-isolation-omitted.js');

const {
  WRITE_CAPABLE_AGENTS,
  isWarnEnabled,
  agentFrontmatterHasIsolation,
} = require(HOOK);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal project dir with optional agents directory and config.
 *
 * @param {object} [opts]
 * @param {object|null} [opts.config] - Object to write as .orchestray/config.json; null to omit.
 * @param {string|null} [opts.agentType] - If set, creates agents/<agentType>.md with given frontmatter content.
 * @param {string} [opts.agentFrontmatter] - Frontmatter body to embed in the agent markdown file.
 * @returns {string} Temp directory path.
 */
function makeProjectDir({ config = null, agentType = null, agentFrontmatter = '' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wio-r4-'));
  const orchestrayDir = path.join(tmp, '.orchestray');
  const auditDir = path.join(orchestrayDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });

  if (config !== null) {
    fs.writeFileSync(
      path.join(orchestrayDir, 'config.json'),
      JSON.stringify(config, null, 2)
    );
  }

  if (agentType !== null) {
    const agentsDir = path.join(tmp, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const agentContent = `---\n${agentFrontmatter}\n---\n\n# ${agentType} agent\n`;
    fs.writeFileSync(path.join(agentsDir, agentType + '.md'), agentContent);
  }

  return tmp;
}

/**
 * Run the hook via spawnSync, returning { status, stdout, stderr }.
 *
 * @param {object} eventPayload - JSON payload sent to stdin.
 * @param {string} [cwd] - Working directory for hook (project root).
 * @param {object} [extraEnv] - Extra env vars.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runHook(eventPayload, cwd, extraEnv = {}) {
  const env = Object.assign({}, process.env, extraEnv);
  // Remove lingering kill-switch from parent env unless explicitly set by test.
  if (!extraEnv.ORCHESTRAY_ISOLATION_WARN_DISABLED) {
    delete env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
  }

  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(eventPayload),
    env,
    encoding: 'utf8',
    timeout: 10_000,
    cwd,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ---------------------------------------------------------------------------
// 1. WRITE_CAPABLE_AGENTS membership
// ---------------------------------------------------------------------------

describe('R4 — WRITE_CAPABLE_AGENTS membership', () => {

  test('write-capable agents are members: architect, developer, refactorer, tester, security-engineer, inventor', () => {
    for (const agent of ['architect', 'developer', 'refactorer', 'tester', 'security-engineer', 'inventor']) {
      assert.ok(WRITE_CAPABLE_AGENTS.has(agent), `${agent} must be in WRITE_CAPABLE_AGENTS`);
    }
  });

  test('read-only agents are NOT members: reviewer, debugger, researcher, documenter, ux-critic, platform-oracle', () => {
    for (const agent of ['reviewer', 'debugger', 'researcher', 'documenter', 'ux-critic', 'platform-oracle']) {
      assert.ok(!WRITE_CAPABLE_AGENTS.has(agent), `${agent} must NOT be in WRITE_CAPABLE_AGENTS`);
    }
  });

});

// ---------------------------------------------------------------------------
// 2. agentFrontmatterHasIsolation
// ---------------------------------------------------------------------------

describe('R4 — agentFrontmatterHasIsolation', () => {

  test('returns true when agent markdown contains isolation: worktree in frontmatter', () => {
    const tmp = makeProjectDir({
      agentType: 'developer',
      agentFrontmatter: 'name: developer\nmodel: sonnet\nisolation: worktree',
    });
    try {
      assert.equal(agentFrontmatterHasIsolation(tmp, 'developer'), true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns false when agent markdown file is missing', () => {
    const tmp = makeProjectDir(); // no agentType — agents/ dir will not exist
    try {
      assert.equal(agentFrontmatterHasIsolation(tmp, 'developer'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns false when agent markdown exists but isolation field is absent', () => {
    const tmp = makeProjectDir({
      agentType: 'developer',
      agentFrontmatter: 'name: developer\nmodel: sonnet',
    });
    try {
      assert.equal(agentFrontmatterHasIsolation(tmp, 'developer'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns false when agent markdown exists but isolation field has a different value', () => {
    const tmp = makeProjectDir({
      agentType: 'developer',
      agentFrontmatter: 'name: developer\nmodel: sonnet\nisolation: none',
    });
    try {
      assert.equal(agentFrontmatterHasIsolation(tmp, 'developer'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// 3. isWarnEnabled — env kill-switch
// ---------------------------------------------------------------------------

describe('R4 — isWarnEnabled env kill-switch', () => {

  test('returns false when ORCHESTRAY_ISOLATION_WARN_DISABLED=1', () => {
    const tmp = makeProjectDir();
    const originalEnv = process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED = '1';
    try {
      assert.equal(isWarnEnabled(tmp), false);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
      } else {
        process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns true when ORCHESTRAY_ISOLATION_WARN_DISABLED is not set', () => {
    const tmp = makeProjectDir();
    const originalEnv = process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    delete process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    try {
      assert.equal(isWarnEnabled(tmp), true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// 4. isWarnEnabled — config.json kill-switch
// ---------------------------------------------------------------------------

describe('R4 — isWarnEnabled config.json kill-switch', () => {

  test('returns false when config.json has worktree_isolation.warn_on_omission: false', () => {
    const tmp = makeProjectDir({
      config: { worktree_isolation: { warn_on_omission: false } },
    });
    const originalEnv = process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    delete process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    try {
      assert.equal(isWarnEnabled(tmp), false);
    } finally {
      if (originalEnv !== undefined) {
        process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns true when config.json has worktree_isolation.warn_on_omission: true', () => {
    const tmp = makeProjectDir({
      config: { worktree_isolation: { warn_on_omission: true } },
    });
    const originalEnv = process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    delete process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    try {
      assert.equal(isWarnEnabled(tmp), true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns true when config.json is missing (defaults to warn enabled)', () => {
    const tmp = makeProjectDir(); // no config
    const originalEnv = process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    delete process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED;
    try {
      assert.equal(isWarnEnabled(tmp), true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// 5. Full hook: non-Agent tool → continue:true, no event emitted
// ---------------------------------------------------------------------------

describe('R4 full hook — non-Agent tool_name', () => {

  test('tool_name != "Agent" → exits 0, continue:true, no events.jsonl entry', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: tmp },
        tmp
      );
      assert.equal(r.status, 0, `Unexpected exit: stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.continue, true, 'non-Agent hook must emit continue:true');
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(!fs.existsSync(eventsPath), 'non-Agent tool must not produce events.jsonl');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('missing tool_name → exits 0, no event', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook({ cwd: tmp }, tmp);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.continue, true);
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(!fs.existsSync(eventsPath));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// 6. Full hook: write-capable agent with tool_input.isolation = "worktree" → no event
// ---------------------------------------------------------------------------

describe('R4 full hook — write-capable agent with isolation param', () => {

  test('developer with isolation: "worktree" param → exits 0, no event emitted', () => {
    const tmp = makeProjectDir(); // no frontmatter file — isolation comes from param
    try {
      const r = runHook(
        {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'developer',
            isolation: 'worktree',
            prompt: 'implement something',
          },
          cwd: tmp,
        },
        tmp
      );
      assert.equal(r.status, 0, `Unexpected exit: stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.continue, true);
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(!fs.existsSync(eventsPath), 'isolated agent must not emit warning event');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('architect with isolation from frontmatter → exits 0, no event emitted', () => {
    const tmp = makeProjectDir({
      agentType: 'architect',
      agentFrontmatter: 'name: architect\nmodel: opus\nisolation: worktree',
    });
    try {
      const r = runHook(
        {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'architect',
            prompt: 'design something',
          },
          cwd: tmp,
        },
        tmp
      );
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.continue, true);
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(!fs.existsSync(eventsPath), 'frontmatter-isolated agent must not emit warning event');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// 7. Full hook: write-capable agent without isolation → exits 0 AND emits event
// ---------------------------------------------------------------------------

describe('R4 full hook — write-capable agent without isolation', () => {

  test('developer without isolation param AND without frontmatter isolation → exits 0 AND emits isolation_omitted_warn event', () => {
    // No agents/ dir, no isolation param — triggers warning.
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        {
          tool_name: 'Agent',
          tool_input: {
            subagent_type: 'developer',
            prompt: 'do something',
          },
          cwd: tmp,
        },
        tmp
      );
      assert.equal(r.status, 0, `Hook must always exit 0 (advisory only): stderr=${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.continue, true, 'advisory hook must always emit continue:true');

      // Must have written exactly one isolation_omitted_warn event.
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath), 'events.jsonl must be created for warning event');
      const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
      assert.equal(lines.length, 1, 'exactly one event must be emitted');
      const event = JSON.parse(lines[0]);
      assert.equal(event.type, 'isolation_omitted_warn', 'event type must be isolation_omitted_warn');
      assert.equal(event.agent, 'developer', 'event must record the spawned agent type');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('refactorer without isolation → emits isolation_omitted_warn event with correct agent field', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        {
          tool_name: 'Agent',
          tool_input: { subagent_type: 'refactorer', prompt: 'refactor' },
          cwd: tmp,
        },
        tmp
      );
      assert.equal(r.status, 0);
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath));
      const event = JSON.parse(fs.readFileSync(eventsPath, 'utf8').trim());
      assert.equal(event.agent, 'refactorer');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('env kill-switch ORCHESTRAY_ISOLATION_WARN_DISABLED=1 suppresses event even for write-capable agent', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        {
          tool_name: 'Agent',
          tool_input: { subagent_type: 'developer', prompt: 'do something' },
          cwd: tmp,
        },
        tmp,
        { ORCHESTRAY_ISOLATION_WARN_DISABLED: '1' }
      );
      assert.equal(r.status, 0);
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(!fs.existsSync(eventsPath), 'kill-switch must suppress event emission');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reviewer without isolation → exits 0, no event (reviewer is read-only)', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook(
        {
          tool_name: 'Agent',
          tool_input: { subagent_type: 'reviewer', prompt: 'review something' },
          cwd: tmp,
        },
        tmp
      );
      assert.equal(r.status, 0);
      const parsed = JSON.parse(r.stdout.trim());
      assert.equal(parsed.continue, true);
      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      assert.ok(!fs.existsSync(eventsPath), 'reviewer is read-only, must not emit warning event');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
