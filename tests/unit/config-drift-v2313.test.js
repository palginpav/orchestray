'use strict';

/**
 * v2.3.13 F-MC-01 / F-MC-04 regression tests.
 *
 * Verify that `plugin_loader` and `block_a_zone_caching` are registered in
 * KNOWN_TOP_LEVEL_KEYS (detectDrift no longer reports them unknown) and that
 * the zod schema in schemas/config.schema.js accepts them without error.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const driftModPath = path.join(REPO_ROOT, 'bin', '_lib', 'config-drift.js');
const schemaPath = path.join(REPO_ROOT, 'schemas', 'config.schema.js');

const { detectDrift, KNOWN_TOP_LEVEL_KEYS } = require(driftModPath);
const { configSchema } = require(schemaPath);

// ---------------------------------------------------------------------------
// F-MC-01: plugin_loader
// ---------------------------------------------------------------------------

describe('F-MC-01: plugin_loader no longer trips drift detector', () => {
  test('detectDrift({plugin_loader:{enabled:true}}) returns empty unknown[]', () => {
    const res = detectDrift({ plugin_loader: { enabled: true } });
    assert.deepEqual(res.unknown, [], 'plugin_loader must not appear in unknown[]');
    assert.deepEqual(res.renamed, []);
  });

  test('KNOWN_TOP_LEVEL_KEYS includes plugin_loader', () => {
    assert.ok(
      KNOWN_TOP_LEVEL_KEYS.includes('plugin_loader'),
      'KNOWN_TOP_LEVEL_KEYS must contain plugin_loader'
    );
  });

  test('configSchema.parse() accepts plugin_loader block without error', () => {
    const cfg = {
      plugin_loader: {
        enabled: true,
        discovery: { enabled: true, scan_paths: null },
        consent: { require_explicit_grant: true, auto_approve_unsigned: false },
        lifecycle: {
          max_restart_attempts: 3,
          restart_backoff_ms: [1000, 5000, 30000],
          restart_reset_window_ms: 300000,
        },
      },
    };
    const result = configSchema.safeParse(cfg);
    assert.equal(result.success, true, 'schema must accept plugin_loader: ' + JSON.stringify(result.error));
  });
});

// ---------------------------------------------------------------------------
// F-MC-04: block_a_zone_caching
// ---------------------------------------------------------------------------

describe('F-MC-04: block_a_zone_caching no longer trips drift detector', () => {
  test('detectDrift({block_a_zone_caching:{enabled:false}}) returns empty unknown[]', () => {
    const res = detectDrift({ block_a_zone_caching: { enabled: false } });
    assert.deepEqual(res.unknown, [], 'block_a_zone_caching must not appear in unknown[]');
    assert.deepEqual(res.renamed, []);
  });

  test('KNOWN_TOP_LEVEL_KEYS includes block_a_zone_caching', () => {
    assert.ok(
      KNOWN_TOP_LEVEL_KEYS.includes('block_a_zone_caching'),
      'KNOWN_TOP_LEVEL_KEYS must contain block_a_zone_caching'
    );
  });

  test('configSchema.parse() accepts block_a_zone_caching block without error', () => {
    const cfg = {
      block_a_zone_caching: {
        enabled: false,
        invariant_violation_threshold_24h: 5,
      },
    };
    const result = configSchema.safeParse(cfg);
    assert.equal(result.success, true, 'schema must accept block_a_zone_caching: ' + JSON.stringify(result.error));
  });
});

// ---------------------------------------------------------------------------
// Both keys together (regression guard)
// ---------------------------------------------------------------------------

describe('F-MC-01 + F-MC-04: combined config with both keys', () => {
  test('detectDrift reports no unknown keys when both are present', () => {
    const res = detectDrift({
      plugin_loader: { enabled: true },
      block_a_zone_caching: { enabled: true, invariant_violation_threshold_24h: 3 },
    });
    assert.deepEqual(res.unknown, []);
  });
});
