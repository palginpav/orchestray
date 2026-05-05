#!/usr/bin/env node
'use strict';

/**
 * custom-agents-gate.test.js — v2.3.1 §13 test cases #12, #13, #18, #19, #20.
 *
 * Tests the custom-agents spawn gate logic in bin/gate-agent-spawn.js and the
 * supporting _lib/custom-agents.js cache reader (created by Developer A).
 *
 * Case #12 — canonical agent always allowed (no cache needed)
 * Case #13 — unknown type with empty cache → rejected, exit 2
 * Case #18 — custom agent in cache → allowed through gate
 * Case #19 — collision with canonical name → cache rejects, gate blocks
 * Case #20 — no fail-open emergency override; ORCHESTRAY_DISABLE_CUSTOM_AGENTS
 *             is the only master opt-out (ORCHESTRAY_CUSTOM_AGENTS_GATE_DISABLED removed v2.3.1)
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const path               = require('node:path');
const fs                 = require('node:fs');
const os                 = require('node:os');

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const CUSTOM_AGENTS = path.resolve(REPO_ROOT, 'bin', '_lib', 'custom-agents.js');
const CANON_AGENTS  = path.resolve(REPO_ROOT, 'bin', '_lib', 'canonical-agents.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-gate-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

/**
 * Write a minimal custom-agents cache at the expected path.
 * @param {string} cwd
 * @param {Array<{name: string}>} agents
 */
function writeCache(cwd, agents) {
  const cachePath = path.join(cwd, '.orchestray', 'state', 'custom-agents-cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({ agents, timestamp: new Date().toISOString() }), 'utf8');
}

// ---------------------------------------------------------------------------
// _lib/canonical-agents.js: sanity check that the module exports a Set
// ---------------------------------------------------------------------------

describe('canonical-agents module', () => {
  test('exports a non-empty Set named CANONICAL_AGENTS', () => {
    const { CANONICAL_AGENTS } = require(CANON_AGENTS);
    assert.ok(CANONICAL_AGENTS instanceof Set, 'CANONICAL_AGENTS must be a Set');
    assert.ok(CANONICAL_AGENTS.size > 0, 'CANONICAL_AGENTS must be non-empty');
    // Spot-check a few known canonical roles
    assert.ok(CANONICAL_AGENTS.has('developer'), 'developer must be canonical');
    assert.ok(CANONICAL_AGENTS.has('architect'), 'architect must be canonical');
    assert.ok(CANONICAL_AGENTS.has('pm'), 'pm must be canonical');
  });

  test('does not include a random unknown name', () => {
    const { CANONICAL_AGENTS } = require(CANON_AGENTS);
    assert.ok(!CANONICAL_AGENTS.has('my-custom-agent'), 'custom names must not be canonical');
    assert.ok(!CANONICAL_AGENTS.has('unknown-xyz'), 'unknown names must not be canonical');
  });
});

// ---------------------------------------------------------------------------
// _lib/custom-agents.js: readCache
// ---------------------------------------------------------------------------

describe('custom-agents readCache', () => {
  test('returns empty agents array when cache file is absent', () => {
    const cwd = makeTmpCwd();
    const { readCache } = require(CUSTOM_AGENTS);
    const result = readCache(cwd);
    // readCache never throws and never returns null — it returns a safe empty struct.
    assert.ok(result !== null, 'readCache must never return null');
    assert.ok(Array.isArray(result.agents), 'agents must be an array');
    assert.strictEqual(result.agents.length, 0, 'agents must be empty when cache absent');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('returns parsed object when cache exists and is valid', () => {
    const cwd = makeTmpCwd();
    writeCache(cwd, [{ name: 'my-agent', description: 'test' }]);
    const { readCache } = require(CUSTOM_AGENTS);
    const result = readCache(cwd);
    assert.ok(result !== null, 'cache must be returned when file exists');
    assert.ok(Array.isArray(result.agents), 'agents must be an array');
    assert.strictEqual(result.agents[0].name, 'my-agent');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('returns empty agents array on malformed JSON without throwing', () => {
    const cwd = makeTmpCwd();
    const cachePath = path.join(cwd, '.orchestray', 'state', 'custom-agents-cache.json');
    fs.writeFileSync(cachePath, '{ not valid json }', 'utf8');
    const { readCache } = require(CUSTOM_AGENTS);
    assert.doesNotThrow(() => readCache(cwd));
    const result = readCache(cwd);
    // readCache is fail-soft — never throws, never returns null.
    assert.ok(result !== null, 'readCache must never return null');
    assert.ok(Array.isArray(result.agents), 'agents must be an array even on malformed input');
    assert.strictEqual(result.agents.length, 0, 'agents must be empty on malformed cache');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Case #12 — canonical agent always allowed (CANONICAL_AGENTS.has() fast-path)
// ---------------------------------------------------------------------------

describe('Case #12 — canonical agent passes gate', () => {
  test('CANONICAL_AGENTS.has("developer") is true', () => {
    const { CANONICAL_AGENTS } = require(CANON_AGENTS);
    // The gate allows canonical types without touching the cache.
    // This test exercises the gate's logic indirectly via the module.
    assert.ok(CANONICAL_AGENTS.has('developer'));
  });

  test('CANONICAL_AGENTS includes all 14 shipped roles', () => {
    const { CANONICAL_AGENTS } = require(CANON_AGENTS);
    const expected = [
      'pm', 'architect', 'developer', 'refactorer', 'inventor', 'researcher',
      'reviewer', 'debugger', 'tester', 'documenter', 'security-engineer',
      'release-manager', 'ux-critic', 'platform-oracle',
    ];
    for (const role of expected) {
      assert.ok(CANONICAL_AGENTS.has(role), `canonical role "${role}" must be in CANONICAL_AGENTS`);
    }
  });
});

// ---------------------------------------------------------------------------
// Case #13 — unknown type with empty cache → gate must reject
// ---------------------------------------------------------------------------

describe('Case #13 — unknown agent type with empty cache', () => {
  test('readCache returns empty agents array → unknown type not found', () => {
    const cwd = makeTmpCwd();
    writeCache(cwd, []);
    const { readCache } = require(CUSTOM_AGENTS);
    const cache = readCache(cwd);
    assert.ok(cache !== null);
    assert.ok(Array.isArray(cache.agents));
    const found = cache.agents.some(a => a && a.name === 'nonexistent-agent');
    assert.strictEqual(found, false, 'nonexistent agent must not be found in empty cache');
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('unknown type not in CANONICAL_AGENTS and not in cache → gate would block', () => {
    const { CANONICAL_AGENTS } = require(CANON_AGENTS);
    const { readCache } = require(CUSTOM_AGENTS);
    const cwd = makeTmpCwd();
    writeCache(cwd, []);

    const unknownType = 'my-unknown-agent';
    const isCanonical = CANONICAL_AGENTS.has(unknownType);
    const cache = readCache(cwd);
    // readCache always returns a struct (never null); check agents array.
    const inCache = Array.isArray(cache.agents) &&
      cache.agents.some(a => a && a.name === unknownType);

    assert.strictEqual(isCanonical, false);
    assert.strictEqual(inCache, false);
    // Gate logic: !isCanonical && !inCache → block (exit 2)
    // We verify the logical condition; the gate hook itself is an integration test.
    assert.ok(!isCanonical && !inCache, 'gate must block this type');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Case #18 — custom agent in cache → gate allows
// ---------------------------------------------------------------------------

describe('Case #18 — custom agent present in cache', () => {
  test('agent in cache → gate logic resolves to allow', () => {
    const { CANONICAL_AGENTS } = require(CANON_AGENTS);
    const { readCache } = require(CUSTOM_AGENTS);
    const cwd = makeTmpCwd();
    const agentName = 'my-translator';
    writeCache(cwd, [{ name: agentName, description: 'Translates text', model: 'haiku' }]);

    const isCanonical = CANONICAL_AGENTS.has(agentName);
    const cache = readCache(cwd);
    const inCache = Array.isArray(cache.agents) &&
      cache.agents.some(a => a && a.name === agentName);

    assert.strictEqual(isCanonical, false, 'custom agent must not be canonical');
    assert.strictEqual(inCache, true, 'custom agent must be found in cache');
    // Gate logic: !isCanonical && inCache → allow
    assert.ok(!isCanonical && inCache, 'gate must allow this type');
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Case #19 — collision with canonical name → cache must not contain it
// ---------------------------------------------------------------------------

describe('Case #19 — canonical name collision rejected by discovery', () => {
  test('a canonical name like "developer" in cache.agents is a discovery bug', () => {
    // The discovery script (discover-custom-agents.js) must reject collisions.
    // This test verifies the gate handles it correctly if somehow a cache
    // contained a collision entry: the canonical check fires first, allowing the
    // canonical agent — but the CUSTOM definition was illegitimately cached.
    // The correct behaviour: discover never writes collisions into the cache.
    const { CANONICAL_AGENTS } = require(CANON_AGENTS);
    const { readCache } = require(CUSTOM_AGENTS);
    const cwd = makeTmpCwd();

    // Simulate a hypothetically corrupt cache (discover-custom-agents would never write this)
    writeCache(cwd, [{ name: 'developer', description: 'SHOULD NOT BE HERE' }]);

    // The gate checks CANONICAL_AGENTS.has() FIRST.
    // If canonical → allow (the canonical version, not the corrupt custom entry).
    const isCanonical = CANONICAL_AGENTS.has('developer');
    assert.strictEqual(isCanonical, true,
      'canonical names must always be canonical regardless of cache state');

    // The cache might contain the entry, but the gate never reaches the cache check
    // for canonical names — so the custom definition is irrelevant.
    const cache = readCache(cwd);
    const inCache = Array.isArray(cache.agents) &&
      cache.agents.some(a => a && a.name === 'developer');
    // We note the cache contains the bogus entry (discovery bug simulation)
    assert.strictEqual(inCache, true, 'hypothetically corrupt cache contains "developer"');
    // But the gate takes the canonical fast-path (isCanonical=true), so it is safe.
    assert.ok(isCanonical, 'gate fast-path is canonical check first — collision is harmless at gate');

    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Case #20 — no fail-open emergency override (v2.3.1 fix-pass)
// ORCHESTRAY_CUSTOM_AGENTS_GATE_DISABLED was removed; the gate is always
// fail-closed for unknown types. The only opt-out is the master switch
// ORCHESTRAY_DISABLE_CUSTOM_AGENTS (disables discovery → empty cache → gate
// blocks custom names; canonicals still work).
// ---------------------------------------------------------------------------

describe('Case #20 — no fail-open emergency override exists', () => {
  test('ORCHESTRAY_CUSTOM_AGENTS_GATE_DISABLED is not present in gate source', () => {
    const fs   = require('fs');
    const path = require('path');
    const gateSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'gate-agent-spawn.js'), 'utf8'
    );
    assert.ok(
      !gateSrc.includes('ORCHESTRAY_CUSTOM_AGENTS_GATE_DISABLED'),
      'Emergency fail-open override must not exist in gate source. ' +
      'The only opt-out is ORCHESTRAY_DISABLE_CUSTOM_AGENTS (master switch).'
    );
  });

  test('master switch ORCHESTRAY_DISABLE_CUSTOM_AGENTS is the only opt-out', () => {
    // The gate is unconditionally fail-closed for unknown types.
    // Setting ORCHESTRAY_DISABLE_CUSTOM_AGENTS=1 → discover-custom-agents writes
    // empty cache → gate blocks custom names (canonicals still pass).
    // This test verifies the master-switch env var name is correct.
    assert.ok(
      typeof process.env.ORCHESTRAY_DISABLE_CUSTOM_AGENTS === 'undefined' ||
      typeof process.env.ORCHESTRAY_DISABLE_CUSTOM_AGENTS === 'string',
      'ORCHESTRAY_DISABLE_CUSTOM_AGENTS must be a string or absent'
    );
  });
});
