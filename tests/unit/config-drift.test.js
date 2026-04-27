#!/usr/bin/env node
'use strict';

/**
 * Unit tests for R-CONFIG-DRIFT (v2.1.13 W9):
 *   - bin/_lib/config-drift.js          (pure detector)
 *   - bin/_lib/config-rename-map.js     (rename dictionary)
 *   - bin/boot-validate-config.js       (drift-warning emission + dedup)
 *
 * AC coverage (from the v2.1.13 plan, §R-CONFIG-DRIFT):
 *   (a) Unknown top-level key with a close match → warning includes
 *       "did you mean <closest>?" suggestion (lev ≤ 2).
 *   (b) Renamed-key case → warning surfaces the new name.
 *   (c) `config_drift_silence: ["key"]` suppresses that key's warning.
 *   (d) Same unknown key twice (across two detector runs) → emitted once.
 *   (e) Boot exits 0 on drift only (no zod errors).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const driftModPath = path.join(REPO_ROOT, 'bin', '_lib', 'config-drift.js');
const renameModPath = path.join(REPO_ROOT, 'bin', '_lib', 'config-rename-map.js');
const bootScriptPath = path.join(REPO_ROOT, 'bin', 'boot-validate-config.js');
const schemaPath = path.join(REPO_ROOT, 'schemas', 'config.schema.js');

const { detectDrift, lev, nearestKey, KNOWN_TOP_LEVEL_KEYS } = require(driftModPath);
const { RENAME_MAP } = require(renameModPath);

// ---------------------------------------------------------------------------
// Pure detector
// ---------------------------------------------------------------------------

describe('config-drift — lev()', () => {
  test('identical strings → 0', () => {
    assert.equal(lev('foo', 'foo'), 0);
    assert.equal(lev('', ''), 0);
  });
  test('empty-vs-nonempty → length of the other', () => {
    assert.equal(lev('', 'abc'), 3);
    assert.equal(lev('abc', ''), 3);
  });
  test('single-substitution → 1', () => {
    assert.equal(lev('auto_reviwe', 'auto_review'), 2); // swap + swap? actually: "auto_reviwe" vs "auto_review" — w/e → e/w; distance 2
    assert.equal(lev('auto_revie', 'auto_review'), 1);
  });
  test('classic examples', () => {
    assert.equal(lev('kitten', 'sitting'), 3);
    assert.equal(lev('flaw', 'lawn'), 2);
  });
});

describe('config-drift — nearestKey()', () => {
  test('finds a match within distance 2', () => {
    const near = nearestKey('auto_reveiw', KNOWN_TOP_LEVEL_KEYS, 2);
    assert.equal(near, 'auto_review');
  });
  test('returns null when nothing within distance 2', () => {
    const near = nearestKey('this_key_does_not_resemble_anything_xyz', KNOWN_TOP_LEVEL_KEYS, 2);
    assert.equal(near, null);
  });
  test('length-difference fast-path still yields correct nearest', () => {
    // "complexity_threshol" (missing trailing d) is distance 1 from the real key
    const near = nearestKey('complexity_threshol', KNOWN_TOP_LEVEL_KEYS, 2);
    assert.equal(near, 'complexity_threshold');
  });
});

describe('config-drift — detectDrift()', () => {
  test('AC(a): unknown top-level key with close match → suggests it', () => {
    const res = detectDrift({ auto_reveiw: true });
    assert.deepEqual(res.unknown, ['auto_reveiw']);
    assert.equal(res.suggestions.auto_reveiw, 'auto_review');
    assert.deepEqual(res.renamed, []);
  });

  test('unknown top-level key with NO close match → unknown but no suggestion', () => {
    const res = detectDrift({ zz_totally_unrelated_gibberish: 1 });
    assert.deepEqual(res.unknown, ['zz_totally_unrelated_gibberish']);
    assert.equal(res.suggestions.zz_totally_unrelated_gibberish, undefined);
  });

  test('known keys are never flagged', () => {
    const res = detectDrift({
      auto_review: true,
      complexity_threshold: 5,
      retrieval: { scorer_variant: 'baseline' },
      mcp_server: { enabled: true },
      config_drift_silence: [],
    });
    assert.deepEqual(res.unknown, []);
    assert.deepEqual(res.renamed, []);
  });

  test('AC(b): renamed key → returns {to} from rename map, not in unknown[]', () => {
    const renameMap = {
      old_name: { to: 'new_name', since: '2.1.13' },
    };
    const res = detectDrift({ old_name: 'v' }, {
      knownKeys: ['new_name'],
      renameMap,
    });
    assert.deepEqual(res.unknown, []);
    assert.equal(res.renamed.length, 1);
    assert.equal(res.renamed[0].key, 'old_name');
    assert.equal(res.renamed[0].to, 'new_name');
    assert.equal(res.renamed[0].since, '2.1.13');
  });

  test('rename entry with example:true is ignored (treated as plain unknown)', () => {
    const renameMap = {
      example_key: { to: 'something', example: true },
    };
    const res = detectDrift({ example_key: 1 }, {
      knownKeys: ['auto_review'],
      renameMap,
    });
    assert.deepEqual(res.renamed, []);
    assert.deepEqual(res.unknown, ['example_key']);
  });

  test('AC(c): silence list suppresses matching keys', () => {
    const res = detectDrift(
      { not_a_real_key_xyz: 1, also_unknown: 2 },
      { silence: ['not_a_real_key_xyz'] }
    );
    assert.deepEqual(res.unknown, ['also_unknown']);
    assert.equal(res.suggestions.not_a_real_key_xyz, undefined);
  });

  test('non-object / null / array config → empty result, no throw', () => {
    assert.deepEqual(detectDrift(null), { unknown: [], renamed: [], suggestions: {} });
    assert.deepEqual(detectDrift(undefined), { unknown: [], renamed: [], suggestions: {} });
    assert.deepEqual(detectDrift([]), { unknown: [], renamed: [], suggestions: {} });
    assert.deepEqual(detectDrift('foo'), { unknown: [], renamed: [], suggestions: {} });
  });
});

// ---------------------------------------------------------------------------
// Rename map
// ---------------------------------------------------------------------------

describe('config-rename-map', () => {
  test('RENAME_MAP is frozen', () => {
    assert.ok(Object.isFrozen(RENAME_MAP));
  });

  test('every rename entry has a string `to` field', () => {
    for (const [key, val] of Object.entries(RENAME_MAP)) {
      assert.ok(val && typeof val === 'object', `entry "${key}" must be object`);
      assert.equal(typeof val.to, 'string', `entry "${key}".to must be string`);
      assert.ok(val.to.length > 0, `entry "${key}".to must be non-empty`);
    }
  });

  test('placeholder example entry is gated by example:true', () => {
    // Ensures we never accidentally emit a warning for the documentation stub.
    const ex = RENAME_MAP.__example_old_key;
    if (ex) {
      assert.equal(ex.example, true, 'documentation-stub entry must set example:true');
    }
  });
});

// ---------------------------------------------------------------------------
// KNOWN_TOP_LEVEL_KEYS cross-reference test
// ---------------------------------------------------------------------------

describe('config-drift — KNOWN_TOP_LEVEL_KEYS stays in sync with schema', () => {
  test('every top-level key in schemas/config.schema.js is listed', () => {
    const src = fs.readFileSync(schemaPath, 'utf8');
    // Find the top-level configSchema body, then extract the keys.
    // The configSchema block begins with `const configSchema = z.object({`.
    const start = src.indexOf('const configSchema = z.object({');
    assert.ok(start >= 0, 'schema file must contain `const configSchema = z.object({`');
    // The body extends until the closing `}).passthrough();`.
    const after = src.slice(start);
    const end = after.indexOf('}).passthrough()');
    assert.ok(end >= 0, 'schema configSchema block must close with `}).passthrough()`');
    const body = after.slice(0, end);

    // Extract keys: any line matching `  <key>:` (single indentation level).
    // Skip comment-only lines.
    const keyRe = /^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
    const schemaKeys = new Set();
    let m;
    while ((m = keyRe.exec(body)) !== null) {
      schemaKeys.add(m[1]);
    }
    assert.ok(schemaKeys.size > 20, 'expected to extract many top-level keys, got ' + schemaKeys.size);

    const known = new Set(KNOWN_TOP_LEVEL_KEYS);
    const missingInKnown = [];
    for (const k of schemaKeys) {
      if (!known.has(k)) missingInKnown.push(k);
    }
    const extraInKnown = [];
    for (const k of known) {
      if (!schemaKeys.has(k)) extraInKnown.push(k);
    }
    assert.deepEqual(
      missingInKnown,
      [],
      'KNOWN_TOP_LEVEL_KEYS missing these schema keys: ' + missingInKnown.join(', ')
    );
    assert.deepEqual(
      extraInKnown,
      [],
      'KNOWN_TOP_LEVEL_KEYS has these keys not in schema: ' + extraInKnown.join(', ')
    );
  });
});

// ---------------------------------------------------------------------------
// boot-validate-config.js integration
// ---------------------------------------------------------------------------

function seed(tmp, filePath, content) {
  const abs = path.join(tmp, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function runBoot(cwd, extraEnv) {
  const env = Object.assign({}, process.env, { CLAUDE_PROJECT_DIR: cwd }, extraEnv || {});
  return spawnSync(process.execPath, [bootScriptPath], { env, encoding: 'utf8' });
}

describe('boot-validate-config.js — drift integration (spawned)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-drift-boot-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('AC(a): typo in top-level key → exit 0, stderr has "did you mean"', () => {
    seed(tmp, '.orchestray/config.json', JSON.stringify({
      auto_review: true,
      complexity_threshol: 5, // typo: missing trailing "d"
    }));
    const r = runBoot(tmp);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: stderr=${r.stderr}`);
    assert.match(r.stderr, /config drift/);
    assert.match(r.stderr, /complexity_threshol/);
    assert.match(r.stderr, /did you mean "complexity_threshold"/);
  });

  test('AC(c): silence list suppresses the warning', () => {
    seed(tmp, '.orchestray/config.json', JSON.stringify({
      totally_unknown_key: 1,
      config_drift_silence: ['totally_unknown_key'],
    }));
    const r = runBoot(tmp);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /totally_unknown_key/);
  });

  test('AC(e): exit 0 on drift-only (no zod errors)', () => {
    seed(tmp, '.orchestray/config.json', JSON.stringify({
      my_mysterious_flag: true,
    }));
    const r = runBoot(tmp);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /unknown top-level key "my_mysterious_flag"/);
  });

  test('no config → no drift output, exit 0', () => {
    const r = runBoot(tmp);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /config drift/);
  });

  test('malformed JSON → drift detector no-ops (zod phase already reports)', () => {
    seed(tmp, '.orchestray/config.json', '{ this is not json');
    const r = runBoot(tmp);
    // Exit 1 expected from zod phase (JSON parse error), but we care that
    // the drift detector didn't crash the script.
    assert.notEqual(r.status, 2, 'drift detector must not crash boot');
    assert.doesNotMatch(r.stderr, /drift detector internal error/);
  });
});

// ---------------------------------------------------------------------------
// Dedup: runDriftDetection() called twice with the same unknown key → one warning
// ---------------------------------------------------------------------------

describe('boot-validate-config.js — dedup (in-process)', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-drift-dedup-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    // The boot-validate-config module keeps a session-scoped WARNED_KEYS Set.
    // Purge require cache so each test starts fresh.
    delete require.cache[require.resolve(bootScriptPath)];
  });

  test('AC(d): second call with same unknown key → no duplicate warning', () => {
    // Require the module fresh for this test so WARNED_KEYS starts empty.
    delete require.cache[require.resolve(bootScriptPath)];
    const boot = require(bootScriptPath);
    seed(tmp, '.orchestray/config.json', JSON.stringify({
      some_unknown_thing: 1,
    }));

    // Capture stderr
    const chunks = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    try {
      boot.runDriftDetection(tmp);
      boot.runDriftDetection(tmp); // second call: dedup should kick in
    } finally {
      process.stderr.write = orig;
    }
    const combined = chunks.join('');
    const matches = combined.match(/unknown top-level key "some_unknown_thing"/g) || [];
    assert.equal(matches.length, 1, 'expected exactly one warning, got ' + matches.length);
  });

  test('two DIFFERENT unknown keys → two warnings', () => {
    delete require.cache[require.resolve(bootScriptPath)];
    const boot = require(bootScriptPath);
    seed(tmp, '.orchestray/config.json', JSON.stringify({
      unknown_a: 1,
      unknown_b: 2,
    }));
    const chunks = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    try {
      boot.runDriftDetection(tmp);
    } finally {
      process.stderr.write = orig;
    }
    const combined = chunks.join('');
    assert.match(combined, /unknown_a/);
    assert.match(combined, /unknown_b/);
  });
});

// ---------------------------------------------------------------------------
// AC(b): renamed key end-to-end via detectDrift opts (no seeding required
// in the real rename map since W9 ships with an empty map).
// ---------------------------------------------------------------------------

describe('config-drift — renamed-key warning end-to-end', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-drift-renamed-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('AC(b): a synthetic renamed entry surfaces the new name', () => {
    // Exercise the detector directly with an injected rename map, since
    // the real RENAME_MAP intentionally has no live entries yet.
    const res = detectDrift(
      { sensitivity: 'private' },
      {
        knownKeys: ['federation'],
        renameMap: { sensitivity: { to: 'federation.sensitivity', since: '2.1.x' } },
      }
    );
    assert.equal(res.renamed.length, 1);
    assert.equal(res.renamed[0].key, 'sensitivity');
    assert.equal(res.renamed[0].to, 'federation.sensitivity');
  });
});

// ---------------------------------------------------------------------------
// F-001 (v2.2.0 pre-ship cross-phase fix-pass): pm_protocol / event_schemas /
// output_shape — three top-level blocks introduced by P1.2/P1.3/P3.2 must NOT
// produce "unknown top-level key" boot-time drift warnings on fresh installs.
// ---------------------------------------------------------------------------

describe('config-drift — v2.2.0 P1.2/P1.3/P3.2 top-level keys are registered', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-drift-v220-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('detectDrift() flags none of pm_protocol/event_schemas/output_shape as unknown', () => {
    const res = detectDrift({
      pm_protocol: { delegation_delta: { enabled: true }, tier2_index: { enabled: true } },
      event_schemas: { full_load_disabled: true },
      output_shape: {
        enabled: true,
        caveman_enabled: true,
        structured_outputs_enabled: true,
        length_cap_enabled: true,
        staged_flip_allowlist: ['researcher', 'tester'],
      },
    });
    assert.deepEqual(res.unknown, [], 'all three v2.2.0 keys must be in KNOWN_TOP_LEVEL_KEYS');
    assert.deepEqual(res.renamed, []);
  });

  test('boot-validate-config emits ZERO unknown_top_level_key warnings for the three v2.2.0 blocks', () => {
    seed(tmp, '.orchestray/config.json', JSON.stringify({
      pm_protocol: { delegation_delta: { enabled: true }, tier2_index: { enabled: true } },
      event_schemas: { full_load_disabled: true },
      output_shape: {
        enabled: true,
        caveman_enabled: true,
        structured_outputs_enabled: true,
        length_cap_enabled: true,
        staged_flip_allowlist: ['researcher', 'tester'],
      },
    }));
    const r = runBoot(tmp);
    assert.equal(r.status, 0, 'boot must exit 0 on a clean v2.2.0 config; stderr=' + r.stderr);
    assert.doesNotMatch(
      r.stderr, /unknown top-level key "(pm_protocol|event_schemas|output_shape)"/,
      'F-001 regression: boot must NOT warn about pm_protocol/event_schemas/output_shape; ' +
      'observed stderr=\n' + r.stderr,
    );
  });

  test('the three v2.2.0 keys appear in KNOWN_TOP_LEVEL_KEYS by name', () => {
    const known = new Set(KNOWN_TOP_LEVEL_KEYS);
    assert.ok(known.has('pm_protocol'),    'KNOWN_TOP_LEVEL_KEYS missing pm_protocol');
    assert.ok(known.has('event_schemas'),  'KNOWN_TOP_LEVEL_KEYS missing event_schemas');
    assert.ok(known.has('output_shape'),   'KNOWN_TOP_LEVEL_KEYS missing output_shape');
  });
});
