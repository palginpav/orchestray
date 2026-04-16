#!/usr/bin/env node
'use strict';

/**
 * v2.0.21 hotfix regression — plugin statusline wiring.
 *
 * v2.0.19 shipped the plugin `settings.json` with a top-level `statusLine` block,
 * which Claude Code silently ignores in plugin scope (only `agent` and
 * `subagentStatusLine` are honored). v2.0.21 reshapes it to `subagentStatusLine`.
 *
 * This test pins:
 *   1. `settings.json` has NO top-level `statusLine` key.
 *   2. `settings.json` has a `subagentStatusLine.command` ending in `bin/statusline.js`.
 *   3. `package.json.version` === `.claude-plugin/plugin.json.version` === `2.0.21`.
 *
 * Design doc: `.orchestray/kb/artifacts/2019_1-bugfix-statusline-design.md`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
}

describe('v2.0.21 — plugin settings.json statusline wiring', () => {
  const settings = readJson('settings.json');

  test('no top-level statusLine key (plugin scope ignores it)', () => {
    assert.equal(
      Object.prototype.hasOwnProperty.call(settings, 'statusLine'),
      false,
      'plugin settings.json must not carry a top-level statusLine block — Claude Code silently ignores it in plugin scope',
    );
  });

  test('has subagentStatusLine.command ending in bin/statusline.js', () => {
    assert.ok(settings.subagentStatusLine, 'subagentStatusLine block must be present');
    assert.equal(settings.subagentStatusLine.type, 'command');
    const cmd = settings.subagentStatusLine.command;
    assert.equal(typeof cmd, 'string', 'subagentStatusLine.command must be a string');
    assert.ok(
      cmd.endsWith('bin/statusline.js'),
      `subagentStatusLine.command should end in bin/statusline.js, got: ${cmd}`,
    );
  });
});

describe('v2.0.21 — version parity across package.json and plugin.json', () => {
  const pkg    = readJson('package.json');
  const plugin = readJson('.claude-plugin/plugin.json');

  test('package.json version is 2.0.21', () => {
    assert.equal(pkg.version, '2.0.21');
  });

  test('.claude-plugin/plugin.json version is 2.0.21', () => {
    assert.equal(plugin.version, '2.0.21');
  });

  test('package.json and plugin.json versions match', () => {
    assert.equal(pkg.version, plugin.version);
  });
});
