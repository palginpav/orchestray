#!/usr/bin/env node
'use strict';

/**
 * Tests for R-FPM (v2.1.12) — fields_projected telemetry metric.
 *
 * AC-01 (R-FPM): Each MCP tool call with a non-empty fields parameter emits a
 *   fields_projected event to events.jsonl.
 * AC-02 (R-FPM): Post-orchestration rollup contains a MCP field projection summary line.
 * AC-03 (R-FPM): One integration test exercises the counter increment on a simulated
 *   tool call.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const CHECKPOINT_SCRIPT = path.resolve(__dirname, '../bin/record-mcp-checkpoint.js');
const ROLLUP_SCRIPT     = path.resolve(__dirname, '../bin/emit-orchestration-rollup.js');

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDir({ orchId = 'orch-rfpm-test' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rfpm-'));
  cleanup.push(dir);

  const auditDir = path.join(dir, '.orchestray', 'audit');
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  // Active orchestration
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );

  // Minimal routing.jsonl so phase = 'pre-decomposition' (no entries yet)
  return { dir, auditDir, stateDir };
}

function runCheckpoint(dir, toolName, toolInput, toolResponse = null) {
  const payload = JSON.stringify({
    cwd:       dir,
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
  });
  return spawnSync(process.execPath, [CHECKPOINT_SCRIPT], {
    input:    payload,
    encoding: 'utf8',
    timeout:  5000,
  });
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function writeEvents(auditDir, events) {
  const p = path.join(auditDir, 'events.jsonl');
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const lines = events.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(p, existing + lines + '\n');
}

function runRollup(dir, orchId) {
  return spawnSync(process.execPath, [ROLLUP_SCRIPT, orchId, '--cwd', dir], {
    encoding: 'utf8',
    timeout:  10000,
  });
}

function readRollup(dir) {
  const p = path.join(dir, '.orchestray', 'metrics', 'orchestration_rollup.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// AC-01 + AC-03 (R-FPM): fields_projected emitted on simulated tool call
// ---------------------------------------------------------------------------

describe('fields_projected event emission (AC-01, AC-03 R-FPM)', () => {

  test('emits fields_projected event when pattern_find called with non-empty fields (AC-01, AC-03)', () => {
    const orchId = 'orch-rfpm-ac01-1';
    const { dir, auditDir } = makeDir({ orchId });

    const result = runCheckpoint(dir, 'mcp__orchestray__pattern_find', {
      task_summary: 'test task',
      fields: ['slug', 'confidence'],
    }, JSON.stringify({ isError: false, matches: [] }));

    assert.equal(result.status, 0, 'hook must exit 0');

    const events = readEvents(dir);
    const fpEvents = events.filter(e => e.type === 'fields_projected');
    assert.ok(fpEvents.length >= 1, 'must emit at least one fields_projected event');

    const fpEvent = fpEvents[0];
    assert.equal(fpEvent.type, 'fields_projected');
    assert.equal(fpEvent.tool_name, 'pattern_find');
    assert.equal(fpEvent.field_count, 2, 'field_count must equal length of fields array');
    assert.equal(fpEvent.orchestration_id, orchId);
    assert.equal(fpEvent.source, 'hook');
    assert.ok(typeof fpEvent.timestamp === 'string', 'timestamp must be present');
  });

  test('emits fields_projected with comma-separated string fields', () => {
    const orchId = 'orch-rfpm-ac01-2';
    const { dir } = makeDir({ orchId });

    const result = runCheckpoint(dir, 'mcp__orchestray__kb_search', {
      query: 'test query',
      fields: 'slug,confidence,excerpt',
    }, JSON.stringify({ isError: false, matches: [] }));

    assert.equal(result.status, 0);

    const events = readEvents(dir);
    const fpEvents = events.filter(e => e.type === 'fields_projected');
    assert.ok(fpEvents.length >= 1, 'must emit fields_projected event');
    assert.equal(fpEvents[0].field_count, 3, 'comma-sep: field_count must be 3');
    assert.equal(fpEvents[0].tool_name, 'kb_search');
  });

  test('does NOT emit fields_projected when fields parameter is absent (AC-01 zero-length gate)', () => {
    const orchId = 'orch-rfpm-ac01-3';
    const { dir } = makeDir({ orchId });

    const result = runCheckpoint(dir, 'mcp__orchestray__pattern_find', {
      task_summary: 'no fields here',
      // No fields parameter
    }, JSON.stringify({ isError: false, matches: [] }));

    assert.equal(result.status, 0);

    const events = readEvents(dir);
    const fpEvents = events.filter(e => e.type === 'fields_projected');
    assert.equal(fpEvents.length, 0, 'must NOT emit fields_projected when fields absent');
  });

  test('does NOT emit fields_projected when fields is an empty array', () => {
    const orchId = 'orch-rfpm-ac01-4';
    const { dir } = makeDir({ orchId });

    const result = runCheckpoint(dir, 'mcp__orchestray__kb_search', {
      query: 'empty fields',
      fields: [],
    }, JSON.stringify({ isError: false, matches: [] }));

    assert.equal(result.status, 0);

    const events = readEvents(dir);
    const fpEvents = events.filter(e => e.type === 'fields_projected');
    assert.equal(fpEvents.length, 0, 'must NOT emit fields_projected when fields is empty array');
  });

  test('does NOT emit fields_projected when fields is an empty string', () => {
    const orchId = 'orch-rfpm-ac01-5';
    const { dir } = makeDir({ orchId });

    const result = runCheckpoint(dir, 'mcp__orchestray__pattern_find', {
      task_summary: 'empty string fields',
      fields: '',
    }, JSON.stringify({ isError: false, matches: [] }));

    assert.equal(result.status, 0);

    const events = readEvents(dir);
    const fpEvents = events.filter(e => e.type === 'fields_projected');
    assert.equal(fpEvents.length, 0, 'must NOT emit fields_projected when fields is empty string');
  });

  test('hook exits 0 even when orchestration file is missing (fail-open)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rfpm-noorch-'));
    cleanup.push(dir);
    // No audit dir, no orchestration file.

    const result = runCheckpoint(dir, 'mcp__orchestray__pattern_find', {
      task_summary: 'test',
      fields: ['slug'],
    }, JSON.stringify({ isError: false, matches: [] }));

    assert.equal(result.status, 0, 'hook must exit 0 even when orchestration file missing');
  });
});

// ---------------------------------------------------------------------------
// AC-02 (R-FPM): rollup summarises fields_projected by tool
// ---------------------------------------------------------------------------

describe('emit-orchestration-rollup.js fields_projected summary (AC-02 R-FPM)', () => {

  test('rollup row includes fields_projected_summary when events present', () => {
    const orchId = 'orch-rfpm-ac02-1';
    const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rfpm-rollup-'));
    cleanup.push(dir);

    const auditDir   = path.join(dir, '.orchestray', 'audit');
    const metricsDir = path.join(dir, '.orchestray', 'metrics');
    const stateDir   = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir,   { recursive: true });
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.mkdirSync(stateDir,   { recursive: true });

    // Write fields_projected events for two tools
    const events = [
      {
        type: 'fields_projected',
        orchestration_id: orchId,
        tool_name: 'pattern_find',
        field_count: 2,
        timestamp: new Date().toISOString(),
        source: 'hook',
      },
      {
        type: 'fields_projected',
        orchestration_id: orchId,
        tool_name: 'pattern_find',
        field_count: 3,
        timestamp: new Date().toISOString(),
        source: 'hook',
      },
      {
        type: 'fields_projected',
        orchestration_id: orchId,
        tool_name: 'kb_search',
        field_count: 2,
        timestamp: new Date().toISOString(),
        source: 'hook',
      },
      {
        type: 'orchestration_complete',
        orchestration_id: orchId,
        timestamp: new Date().toISOString(),
        status: 'success',
      },
    ];
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      events.map(e => JSON.stringify(e)).join('\n') + '\n'
    );

    const result = runRollup(dir, orchId);
    assert.equal(result.status, 0, 'rollup must exit 0');

    const rows = readRollup(dir);
    assert.ok(rows.length > 0, 'rollup must write at least one row');

    const row = rows.find(r => r.orchestration_id === orchId);
    assert.ok(row, 'rollup row for orchestration must exist');

    // AC-02: summary line must be present.
    assert.ok(
      typeof row.fields_projected_summary === 'string',
      'fields_projected_summary must be a string'
    );

    // Must contain total count (3 observations) and 2 tools.
    assert.ok(
      row.fields_projected_summary.includes('3 times'),
      'summary must show total 3'
    );
    assert.ok(
      row.fields_projected_summary.includes('2 tools'),
      'summary must show 2 tools'
    );
    assert.ok(
      row.fields_projected_summary.includes('pattern_find: 2'),
      'summary must show pattern_find: 2'
    );
    assert.ok(
      row.fields_projected_summary.includes('kb_search: 1'),
      'summary must show kb_search: 1'
    );
    // Format prefix check.
    assert.ok(
      row.fields_projected_summary.startsWith('- MCP field projection used '),
      'summary must start with "- MCP field projection used "'
    );
  });

  test('rollup row omits fields_projected_summary when no projection events', () => {
    const orchId = 'orch-rfpm-ac02-2';
    const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rfpm-rollup2-'));
    cleanup.push(dir);

    const auditDir   = path.join(dir, '.orchestray', 'audit');
    const metricsDir = path.join(dir, '.orchestray', 'metrics');
    const stateDir   = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(auditDir,   { recursive: true });
    fs.mkdirSync(metricsDir, { recursive: true });
    fs.mkdirSync(stateDir,   { recursive: true });

    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      JSON.stringify({
        type: 'orchestration_complete',
        orchestration_id: orchId,
        timestamp: new Date().toISOString(),
        status: 'success',
      }) + '\n'
    );

    const result = runRollup(dir, orchId);
    assert.equal(result.status, 0);

    const rows = readRollup(dir);
    const row  = rows.find(r => r.orchestration_id === orchId);
    assert.ok(row, 'rollup row must be present');

    assert.equal(
      row.fields_projected_summary,
      undefined,
      'fields_projected_summary must be absent when no projection events'
    );
  });
});
