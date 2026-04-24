#!/usr/bin/env node
'use strict';

/**
 * install-ox tests (v2.1.11 F-08 / R4 AC-07).
 *
 * Verifies that:
 * 1. The ox shim can be created in a temp directory.
 * 2. The shim can be invoked and `ox help` exits 0.
 * 3. The ox.js binary itself is executable via node directly.
 * 4. The ox shim content is well-formed (exec node path).
 * 5. PATH prepend function does not overwrite an existing PATH value.
 *
 * Runner: node --test tests/install-ox.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const OX_JS = path.join(__dirname, '..', 'bin', 'ox.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ox-install-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ok */ }
}

/**
 * Create a minimal ox shim in a temp directory (simulates what install.js does).
 * Returns the shim path.
 */
function createShim(oxBinDir) {
  const isWindows = process.platform === 'win32';
  const shimPath = path.join(oxBinDir, isWindows ? 'ox.cmd' : 'ox');
  fs.mkdirSync(oxBinDir, { recursive: true });
  if (isWindows) {
    fs.writeFileSync(shimPath, '@echo off\nnode "%~dp0ox.js" %*\n', { encoding: 'utf8' });
  } else {
    const shimContent = `#!/bin/sh\nexec node "${OX_JS}" "$@"\n`;
    fs.writeFileSync(shimPath, shimContent, { encoding: 'utf8', mode: 0o755 });
    try { fs.chmodSync(shimPath, 0o755); } catch (_e) {}
  }
  return shimPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ox.js binary — bare invocation', () => {
  test('node ox.js help exits 0', () => {
    const result = spawnSync(process.execPath, [OX_JS, 'help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'node ox.js help must exit 0');
    assert.ok(result.stdout.length > 0, 'help must emit output');
  });

  test('node ox.js (no args) exits 0', () => {
    const result = spawnSync(process.execPath, [OX_JS], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'bare ox must exit 0');
  });

  test('ox.js exists and is readable', () => {
    assert.ok(fs.existsSync(OX_JS), `ox.js must exist at ${OX_JS}`);
    const stat = fs.statSync(OX_JS);
    assert.ok(stat.isFile(), 'ox.js must be a regular file');
    assert.ok(stat.size > 0, 'ox.js must not be empty');
  });
});

describe('ox shim — install simulation', () => {
  test('shim can be created in a temp directory', () => {
    const tmp = makeTmpDir();
    try {
      const oxBinDir = path.join(tmp, 'orchestray', 'bin');
      const shimPath = createShim(oxBinDir);
      assert.ok(fs.existsSync(shimPath), 'shim file must be created');
      const content = fs.readFileSync(shimPath, 'utf8');
      assert.ok(content.length > 0, 'shim must not be empty');
    } finally {
      cleanup(tmp);
    }
  });

  test('shim invocation: ox help exits 0', () => {
    if (process.platform === 'win32') {
      // Skip shim execution test on Windows (shim format differs).
      return;
    }
    const tmp = makeTmpDir();
    try {
      const oxBinDir = path.join(tmp, 'orchestray', 'bin');
      const shimPath = createShim(oxBinDir);
      // Invoke the shim directly (it executes via sh -> node).
      const result = spawnSync('sh', [shimPath, 'help'], { encoding: 'utf8' });
      assert.equal(result.status, 0, 'shim ox help must exit 0');
      assert.ok(result.stdout.includes('routing') || result.stdout.includes('state'),
        'shim help output must include verb table');
    } finally {
      cleanup(tmp);
    }
  });

  test('shim content starts with #!/bin/sh on non-Windows', () => {
    if (process.platform === 'win32') return;
    const tmp = makeTmpDir();
    try {
      const oxBinDir = path.join(tmp, 'orchestray', 'bin');
      const shimPath = createShim(oxBinDir);
      const content = fs.readFileSync(shimPath, 'utf8');
      assert.ok(content.startsWith('#!/bin/sh'), 'shim must start with #!/bin/sh');
    } finally {
      cleanup(tmp);
    }
  });

  test('shim references the real ox.js path', () => {
    if (process.platform === 'win32') return;
    const tmp = makeTmpDir();
    try {
      const oxBinDir = path.join(tmp, 'orchestray', 'bin');
      const shimPath = createShim(oxBinDir);
      const content = fs.readFileSync(shimPath, 'utf8');
      assert.ok(content.includes('ox.js'), 'shim must reference ox.js');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('PATH prepend safety', () => {
  test('PATH variable is not overwritten with just the ox dir', () => {
    // This test verifies the fix for the install.js PATH overwrite bug:
    // _prependOxBinToPath must read the existing PATH and PREPEND to it,
    // not replace it entirely.
    //
    // We simulate by checking: if a settings.json has no env.PATH key,
    // the install code should fall back to process.env.PATH.
    //
    // We test the _prependOxBinToPath logic indirectly:
    // - Read install.js source and verify it reads existing PATH value
    //   before writing (guards against regression).
    const installSrc = fs.readFileSync(
      path.join(__dirname, '..', 'bin', 'install.js'), 'utf8'
    );
    // The fix reads process.env.PATH as a fallback.
    assert.ok(
      installSrc.includes('process.env.PATH') || installSrc.includes('systemPath'),
      'install.js must read process.env.PATH before writing settings PATH'
    );
    // Must NOT blindly set PATH to just oxBinDir without including existing PATH.
    // We check that the string oxBinDir alone is not the only value assigned.
    assert.ok(
      !installSrc.match(/PATH['"]?\s*:\s*oxBinDir[^+|:]/),
      'install.js must not overwrite PATH with only oxBinDir'
    );
  });
});
