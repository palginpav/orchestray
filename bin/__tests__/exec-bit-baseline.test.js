'use strict';

/**
 * v2.2.21 W2-T5: exec-bit baseline test.
 *
 * Asserts every bin/*.js (and bin/release-manager/*.js) referenced in
 * hooks/hooks.json has mode 0755 in the source tree. This is a CI safety net
 * that catches newly-wired scripts that were not chmod'd before commit.
 *
 * Cases:
 *   1. happy_path       — all wired hook scripts have mode 0755 in source tree
 *   2. mode_check_logic — fixture: script with mode 0644 → flagged as failing
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HOOKS_JSON  = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const BIN_DIR     = path.join(REPO_ROOT, 'bin');

// ---------------------------------------------------------------------------
// Helper: collect all bin/*.js paths referenced in hooks.json commands.
// Returns a Set of repo-relative paths like "bin/audit-event.js".
// ---------------------------------------------------------------------------
function collectWiredBinScripts(hooksJsonPath) {
  const data = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const scripts = new Set();

  for (const entries of Object.values(data.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of (entry.hooks || [])) {
        const cmd = (h && h.command) || '';
        // Match both bare and node-prefixed forms:
        //   ${CLAUDE_PLUGIN_ROOT}/bin/foo.js
        //   node ${CLAUDE_PLUGIN_ROOT}/bin/foo.js
        const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/([A-Za-z0-9_\-\/\.]+\.js)/);
        if (m) scripts.add(m[1]); // e.g. "audit-event.js" or "release-manager/subagentstop-changelog-gate.js"
      }
    }
  }

  return scripts;
}

// ---------------------------------------------------------------------------
// Helper: check if a file has mode 0755 (user+group+other execute).
// Returns { ok: bool, actual: string } where actual is octal string like "755".
// ---------------------------------------------------------------------------
function checkMode(filePath) {
  const stat = fs.statSync(filePath);
  // fs.statSync().mode is a 32-bit integer; mask to lower 9 bits for rwxrwxrwx.
  const mode = stat.mode & 0o777;
  return { ok: mode === 0o755, actual: mode.toString(8).padStart(3, '0') };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exec-bit baseline', () => {
  test('happy_path: all wired hook scripts have mode 0755 in source tree', () => {
    const wired = collectWiredBinScripts(HOOKS_JSON);
    assert.ok(wired.size > 0, 'hooks.json should reference at least one bin script');

    const failures = [];
    for (const rel of wired) {
      const absPath = path.join(BIN_DIR, rel);
      if (!fs.existsSync(absPath)) {
        // Missing scripts are caught by install-hook-canonicalisation.test.js.
        // We only check mode on scripts that actually exist.
        continue;
      }
      const { ok, actual } = checkMode(absPath);
      if (!ok) {
        failures.push(`${rel}: mode ${actual} (expected 755)`);
      }
    }

    assert.deepEqual(
      failures,
      [],
      `These wired hook scripts are missing exec bit:\n  ${failures.join('\n  ')}\n` +
      `Run: chmod 0755 bin/<script>.js for each`
    );
  });

  test('mode_check_logic: script with mode 0644 is flagged', () => {
    // Fixture: create a tmp .js file with mode 0644 and verify our logic detects it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-bit-baseline-'));
    try {
      const tmpScript = path.join(tmpDir, 'fixture.js');
      fs.writeFileSync(tmpScript, '// fixture\n', { mode: 0o644 });
      fs.chmodSync(tmpScript, 0o644);
      const { ok, actual } = checkMode(tmpScript);
      assert.equal(ok, false, 'mode 0644 should fail the check');
      assert.equal(actual, '644');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
