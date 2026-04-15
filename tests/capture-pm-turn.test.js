#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/capture-pm-turn.js  (T3 — v2.0.17)
 *
 * Contracts under test:
 *  - given a transcript with assistant usage block, appends pm_turn row
 *  - both transcript envelope shapes work
 *  - fail-open on missing transcript_path
 *  - fail-open on no assistant-with-usage found
 *  - ORCHESTRAY_METRICS_DISABLED=1 suppresses write
 *  - --self-test flag exits 0
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/capture-pm-turn.js');

function run(stdinData, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function runArgs(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: '',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-capture-pm-'));
}

function writeTranscript(tmpDir, lines, filename = 'transcript.jsonl') {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function readMetricsRows(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function writeOrchestrationId(tmpDir, id) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: id })
  );
}

// ---------------------------------------------------------------------------
// --self-test flag
// ---------------------------------------------------------------------------

describe('--self-test flag', () => {

  test('--self-test exits 0', () => {
    const { status } = runArgs(['--self-test']);
    assert.equal(status, 0, '--self-test must exit 0');
  });

});

// ---------------------------------------------------------------------------
// pm_turn row written from transcript (shape 1: {role:"assistant", usage})
// ---------------------------------------------------------------------------

describe('pm_turn row — shape 1: {role, usage}', () => {

  test('appends pm_turn row when transcript has role:assistant with usage', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'hi there',
        model: 'claude-sonnet-4-6',
        timestamp: '2026-01-01T00:00:00.000Z',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        },
      },
    ]);

    try {
      const { status, stdout } = run(JSON.stringify({
        cwd: tmpDir,
        transcript_path: transcriptPath,
        session_id: 'sess-pm-001',
      }));
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);

      const rows = readMetricsRows(tmpDir);
      assert.ok(rows.length >= 1, 'at least one metrics row expected');
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row must be written');
      assert.equal(pmRow.usage.input_tokens, 1000);
      assert.equal(pmRow.usage.output_tokens, 200);
      assert.equal(pmRow.usage.cache_read_input_tokens, 800);
      assert.equal(pmRow.usage.cache_creation_input_tokens, 0);
      assert.equal(pmRow.model_used, 'claude-sonnet-4-6');
      assert.equal(pmRow.timestamp, '2026-01-01T00:00:00.000Z');
      assert.equal(pmRow.session_id, 'sess-pm-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('picks the LAST assistant entry when transcript has multiple assistant turns', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', content: 'first', model: 'claude-haiku', timestamp: '2026-01-01T00:01:00.000Z', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'last', model: 'claude-sonnet-4-6', timestamp: '2026-01-01T00:02:00.000Z', usage: { input_tokens: 300, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      run(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row must be written');
      // Should be the LAST assistant entry
      assert.equal(pmRow.usage.input_tokens, 300, 'must capture usage from last assistant entry');
      assert.equal(pmRow.model_used, 'claude-sonnet-4-6');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('includes orchestration_id from current-orchestration.json when present', () => {
    const tmpDir = makeTmpDir();
    writeOrchestrationId(tmpDir, 'orch-pm-001');
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      run(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row required');
      assert.equal(pmRow.orchestration_id, 'orch-pm-001');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('orchestration_id is null when current-orchestration.json is missing', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      run(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row required');
      assert.equal(pmRow.orchestration_id, null, 'orchestration_id should be null without orchestration file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// pm_turn row — shape 2: {type:"assistant", message:{usage}}
// ---------------------------------------------------------------------------

describe('pm_turn row — shape 2: {type, message:{usage}}', () => {

  test('appends pm_turn row when transcript has type:assistant with message.usage', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { type: 'user', content: 'hello' },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-6',
          timestamp: '2026-02-01T12:00:00.000Z',
          usage: {
            input_tokens: 2000,
            output_tokens: 600,
            cache_read_input_tokens: 1200,
            cache_creation_input_tokens: 100,
          },
        },
      },
    ]);

    try {
      run(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row must be written for shape-2 transcript');
      assert.equal(pmRow.usage.input_tokens, 2000);
      assert.equal(pmRow.usage.output_tokens, 600);
      assert.equal(pmRow.usage.cache_read_input_tokens, 1200);
      assert.equal(pmRow.usage.cache_creation_input_tokens, 100);
      assert.equal(pmRow.model_used, 'claude-opus-4-6');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('handles mixed shape-1 and shape-2 entries, capturing last assistant usage', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: { input_tokens: 999, output_tokens: 333, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      },
    ]);

    try {
      run(JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }));

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(pmRow, 'pm_turn row required');
      assert.equal(pmRow.usage.input_tokens, 999, 'last entry (shape-2) should win');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Fail-open cases
// ---------------------------------------------------------------------------

describe('fail-open contract', () => {

  test('exits 0 with continue:true when transcript_path is absent from event', () => {
    const tmpDir = makeTmpDir();

    try {
      // No transcript_path in the event
      const { status, stdout } = run(JSON.stringify({ cwd: tmpDir }));
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);

      // No metrics file should be created
      const metricsPath = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
      assert.ok(!fs.existsSync(metricsPath), 'no metrics file when transcript_path missing');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exits 0 with continue:true when transcript has no assistant-with-usage entry', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'user', content: 'ping' },
      { role: 'user', content: 'pong' },
    ]);

    try {
      const { status, stdout } = run(JSON.stringify({
        cwd: tmpDir,
        transcript_path: transcriptPath,
      }));
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);

      const rows = readMetricsRows(tmpDir);
      const pmRow = rows.find(r => r.row_type === 'pm_turn');
      assert.ok(!pmRow, 'no pm_turn row should be written when no assistant+usage found');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exits 0 when transcript_path points to non-existent file', () => {
    const tmpDir = makeTmpDir();

    try {
      const { status, stdout } = run(JSON.stringify({
        cwd: tmpDir,
        transcript_path: path.join(tmpDir, 'does-not-exist.jsonl'),
      }));
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exits 0 when transcript contains entirely malformed JSON lines', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = path.join(tmpDir, 'bad.jsonl');
    fs.writeFileSync(transcriptPath, 'not json\n{broken}\n\n');

    try {
      const { status, stdout } = run(JSON.stringify({
        cwd: tmpDir,
        transcript_path: transcriptPath,
      }));
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exits 0 on empty stdin (no event JSON)', () => {
    const { status, stdout } = run('');
    assert.equal(status, 0);
    assert.equal(parseOutput(stdout).continue, true);
  });

});

// ---------------------------------------------------------------------------
// ORCHESTRAY_METRICS_DISABLED kill-switch
// ---------------------------------------------------------------------------

describe('ORCHESTRAY_METRICS_DISABLED kill-switch', () => {

  test('does not write pm_turn row when ORCHESTRAY_METRICS_DISABLED=1', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      const { status } = run(
        JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }),
        { ORCHESTRAY_METRICS_DISABLED: '1' }
      );
      assert.equal(status, 0);

      const metricsPath = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
      assert.ok(!fs.existsSync(metricsPath), 'agent_metrics.jsonl must not exist when kill-switch is set');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('still exits 0 with continue:true when kill-switch is set', () => {
    const tmpDir = makeTmpDir();
    const transcriptPath = writeTranscript(tmpDir, [
      { role: 'assistant', usage: { input_tokens: 500, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ]);

    try {
      const { status, stdout } = run(
        JSON.stringify({ cwd: tmpDir, transcript_path: transcriptPath }),
        { ORCHESTRAY_METRICS_DISABLED: '1' }
      );
      assert.equal(status, 0);
      assert.equal(parseOutput(stdout).continue, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
