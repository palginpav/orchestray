#!/usr/bin/env node
'use strict';

/**
 * v229-spawn-tool-reach.test.js — B-5.1 unit tests.
 *
 * Verifies:
 *   1. The PreToolUse:Agent hook bin/inject-spawn-agent-hint.js mechanically
 *      appends an escalation hint to delegation prompts targeting write-capable
 *      specialist roles (developer, refactorer, security-engineer).
 *   2. Read-only / non-targeted roles (researcher, architect, reviewer, etc.)
 *      receive no hint.
 *   3. Idempotent: a second PreToolUse on a prompt that already contains the
 *      hint sentinel is a no-op.
 *   4. Kill switch ORCHESTRAY_SPAWN_AGENT_HINT_DISABLED=1 disables injection.
 *   5. detectEscalationHint() correctly identifies "TODO escalate to <role>"
 *      and similar patterns in agent transcripts; emits
 *      `spawn_escalation_hint_seen` only for write-capable specialists.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT       = path.resolve(__dirname, '..', '..');
const HINT_HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'inject-spawn-agent-hint.js');
const VTC_PATH        = path.join(REPO_ROOT, 'bin', 'validate-task-completion.js');
const NODE            = process.execPath;

const { detectEscalationHint } = require(VTC_PATH);
const { HINT_SENTINEL, TARGETED_ROLES } = require(HINT_HOOK_PATH);

function runHookSync(scriptPath, payload, envOverrides) {
  const env = Object.assign({}, process.env, envOverrides || {});
  const r = cp.spawnSync(NODE, [scriptPath], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseHookResponse(stdout) {
  try { return JSON.parse(stdout || '{}'); } catch (_e) { return null; }
}

describe('v229 B-5.1 — inject-spawn-agent-hint', () => {
  test('developer spawn → injector appends escalation hint', () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: {
        subagent_type: 'developer',
        prompt: '## Task\nImplement the foo bar baz feature.\n',
      },
    };
    const r = runHookSync(HINT_HOOK_PATH, payload);
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);
    const resp = parseHookResponse(r.stdout);
    assert.ok(resp, 'hook returns parseable JSON');
    assert.ok(resp.hookSpecificOutput, 'hook returns hookSpecificOutput');
    assert.equal(resp.hookSpecificOutput.permissionDecision, 'allow');
    const newPrompt = resp.hookSpecificOutput.updatedInput.prompt;
    assert.ok(newPrompt.includes(HINT_SENTINEL), 'prompt includes hint sentinel');
    assert.ok(newPrompt.includes('mcp__orchestray__spawn_agent'), 'prompt names the MCP tool');
  });

  test('refactorer + security-engineer spawn → also injected', () => {
    for (const role of ['refactorer', 'security-engineer']) {
      const payload = {
        tool_name: 'Agent',
        tool_input: { subagent_type: role, prompt: 'do work' },
      };
      const r = runHookSync(HINT_HOOK_PATH, payload);
      assert.equal(r.status, 0, role + ' exits 0');
      const resp = parseHookResponse(r.stdout);
      assert.ok(
        resp.hookSpecificOutput && resp.hookSpecificOutput.updatedInput.prompt.includes(HINT_SENTINEL),
        role + ' should be injected'
      );
    }
  });

  test('researcher spawn (read-only role) → no injection', () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'researcher', prompt: 'survey libraries' },
    };
    const r = runHookSync(HINT_HOOK_PATH, payload);
    assert.equal(r.status, 0);
    const resp = parseHookResponse(r.stdout);
    // Non-targeted roles get bare {continue: true} — no updatedInput.
    assert.equal(resp.continue, true);
    assert.ok(!resp.hookSpecificOutput, 'no updatedInput for read-only role');
  });

  test('architect / reviewer / documenter / tester → no injection', () => {
    for (const role of ['architect', 'reviewer', 'documenter', 'tester']) {
      const payload = {
        tool_name: 'Agent',
        tool_input: { subagent_type: role, prompt: 'do design work' },
      };
      const r = runHookSync(HINT_HOOK_PATH, payload);
      assert.equal(r.status, 0, role + ' exits 0');
      const resp = parseHookResponse(r.stdout);
      assert.ok(!resp.hookSpecificOutput, role + ' should NOT be injected');
    }
  });

  test('idempotent: second pass with sentinel already present → no double-inject', () => {
    const promptWithHint = '## Task\nWork.\n\n' + HINT_SENTINEL + '\nAlready injected.\n';
    const payload = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: promptWithHint },
    };
    const r = runHookSync(HINT_HOOK_PATH, payload);
    assert.equal(r.status, 0);
    const resp = parseHookResponse(r.stdout);
    assert.ok(!resp.hookSpecificOutput, 'idempotent — no updatedInput when sentinel present');
  });

  test('kill switch ORCHESTRAY_SPAWN_AGENT_HINT_DISABLED=1 → no injection', () => {
    const payload = {
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'do work' },
    };
    const r = runHookSync(HINT_HOOK_PATH, payload, {
      ORCHESTRAY_SPAWN_AGENT_HINT_DISABLED: '1',
    });
    assert.equal(r.status, 0);
    const resp = parseHookResponse(r.stdout);
    assert.ok(!resp.hookSpecificOutput, 'kill switch suppresses injection');
  });

  test('non-Agent tool → ignored', () => {
    const payload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    };
    const r = runHookSync(HINT_HOOK_PATH, payload);
    assert.equal(r.status, 0);
    const resp = parseHookResponse(r.stdout);
    assert.ok(!resp.hookSpecificOutput);
  });

  test('TARGETED_ROLES export matches the documented set', () => {
    assert.deepEqual(
      [...TARGETED_ROLES].sort(),
      ['developer', 'refactorer', 'security-engineer'].sort()
    );
  });
});

describe('v229 B-5.1 — detectEscalationHint (TaskCompleted backstop)', () => {
  test('TODO: escalate to security-engineer → match', () => {
    const text = 'Done with crypto changes. TODO: escalate to security-engineer for review.';
    const hint = detectEscalationHint(text, null);
    assert.ok(hint, 'hint detected');
    assert.equal(hint.suggested_agent, 'security-engineer');
    assert.match(hint.regex_match, /security-engineer/i);
  });

  test('needs reviewer review → match', () => {
    const text = 'Implemented foo. This needs reviewer review before merge.';
    const hint = detectEscalationHint(text, null);
    assert.ok(hint, 'hint detected');
    assert.equal(hint.suggested_agent, 'reviewer');
  });

  test('should be reviewed by architect → match', () => {
    const text = 'Wrote scaffolding. Should be reviewed by architect for design fit.';
    const hint = detectEscalationHint(text, null);
    assert.ok(hint, 'hint detected');
    assert.equal(hint.suggested_agent, 'architect');
  });

  test('hand off to tester → match', () => {
    const text = 'Test cases drafted. Hand off to tester for full coverage.';
    const hint = detectEscalationHint(text, null);
    assert.ok(hint);
    assert.equal(hint.suggested_agent, 'tester');
  });

  test('no escalation hint → null', () => {
    const text = 'Done. All tests pass. Ready for merge.';
    const hint = detectEscalationHint(text, null);
    assert.equal(hint, null);
  });

  test('reads structured_result.summary + issues + recommendations', () => {
    const sr = {
      summary: 'Implementation complete.',
      issues: [{ description: 'TODO escalate to security-engineer' }],
      recommendations: [],
    };
    const hint = detectEscalationHint('', sr);
    assert.ok(hint);
    assert.equal(hint.suggested_agent, 'security-engineer');
  });

  test('kill switch ORCHESTRAY_SPAWN_ESCALATION_HINT_TRACK_DISABLED=1 → null', () => {
    process.env.ORCHESTRAY_SPAWN_ESCALATION_HINT_TRACK_DISABLED = '1';
    try {
      const text = 'TODO: escalate to security-engineer';
      const hint = detectEscalationHint(text, null);
      assert.equal(hint, null);
    } finally {
      delete process.env.ORCHESTRAY_SPAWN_ESCALATION_HINT_TRACK_DISABLED;
    }
  });
});

describe('v229 B-5.1 — TaskCompleted hook emits spawn_escalation_hint_seen', () => {
  function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b5-1-vtc-'));
    fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
    // Seed minimal current-orchestration so resolveOrchestrationId works.
    fs.writeFileSync(
      path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-test-b5-1' }),
      'utf8'
    );
    return root;
  }

  function readEvents(root) {
    const p = path.join(root, '.orchestray', 'audit', 'events.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  }

  test('developer transcript with TODO escalate → fires spawn_escalation_hint_seen', () => {
    const root = makeRoot();
    const payload = {
      hook_event_name: 'SubagentStop',
      task_id: 'B-5.1',
      task_subject: 'developer task',
      subagent_type: 'developer',
      result: '## Structured Result\n```json\n{"status":"success","summary":"done","files_changed":["a.js"],"files_read":["a.js"],"issues":[{"description":"TODO: escalate to security-engineer for crypto review"}]}\n```',
      cwd: root,
    };
    const r = cp.spawnSync(NODE, [VTC_PATH], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
      encoding: 'utf8',
      timeout: 8000,
      cwd: root,
    });
    // Hook may exit 0 or 2 depending on T15 — we only care about the emit.
    const events = readEvents(root);
    const hits = events.filter(e => e.type === 'spawn_escalation_hint_seen');
    assert.equal(hits.length, 1, 'exactly one spawn_escalation_hint_seen; events: ' + JSON.stringify(events.map(e=>e.type)));
    assert.equal(hits[0].requester_agent, 'developer');
    assert.equal(hits[0].suggested_agent, 'security-engineer');
  });

  test('reviewer transcript (non-targeted role) with same content → does NOT fire', () => {
    const root = makeRoot();
    const payload = {
      hook_event_name: 'SubagentStop',
      task_id: 'X-1',
      task_subject: 'reviewer task',
      subagent_type: 'reviewer',
      result: '## Structured Result\n```json\n{"status":"success","summary":"reviewed","files_changed":[],"files_read":["a.js"],"issues":[{"description":"TODO escalate to architect"}]}\n```',
      cwd: root,
    };
    cp.spawnSync(NODE, [VTC_PATH], {
      input: JSON.stringify(payload),
      env: Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: root }),
      encoding: 'utf8',
      timeout: 8000,
      cwd: root,
    });
    const events = readEvents(root);
    const hits = events.filter(e => e.type === 'spawn_escalation_hint_seen');
    assert.equal(hits.length, 0, 'reviewer is read-only — no escalation event');
  });
});
