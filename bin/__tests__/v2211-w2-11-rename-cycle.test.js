#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-11-rename-cycle.test.js — W2-11 rename-cycle shadow alias tests.
 *
 * Tests the alias-table mechanism in bin/_lib/audit-event-writer.js:
 *   1. Emit staging_write_failed → 3 events: original + staging_write_attempt + staging_write_result.
 *   2. Emit task_validation_failed → 3 events: original + task_validation_attempt + task_validation_result.
 *   3. Kill switch ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED=1 → only original *_failed fires.
 *   4. Schema validation: 4 new alias types appear in event-schemas.shadow.json.
 *   5. Alias events carry correct original_event_type field.
 *   6. Alias events carry outcome: "failed" on the *_result events.
 *
 * Runner: node --test bin/__tests__/v2211-w2-11-rename-cycle.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const WRITER_LIB   = path.join(REPO_ROOT, 'bin', '_lib', 'audit-event-writer');
const SHADOW_PATH  = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-w211-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  // Write current-orchestration.json so writeEvent can resolve orchestration_id.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8',
  );
  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211 W2-11 — rename-cycle shadow aliases', () => {

  let savedEnv;
  beforeEach(() => {
    savedEnv = process.env.ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED;
    delete process.env.ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED;
    // Disable schema validation to avoid needing a full schema fixture.
    process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW = '1';
  });
  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED;
    } else {
      process.env.ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED = savedEnv;
    }
    delete process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW;
  });

  test('Test 1: staging_write_failed → 3 events (original + attempt + result)', () => {
    const orchId = 'orch-w211-t1-' + Date.now();
    const dir    = makeRepo(orchId);

    const { writeEventWithAliases } = require(WRITER_LIB);

    writeEventWithAliases({
      type:             'staging_write_failed',
      version:          1,
      orchestration_id: orchId,
      op:               'write',
      error_class:      'EACCES',
      error_message:    'permission denied',
      cwd:              dir,
      cache_path:       '/tmp/context-telemetry.json',
    }, { cwd: dir });

    const events = readEvents(dir);
    const types  = events.map(e => e.type);

    assert.ok(types.includes('staging_write_failed'),  'original staging_write_failed must be present');
    assert.ok(types.includes('staging_write_attempt'), 'staging_write_attempt alias must be present');
    assert.ok(types.includes('staging_write_result'),  'staging_write_result alias must be present');
    assert.equal(
      types.filter(t => ['staging_write_failed','staging_write_attempt','staging_write_result'].includes(t)).length,
      3,
      'must emit exactly 3 events for staging_write_failed',
    );
  });

  test('Test 2: task_validation_failed → 3 events (original + attempt + result)', () => {
    const orchId = 'orch-w211-t2-' + Date.now();
    const dir    = makeRepo(orchId);

    const { writeEventWithAliases } = require(WRITER_LIB);

    writeEventWithAliases({
      type:             'task_validation_failed',
      version:          1,
      orchestration_id: orchId,
      hook:             'validate-task-completion',
      reason:           'missing task_id',
      payload_keys:     [],
    }, { cwd: dir });

    const events = readEvents(dir);
    const types  = events.map(e => e.type);

    assert.ok(types.includes('task_validation_failed'),   'original task_validation_failed must be present');
    assert.ok(types.includes('task_validation_attempt'),  'task_validation_attempt alias must be present');
    assert.ok(types.includes('task_validation_result'),   'task_validation_result alias must be present');
    assert.equal(
      types.filter(t => ['task_validation_failed','task_validation_attempt','task_validation_result'].includes(t)).length,
      3,
      'must emit exactly 3 events for task_validation_failed',
    );
  });

  test('Test 3: kill switch ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED=1 → only original fires', () => {
    process.env.ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED = '1';

    const orchId = 'orch-w211-t3-' + Date.now();
    const dir    = makeRepo(orchId);

    const { writeEventWithAliases } = require(WRITER_LIB);

    writeEventWithAliases({
      type:             'staging_write_failed',
      version:          1,
      orchestration_id: orchId,
      op:               'write',
      error_class:      'ENOSPC',
      error_message:    'no space left',
      cwd:              dir,
      cache_path:       '/tmp/ctx.json',
    }, { cwd: dir });

    const events = readEvents(dir);
    const types  = events.map(e => e.type);

    assert.ok(types.includes('staging_write_failed'), 'original must still fire with kill switch');
    assert.ok(!types.includes('staging_write_attempt'), 'staging_write_attempt must NOT fire with kill switch');
    assert.ok(!types.includes('staging_write_result'),  'staging_write_result must NOT fire with kill switch');
  });

  test('Test 4: schema — 4 new alias types in event-schemas.shadow.json', () => {
    const shadow = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));

    const required = [
      'staging_write_attempt',
      'staging_write_result',
      'task_validation_attempt',
      'task_validation_result',
    ];

    for (const t of required) {
      assert.ok(t in shadow, `shadow must contain ${t}`);
      assert.ok(shadow[t] && typeof shadow[t].v === 'number', `${t} must have version field`);
    }

    assert.equal(shadow._meta.event_count, 205, 'shadow event_count must be 205');
  });

  test('Test 5: alias events carry correct original_event_type field', () => {
    const orchId = 'orch-w211-t5-' + Date.now();
    const dir    = makeRepo(orchId);

    const { writeEventWithAliases } = require(WRITER_LIB);

    writeEventWithAliases({
      type:             'task_validation_failed',
      version:          1,
      orchestration_id: orchId,
      hook:             'validate-task-completion',
      reason:           'missing task_subject',
      payload_keys:     ['task_id'],
    }, { cwd: dir });

    const events = readEvents(dir);

    const attempt = events.find(e => e.type === 'task_validation_attempt');
    const result  = events.find(e => e.type === 'task_validation_result');

    assert.ok(attempt, 'task_validation_attempt must be emitted');
    assert.equal(attempt.original_event_type, 'task_validation_failed',
      'attempt must reference the original event type');

    assert.ok(result, 'task_validation_result must be emitted');
    assert.equal(result.original_event_type, 'task_validation_failed',
      'result must reference the original event type');
  });

  test('Test 6: *_result alias events carry outcome: "failed"', () => {
    const orchId = 'orch-w211-t6-' + Date.now();
    const dir    = makeRepo(orchId);

    const { writeEventWithAliases } = require(WRITER_LIB);

    writeEventWithAliases({
      type:             'staging_write_failed',
      version:          1,
      orchestration_id: orchId,
      op:               'read',
      error_class:      'EROFS',
      error_message:    'read-only filesystem',
      cwd:              dir,
      cache_path:       '/tmp/ctx.json',
    }, { cwd: dir });

    const events = readEvents(dir);

    const result = events.find(e => e.type === 'staging_write_result');
    assert.ok(result, 'staging_write_result must be emitted');
    assert.equal(result.outcome, 'failed', 'outcome must be "failed"');
  });

});
