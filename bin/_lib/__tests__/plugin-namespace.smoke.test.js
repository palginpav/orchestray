#!/usr/bin/env node
'use strict';

/**
 * Smoke tests for plugin-namespace.js (W-NS-1 / v2.3.0).
 *
 * Covers all 13 acceptance-rubric cases:
 *   1–4   buildNamespacedName (happy path + two invalid-input throws)
 *   5–9   parseNamespacedName (happy path + null cases)
 *   10–11 isPluginToolName
 *   12–13 assertNoCoreCollision
 *
 * Runner: node --test bin/_lib/__tests__/plugin-namespace.smoke.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  NAMESPACE_PREFIX,
  SEPARATOR,
  buildNamespacedName,
  parseNamespacedName,
  isPluginToolName,
  assertNoCoreCollision,
} = require('../plugin-namespace.js');

// ---------------------------------------------------------------------------
// buildNamespacedName
// ---------------------------------------------------------------------------

describe('buildNamespacedName', () => {
  // Test 1
  test('simple plugin + tool produces correct broker-emitted name', () => {
    assert.equal(buildNamespacedName('weather', 'forecast'), 'plugin_weather_forecast');
  });

  // Test 2
  test('kebab-case plugin and tool names are preserved verbatim', () => {
    assert.equal(
      buildNamespacedName('kb-extras', 'summarize-pdf'),
      'plugin_kb-extras_summarize-pdf'
    );
  });

  // Test 3
  test('throws TypeError for plugin name with uppercase letter', () => {
    assert.throws(
      () => buildNamespacedName('Weather', 'forecast'),
      (err) => err instanceof TypeError && /pluginName/.test(err.message)
    );
  });

  // Test 4
  test('throws TypeError for tool name with illegal character', () => {
    assert.throws(
      () => buildNamespacedName('weather', 'forecast!'),
      (err) => err instanceof TypeError && /toolName/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// parseNamespacedName
// ---------------------------------------------------------------------------

describe('parseNamespacedName', () => {
  // Test 5
  test('parses simple plugin_name_tool back to parts', () => {
    assert.deepEqual(
      parseNamespacedName('plugin_weather_forecast'),
      { pluginName: 'weather', toolName: 'forecast' }
    );
  });

  // Test 6
  test('parses kebab-case plugin and tool names correctly', () => {
    assert.deepEqual(
      parseNamespacedName('plugin_kb-extras_summarize-pdf'),
      { pluginName: 'kb-extras', toolName: 'summarize-pdf' }
    );
  });

  // Test 7
  test('returns null for a core tool name not in plugin namespace', () => {
    assert.equal(parseNamespacedName('kb_search'), null);
  });

  // Test 8
  test('returns null when there is no separator after the prefix (no tool-name)', () => {
    assert.equal(parseNamespacedName('plugin_only-prefix'), null);
  });

  // Test 9
  test('returns null when plugin-name is empty (double underscore after prefix)', () => {
    assert.equal(parseNamespacedName('plugin__double-sep'), null);
  });
});

// ---------------------------------------------------------------------------
// isPluginToolName
// ---------------------------------------------------------------------------

describe('isPluginToolName', () => {
  // Test 10
  test('returns true for a valid plugin-namespaced name', () => {
    assert.equal(isPluginToolName('plugin_weather_forecast'), true);
  });

  // Test 11
  test('returns false for a core tool name', () => {
    assert.equal(isPluginToolName('kb_search'), false);
  });
});

// ---------------------------------------------------------------------------
// assertNoCoreCollision
// ---------------------------------------------------------------------------

describe('assertNoCoreCollision', () => {
  // Test 12
  test('does not throw when plugin tool name is absent from core list', () => {
    assert.doesNotThrow(() => {
      assertNoCoreCollision(
        'plugin_weather_forecast',
        new Set(['kb_search', 'pattern_find'])
      );
    });
  });

  // Test 13
  test('throws TypeError when name is found in core tools list', () => {
    assert.throws(
      () => assertNoCoreCollision('kb_search', new Set(['kb_search', 'pattern_find'])),
      (err) => err instanceof TypeError && /kb_search/.test(err.message)
    );
  });
});

// ---------------------------------------------------------------------------
// Constants are exported
// ---------------------------------------------------------------------------

describe('module constants', () => {
  test('NAMESPACE_PREFIX equals "plugin_"', () => {
    assert.equal(NAMESPACE_PREFIX, 'plugin_');
  });

  test('SEPARATOR equals "_"', () => {
    assert.equal(SEPARATOR, '_');
  });
});
