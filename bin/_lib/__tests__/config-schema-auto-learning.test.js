#!/usr/bin/env node
'use strict';

/**
 * Tests for loadAutoLearningConfig (v2.1.6 W7).
 *
 * Covers: happy path, missing block, malformed block, env-var kill switch,
 * clamp behaviour, missing sub-keys, and alias handling.
 *
 * Runner: node --test bin/_lib/__tests__/config-schema-auto-learning.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  loadAutoLearningConfig,
  DEFAULT_AUTO_LEARNING,
} = require('../config-schema.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-al-test-'));
  // Ensure no leftover env var from prior test.
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH;
});

/** Write config.json with the given auto_learning value (or without the key). */
function writeConfig(autoLearning, extra) {
  const dir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(dir, { recursive: true });
  const obj = Object.assign({}, extra || {});
  if (autoLearning !== undefined) obj.auto_learning = autoLearning;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(obj), 'utf8');
}

/** Capture stderr output during a function call. */
function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  let result;
  try {
    result = fn();
  } finally {
    process.stderr.write = orig;
  }
  return { result, stderr: chunks.join('') };
}

/** Read the degraded-journal to check for auto_learning_config_malformed entries. */
function readJournal() {
  // recordDegradation writes to .orchestray/state/degraded.jsonl
  const jPath = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
  if (!fs.existsSync(jPath)) return [];
  const lines = fs.readFileSync(jPath, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Default constant checks
// ---------------------------------------------------------------------------

describe('DEFAULT_AUTO_LEARNING shape', () => {
  test('all sub-features default to enabled:false', () => {
    assert.equal(DEFAULT_AUTO_LEARNING.global_kill_switch, false);
    assert.equal(DEFAULT_AUTO_LEARNING.extract_on_complete.enabled, false);
    assert.equal(DEFAULT_AUTO_LEARNING.roi_aggregator.enabled, false);
    assert.equal(DEFAULT_AUTO_LEARNING.kb_refs_sweep.enabled, false);
  });

  test('extract_on_complete shadow_mode defaults to false', () => {
    assert.equal(DEFAULT_AUTO_LEARNING.extract_on_complete.shadow_mode, false);
  });
});

// ---------------------------------------------------------------------------
// Happy path — valid full block
// ---------------------------------------------------------------------------

describe('happy path — valid full auto_learning block', () => {
  test('loads all keys correctly', () => {
    writeConfig({
      global_kill_switch: false,
      extract_on_complete: {
        enabled: false,
        shadow_mode: false,
        proposals_per_orchestration: 5,
        proposals_per_24h: 20,
      },
      roi_aggregator: {
        enabled: false,
        min_days_between_runs: 3,
        lookback_days: 60,
      },
      kb_refs_sweep: {
        enabled: false,
        min_days_between_runs: 14,
      },
      safety: {
        circuit_breaker: {
          max_extractions_per_24h: 15,
          cooldown_minutes_on_trip: 120,
        },
      },
    });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.global_kill_switch, false);
    assert.equal(cfg.extract_on_complete.enabled, false);
    assert.equal(cfg.extract_on_complete.shadow_mode, false);
    assert.equal(cfg.extract_on_complete.proposals_per_orchestration, 5);
    assert.equal(cfg.extract_on_complete.proposals_per_24h, 20);
    assert.equal(cfg.roi_aggregator.enabled, false);
    assert.equal(cfg.roi_aggregator.min_days_between_runs, 3);
    assert.equal(cfg.roi_aggregator.lookback_days, 60);
    assert.equal(cfg.kb_refs_sweep.enabled, false);
    assert.equal(cfg.kb_refs_sweep.min_days_between_runs, 14);
    assert.equal(cfg.safety.circuit_breaker.max_extractions_per_24h, 15);
    assert.equal(cfg.safety.circuit_breaker.cooldown_minutes_on_trip, 120);
  });
});

// ---------------------------------------------------------------------------
// Missing block — valid initial state, no degraded-journal entry
// ---------------------------------------------------------------------------

describe('missing block', () => {
  test('no auto_learning key → all-off defaults, no journal entry', () => {
    writeConfig(undefined); // writes config without auto_learning

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.global_kill_switch, false);
    assert.equal(cfg.extract_on_complete.enabled, false);
    assert.equal(cfg.roi_aggregator.enabled, false);
    assert.equal(cfg.kb_refs_sweep.enabled, false);

    // No degraded-journal entry (missing is valid initial state).
    const journal = readJournal();
    const malformed = journal.filter(e => e.kind === 'auto_learning_config_malformed');
    assert.equal(malformed.length, 0, 'missing block must NOT log a journal entry');
  });

  test('missing config.json → all-off defaults, no journal entry', () => {
    // Don't create any config file.
    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.global_kill_switch, false);
    assert.equal(cfg.extract_on_complete.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// Malformed block — returns all-off defaults + degraded-journal entry
// ---------------------------------------------------------------------------

describe('malformed block', () => {
  test('type mismatch (global_kill_switch is string) → all-off defaults + journal entry', () => {
    writeConfig({ global_kill_switch: 'yes', extract_on_complete: { enabled: false } });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.global_kill_switch, false, 'malformed block returns all-off defaults');
    assert.equal(cfg.extract_on_complete.enabled, false);

    const journal = readJournal();
    const malformed = journal.filter(e => e.kind === 'auto_learning_config_malformed');
    assert.ok(malformed.length >= 1, 'malformed block must emit a journal entry');
  });

  test('extract_on_complete.enabled is a number → all-off defaults + journal entry', () => {
    writeConfig({ global_kill_switch: false, extract_on_complete: { enabled: 1 } });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.extract_on_complete.enabled, false);

    const journal = readJournal();
    const malformed = journal.filter(e => e.kind === 'auto_learning_config_malformed');
    assert.ok(malformed.length >= 1);
  });

  test('auto_learning block is a string → all-off defaults + journal entry', () => {
    writeConfig('enabled');

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.global_kill_switch, false);
    assert.equal(cfg.extract_on_complete.enabled, false);

    const journal = readJournal();
    const malformed = journal.filter(e => e.kind === 'auto_learning_config_malformed');
    assert.ok(malformed.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// Env-var kill switch
// ---------------------------------------------------------------------------

describe('env-var kill switch', () => {
  test('ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1 returns global_kill_switch:true even with false in config', () => {
    writeConfig({ global_kill_switch: false, extract_on_complete: { enabled: true } });

    process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH = '1';
    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.global_kill_switch, true, 'env var must override config global_kill_switch');
    // All features remain at defaults (not enabled).
    assert.equal(cfg.extract_on_complete.enabled, false);
  });

  test('env var takes precedence even over config global_kill_switch: true (both true → true)', () => {
    writeConfig({ global_kill_switch: true });

    process.env.ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH = '1';
    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.global_kill_switch, true);
  });

  test('env var NOT set — config global_kill_switch: false is respected', () => {
    writeConfig({ global_kill_switch: false });

    // env var absent
    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.global_kill_switch, false);
  });

  test('env var NOT set with missing config — global_kill_switch: false (all-off defaults)', () => {
    // No config file at all.
    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.global_kill_switch, false);
  });
});

// ---------------------------------------------------------------------------
// Integer clamp tests
// ---------------------------------------------------------------------------

describe('integer clamping', () => {
  test('breaker_max above upper bound (99999) → clamped to 100', () => {
    writeConfig({
      extract_on_complete: { enabled: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 99999 } },
    });

    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.safety.circuit_breaker.max_extractions_per_24h, 100);
  });

  test('max_extractions_per_24h = 0 → clamped to 1', () => {
    writeConfig({
      extract_on_complete: { enabled: false },
      safety: { circuit_breaker: { max_extractions_per_24h: 0 } },
    });

    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.safety.circuit_breaker.max_extractions_per_24h, 1);
  });

  test('proposals_per_orchestration above upper bound (999) → clamped to 10', () => {
    writeConfig({
      extract_on_complete: { enabled: false, proposals_per_orchestration: 999 },
    });

    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.extract_on_complete.proposals_per_orchestration, 10);
  });

  test('proposals_per_orchestration = 0 → clamped to 1', () => {
    writeConfig({
      extract_on_complete: { enabled: false, proposals_per_orchestration: 0 },
    });

    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.extract_on_complete.proposals_per_orchestration, 1);
  });

  test('cooldown_minutes_on_trip below lower bound (1) → clamped to 5', () => {
    writeConfig({
      extract_on_complete: { enabled: false },
      safety: { circuit_breaker: { cooldown_minutes_on_trip: 1 } },
    });

    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.safety.circuit_breaker.cooldown_minutes_on_trip, 5);
  });
});

// ---------------------------------------------------------------------------
// Missing sub-keys — fill in defaults
// ---------------------------------------------------------------------------

describe('missing sub-keys', () => {
  test('extract_on_complete: {} → fills in all defaults for absent keys', () => {
    writeConfig({ extract_on_complete: {} });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.extract_on_complete.enabled, DEFAULT_AUTO_LEARNING.extract_on_complete.enabled);
    assert.equal(cfg.extract_on_complete.shadow_mode, DEFAULT_AUTO_LEARNING.extract_on_complete.shadow_mode);
    assert.equal(cfg.extract_on_complete.proposals_per_orchestration, DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_orchestration);
    assert.equal(cfg.extract_on_complete.proposals_per_24h, DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_24h);
  });

  test('safety: {} → circuit_breaker fills in defaults', () => {
    writeConfig({ safety: {} });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.safety.circuit_breaker.max_extractions_per_24h, DEFAULT_AUTO_LEARNING.safety.circuit_breaker.max_extractions_per_24h);
    assert.equal(cfg.safety.circuit_breaker.cooldown_minutes_on_trip, DEFAULT_AUTO_LEARNING.safety.circuit_breaker.cooldown_minutes_on_trip);
  });

  test('roi_aggregator: {} → fills in defaults', () => {
    writeConfig({ roi_aggregator: {} });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.roi_aggregator.enabled, DEFAULT_AUTO_LEARNING.roi_aggregator.enabled);
    assert.equal(cfg.roi_aggregator.min_days_between_runs, DEFAULT_AUTO_LEARNING.roi_aggregator.min_days_between_runs);
    assert.equal(cfg.roi_aggregator.lookback_days, DEFAULT_AUTO_LEARNING.roi_aggregator.lookback_days);
  });
});

// ---------------------------------------------------------------------------
// Kill-switch cascade documentation (caller responsibility)
// ---------------------------------------------------------------------------

describe('kill-switch cascade semantics', () => {
  test('global_kill_switch:true AND extract_on_complete.enabled:true — loader returns kill_switch true, enabled true (caller must cascade)', () => {
    // The loader does NOT mutate sub-feature flags when global_kill_switch is true.
    // Callers must check global_kill_switch and treat all sub-features as disabled.
    writeConfig({
      global_kill_switch: true,
      extract_on_complete: { enabled: true },
    });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.global_kill_switch, true, 'global_kill_switch must be true');
    // Loader returns the raw enabled value — CALLER is responsible for the cascade.
    // This is by design: the loader is not the enforcement point.
    assert.equal(cfg.extract_on_complete.enabled, true, 'loader returns raw value; caller enforces cascade');
  });
});

// ---------------------------------------------------------------------------
// CHG-01 backward-compat: shadow alias
// ---------------------------------------------------------------------------

describe('CHG-01 shadow alias', () => {
  test('legacy shadow:true (not shadow_mode) maps to shadow_mode:true', () => {
    writeConfig({
      extract_on_complete: { enabled: true, shadow: true },
    });

    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.extract_on_complete.shadow_mode, true, 'shadow alias must map to shadow_mode');
  });

  test('shadow_mode takes precedence over shadow when both present', () => {
    writeConfig({
      extract_on_complete: { enabled: true, shadow_mode: false, shadow: true },
    });

    const cfg = loadAutoLearningConfig(tmpDir);
    assert.equal(cfg.extract_on_complete.shadow_mode, false, 'shadow_mode must take precedence over shadow alias');
  });
});

// ---------------------------------------------------------------------------
// F4 (zero-deferral): haiku-sdk backend → loud fallback to haiku-cli
// ---------------------------------------------------------------------------

describe('F4 — haiku-sdk backend rejected loudly (K3 arbitration)', () => {
  function readJournalF4() {
    const p = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  }

  test('backend: "haiku-sdk" falls back to "haiku-cli" and journals auto_extract_backend_unsupported_value', () => {
    writeConfig({
      extract_on_complete: { enabled: true, backend: 'haiku-sdk' },
    });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.extract_on_complete.backend, 'haiku-cli',
      'haiku-sdk must fall back to haiku-cli');

    const journal = readJournalF4();
    assert.ok(
      journal.some((e) => e.kind === 'auto_extract_backend_unsupported_value'),
      'must journal auto_extract_backend_unsupported_value'
    );
  });

  test('backend: "haiku-cli" is accepted without journal entry', () => {
    writeConfig({
      extract_on_complete: { enabled: true, backend: 'haiku-cli' },
    });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.extract_on_complete.backend, 'haiku-cli');
    const journal = readJournalF4();
    assert.ok(
      !journal.some((e) => e.kind === 'auto_extract_backend_unsupported_value'),
      'haiku-cli must NOT journal the unsupported-value entry'
    );
  });

  test('backend: "stub" is accepted without journal entry', () => {
    writeConfig({
      extract_on_complete: { enabled: true, backend: 'stub' },
    });

    const cfg = loadAutoLearningConfig(tmpDir);

    assert.equal(cfg.extract_on_complete.backend, 'stub');
    const journal = readJournalF4();
    assert.ok(
      !journal.some((e) => e.kind === 'auto_extract_backend_unsupported_value'),
      '"stub" must NOT journal the unsupported-value entry'
    );
  });

  test('backend: "completely-unknown" still triggers the invalid-value all-off fallback', () => {
    writeConfig({
      extract_on_complete: { enabled: true, backend: 'completely-unknown' },
    });

    const cfg = loadAutoLearningConfig(tmpDir);

    // Completely unknown values (not haiku-sdk) trigger auto_learning_config_malformed
    // and return all-off defaults.
    assert.equal(cfg.extract_on_complete.enabled, false,
      'unknown backend must trigger all-off defaults');
    const journal = readJournalF4();
    assert.ok(
      journal.some((e) => e.kind === 'auto_learning_config_malformed'),
      'unknown backend must journal auto_learning_config_malformed'
    );
  });
});

// ---------------------------------------------------------------------------
// Shipped config.json all-off assertion
// ---------------------------------------------------------------------------

describe('shipped .orchestray/config.json has all auto_learning features OFF', () => {
  test('loading the actual project config yields extract_on_complete.enabled:false and shadow_mode:false', () => {
    // Use the real project root (not the tmpDir).
    const projectRoot = path.resolve(__dirname, '../../../');
    const cfg = loadAutoLearningConfig(projectRoot);

    assert.equal(cfg.extract_on_complete.enabled, false,
      'extract_on_complete.enabled MUST be false in shipped config');
    assert.equal(cfg.extract_on_complete.shadow_mode, false,
      'extract_on_complete.shadow_mode MUST be false in shipped config');
    assert.equal(cfg.global_kill_switch, false,
      'global_kill_switch must be false (kill switch off by default)');
  });
});
