#!/usr/bin/env node
'use strict';

/**
 * p11-m03-pm-turn-flow.test.js — P1.1 M0.3 pm_turn row flow + diagnose mode.
 *
 * Verifies bin/capture-pm-turn.js:
 *   1. Happy path — Stop event with usage-bearing transcript → pm_turn row.
 *   2. Backward walk — last assistant lacks usage; earlier entry wins.
 *   3. no_transcript outcome when payload omits transcript_path.
 *   4. --self-test exits 0 (regression).
 *   5. --diagnose dumps an outcome histogram + verdict.
 *   6. schema_version=2 with nullable routing_class / inline_or_scout fields.
 *
 * Runner: node --test bin/__tests__/p11-m03-pm-turn-flow.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'capture-pm-turn.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-p11-m03-'));
  // Ensure metrics dir parent exists for hook side-effects (context-telemetry).
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'metrics'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a transcript file with given JSONL entries. */
function writeTranscript(entries) {
  const p = path.join(tmpDir, 'transcript.jsonl');
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

/** Spawn the hook with stdin pipe. */
function runHook(payload, args) {
  const r = spawnSync('node', [SCRIPT, ...(args || [])], {
    input: JSON.stringify(payload),
    env: process.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  return r;
}

/** Read agent_metrics.jsonl rows. */
function readMetrics() {
  const p = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Read stop-hook.jsonl rows. */
function readAudit() {
  const p = path.join(tmpDir, '.orchestray', 'state', 'stop-hook.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// --- Tests ------------------------------------------------------------------

test('happy path — Stop event with usage-bearing transcript writes pm_turn row', () => {
  const transcriptPath = writeTranscript([
    { role: 'user', content: 'ping' },
    {
      role: 'assistant',
      content: 'pong',
      model: 'claude-opus-4-7',
      timestamp: '2026-04-26T17:00:00.000Z',
      usage: { input_tokens: 12345, output_tokens: 6789, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    },
  ]);

  const payload = { transcript_path: transcriptPath, session_id: 's1', cwd: tmpDir };
  const r = runHook(payload);
  assert.equal(r.status, 0, 'hook exits 0; stderr=' + (r.stderr || ''));

  const rows = readMetrics();
  assert.equal(rows.length, 1, 'exactly one pm_turn row');
  const row = rows[0];
  assert.equal(row.row_type, 'pm_turn');
  assert.equal(row.schema_version, 2);
  assert.equal(row.usage.input_tokens, 12345);
  assert.equal(row.usage.output_tokens, 6789);
  assert.equal(row.routing_class, null);
  assert.equal(row.inline_or_scout, null);

  const audit = readAudit();
  assert.ok(audit.length >= 1);
  assert.equal(audit[audit.length - 1].outcome, 'success');
});

test('backward walk — last assistant entry lacks usage but earlier one has it', () => {
  const transcriptPath = writeTranscript([
    { role: 'user', content: 'ping' },
    {
      role: 'assistant',
      content: 'first',
      model: 'claude-sonnet-4-6',
      timestamp: '2026-04-26T17:00:00.000Z',
      usage: { input_tokens: 999, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    // last assistant entry has NO usage block — should be skipped
    { role: 'assistant', content: 'second-no-usage', model: 'claude-sonnet-4-6' },
  ]);

  const payload = { transcript_path: transcriptPath, session_id: 's2', cwd: tmpDir };
  const r = runHook(payload);
  assert.equal(r.status, 0);

  const rows = readMetrics();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usage.input_tokens, 999, 'fell back to earlier entry with usage');
});

test('no_transcript outcome when payload omits transcript_path', () => {
  const payload = { session_id: 's3', cwd: tmpDir };
  const r = runHook(payload);
  assert.equal(r.status, 0);

  const rows = readMetrics();
  assert.equal(rows.length, 0, 'no pm_turn row written');
  const audit = readAudit();
  assert.ok(audit.length >= 1);
  assert.equal(audit[audit.length - 1].outcome, 'no_transcript');
});

test('--self-test exits 0', () => {
  const r = spawnSync('node', [SCRIPT, '--self-test'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 0, '--self-test exit; stdout=' + r.stdout + '; stderr=' + r.stderr);
  assert.match(r.stdout, /self-test PASS/);
});

test('--diagnose dumps outcome histogram + verdict', () => {
  // Seed stop-hook.jsonl with 3 success and 2 no_transcript rows.
  const auditPath = path.join(tmpDir, '.orchestray', 'state', 'stop-hook.jsonl');
  const seedRows = [
    { ts: '2026-04-26T17:00:00.000Z', outcome: 'success' },
    { ts: '2026-04-26T17:00:01.000Z', outcome: 'success' },
    { ts: '2026-04-26T17:00:02.000Z', outcome: 'success' },
    { ts: '2026-04-26T17:00:03.000Z', outcome: 'no_transcript' },
    { ts: '2026-04-26T17:00:04.000Z', outcome: 'no_transcript' },
  ];
  fs.writeFileSync(auditPath, seedRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const r = spawnSync('node', [SCRIPT, '--diagnose'], {
    cwd: tmpDir,
    env: process.env,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /total Stop fires: 5/);
  assert.match(r.stdout, /success: 3/);
  assert.match(r.stdout, /no_transcript: 2/);
  assert.match(r.stdout, /VERDICT: 3 successful pm_turn rows/);
});

test('schema_version=2 with nullable new fields (smoke)', () => {
  const transcriptPath = writeTranscript([
    {
      role: 'assistant',
      model: 'claude-haiku-4-5',
      timestamp: '2026-04-26T17:00:00.000Z',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  ]);
  const payload = { transcript_path: transcriptPath, session_id: 's6', cwd: tmpDir };
  const r = runHook(payload);
  assert.equal(r.status, 0);

  const rows = readMetrics();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.schema_version, 2);
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'routing_class'));
  assert.equal(row.routing_class, null);
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'inline_or_scout'));
  assert.equal(row.inline_or_scout, null);
});
