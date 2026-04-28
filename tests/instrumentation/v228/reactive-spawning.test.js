'use strict';

/**
 * Tests for v2.2.8 reactive worker-initiated agent spawning.
 *
 * Covers:
 *   Smoke 1 — request emit: MCP tool writes spawn-requests.jsonl and events.jsonl.
 *   Smoke 2 — auto-approve: hook approves below-threshold request.
 *   Smoke 3 — quota exhaustion: 6th request denied with quota_exhausted.
 *   Smoke 4 — max-depth: spawn from depth>=2 denied with max_depth_exceeded.
 *   Smoke 5 — kill-switch: ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1.
 *   Unit — config schema: reactive_spawn block validates correctly.
 *   Unit — hook fail-open: hook exits 0 even on corrupt requests.jsonl.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_SCRIPT = path.resolve(__dirname, '../../../bin/process-spawn-requests.js');
const TOOL_MODULE = path.resolve(__dirname, '../../../bin/mcp-server/tools/spawn_agent.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reactive-spawn-'));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  });
  return dir;
}

function setupProject(dir, { orchId = 'orch-test-001', config = {}, events = [] } = {}) {
  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Write current-orchestration.json.
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );

  // Write config.json.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify(config)
  );

  // Write events.jsonl.
  if (events.length > 0) {
    const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(path.join(auditDir, 'events.jsonl'), content);
  }

  return { auditDir, stateDir };
}

function readEventsJsonl(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function readSpawnRequests(dir) {
  const p = path.join(dir, '.orchestray', 'state', 'spawn-requests.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function readApprovedSpawns(dir) {
  const p = path.join(dir, '.orchestray', 'state', 'spawn-approved.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function invokeHook(dir, env = {}) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify({ tool_name: 'Agent', cwd: dir }),
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, env),
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Tool-level helpers (call the module directly without spawning a process)
// ---------------------------------------------------------------------------

let spawnAgentTool;
try {
  spawnAgentTool = require(TOOL_MODULE);
} catch (_e) {
  spawnAgentTool = null;
}

// ---------------------------------------------------------------------------
// Smoke 1 — request emit
// ---------------------------------------------------------------------------

describe('Smoke 1 — request emit', () => {
  test('tool queues request in spawn-requests.jsonl and emits spawn_requested event', async (t) => {
    if (!spawnAgentTool) {
      t.skip('spawn_agent module not loadable');
      return;
    }
    const dir = makeTmpDir(t);
    setupProject(dir, { orchId: 'orch-smoke1' });

    const result = await spawnAgentTool.handle(
      {
        agent_type: 'security-engineer',
        prompt: 'Audit the auth module for injection vulnerabilities.',
        justification: 'Found SQL construction in user.js line 42.',
        _orchestration_id: 'orch-smoke1',
        _spawn_depth: 0,
      },
      { projectRoot: dir }
    );

    // Tool should return success.
    assert.equal(result.isError, false, 'tool should not return isError');
    const payload = result.structuredContent || JSON.parse(result.content[0].text);
    assert.equal(payload.status, 'pending', 'status should be pending');
    assert.ok(payload.request_id, 'request_id should be present');

    // spawn-requests.jsonl should have entry.
    const requests = readSpawnRequests(dir);
    assert.equal(requests.length, 1, 'one request should be queued');
    assert.equal(requests[0].requested_agent, 'security-engineer');
    assert.equal(requests[0].status, 'pending');
    assert.equal(requests[0].request_id, payload.request_id);

    // events.jsonl should have spawn_requested event.
    const events = readEventsJsonl(dir);
    const spawnRequested = events.find(e => e.type === 'spawn_requested');
    assert.ok(spawnRequested, 'spawn_requested event should be emitted');
    assert.equal(spawnRequested.orchestration_id, 'orch-smoke1');
    assert.equal(spawnRequested.request_id, payload.request_id);
    assert.equal(spawnRequested.requested_agent, 'security-engineer');
  });
});

// ---------------------------------------------------------------------------
// Smoke 2 — auto-approve
// ---------------------------------------------------------------------------

describe('Smoke 2 — auto-approve', () => {
  test('hook approves below-threshold request and emits spawn_approved', (t) => {
    const dir = makeTmpDir(t);
    const orchId = 'orch-smoke2';

    // Budget: max_cost_usd=10.0, accumulated=0 → remaining=10.0.
    // Threshold=20% → $2.00. Request max_cost=0.50 < $2.00 → approve.
    setupProject(dir, {
      orchId,
      config: { max_cost_usd: 10.0 },
      events: [
        {
          type: 'spawn_requested',
          orchestration_id: orchId,
          request_id: 'req-001',
          requested_agent: 'researcher',
          justification: 'test',
          max_cost_usd: 0.50,
          timestamp: new Date().toISOString(),
          version: 1,
          schema_version: 1,
        },
      ],
    });

    // Write a pending request.
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const req = {
      request_id: 'req-001',
      orchestration_id: orchId,
      requester_agent: 'worker',
      requested_agent: 'researcher',
      justification: 'need research',
      prompt: 'Research rate-limiting libraries.',
      max_cost_usd: 0.50,
      spawn_depth: 0,
      status: 'pending',
      ts: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stateDir, 'spawn-requests.jsonl'),
      JSON.stringify(req) + '\n'
    );

    const { status, stderr } = invokeHook(dir);
    assert.equal(status, 0, 'hook should exit 0');

    // Request should now be approved.
    const requests = readSpawnRequests(dir);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'approved', 'request should be approved');
    assert.equal(requests[0].reason, 'below_threshold');

    // spawn-approved.jsonl should have the entry.
    const approved = readApprovedSpawns(dir);
    assert.equal(approved.length, 1, 'one approved entry');
    assert.equal(approved[0].request_id, 'req-001');

    // spawn_approved event should be in events.jsonl.
    const events = readEventsJsonl(dir);
    const approvedEvent = events.find(e => e.type === 'spawn_approved');
    assert.ok(approvedEvent, 'spawn_approved event should be emitted');
    assert.equal(approvedEvent.reason, 'below_threshold');
    assert.equal(approvedEvent.decision_source, 'auto');

    // No DENIED banner in stderr.
    assert.ok(!stderr.includes('DENIED'), 'should not emit DENIED banner');
  });
});

// ---------------------------------------------------------------------------
// Smoke 3 — quota exhaustion
// ---------------------------------------------------------------------------

describe('Smoke 3 — quota exhaustion', () => {
  test('6th request denied with quota_exhausted when 5 already in events', (t) => {
    const dir = makeTmpDir(t);
    const orchId = 'orch-smoke3';

    // 5 existing spawn_requested events (= quota).
    const existingEvents = Array.from({ length: 5 }, (_, i) => ({
      type: 'spawn_requested',
      orchestration_id: orchId,
      request_id: 'req-prev-' + i,
      requested_agent: 'researcher',
      justification: 'test',
      max_cost_usd: 0.10,
      timestamp: new Date().toISOString(),
      version: 1,
      schema_version: 1,
    }));

    setupProject(dir, {
      orchId,
      config: { max_cost_usd: 10.0 },
      events: existingEvents,
    });

    // Write one pending request (the 6th).
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const req = {
      request_id: 'req-006',
      orchestration_id: orchId,
      requester_agent: 'worker',
      requested_agent: 'security-engineer',
      justification: 'security check needed',
      prompt: 'Check auth.',
      max_cost_usd: 0.10,
      spawn_depth: 0,
      status: 'pending',
      ts: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stateDir, 'spawn-requests.jsonl'),
      JSON.stringify(req) + '\n'
    );

    const { status, stderr } = invokeHook(dir);
    assert.equal(status, 0, 'hook should exit 0 even on denial');

    const requests = readSpawnRequests(dir);
    assert.equal(requests[0].status, 'denied', 'should be denied');
    assert.equal(requests[0].reason, 'quota_exhausted');

    const events = readEventsJsonl(dir);
    const deniedEvent = events.find(e => e.type === 'spawn_denied');
    assert.ok(deniedEvent, 'spawn_denied event should be emitted');
    assert.equal(deniedEvent.reason, 'quota_exhausted');

    assert.ok(stderr.includes('quota_exhausted'), 'stderr should mention quota_exhausted');
  });
});

// ---------------------------------------------------------------------------
// Smoke 4 — max-depth
// ---------------------------------------------------------------------------

describe('Smoke 4 — max-depth', () => {
  test('request with spawn_depth >= max_depth denied with max_depth_exceeded', (t) => {
    const dir = makeTmpDir(t);
    const orchId = 'orch-smoke4';

    setupProject(dir, {
      orchId,
      config: { max_cost_usd: 10.0, reactive_spawn: { max_depth: 2 } },
    });

    // Request from an agent at depth 2 (= max_depth).
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const req = {
      request_id: 'req-depth',
      orchestration_id: orchId,
      requester_agent: 'worker',
      requested_agent: 'researcher',
      justification: 'deeper research',
      prompt: 'Research something.',
      max_cost_usd: 0.05,
      spawn_depth: 2,  // = max_depth → should be denied
      status: 'pending',
      ts: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stateDir, 'spawn-requests.jsonl'),
      JSON.stringify(req) + '\n'
    );

    const { status, stderr } = invokeHook(dir);
    assert.equal(status, 0, 'hook should exit 0 even on denial');

    const requests = readSpawnRequests(dir);
    assert.equal(requests[0].status, 'denied');
    assert.equal(requests[0].reason, 'max_depth_exceeded');

    const events = readEventsJsonl(dir);
    const deniedEvent = events.find(e => e.type === 'spawn_denied');
    assert.ok(deniedEvent, 'spawn_denied event should be emitted');
    assert.equal(deniedEvent.reason, 'max_depth_exceeded');

    assert.ok(stderr.includes('max_depth_exceeded'), 'stderr should mention max_depth_exceeded');
  });

  test('tool rejects input with _spawn_depth >= max_depth', async (t) => {
    if (!spawnAgentTool) {
      t.skip('spawn_agent module not loadable');
      return;
    }
    const dir = makeTmpDir(t);
    setupProject(dir, {
      orchId: 'orch-smoke4b',
      config: { reactive_spawn: { max_depth: 2 } },
    });

    const result = await spawnAgentTool.handle(
      {
        agent_type: 'researcher',
        prompt: 'Deep research.',
        justification: 'Need info.',
        _orchestration_id: 'orch-smoke4b',
        _spawn_depth: 2,  // = max_depth
      },
      { projectRoot: dir }
    );

    assert.equal(result.isError, true, 'tool should return error');
    assert.ok(result.content[0].text.includes('max_depth_exceeded'));
  });
});

// ---------------------------------------------------------------------------
// Smoke 5 — kill-switch
// ---------------------------------------------------------------------------

describe('Smoke 5 — kill-switch', () => {
  test('ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1 causes hook to exit 0 immediately', (t) => {
    const dir = makeTmpDir(t);
    const orchId = 'orch-smoke5';
    setupProject(dir, { orchId });

    // Write a pending request.
    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'spawn-requests.jsonl'),
      JSON.stringify({
        request_id: 'req-ks',
        orchestration_id: orchId,
        requester_agent: 'worker',
        requested_agent: 'researcher',
        justification: 'test',
        prompt: 'Test.',
        max_cost_usd: 0.10,
        spawn_depth: 0,
        status: 'pending',
        ts: new Date().toISOString(),
      }) + '\n'
    );

    const { status } = invokeHook(dir, { ORCHESTRAY_DISABLE_REACTIVE_SPAWN: '1' });
    assert.equal(status, 0, 'hook should exit 0');

    // Request should remain pending (hook did not process).
    const requests = readSpawnRequests(dir);
    assert.equal(requests[0].status, 'pending', 'request should still be pending when killed');
  });

  test('ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1 causes tool to return disabled status', async (t) => {
    if (!spawnAgentTool) {
      t.skip('spawn_agent module not loadable');
      return;
    }
    const dir = makeTmpDir(t);
    setupProject(dir, { orchId: 'orch-smoke5b' });

    const origEnv = process.env.ORCHESTRAY_DISABLE_REACTIVE_SPAWN;
    process.env.ORCHESTRAY_DISABLE_REACTIVE_SPAWN = '1';
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.ORCHESTRAY_DISABLE_REACTIVE_SPAWN;
      } else {
        process.env.ORCHESTRAY_DISABLE_REACTIVE_SPAWN = origEnv;
      }
    });

    const result = await spawnAgentTool.handle(
      {
        agent_type: 'researcher',
        prompt: 'Test.',
        justification: 'Test.',
        _orchestration_id: 'orch-smoke5b',
      },
      { projectRoot: dir }
    );

    assert.equal(result.isError, false, 'should not be an error');
    const payload = result.structuredContent || JSON.parse(result.content[0].text);
    assert.equal(payload.status, 'disabled');
  });
});

// ---------------------------------------------------------------------------
// Unit — config-derived kill switch
// ---------------------------------------------------------------------------

describe('Unit — config-level kill switch', () => {
  test('reactive_spawn.enabled: false causes tool to return disabled', async (t) => {
    if (!spawnAgentTool) {
      t.skip('spawn_agent module not loadable');
      return;
    }
    const dir = makeTmpDir(t);
    setupProject(dir, {
      orchId: 'orch-config-ks',
      config: { reactive_spawn: { enabled: false } },
    });

    const result = await spawnAgentTool.handle(
      {
        agent_type: 'researcher',
        prompt: 'Test.',
        justification: 'Test.',
        _orchestration_id: 'orch-config-ks',
      },
      { projectRoot: dir }
    );

    assert.equal(result.isError, false);
    const payload = result.structuredContent || JSON.parse(result.content[0].text);
    assert.equal(payload.status, 'disabled');
  });
});

// ---------------------------------------------------------------------------
// Unit — hook fail-open on corrupt spawn-requests.jsonl
// ---------------------------------------------------------------------------

describe('Unit — hook fail-open', () => {
  test('hook exits 0 on corrupt spawn-requests.jsonl', (t) => {
    const dir = makeTmpDir(t);
    setupProject(dir, { orchId: 'orch-failopen' });

    const stateDir = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'spawn-requests.jsonl'),
      'NOT_VALID_JSON\n{"broken":'
    );

    const { status } = invokeHook(dir);
    assert.equal(status, 0, 'hook should exit 0 on corrupt queue');
  });

  test('hook exits 0 with no orchestration context', (t) => {
    const dir = makeTmpDir(t);
    // No .orchestray directory at all.
    const { status } = invokeHook(dir);
    assert.equal(status, 0, 'hook should exit 0 with no orchestration');
  });
});

// ---------------------------------------------------------------------------
// Unit — input validation
// ---------------------------------------------------------------------------

describe('Unit — input validation', () => {
  test('tool rejects missing required fields', async (t) => {
    if (!spawnAgentTool) {
      t.skip('spawn_agent module not loadable');
      return;
    }
    const dir = makeTmpDir(t);
    setupProject(dir, { orchId: 'orch-validation' });

    const result = await spawnAgentTool.handle(
      { agent_type: 'researcher' /* missing prompt, justification */ },
      { projectRoot: dir }
    );
    assert.equal(result.isError, true, 'should return error for missing fields');
  });

  test('tool rejects unknown agent_type', async (t) => {
    if (!spawnAgentTool) {
      t.skip('spawn_agent module not loadable');
      return;
    }
    const dir = makeTmpDir(t);
    setupProject(dir, { orchId: 'orch-validation2' });

    const result = await spawnAgentTool.handle(
      {
        agent_type: 'not-a-real-agent',
        prompt: 'Test.',
        justification: 'Test.',
      },
      { projectRoot: dir }
    );
    assert.equal(result.isError, true, 'should return error for unknown agent_type');
  });
});

// ---------------------------------------------------------------------------
// Unit — hooks.json registration
// ---------------------------------------------------------------------------

describe('Unit — hooks.json registration', () => {
  test('process-spawn-requests.js is registered in hooks.json as PreToolUse:Agent', () => {
    const hooksPath = path.resolve(__dirname, '../../../hooks/hooks.json');
    const hooksContent = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const preToolHooks = hooksContent.hooks.PreToolUse || [];

    const hasEntry = preToolHooks.some(group => {
      const matcher = group.matcher || '';
      if (!matcher.includes('Agent')) return false;
      return (group.hooks || []).some(h =>
        typeof h.command === 'string' && h.command.includes('process-spawn-requests.js')
      );
    });

    assert.ok(hasEntry, 'process-spawn-requests.js should be registered in hooks.json PreToolUse:Agent');
  });
});

// ---------------------------------------------------------------------------
// Unit — server.js registration
// ---------------------------------------------------------------------------

describe('Unit — server.js registration', () => {
  test('spawn_agent tool is registered in TOOL_TABLE', () => {
    const serverPath = path.resolve(__dirname, '../../../bin/mcp-server/server.js');
    const content = fs.readFileSync(serverPath, 'utf8');
    assert.ok(content.includes('spawn_agent'), 'server.js should reference spawn_agent');
    assert.ok(content.includes("require('./tools/spawn_agent')"), 'server.js should require spawn_agent tool');
  });
});
