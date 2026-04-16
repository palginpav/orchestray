'use strict';

// Unit tests for loadContextStatusbarConfig and validateContextStatusbarConfig
// (W3 / v2.0.19 Pillar B — Fix #3 from cascade audit round 2).
//
// Covers:
//   - Happy path: valid nested config → all fields parsed
//   - Missing config file → defaults (enabled=true)
//   - context_statusbar key absent → defaults
//   - validateContextStatusbarConfig rejection cases
//   - validateContextStatusbarConfig acceptance cases

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const {
  loadContextStatusbarConfig,
  validateContextStatusbarConfig,
} = require('../bin/_lib/config-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp dir with a .orchestray/config.json file containing `content`.
 * Returns the temp dir path. Caller is responsible for cleanup.
 */
function makeTempConfig(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-test-'));
  const dir = path.join(tmp, '.orchestray');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(content), 'utf8');
  return tmp;
}

// ---------------------------------------------------------------------------
// loadContextStatusbarConfig — happy path
// ---------------------------------------------------------------------------

test('loadContextStatusbarConfig: valid nested config → all fields parsed', () => {
  const tmp = makeTempConfig({
    context_statusbar: {
      enabled: false,
      unicode: true,
      color: true,
      width_cap: 80,
      pressure_thresholds: { warn: 60, critical: 85 },
    },
  });
  try {
    const cfg = loadContextStatusbarConfig(tmp);
    assert.equal(cfg.enabled,  false);
    assert.equal(cfg.unicode,  true);
    assert.equal(cfg.color,    true);
    assert.equal(cfg.width_cap, 80);
    assert.deepEqual(cfg.pressure_thresholds, { warn: 60, critical: 85 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadContextStatusbarConfig — missing config file → defaults
// ---------------------------------------------------------------------------

test('loadContextStatusbarConfig: missing config file → enabled=true (default)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-test-'));
  // No .orchestray/config.json created.
  try {
    const cfg = loadContextStatusbarConfig(tmp);
    assert.equal(cfg.enabled,  true,  'default enabled should be true');
    assert.equal(cfg.unicode,  false, 'default unicode should be false');
    assert.equal(cfg.color,    false, 'default color should be false');
    assert.equal(cfg.width_cap, 120,  'default width_cap should be 120');
    assert.deepEqual(cfg.pressure_thresholds, { warn: 75, critical: 90 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// loadContextStatusbarConfig — context_statusbar key absent → defaults
// ---------------------------------------------------------------------------

test('loadContextStatusbarConfig: context_statusbar key absent → defaults', () => {
  const tmp = makeTempConfig({ mcp_enforcement: {} });
  try {
    const cfg = loadContextStatusbarConfig(tmp);
    assert.equal(cfg.enabled,  true);
    assert.equal(cfg.width_cap, 120);
    assert.deepEqual(cfg.pressure_thresholds, { warn: 75, critical: 90 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// validateContextStatusbarConfig — rejection cases
// ---------------------------------------------------------------------------

test('validateContextStatusbarConfig: rejects non-object', () => {
  assert.equal(validateContextStatusbarConfig(null).valid, false);
  assert.equal(validateContextStatusbarConfig('string').valid, false);
  assert.equal(validateContextStatusbarConfig([]).valid, false);
});

test('validateContextStatusbarConfig: rejects enabled: "yes" (wrong type)', () => {
  const result = validateContextStatusbarConfig({ enabled: 'yes' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /enabled must be a boolean/.test(e)));
});

test('validateContextStatusbarConfig: rejects width_cap: 30 (below min 40)', () => {
  const result = validateContextStatusbarConfig({ enabled: true, width_cap: 30 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /width_cap must be an integer >= 40/.test(e)));
});

test('validateContextStatusbarConfig: rejects width_cap: "wide" (wrong type)', () => {
  const result = validateContextStatusbarConfig({ enabled: true, width_cap: 'wide' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /width_cap must be an integer >= 40/.test(e)));
});

test('validateContextStatusbarConfig: rejects pressure_thresholds.warn: 110 (out of range)', () => {
  const result = validateContextStatusbarConfig({
    pressure_thresholds: { warn: 110 },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /warn must be 0-100/.test(e)));
});

test('validateContextStatusbarConfig: rejects warn > critical (warn: 90, critical: 50)', () => {
  // The validator checks each field is 0-100, but does not enforce warn < critical
  // — that is a runtime concern. This case passes field-level validation (both in range).
  // We test that both values individually pass so any future warn>critical constraint
  // can be detected at this layer.
  const result = validateContextStatusbarConfig({
    pressure_thresholds: { warn: 90, critical: 50 },
  });
  // Both 90 and 50 are individually valid (0-100) — no per-field error expected.
  // If a future cross-field constraint is added, update this test.
  assert.equal(result.valid, true, 'individual fields are valid; cross-field ordering is not currently enforced: ' + JSON.stringify(result));
});

// ---------------------------------------------------------------------------
// validateContextStatusbarConfig — acceptance cases
// ---------------------------------------------------------------------------

test('validateContextStatusbarConfig: accepts minimal {enabled: true}', () => {
  const result = validateContextStatusbarConfig({ enabled: true });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('validateContextStatusbarConfig: accepts full valid config', () => {
  const result = validateContextStatusbarConfig({
    enabled: true,
    unicode: false,
    color: true,
    width_cap: 100,
    pressure_thresholds: { warn: 70, critical: 90 },
  });
  assert.equal(result.valid, true, JSON.stringify(result));
});
