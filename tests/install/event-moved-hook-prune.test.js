'use strict';

// Regression test for FN-16b: a hook whose script is still canonical, but was
// re-registered under a DIFFERENT (event, matcher) than the one shipped in
// hooks.json (e.g. validate-pattern-ack.js moved from PostToolUse:Agent to
// SubagentStop), left a stale duplicate in settings.json forever. The
// existing FN-16 prune only checked a flat "is this basename canonical
// ANYWHERE" set, which is blind to event moves. See bin/install.js mergeHooks()
// canonicalEventBasenames / eventMoved.
//
// This test proves, with one fixture, that mergeHooks():
//   1. Prunes the same-script-different-event stale entry (reason: event_moved).
//   2. Preserves the canonical entry for that script under its real event.
//   3. Preserves a user-added third-party hook in the same stale entry.
//   4. Preserves a hook pointing at a DIFFERENT install root, even though its
//      script and event both match canonical (path-prefix, not basename-only,
//      identifies "ours").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-event-moved-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Runs mergeHooks() in a child process the same way tests/install-prune-stale-hooks.test.js
// does, but captures recordDegradation() calls (written to stdout as JSON lines)
// so we can assert on the pruned reason, not just the resulting settings.json.
function runMerge(targetDir, srcHooksJson) {
  const fixturePkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-event-moved-pkg-'));
  fs.mkdirSync(path.join(fixturePkgRoot, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(fixturePkgRoot, 'hooks', 'hooks.json'), JSON.stringify(srcHooksJson));
  fs.writeFileSync(path.join(fixturePkgRoot, 'package.json'), JSON.stringify({
    name: 'orchestray', version: '0.0.0-test',
  }));
  fs.mkdirSync(path.join(fixturePkgRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(fixturePkgRoot, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'orchestray', version: '0.0.0-test' })
  );

  const installJsPath = path.join(__dirname, '..', '..', 'bin', 'install.js');
  const src = fs.readFileSync(installJsPath, 'utf8');
  const startIdx = src.indexOf('function mergeHooks(');
  assert.ok(startIdx > 0, 'mergeHooks function not found');
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
    function recordDegradation(ev) { process.stdout.write(JSON.stringify(ev) + '\\n'); }
    ${mergeHooksSrc}
    mergeHooks(${JSON.stringify(targetDir)});
  `;
  const tmpScript = path.join(fixturePkgRoot, '_run.js');
  fs.writeFileSync(tmpScript, harness);
  const out = execFileSync(process.execPath, [tmpScript], { encoding: 'utf8' });
  fs.rmSync(fixturePkgRoot, { recursive: true, force: true });
  return out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('install — event-moved hook prune removes only the stale (event,matcher) duplicate', () => {
  withTempDir(targetDir => {
    const orchestrayBin = path.join(targetDir, 'orchestray', 'bin');
    const otherPluginBin = path.join(targetDir, 'other-plugin', 'bin');
    const otherInstallBin = path.join(targetDir, 'other-install', 'orchestray', 'bin');
    fs.mkdirSync(orchestrayBin, { recursive: true });
    fs.writeFileSync(path.join(orchestrayBin, 'validate-pattern-ack.js'), '// stub\n');
    fs.mkdirSync(otherInstallBin, { recursive: true });
    fs.writeFileSync(path.join(otherInstallBin, 'validate-pattern-ack.js'), '// stub\n');

    const settings = {
      hooks: {
        // Canonical entry only — kept as its own event so the pre-existing
        // G-04 hook-chain reorder pass (unrelated to this fix) doesn't also
        // walk it; that pass classifies "ours" by substring match on
        // 'orchestray' in the command rather than path-prefix, so two
        // same-basename peers under one canonical (event, matcher) collapse
        // to one there — a separate latent bug, reported but not fixed here
        // (out of scope: this task owns the prune sweep, not the reorder pass).
        SubagentStop: [
          {
            hooks: [
              { type: 'command', command: `node "${path.join(orchestrayBin, 'validate-pattern-ack.js')}"` },
            ],
          },
        ],
        // PostToolUse:Agent is NOT declared in canonical hooks.json (see
        // srcHooksJson below), so it is untouched by the reorder pass and by
        // the cross-install-dedup sweep — isolating exactly what this test
        // exercises: the FN-16 prune sweep's own path-prefix + event-moved logic.
        PostToolUse: [
          {
            matcher: 'Agent',
            hooks: [
              { type: 'command', command: `node "${path.join(orchestrayBin, 'validate-pattern-ack.js')}"` }, // stale: event moved
              { type: 'command', command: `node "${path.join(otherPluginBin, 'lint.js')}"` }, // third-party
              { type: 'command', command: `node "${path.join(otherInstallBin, 'validate-pattern-ack.js')}"` }, // other install root
            ],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(targetDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const srcHooksJson = {
      hooks: {
        SubagentStop: [
          { hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-pattern-ack.js' }] },
        ],
      },
    };

    const events = runMerge(targetDir, srcHooksJson);
    const after = JSON.parse(fs.readFileSync(path.join(targetDir, 'settings.json'), 'utf8'));

    // 1. Canonical entry survives untouched.
    const subagentStopHooks = after.hooks.SubagentStop[0].hooks;
    assert.equal(subagentStopHooks.length, 1, 'canonical entry survives');
    assert.match(subagentStopHooks[0].command, /orchestray[\\/]bin[\\/]validate-pattern-ack\.js/);

    // 2. PostToolUse:Agent retains the third-party hook AND the other-install-root
    //    peer — only the stale same-script-different-event duplicate is pruned.
    const postToolUseHooks = after.hooks.PostToolUse[0].hooks;
    assert.equal(postToolUseHooks.length, 2, 'third-party + other-install-root hooks both survive');
    assert.ok(postToolUseHooks.some(h => h.command.includes(otherPluginBin)), 'third-party hook is preserved');
    assert.ok(postToolUseHooks.some(h => h.command.includes(otherInstallBin)), 'other install root hook is preserved (path-prefix, not basename, identifies "ours")');

    // 3. Telemetry: exactly one install_stale_hook_pruned event, reason event_moved.
    const pruneEvents = events.filter(e => e.kind === 'install_stale_hook_pruned');
    assert.equal(pruneEvents.length, 1, 'exactly one prune event emitted');
    assert.equal(pruneEvents[0].detail.reason, 'event_moved');
    assert.equal(pruneEvents[0].detail.event, 'PostToolUse');
    assert.equal(pruneEvents[0].detail.matcher, 'Agent');
    assert.equal(pruneEvents[0].detail.basename, 'validate-pattern-ack.js');
  });
});

test('install — event-moved prune is skipped when ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED=1', () => {
  withTempDir(targetDir => {
    const orchestrayBin = path.join(targetDir, 'orchestray', 'bin');
    fs.mkdirSync(orchestrayBin, { recursive: true });
    fs.writeFileSync(path.join(orchestrayBin, 'validate-pattern-ack.js'), '// stub\n');

    const settings = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Agent',
            hooks: [
              { type: 'command', command: `node "${path.join(orchestrayBin, 'validate-pattern-ack.js')}"` },
            ],
          },
        ],
      },
    };
    fs.writeFileSync(path.join(targetDir, 'settings.json'), JSON.stringify(settings, null, 2));

    const srcHooksJson = {
      hooks: {
        SubagentStop: [
          { hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/bin/validate-pattern-ack.js' }] },
        ],
      },
    };

    const prevEnv = process.env.ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED;
    process.env.ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED = '1';
    try {
      runMerge(targetDir, srcHooksJson);
    } finally {
      if (prevEnv === undefined) delete process.env.ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED;
      else process.env.ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED = prevEnv;
    }

    const after = JSON.parse(fs.readFileSync(path.join(targetDir, 'settings.json'), 'utf8'));
    assert.equal(after.hooks.PostToolUse[0].hooks.length, 1,
      'stale entry survives when the FN-16 prune gate is disabled — same gate as file_missing/no_longer_canonical');
  });
});
