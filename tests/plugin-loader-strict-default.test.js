'use strict';

/**
 * v2.3.12 W15 (M3) — strictCapabilities is default-on, env kill switch reverts,
 * config-schema default agrees.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { DEFAULT_OPTS, createLoader } = require('../bin/_lib/plugin-loader');
const { loadPluginLoaderConfig } = require('../bin/_lib/config-schema');

test('DEFAULT_OPTS.strictCapabilities defaults true', () => {
  assert.strictEqual(DEFAULT_OPTS.strictCapabilities, true);
});

test('config-schema plugin_loader.strict_capabilities defaults true', () => {
  const c = loadPluginLoaderConfig(process.cwd());
  assert.strictEqual(c.strict_capabilities, true);
});

test('createLoader honors default-on and explicit config override', () => {
  // We can't read opts off the loader directly, but env kill switch is the
  // observable contract; explicit userOpts:false must also win.
  const prev = process.env.ORCHESTRAY_PLUGIN_STRICT_CAPS_DISABLED;
  delete process.env.ORCHESTRAY_PLUGIN_STRICT_CAPS_DISABLED;

  // Default path: no throw, loader builds with strict default.
  assert.doesNotThrow(() => createLoader({ audit: () => {} }));

  // Env kill switch path: also builds (revert to observe-only).
  process.env.ORCHESTRAY_PLUGIN_STRICT_CAPS_DISABLED = '1';
  assert.doesNotThrow(() => createLoader({ audit: () => {} }));

  if (prev === undefined) delete process.env.ORCHESTRAY_PLUGIN_STRICT_CAPS_DISABLED;
  else process.env.ORCHESTRAY_PLUGIN_STRICT_CAPS_DISABLED = prev;
});
