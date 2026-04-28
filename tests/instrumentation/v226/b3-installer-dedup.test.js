'use strict';

/**
 * Test B3 (installer): dedup-plugin-hooks.js removes tokenwright entries from
 * both global and local settings.json files while preserving custom user hooks.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { dedupPluginHooks } = require('../../../bin/_lib/dedup-plugin-hooks');

// ---------------------------------------------------------------------------
// Helper: isolated tmp dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-b3-installer-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Test 1: tokenwright entries removed from both settings files; custom hook preserved
// ---------------------------------------------------------------------------
test('B3-installer-dedup: removes tokenwright entries from global and project settings.json', (t) => {
  const tmpDir = makeTmpDir(t);

  // Create a fake pkg root with a hooks.json manifest
  const pkgRoot = path.join(tmpDir, 'orchestray');
  fs.mkdirSync(path.join(pkgRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'bin'),   { recursive: true });

  const injectScript   = path.join(pkgRoot, 'bin', 'inject-tokenwright.js');
  const captureScript  = path.join(pkgRoot, 'bin', 'capture-tokenwright-realized.js');

  // Write stub script files (dedup-plugin-hooks only reads their paths, not content)
  fs.writeFileSync(injectScript,  '', 'utf8');
  fs.writeFileSync(captureScript, '', 'utf8');

  const manifestPath = path.join(pkgRoot, 'hooks', 'hooks.json');
  writeJson(manifestPath, {
    hooks: {
      PreToolUse: [{ hooks: [{ command: injectScript }] }],
      SubagentStop: [{ hooks: [{ command: captureScript }] }],
    }
  });

  // Global settings with tokenwright entry that must be removed
  const globalSettingsPath = path.join(tmpDir, 'global-claude', 'settings.json');
  writeJson(globalSettingsPath, {
    hooks: {
      PreToolUse: [
        { hooks: [{ command: injectScript }] }
      ]
    }
  });

  // Project settings with tokenwright entry AND a custom user hook
  const projectSettingsPath = path.join(tmpDir, 'local-claude', 'settings.json');
  writeJson(projectSettingsPath, {
    hooks: {
      PreToolUse: [
        { hooks: [{ command: injectScript }] }
      ],
      SubagentStop: [
        { hooks: [{ command: '/my/custom/post-hook.js' }] }  // must be preserved
      ]
    }
  });

  const result = dedupPluginHooks({
    globalSettingsPath,
    projectSettingsPath,
    pluginManifestPath: manifestPath,
  });

  assert.ok(typeof result === 'object', 'must return a result object');
  const totalRemoved = (result.globalEntriesRemoved || 0) + (result.projectEntriesRemoved || 0);
  assert.ok(totalRemoved >= 1, 'must have removed at least 1 tokenwright entry');

  // Global: tokenwright entry gone
  const globalAfter = readJson(globalSettingsPath);
  const globalPreCmds = (
    (globalAfter.hooks && globalAfter.hooks.PreToolUse) || []
  ).flatMap(g => (g.hooks || []).map(h => h.command || ''));
  assert.equal(
    globalPreCmds.some(cmd => cmd.includes('inject-tokenwright.js')),
    false,
    'global settings must not contain inject-tokenwright.js after dedup'
  );

  // Project: tokenwright gone, custom hook preserved
  const localAfter = readJson(projectSettingsPath);
  const localPreCmds = (
    (localAfter.hooks && localAfter.hooks.PreToolUse) || []
  ).flatMap(g => (g.hooks || []).map(h => h.command || ''));
  assert.equal(
    localPreCmds.some(cmd => cmd.includes('inject-tokenwright.js')),
    false,
    'project settings must not contain inject-tokenwright.js after dedup'
  );

  const localSubCmds = (
    (localAfter.hooks && localAfter.hooks.SubagentStop) || []
  ).flatMap(g => (g.hooks || []).map(h => h.command || ''));
  assert.ok(
    localSubCmds.some(cmd => cmd.includes('/my/custom/post-hook.js')),
    'custom user hook must be preserved after dedup'
  );
});

// ---------------------------------------------------------------------------
// Test 3: quoted-command form — settings.json commands wrapped in double quotes
// (e.g. node "/abs/path/orchestray/bin/inject-tokenwright.js") must be matched
// and removed. This guards against regression of Finding #1 (basename extractor
// previously returned 'inject-tokenwright.js"' with trailing quote, failing the
// Set lookup).
// ---------------------------------------------------------------------------
test('B3-installer-dedup: removes entries with quoted command strings (node "...")', (t) => {
  const tmpDir = makeTmpDir(t);

  // Use a path that contains /orchestray/bin/ so isOrchestrayManagedHook matches
  const pkgRoot = path.join(tmpDir, 'orchestray');
  fs.mkdirSync(path.join(pkgRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'bin'),   { recursive: true });

  const injectScript  = path.join(pkgRoot, 'bin', 'inject-tokenwright.js');
  const captureScript = path.join(pkgRoot, 'bin', 'capture-tokenwright-realized.js');
  fs.writeFileSync(injectScript,  '', 'utf8');
  fs.writeFileSync(captureScript, '', 'utf8');

  const manifestPath = path.join(pkgRoot, 'hooks', 'hooks.json');
  writeJson(manifestPath, {
    hooks: {
      PreToolUse:   [{ hooks: [{ command: injectScript }] }],
      SubagentStop: [{ hooks: [{ command: captureScript }] }],
    }
  });

  // Simulate realistic settings.json shape: command wrapped in double quotes
  // as written by the installer when paths contain spaces or for portability.
  const quotedInject  = `node "${injectScript}"`;
  const quotedCapture = `node "${captureScript}"`;

  const globalSettingsPath = path.join(tmpDir, 'global3', 'settings.json');
  writeJson(globalSettingsPath, {
    hooks: {
      PreToolUse:   [{ hooks: [{ command: quotedInject }] }],
      SubagentStop: [{ hooks: [{ command: quotedCapture }] }],
    }
  });

  const projectSettingsPath = path.join(tmpDir, 'local3', 'settings.json');
  writeJson(projectSettingsPath, {
    hooks: {
      PreToolUse: [{ hooks: [{ command: quotedInject }] }],
    }
  });

  const result = dedupPluginHooks({
    globalSettingsPath,
    projectSettingsPath,
    pluginManifestPath: manifestPath,
  });

  assert.ok(typeof result === 'object', 'must return a result object');
  const totalRemoved = (result.globalEntriesRemoved || 0) + (result.projectEntriesRemoved || 0);
  assert.ok(totalRemoved >= 1, `must have removed at least 1 quoted-command entry (got ${totalRemoved})`);

  // Global: both quoted entries gone
  const globalAfter = readJson(globalSettingsPath);
  const globalPreCmds = ((globalAfter.hooks && globalAfter.hooks.PreToolUse) || [])
    .flatMap(g => (g.hooks || []).map(h => h.command || ''));
  const globalSubCmds = ((globalAfter.hooks && globalAfter.hooks.SubagentStop) || [])
    .flatMap(g => (g.hooks || []).map(h => h.command || ''));
  assert.equal(
    globalPreCmds.some(cmd => cmd.includes('inject-tokenwright.js')),
    false,
    'global settings: inject-tokenwright.js must be removed even when quoted'
  );
  assert.equal(
    globalSubCmds.some(cmd => cmd.includes('capture-tokenwright-realized.js')),
    false,
    'global settings: capture-tokenwright-realized.js must be removed even when quoted'
  );

  // Project: quoted inject entry gone
  const localAfter = readJson(projectSettingsPath);
  const localPreCmds = ((localAfter.hooks && localAfter.hooks.PreToolUse) || [])
    .flatMap(g => (g.hooks || []).map(h => h.command || ''));
  assert.equal(
    localPreCmds.some(cmd => cmd.includes('inject-tokenwright.js')),
    false,
    'project settings: inject-tokenwright.js must be removed even when quoted'
  );
});

// ---------------------------------------------------------------------------
// Test 2: re-run is idempotent (no further removals when already clean)
// ---------------------------------------------------------------------------
test('B3-installer-dedup: re-running on already-clean settings is a no-op', (t) => {
  const tmpDir = makeTmpDir(t);

  const pkgRoot = path.join(tmpDir, 'orchestray2');
  fs.mkdirSync(path.join(pkgRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, 'bin'),   { recursive: true });

  const injectScript  = path.join(pkgRoot, 'bin', 'inject-tokenwright.js');
  const captureScript = path.join(pkgRoot, 'bin', 'capture-tokenwright-realized.js');
  fs.writeFileSync(injectScript,  '', 'utf8');
  fs.writeFileSync(captureScript, '', 'utf8');

  const manifestPath = path.join(pkgRoot, 'hooks', 'hooks.json');
  writeJson(manifestPath, {
    hooks: {
      PreToolUse: [{ hooks: [{ command: injectScript }] }],
      SubagentStop: [{ hooks: [{ command: captureScript }] }],
    }
  });

  // Settings with only a non-orchestray hook (already clean)
  const cleanPath = path.join(tmpDir, 'clean-claude', 'settings.json');
  writeJson(cleanPath, {
    hooks: {
      PreToolUse: [{ hooks: [{ command: '/other/hook.js' }] }]
    }
  });

  const result = dedupPluginHooks({
    globalSettingsPath:  cleanPath,
    projectSettingsPath: cleanPath,
    pluginManifestPath:  manifestPath,
  });

  assert.equal(result.globalEntriesRemoved, 0,   'global: 0 removals on clean settings');
  // projectEntries may show 0 since same file
  const total = (result.globalEntriesRemoved || 0) + (result.projectEntriesRemoved || 0);
  assert.equal(total, 0, 'total removals must be 0 on already-clean settings');

  const after = readJson(cleanPath);
  const cmds = ((after.hooks && after.hooks.PreToolUse) || []).flatMap(g =>
    (g.hooks || []).map(h => h.command || '')
  );
  assert.ok(cmds.includes('/other/hook.js'), 'non-orchestray hook must still be present');
});
