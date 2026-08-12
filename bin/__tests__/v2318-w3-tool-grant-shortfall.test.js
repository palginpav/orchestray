#!/usr/bin/env node
'use strict';

/**
 * v2318-w3-tool-grant-shortfall.test.js — tool-grant shortfall detector (v2.3.18 W3, new).
 *
 * `platform-oracle` and `researcher` both declare `WebFetch`/`WebSearch` in
 * their agent frontmatter but were observed silently falling back to `curl`
 * via Bash with no error and no telemetry. This is the SubagentStop hook
 * that detects that gap: telemetry-only, never blocks (see
 * bin/detect-tool-grant-shortfall.js header for the full rationale).
 *
 * Runner: node --test bin/__tests__/v2318-w3-tool-grant-shortfall.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'detect-tool-grant-shortfall.js');
const NODE      = process.execPath;

function readEvents(root) {
  try {
    return fs.readFileSync(path.join(root, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function writeTranscript(dir, name, toolUseLines) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, toolUseLines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return p;
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-toolgrant-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  return dir;
}

function writeAgentDef(dir, role, tools) {
  fs.writeFileSync(
    path.join(dir, 'agents', role + '.md'),
    `---\nname: ${role}\ntools: ${tools.join(', ')}\nmodel: inherit\n---\n\n# ${role}\n`,
    'utf8',
  );
}

function runHookSync(payload, cwd, extraEnv) {
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, extraEnv || {}),
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Encode a project root the way Claude Code names its cache dir. */
function encodeProject(root) {
  return root.replace(/^\//, '').replace(/\//g, '-');
}

/**
 * Write a spawn-metadata sidecar exactly as Claude Code does, mirroring the
 * fixture helper in tests/gate-agent-spawn.test.js (same sidecar shape).
 */
function writeMeta(home, cwd, { rosterName, customAgentType, sessionId }) {
  const subDir = path.join(
    home, '.claude', 'projects', '-' + encodeProject(cwd), sessionId, 'subagents'
  );
  fs.mkdirSync(subDir, { recursive: true });
  const file = path.join(subDir, 'agent-a' + rosterName + '-c528d894081a8347.meta.json');
  fs.writeFileSync(file, JSON.stringify({
    agentType: rosterName, name: rosterName, customAgentType,
  }));
}

describe('tool_grant_shortfall detection', () => {
  let dir;
  beforeEach(() => { dir = makeFixture(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('declared WebFetch never used, Bash+curl present → shortfall event with substituted_via bash_curl', () => {
    writeAgentDef(dir, 'platform-oracle', ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'WebFetch']);
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl -s https://example.com' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/foo' } }] } },
    ]);
    const payload = {
      hook_event_name: 'SubagentStop',
      subagent_type: 'platform-oracle',
      agent_id: 'agent-1',
      cwd: dir,
      agent_transcript_path: transcriptPath,
    };
    const { stdout, stderr, status } = runHookSync(payload, dir);
    assert.equal(status, 0, `hook always exits 0 (telemetry-only); stderr=${stderr}`);
    assert.deepEqual(JSON.parse(stdout), { continue: true });

    const events = readEvents(dir).filter(e => e.type === 'tool_grant_shortfall');
    assert.equal(events.length, 1, 'exactly 1 tool_grant_shortfall event');
    assert.equal(events[0].agent_role, 'platform-oracle');
    assert.deepEqual(events[0].declared_but_unused, ['WebFetch']);
    assert.equal(events[0].substituted_via, 'bash_curl');
    // W12: Bash+curl substitution is positive evidence of a real capability
    // gap, not just idle non-use.
    assert.equal(events[0].confidence, 'workaround_observed');
    // W12: no spawn-metadata sidecar exists in this fixture, so identity
    // came from the roster-name fallback, not the runtime-authoritative one
    // — and the event must say so rather than presenting both as equal.
    assert.equal(events[0].agent_role_source, 'roster_fallback');
  });

  test('declared WebFetch unused with no substitution evidence → ambiguous_unused, not implied certainty', () => {
    writeAgentDef(dir, 'platform-oracle', ['Read', 'Bash', 'WebFetch']);
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/foo' } }] } },
    ]);
    const payload = {
      hook_event_name: 'SubagentStop',
      subagent_type: 'platform-oracle',
      agent_id: 'agent-ambiguous',
      cwd: dir,
      agent_transcript_path: transcriptPath,
    };
    const { status } = runHookSync(payload, dir);
    assert.equal(status, 0);
    const events = readEvents(dir).filter(e => e.type === 'tool_grant_shortfall');
    assert.equal(events.length, 1);
    assert.equal(events[0].substituted_via, null);
    // W12: without a curl substitution, the transcript genuinely cannot
    // distinguish "didn't need it" from "couldn't have it" — the event
    // must say so explicitly rather than reporting a bare shortfall.
    assert.equal(events[0].confidence, 'ambiguous_unused');
  });

  test('spawn-metadata sidecar present → agent_role_source is sidecar (authoritative), not roster_fallback', () => {
    writeAgentDef(dir, 'platform-oracle', ['Read', 'Bash', 'WebFetch']);
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl https://x' } }] } },
    ]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2318-w3-home-'));
    const sessionId = 'sess-w12-sidecar';
    // Roster name deliberately differs from the real role — only the
    // sidecar's customAgentType should be trusted for identity.
    writeMeta(home, dir, { rosterName: 'oracle-v2318', customAgentType: 'platform-oracle', sessionId });
    const payload = {
      hook_event_name: 'SubagentStop',
      subagent_type: 'oracle-v2318',
      session_id: sessionId,
      agent_id: 'agent-sidecar',
      cwd: dir,
      agent_transcript_path: transcriptPath,
    };
    try {
      const { status } = runHookSync(payload, dir, { HOME: home });
      assert.equal(status, 0);
      const events = readEvents(dir).filter(e => e.type === 'tool_grant_shortfall');
      assert.equal(events.length, 1);
      assert.equal(events[0].agent_role, 'platform-oracle');
      assert.equal(events[0].agent_role_source, 'sidecar');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('declared WebFetch WAS used → no shortfall event', () => {
    writeAgentDef(dir, 'platform-oracle', ['Read', 'Bash', 'WebFetch']);
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://example.com' } }] } },
    ]);
    const payload = {
      hook_event_name: 'SubagentStop',
      subagent_type: 'platform-oracle',
      agent_id: 'agent-2',
      cwd: dir,
      agent_transcript_path: transcriptPath,
    };
    const { status } = runHookSync(payload, dir);
    assert.equal(status, 0);
    const events = readEvents(dir).filter(e => e.type === 'tool_grant_shortfall');
    assert.equal(events.length, 0, 'no shortfall event when the tool was actually used');
  });

  test('role does not declare any capability-critical tool → no shortfall event', () => {
    writeAgentDef(dir, 'developer', ['Read', 'Write', 'Bash', 'Edit']);
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
    ]);
    const payload = {
      hook_event_name: 'SubagentStop',
      subagent_type: 'developer',
      agent_id: 'agent-3',
      cwd: dir,
      agent_transcript_path: transcriptPath,
    };
    const { status } = runHookSync(payload, dir);
    assert.equal(status, 0);
    const events = readEvents(dir).filter(e => e.type === 'tool_grant_shortfall');
    assert.equal(events.length, 0, 'no shortfall event when nothing capability-critical was declared');
  });

  test('kill switch ORCHESTRAY_TOOL_GRANT_SHORTFALL_DISABLED=1 suppresses the event entirely', () => {
    writeAgentDef(dir, 'researcher', ['Read', 'Bash', 'WebFetch', 'WebSearch']);
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl', [
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'curl https://x' } }] } },
    ]);
    const payload = {
      hook_event_name: 'SubagentStop',
      subagent_type: 'researcher',
      agent_id: 'agent-4',
      cwd: dir,
      agent_transcript_path: transcriptPath,
    };
    const r = cp.spawnSync(NODE, [HOOK_PATH], {
      input: JSON.stringify(payload),
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, { ORCHESTRAY_TOOL_GRANT_SHORTFALL_DISABLED: '1' }),
    });
    assert.equal(r.status, 0);
    const events = readEvents(dir).filter(e => e.type === 'tool_grant_shortfall');
    assert.equal(events.length, 0, 'kill switch must suppress the event');
  });

  test('non-SubagentStop hook_event_name is a no-op', () => {
    writeAgentDef(dir, 'researcher', ['Bash', 'WebFetch']);
    const payload = { hook_event_name: 'PreToolUse', subagent_type: 'researcher', cwd: dir };
    const { status } = runHookSync(payload, dir);
    assert.equal(status, 0);
    assert.equal(readEvents(dir).filter(e => e.type === 'tool_grant_shortfall').length, 0);
  });
});
