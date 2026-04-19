#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/config-repair.js (v2.1.6 — W10 observability).
 *
 * Runner: node --test bin/_lib/__tests__/config-repair.test.js
 *
 * Coverage:
 *   1. Missing auto_learning block → repair adds it with defaults; backup created.
 *   2. Malformed block (type mismatch) → repair replaces it; backup created.
 *   3. Valid block → no-op; no backup written; config_repair_noop event.
 *   4. Other top-level keys preserved (JSON parse-equivalence).
 *   5. --dry-run → no file writes; reports what would happen.
 *   6. Config file absent entirely → repair creates it with defaults.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { repairAutoLearning } = require('../config-repair');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-repair-test-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
});

afterEach(() => {
  // Clear kill-switch env var between tests.
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function configPath(root) {
  return path.join(root || tmpDir, '.orchestray', 'config.json');
}

function writeConfig(root, content) {
  const cfgPath = configPath(root);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
}

function readConfig(root) {
  return JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
}

function listBackups(root) {
  root = root || tmpDir;
  const dir = path.join(root, '.orchestray');
  const entries = fs.readdirSync(dir);
  return entries.filter(e => e.startsWith('config.json.bak-'));
}

/**
 * The canonical default auto_learning block as produced by DEFAULT_AUTO_LEARNING.
 */
const EXPECTED_AUTO_LEARNING = {
  global_kill_switch: false,
  extract_on_complete: {
    enabled: false,
    shadow_mode: false,
    proposals_per_orchestration: 3,
    proposals_per_24h: 10,
  },
  roi_aggregator: {
    enabled: false,
    min_days_between_runs: 1,
    lookback_days: 30,
  },
  kb_refs_sweep: {
    enabled: false,
    min_days_between_runs: 7,
  },
  safety: {
    circuit_breaker: {
      max_extractions_per_24h: 10,
      cooldown_minutes_on_trip: 60,
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config-repair', () => {
  test('missing auto_learning block → repair adds it with defaults; backup created', () => {
    // Config exists but has no auto_learning key.
    writeConfig(tmpDir, {
      mcp_enforcement: { global_kill_switch: false },
      other_key: 'preserved',
    });

    const result = repairAutoLearning(tmpDir);

    assert.equal(result.repaired, true, 'should be repaired');
    assert.equal(result.reason, 'missing');
    assert.ok(result.backup, 'backup path should be set');
    assert.ok(fs.existsSync(result.backup), 'backup file should exist');

    const updated = readConfig(tmpDir);
    assert.deepStrictEqual(updated.auto_learning, EXPECTED_AUTO_LEARNING,
      'auto_learning should match defaults');

    // Other keys must be preserved.
    assert.deepStrictEqual(updated.mcp_enforcement, { global_kill_switch: false },
      'other keys must be preserved');
    assert.equal(updated.other_key, 'preserved', 'other_key must be preserved');

    // Verify backup count.
    const backups = listBackups();
    assert.equal(backups.length, 1, 'exactly one backup');
  });

  test('malformed block (global_kill_switch wrong type) → repair replaces; backup created', () => {
    writeConfig(tmpDir, {
      auto_learning: {
        global_kill_switch: 'not-a-boolean',   // type mismatch → loader falls back to all-off + journal
        roi_aggregator: { enabled: true },
      },
      sentinel: 42,
    });

    const result = repairAutoLearning(tmpDir);

    assert.equal(result.repaired, true, 'should be repaired');
    assert.equal(result.reason, 'malformed');
    assert.ok(result.backup, 'backup path should be set');
    assert.ok(fs.existsSync(result.backup), 'backup file should exist');

    const updated = readConfig(tmpDir);
    assert.deepStrictEqual(updated.auto_learning, EXPECTED_AUTO_LEARNING,
      'auto_learning should be reset to defaults');
    assert.equal(updated.sentinel, 42, 'sentinel key must be preserved');
  });

  test('valid block → no-op; no backup; config_repair_noop event emitted', () => {
    // Write a fully valid auto_learning block.
    writeConfig(tmpDir, {
      auto_learning: {
        global_kill_switch: false,
        extract_on_complete: {
          enabled: false,
          shadow_mode: false,
          proposals_per_orchestration: 3,
          proposals_per_24h: 10,
        },
        roi_aggregator: { enabled: false, min_days_between_runs: 1, lookback_days: 30 },
        kb_refs_sweep: { enabled: false, min_days_between_runs: 7 },
        safety: {
          circuit_breaker: { max_extractions_per_24h: 10, cooldown_minutes_on_trip: 60 },
        },
      },
    });

    const contentBefore = fs.readFileSync(configPath(), 'utf8');
    const result = repairAutoLearning(tmpDir);

    assert.equal(result.repaired, false, 'should not be repaired');
    assert.equal(result.reason, 'valid');
    assert.equal(result.backup, null, 'no backup for valid config');

    const contentAfter = fs.readFileSync(configPath(), 'utf8');
    assert.equal(contentBefore, contentAfter, 'config must not be modified');

    const backups = listBackups();
    assert.equal(backups.length, 0, 'no backups for valid config');

    // config_repair_noop event should have been emitted.
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath), 'events.jsonl should exist');
    const events = fs.readFileSync(eventsPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => JSON.parse(l));
    const noopEvts = events.filter(e => e.type === 'config_repair_noop');
    assert.equal(noopEvts.length, 1, 'config_repair_noop event should be emitted');
  });

  test('other top-level keys are preserved (JSON parse-equivalence)', () => {
    const original = {
      mcp_enforcement: { pattern_find: 'hook', global_kill_switch: false },
      shield: { r14_dedup_reads: { enabled: true } },
      audit: { max_events_bytes_for_scan: null },
      my_custom_key: [1, 2, 3],
    };
    writeConfig(tmpDir, original);

    repairAutoLearning(tmpDir);

    const updated = readConfig(tmpDir);
    // auto_learning should have been added.
    assert.ok(updated.auto_learning, 'auto_learning must be added');
    // All original keys must be preserved.
    assert.deepStrictEqual(updated.mcp_enforcement, original.mcp_enforcement);
    assert.deepStrictEqual(updated.shield, original.shield);
    assert.deepStrictEqual(updated.audit, original.audit);
    assert.deepStrictEqual(updated.my_custom_key, original.my_custom_key);
  });

  test('--dry-run → no file writes; reports what would happen', () => {
    // Config without auto_learning.
    writeConfig(tmpDir, { other: 'value' });
    const contentBefore = fs.readFileSync(configPath(), 'utf8');

    const result = repairAutoLearning(tmpDir, { dryRun: true });

    assert.equal(result.dryRun, true, 'dryRun flag should be set');
    assert.equal(result.repaired, false, 'should not actually repair in dry-run');
    assert.equal(result.reason, 'missing', 'reason should still be reported');

    // Config must not have changed.
    const contentAfter = fs.readFileSync(configPath(), 'utf8');
    assert.equal(contentBefore, contentAfter, 'config must not be modified in dry-run');

    // No backup.
    const backups = listBackups();
    assert.equal(backups.length, 0, 'no backups in dry-run');
  });

  test('config file absent entirely → repair creates it with defaults', () => {
    // Do NOT create config.json.
    assert.ok(!fs.existsSync(configPath()), 'precondition: no config file');

    const result = repairAutoLearning(tmpDir);

    assert.equal(result.repaired, true, 'should be repaired');
    assert.ok(fs.existsSync(configPath()), 'config.json should be created');
    const created = readConfig(tmpDir);
    assert.deepStrictEqual(created.auto_learning, EXPECTED_AUTO_LEARNING);
  });
});
