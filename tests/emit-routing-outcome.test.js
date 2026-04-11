#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/emit-routing-outcome.js
 *
 * PostToolUse:Agent hook — appends routing_outcome events to events.jsonl
 * after each Agent() spawn inside an orchestration.
 * Always exits 0 and writes { continue: true } to stdout.
 *
 * The critical regression locked in here: non-Agent tool calls (Bash, Read,
 * Edit, etc.) must NEVER append to events.jsonl. A missing tool_name guard
 * was the exact bug caught in code review — these tests would have caught it.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/emit-routing-outcome.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create an isolated tmpdir.
 * withOrch=true writes current-orchestration.json; orchestrationId sets its content.
 * Returns { dir, auditDir }.
 */
function makeDir({ withOrch = false, orchestrationId = 'orch-test-001' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-emit-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  if (withOrch) {
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchestrationId })
    );
  }
  return { dir, auditDir };
}

function run(payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function parseOutput(stdout) {
  return JSON.parse(stdout.trim());
}

/**
 * Read events.jsonl from the audit dir and parse each line as JSON.
 * Returns an empty array if the file does not exist.
 */
function readEvents(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Always exits 0 + outputs { continue: true }
// ---------------------------------------------------------------------------

describe('output contract — always exits 0 with continue:true', () => {

  test('exits 0 and writes continue:true on valid Agent call', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const { stdout, status } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet', subagent_type: 'developer', description: 'Implement feature X' },
    });
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 with continue:true on malformed JSON stdin', () => {
    const { stdout, status } = run('{{not json}}');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 with continue:true on empty stdin', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});

// ---------------------------------------------------------------------------
// REGRESSION: non-Agent tool_name must never write events
// This is the exact bug caught in review — locking it in with file assertions
// ---------------------------------------------------------------------------

describe('tool filtering — regression: non-Agent tools must not write events', () => {

  test('Bash tool_name exits 0 and does NOT append to events.jsonl', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const { status } = run({ tool_name: 'Bash', cwd: dir, tool_input: {} });

    assert.equal(status, 0);
    // The file must not have been created
    assert.equal(fs.existsSync(eventsPath), false,
      'Bash tool_name must not create events.jsonl');
  });

  test('Read tool_name exits 0 and does NOT append to events.jsonl', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const { status } = run({ tool_name: 'Read', cwd: dir, tool_input: {} });

    assert.equal(status, 0);
    assert.equal(fs.existsSync(eventsPath), false,
      'Read tool_name must not create events.jsonl');
  });

  test('Edit tool_name exits 0 and does NOT append to events.jsonl', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const { status } = run({ tool_name: 'Edit', cwd: dir, tool_input: {} });

    assert.equal(status, 0);
    assert.equal(fs.existsSync(eventsPath), false,
      'Edit tool_name must not create events.jsonl');
  });

  test('non-Agent tool does not append even when events.jsonl already exists', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    // Pre-create the file with a sentinel line
    fs.writeFileSync(eventsPath, '{"type":"sentinel"}\n');

    run({ tool_name: 'Bash', cwd: dir, tool_input: {} });

    const contents = fs.readFileSync(eventsPath, 'utf8');
    assert.equal(contents, '{"type":"sentinel"}\n',
      'Bash call must not append to a pre-existing events.jsonl');
  });

});

// ---------------------------------------------------------------------------
// Outside orchestration — no current-orchestration.json
// ---------------------------------------------------------------------------

describe('outside orchestration', () => {

  test('Agent tool with no current-orchestration.json exits 0 and writes nothing', () => {
    const { dir, auditDir } = makeDir({ withOrch: false });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const { status } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet' },
    });

    assert.equal(status, 0);
    assert.equal(fs.existsSync(eventsPath), false,
      'No event should be written when outside an orchestration');
  });

});

// ---------------------------------------------------------------------------
// Inside orchestration — write path
// ---------------------------------------------------------------------------

describe('inside orchestration — event write path', () => {

  test('writes routing_outcome event with correct fields', () => {
    const { dir, auditDir } = makeDir({ withOrch: true, orchestrationId: 'orch-abc-123' });

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        model: 'sonnet',
        subagent_type: 'developer',
        description: 'Implement feature X',
      },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1, 'Exactly one event should be appended');

    const ev = events[0];
    assert.equal(ev.type, 'routing_outcome');
    assert.equal(ev.source, 'hook');
    assert.equal(ev.orchestration_id, 'orch-abc-123');
    assert.equal(ev.agent_type, 'developer');
    assert.equal(ev.model_assigned, 'sonnet');
    assert.equal(ev.description, 'Implement feature X');
    // timestamp must parse as ISO 8601
    assert.ok(!isNaN(Date.parse(ev.timestamp)), 'timestamp must be valid ISO 8601');
  });

  test('normalizes full model id "claude-opus-4-6" to model_assigned="opus"', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'claude-opus-4-6', subagent_type: 'architect' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].model_assigned, 'opus');
  });

  test('normalizes "claude-haiku-3-5" to model_assigned="haiku"', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'claude-haiku-3-5', subagent_type: 'reviewer' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].model_assigned, 'haiku');
  });

  test('truncates description to 200 chars for a 500-char input', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const longDesc = 'x'.repeat(500);

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet', description: longDesc },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].description.length, 200,
      'description must be truncated to exactly 200 chars');
  });

  test('two sequential calls produce two events in order', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'haiku', subagent_type: 'reviewer', description: 'First call' },
    });
    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'opus', subagent_type: 'architect', description: 'Second call' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 2, 'Both events must be appended');
    assert.equal(events[0].description, 'First call');
    assert.equal(events[0].model_assigned, 'haiku');
    assert.equal(events[1].description, 'Second call');
    assert.equal(events[1].model_assigned, 'opus');
  });

  test('uses "prompt" field as description fallback when "description" is absent', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet', prompt: 'Prompt-based description' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].description, 'Prompt-based description');
  });

  test('missing tool_input exits 0 and does not crash (fail-open)', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const { status, stdout } = run({ tool_name: 'Agent', cwd: dir });
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
    // Event may or may not be written (tool_input defaults to {}, so it writes
    // an event with null model and null agent_type). Assert we don't crash.
    // If written, it must still be valid JSON.
    if (fs.existsSync(eventsPath)) {
      const events = readEvents(auditDir);
      assert.ok(events.length >= 1, 'If file exists it must contain valid JSON lines');
    }
  });

  test('effort field is captured in effort_assigned', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'opus', effort: 'high', subagent_type: 'architect' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].effort_assigned, 'high');
  });

  test('orchestration_id falls back to "unknown" if current-orchestration.json has no id field', () => {
    const { dir, auditDir } = makeDir({ withOrch: false });
    // Write a malformed orchestration file without orchestration_id
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ phase: 'execution' })
    );

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].orchestration_id, 'unknown');
  });

});

// ---------------------------------------------------------------------------
// Failure modes — must always exit 0 (fail-open)
// ---------------------------------------------------------------------------

describe('failure modes — fail open', () => {

  test('malformed JSON stdin exits 0 with continue:true and writes nothing', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');

    const { status, stdout } = run('not-json at all');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
    assert.equal(fs.existsSync(eventsPath), false);
  });

  test('read-only audit directory exits 0 (fail-open on write failure)', () => {
    const { dir, auditDir } = makeDir({ withOrch: true });

    // Make the audit dir read-only so writing events.jsonl fails
    fs.chmodSync(auditDir, 0o555);

    let status;
    try {
      const result = run({
        tool_name: 'Agent',
        cwd: dir,
        tool_input: { model: 'sonnet', subagent_type: 'developer' },
      });
      status = result.status;
    } finally {
      // Restore permissions so cleanup can delete the dir
      try { fs.chmodSync(auditDir, 0o755); } catch (_e) {}
    }

    assert.equal(status, 0, 'Script must fail open even when the audit dir is read-only');
  });

});

// ---------------------------------------------------------------------------
// Concurrent append — verifies atomicAppendJsonl holds under parallel writers
// ---------------------------------------------------------------------------

describe('concurrent append', () => {

  test('N parallel hook invocations all land as N valid jsonl lines', async () => {
    const { spawn } = require('node:child_process');
    const { dir, auditDir } = makeDir({ withOrch: true, orchestrationId: 'orch-concurrent-001' });

    const N = 10;
    const models = ['sonnet', 'opus', 'haiku'];
    const agentTypes = ['developer', 'reviewer', 'architect', 'tester'];

    // Spawn N processes simultaneously — don't wait on one before starting the next
    const procs = [];
    for (let i = 0; i < N; i++) {
      const payload = JSON.stringify({
        tool_name: 'Agent',
        cwd: dir,
        tool_input: {
          model: models[i % models.length],
          subagent_type: agentTypes[i % agentTypes.length],
          description: `concurrent-call-${i}`,
        },
      });
      const child = spawn(process.execPath, [SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.write(payload);
      child.stdin.end();
      procs.push(new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code));
      }));
    }

    const exitCodes = await Promise.all(procs);
    for (let i = 0; i < N; i++) {
      assert.equal(exitCodes[i], 0, `child ${i} must exit 0`);
    }

    // Every write must have landed — no lost updates from the atomic append
    const events = readEvents(auditDir);
    assert.equal(events.length, N, `Expected exactly ${N} appended events from ${N} concurrent writers`);

    // Every line must parse — no interleaved/corrupted frames
    for (const ev of events) {
      assert.equal(ev.type, 'routing_outcome');
      assert.equal(ev.source, 'hook');
      assert.equal(ev.orchestration_id, 'orch-concurrent-001');
      assert.ok(['sonnet', 'opus', 'haiku'].includes(ev.model_assigned));
      assert.ok(/^concurrent-call-\d+$/.test(ev.description));
    }

    // All N distinct descriptions must be present — no duplicate loss, no
    // silent drops. Order across processes is non-deterministic so we compare
    // as a set, not a list.
    const descriptions = new Set(events.map(e => e.description));
    assert.equal(descriptions.size, N, 'All N unique descriptions must be present');
    for (let i = 0; i < N; i++) {
      assert.ok(descriptions.has(`concurrent-call-${i}`),
        `description concurrent-call-${i} missing — atomic append lost an update`);
    }
  });

});

// ---------------------------------------------------------------------------
// D4 item 4 — routing_outcome Variant A tool_name extension (2.0.12)
// ---------------------------------------------------------------------------

describe('D4 item 4 — routing_outcome tool_name field for Explore dispatch', () => {

  test('Explore dispatch produces routing_outcome row with tool_name: "Explore"', () => {
    // 2.0.12: hooks.json matcher now covers Explore. The routing_outcome event
    // emitted by emit-routing-outcome.js must record tool_name="Explore" so
    // analytics can distinguish Explore from Agent spawns.
    const { dir, auditDir } = makeDir({ withOrch: true });

    run({
      tool_name: 'Explore',
      cwd: dir,
      tool_input: { model: 'haiku', subagent_type: 'explorer', description: 'Explore codebase' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1,
      'Explore dispatch must produce exactly one routing_outcome event');
    assert.equal(events[0].tool_name, 'Explore',
      'routing_outcome for Explore dispatch must have tool_name: "Explore"');
  });

  test('Agent dispatch routing_outcome has tool_name: "Agent" (or defaults to "Agent" when absent)', () => {
    // Backward-compat: existing Agent dispatches must not break.
    // tool_name defaults to "Agent" when absent (backward-compat per D4 item 4).
    const { dir, auditDir } = makeDir({ withOrch: true });

    run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { model: 'sonnet', subagent_type: 'developer', description: 'Implement feature' },
    });

    const events = readEvents(auditDir);
    assert.equal(events.length, 1);
    // The field must be either 'Agent' explicitly, or absent (defaulting to Agent).
    // We accept either: the contract is that if present it is 'Agent', never 'Explore'.
    const toolNameField = events[0].tool_name;
    assert.ok(
      toolNameField === 'Agent' || toolNameField === undefined || toolNameField === null,
      'Agent dispatch routing_outcome tool_name must be "Agent" or absent (defaults to "Agent"). Got: ' +
      JSON.stringify(toolNameField)
    );
  });

});
