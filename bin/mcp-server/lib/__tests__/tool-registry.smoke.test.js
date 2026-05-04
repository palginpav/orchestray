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
 *
 * W-LISTCH-3/W-SEC-24 + W-DEG-1/W-SEC-25 verification: 6 new tests.
 *
 * T5 — listTools under cap: full result returned with no truncation.
 * T6 — listTools over cap: overlay entries dropped from end; audit event emitted.
 * T7 — listTools cap respects core: even a tiny cap never drops core tools.
 * T8 — Degraded prefix: accessor returns 'degraded' → description prefixed.
 * T9 — Dead plugin tools dropped: accessor returns 'dead' → tool not in response.
 * T10 — Default accessor: no opts → all entries treated as 'ready' (no prefix, no drop).
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

// ---------------------------------------------------------------------------
// T5 — listTools under cap: full result returned (W-LISTCH-3, W-SEC-24)
// ---------------------------------------------------------------------------

describe('T5 — listTools under cap returns full result', () => {
  test('when serialised response is under maxBytes, all entries returned unchanged', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_a', 'core_b'));
    reg._register({ name: 'plugin_x', plugin_name: 'plugin_x', ...makeEntry('plugin_x') });

    const auditEvents = [];
    const listed = reg.listTools({
      maxBytes: 1048576, // 1 MiB — easily large enough
      audit: (ev) => auditEvents.push(ev),
    });

    assert.equal(listed.length, 3, 'all 3 entries must be present');
    assert.equal(auditEvents.length, 0, 'no audit event emitted when under cap');
  });
});

// ---------------------------------------------------------------------------
// T6 — listTools over cap: overlay truncated from end; audit event emitted
//      (W-LISTCH-3, W-SEC-24)
// ---------------------------------------------------------------------------

describe('T6 — listTools over cap truncates overlay and emits audit event', () => {
  test('overlay entries dropped from end; plugin_tools_truncated event emitted', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_tool'));
    // Register two overlay tools from the same plugin.
    reg._register({ name: 'plugin_t6_a', plugin_name: 'plugin_t6', ...makeEntry('plugin_t6_a') });
    reg._register({ name: 'plugin_t6_b', plugin_name: 'plugin_t6', ...makeEntry('plugin_t6_b') });

    const auditEvents = [];
    // Force truncation: cap is tiny — only the core tool JSON can fit,
    // but not the overlay tools. We use 100 bytes which is far below the
    // full 3-entry serialisation but above the 1-core-entry serialisation.
    const listedFull = reg.listTools({ maxBytes: null }); // baseline: 3 entries
    const fullSize = JSON.stringify(listedFull).length;
    // Cap below full size but above just core.
    const coreOnly = reg.listTools({ maxBytes: null }).slice(0, 1);
    const coreSize = JSON.stringify(coreOnly).length;
    const cap = Math.floor((coreSize + fullSize) / 2); // between core-only and full

    const listed = reg.listTools({
      maxBytes: cap,
      audit: (ev) => auditEvents.push(ev),
    });

    // Core tool must always be present.
    assert.ok(listed.some((d) => d.name === 'core_tool'), 'core tool must survive truncation');
    // At least one overlay entry must have been dropped.
    const overlayPresent = listed.filter((d) => d.name.startsWith('plugin_t6'));
    assert.ok(overlayPresent.length < 2, 'at least one overlay entry must be truncated');

    // Exactly one audit event emitted.
    assert.equal(auditEvents.length, 1, 'exactly one audit event must be emitted');
    const ev = auditEvents[0];
    assert.equal(ev.type, 'plugin_tools_truncated');
    assert.ok(ev.removed_count > 0, 'removed_count must be positive');
    assert.equal(ev.max_bytes, cap);
  });
});

// ---------------------------------------------------------------------------
// T7 — listTools cap respects core: tiny cap never drops core tools (W-LISTCH-3)
// ---------------------------------------------------------------------------

describe('T7 — listTools tiny cap preserves core tools', () => {
  test('core tools are never dropped regardless of maxBytes value', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_t7_a', 'core_t7_b', 'core_t7_c'));
    reg._register({ name: 'plugin_t7', plugin_name: 'p_t7', ...makeEntry('plugin_t7') });

    const auditEvents = [];
    // Use a cap of 10 bytes — impossibly small for any real result.
    const listed = reg.listTools({
      maxBytes: 10,
      audit: (ev) => auditEvents.push(ev),
    });

    // All core tools must be present.
    assert.ok(listed.some((d) => d.name === 'core_t7_a'), 'core_t7_a must survive');
    assert.ok(listed.some((d) => d.name === 'core_t7_b'), 'core_t7_b must survive');
    assert.ok(listed.some((d) => d.name === 'core_t7_c'), 'core_t7_c must survive');
    // Overlay tool must have been dropped.
    assert.ok(!listed.some((d) => d.name === 'plugin_t7'), 'overlay tool must be dropped');
    // Audit event must have been emitted.
    assert.equal(auditEvents.length, 1, 'audit event must be emitted');
    assert.equal(auditEvents[0].removed_count, 1);
  });
});

// ---------------------------------------------------------------------------
// T8 — Degraded prefix applied (W-DEG-1, W-SEC-25)
// ---------------------------------------------------------------------------

describe('T8 — degraded plugin tools get [DEGRADED] prefix', () => {
  test('pluginStateAccessor returns degraded → description prefixed with [DEGRADED]', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_t8'));
    reg._register({
      name: 'plugin_t8',
      plugin_name: 'my_plugin',
      ...makeEntry('plugin_t8'),
    });

    const listed = reg.listTools({
      pluginStateAccessor: (pname) => pname === 'my_plugin' ? 'degraded' : 'ready',
    });

    const pluginDef = listed.find((d) => d.name === 'plugin_t8');
    assert.ok(pluginDef, 'degraded tool must still appear in the list');
    assert.ok(
      pluginDef.description.startsWith('[DEGRADED] '),
      'description must start with [DEGRADED] — got: ' + pluginDef.description
    );

    // Core tool must be unaffected.
    const coreDef = listed.find((d) => d.name === 'core_t8');
    assert.ok(coreDef, 'core tool must still appear');
    assert.ok(!coreDef.description.startsWith('[DEGRADED]'), 'core tool must not be prefixed');
  });

  test('original stored definition is not mutated by the degraded prefix', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_t8b'));
    reg._register({
      name: 'plugin_t8b',
      plugin_name: 'my_plugin_b',
      definition: {
        name: 'plugin_t8b',
        description: 'Original description',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => ({ content: [], isError: false }),
    });

    // Call with degraded accessor.
    reg.listTools({ pluginStateAccessor: () => 'degraded' });

    // Resolve the entry — stored definition must be unchanged.
    const resolved = reg.resolveTool('plugin_t8b');
    assert.equal(
      resolved.definition.description,
      'Original description',
      'stored definition must not be mutated'
    );
  });
});

// ---------------------------------------------------------------------------
// T9 — Dead plugin tools dropped (W-DEG-1, W-SEC-25)
// ---------------------------------------------------------------------------

describe('T9 — dead and unloaded plugin tools are omitted', () => {
  test('accessor returns dead → tool not in response', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_t9'));
    reg._register({ name: 'plugin_t9_dead', plugin_name: 'dead_plugin', ...makeEntry('plugin_t9_dead') });
    reg._register({ name: 'plugin_t9_alive', plugin_name: 'alive_plugin', ...makeEntry('plugin_t9_alive') });

    const listed = reg.listTools({
      pluginStateAccessor: (pname) => pname === 'dead_plugin' ? 'dead' : 'ready',
    });

    assert.ok(!listed.some((d) => d.name === 'plugin_t9_dead'), 'dead tool must not appear');
    assert.ok(listed.some((d) => d.name === 'plugin_t9_alive'), 'alive tool must appear');
    assert.ok(listed.some((d) => d.name === 'core_t9'), 'core tool must appear');
  });

  test('accessor returns unloaded → tool not in response', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_t9b'));
    reg._register({ name: 'plugin_t9_unloaded', plugin_name: 'unloaded_plugin', ...makeEntry('plugin_t9_unloaded') });

    const listed = reg.listTools({
      pluginStateAccessor: () => 'unloaded',
    });

    assert.ok(!listed.some((d) => d.name === 'plugin_t9_unloaded'), 'unloaded tool must not appear');
    assert.ok(listed.some((d) => d.name === 'core_t9b'), 'core tool must appear');
  });
});

// ---------------------------------------------------------------------------
// T10 — Default accessor: no opts → all entries treated as ready (W-DEG-1)
// ---------------------------------------------------------------------------

describe('T10 — default accessor treats all entries as ready', () => {
  test('listTools() with no opts returns all entries without prefix or omission', () => {
    const reg = freshRegistry();
    reg.initCoreTools(makeTable('core_t10'));
    reg._register({ name: 'plugin_t10', plugin_name: 'some_plugin', ...makeEntry('plugin_t10') });

    // Call without any opts — backward-compatible with pre-Wave-4 callers.
    const listed = reg.listTools();

    assert.equal(listed.length, 2, 'both core and overlay must be returned');
    const pluginDef = listed.find((d) => d.name === 'plugin_t10');
    assert.ok(pluginDef, 'overlay tool must be present');
    assert.ok(
      !pluginDef.description.startsWith('[DEGRADED]'),
      'no DEGRADED prefix when no opts provided'
    );
  });

  test('listTools() with no opts does not emit audit events even with many tools', () => {
    const reg = freshRegistry();
    // Build a table with many tools but no audit callback — must not throw.
    const table = makeTable('core_t10b_1', 'core_t10b_2', 'core_t10b_3');
    reg.initCoreTools(table);
    for (let i = 0; i < 5; i++) {
      reg._register({ name: 'plugin_t10b_' + i, ...makeEntry('plugin_t10b_' + i) });
    }

    // Must not throw and must return all entries (default cap is 1 MiB — easily fits).
    const listed = reg.listTools();
    assert.equal(listed.length, 8, 'all 8 entries must be returned');
  });
});
