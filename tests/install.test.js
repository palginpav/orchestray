#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/install.js
 *
 * Installer script. Copies agents, skills, bin scripts, merges hooks into
 * settings.json, and writes manifest. Also handles uninstall.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/install.js');
const PKG_ROOT = path.resolve(__dirname, '..');

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...env },
    cwd: PKG_ROOT,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-install-test-'));
}

// ---------------------------------------------------------------------------
// Help and usage
// ---------------------------------------------------------------------------

describe('--help flag', () => {

  test('prints usage and exits 0', () => {
    const { stdout, status } = run(['--help']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Usage'), 'should print usage instructions');
    assert.ok(stdout.includes('--global'), 'should mention --global flag');
    assert.ok(stdout.includes('--local'), 'should mention --local flag');
  });

  test('-h is equivalent to --help', () => {
    const { stdout, status } = run(['-h']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Usage'));
  });

});

describe('no flags provided', () => {

  test('prints where-to-install prompt and exits 0', () => {
    const { stdout, status } = run([]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('--global') || stdout.includes('--local'),
      'should prompt user to choose install scope');
  });

});

// ---------------------------------------------------------------------------
// Local installation
// ---------------------------------------------------------------------------

describe('local installation (--local)', () => {

  test('creates expected directory structure', () => {
    const tmpDir = makeTmpDir();
    try {
      // Install into tmpDir by overriding HOME so --local writes to tmpDir/.claude
      // Actually --local writes to CWD/.claude — we'll change cwd
      const result = spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: { ...process.env },
      });

      assert.equal(result.status, 0, `install failed: ${result.stderr}`);

      const claudeDir = path.join(tmpDir, '.claude');
      assert.ok(fs.existsSync(path.join(claudeDir, 'agents')), 'agents/ dir should exist');
      assert.ok(fs.existsSync(path.join(claudeDir, 'skills')), 'skills/ dir should exist');
      assert.ok(fs.existsSync(path.join(claudeDir, 'orchestray', 'bin')), 'orchestray/bin/ dir should exist');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('copies agent markdown files', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: { ...process.env },
      });

      const agentsDir = path.join(tmpDir, '.claude', 'agents');
      const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
      assert.ok(agentFiles.length > 0, 'should install at least one agent file');

      // Verify at least the core agents are present
      const expectedAgents = ['pm.md', 'developer.md', 'reviewer.md'];
      for (const expected of expectedAgents) {
        assert.ok(agentFiles.includes(expected), `agent ${expected} should be installed`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('copies hook scripts to orchestray/bin/', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: { ...process.env },
      });

      const binDir = path.join(tmpDir, '.claude', 'orchestray', 'bin');
      const binFiles = fs.readdirSync(binDir);
      assert.ok(binFiles.length > 0, 'should install hook scripts');
      // install.js itself should NOT be copied to the target
      assert.ok(!binFiles.includes('install.js'), 'install.js should not be copied to target');
      // Core hooks should be present
      assert.ok(binFiles.includes('complexity-precheck.js'), 'complexity-precheck.js should be copied');
      assert.ok(binFiles.includes('collect-agent-metrics.js'), 'collect-agent-metrics.js should be copied');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('writes VERSION file with current version', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: { ...process.env },
      });

      const versionPath = path.join(tmpDir, '.claude', 'orchestray', 'VERSION');
      assert.ok(fs.existsSync(versionPath), 'VERSION file should exist');
      const version = fs.readFileSync(versionPath, 'utf8').trim();
      const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
      assert.equal(version, pkg.version, 'VERSION file should match package.json version');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('writes manifest.json with correct fields', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: { ...process.env },
      });

      const manifestPath = path.join(tmpDir, '.claude', 'orchestray', 'manifest.json');
      assert.ok(fs.existsSync(manifestPath), 'manifest.json should exist');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(manifest.version, 'manifest should have version');
      assert.ok(manifest.installedAt, 'manifest should have installedAt timestamp');
      assert.equal(manifest.scope, 'local', 'manifest scope should be local');
      assert.ok(Array.isArray(manifest.agents), 'manifest.agents should be an array');
      assert.ok(Array.isArray(manifest.skills), 'manifest.skills should be an array');
      assert.ok(Array.isArray(manifest.hooks), 'manifest.hooks should be an array');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('creates settings.json with hooks configured', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: { ...process.env },
      });

      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      assert.ok(fs.existsSync(settingsPath), 'settings.json should be created');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(settings.hooks, 'settings.json should have hooks key');
      assert.ok(Object.keys(settings.hooks).length > 0, 'at least one hook should be configured');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('hook commands reference absolute paths to installed scripts', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8',
        timeout: 15000,
        cwd: tmpDir,
        env: { ...process.env },
      });

      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const allCommands = Object.values(settings.hooks)
        .flat()
        .flatMap(e => (e.hooks || []).map(h => h.command || ''));

      for (const cmd of allCommands) {
        // Commands should NOT contain the ${CLAUDE_PLUGIN_ROOT} template variable
        assert.ok(!cmd.includes('${CLAUDE_PLUGIN_ROOT}'),
          `hook command should not contain template var: ${cmd}`);
        // Commands should reference the orchestray/bin directory
        assert.ok(cmd.includes('orchestray') && cmd.includes('bin'),
          `hook command should reference orchestray/bin: ${cmd}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('does not overwrite existing user hooks when re-running install', () => {
    const tmpDir = makeTmpDir();
    try {
      // First install
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      // Add a user hook manually
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
      settings.hooks.UserPromptSubmit.push({
        hooks: [{ type: 'command', command: 'node /my/custom/hook.js' }],
      });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      // Second install (re-run)
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      // User's custom hook should still be present
      const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const userPromptHooks = (updated.hooks.UserPromptSubmit || [])
        .flatMap(e => (e.hooks || []).map(h => h.command));
      assert.ok(
        userPromptHooks.some(c => c.includes('/my/custom/hook.js')),
        'user custom hook should not be removed by re-install'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('does not duplicate orchestray hooks on re-install', () => {
    const tmpDir = makeTmpDir();
    try {
      // Install twice
      for (let i = 0; i < 2; i++) {
        spawnSync(process.execPath, [SCRIPT, '--local'], {
          encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
        });
      }

      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const allCommands = Object.values(settings.hooks)
        .flat()
        .flatMap(e => (e.hooks || []).map(h => h.command || ''));

      // Count how many times complexity-precheck appears
      const precheckCount = allCommands.filter(c => c.includes('complexity-precheck')).length;
      assert.equal(precheckCount, 1, 'complexity-precheck should not be duplicated on re-install');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

describe('uninstall (--uninstall --local)', () => {

  test('removes installed agents, skills, and orchestray directory', () => {
    const tmpDir = makeTmpDir();
    try {
      // Install first
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      const claudeDir = path.join(tmpDir, '.claude');
      assert.ok(fs.existsSync(path.join(claudeDir, 'orchestray')), 'orchestray dir should exist after install');

      // Uninstall
      const { status } = spawnSync(process.execPath, [SCRIPT, '--local', '--uninstall'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });
      assert.equal(status, 0, 'uninstall should exit 0');

      assert.ok(!fs.existsSync(path.join(claudeDir, 'orchestray')),
        'orchestray/ dir should be removed after uninstall');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('removes orchestray hooks from settings.json', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });
      spawnSync(process.execPath, [SCRIPT, '--local', '--uninstall'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        const allCommands = Object.values(settings.hooks || {})
          .flat()
          .flatMap(e => (e.hooks || []).map(h => h.command || ''));
        assert.ok(
          !allCommands.some(c => c.includes('orchestray')),
          'no orchestray hook commands should remain after uninstall'
        );
      }
      // If settings.json doesn't exist, that's also acceptable
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 1 when orchestray is not installed', () => {
    const tmpDir = makeTmpDir();
    try {
      // Try to uninstall without ever installing
      const { status } = spawnSync(process.execPath, [SCRIPT, '--local', '--uninstall'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });
      assert.equal(status, 1, 'uninstall should exit 1 when manifest.json is not found');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('preserves user custom hooks during uninstall', () => {
    const tmpDir = makeTmpDir();
    try {
      // Install
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      // Add user hook
      const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
      settings.hooks.UserPromptSubmit.push({
        hooks: [{ type: 'command', command: 'node /my/custom/hook.js' }],
      });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      // Uninstall
      spawnSync(process.execPath, [SCRIPT, '--local', '--uninstall'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      // Custom hook should remain
      const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const userCmds = Object.values(after.hooks || {})
        .flat()
        .flatMap(e => (e.hooks || []).map(h => h.command || ''));
      assert.ok(
        userCmds.some(c => c.includes('/my/custom/hook.js')),
        'user custom hooks should be preserved after orchestray uninstall'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Subdirectory copying (agents with reference files)
// ---------------------------------------------------------------------------

describe('subdirectory copying', () => {

  test('copies agent subdirectories (e.g. pm-reference/) if they exist', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      const agentsDir = path.join(PKG_ROOT, 'agents');
      const subdirs = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      for (const subdir of subdirs) {
        const installedSubdir = path.join(tmpDir, '.claude', 'agents', subdir);
        assert.ok(fs.existsSync(installedSubdir),
          `agent subdirectory ${subdir} should be installed`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('copies skill subdirectories (e.g. templates/) within each skill', () => {
    const tmpDir = makeTmpDir();
    try {
      spawnSync(process.execPath, [SCRIPT, '--local'], {
        encoding: 'utf8', timeout: 15000, cwd: tmpDir, env: { ...process.env },
      });

      const skillsDir = path.join(PKG_ROOT, 'skills');
      const skillDirs = fs.readdirSync(skillsDir).filter(f =>
        fs.statSync(path.join(skillsDir, f)).isDirectory()
      );

      for (const skillDir of skillDirs) {
        const subDirs = fs.readdirSync(path.join(skillsDir, skillDir), { withFileTypes: true })
          .filter(e => e.isDirectory());
        for (const sub of subDirs) {
          const installedSub = path.join(tmpDir, '.claude', 'skills', skillDir, sub.name);
          assert.ok(fs.existsSync(installedSub),
            `skill subdirectory ${skillDir}/${sub.name} should be installed`);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});
