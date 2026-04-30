#!/usr/bin/env node
'use strict';

/**
 * Tests for P1-13 (v2.2.15 W2-07): autofill telemetry on schema-unreadable branch.
 *
 * Covers:
 *   - When schema is readable: emitAutofillTelemetry emits WITHOUT schema_state field.
 *   - When schema is unreadable: emitAutofillTelemetry emits WITH schema_state:'unreadable'.
 *
 * Runner: node --test bin/_lib/__tests__/autofill-schema-unreadable.test.js
 *
 * Isolation contract:
 *   - Tests call emitAutofillTelemetry directly, with an isolated tmp eventsPath.
 *   - No real events.jsonl or project root is modified.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const auditEventWriter = require('../audit-event-writer.js');
const { emitAutofillTelemetry } = auditEventWriter._testHooks;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpEventsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-autofill-test-'));
  return { dir, eventsPath: path.join(dir, 'events.jsonl') };
}

function readEvents(eventsPath) {
  try {
    return fs.readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// P1-13: emitAutofillTelemetry — schema_state field
// ---------------------------------------------------------------------------

describe('emitAutofillTelemetry — schema_state absent on readable-schema path', () => {
  test('does not include schema_state when called without 5th argument', () => {
    const { dir, eventsPath } = makeTmpEventsPath();
    try {
      // Call without schemaState (readable-schema path).
      emitAutofillTelemetry(
        'agent_start',
        ['timestamp', 'orchestration_id'],
        dir,
        eventsPath
        // no 5th arg
      );

      const events = readEvents(eventsPath);
      // Should have emitted the autofilled telemetry row.
      const row = events.find(e => e.type === 'audit_event_autofilled');
      assert.ok(row, 'audit_event_autofilled must be emitted');
      assert.equal(row.event_type, 'agent_start');
      assert.deepEqual(row.fields_autofilled, ['timestamp', 'orchestration_id']);
      // schema_state must NOT be present on the readable path.
      assert.equal('schema_state' in row, false, 'schema_state must be absent on readable path');
    } finally {
      cleanup(dir);
    }
  });
});

describe('emitAutofillTelemetry — schema_state:unreadable on unreadable-schema path', () => {
  test('includes schema_state:"unreadable" when 5th arg is "unreadable"', () => {
    const { dir, eventsPath } = makeTmpEventsPath();
    try {
      emitAutofillTelemetry(
        'agent_stop',
        ['timestamp'],
        dir,
        eventsPath,
        'unreadable'  // schema_state
      );

      const events = readEvents(eventsPath);
      const row = events.find(e => e.type === 'audit_event_autofilled');
      assert.ok(row, 'audit_event_autofilled must be emitted on unreadable path');
      assert.equal(row.event_type,   'agent_stop');
      assert.equal(row.schema_state, 'unreadable', 'schema_state must be "unreadable"');
    } finally {
      cleanup(dir);
    }
  });

  test('emits nothing when fields array is empty (regardless of schema_state)', () => {
    const { dir, eventsPath } = makeTmpEventsPath();
    try {
      emitAutofillTelemetry('agent_stop', [], dir, eventsPath, 'unreadable');
      const events = readEvents(eventsPath);
      assert.equal(events.length, 0, 'no event when fields is empty');
    } finally {
      cleanup(dir);
    }
  });
});
