'use strict';

// Regression test for the forward-compat installer fix.
//
// Background: when a user rolls back from a later Orchestray version, the
// previous install registered hooks in settings.json that pointed at scripts
// (e.g. gate-router-solo-edit.js, capture-pm-router-stop.js) which the
// current install does not ship. Claude Code fires those hooks anyway and
// reports a non-blocking MODULE_NOT_FOUND on every Edit/Write/SubagentStop.
//
// The installer now prunes orchestray-origin hooks whose script does not
// exist on disk before merging in the current install's hooks.
//
// What this test verifies:
//   1. mergeHooks() removes hooks whose orchestray/bin/<script>.js path is
//      missing on disk.
//   2. mergeHooks() leaves orchestray-origin hooks whose script exists.
//   3. mergeHooks() does NOT touch non-orchestray hooks (other plugins).
//   4. Empty entry arrays and empty event keys are cleaned up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-prune-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Build a minimal pseudo-install layout the installer can target. We do NOT
// invoke the full installer (it's interactive and copies large amounts of
// repo state). Instead we construct settings.json + hooks/hooks.json + a
// fake orchestray/bin/ directory containing only the scripts we want to
// keep, then run mergeHooks via a small shim.
function makeFixture(targetDir, opts) {
  const orchestrayDir = path.join(targetDir, 'orchestray');
  const binDir = path.join(orchestrayDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  // Emit existing scripts.
  for (const script of opts.existingScripts) {
    fs.writeFileSync(path.join(binDir, script), '// stub\n');
  }
  // Emit the stale hooks fixture into settings.json.
  const settings = { hooks: opts.existingHooks };
  fs.writeFileSync(path.join(targetDir, 'settings.json'), JSON.stringify(settings, null, 2));
  return { orchestrayDir, binDir, settingsFile: path.join(targetDir, 'settings.json') };
}

// Run the installer's mergeHooks() in isolation by spawning a Node child
// that requires install.js, swaps its module-scoped `pkgRoot` to point at a
// fixture pkg, and calls mergeHooks against our temp targetDir. We can't
// use require() in-process because install.js has top-level side effects
// (parses argv, writes to console).
function runMerge(targetDir, srcHooksJson) {
  const fixturePkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-prune-pkg-'));
  fs.mkdirSync(path.join(fixturePkgRoot, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(fixturePkgRoot, 'hooks', 'hooks.json'),
    JSON.stringify(srcHooksJson)
  );
  // Minimal package.json + plugin.json so install.js's pkgRoot detection
  // settles on the fixture.
  fs.writeFileSync(path.join(fixturePkgRoot, 'package.json'), JSON.stringify({
    name: 'orchestray', version: '0.0.0-test',
  }));
  fs.mkdirSync(path.join(fixturePkgRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(fixturePkgRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'orchestray', version: '0.0.0-test' })
  );

  const installJsPath = path.join(__dirname, '..', 'bin', 'install.js');
  // Read install.js, extract just the mergeHooks function + its sibling
  // helpers, eval it in a fresh context with a fake pkgRoot.
  const src = fs.readFileSync(installJsPath, 'utf8');
  // Find the mergeHooks function block.
  const startIdx = src.indexOf('function mergeHooks(');
  assert.ok(startIdx > 0, 'mergeHooks function not found');
  // Find the matching closing brace by tracking depth from after the (
  const openParen = src.indexOf('{', startIdx);
  let depth = 1, i = openParen + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  const mergeHooksSrc = src.slice(startIdx, i);

  const harness = `
    'use strict';
    const fs = require('fs');
    const path = require('path');
    const pkgRoot = ${JSON.stringify(fixturePkgRoot)};
    function recordDegradation() {} // installer hook stub
    ${mergeHooksSrc}
    mergeHooks(${JSON.stringify(targetDir)});
  `;
  const tmpScript = path.join(fixturePkgRoot, '_run.js');
  fs.writeFileSync(tmpScript, harness);
  const out = execFileSync(process.execPath, [tmpScript], { encoding: 'utf8' });
  fs.rmSync(fixturePkgRoot, { recursive: true, force: true });
  return out;
}

test('install — pruneStaleOrchestrayHooks removes hooks pointing at missing scripts', () => {
  withTempDir(targetDir => {
    const orchestrayBin = path.join(targetDir, 'orchestray', 'bin');
    const fixture = makeFixture(targetDir, {
      existingScripts: ['validate-schema-emit.js'], // only this one is alive
      existingHooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [
              { type: 'command', command: `node "${path.join(orchestrayBin, 'validate-schema-emit.js')}"` },
              { type: 'command', command: `node "${path.join(orchestrayBin, 'gate-router-solo-edit.js')}"` }, // stale
            ],
          },
        ],
        SubagentStop: [
          {
            hooks: [
              { type: 'command', command: `node "${path.join(orchestrayBin, 'capture-pm-router-stop.js')}"` }, // stale
              { type: 'command', command: `node "${path.join(orchestrayBin, 'validate-no-solo-violation.js')}"` }, // stale
            ],
          },
        ],
      },
    });

    runMerge(targetDir, { hooks: {} });
    const after = JSON.parse(fs.readFileSync(fixture.settingsFile, 'utf8'));

    // PreToolUse should retain only validate-schema-emit.js
    const preEntries = (after.hooks.PreToolUse || []);
    assert.equal(preEntries.length, 1, 'one PreToolUse entry should remain');
    assert.equal(preEntries[0].hooks.length, 1, 'one hook should remain in that entry');
    assert.match(preEntries[0].hooks[0].command, /validate-schema-emit\.js/);

    // SubagentStop should be entirely gone (both hooks were stale → empty
    // entry → removed → empty event key → removed)
    assert.equal(after.hooks.SubagentStop, undefined,
      'SubagentStop event key should be removed when all entries pruned');
  });
});

test('install — pruneStaleOrchestrayHooks does NOT touch non-orchestray hooks', () => {
  withTempDir(targetDir => {
    const orchestrayBin = path.join(targetDir, 'orchestray', 'bin');
    const otherPluginBin = path.join(targetDir, 'other-plugin', 'bin');
    const fixture = makeFixture(targetDir, {
      existingScripts: [], // no orchestray scripts shipped
      existingHooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              // Other plugin's hook with a missing script — must NOT be pruned.
              { type: 'command', command: `node "${path.join(otherPluginBin, 'lint.js')}"` },
              // Orchestray hook with missing script — MUST be pruned.
              { type: 'command', command: `node "${path.join(orchestrayBin, 'validate-schema-emit.js')}"` },
            ],
          },
        ],
      },
    });

    runMerge(targetDir, { hooks: {} });
    const after = JSON.parse(fs.readFileSync(fixture.settingsFile, 'utf8'));
    const preHooks = after.hooks.PreToolUse[0].hooks;
    assert.equal(preHooks.length, 1, 'other-plugin hook must remain even though its script is missing');
    assert.match(preHooks[0].command, /other-plugin/);
  });
});

test('install — pruneStaleOrchestrayHooks is a no-op when all orchestray hooks are alive', () => {
  withTempDir(targetDir => {
    const orchestrayBin = path.join(targetDir, 'orchestray', 'bin');
    const fixture = makeFixture(targetDir, {
      existingScripts: ['hook-a.js', 'hook-b.js'],
      existingHooks: {
        SubagentStop: [
          {
            hooks: [
              { type: 'command', command: `node "${path.join(orchestrayBin, 'hook-a.js')}"` },
              { type: 'command', command: `node "${path.join(orchestrayBin, 'hook-b.js')}"` },
            ],
          },
        ],
      },
    });

    runMerge(targetDir, { hooks: {} });
    const after = JSON.parse(fs.readFileSync(fixture.settingsFile, 'utf8'));
    assert.equal(after.hooks.SubagentStop[0].hooks.length, 2,
      'all alive hooks must be preserved (and not duplicated)');
  });
});
