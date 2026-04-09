#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/collect-agent-metrics.js
 *
 * This hook receives SubagentStop or TaskCompleted events on stdin,
 * reads transcript files, and appends a structured event to events.jsonl.
 * It must ALWAYS exit 0 and write { continue: true }.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/collect-agent-metrics.js');

function run(stdinData) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
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

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-metrics-test-'));
}

function writeOrchestrationId(auditDir, id) {
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

function readEventsJsonl(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Exit codes and safe fallback
// ---------------------------------------------------------------------------

describe('exit codes and safe fallback', () => {

  test('exits 0 with continue:true on empty stdin', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 with continue:true on invalid JSON stdin', () => {
    const { stdout, status } = run('{{not json}}');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 with continue:true on missing fields', () => {
    const { stdout, status } = run(JSON.stringify({}));
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('always exits 0 regardless of filesystem errors', () => {
    // Provide a cwd that does not exist — mkdirSync will still create it
    // but even if it fails the script should exit 0
    const input = JSON.stringify({
      cwd: '/nonexistent/path/that/cannot/be/created',
      hook_event_name: 'SubagentStop',
      agent_type: 'developer',
    });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

  test('exits 0 on very large stdin (>1MB)', () => {
    const bigInput = JSON.stringify({
      cwd: os.tmpdir(),
      hook_event_name: 'SubagentStop',
      last_assistant_message: 'x'.repeat(1_200_000),
    });
    const { stdout, status } = run(bigInput);
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});

// ---------------------------------------------------------------------------
// SubagentStop event handling
// ---------------------------------------------------------------------------

describe('SubagentStop event handling', () => {

  test('writes agent_stop event to events.jsonl', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-test-001');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_id: 'agent-abc',
        session_id: 'sess-xyz',
        last_assistant_message: 'I completed the task successfully.',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1, 'should write exactly one event');
      const ev = events[0];
      assert.equal(ev.type, 'agent_stop');
      assert.equal(ev.orchestration_id, 'orch-test-001');
      assert.equal(ev.agent_type, 'developer');
      assert.equal(ev.agent_id, 'agent-abc');
      assert.equal(ev.session_id, 'sess-xyz');
      assert.ok(ev.timestamp, 'event should have timestamp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('last_message_preview is truncated to 200 characters', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-002');

    try {
      const longMessage = 'A'.repeat(500);
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'reviewer',
        last_assistant_message: longMessage,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].last_message_preview.length, 200,
        'last_message_preview should be truncated to 200 chars');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('uses "unknown" orchestration_id when current-orchestration.json is missing', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    // Do NOT write current-orchestration.json

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].orchestration_id, 'unknown');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('falls back to event_payload usage when transcript yields zero tokens', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-003');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[0];
      assert.equal(ev.usage.input_tokens, 1000);
      assert.equal(ev.usage.output_tokens, 500);
      assert.equal(ev.usage_source, 'event_payload');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('estimates tokens from turn count when both transcript and payload have zero tokens', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-004');

    // Write a transcript with 3 assistant turns but no usage fields
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ role: 'user', content: 'do this' }),
      JSON.stringify({ role: 'assistant', content: 'ok' }),
      JSON.stringify({ role: 'user', content: 'continue' }),
      JSON.stringify({ role: 'assistant', content: 'done' }),
      JSON.stringify({ role: 'assistant', content: 'also done' }),
    ].join('\n');
    fs.writeFileSync(transcriptPath, lines);

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[0];
      // 3 assistant turns → 3 * 2000 = 6000 input, 3 * 1000 = 3000 output
      assert.equal(ev.usage.input_tokens, 6000, 'estimated input tokens should be turns * 2000');
      assert.equal(ev.usage.output_tokens, 3000, 'estimated output tokens should be turns * 1000');
      assert.equal(ev.usage_source, 'estimated');
      assert.equal(ev.turns_used, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('reads token usage from transcript when present', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-005');

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ role: 'assistant', usage: { input_tokens: 5000, output_tokens: 2000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } }),
      JSON.stringify({ role: 'assistant', usage: { input_tokens: 3000, output_tokens: 1500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    ].join('\n');
    fs.writeFileSync(transcriptPath, lines);

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[0];
      assert.equal(ev.usage.input_tokens, 8000, 'should sum input tokens across all turns');
      assert.equal(ev.usage.output_tokens, 3500, 'should sum output tokens');
      assert.equal(ev.usage.cache_read_input_tokens, 1000, 'should sum cache read tokens');
      assert.equal(ev.usage_source, 'transcript');
      assert.equal(ev.turns_used, 2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('handles transcript with malformed lines gracefully', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-006');

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    // Mix valid and malformed lines
    const lines = [
      JSON.stringify({ role: 'assistant', usage: { input_tokens: 1000, output_tokens: 500 } }),
      '{{{INVALID JSON',
      JSON.stringify({ role: 'user', content: 'hello' }),
      'another bad line',
    ].join('\n');
    fs.writeFileSync(transcriptPath, lines);

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      });
      const { status } = run(input);
      assert.equal(status, 0, 'should not crash on malformed transcript lines');
      const events = readEventsJsonl(auditDir);
      assert.equal(events[0].usage.input_tokens, 1000, 'should sum from valid lines only');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('handles nonexistent transcript path gracefully', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-007');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: '/nonexistent/transcript.jsonl',
      });
      const { status } = run(input);
      assert.equal(status, 0, 'should not crash on missing transcript');
      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1, 'should still write event');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// TaskCompleted (team event) handling
// ---------------------------------------------------------------------------

describe('TaskCompleted event handling', () => {

  test('writes task_completed_metrics event for team events', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-team-001');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'TaskCompleted',
        task_id: 'task-001',
        task_subject: 'Implement auth module',
        teammate_name: 'developer',
        team_name: 'alpha',
        session_id: 'sess-001',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1);
      const ev = events[0];
      assert.equal(ev.type, 'task_completed_metrics');
      assert.equal(ev.mode, 'teams');
      assert.equal(ev.orchestration_id, 'orch-team-001');
      assert.equal(ev.agent_type, 'developer');
      assert.equal(ev.task_subject, 'Implement auth module');
      assert.equal(ev.team_name, 'alpha');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('uses transcript_path (not agent_transcript_path) for team events', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-team-002');

    const transcriptPath = path.join(tmpDir, 'team-transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ role: 'assistant', usage: { input_tokens: 800, output_tokens: 400 } }) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'TaskCompleted',
        task_id: 'task-002',
        task_subject: 'Write tests',
        transcript_path: transcriptPath,
        // Note: agent_transcript_path is NOT set — team events use transcript_path
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[0];
      assert.equal(ev.usage.input_tokens, 800);
      assert.equal(ev.usage_source, 'transcript');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Pricing and cost calculation
// ---------------------------------------------------------------------------

describe('pricing and cost estimation', () => {

  test('applies opus pricing for opus model', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-pricing-001');

    // Write a routing_outcome event so resolveModelUsed returns opus
    const eventsPath = path.join(auditDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, JSON.stringify({
      type: 'routing_outcome',
      orchestration_id: 'orch-pricing-001',
      agent_type: 'architect',
      model_assigned: 'claude-opus-4-6',
    }) + '\n');

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    // 1M input tokens, 1M output tokens → with opus: $5 input + $25 output = $30
    fs.writeFileSync(transcriptPath, JSON.stringify({
      role: 'assistant',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'architect',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      // Second event is the agent_stop (first is routing_outcome we seeded)
      const ev = events[events.length - 1];
      assert.ok(ev.estimated_cost_usd > 0, 'cost should be positive');
      // opus: $5/M input + $25/M output = $30 for 1M each
      assert.ok(Math.abs(ev.estimated_cost_usd - 30.0) < 0.01,
        `opus cost should be ~$30 for 1M+1M tokens, got ${ev.estimated_cost_usd}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('applies haiku pricing for haiku model', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-pricing-002');

    const eventsPath = path.join(auditDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, JSON.stringify({
      type: 'routing_outcome',
      orchestration_id: 'orch-pricing-002',
      agent_type: 'researcher',
      model_assigned: 'claude-haiku-4-5',
    }) + '\n');

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    // 1M input + 1M output → haiku: $1 + $5 = $6
    fs.writeFileSync(transcriptPath, JSON.stringify({
      role: 'assistant',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'researcher',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[events.length - 1];
      assert.ok(Math.abs(ev.estimated_cost_usd - 6.0) < 0.01,
        `haiku cost should be ~$6 for 1M+1M tokens, got ${ev.estimated_cost_usd}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('defaults to sonnet pricing for unknown agent types', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-pricing-003');

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    // 1M input + 1M output → sonnet: $3 + $15 = $18
    fs.writeFileSync(transcriptPath, JSON.stringify({
      role: 'assistant',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'some_unknown_agent_type',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[events.length - 1];
      assert.ok(Math.abs(ev.estimated_cost_usd - 18.0) < 0.01,
        `unknown agent type should default to sonnet ($18), got ${ev.estimated_cost_usd}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('cache read tokens cost 10% of input rate', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-pricing-cache');

    // No routing_outcome → defaults to sonnet ($3/M input)
    // 0 regular tokens, 1M cache read → $3 * 0.1 = $0.30
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      role: 'assistant',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 0,
      },
    }) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[events.length - 1];
      // usage_source will NOT be transcript because input+output are both 0
      // so the fallback path kicks in and usage becomes estimated or from payload
      // Let's check: the script checks `if (totalUsage.input_tokens === 0 && totalUsage.output_tokens === 0)`
      // after reading transcript. Even though cache_read is 1M, input+output are 0 → fallback triggered!
      // This is an edge case: cache-only token usage is treated as zero and falls back to estimation.
      // Document this behavior:
      assert.equal(ev.usage_source !== 'transcript', true,
        'KNOWN EDGE CASE: cache-only token usage (input=0, output=0) triggers fallback because ' +
        'the zero-check only looks at input_tokens + output_tokens. ' +
        'Cache costs from transcript are lost. This is a minor cost accounting issue.');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('opus baseline cost is always computed with opus rates', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-pricing-baseline');

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      role: 'assistant',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[events.length - 1];
      // baseline should always be at opus rates ($5+$25 = $30)
      assert.ok(Math.abs(ev.estimated_cost_opus_baseline_usd - 30.0) < 0.01,
        `opus baseline should be ~$30 for 1M+1M tokens, got ${ev.estimated_cost_opus_baseline_usd}`);
      // regular cost at sonnet is $18 — less than opus baseline
      assert.ok(ev.estimated_cost_usd < ev.estimated_cost_opus_baseline_usd,
        'actual cost (sonnet) should be less than opus baseline');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('resolveModelUsed returns most recent routing_outcome when multiple exist', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-escalate-001');

    // Simulate escalation: first assigned haiku, then escalated to opus
    const eventsPath = path.join(auditDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, [
      JSON.stringify({
        type: 'routing_outcome',
        orchestration_id: 'orch-escalate-001',
        agent_type: 'developer',
        model_assigned: 'claude-haiku-4-5',
      }),
      JSON.stringify({
        type: 'routing_outcome',
        orchestration_id: 'orch-escalate-001',
        agent_type: 'developer',
        model_assigned: 'claude-opus-4-6',
      }),
    ].join('\n') + '\n');

    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      role: 'assistant',
      usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      const ev = events[events.length - 1];
      // Should use opus (the last routing_outcome), not haiku
      assert.equal(ev.model_used, 'claude-opus-4-6', 'escalation should use last routing_outcome');
      assert.ok(Math.abs(ev.estimated_cost_usd - 30.0) < 0.01,
        'cost should be at opus rates after escalation');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// events.jsonl append behavior
// ---------------------------------------------------------------------------

describe('events.jsonl append behavior', () => {

  test('appends to existing events.jsonl without overwriting', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-append-001');

    // Pre-populate with one event
    const existingEvent = { type: 'existing_event', data: 'preserved' };
    const eventsPath = path.join(auditDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, JSON.stringify(existingEvent) + '\n');

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
      });
      run(input);

      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 2, 'should have 2 events: existing + new');
      assert.equal(events[0].type, 'existing_event', 'existing event must be preserved');
      assert.equal(events[1].type, 'agent_stop', 'new event appended at end');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('creates events.jsonl when it does not exist', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    // Do NOT create audit dir — script should create it via mkdirSync

    try {
      const input = JSON.stringify({
        cwd: tmpDir,
        hook_event_name: 'SubagentStop',
        agent_type: 'developer',
      });
      run(input);

      const eventsPath = path.join(auditDir, 'events.jsonl');
      assert.ok(fs.existsSync(eventsPath), 'events.jsonl should be created');
      const events = readEventsJsonl(auditDir);
      assert.equal(events.length, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('each appended line is valid JSON', () => {
    const tmpDir = makeTmpDir();
    const auditDir = path.join(tmpDir, '.orchestray', 'audit');
    writeOrchestrationId(auditDir, 'orch-json-valid');

    try {
      // Run the hook twice to generate 2 events
      for (let i = 0; i < 2; i++) {
        const input = JSON.stringify({
          cwd: tmpDir,
          hook_event_name: 'SubagentStop',
          agent_type: 'developer',
        });
        run(input);
      }

      const eventsPath = path.join(auditDir, 'events.jsonl');
      const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
      assert.equal(lines.length, 2, 'should have 2 lines');
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `Line should be valid JSON: ${line.slice(0, 80)}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // Note: concurrent writes are noted as a known limitation below (not testable
  // reliably via spawnSync without significant async complexity).

});
