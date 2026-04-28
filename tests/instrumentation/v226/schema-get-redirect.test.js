'use strict';

/**
 * v2.2.x schema-get-redirect: PreToolUse mechanical enforcement.
 *
 * W6: context-shield.js now denies Reads of agents/pm-reference/event-schemas.md
 * with a redirect to mcp__orchestray__schema_get. This replaces the prose-only
 * directive (which W5 smoke confirmed had zero effect on model behavior).
 *
 * Tests:
 *   1. Read of event-schemas.md → deny + redirect message + audit event
 *      with source='pretool-deny'.
 *   2. Read of event-schemas.md with opt-out config
 *      (event_schemas.full_load_disabled: false) → allow + no deny event.
 *   3. Read of unrelated file → allow + no extra event.
 *   4. Payload missing file_path → allow + no extra event (graceful).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const SHIELD_SCRIPT = path.resolve(__dirname, '../../../bin/context-shield.js');
const PKG_ROOT      = path.resolve(__dirname, '../../..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp dir with the minimum structure needed:
 *   .orchestray/audit/  (for events.jsonl and current-orchestration.json)
 *   .orchestray/state/
 *   agents/pm-reference/event-schemas.md  (a real copy so fileStat is non-null)
 *
 * Optionally writes .orchestray/config.json when opts.config is provided.
 */
function makeTempCwd(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-schema-redirect-'));

  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });

  // Copy event-schemas.md so fileStat resolves (R14 null-stat allows through,
  // but we want to exercise the full redirect path).
  const schemaDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.copyFileSync(
    path.join(PKG_ROOT, 'agents', 'pm-reference', 'event-schemas.md'),
    path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.md')
  );

  // Seed current-orchestration.json so oid resolution works.
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({
      orchestration_id: 'orch-schema-redirect-smoke',
      task_summary: 'test',
      started_at: '2026-04-28T12:00:00.000Z',
      phase: 'execute',
    })
  );

  if (opts.config !== undefined) {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'config.json'),
      JSON.stringify(opts.config)
    );
  }

  return tmpDir;
}

/**
 * Run context-shield.js with the given event payload on stdin.
 * Returns { stdout, stderr, status }.
 */
function runShield(payload, cwd) {
  const result = spawnSync(process.execPath, [SHIELD_SCRIPT], {
    input: JSON.stringify(payload),
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/** Parse hookSpecificOutput from shield stdout. */
function parseDecision(stdout) {
  try {
    return JSON.parse(stdout).hookSpecificOutput || {};
  } catch (_e) {
    return {};
  }
}

/** Read events.jsonl from tmpDir. */
function readEvents(tmpDir) {
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Test 1: Read of event-schemas.md → deny + redirect + audit event
// ---------------------------------------------------------------------------

test('schema-get-redirect: Read of event-schemas.md denied with redirect to schema_get', () => {
  const tmpDir = makeTempCwd();
  try {
    const schemaPath = path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.md');
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: schemaPath },
      cwd: tmpDir,
      agent_type: 'developer',
      session_id: 'test-session-redirect-001',
    };

    const { status, stdout } = runShield(payload, tmpDir);
    assert.equal(status, 0, 'hook must exit 0');

    const decision = parseDecision(stdout);
    assert.equal(decision.permissionDecision, 'deny', 'must deny the Read');
    assert.ok(
      decision.permissionDecisionReason &&
        decision.permissionDecisionReason.includes('mcp__orchestray__schema_get'),
      'deny reason must mention mcp__orchestray__schema_get'
    );
    assert.ok(
      decision.permissionDecisionReason.includes('event_schemas.full_load_disabled'),
      'deny reason must mention the opt-out config key'
    );

    // Audit event must be emitted with source='pretool-deny'.
    const events = readEvents(tmpDir);
    const blocked = events.filter(e => e.type === 'event_schemas_full_load_blocked');
    assert.ok(blocked.length >= 1, 'must emit at least one event_schemas_full_load_blocked');
    const pretoolDeny = blocked.find(e => e.source === 'pretool-deny');
    assert.ok(pretoolDeny, 'at least one event must have source=pretool-deny');
    assert.equal(pretoolDeny.orchestration_id, 'orch-schema-redirect-smoke', 'orchestration_id must be set');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 2: Opt-out config → allow + no deny event
// ---------------------------------------------------------------------------

test('schema-get-redirect: event_schemas.full_load_disabled=false bypasses redirect', () => {
  const tmpDir = makeTempCwd({ config: { event_schemas: { full_load_disabled: false } } });
  try {
    const schemaPath = path.join(tmpDir, 'agents', 'pm-reference', 'event-schemas.md');
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: schemaPath },
      cwd: tmpDir,
      agent_type: 'pm',
      session_id: 'test-session-redirect-optout',
    };

    const { status, stdout } = runShield(payload, tmpDir);
    assert.equal(status, 0, 'hook must exit 0');

    const decision = parseDecision(stdout);
    assert.equal(decision.permissionDecision, 'allow', 'must allow when opt-out flag is set');

    // No deny audit event should be present.
    const events = readEvents(tmpDir);
    const pretoolDenyEvents = events.filter(
      e => e.type === 'event_schemas_full_load_blocked' && e.source === 'pretool-deny'
    );
    assert.equal(pretoolDenyEvents.length, 0, 'must not emit pretool-deny event when opt-out is active');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 3: Read of unrelated file → allow + no extra event
// ---------------------------------------------------------------------------

test('schema-get-redirect: Read of unrelated file is not redirected', () => {
  const tmpDir = makeTempCwd();
  try {
    // Write a non-target file.
    const otherFile = path.join(tmpDir, 'some-other-file.md');
    fs.writeFileSync(otherFile, '# Other\n');

    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: otherFile },
      cwd: tmpDir,
      agent_type: 'developer',
      session_id: 'test-session-redirect-unrelated',
    };

    const { status, stdout } = runShield(payload, tmpDir);
    assert.equal(status, 0, 'hook must exit 0');

    const decision = parseDecision(stdout);
    assert.equal(decision.permissionDecision, 'allow', 'unrelated file must be allowed');

    // No pretool-deny events.
    const events = readEvents(tmpDir);
    const pretoolDenyEvents = events.filter(
      e => e.type === 'event_schemas_full_load_blocked' && e.source === 'pretool-deny'
    );
    assert.equal(pretoolDenyEvents.length, 0, 'must not emit pretool-deny event for unrelated file');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 4: Payload missing file_path → allow + no extra event (graceful)
// ---------------------------------------------------------------------------

test('schema-get-redirect: payload with no file_path is allowed gracefully', () => {
  const tmpDir = makeTempCwd();
  try {
    const payload = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: {},   // no file_path, no path
      cwd: tmpDir,
      agent_type: 'developer',
      session_id: 'test-session-redirect-nopath',
    };

    const { status, stdout } = runShield(payload, tmpDir);
    assert.equal(status, 0, 'hook must exit 0');

    const decision = parseDecision(stdout);
    assert.equal(decision.permissionDecision, 'allow', 'missing file_path must be allowed (fail-open)');

    // No deny events.
    const events = readEvents(tmpDir);
    const pretoolDenyEvents = events.filter(
      e => e.type === 'event_schemas_full_load_blocked' && e.source === 'pretool-deny'
    );
    assert.equal(pretoolDenyEvents.length, 0, 'must not emit pretool-deny event when file_path is absent');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
