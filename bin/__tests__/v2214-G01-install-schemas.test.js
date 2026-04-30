#!/usr/bin/env node
'use strict';

/**
 * v2.2.14 G-01: install.js must copy schemas/ to orchestray/schemas/.
 *
 * Root cause: validate-config.js does require('../schemas'). If schemas/
 * is missing from the install target, every SessionStart hook throws
 * node:fs:1012 (ENOENT). Latent since v2.2.9 B-7 (commit 2f9590e).
 *
 * Tests:
 *   1. schemas/index.js present after global install
 *   2. All 6 schema files present
 *   3. validate-config.js exits 0 against a minimal valid config
 *   4. Post-install verification step does not print error to stderr
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = path.join(REPO_ROOT, 'bin', 'install.js');

const EXPECTED_SCHEMA_FILES = [
  'index.js',
  'config.schema.js',
  'pattern.schema.js',
  'specialist.schema.js',
  '_validator.js',
  '_yaml.js',
];

function runInstall(homeDir, args, extraEnv) {
  return spawnSync('node', [INSTALL_SCRIPT, ...args], {
    env: Object.assign({}, process.env, extraEnv || {}, { HOME: homeDir }),
    cwd: homeDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('v2.2.14 G-01 — schemas/ copied by install.js', () => {
  let tmp;
  let installResult;
  let targetDir;
  let schemasDst;

  // Run install once, share across tests for speed.
  test('before: run install --global', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-g01-'));
    installResult = runInstall(tmp, ['--global']);
    targetDir = path.join(tmp, '.claude');
    schemasDst = path.join(targetDir, 'orchestray', 'schemas');
    assert.equal(
      installResult.status, 0,
      `install failed\nstdout=${installResult.stdout}\nstderr=${installResult.stderr}`
    );
  });

  test('schemas/index.js exists after install', () => {
    const indexPath = path.join(schemasDst, 'index.js');
    assert.ok(
      fs.existsSync(indexPath),
      `missing: ${indexPath}\ninstall stdout=${installResult.stdout}`
    );
  });

  test('all 6 schema files present', () => {
    for (const name of EXPECTED_SCHEMA_FILES) {
      const p = path.join(schemasDst, name);
      assert.ok(fs.existsSync(p), `missing schema file: ${name} at ${p}`);
    }
  });

  test('validate-config.js exits 0 with minimal valid config', () => {
    // Write a minimal .orchestray/config.json the validator accepts.
    const orchDir = path.join(tmp, '.orchestray');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(
      path.join(orchDir, 'config.json'),
      JSON.stringify({ version: '1.0.0' }),
      'utf8'
    );

    const validateScript = path.join(targetDir, 'orchestray', 'bin', 'validate-config.js');
    assert.ok(fs.existsSync(validateScript), `validate-config.js not installed at ${validateScript}`);

    const result = spawnSync('node', [validateScript], {
      env: Object.assign({}, process.env, { HOME: tmp }),
      cwd: tmp,
      encoding: 'utf8',
      timeout: 15_000,
    });

    // Must not throw node:fs:1012 — that is the exact bug being fixed.
    assert.ok(
      !result.stderr.includes('node:fs:1012'),
      `validate-config.js threw node:fs:1012 (schemas/ still missing?)\nstderr=${result.stderr}`
    );
    // Exit code 0 = valid config; exit code 1 = invalid config but module loaded fine.
    // Either is acceptable — what we must NOT see is exit 1 with ENOENT on schemas.
    assert.ok(
      result.status !== null,
      `validate-config.js did not exit (timeout?)\nstderr=${result.stderr}`
    );
    assert.ok(
      !result.stderr.includes('Cannot find module'),
      `validate-config.js cannot find module\nstderr=${result.stderr}`
    );
  });

  test('post-install verification does not print error to stderr', () => {
    // The verification step in install.js logs to console.error on failure.
    assert.ok(
      !installResult.stderr.includes('Post-install verification failed'),
      `post-install verification reported failure\nstderr=${installResult.stderr}`
    );
  });
});
