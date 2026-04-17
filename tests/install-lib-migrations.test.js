'use strict';

// Regression test for v2.1.0 install bug: bin/_lib/migrations/ subdirectory
// was silently dropped by the flat readdirSync loop — causing the MCP server
// to exit immediately with MODULE_NOT_FOUND on startup.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/install.js');
const PKG_ROOT = path.resolve(__dirname, '..');

function installLocal(tmpDir) {
  return spawnSync(process.execPath, [SCRIPT, '--local'], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: tmpDir,
    env: { ...process.env },
  });
}

test('_lib/migrations/ is copied by --local install', (t, done) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-lib-migrations-'));
  try {
    const result = installLocal(tmpDir);
    assert.equal(result.status, 0, `install failed:\n${result.stderr}`);

    const libBase = path.join(tmpDir, '.claude', 'orchestray', 'bin', '_lib');

    // migrations/ MUST be present — it contains runtime require()d files
    assert.ok(
      fs.existsSync(path.join(libBase, 'migrations', '001-fts5-initial.js')),
      '_lib/migrations/001-fts5-initial.js must be installed'
    );

    // __tests__/ MUST NOT be present — test fixtures have no place in the install target
    assert.ok(
      !fs.existsSync(path.join(libBase, '__tests__')),
      '_lib/__tests__/ must not be copied to install target'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  done();
});

test('mcp-server boots without MODULE_NOT_FOUND after --local install', (t, done) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-mcp-boot-'));
  const result = installLocal(tmpDir);
  if (result.status !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    assert.fail(`install failed:\n${result.stderr}`);
    return;
  }

  const serverJs = path.join(tmpDir, '.claude', 'orchestray', 'bin', 'mcp-server', 'server.js');
  assert.ok(fs.existsSync(serverJs), 'mcp-server/server.js must exist after install');

  const child = spawn(process.execPath, [serverJs], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpDir,
  });

  let stderr = '';
  let finished = false;

  const finish = (err) => {
    if (finished) return;
    finished = true;
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    done(err);
  };

  const timeout = setTimeout(() => {
    finish(new Error('mcp-server did not emit ready banner within 3s'));
  }, 3000);

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.includes('orchestray-mcp server ready')) {
      clearTimeout(timeout);
      finish();
    }
  });

  child.on('exit', (code) => {
    if (finished) return;
    if (code !== 0 && code !== null) {
      clearTimeout(timeout);
      finish(new Error(`mcp-server exited with code ${code} before ready banner.\nstderr: ${stderr}`));
    }
  });
});
