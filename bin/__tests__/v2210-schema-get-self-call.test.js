#!/usr/bin/env node
'use strict';

/**
 * v2210-schema-get-self-call.test.js — M4, v2.2.10.
 *
 * Asserts that audit-event-writer self-calls schema_get (via getChunk) when
 * it encounters an event type not present in the shadow cache, emits a
 * `mcp_tool_call` row tagged source:"audit-writer-cache-miss", and caches
 * the result so subsequent emits of the same type produce no additional call.
 *
 * Test 1: emit event with unknown type → 1 mcp_tool_call:schema_get row appears.
 * Test 2: emit same unknown type twice in same process → only 1 mcp_tool_call row total.
 * Test 3: ORCHESTRAY_SCHEMA_GET_SELF_CALL_DISABLED=1 → 0 mcp_tool_call rows.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const { spawnSync }      = require('node:child_process');
const path               = require('node:path');
const fs                 = require('node:fs');
const os                 = require('node:os');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const SHADOW_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const GATEWAY     = path.resolve(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');

function makeTmpRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-sg-self-call-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  // Shadow JSON provides the known-type list for the validator.
  if (fs.existsSync(SHADOW_PATH)) {
    fs.copyFileSync(SHADOW_PATH, path.join(pmRefDir, 'event-schemas.shadow.json'));
  }
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  // Build tier2 index so getChunk resolves correctly.
  const { buildIndex } = require(path.join(REPO_ROOT, 'bin', '_lib', 'tier2-index.js'));
  buildIndex({ cwd: tmpDir });
  return tmpDir;
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

/**
 * Run a harness script in a fresh Node process. Returns parsed events.jsonl rows.
 */
function runHarness(tmpDir, harnessBody, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  spawnSync(process.execPath, ['-e', harnessBody], {
    encoding: 'utf8',
    timeout:  15000,
    env,
  });
  return readEvents(tmpDir);
}

describe('v2.2.10 M4 — audit-writer schema_get self-call', () => {

  test('Test 1: unknown event type triggers 1 mcp_tool_call:schema_get row', () => {
    const tmpDir = makeTmpRepo();
    try {
      const harness = `
        const { writeEvent } = require(${JSON.stringify(GATEWAY)});
        writeEvent({
          type: 'totally_unknown_event_type_xyz',
          version: 1,
          timestamp: '2026-04-29T00:00:00.000Z',
          orchestration_id: 'orch-test-m4',
        }, { cwd: ${JSON.stringify(tmpDir)} });
      `;
      const events = runHarness(tmpDir, harness);
      const mcpRows = events.filter(
        (e) => e.type === 'mcp_tool_call' &&
               e.tool === 'schema_get' &&
               e.source === 'audit-writer-cache-miss'
      );
      assert.equal(
        mcpRows.length,
        1,
        'expected exactly 1 mcp_tool_call:schema_get row; got ' + mcpRows.length +
        '\nAll events: ' + JSON.stringify(events.map((e) => e.type))
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 2: second emit of same unknown type produces no additional mcp_tool_call', () => {
    const tmpDir = makeTmpRepo();
    try {
      // Both calls happen in the same process — cache should suppress the 2nd call.
      const harness = `
        const { writeEvent } = require(${JSON.stringify(GATEWAY)});
        const opts = { cwd: ${JSON.stringify(tmpDir)} };
        const payload = {
          type: 'totally_unknown_event_type_xyz',
          version: 1,
          timestamp: '2026-04-29T00:00:00.000Z',
          orchestration_id: 'orch-test-m4',
        };
        writeEvent(Object.assign({}, payload), opts);
        writeEvent(Object.assign({}, payload), opts);
      `;
      const events = runHarness(tmpDir, harness);
      const mcpRows = events.filter(
        (e) => e.type === 'mcp_tool_call' &&
               e.tool === 'schema_get' &&
               e.source === 'audit-writer-cache-miss'
      );
      assert.equal(
        mcpRows.length,
        1,
        'expected exactly 1 mcp_tool_call row for 2 emits of same type (cache); got ' +
        mcpRows.length +
        '\nAll events: ' + JSON.stringify(events.map((e) => e.type))
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 3: ORCHESTRAY_SCHEMA_GET_SELF_CALL_DISABLED=1 suppresses all mcp_tool_call rows', () => {
    const tmpDir = makeTmpRepo();
    try {
      const harness = `
        const { writeEvent } = require(${JSON.stringify(GATEWAY)});
        writeEvent({
          type: 'totally_unknown_event_type_xyz',
          version: 1,
          timestamp: '2026-04-29T00:00:00.000Z',
          orchestration_id: 'orch-test-m4',
        }, { cwd: ${JSON.stringify(tmpDir)} });
      `;
      const events = runHarness(tmpDir, harness, {
        ORCHESTRAY_SCHEMA_GET_SELF_CALL_DISABLED: '1',
      });
      const mcpRows = events.filter(
        (e) => e.type === 'mcp_tool_call' &&
               e.tool === 'schema_get' &&
               e.source === 'audit-writer-cache-miss'
      );
      assert.equal(
        mcpRows.length,
        0,
        'expected 0 mcp_tool_call rows when kill switch is active; got ' + mcpRows.length +
        '\nAll events: ' + JSON.stringify(events.map((e) => e.type))
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
