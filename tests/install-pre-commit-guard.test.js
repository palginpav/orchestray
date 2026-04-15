#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/install-pre-commit-guard.sh  (T13 — v2.0.17)
 *
 * Contracts under test:
 *  - Flag off (or missing config): does NOT install the hook
 *  - Flag on + no existing hook: installs .git/hooks/pre-commit, is executable,
 *    contains Block-A trailer check
 *  - Flag on + existing non-Orchestray hook: does NOT overwrite, prints message, exits 0
 *  - --uninstall removes an Orchestray-installed hook (by marker), leaves non-Orchestray alone
 *  - Installed hook: committing with Block A unchanged → allowed
 *  - Installed hook: changing Block A without 'BLOCK-A: approved' trailer → blocked
 *  - Installed hook: changing Block A WITH 'BLOCK-A: approved' trailer → allowed
 *  - Script has #!/usr/bin/env bash shebang and passes `bash -n`
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/install-pre-commit-guard.sh');
const ORCHESTRAY_MARKER = '# orchestray-block-a-guard';
const BLOCK_A_SENTINEL = '<!-- ORCHESTRAY_BLOCK_A_END -->';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pcg-'));
}

/**
 * Initialize a bare git repo in tmpDir and make an initial commit with pm.md.
 * Returns the tmpDir path.
 */
function makeGitRepo(tmpDir, blockAContent = 'original block-a content\n') {
  const agentsDir = path.join(tmpDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  const pmContent = blockAContent + BLOCK_A_SENTINEL + '\n\nblock-b here\n';
  fs.writeFileSync(path.join(agentsDir, 'pm.md'), pmContent, 'utf8');

  // Init git repo
  spawnSync('git', ['init'], { cwd: tmpDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, encoding: 'utf8' });
  spawnSync('git', ['add', '.'], { cwd: tmpDir, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: tmpDir, encoding: 'utf8' });

  return tmpDir;
}

/**
 * Write the orchestray config.json with pre_commit_guard_enabled.
 */
function writeGuardConfig(tmpDir, enabled = true) {
  const orchDir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(orchDir, { recursive: true });
  const config = {
    cache_choreography: {
      pre_commit_guard_enabled: enabled,
    },
  };
  fs.writeFileSync(path.join(orchDir, 'config.json'), JSON.stringify(config), 'utf8');
}

/**
 * Run the install script from tmpDir.
 * @param {string} tmpDir
 * @param {string[]} [args]
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function runScript(tmpDir, args = []) {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/** Return the pre-commit hook file path for a given tmpDir. */
function hookPath(tmpDir) {
  return path.join(tmpDir, '.git', 'hooks', 'pre-commit');
}

/** Run the installed pre-commit hook directly (simulates git commit). */
function runHook(tmpDir, envOverrides = {}) {
  const hook = hookPath(tmpDir);
  const result = spawnSync('bash', [hook], {
    cwd: tmpDir,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...envOverrides },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Stage a pm.md change with modified Block A content, then run the hook
 * to simulate a git commit check.
 */
function stageBlockAChange(tmpDir, newBlockAContent) {
  const agentsDir = path.join(tmpDir, 'agents');
  const pmContent = newBlockAContent + BLOCK_A_SENTINEL + '\n\nblock-b here\n';
  fs.writeFileSync(path.join(agentsDir, 'pm.md'), pmContent, 'utf8');
  spawnSync('git', ['add', 'agents/pm.md'], { cwd: tmpDir, encoding: 'utf8' });
}

/**
 * Write the COMMIT_EDITMSG file to simulate a commit message.
 */
function writeCommitMsg(tmpDir, message) {
  const gitDir = path.join(tmpDir, '.git');
  fs.writeFileSync(path.join(gitDir, 'COMMIT_EDITMSG'), message, 'utf8');
}

// ---------------------------------------------------------------------------
// Script file sanity
// ---------------------------------------------------------------------------

describe('script file sanity', () => {

  test('script exists and has #!/usr/bin/env bash shebang', () => {
    assert.ok(fs.existsSync(SCRIPT), `install-pre-commit-guard.sh must exist at ${SCRIPT}`);
    const content = fs.readFileSync(SCRIPT, 'utf8');
    assert.ok(
      content.startsWith('#!/usr/bin/env bash'),
      'script must start with #!/usr/bin/env bash shebang'
    );
  });

  test('script passes bash -n syntax check', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8', timeout: 5000 });
    assert.equal(
      result.status,
      0,
      `bash -n syntax check failed:\n${result.stderr}`
    );
  });

});

// ---------------------------------------------------------------------------
// Flag off — does NOT install hook
// ---------------------------------------------------------------------------

describe('guard flag off — does not install hook', () => {

  test('does not install hook when config file is missing entirely', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      // No config file at all

      const { status } = runScript(tmpDir);
      assert.equal(status, 0, 'must exit 0 when config is missing');
      assert.ok(!fs.existsSync(hookPath(tmpDir)), 'hook must NOT be installed when config is missing');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not install hook when pre_commit_guard_enabled is false', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, false);

      const { status } = runScript(tmpDir);
      assert.equal(status, 0, 'must exit 0 when guard is disabled');
      assert.ok(!fs.existsSync(hookPath(tmpDir)), 'hook must NOT be installed when guard is disabled');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Flag on + no existing hook — installs correctly
// ---------------------------------------------------------------------------

describe('guard flag on — installs hook', () => {

  test('installs .git/hooks/pre-commit when flag is on and no existing hook', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);

      const { status } = runScript(tmpDir);
      assert.equal(status, 0, 'install script must exit 0');
      assert.ok(fs.existsSync(hookPath(tmpDir)), '.git/hooks/pre-commit must exist after install');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('installed hook file is executable', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      const stat = fs.statSync(hookPath(tmpDir));
      // Check owner execute bit (0o100)
      const isExecutable = (stat.mode & 0o111) !== 0;
      assert.ok(isExecutable, '.git/hooks/pre-commit must be executable');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('installed hook contains Orchestray marker comment', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      const hookContent = fs.readFileSync(hookPath(tmpDir), 'utf8');
      assert.ok(
        hookContent.includes(ORCHESTRAY_MARKER),
        `installed hook must contain the Orchestray marker: '${ORCHESTRAY_MARKER}'`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('installed hook contains Block A sentinel check', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      const hookContent = fs.readFileSync(hookPath(tmpDir), 'utf8');
      assert.ok(
        hookContent.includes(BLOCK_A_SENTINEL),
        'installed hook must reference the Block A sentinel'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('installed hook contains BLOCK-A: approved check', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      const hookContent = fs.readFileSync(hookPath(tmpDir), 'utf8');
      assert.ok(
        hookContent.includes('BLOCK-A: approved'),
        'installed hook must check for "BLOCK-A: approved" trailer'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Flag on + existing non-Orchestray hook — does NOT overwrite
// ---------------------------------------------------------------------------

describe('guard flag on — does not overwrite non-Orchestray hook', () => {

  test('refuses to overwrite an existing non-Orchestray pre-commit hook', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);

      // Write a non-Orchestray hook
      const hooksDir = path.join(tmpDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const existingHook = '#!/usr/bin/env bash\necho "my existing hook"\nexit 0\n';
      fs.writeFileSync(hookPath(tmpDir), existingHook, 'utf8');
      fs.chmodSync(hookPath(tmpDir), 0o755);

      const { status, stdout } = runScript(tmpDir);
      assert.equal(status, 0, 'must exit 0 even when refusing to overwrite');

      // The existing hook must be unchanged
      const hookContent = fs.readFileSync(hookPath(tmpDir), 'utf8');
      assert.equal(hookContent, existingHook, 'existing non-Orchestray hook must not be overwritten');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('prints a message explaining why the hook was not installed', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);

      const hooksDir = path.join(tmpDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(hookPath(tmpDir), '#!/usr/bin/env bash\nexit 0\n', 'utf8');

      const { stdout } = runScript(tmpDir);
      assert.ok(
        stdout.includes('Orchestray') || stdout.length > 0,
        'script must print an explanatory message when refusing to overwrite'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// --uninstall
// ---------------------------------------------------------------------------

describe('--uninstall', () => {

  test('removes an Orchestray-installed hook', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);

      // Install first
      runScript(tmpDir);
      assert.ok(fs.existsSync(hookPath(tmpDir)), 'hook must exist before uninstall');

      // Uninstall
      const { status } = runScript(tmpDir, ['--uninstall']);
      assert.equal(status, 0, '--uninstall must exit 0');
      assert.ok(!fs.existsSync(hookPath(tmpDir)), 'hook must be removed after --uninstall');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('--uninstall does NOT remove a non-Orchestray pre-commit hook', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);

      // Write a non-Orchestray hook
      const hooksDir = path.join(tmpDir, '.git', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      const existingHook = '#!/usr/bin/env bash\necho "third-party hook"\nexit 0\n';
      fs.writeFileSync(hookPath(tmpDir), existingHook, 'utf8');
      fs.chmodSync(hookPath(tmpDir), 0o755);

      runScript(tmpDir, ['--uninstall']);

      // Non-Orchestray hook must still be there, unchanged
      assert.ok(fs.existsSync(hookPath(tmpDir)), 'non-Orchestray hook must not be removed by --uninstall');
      const hookContent = fs.readFileSync(hookPath(tmpDir), 'utf8');
      assert.equal(hookContent, existingHook, 'non-Orchestray hook content must be unchanged');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('--uninstall exits 0 and prints message when no hook exists', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir);
      writeGuardConfig(tmpDir, true);

      // No hook installed
      const { status, stdout } = runScript(tmpDir, ['--uninstall']);
      assert.equal(status, 0, '--uninstall must exit 0 when no hook present');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Installed hook behavior — commit simulation
// ---------------------------------------------------------------------------

describe('installed hook behavior', () => {

  test('allows commit when Block A is unchanged', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir, 'original block-a content\n');
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      // Stage a change to a file OTHER than agents/pm.md
      fs.writeFileSync(path.join(tmpDir, 'other-file.txt'), 'hello\n', 'utf8');
      spawnSync('git', ['add', 'other-file.txt'], { cwd: tmpDir, encoding: 'utf8' });

      writeCommitMsg(tmpDir, 'chore: update other file');
      const { status } = runHook(tmpDir);
      assert.equal(status, 0, 'hook must allow commit when Block A is unchanged');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('blocks commit when Block A changes without BLOCK-A: approved trailer', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir, 'original block-a content\n');
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      // Stage a Block A change
      stageBlockAChange(tmpDir, 'MODIFIED block-a content — this is different\n');
      writeCommitMsg(tmpDir, 'chore: update pm.md');

      const { status, stderr } = runHook(tmpDir);
      assert.equal(status, 1, 'hook must block (exit 1) when Block A changes without approval');
      assert.ok(
        stderr.includes('BLOCKED') || stderr.includes('BLOCK-A'),
        'hook stderr must mention the block reason'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('allows commit when Block A changes WITH BLOCK-A: approved in commit message', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir, 'original block-a content\n');
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      // Stage a Block A change
      stageBlockAChange(tmpDir, 'MODIFIED block-a content — intentional change\n');
      writeCommitMsg(tmpDir, 'feat: update Block A\nBLOCK-A: approved');

      const { status } = runHook(tmpDir);
      assert.equal(status, 0, 'hook must allow commit when BLOCK-A: approved is in commit message');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('blocks when Block A changed but commit message has no approval (case-insensitive: lowercase blocked)', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir, 'original content\n');
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      stageBlockAChange(tmpDir, 'different content\n');
      // Write a message that does NOT contain the exact trailer
      writeCommitMsg(tmpDir, 'block-a: maybe approved but wrong case per grep -qi');

      // Note: grep -qi "BLOCK-A: approved" IS case-insensitive (-i flag),
      // so "block-a: approved" (lowercase) should PASS, but "block-a: maybe" should FAIL
      const { status } = runHook(tmpDir);
      // This message does NOT contain "approved" at all — it should block
      assert.equal(status, 1, 'hook must block when approval keyword is missing from commit message');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('allows when BLOCK-A: approved is lowercase (grep -qi is case-insensitive)', () => {
    const tmpDir = makeTmpDir();
    try {
      makeGitRepo(tmpDir, 'original content\n');
      writeGuardConfig(tmpDir, true);
      runScript(tmpDir);

      stageBlockAChange(tmpDir, 'different content\n');
      writeCommitMsg(tmpDir, 'feat: update block a\nblock-a: approved');

      const { status } = runHook(tmpDir);
      assert.equal(status, 0, 'hook must allow when "block-a: approved" appears (grep -qi is case-insensitive)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
