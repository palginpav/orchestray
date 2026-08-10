'use strict';

/**
 * v2.3.24 Item 1 regression: hook-reorder convergence.
 *
 * `hooks/hooks.json` defines many canonical entries per event sharing one
 * matcher (e.g. 12 SubagentStop entries, all matcher:undefined), while the
 * append phase in mergeHooks merges same-matcher entries into a SINGLE live
 * entry. The old reorder loop resolved every canonical entry against that
 * one live entry and rewrote it each iteration — so each install just moved
 * a different hook to the front and the loop never converged. Live evidence:
 * SubagentStop ran with `detect-tool-grant-shortfall.js` first and
 * `emit-orchestration-complete.js` last — the exact reverse of canonical.
 *
 * Cases:
 *   1. reversed_order_converges_to_canonical — seed a single merged
 *      SubagentStop entry in the exact reverse of canonical order, run
 *      install, assert the resulting order matches canonical exactly.
 *   2. second_run_emits_zero_corrections — re-running mergeHooks (via
 *      install) over the first run's output must emit zero
 *      install_hook_order_corrected records for SubagentStop.
 *   3. idempotent_across_three_runs — a third consecutive run is also silent.
 *   4. already_canonical_produces_no_record_and_no_write — a fresh install
 *      (already in canonical order) triggers no correction record.
 *   5. user_added_hook_survives_reorder — an extra, non-canonical Orchestray
 *      hook basename present in the live entry is preserved (as an
 *      "orphaned" trailing hook), never dropped, across the reorder.
 */

const { test, describe, after } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const INSTALL_JS = path.join(REPO_ROOT, 'bin', 'install.js');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const NODE       = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2324-hookorder-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-v2324-hookorder-test' }),
    'utf8',
  );
  return dir;
}

/** Run install.js --local against tmp target (never the repo cwd — avoids
 * feeding the hook-fixture-parity capture, per project convention). */
function runInstall(targetDir, env) {
  const r = cp.spawnSync(NODE, [INSTALL_JS, '--local'], {
    cwd:      targetDir,
    env:      Object.assign({}, process.env, { HOME: targetDir }, env || {}),
    encoding: 'utf8',
    timeout:  30_000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readSettings(tmpDir) {
  const p = path.join(tmpDir, '.claude', 'settings.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeSettings(tmpDir, settings) {
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8',
  );
}

function readDegraded(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (_e) { return []; }
}

function clearDegraded(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
  try { fs.writeFileSync(p, '', 'utf8'); } catch (_e) { /* ignore */ }
}

function hookBasename(cmd) {
  const m = (cmd || '').match(/\/bin\/([^\s"']+)/);
  return m ? path.basename(m[1]) : null;
}

/** Flatten canonical hooks/hooks.json[event] into an ordered basename list,
 * mirroring the merged-per-matcher grouping the fix performs. Only handles
 * matcher:undefined groups (sufficient for SubagentStop, used throughout). */
function canonicalBasenamesForEvent(event) {
  const data = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const entries = (data.hooks || {})[event] || [];
  const names = [];
  for (const entry of entries) {
    if (entry.matcher !== undefined) continue;
    for (const h of (entry.hooks || [])) {
      const cmd = h.command || '';
      // Match production's hookBasename2: stop at first whitespace, not end
      // of string — commands may carry trailing args (e.g. "... stop").
      const m = cmd.match(/\/bin\/([^\s"']+)/);
      if (m) names.push(path.basename(m[1]));
    }
  }
  return names;
}

/** Rewrite a canonical `${CLAUDE_PLUGIN_ROOT}/bin/...` command template into
 * an installed-shape command pointing at tmpDir's install bin/. */
function rewriteCommand(cmdTemplate, tmpDir) {
  const m = cmdTemplate.match(/^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/(\S+)(.*)$/);
  if (!m) return cmdTemplate;
  const fullPath = path.join(tmpDir, '.claude', 'orchestray', 'bin', m[1]);
  return `node ${JSON.stringify(fullPath)}${m[2]}`;
}

/** Build a single merged SubagentStop live entry (matcher:undefined) whose
 * hooks are ORDERED per `order` (an array of basenames). */
function seedSubagentStopOrder(tmpDir, order) {
  const data = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  const canonical = data.hooks.SubagentStop.filter(e => e.matcher === undefined);
  const byBasename = new Map();
  for (const entry of canonical) {
    for (const h of (entry.hooks || [])) {
      const base = hookBasename((rewriteCommand(h.command, tmpDir)));
      byBasename.set(base, Object.assign({}, h, { command: rewriteCommand(h.command, tmpDir) }));
    }
  }
  const hooks = order.map(base => byBasename.get(base)).filter(Boolean);
  const settings = { hooks: { SubagentStop: [{ hooks }] } };
  writeSettings(tmpDir, settings);
  return hooks;
}

function getSubagentStopOrder(settings) {
  const entries = (settings.hooks && settings.hooks.SubagentStop) || [];
  const names = [];
  for (const entry of entries) {
    for (const h of (entry.hooks || [])) {
      const base = hookBasename(h.command);
      if (base) names.push(base);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

describe('v2.3.24 Item 1 — hook reorder convergence', () => {

  test('reversed_order_converges_to_canonical: SubagentStop reverse seed reorders to exact canonical order in one run', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    const canonical = canonicalBasenamesForEvent('SubagentStop');
    assert.ok(canonical.length >= 2, 'sanity: canonical SubagentStop must have multiple hooks');

    seedSubagentStopOrder(tmp, canonical.slice().reverse());
    clearDegraded(tmp);

    const r = runInstall(tmp);
    assert.equal(r.status, 0, 'install failed\nstderr=' + r.stderr);

    const settings = readSettings(tmp);
    const gotOrder = getSubagentStopOrder(settings);
    assert.deepEqual(gotOrder, canonical,
      'SubagentStop order after one install must match canonical exactly.\n' +
      'got=' + JSON.stringify(gotOrder) + '\nwant=' + JSON.stringify(canonical));

    // Correctness (dimension: exact basename sequence, not "a reorder occurred"):
    // emit-orchestration-complete.js must run FIRST, detect-tool-grant-shortfall.js LAST.
    assert.equal(gotOrder[0], 'emit-orchestration-complete.js');
    assert.equal(gotOrder[gotOrder.length - 1], 'detect-tool-grant-shortfall.js');

    // Exactly one correction record for the whole merged group — not one per
    // canonical entry (the old bug emitted up to N nearly-redundant records).
    const degraded = readDegraded(tmp);
    const corrected = degraded.filter(row =>
      row.kind === 'install_hook_order_corrected' && row.detail && row.detail.event === 'SubagentStop');
    assert.equal(corrected.length, 1,
      'expected exactly one install_hook_order_corrected record for SubagentStop, got ' +
      corrected.length + ': ' + JSON.stringify(corrected));
  });

  test('second_run_emits_zero_corrections: a second mergeHooks run over the first run\'s output converges', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    const canonical = canonicalBasenamesForEvent('SubagentStop');
    seedSubagentStopOrder(tmp, canonical.slice().reverse());

    let r = runInstall(tmp);
    assert.equal(r.status, 0, 'first install failed\nstderr=' + r.stderr);

    clearDegraded(tmp);
    r = runInstall(tmp);
    assert.equal(r.status, 0, 'second install failed\nstderr=' + r.stderr);

    const degraded = readDegraded(tmp);
    const corrected = degraded.filter(row => row.kind === 'install_hook_order_corrected');
    assert.equal(corrected.length, 0,
      'second run must emit zero correction records; got: ' + JSON.stringify(corrected));

    const settings = readSettings(tmp);
    assert.deepEqual(getSubagentStopOrder(settings), canonical,
      'order must remain canonical after the second run');
  });

  test('idempotent_across_three_runs: three consecutive installs all converge', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    const canonical = canonicalBasenamesForEvent('SubagentStop');
    // Start from a non-trivial, non-reversed drift (partial rotation) rather
    // than a clean reversal — the diagnosis warns that some events reflect
    // incremental append history, not a pure reversal.
    const rotated = canonical.slice(3).concat(canonical.slice(0, 3));
    seedSubagentStopOrder(tmp, rotated);

    for (let i = 1; i <= 3; i++) {
      clearDegraded(tmp);
      const r = runInstall(tmp);
      assert.equal(r.status, 0, `run ${i} failed\nstderr=` + r.stderr);
    }

    const settings = readSettings(tmp);
    assert.deepEqual(getSubagentStopOrder(settings), canonical,
      'order must converge to canonical after repeated installs');

    // One more run for good measure: must be fully silent.
    clearDegraded(tmp);
    const r = runInstall(tmp);
    assert.equal(r.status, 0);
    const degraded = readDegraded(tmp);
    assert.equal(
      degraded.filter(row => row.kind === 'install_hook_order_corrected').length, 0,
      'steady state must stay silent'
    );
  });

  test('already_canonical_produces_no_record_and_no_write: fresh install triggers no correction', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    const r = runInstall(tmp);
    assert.equal(r.status, 0, 'fresh install failed\nstderr=' + r.stderr);

    const degraded = readDegraded(tmp);
    const corrected = degraded.filter(row => row.kind === 'install_hook_order_corrected');
    assert.equal(corrected.length, 0,
      'a fresh install (already canonical) must not emit any correction record; got: ' +
      JSON.stringify(corrected));
  });

  test('user_added_hook_survives_reorder: a non-canonical Orchestray-namespaced hook is preserved, not dropped', () => {
    const tmp = makeTmpTarget();
    tmpDirs.push(tmp);
    const canonical = canonicalBasenamesForEvent('SubagentStop');
    const hooks = seedSubagentStopOrder(tmp, canonical.slice().reverse());

    // Inject a synthetic orchestray-namespaced hook basename not present in
    // canonical hooks.json — simulates a script from a prior version that
    // was not yet pruned, or a user-added script under the orchestray dir.
    const settings = readSettings(tmp);
    const userHook = {
      type: 'command',
      command: `node ${JSON.stringify(path.join(tmp, '.claude', 'orchestray', 'bin', 'my-custom-hook.js'))}`,
      timeout: 5,
    };
    settings.hooks.SubagentStop[0].hooks.push(userHook);
    writeSettings(tmp, settings);
    clearDegraded(tmp);

    // FN-16's separate stale-hook prune sweep would remove this synthetic
    // hook for pointing at a script file that does not exist on disk — a
    // different feature, out of scope here. Its own kill switch
    // (ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED, documented for exactly this
    // "user hand-added an extra Orchestray-namespaced hook" case) isolates
    // the reorder step's own no-drop guarantee, which is what this test
    // targets.
    const r = runInstall(tmp, { ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED: '1' });
    assert.equal(r.status, 0, 'install failed\nstderr=' + r.stderr);

    const after = readSettings(tmp);
    const gotOrder = getSubagentStopOrder(after);
    assert.ok(gotOrder.includes('my-custom-hook.js'),
      'user-added hook must survive the reorder, got order: ' + JSON.stringify(gotOrder));
    // Canonical hooks lead, orphaned (non-canonical) hooks trail — never dropped.
    assert.deepEqual(gotOrder.slice(0, canonical.length), canonical,
      'canonical hooks must lead in canonical order');
    assert.equal(gotOrder[gotOrder.length - 1], 'my-custom-hook.js',
      'orphaned user hook must trail the canonical block, not be dropped');

    // Convergence still holds with the orphaned hook present (same prune
    // isolation as above, so the hook is still there to prove convergence
    // doesn't need to touch it).
    clearDegraded(tmp);
    const r2 = runInstall(tmp, { ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED: '1' });
    assert.equal(r2.status, 0);
    const degraded = readDegraded(tmp);
    assert.equal(
      degraded.filter(row => row.kind === 'install_hook_order_corrected').length, 0,
      'presence of an orphaned user hook must not prevent convergence'
    );
  });
});
