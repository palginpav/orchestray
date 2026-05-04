#!/usr/bin/env node
'use strict';

/**
 * tool-registry.dup-overlay.smoke.test.js — W-TEST-2 gap coverage
 *
 * Covers the W-TEST-2 acceptance-rubric item:
 *   "verify _register dup overlay name throws"
 *
 * The pre-existing tool-registry.smoke.test.js covers core-shadow rejection
 * (T4) but does NOT test duplicate OVERLAY name registration. This file
 * verifies the registry collision contract for both the core and overlay
 * layers.
 *
 * v2.3.0 Wave 5 (W-TEST-2 fix): _register now throws on duplicate overlay
 * names (matching the fake registry's contract used in plugin-loader
 * integration tests). Without this, a second plugin's load could silently
 * overwrite a tool that a prior plugin's load had registered.
 *
 * Runner: node --test bin/_lib/__tests__/tool-registry.dup-overlay.smoke.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

function freshRegistry() {
  const p = require.resolve('../../mcp-server/lib/tool-registry');
  delete require.cache[p];
  return require('../../mcp-server/lib/tool-registry');
}

function makeEntry(name) {
  return {
    name,
    definition: { name, description: 'test ' + name, inputSchema: { type: 'object', properties: {} } },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

// ---------------------------------------------------------------------------
// W-TEST-2: _register with a core tool name throws "cannot shadow core tool"
// ---------------------------------------------------------------------------

describe('W-TEST-2 registry collision — core tool shadow throws', () => {
  test('_register throws when overlay name matches a core tool', () => {
    const reg = freshRegistry();
    reg.initCoreTools({ kb_search: makeEntry('kb_search') });
    assert.throws(
      () => reg._register(makeEntry('kb_search')),
      /cannot shadow core tool/,
      '_register must reject overlay entries that shadow core tools'
    );
  });

  test('_isCoreTool returns true for an actual core tool name', () => {
    const reg = freshRegistry();
    reg.initCoreTools({
      kb_search:    makeEntry('kb_search'),
      pattern_find: makeEntry('pattern_find'),
    });
    assert.equal(reg._isCoreTool('kb_search'),    true,  'kb_search must be core');
    assert.equal(reg._isCoreTool('pattern_find'), true,  'pattern_find must be core');
    assert.equal(reg._isCoreTool('unknown_tool'), false, 'unknown tool must not be core');
  });
});

// ---------------------------------------------------------------------------
// W-TEST-2: _register dup overlay name throws (v2.3.0 Wave 5 fix).
// ---------------------------------------------------------------------------

describe('W-TEST-2 registry collision — duplicate overlay name throws', () => {
  test('_register with a duplicate overlay name throws "already registered"', () => {
    const reg = freshRegistry();
    reg.initCoreTools({ core_tool: makeEntry('core_tool') });

    const handler1 = async () => ({ content: [{ type: 'text', text: 'v1' }] });
    reg._register({ name: 'plugin_foo', definition: makeEntry('plugin_foo').definition, handler: handler1 });
    assert.equal(reg._overlaySize(), 1, 'overlay must have 1 entry after first _register');

    const handler2 = async () => ({ content: [{ type: 'text', text: 'v2' }] });
    assert.throws(
      () => reg._register({ name: 'plugin_foo', definition: makeEntry('plugin_foo').definition, handler: handler2 }),
      /already registered/,
      '_register must reject duplicate overlay names — call _unregister first'
    );

    // The first handler must remain — second registration is rejected, not overwritten.
    const resolved = reg.resolveTool('plugin_foo');
    assert.ok(resolved, 'first-registered tool must still resolve');
    assert.strictEqual(resolved.handler, handler1,
      'first _register must remain in place; the duplicate must be rejected');

    assert.equal(reg._overlaySize(), 1, 'overlay still has 1 entry (the first, not the second)');
  });

  test('_unregister + _register supports the explicit-replacement pattern', () => {
    const reg = freshRegistry();
    reg.initCoreTools({ core_tool: makeEntry('core_tool') });

    const handler1 = async () => ({ content: [{ type: 'text', text: 'v1' }] });
    reg._register({ name: 'plugin_bar', definition: makeEntry('plugin_bar').definition, handler: handler1 });

    reg._unregister('plugin_bar');
    assert.equal(reg._overlaySize(), 0, 'overlay must be empty after _unregister');

    const handler2 = async () => ({ content: [{ type: 'text', text: 'v2' }] });
    assert.doesNotThrow(
      () => reg._register({ name: 'plugin_bar', definition: makeEntry('plugin_bar').definition, handler: handler2 }),
      'after _unregister, the same name can be re-registered'
    );

    const resolved = reg.resolveTool('plugin_bar');
    assert.strictEqual(resolved.handler, handler2,
      'after _unregister + _register, the new handler must be the active one');
  });
});
