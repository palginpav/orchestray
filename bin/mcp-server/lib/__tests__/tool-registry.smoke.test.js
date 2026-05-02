#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for bin/mcp-server/lib/tool-registry.js
 *
 * W-REG-1 verification: 4 tests cover the core contract.
 *
 * T1 — initCoreTools populates the registry; listTools returns matching names.
 * T2 — resolveTool returns the correct entry for a known core tool.
 * T3 — Overlay tools appear in listTools after _register; disappear after _unregister.
 * T4 — Core tool names cannot be shadowed by _register.
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh isolated registry instance for each test so state cannot
 * leak between tests. We achieve isolation by deleting the module from
 * require.cache before each require().
 */
function freshRegistry() {
  const registryPath = require.resolve('../tool-registry.js');
  delete require.cache[registryPath];
  return require('../tool-registry.js');
}

function makeEntry(name) {
  return {
    definition: {
      name,
      description: 'Test tool ' + name,
      inputSchema: { type: 'object', properties: {} },
    },
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
  };
}

function makeTable(...names) {
  const table = {};
  for (const n of names) table[n] = makeEntry(n);
  return table;
}

// ---------------------------------------------------------------------------
// T1 — initCoreTools populates; listTools returns all names
// ---------------------------------------------------------------------------

describe('T1 — initCoreTools → listTools', () => {
  test('listTools returns all core tool definitions after initCoreTools', () => {
    const reg = freshRegistry();
    const table = makeTable('tool_a', 'tool_b', 'tool_c');
    reg.initCoreTools(table);

    const listed = reg.listTools();
    assert.equal(listed.length, 3, 'listTools must return 3 entries');
    const names = listed.map((d) => d.name).sort();
    assert.deepEqual(names, ['tool_a', 'tool_b', 'tool_c']);

    // Shape: each entry must have name, description, inputSchema
    for (const d of listed) {
      assert.ok(typeof d.name === 'string', 'definition.name must be a string');
      assert.ok(typeof d.description === 'string', 'definition.description must be a string');
      assert.ok(d.inputSchema && typeof d.inputSchema === 'object', 'definition.inputSchema must be an object');
    }
  });

  test('initCoreTools called twice throws', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('tool_a'));
    assert.throws(() => reg.initCoreTools(makeTable('tool_b')), /called more than once/);
  });
});

// ---------------------------------------------------------------------------
// T2 — resolveTool returns the correct entry
// ---------------------------------------------------------------------------

describe('T2 — resolveTool', () => {
  test('resolveTool returns the entry for a known core tool', () => {
    const reg = freshRegistry();
    const table = makeTable('kb_search', 'pattern_find');
    reg.initCoreTools(table);

    const entry = reg.resolveTool('kb_search');
    assert.ok(entry, 'resolveTool must return an entry for a core tool');
    assert.ok(typeof entry.handler === 'function', 'entry.handler must be a function');
    assert.equal(entry.definition.name, 'kb_search');
  });

  test('resolveTool returns undefined for an unknown tool', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('kb_search'));

    const entry = reg.resolveTool('nonexistent_tool');
    assert.equal(entry, undefined, 'resolveTool must return undefined for unknown tool');
  });
});

// ---------------------------------------------------------------------------
// T3 — Overlay: _register / _unregister
// ---------------------------------------------------------------------------

describe('T3 — overlay _register and _unregister', () => {
  test('overlay tool appears in listTools and resolves after _register', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_tool'));

    const overlayEntry = makeEntry('plugin_tool');
    reg._register({ name: 'plugin_tool', ...overlayEntry });

    const listed = reg.listTools();
    const names = listed.map((d) => d.name);
    assert.ok(names.includes('plugin_tool'), 'overlay tool must appear in listTools');
    assert.equal(reg._overlaySize(), 1);

    const resolved = reg.resolveTool('plugin_tool');
    assert.ok(resolved, 'overlay tool must resolve');
    assert.equal(resolved.definition.name, 'plugin_tool');
  });

  test('overlay tool disappears from listTools after _unregister', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_tool'));

    const overlayEntry = makeEntry('plugin_tool');
    reg._register({ name: 'plugin_tool', ...overlayEntry });
    assert.equal(reg._overlaySize(), 1);

    reg._unregister('plugin_tool');
    assert.equal(reg._overlaySize(), 0);

    const listed = reg.listTools();
    const names = listed.map((d) => d.name);
    assert.ok(!names.includes('plugin_tool'), 'unregistered overlay tool must not appear in listTools');

    const resolved = reg.resolveTool('plugin_tool');
    assert.equal(resolved, undefined, 'unregistered overlay tool must not resolve');
  });

  test('core tools appear before overlay tools in listTools', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_tool'));
    reg._register({ name: 'plugin_tool', ...makeEntry('plugin_tool') });

    const listed = reg.listTools();
    assert.equal(listed[0].name, 'core_tool', 'core tools must come first');
    assert.equal(listed[1].name, 'plugin_tool', 'overlay tools must come after core');
  });
});

// ---------------------------------------------------------------------------
// T4 — Core shadowing is forbidden
// ---------------------------------------------------------------------------

describe('T4 — core tool shadowing prevention', () => {
  test('_register throws when overlay name matches a core tool', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('kb_search'));

    assert.throws(
      () => reg._register({ name: 'kb_search', ...makeEntry('kb_search') }),
      /cannot shadow core tool/,
      '_register must reject overlay entries that shadow core tools'
    );
  });

  test('_isCoreTool returns true for core names and false for overlay names', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_tool'));
    reg._register({ name: 'plugin_tool', ...makeEntry('plugin_tool') });

    assert.equal(reg._isCoreTool('core_tool'), true);
    assert.equal(reg._isCoreTool('plugin_tool'), false);
    assert.equal(reg._isCoreTool('unknown'), false);
  });
});
