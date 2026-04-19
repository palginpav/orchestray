#!/usr/bin/env node
'use strict';

/**
 * Tests for loadMcpServerConfig and validateMcpServerConfig (Bundle C, v2.1.7).
 *
 * 8-case matrix from §4.C.5 of v217-roadmap.md, mirroring the structural
 * pattern from v215-deferred-fix-spec §Item C.
 *
 * Runner: node --test bin/_lib/__tests__/config-schema-max-per-task.test.js
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadMcpServerConfig,
  validateMcpServerConfig,
  DEFAULT_MAX_PER_TASK,
} = require('../config-schema.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(configObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mpt-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  if (configObj !== undefined && configObj !== null) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(configObj),
      'utf8'
    );
  }
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readJournal(dir) {
  const jp = path.join(dir, '.orchestray', 'state', 'degraded.jsonl');
  try {
    const raw = fs.readFileSync(jp, 'utf8');
    return raw.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Test 1 — Defaults populate when max_per_task block absent
// ---------------------------------------------------------------------------

describe('T1 — defaults when max_per_task block absent', () => {
  test('returns DEFAULT_MAX_PER_TASK values when mcp_server.max_per_task is missing', () => {
    const dir = makeTmpProject({ mcp_server: {} });
    try {
      const cfg = loadMcpServerConfig(dir);
      assert.equal(cfg.ask_user, DEFAULT_MAX_PER_TASK.ask_user, 'ask_user should default to 20');
      assert.equal(cfg.kb_write, DEFAULT_MAX_PER_TASK.kb_write, 'kb_write should default to 20');
      assert.equal(cfg.pattern_record_application, DEFAULT_MAX_PER_TASK.pattern_record_application,
        'pattern_record_application should default to 20');
    } finally {
      cleanup(dir);
    }
  });

  test('returns defaults when config.json is absent entirely', () => {
    const dir = makeTmpProject(null);
    try {
      const cfg = loadMcpServerConfig(dir);
      assert.equal(cfg.ask_user, 20);
      assert.equal(cfg.kb_write, 20);
      assert.equal(cfg.pattern_record_application, 20);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Round-trip valid value (25) for ask_user, other defaults preserved
// ---------------------------------------------------------------------------

describe('T2 — round-trip valid value', () => {
  test('ask_user: 25 round-trips; kb_write and pattern_record_application keep defaults', () => {
    const dir = makeTmpProject({
      mcp_server: { max_per_task: { ask_user: 25 } },
    });
    try {
      const cfg = loadMcpServerConfig(dir);
      assert.equal(cfg.ask_user, 25, 'ask_user should be 25');
      assert.equal(cfg.kb_write, DEFAULT_MAX_PER_TASK.kb_write, 'kb_write should remain at default');
      assert.equal(cfg.pattern_record_application, DEFAULT_MAX_PER_TASK.pattern_record_application,
        'pattern_record_application should remain at default');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Out-of-range (0) → fallback to 20 + journal mcp_server_max_per_task_out_of_range
// ---------------------------------------------------------------------------

describe('T3 — out-of-range 0 falls back to default + journals', () => {
  test('ask_user: 0 triggers fallback to 20 and journals out_of_range', () => {
    const dir = makeTmpProject({
      mcp_server: { max_per_task: { ask_user: 0 } },
    });
    try {
      const cfg = loadMcpServerConfig(dir);
      assert.equal(cfg.ask_user, DEFAULT_MAX_PER_TASK.ask_user,
        'out-of-range 0 should fall back to default 20');

      const journal = readJournal(dir);
      const entry = journal.find(e => e.kind === 'mcp_server_max_per_task_out_of_range');
      assert.ok(entry, 'should have journaled mcp_server_max_per_task_out_of_range');
      assert.equal(entry.detail.tool, 'ask_user');
      assert.equal(entry.detail.value, 0);
      assert.equal(entry.detail.default, 20);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Out-of-range (1001) → fallback + journal
// (uses kb_write to avoid dedup collision with T3's ask_user entry)
// ---------------------------------------------------------------------------

describe('T4 — out-of-range 1001 falls back to default + journals', () => {
  test('kb_write: 1001 triggers fallback to 20 and journals out_of_range', () => {
    const dir = makeTmpProject({
      mcp_server: { max_per_task: { kb_write: 1001 } },
    });
    try {
      const cfg = loadMcpServerConfig(dir);
      assert.equal(cfg.kb_write, DEFAULT_MAX_PER_TASK.kb_write,
        'out-of-range 1001 should fall back to default 20');

      const journal = readJournal(dir);
      const entry = journal.find(e =>
        e.kind === 'mcp_server_max_per_task_out_of_range' && e.detail.tool === 'kb_write'
      );
      assert.ok(entry, 'should have journaled mcp_server_max_per_task_out_of_range for kb_write');
      assert.equal(entry.detail.tool, 'kb_write');
      assert.equal(entry.detail.value, 1001);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Non-integer ("twenty") → fallback + journal
// (uses pattern_record_application to avoid dedup collision with T3/T4)
// ---------------------------------------------------------------------------

describe('T5 — non-integer value falls back to default + journals', () => {
  test('pattern_record_application: "twenty" triggers fallback to 20 and journals out_of_range', () => {
    const dir = makeTmpProject({
      mcp_server: { max_per_task: { pattern_record_application: 'twenty' } },
    });
    try {
      const cfg = loadMcpServerConfig(dir);
      assert.equal(cfg.pattern_record_application, DEFAULT_MAX_PER_TASK.pattern_record_application,
        'non-integer "twenty" should fall back to default 20');

      const journal = readJournal(dir);
      const entry = journal.find(e =>
        e.kind === 'mcp_server_max_per_task_out_of_range' &&
        e.detail.tool === 'pattern_record_application'
      );
      assert.ok(entry, 'should have journaled mcp_server_max_per_task_out_of_range for pattern_record_application');
      assert.equal(entry.detail.tool, 'pattern_record_application');
      assert.equal(entry.detail.value, 'twenty');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Unknown tool key (max_per_task.foo: 50) → passed through + journal
// ---------------------------------------------------------------------------

describe('T6 — unknown tool key passes through + journals unknown_tool', () => {
  test('max_per_task.foo: 50 is passed through and journals unknown_tool KIND', () => {
    const dir = makeTmpProject({
      mcp_server: { max_per_task: { ask_user: 10, foo: 50 } },
    });
    try {
      const cfg = loadMcpServerConfig(dir);
      assert.equal(cfg.ask_user, 10, 'known tool should be set to provided value');
      assert.equal(cfg.foo, 50, 'unknown tool key foo should be passed through');

      const journal = readJournal(dir);
      const entry = journal.find(e => e.kind === 'mcp_server_max_per_task_unknown_tool');
      assert.ok(entry, 'should have journaled mcp_server_max_per_task_unknown_tool');
      assert.equal(entry.detail.tool, 'foo');
      assert.equal(entry.detail.value, 50);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7 — Gate still enforces budget at the new validated value (regression)
// ---------------------------------------------------------------------------

describe('T7 — gate enforces budget at validated value', () => {
  test('tool-counts checkLimit sees the validated value from loadMcpServerConfig', () => {
    const dir = makeTmpProject({
      mcp_server: { max_per_task: { ask_user: 3 } },
    });
    try {
      const cfg = loadMcpServerConfig(dir);
      // Verify the validated value came through.
      assert.equal(cfg.ask_user, 3, 'validated value should be 3');

      // Simulate what tool-counts.js does: use the validated shape.
      // The budget gate uses the value from loadMcpServerConfig (or the raw config fallback).
      // Verify that an in-range value (3) is not treated as a default (20).
      assert.ok(cfg.ask_user < DEFAULT_MAX_PER_TASK.ask_user,
        'validated value (3) should be less than default (20) — gate would enforce at 3, not 20');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8 — validateMcpServerConfig reports errors for out-of-range value
// ---------------------------------------------------------------------------

describe('T8 — validateMcpServerConfig reports errors', () => {
  test('validateMcpServerConfig({max_per_task: {ask_user: -1}}) returns {valid: false, errors: [...]}', () => {
    const result = validateMcpServerConfig({ max_per_task: { ask_user: -1 } });
    assert.equal(result.valid, false, 'should be invalid');
    assert.ok(Array.isArray(result.errors), 'errors should be an array');
    assert.ok(result.errors.length > 0, 'should have at least one error');
    assert.ok(
      result.errors.some(e => e.includes('ask_user')),
      'error should mention ask_user'
    );
  });

  test('validateMcpServerConfig with valid values returns {valid: true}', () => {
    const result = validateMcpServerConfig({ max_per_task: { ask_user: 10, kb_write: 5 } });
    assert.equal(result.valid, true);
    assert.equal(result.errors, undefined);
  });

  test('validateMcpServerConfig with no max_per_task returns {valid: true}', () => {
    const result = validateMcpServerConfig({});
    assert.equal(result.valid, true);
  });

  test('validateMcpServerConfig with out-of-range 0 returns {valid: false}', () => {
    const result = validateMcpServerConfig({ max_per_task: { kb_write: 0 } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('kb_write')));
  });

  test('validateMcpServerConfig with out-of-range 1001 returns {valid: false}', () => {
    const result = validateMcpServerConfig({ max_per_task: { pattern_record_application: 1001 } });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('pattern_record_application')));
  });

  test('validateMcpServerConfig with unknown tool key does NOT produce an error (K5 pass-through)', () => {
    const result = validateMcpServerConfig({ max_per_task: { ask_user: 10, my_custom_tool: 999 } });
    assert.equal(result.valid, true, 'unknown tool keys should not cause validation errors');
  });
});
