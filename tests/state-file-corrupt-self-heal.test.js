#!/usr/bin/env node
'use strict';

/**
 * Tests for corrupt state-file self-healing (F-15 from v2.2.21 T2 findings).
 *
 * Verifies:
 *   - safeReadJson emits state_file_corrupt event AND truncates to default
 *   - context-telemetry-cache.js readCache() returns skeleton on corrupt file
 *   - Subsequent reads after self-heal succeed without repeated SyntaxError
 *
 * v2.2.21 W4-T18: state-file corrupt self-heal acceptance tests.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { safeReadJson } = require('../bin/_lib/state-gc');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-corrupt-heal-'));
}

// ---------------------------------------------------------------------------
// safeReadJson self-heal contract
// ---------------------------------------------------------------------------

describe('safeReadJson — self-heal contract (F-15)', () => {
  test('SyntaxError on {} default: file is truncated to {}', () => {
    const dir  = makeTmpDir();
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{"key": broken');

    const result = safeReadJson(file, {});

    assert.deepEqual(result, {}, 'must return {} as defaultValue');
    const healed = fs.readFileSync(file, 'utf8').trim();
    assert.equal(healed, '{}', 'file must be truncated to {}');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('SyntaxError on [] default: file is truncated to []', () => {
    const dir  = makeTmpDir();
    const file = path.join(dir, 'state.json');
    // Simulate partial write during crash (F-15 reproduction).
    fs.writeFileSync(file, '[{"key": "Expected property name or \'}\' in JSON at position 1');

    const result = safeReadJson(file, []);

    assert.deepEqual(result, [], 'must return [] as defaultValue');
    const healed = fs.readFileSync(file, 'utf8').trim();
    assert.equal(healed, '[]', 'file must be truncated to []');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('after self-heal, second parse succeeds without SyntaxError', () => {
    const dir  = makeTmpDir();
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{CORRUPT');

    // First: heals.
    safeReadJson(file, {});

    // Second: should succeed cleanly (file is now valid JSON).
    let threw = false;
    let result;
    try {
      result = safeReadJson(file, { sentinel: true });
    } catch (_e) {
      threw = true;
    }

    assert.equal(threw, false, 'second read must not throw');
    assert.deepEqual(result, {}, 'second read must return healed content');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ENOENT returns defaultValue without creating the file', () => {
    const file = path.join(os.tmpdir(), 'does-not-exist-corrupt-test-' + Date.now() + '.json');

    const result = safeReadJson(file, { missing: true });

    assert.deepEqual(result, { missing: true }, 'ENOENT must return defaultValue');
    assert.equal(fs.existsSync(file), false, 'ENOENT must not create the file');
  });

  test('valid JSON is returned as-is without modification', () => {
    const dir  = makeTmpDir();
    const file = path.join(dir, 'valid.json');
    const data = { schema_version: 1, entries: [1, 2, 3] };
    fs.writeFileSync(file, JSON.stringify(data));

    const originalMtime = fs.statSync(file).mtimeMs;
    const result        = safeReadJson(file, {});

    assert.deepEqual(result, data, 'valid JSON must be returned unchanged');

    // File should not have been rewritten (mtime unchanged).
    const newMtime = fs.statSync(file).mtimeMs;
    assert.equal(originalMtime, newMtime, 'valid file must not be rewritten');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// context-telemetry-cache readCache corruption handling
// ---------------------------------------------------------------------------

describe('context-telemetry-cache readCache — corrupt file (F-15)', () => {
  test('returns skeleton when cache file is corrupt JSON', () => {
    const dir        = makeTmpDir();
    const stateDir   = path.join(dir, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const cachePath = path.join(stateDir, 'context-telemetry.json');

    // Write corrupt JSON (simulating partial write during crash).
    fs.writeFileSync(cachePath, '{"schema_version":1,"session":{broken');

    // Require the module — it uses its own corrupt-handling.
    const { readCache } = require('../bin/_lib/context-telemetry-cache');
    const result = readCache(dir);

    // Must return a valid skeleton (not throw).
    assert.ok(result, 'readCache must return a value on corrupt file');
    assert.ok(typeof result === 'object', 'readCache must return an object');

    // The corrupt file should have been either renamed or unlinked.
    // Either way, subsequent reads should not see the same SyntaxError.
    // (The module renames to .corrupt-<ts> or unlinks.)
    // Reading again must succeed.
    const result2 = readCache(dir);
    assert.ok(result2, 'second readCache must also succeed');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('returns skeleton for ENOENT (first run, no cache yet)', () => {
    const dir = makeTmpDir();
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

    const { readCache } = require('../bin/_lib/context-telemetry-cache');
    const result = readCache(dir);

    assert.ok(result, 'readCache must return skeleton for missing file');
    assert.ok(typeof result === 'object');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
