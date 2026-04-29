#!/usr/bin/env node
'use strict';

/**
 * v2211-w0b-kb-write-artifacts.test.js — W0b (v2.2.11).
 *
 * Tests for KB_INTERCEPT_RE extension in bin/redirect-kb-write.js.
 * Verifies that artifacts/ is now intercepted alongside facts/ and decisions/.
 *
 * Coverage:
 *   1. Write to .orchestray/kb/artifacts/foo.md → 1 mcp_tool_call:kb_write + 1 kb_write_redirected; continue:true
 *   2. Write to .orchestray/kb/facts/bar.md → regression check (still works)
 *   3. Write to .orchestray/kb/decisions/baz.md → regression check (still works)
 *   4. Write to .orchestray/state/something.md → 0 emits (out-of-scope path)
 *   5. Write to .orchestray/kb/artifacts/foo.md with ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED=1 → 0 emits
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const HOOK      = path.resolve(__dirname, '..', 'redirect-kb-write.js');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-w0b-kb-artifacts-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-v2211-w0b' }),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), '', 'utf8');

  return dir;
}

function buildWritePayload(filePath, content, cwd) {
  return JSON.stringify({
    cwd: cwd || '',
    tool_name: 'Write',
    tool_input: {
      file_path: filePath,
      content: content || 'test content',
    },
  });
}

function runHook(tmpDir, filePath, extraEnv = {}, content = 'test content') {
  const payload = buildWritePayload(filePath, content, tmpDir);
  const result = spawnSync(process.execPath, [HOOK], {
    input: payload,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ORCHESTRAY_PLUGIN_ROOT: REPO_ROOT,
      // disable schema shadow circuit to avoid miss-counter side effects in tests
      ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1',
      ...extraEnv,
    },
  });

  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  const events = readJsonlFile(eventsPath);

  let stdout = {};
  try {
    stdout = JSON.parse(result.stdout || '{}');
  } catch (_e) {
    stdout = {};
  }

  return {
    stdout,
    stderr: result.stderr || '',
    events,
    exitCode: result.status,
  };
}

function readJsonlFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211-w0b-kb-write-artifacts', () => {

  test('1. Write to artifacts/foo.md → 1 mcp_tool_call:kb_write + 1 kb_write_redirected; continue:true', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'artifacts', 'foo.md');
    const { stdout, events } = runHook(tmpDir, filePath);

    assert.strictEqual(stdout.continue, true, 'continue must be true');

    const toolCalls = events.filter((e) => e.type === 'mcp_tool_call' && e.tool === 'kb_write');
    assert.strictEqual(toolCalls.length, 1,
      `Expected 1 mcp_tool_call:kb_write, got ${toolCalls.length}`);

    const redirected = events.filter((e) => e.type === 'kb_write_redirected');
    assert.strictEqual(redirected.length, 1,
      `Expected 1 kb_write_redirected, got ${redirected.length}`);

    assert.strictEqual(redirected[0].phase, 'transparent-pass-v2210');
    assert.strictEqual(redirected[0].bucket, 'artifacts');
    assert.ok(
      typeof redirected[0].target_path === 'string' && redirected[0].target_path.length > 0,
      'target_path must be a non-empty string'
    );
  });

  test('2. Write to facts/bar.md → regression: still fires (facts still intercepted)', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'facts', 'bar.md');
    const { stdout, events } = runHook(tmpDir, filePath);

    assert.strictEqual(stdout.continue, true, 'continue must be true');

    const toolCalls = events.filter((e) => e.type === 'mcp_tool_call' && e.tool === 'kb_write');
    assert.strictEqual(toolCalls.length, 1,
      `Expected 1 mcp_tool_call:kb_write for facts path, got ${toolCalls.length}`);

    const redirected = events.filter((e) => e.type === 'kb_write_redirected');
    assert.strictEqual(redirected.length, 1,
      `Expected 1 kb_write_redirected for facts path, got ${redirected.length}`);

    assert.strictEqual(redirected[0].bucket, 'facts');
  });

  test('3. Write to decisions/baz.md → regression: still fires (decisions still intercepted)', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'decisions', 'baz.md');
    const { stdout, events } = runHook(tmpDir, filePath);

    assert.strictEqual(stdout.continue, true, 'continue must be true');

    const toolCalls = events.filter((e) => e.type === 'mcp_tool_call' && e.tool === 'kb_write');
    assert.strictEqual(toolCalls.length, 1,
      `Expected 1 mcp_tool_call:kb_write for decisions path, got ${toolCalls.length}`);

    const redirected = events.filter((e) => e.type === 'kb_write_redirected');
    assert.strictEqual(redirected.length, 1,
      `Expected 1 kb_write_redirected for decisions path, got ${redirected.length}`);

    assert.strictEqual(redirected[0].bucket, 'decisions');
  });

  test('4. Write to .orchestray/state/something.md → 0 emits (out-of-scope)', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'state', 'something.md');
    const { stdout, events } = runHook(tmpDir, filePath);

    assert.strictEqual(stdout.continue, true, 'continue must be true for out-of-scope path');

    const toolCalls = events.filter((e) => e.type === 'mcp_tool_call' && e.tool === 'kb_write');
    assert.strictEqual(toolCalls.length, 0,
      `Expected 0 mcp_tool_call:kb_write for state path, got ${toolCalls.length}`);

    const redirected = events.filter((e) => e.type === 'kb_write_redirected');
    assert.strictEqual(redirected.length, 0,
      `Expected 0 kb_write_redirected for state path, got ${redirected.length}`);
  });

  test('5. Write to artifacts/foo.md with ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED=1 → 0 emits', () => {
    const tmpDir = makeTmpDir();
    const filePath = path.join(tmpDir, '.orchestray', 'kb', 'artifacts', 'foo.md');
    const { stdout, events } = runHook(tmpDir, filePath, {
      ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED: '1',
    });

    assert.strictEqual(stdout.continue, true, 'continue must be true with kill switch');

    const toolCalls = events.filter((e) => e.type === 'mcp_tool_call' && e.tool === 'kb_write');
    assert.strictEqual(toolCalls.length, 0,
      `Expected 0 mcp_tool_call:kb_write with kill switch, got ${toolCalls.length}`);

    const redirected = events.filter((e) => e.type === 'kb_write_redirected');
    assert.strictEqual(redirected.length, 0,
      `Expected 0 kb_write_redirected with kill switch, got ${redirected.length}`);
  });

});
