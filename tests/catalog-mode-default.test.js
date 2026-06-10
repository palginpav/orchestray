'use strict';

/**
 * Regression tests for C2-01: ORCHESTRAY_DISABLE_CATALOG_DEFAULT kill switch.
 *
 * Verifies that:
 * 1. When no explicit mode is given, pattern_find defaults to catalog mode
 *    (R-CAT-DEFAULT behavior).
 * 2. ORCHESTRAY_DISABLE_CATALOG_DEFAULT=1 flips the default to full mode.
 * 3. config catalog_mode_default.catalog_default=false also flips to full.
 * 4. Explicit input.mode always overrides the config/env default.
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle } = require('../bin/mcp-server/tools/pattern_find.js');

// Disable shared-tier federation for all tests.
let _prevSharedDir;
before(() => {
  _prevSharedDir = process.env.ORCHESTRAY_TEST_SHARED_DIR;
  process.env.ORCHESTRAY_TEST_SHARED_DIR = path.join(
    os.tmpdir(), 'orchestray-catmode-no-shared-' + process.pid
  );
});
after(() => {
  if (_prevSharedDir === undefined) delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
  else process.env.ORCHESTRAY_TEST_SHARED_DIR = _prevSharedDir;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject(configObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-catmode-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  if (configObj !== undefined) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(configObj)
    );
  }
  // Write one minimal pattern so pattern_find has something to return.
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'patterns', 'test-pattern.md'),
    [
      '---',
      'name: test-pattern',
      'one_line: A test pattern for catalog mode regression',
      'description: Used only in catalog-mode tests.',
      'confidence: 0.9',
      'tags: [test]',
      'categories: [routing]',
      'times_applied: 1',
      '---',
      '# Test Pattern',
      'Body text.',
    ].join('\n')
  );
  return dir;
}

function makeContext(dir) {
  return { projectRoot: dir };
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tests for loadCatalogModeDefaultConfig (unit level)
// ---------------------------------------------------------------------------

describe('loadCatalogModeDefaultConfig', () => {
  const { loadCatalogModeDefaultConfig } = require('../bin/_lib/config-schema');

  let savedEnv;
  beforeEach(() => { savedEnv = process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    else process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = savedEnv;
  });

  test('default (no config, no env) → catalog_default=true', () => {
    delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-cmd-'));
    try {
      const result = loadCatalogModeDefaultConfig(dir);
      assert.equal(result.catalog_default, true);
    } finally {
      cleanup(dir);
    }
  });

  test('ORCHESTRAY_DISABLE_CATALOG_DEFAULT=1 → catalog_default=false', () => {
    process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-cmd-'));
    try {
      const result = loadCatalogModeDefaultConfig(dir);
      assert.equal(result.catalog_default, false);
    } finally {
      cleanup(dir);
    }
  });

  test('config catalog_mode_default.catalog_default=false → catalog_default=false', () => {
    delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-cmd-'));
    try {
      fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'config.json'),
        JSON.stringify({ catalog_mode_default: { catalog_default: false } })
      );
      const result = loadCatalogModeDefaultConfig(dir);
      assert.equal(result.catalog_default, false);
    } finally {
      cleanup(dir);
    }
  });

  test('env var takes precedence over config file', () => {
    // Config says true, env says disable → env wins → false
    process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-cmd-'));
    try {
      fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'config.json'),
        JSON.stringify({ catalog_mode_default: { catalog_default: true } })
      );
      const result = loadCatalogModeDefaultConfig(dir);
      assert.equal(result.catalog_default, false);
    } finally {
      cleanup(dir);
    }
  });

  test('malformed config.json → fail-open to true', () => {
    delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-cmd-'));
    try {
      fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), 'not valid json');
      const result = loadCatalogModeDefaultConfig(dir);
      assert.equal(result.catalog_default, true);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration tests: pattern_find mode selection via handle()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Integration tests: pattern_find mode selection
//
// PM design ruling (v2.3.x): R-CAT T3 backward-compat contract wins.
//   (a) omitted mode → full shape (tool-level default is 'full')
//   (b) explicit mode=catalog honored when kill switch inactive
//   (c) kill switch coerces even explicit mode=catalog to full
//   (d) config catalog_default=false is equivalent to env kill switch
// ---------------------------------------------------------------------------

describe('pattern_find mode selection — R-CAT-DEFAULT', () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    else process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = savedEnv;
  });

  test('(a) no explicit mode → full shape (R-CAT T3 backward compat)', async () => {
    delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    const dir = makeTmpProject();
    try {
      const result = await handle(
        { task_summary: 'test task', agent_role: 'developer' },
        makeContext(dir)
      );
      assert.ok(!result.isError, 'handle should not error');
      const body = JSON.parse(result.content[0].text);
      assert.ok('matches' in body, 'omitted mode must return full shape (matches array)');
      assert.ok(!('catalog' in body), 'omitted mode must NOT have catalog field');
    } finally {
      cleanup(dir);
    }
  });

  test('(b) explicit mode=catalog honored when kill switch inactive', async () => {
    delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    const dir = makeTmpProject();
    try {
      const result = await handle(
        { task_summary: 'test task', agent_role: 'developer', mode: 'catalog' },
        makeContext(dir)
      );
      assert.ok(!result.isError, 'handle should not error');
      const body = JSON.parse(result.content[0].text);
      assert.equal(body.mode, 'catalog', 'explicit mode=catalog should be honoured when kill switch inactive');
    } finally {
      cleanup(dir);
    }
  });

  test('(c) ORCHESTRAY_DISABLE_CATALOG_DEFAULT=1 coerces explicit catalog → full', async () => {
    process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = '1';
    const dir = makeTmpProject();
    try {
      const result = await handle(
        { task_summary: 'test task', agent_role: 'developer', mode: 'catalog' },
        makeContext(dir)
      );
      assert.ok(!result.isError, 'handle should not error');
      const body = JSON.parse(result.content[0].text);
      assert.ok('matches' in body, 'kill switch must coerce catalog to full');
      assert.ok(!('catalog' in body), 'kill switch must suppress catalog field');
    } finally {
      cleanup(dir);
    }
  });

  test('(c-omit) ORCHESTRAY_DISABLE_CATALOG_DEFAULT=1 with no explicit mode → full', async () => {
    process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT = '1';
    const dir = makeTmpProject();
    try {
      const result = await handle(
        { task_summary: 'test task', agent_role: 'developer' },
        makeContext(dir)
      );
      assert.ok(!result.isError, 'handle should not error');
      const body = JSON.parse(result.content[0].text);
      assert.ok('matches' in body, 'full mode should return matches array');
      assert.ok(!('catalog' in body), 'full mode should not return catalog string');
    } finally {
      cleanup(dir);
    }
  });

  test('explicit mode=full with no env override → full mode', async () => {
    delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    const dir = makeTmpProject();
    try {
      const result = await handle(
        { task_summary: 'test task', agent_role: 'developer', mode: 'full' },
        makeContext(dir)
      );
      assert.ok(!result.isError, 'handle should not error');
      const body = JSON.parse(result.content[0].text);
      assert.ok('matches' in body, 'explicit mode=full should return matches array');
    } finally {
      cleanup(dir);
    }
  });

  test('(d) config catalog_default=false coerces explicit catalog → full', async () => {
    delete process.env.ORCHESTRAY_DISABLE_CATALOG_DEFAULT;
    const dir = makeTmpProject({ catalog_mode_default: { catalog_default: false } });
    try {
      const result = await handle(
        { task_summary: 'test task', agent_role: 'developer', mode: 'catalog' },
        makeContext(dir)
      );
      assert.ok(!result.isError, 'handle should not error');
      const body = JSON.parse(result.content[0].text);
      assert.ok('matches' in body, 'config catalog_default=false should coerce catalog to full');
      assert.ok(!('catalog' in body), 'should not have catalog field when kill switch active');
    } finally {
      cleanup(dir);
    }
  });
});
