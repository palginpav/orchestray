#!/usr/bin/env node
'use strict';

/**
 * Tests for loadFederationConfig and loadCuratorConfig flat-key fallback fix.
 *
 * Covers the 11-case matrix from the W1 design (fed-curator-config-fix-design.md §8)
 * parameterized across both sections to avoid duplication.
 *
 * Runner: node --test bin/_lib/__tests__/config-schema-federation-curator.test.js
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadFederationConfig,
  loadCuratorConfig,
  DEFAULT_FEDERATION,
  DEFAULT_CURATOR,
  _flatDeprecationWarned,
} = require('../config-schema.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(configObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cfg-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  if (configObj !== null) {
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

// Capture stderr during a loader call so tests can inspect warnings.
function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };
  try {
    const result = fn();
    return { result, stderr: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

// ---------------------------------------------------------------------------
// Parameterized section helpers
// ---------------------------------------------------------------------------

const SECTIONS = [
  {
    name: 'federation',
    loader: loadFederationConfig,
    defaults: DEFAULT_FEDERATION,
    flatConfig: {
      'federation.shared_dir_enabled': true,
      'federation.sensitivity': 'shareable',
      'federation.shared_dir_path': '~/.orchestray/shared',
    },
    flatPartial: { 'federation.shared_dir_enabled': true },
    nestedConfig: { federation: { shared_dir_enabled: true } },
    nestedFull: {
      federation: {
        shared_dir_enabled: true,
        sensitivity: 'shareable',
        shared_dir_path: '~/.orchestray/shared',
      },
    },
    bothConfig: {
      federation: { shared_dir_enabled: false },
      'federation.shared_dir_enabled': true,
    },
    malformedSection: { federation: 'yes' },
    wrongTypedLeaf: { 'federation.shared_dir_enabled': 'yes' },
    outOfRangeConfig: null, // N/A for federation
    // expected flat-full result
    flatResult: {
      shared_dir_enabled: true,
      sensitivity: 'shareable',
      shared_dir_path: '~/.orchestray/shared',
    },
    deprecationPattern: '[orchestray] config: federation.* keys found as flat',
  },
  {
    name: 'curator',
    loader: loadCuratorConfig,
    defaults: DEFAULT_CURATOR,
    flatConfig: {
      'curator.enabled': false,
      'curator.tombstone_retention_runs': 5,
      'curator.self_escalation_enabled': false,
      'curator.pm_recommendation_enabled': false,
    },
    flatPartial: { 'curator.enabled': false },
    nestedConfig: { curator: { enabled: false } },
    nestedFull: {
      curator: {
        enabled: false,
        self_escalation_enabled: false,
        pm_recommendation_enabled: false,
        tombstone_retention_runs: 5,
      },
    },
    bothConfig: {
      curator: { enabled: false },
      'curator.enabled': true,
    },
    malformedSection: { curator: 'yes' },
    wrongTypedLeaf: { 'curator.enabled': 'yes' },
    outOfRangeConfig: { 'curator.tombstone_retention_runs': 99 },
    flatResult: {
      enabled: false,
      self_escalation_enabled: false,
      pm_recommendation_enabled: false,
      tombstone_retention_runs: 5,
    },
    deprecationPattern: '[orchestray] config: curator.* keys found as flat',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

for (const section of SECTIONS) {
  describe(`${section.name} config loader`, () => {
    // Reset the per-process deprecation guard before each test so warnings
    // are predictable regardless of test execution order.
    beforeEach(() => {
      _flatDeprecationWarned.clear();
    });

    // T1: flat-only (legacy)
    test('T1: flat-only keys load correctly', () => {
      const dir = makeTmpProject(section.flatConfig);
      try {
        const cfg = section.loader(dir);
        const expected = section.flatResult;
        for (const [k, v] of Object.entries(expected)) {
          assert.deepStrictEqual(cfg[k], v, `key ${k}`);
        }
        // All default keys must be present
        for (const k of Object.keys(section.defaults)) {
          assert.ok(k in cfg, `result must contain key ${k}`);
        }
      } finally {
        cleanup(dir);
      }
    });

    // T2: nested-only (new canonical) — defaults filled in
    test('T2: nested-only config loads and fills defaults', () => {
      const dir = makeTmpProject(section.nestedConfig);
      try {
        const cfg = section.loader(dir);
        // The explicitly-set key must have been applied
        const nestedObj = Object.values(section.nestedConfig)[0];
        for (const [k, v] of Object.entries(nestedObj)) {
          assert.deepStrictEqual(cfg[k], v, `key ${k}`);
        }
        // All default keys present
        for (const k of Object.keys(section.defaults)) {
          assert.ok(k in cfg, `result must contain key ${k}`);
        }
      } finally {
        cleanup(dir);
      }
    });

    // T3: both present — nested wins
    test('T3: nested wins over flat when both present', () => {
      const dir = makeTmpProject(section.bothConfig);
      try {
        const cfg = section.loader(dir);
        // The nested value is false; flat says true — nested must win
        const nestedSection = Object.values(
          Object.fromEntries(
            Object.entries(section.bothConfig).filter(([k]) => !k.includes('.'))
          )
        )[0];
        for (const [k, v] of Object.entries(nestedSection)) {
          assert.deepStrictEqual(cfg[k], v, `nested wins for key ${k}`);
        }
      } finally {
        cleanup(dir);
      }
    });

    // T4: neither present — defaults apply
    test('T4: empty config returns defaults', () => {
      const dir = makeTmpProject({});
      try {
        const cfg = section.loader(dir);
        assert.deepStrictEqual(cfg, Object.assign({}, section.defaults));
      } finally {
        cleanup(dir);
      }
    });

    // T5: malformed section value — fail open to defaults
    test('T5: malformed section value (string) falls open to defaults', () => {
      const dir = makeTmpProject(section.malformedSection);
      try {
        const cfg = section.loader(dir);
        assert.deepStrictEqual(cfg, Object.assign({}, section.defaults));
      } finally {
        cleanup(dir);
      }
    });

    // T6: wrong-typed leaf in flat form — loader does not throw and returns default
    test('T6: wrong-typed leaf in flat form does not throw', () => {
      const dir = makeTmpProject(section.wrongTypedLeaf);
      try {
        assert.doesNotThrow(() => section.loader(dir));
        const cfg = section.loader(dir);
        const shortKey = Object.keys(section.wrongTypedLeaf)[0].split('.')[1];
        assert.deepStrictEqual(cfg[shortKey], section.defaults[shortKey],
          'wrong-typed leaf uses default');
      } finally {
        cleanup(dir);
      }
    });

    // T7: flat partial (only some keys) — missing keys filled from defaults
    test('T7: flat partial keys fill missing keys from defaults', () => {
      const dir = makeTmpProject(section.flatPartial);
      try {
        const cfg = section.loader(dir);
        // All keys present
        for (const k of Object.keys(section.defaults)) {
          assert.ok(k in cfg, `result must contain key ${k}`);
        }
        // The explicitly-set key should be honoured where type-valid
        const [key, val] = Object.entries(section.flatPartial)[0];
        const shortKey = key.split('.')[1];
        // type may differ from default — if type is correct, value should be applied
        const defaultTypeof = typeof section.defaults[shortKey];
        if (typeof val === defaultTypeof) {
          assert.deepStrictEqual(cfg[shortKey], val, `partial flat key ${shortKey} respected`);
        }
      } finally {
        cleanup(dir);
      }
    });

    // T8: flat-only curator (exact mirror of T1 for curator) — already covered by T1 above
    // (parameterized — T1 runs for curator section with the same assertions)

    // T9: out-of-range value falls back to default (curator only)
    if (section.outOfRangeConfig) {
      test('T9: out-of-range tombstone_retention_runs falls back to default', () => {
        const dir = makeTmpProject(section.outOfRangeConfig);
        try {
          const cfg = section.loader(dir);
          assert.strictEqual(
            cfg.tombstone_retention_runs,
            section.defaults.tombstone_retention_runs,
            'out-of-range value must fall back to default'
          );
        } finally {
          cleanup(dir);
        }
      });
    }

    // T10: flat deprecation warning emitted
    test('T10: deprecation warning emitted for flat config', () => {
      const dir = makeTmpProject(section.flatConfig);
      try {
        const { stderr } = captureStderr(() => section.loader(dir));
        assert.ok(
          stderr.includes(section.deprecationPattern),
          `expected deprecation warning containing "${section.deprecationPattern}", got: ${JSON.stringify(stderr)}`
        );
      } finally {
        cleanup(dir);
      }
    });

    // T11: no deprecation warning for nested config
    test('T11: no deprecation warning for nested config', () => {
      const dir = makeTmpProject(section.nestedFull);
      try {
        const { stderr } = captureStderr(() => section.loader(dir));
        assert.ok(
          !stderr.includes(section.deprecationPattern),
          `unexpected deprecation warning for nested config: ${JSON.stringify(stderr)}`
        );
      } finally {
        cleanup(dir);
      }
    });

    // Extra: warning fires at most once per process per section
    test('deprecation warning fires only once per process per section', () => {
      const dir = makeTmpProject(section.flatConfig);
      try {
        const chunks = [];
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk, ...rest) => {
          chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
          return true;
        };
        try {
          section.loader(dir);
          section.loader(dir); // second call — should NOT emit again
        } finally {
          process.stderr.write = original;
        }
        const combined = chunks.join('');
        const count = (combined.match(new RegExp(section.name + '\\.\\*', 'g')) || []).length;
        assert.strictEqual(count, 1, `deprecation warning must appear exactly once, got ${count}`);
      } finally {
        cleanup(dir);
      }
    });
  });
}
