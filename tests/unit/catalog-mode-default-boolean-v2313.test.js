'use strict';

// v2.3.13 F-MC-05 regression: loadCatalogModeDefaultConfig must honor the
// canonical top-level boolean form (the form used by the zod schema,
// config.json, and pm.md's documented `"catalog_mode_default": false` kill
// switch). Before the fix, a top-level boolean spread to zero keys and the
// loader always returned the default, so the documented kill switch was inert.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadCatalogModeDefaultConfig } = require('../../bin/_lib/config-schema');

function withConfig(value, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-catalog-'));
  try {
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    const cfg = value === undefined ? {} : { catalog_mode_default: value };
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(cfg),
    );
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('top-level boolean true → catalog_default true', () => {
  withConfig(true, (dir) => {
    assert.strictEqual(loadCatalogModeDefaultConfig(dir).catalog_default, true);
  });
});

test('top-level boolean false → catalog_default false (kill switch now works)', () => {
  withConfig(false, (dir) => {
    assert.strictEqual(loadCatalogModeDefaultConfig(dir).catalog_default, false);
  });
});

test('legacy nested object form still honored (back-compat)', () => {
  withConfig({ catalog_default: false }, (dir) => {
    assert.strictEqual(loadCatalogModeDefaultConfig(dir).catalog_default, false);
  });
});

test('missing key → default true (fail-open)', () => {
  withConfig(undefined, (dir) => {
    assert.strictEqual(loadCatalogModeDefaultConfig(dir).catalog_default, true);
  });
});

test('env kill switch overrides config', () => {
  const prev = process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
  process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = '1';
  try {
    withConfig(true, (dir) => {
      assert.strictEqual(loadCatalogModeDefaultConfig(dir).catalog_default, false);
    });
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    else process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = prev;
  }
});
