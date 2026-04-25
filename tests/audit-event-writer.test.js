#!/usr/bin/env node
'use strict';

/**
 * audit-event-writer.test.js — R-SHDW-EMIT gateway tests (v2.1.15).
 *
 * Tests the central `writeEvent` audit-event gateway in
 * `bin/_lib/audit-event-writer.js`. Implements the 5 W2-specified TDD cases
 * for R-SHDW-EMIT plus one PreToolUse hook integration test.
 *
 * Test plan (W2 design § "Test plan (TDD seed for W3)"):
 *   1. Happy-path emit with a known event type.
 *   2. Schema violation — drop original + emit surrogate `schema_shadow_validation_block`.
 *   3. Unknown event type (shadow miss == schema miss) — same drop + surrogate.
 *   4. Three-strike circuit broken — bypass validation, append as-is, stderr warning.
 *   5. PreToolUse hook blocks direct Edit on events.jsonl (path-based defence).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT     = path.resolve(__dirname, '..');
const SCHEMA_PATH   = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const VALIDATE_HOOK = path.resolve(REPO_ROOT, 'bin', 'validate-schema-emit.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-emit-gateway-test-'));
}

function setupTmpRepo(tmpDir) {
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
}

function readEventsJsonl(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Run a one-line node harness that loads writeEvent from the gateway and
 * invokes it with the given payload+opts. Returns { stdout, stderr, status,
 * result }, where `result` is the parsed JSON return value of writeEvent
 * (printed by the harness on stdout).
 */
function callWriteEvent(eventPayload, opts) {
  const gatewayPath = path.resolve(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');
  const harness = `
    const { writeEvent } = require(${JSON.stringify(gatewayPath)});
    const result = writeEvent(${JSON.stringify(eventPayload)}, ${JSON.stringify(opts || {})});
    process.stdout.write(JSON.stringify(result));
  `;
  const r = spawnSync(process.execPath, ['-e', harness], {
    encoding: 'utf8',
    timeout: 5000,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch (_e) { /* ignore */ }
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
    result: parsed,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('audit-event-writer (R-SHDW-EMIT gateway)', () => {

  test('Test 1 — happy-path emit with a known event type', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);

      const event = { type: 'schema_shadow_hit', version: 1, event_type: 'tier2_load' };
      const { result } = callWriteEvent(event, { cwd: tmpDir });

      assert.equal(result.written, true, 'written should be true');
      assert.equal(result.reason, 'ok', 'reason should be "ok"');
      assert.equal(result.event_type, 'schema_shadow_hit');
      assert.deepEqual(result.errors, [], 'errors should be empty');

      const lines = readEventsJsonl(tmpDir);
      assert.equal(lines.length, 1, 'exactly one line should be appended');
      assert.equal(lines[0].type, 'schema_shadow_hit');
      assert.ok(lines[0].timestamp, 'timestamp auto-filled');
      assert.equal(lines[0].orchestration_id, 'unknown', 'orchestration_id auto-filled');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 2 — schema violation drops original and emits surrogate', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);

      // tier2_load is in the schema; emit it without required fields.
      const badEvent = { type: 'tier2_load' };
      const { result } = callWriteEvent(badEvent, { cwd: tmpDir });

      assert.equal(result.written, false, 'written should be false');
      assert.equal(result.reason, 'validation_failed', 'reason should be "validation_failed"');
      assert.equal(result.event_type, 'tier2_load');
      assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'errors should be non-empty');

      const lines = readEventsJsonl(tmpDir);
      assert.equal(lines.length, 1, 'exactly one line should be present (the surrogate)');
      assert.equal(lines[0].type, 'schema_shadow_validation_block', 'line is the surrogate event');
      assert.equal(lines[0].blocked_event_type, 'tier2_load');
      assert.ok(Array.isArray(lines[0].errors) && lines[0].errors.length > 0);
      // Confirm the original tier2_load was NOT written
      const tier2Lines = lines.filter((e) => e.type === 'tier2_load');
      assert.equal(tier2Lines.length, 0, 'no original tier2_load line written');

      // recordMiss should have logged an entry
      const missesPath = path.join(tmpDir, '.orchestray', 'state', 'schema-shadow-misses.jsonl');
      assert.ok(fs.existsSync(missesPath), 'misses log exists');
      const missLines = fs.readFileSync(missesPath, 'utf8').split('\n').filter(Boolean);
      assert.equal(missLines.length, 1, 'exactly one miss entry');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 3 — unknown event type emits with schema_unknown_type_warn advisory', () => {
    // v2.1.15 contract: unknown event types are EMITTED AS-IS plus a separate
    // `schema_unknown_type_warn` advisory event. This preserves observability
    // for legacy event types not yet schemaed (e.g. prefix_drift,
    // kill_switch_event) while making the schema gap visible. Missing-required-
    // field violations still take the strict drop+surrogate path (Test 2).
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);

      const unknown = { type: 'totally_made_up_event' };
      const { result } = callWriteEvent(unknown, { cwd: tmpDir });

      assert.equal(result.written, true);
      assert.equal(result.reason, 'unknown_type_emitted');
      assert.ok(
        result.errors.some((e) => /unknown event type/i.test(e)),
        'errors mention "unknown event type"'
      );

      const lines = readEventsJsonl(tmpDir);
      assert.equal(lines.length, 2, 'two lines: original event + advisory');
      assert.equal(
        lines.filter((e) => e.type === 'totally_made_up_event').length,
        1,
        'original event written exactly once'
      );
      const advisory = lines.find((e) => e.type === 'schema_unknown_type_warn');
      assert.ok(advisory, 'schema_unknown_type_warn advisory present');
      assert.equal(advisory.unknown_event_type, 'totally_made_up_event');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 4 — three-strike circuit broken bypasses validation', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      // Pre-create the sentinel
      fs.writeFileSync(
        path.join(tmpDir, '.orchestray', 'state', '.schema-shadow-disabled'),
        'manual\n'
      );

      const invalid = { type: 'totally_made_up_event' };
      const { result, stderr } = callWriteEvent(invalid, { cwd: tmpDir });

      assert.equal(result.written, true, 'event appended despite invalid type');
      assert.equal(result.reason, 'circuit_broken_bypass');
      assert.equal(result.event_type, 'totally_made_up_event');
      assert.deepEqual(result.errors, []);

      const lines = readEventsJsonl(tmpDir);
      assert.equal(lines.length, 1, 'one line written');
      assert.equal(lines[0].type, 'totally_made_up_event', 'original event written, NOT surrogate');

      // Stderr warning emitted exactly once per process
      assert.ok(
        /circuit broken/i.test(stderr),
        'stderr contains circuit-broken warning. Got: ' + stderr
      );

      // recordMiss NOT called when circuit already broken
      const missesPath = path.join(tmpDir, '.orchestray', 'state', 'schema-shadow-misses.jsonl');
      assert.equal(
        fs.existsSync(missesPath),
        false,
        'recordMiss not called when circuit already broken'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Test 5 — PreToolUse hook blocks direct Edit on events.jsonl', () => {
    const tmpDir = makeTmpDir();
    try {
      setupTmpRepo(tmpDir);
      const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
      fs.writeFileSync(eventsPath, '');

      const payload = JSON.stringify({
        cwd: tmpDir,
        tool_input: {
          file_path: eventsPath,
          old_string: 'foo',
          new_string: 'bar',
        },
      });
      const r = spawnSync(process.execPath, [VALIDATE_HOOK], {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
      });
      assert.equal(r.status, 2, 'exit code 2 (block)');
      const out = JSON.parse(r.stdout);
      assert.equal(
        out.hookSpecificOutput.permissionDecision,
        'block',
        'permissionDecision is "block"'
      );
      assert.ok(
        /writeEvent gateway/i.test(out.hookSpecificOutput.permissionDecisionReason || ''),
        'block reason mentions writeEvent gateway'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
