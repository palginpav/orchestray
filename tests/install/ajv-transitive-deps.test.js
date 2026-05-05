#!/usr/bin/env node
'use strict';

/**
 * v2.3.2 regression: install.js must copy ajv's runtime dependencies, not
 * just ajv itself. v2.3.0 shipped the ajv copy block but forgot the four
 * transitive deps (fast-deep-equal, fast-uri, json-schema-traverse,
 * require-from-string), so `require('ajv')` succeeded but `new Ajv()`
 * crashed at first use of plugin-input-schema-validator.js.
 *
 * This test runs `node bin/install.js --global` against a throwaway HOME
 * and asserts the four leaf deps are present alongside ajv, then exercises
 * the validator end-to-end so any future drift (ajv adds a dep, walker
 * misses it) fails the suite loudly.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'bin', 'install.js');

describe('install.js — ajv transitive deps (v2.3.2)', () => {
  test('copies ajv plus all package.json#dependencies leaf packages', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ajv-deps-'));
    const env = Object.assign({}, process.env, { HOME: tmp });
    const res = spawnSync('node', [INSTALL_SCRIPT, '--global'], {
      env, cwd: tmp, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(res.status, 0, 'install failed: ' + res.stderr + '\n' + res.stdout);

    const nm = path.join(tmp, '.claude', 'orchestray', 'node_modules');
    assert.ok(fs.existsSync(path.join(nm, 'ajv')), 'ajv missing');

    // Drive the expected list from ajv's own package.json — same source the
    // installer uses, so the test stays in sync if ajv changes deps.
    const ajvPkg = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'node_modules', 'ajv', 'package.json'), 'utf8'));
    const expectedDeps = Object.keys(ajvPkg.dependencies || {});
    assert.ok(expectedDeps.length > 0, 'ajv should declare runtime deps');

    for (const dep of expectedDeps) {
      const depDir = path.join(nm, dep);
      assert.ok(fs.existsSync(depDir),
        `ajv runtime dep ${dep} missing from install — new Ajv() will throw`);
      assert.ok(fs.existsSync(path.join(depDir, 'package.json')),
        `${dep} package.json missing — copy was incomplete`);
    }

    // End-to-end: instantiating Ajv via the installed validator must work.
    // This is the exact code path the v2.3.0 plugin-loader hits.
    const validator = path.join(tmp, '.claude', 'orchestray', 'bin',
      '_lib', 'plugin-input-schema-validator.js');
    assert.ok(fs.existsSync(validator), 'validator not installed');
    const probe = spawnSync(process.execPath, [
      '-e',
      `const v = require(${JSON.stringify(validator)});` +
      `v.compileToolInputSchema({type:'object',properties:{}});` +
      `const r = v.validateInput({type:'object',properties:{n:{type:'string'}}},{n:'x'});` +
      `if (!r.ok) { console.error('validateInput failed', r.errors); process.exit(1); }` +
      `console.log('OK');`,
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(probe.status, 0,
      'plugin-input-schema-validator end-to-end failed:\n' +
      'stdout=' + probe.stdout + '\nstderr=' + probe.stderr);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
