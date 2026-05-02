#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for plugin-manifest-schema.js
 *
 * Covers: W-SEC-3 (reserved names/prefixes), W-SEC-10 (proto scrub), W-SEC-11 (unicode)
 *
 * Runner: node --test bin/_lib/__tests__/plugin-manifest-schema.smoke.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseManifest,
  scrubPrototype,
} = require('../plugin-manifest-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid minimal manifest, overriding any fields. */
function validManifest(overrides = {}) {
  return Object.assign({
    schema_version: 1,
    name: 'my-plugin',
    version: '1.0.0',
    description: 'A test plugin',
    entrypoint: 'index.js',
    transport: 'stdio',
    runtime: 'any',
    tools: [
      { name: 'do-thing', description: 'Does a thing', inputSchema: {} },
    ],
  }, overrides);
}

/** Assert parseManifest throws (ZodError or otherwise). */
function assertFails(input, msgHint) {
  assert.throws(
    () => parseManifest(input),
    (err) => {
      assert.ok(err, `expected error for: ${msgHint}`);
      return true;
    },
    msgHint
  );
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

test('valid minimal manifest passes', () => {
  const result = parseManifest(validManifest());
  assert.equal(result.name, 'my-plugin');
  assert.equal(result.schema_version, 1);
  assert.equal(result.tools.length, 1);
});

// ---------------------------------------------------------------------------
// 2. W-SEC-3 / format negatives
// ---------------------------------------------------------------------------

test('name with uppercase letters fails kebab-case regex', () => {
  assertFails(validManifest({ name: 'Foo' }), 'uppercase name should fail');
});

test('name with reserved prefix "plugin_" fails', () => {
  assertFails(validManifest({ name: 'plugin_evil' }), 'reserved-prefix plugin_ should fail');
});

test('exact reserved name "orchestray" fails', () => {
  assertFails(validManifest({ name: 'orchestray' }), 'reserved name orchestray should fail');
});

// ---------------------------------------------------------------------------
// 3. W-SEC-11: unicode attack
// ---------------------------------------------------------------------------

test('name containing RTL override (bidi) codepoint fails', () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE injected into name
  const evilName = 'evil‮name';
  assertFails(validManifest({ name: evilName }), 'bidi codepoint in name should fail');
});

// ---------------------------------------------------------------------------
// 4. Semver / path / transport / tools negatives
// ---------------------------------------------------------------------------

test('non-semver version string fails', () => {
  assertFails(validManifest({ version: 'not-semver' }), 'bad version should fail');
});

test('absolute entrypoint path fails', () => {
  assertFails(validManifest({ entrypoint: '/etc/passwd' }), 'absolute entrypoint should fail');
});

test('parent-traversal entrypoint fails', () => {
  assertFails(validManifest({ entrypoint: '../../etc/passwd' }), 'traversal entrypoint should fail');
});

test('unsupported transport "unix-socket" fails', () => {
  assertFails(validManifest({ transport: 'unix-socket' }), 'unix-socket transport should fail');
});

test('empty tools array fails (min 1)', () => {
  assertFails(validManifest({ tools: [] }), 'empty tools should fail');
});

// ---------------------------------------------------------------------------
// 5. W-SEC-9: strict mode — unknown top-level key fails
// ---------------------------------------------------------------------------

test('unknown top-level key fails (strict mode)', () => {
  const input = validManifest();
  input.evil_field = 'surprise';
  assertFails(input, 'unknown top-level key should fail in strict mode');
});

// ---------------------------------------------------------------------------
// 6. W-SEC-10: scrubPrototype removes __proto__ key
// ---------------------------------------------------------------------------

test('__proto__ key is stripped by scrubPrototype before parse', () => {
  // Simulate what JSON.parse produces for {"__proto__": {"isAdmin": true}}
  // (JSON.parse does NOT set the real __proto__; it creates a key named "__proto__")
  const raw = JSON.parse('{"schema_version":1,"name":"ok-plugin","version":"1.0.0",' +
    '"description":"test","entrypoint":"index.js","transport":"stdio","runtime":"any",' +
    '"tools":[{"name":"do-thing","description":"Does thing","inputSchema":{}}],' +
    '"__proto__":{"isAdmin":true}}');

  const scrubbed = scrubPrototype(raw);
  assert.ok(!Object.prototype.hasOwnProperty.call(scrubbed, '__proto__'),
    '__proto__ key must be stripped');
  // parseManifest uses scrubPrototype internally; strict() mode means __proto__ key
  // would also cause a zod rejection if NOT stripped — but the scrub removes it first
  const result = parseManifest(raw);
  assert.equal(result.name, 'ok-plugin');
});

// ---------------------------------------------------------------------------
// Wave 1 closeout: W-SEC-11 unicode coverage gaps (reviewer finding #3)
// ---------------------------------------------------------------------------
// G3 W-SEC-11 mandate is bidi/zero-width unicode rejection in BOTH name AND
// description (manifest-level + per-tool). Original tests covered only the
// plugin name. These add coverage for description, tool name, and tool
// description.

test('description containing zero-width space (U+200B) fails', () => {
  const input = validManifest();
  // U+200B = zero-width space
  input.description = 'inno​cuous-looking text';
  assertFails(input, 'description with U+200B must be rejected');
});

test('description containing RTL override (U+202E) fails', () => {
  const input = validManifest();
  input.description = 'forecast‮';
  assertFails(input, 'description with U+202E must be rejected');
});

test('tools[0].name with zero-width non-joiner (U+200C) fails', () => {
  const input = validManifest();
  input.tools[0].name = 'do‌thing';
  assertFails(input, 'tool name with U+200C must be rejected');
});

test('tools[0].description with bidi U+202B fails', () => {
  const input = validManifest();
  input.tools[0].description = 'description with ‫ embedded';
  assertFails(input, 'tool description with U+202B must be rejected');
});
