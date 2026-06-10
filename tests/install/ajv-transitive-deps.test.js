#!/usr/bin/env node
'use strict';

/**
 * v2.3.8: ajv removed; plugin-input-schema-validator.js now uses in-house
 * json-schema-subset.js (no eval, no external deps).
 *
 * This test verifies the install end-to-end: the validator installs correctly
 * and the json-schema-subset.js companion module is present alongside it.
 * The old ajv-copy assertions are gone — replaced with subset-validator checks.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'bin', 'install.js');

describe('install.js — plugin-input-schema-validator (v2.3.8, no ajv)', () => {
  test('installs validator + json-schema-subset and validates correctly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-subset-deps-'));
    const env = Object.assign({}, process.env, { HOME: tmp });
    const res = spawnSync('node', [INSTALL_SCRIPT, '--global'], {
      env, cwd: tmp, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

    const libDir = path.join(tmp, '.claude', 'orchestray', 'bin', '_lib');
    const validator = path.join(libDir, 'plugin-input-schema-validator.js');
    const subset = path.join(libDir, 'json-schema-subset.js');

    assert.ok(fs.existsSync(validator), 'plugin-input-schema-validator.js not installed');
    assert.ok(fs.existsSync(subset), 'json-schema-subset.js not installed');

    // ajv must NOT be present — it was removed.
    const ajvDir = path.join(tmp, '.claude', 'orchestray', 'node_modules', 'ajv');
    assert.ok(!fs.existsSync(ajvDir), 'ajv should not be installed (dependency removed)');

    // End-to-end: validate + validateInput must work without ajv.
    const probe = spawnSync(process.execPath, [
      '-e',
      `const v = require(${JSON.stringify(validator)});` +
      `v.compileToolInputSchema({type:'object',properties:{}});` +
      `const r = v.validateInput({type:'object',properties:{n:{type:'string'}}},{n:'x'});` +
      `if (!r.ok) { console.error('validateInput failed', r.errors); process.exit(1); }` +
      `const r2 = v.validateInput({type:'integer'}, '42');` +
      `if (r2.ok) { console.error('integer check should reject string'); process.exit(1); }` +
      `console.log('OK');`,
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(probe.status, 0,
      'plugin-input-schema-validator end-to-end failed:\n' +
      'stdout=' + probe.stdout + '\nstderr=' + probe.stderr);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
