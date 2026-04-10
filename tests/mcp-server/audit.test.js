#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/lib/audit.js
 *
 * Per v2011c-stage1-plan.md §3.3, §10, §11.
 *
 * Contract under test:
 *   buildAuditEvent({ tool, outcome, duration_ms, form_fields_count }) -> object
 *     Returns the mcp_tool_call event shape from §10.
 *     outcome ∈ "answered" | "cancelled" | "declined" | "timeout" | "error"
 *
 *   readOrchestrationId() -> string
 *     Reads .orchestray/audit/current-orchestration.json at the resolved
 *     project root. Returns orchestration_id field or "unknown". Never throws.
 *
 * NOTE for developer: readOrchestrationId tests rely on the function
 * resolving the project root from process.cwd() (per plan §3.1
 * getProjectRoot walks up from process.cwd() looking for .orchestray/).
 * Tests set process.cwd to a tmpdir that contains a .orchestray/ fixture.
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  buildAuditEvent,
  readOrchestrationId,
} = require('../../bin/mcp-server/lib/audit.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-mcp-audit-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

// ---------------------------------------------------------------------------
// buildAuditEvent
// ---------------------------------------------------------------------------

describe('buildAuditEvent', () => {

  test('returns the full §10 shape for outcome=answered', () => {
    const event = buildAuditEvent({
      tool: 'mcp__orchestray__ask_user',
      outcome: 'answered',
      duration_ms: 42310,
      form_fields_count: 2,
    });

    // Exact property-for-property match against the §10 spec (minus timestamp/orch id).
    assert.equal(event.type, 'mcp_tool_call');
    assert.equal(event.tool, 'mcp__orchestray__ask_user');
    assert.equal(event.outcome, 'answered');
    assert.equal(event.duration_ms, 42310);
    assert.equal(event.form_fields_count, 2);
    assert.ok(typeof event.timestamp === 'string' && event.timestamp.length > 0,
      'timestamp must be a non-empty string');
    assert.ok(typeof event.orchestration_id === 'string',
      'orchestration_id must be a string (even if "unknown")');
  });

  test('returns the full §10 shape for outcome=timeout', () => {
    const event = buildAuditEvent({
      tool: 'mcp__orchestray__ask_user',
      outcome: 'timeout',
      duration_ms: 120000,
      form_fields_count: 1,
    });
    assert.equal(event.type, 'mcp_tool_call');
    assert.equal(event.outcome, 'timeout');
    assert.equal(event.duration_ms, 120000);
    assert.equal(event.form_fields_count, 1);
  });

  test('preserves every legal outcome value verbatim', () => {
    const outcomes = ['answered', 'cancelled', 'declined', 'timeout', 'error'];
    for (const outcome of outcomes) {
      const ev = buildAuditEvent({
        tool: 'mcp__orchestray__ask_user',
        outcome,
        duration_ms: 100,
        form_fields_count: 1,
      });
      assert.equal(ev.outcome, outcome, `outcome "${outcome}" must be preserved`);
    }
  });

  test('produces a valid ISO-8601 timestamp with millisecond precision', () => {
    const event = buildAuditEvent({
      tool: 'mcp__orchestray__ask_user',
      outcome: 'answered',
      duration_ms: 10,
      form_fields_count: 1,
    });
    // ISO 8601 with ms, ending in Z. e.g. "2026-04-10T20:24:16.123Z"
    const iso8601ms = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    assert.match(event.timestamp, iso8601ms);
    // Round-trips through Date.
    const parsed = new Date(event.timestamp);
    assert.ok(!Number.isNaN(parsed.getTime()), 'timestamp must parse as a valid Date');
  });

});

// ---------------------------------------------------------------------------
// readOrchestrationId
// ---------------------------------------------------------------------------

describe('readOrchestrationId', () => {

  test('reads orchestration_id from a valid current-orchestration.json', () => {
    const tmp = makeTmpProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json'),
        JSON.stringify({ orchestration_id: 'orch-abc-123' })
      );
      const id = withCwd(tmp, () => readOrchestrationId());
      assert.equal(id, 'orch-abc-123');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns "unknown" when current-orchestration.json is missing', () => {
    const tmp = makeTmpProject();
    try {
      // No file written.
      const id = withCwd(tmp, () => readOrchestrationId());
      assert.equal(id, 'unknown');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns "unknown" when current-orchestration.json is malformed JSON', () => {
    const tmp = makeTmpProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json'),
        '{not valid json'
      );
      const id = withCwd(tmp, () => readOrchestrationId());
      assert.equal(id, 'unknown');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns "unknown" when orchestration_id field is absent', () => {
    const tmp = makeTmpProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json'),
        JSON.stringify({ some_other_field: 'value' })
      );
      const id = withCwd(tmp, () => readOrchestrationId());
      assert.equal(id, 'unknown');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
