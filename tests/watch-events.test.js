#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/watch-events.js
 *
 * Validates:
 * - Correct formatting of each event type (orchestration_start, agent_start,
 *   agent_stop, routing_outcome success/error, wave_complete, w_item_complete,
 *   orchestration_complete, unknown types)
 * - routing_outcome with result:error is suppressed
 * - Poller exits on orchestration_complete
 * - Poller picks up newly appended lines mid-poll (append test)
 * - Poller handles missing / unreadable files gracefully
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/watch-events.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watch-events-test-'));
}

function writeEventsFile(dir, events) {
  const filePath = path.join(dir, 'events.jsonl');
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, content);
  return filePath;
}

function appendEvent(filePath, event) {
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n');
}

/**
 * Run the poller synchronously against a pre-written fixture file.
 * Uses --interval=10 so the test does not wait 2 seconds between polls.
 */
function runSync(eventsFilePath, { timeout = 5000 } = {}) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, eventsFilePath, '--interval=10'],
    { encoding: 'utf8', timeout }
  );
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Run the poller as a background child process and collect its output
 * incrementally so we can feed it new lines while it runs.
 */
function runAsync(eventsFilePath, { interval = 10 } = {}) {
  const child = spawn(
    process.execPath,
    [SCRIPT, eventsFilePath, `--interval=${interval}`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    waitForExit: (timeoutMs = 5000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`process did not exit within ${timeoutMs}ms`));
      }, timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// Fixture events
// ---------------------------------------------------------------------------

const EVT_ORCH_START = {
  type: 'orchestration_start',
  orchestration_id: 'orch-abc-001',
  task: 'Build the API layer',
};

const EVT_AGENT_START = {
  type: 'agent_start',
  agent_type: 'developer',
  w_id: 'W3',
};

const EVT_AGENT_STOP = {
  type: 'agent_stop',
  agent_type: 'developer',
  w_id: 'W3',
  turns_used: 12,
  estimated_cost_usd: 0.0312,
};

const EVT_ROUTING_SUCCESS = {
  type: 'routing_outcome',
  result: 'success',
  agent_type: 'reviewer',
  model_assigned: 'sonnet',
  input_tokens: 4200,
  output_tokens: 380,
};

const EVT_ROUTING_ERROR = {
  type: 'routing_outcome',
  result: 'error',
  agent_type: 'reviewer',
  model_assigned: 'sonnet',
};

const EVT_WAVE_COMPLETE = {
  type: 'wave_complete',
  w_id: 'W3',
  tests_delta: 5,
};

const EVT_W_ITEM_COMPLETE = {
  type: 'w_item_complete',
  w_id: 'W2',
  tests_delta: -1,
};

const EVT_ORCH_COMPLETE = {
  type: 'orchestration_complete',
  status: 'success',
  total_cost_usd: 1.2345,
};

const EVT_UNKNOWN = {
  type: 'some_custom_event',
  foo: 'bar',
};

// ---------------------------------------------------------------------------
// § 1 Event formatting — one event at a time
// ---------------------------------------------------------------------------

describe('event formatting', () => {

  test('orchestration_start shows id and task', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_ORCH_START, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const startLine = lines.find(l => l.includes('orchestration_start'));
      assert.ok(startLine, 'should have an orchestration_start line');
      assert.ok(startLine.includes('orch-abc-001'), 'should include orchestration id');
      assert.ok(startLine.includes('Build the API layer'), 'should include task text');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('agent_start shows agent_type and w_id', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_AGENT_START, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const line = lines.find(l => l.includes('agent_start'));
      assert.ok(line, 'should have an agent_start line');
      assert.ok(line.includes('developer'), 'should include agent_type');
      assert.ok(line.includes('W3'), 'should include w_id');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('agent_stop shows agent_type, w_id, turns_used, and cost', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_AGENT_STOP, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const line = lines.find(l => l.includes('agent_stop'));
      assert.ok(line, 'should have an agent_stop line');
      assert.ok(line.includes('developer'), 'should include agent_type');
      assert.ok(line.includes('W3'), 'should include w_id');
      assert.ok(line.includes('turns=12'), 'should include turns_used');
      assert.ok(line.includes('cost='), 'should include cost');
      assert.ok(line.includes('0.0312'), 'should format cost to 4 decimal places');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('routing_outcome result:success shows agent, model, token counts', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_ROUTING_SUCCESS, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const line = lines.find(l => l.includes('routing'));
      assert.ok(line, 'should have a routing line');
      assert.ok(line.includes('reviewer'), 'should include agent_type');
      assert.ok(line.includes('sonnet'), 'should include model');
      assert.ok(line.includes('4200'), 'should include input_tokens');
      assert.ok(line.includes('380'), 'should include output_tokens');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('routing_outcome result:error is SUPPRESSED from output', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_ROUTING_ERROR, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      // The routing error line must not appear; only orchestration_complete should
      const routingLines = lines.filter(l => l.includes('routing'));
      assert.equal(routingLines.length, 0, 'routing result:error rows must be suppressed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('wave_complete shows w_id and tests_delta', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_WAVE_COMPLETE, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const line = lines.find(l => l.includes('wave_complete'));
      assert.ok(line, 'should have a wave_complete line');
      assert.ok(line.includes('W3'), 'should include w_id');
      assert.ok(line.includes('tests_delta=5'), 'should include tests_delta');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('w_item_complete shows w_id and tests_delta', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_W_ITEM_COMPLETE, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const line = lines.find(l => l.includes('w_item_complete'));
      assert.ok(line, 'should have a w_item_complete line');
      assert.ok(line.includes('W2'), 'should include w_id');
      assert.ok(line.includes('tests_delta=-1'), 'should include negative tests_delta');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('orchestration_complete shows verdict and total cost', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const line = lines.find(l => l.includes('orchestration_complete'));
      assert.ok(line, 'should have an orchestration_complete line');
      assert.ok(line.includes('success'), 'should include verdict');
      assert.ok(line.includes('1.2345'), 'should include total cost');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('unknown event type shows type and compact JSON', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_UNKNOWN, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      const line = lines.find(l => l.includes('some_custom_event'));
      assert.ok(line, 'should print unknown event type');
      assert.ok(line.includes('bar'), 'should include JSON payload content');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('each output line has a HH:MM:SS timestamp prefix', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_ORCH_START, EVT_ORCH_COMPLETE]);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(l => l.trim() && !l.startsWith('['));

      for (const line of lines) {
        assert.match(line, /^\d{2}:\d{2}:\d{2}/, `line should start with HH:MM:SS: ${line}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// § 2 Five-event fixture (spec requirement)
// ---------------------------------------------------------------------------

describe('five-event fixture', () => {

  test('processes 5 mixed events: start, agent_start, routing success, routing error (suppressed), complete', () => {
    const tmpDir = makeTmpDir();
    try {
      const events = [
        EVT_ORCH_START,
        EVT_AGENT_START,
        EVT_ROUTING_SUCCESS,
        EVT_ROUTING_ERROR,  // must be suppressed
        EVT_ORCH_COMPLETE,
      ];
      const file = writeEventsFile(tmpDir, events);
      const { stdout, status } = runSync(file);

      assert.equal(status, 0, 'should exit 0 on orchestration_complete');

      const lines = stdout.split('\n').filter(Boolean);

      // orchestration_start must appear
      assert.ok(lines.some(l => l.includes('orchestration_start')), 'must show orchestration_start');

      // agent_start must appear
      assert.ok(lines.some(l => l.includes('agent_start')), 'must show agent_start');

      // routing success must appear
      assert.ok(lines.some(l => l.includes('routing')), 'must show routing success');

      // routing error must NOT appear
      // (the routing success line IS there, but it should be the only routing line)
      const routingLines = lines.filter(l => l.includes('routing'));
      assert.equal(routingLines.length, 1, 'only the success routing line should appear (error suppressed)');

      // orchestration_complete must appear
      assert.ok(lines.some(l => l.includes('orchestration_complete')), 'must show orchestration_complete');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// § 3 Exit on orchestration_complete
// ---------------------------------------------------------------------------

describe('exit on orchestration_complete', () => {

  test('exits with code 0 when orchestration_complete is encountered', () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_ORCH_START, EVT_ORCH_COMPLETE]);
      const { status } = runSync(file);
      assert.equal(status, 0, 'should exit 0 on orchestration_complete');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('does not exit if orchestration_complete has not appeared yet', async () => {
    const tmpDir = makeTmpDir();
    try {
      // File with no complete event
      const file = writeEventsFile(tmpDir, [EVT_ORCH_START]);

      const proc = runAsync(file, { interval: 10 });

      // Give it some time — it should NOT exit
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(proc.child.exitCode, null, 'process should still be running');

      // Now write the complete event
      appendEvent(file, EVT_ORCH_COMPLETE);

      // Wait for exit
      const { code } = await proc.waitForExit(3000);
      assert.equal(code, 0, 'should exit 0 after orchestration_complete is appended');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// § 4 Mid-poll append test
// ---------------------------------------------------------------------------

describe('mid-poll append', () => {

  test('picks up lines appended after initial read', async () => {
    const tmpDir = makeTmpDir();
    try {
      // Start with 2 events
      const file = writeEventsFile(tmpDir, [EVT_ORCH_START, EVT_AGENT_START]);

      const proc = runAsync(file, { interval: 10 });

      // Give the poller time to read the initial 2 events
      await new Promise(resolve => setTimeout(resolve, 150));

      // Append 2 more events
      appendEvent(file, EVT_AGENT_STOP);
      appendEvent(file, EVT_ORCH_COMPLETE);

      const { code, stdout } = await proc.waitForExit(3000);

      assert.equal(code, 0, 'should exit on orchestration_complete');

      const lines = stdout.split('\n').filter(Boolean);

      // All 4 expected event types should appear in output
      assert.ok(lines.some(l => l.includes('orchestration_start')), 'must show orchestration_start');
      assert.ok(lines.some(l => l.includes('agent_start')), 'must show agent_start');
      assert.ok(lines.some(l => l.includes('agent_stop')), 'must show agent_stop (appended)');
      assert.ok(lines.some(l => l.includes('orchestration_complete')), 'must show orchestration_complete (appended)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('all 4 events appear in output order', async () => {
    const tmpDir = makeTmpDir();
    try {
      const file = writeEventsFile(tmpDir, [EVT_ORCH_START, EVT_AGENT_START]);

      const proc = runAsync(file, { interval: 10 });
      await new Promise(resolve => setTimeout(resolve, 120));

      appendEvent(file, EVT_ROUTING_SUCCESS);
      appendEvent(file, EVT_ORCH_COMPLETE);

      const { stdout } = await proc.waitForExit(3000);
      const lines = stdout.split('\n').filter(l => /\d{2}:\d{2}:\d{2}/.test(l));

      const types = lines.map(l => {
        if (l.includes('orchestration_start')) return 'orchestration_start';
        if (l.includes('agent_start')) return 'agent_start';
        if (l.includes('routing')) return 'routing';
        if (l.includes('orchestration_complete')) return 'orchestration_complete';
        return 'other';
      }).filter(t => t !== 'other');

      // All 4 types should appear
      assert.ok(types.includes('orchestration_start'));
      assert.ok(types.includes('agent_start'));
      assert.ok(types.includes('routing'));
      assert.ok(types.includes('orchestration_complete'));

      // Order: start should come before complete
      assert.ok(
        types.indexOf('orchestration_start') < types.indexOf('orchestration_complete'),
        'orchestration_start should appear before orchestration_complete'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// § 5 Robustness
// ---------------------------------------------------------------------------

describe('robustness', () => {

  test('exits 1 when an explicit file path is given but does not exist', () => {
    const { status } = runSync('/nonexistent/path/events.jsonl');
    assert.equal(status, 1, 'should exit 1 when explicit file path is missing');
  });

  test('handles malformed JSON lines without crashing', () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = path.join(tmpDir, 'events.jsonl');
      fs.writeFileSync(filePath, 'not valid json\n' + JSON.stringify(EVT_ORCH_COMPLETE) + '\n');
      const { stdout, status } = runSync(filePath);

      assert.equal(status, 0, 'should still exit 0 even with malformed lines');
      const lines = stdout.split('\n').filter(Boolean);
      assert.ok(lines.some(l => l.includes('[parse error]')), 'should label malformed lines');
      assert.ok(lines.some(l => l.includes('orchestration_complete')), 'should continue after malformed line');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('suppresses routing error rows in five-event full run', () => {
    const tmpDir = makeTmpDir();
    try {
      const events = [
        EVT_ORCH_START,
        EVT_AGENT_START,
        EVT_ROUTING_SUCCESS,
        EVT_ROUTING_ERROR,
        EVT_ORCH_COMPLETE,
      ];
      const file = writeEventsFile(tmpDir, events);
      const { stdout } = runSync(file);
      const lines = stdout.split('\n').filter(Boolean);

      // Confirm the error row is absent from output
      const hasErrorRow = lines.some(l => l.includes('result') && l.includes('error'));
      assert.equal(hasErrorRow, false, 'routing result:error must not appear in output');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});
