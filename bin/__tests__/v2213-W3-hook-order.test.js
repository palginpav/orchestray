'use strict';

/**
 * v2213-W3-hook-order.test.js — Hook-order determinism tests (G-03 + G-04, v2.2.13 W3).
 *
 * Tests the install-time reorder step in bin/install.js (mergeHooks extension)
 * and the SessionStart drift validator in bin/validate-hook-order.js.
 *
 * 9 mandatory cases:
 *   1. Layout A (no peers, drift): reorders live to canonical; emits install_hook_order_corrected.
 *   2. Layout C (peers contiguous after, drift): reorders orchestray slice; preserves peer at tail.
 *   3. Layout B (peers contiguous before, drift): reorders orchestray slice; preserves peer at head.
 *   4. Layout D (interleaved, no orchestray drift): no reorder, no skipped_interleaved for that matcher.
 *   5. Layout D (interleaved, drift): no reorder; emits install_hook_order_skipped_interleaved + stderr.
 *   6. No drift: no install_hook_order_corrected for the target matcher.
 *   7. SessionStart validator drift: emits hook_chain_drift_detected, exit 0.
 *   8. SessionStart validator kill switch: ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED=1 → exit 0, no emit.
 *   9. Install kill switch (Layout A): ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED=1 skips reorder;
 *      Layout D still emits the interleaved warn even with kill switch set.
 *
 * Runner: node --test bin/__tests__/v2213-W3-hook-order.test.js
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const INSTALL_JS   = path.join(REPO_ROOT, 'bin', 'install.js');
const VALIDATOR_JS = path.join(REPO_ROOT, 'bin', 'validate-hook-order.js');
const NODE         = process.execPath;

// The (event, matcher) group we manipulate in most tests.
const TEST_EVENT   = 'PreToolUse';
const TEST_MATCHER = 'Agent|Explore|Task';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2213-w3-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-w3-test' }),
    'utf8',
  );
  return dir;
}

function runRealInstall(targetDir, envOverrides = {}) {
  const baseEnv = Object.assign({}, process.env);
  delete baseEnv.ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED;
  const r = cp.spawnSync(
    NODE,
    [INSTALL_JS, '--local'],
    {
      cwd:      targetDir,
      env:      Object.assign({}, baseEnv, { HOME: targetDir }, envOverrides),
      encoding: 'utf8',
      timeout:  20000,
    }
  );
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readSettings(tmpDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf8'));
  } catch (_) { return null; }
}

function readJournal(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function clearJournal(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
  try { fs.writeFileSync(p, '', 'utf8'); } catch (_) {}
}

/**
 * Find the AgentEntry (PreToolUse: Agent|Explore|Task) from a settings object.
 * Returns null if not found.
 */
function getAgentEntry(settings) {
  const ptu = settings && settings.hooks && settings.hooks[TEST_EVENT];
  if (!Array.isArray(ptu)) return null;
  return ptu.find(e => e.matcher === TEST_MATCHER) || null;
}

/**
 * Save mutated settings back to disk.
 */
function saveSettings(tmpDir, settings) {
  fs.writeFileSync(
    path.join(tmpDir, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Find a journal entry for install_hook_order_corrected on the target (event, matcher).
 */
function findCorrected(journal, event, matcher) {
  return journal.find(r =>
    r.kind === 'install_hook_order_corrected' &&
    r.detail && r.detail.event === event && r.detail.matcher === matcher
  );
}

/**
 * Find a journal entry for install_hook_order_skipped_interleaved on the target (event, matcher).
 */
function findSkipped(journal, event, matcher) {
  return journal.find(r =>
    r.kind === 'install_hook_order_skipped_interleaved' &&
    r.detail && r.detail.event === event && r.detail.matcher === matcher
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.2.13 W3 — install hook-order reorder + SessionStart drift validator', () => {

  let tmpDir;
  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  // ── Case 1: Layout A — no peers, drift → auto-reorder ──────────────────
  test('Layout A (no peers, drift): reorders live to canonical; emits install_hook_order_corrected{peer_layout:none, divergence_at_index:0}', () => {
    tmpDir = makeTmpTarget();

    // Fresh install to get canonical settings.json.
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return; // skip if not enough hooks

    const ourHooks = ae.hooks.filter(h => (h.command || '').includes('orchestray'));
    if (ourHooks.length < 2) return;

    // Capture canonical first two positions before swapping.
    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];

    // Swap to simulate drift (Layout A: no peer hooks).
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    saveSettings(tmpDir, settings);
    clearJournal(tmpDir);

    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'second install must succeed');

    const settings2 = readSettings(tmpDir);
    const ae2 = getAgentEntry(settings2);
    assert.ok(ae2, 'AgentEntry must exist after reorder');

    // Canonical order restored.
    assert.strictEqual(ae2.hooks[0].command, h0.command, 'first hook restored to canonical position');
    assert.strictEqual(ae2.hooks[1].command, h1.command, 'second hook restored to canonical position');

    const journal = readJournal(tmpDir);
    const corrected = findCorrected(journal, TEST_EVENT, TEST_MATCHER);
    assert.ok(corrected, 'install_hook_order_corrected must be emitted for PreToolUse:Agent|Explore|Task');
    assert.strictEqual(corrected.detail.peer_layout, 'none', 'peer_layout must be "none" for Layout A');
    assert.strictEqual(corrected.detail.divergence_at_index, 0, 'divergence_at_index must be 0');
    assert.strictEqual(corrected.severity, 'info', 'severity must be info');
  });

  // ── Case 2: Layout C — peers contiguous after, drift ───────────────────
  test('Layout C (peers contiguous after, drift): preserves peer at tail; emits install_hook_order_corrected{peer_layout:after}', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return;

    const ourHooks = ae.hooks.filter(h => (h.command || '').includes('orchestray'));
    if (ourHooks.length < 2) return;

    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];

    // Swap orchestray hooks (drift) + append a peer hook at the end (Layout C).
    const peerHook = { type: 'command', command: 'node /some/other/plugin/bin/peer-gate.js', timeout: 5 };
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    ae.hooks.push(peerHook);
    saveSettings(tmpDir, settings);
    clearJournal(tmpDir);

    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'second install must succeed');

    const settings2 = readSettings(tmpDir);
    const ae2 = getAgentEntry(settings2);
    assert.ok(ae2, 'agentEntry must exist');

    // Peer must still be at the end.
    const lastHook = ae2.hooks[ae2.hooks.length - 1];
    assert.strictEqual(lastHook.command, peerHook.command, 'peer hook must remain at tail');

    // Canonical orchestray order restored.
    assert.strictEqual(ae2.hooks[0].command, h0.command, 'first orch hook restored');
    assert.strictEqual(ae2.hooks[1].command, h1.command, 'second orch hook restored');

    const journal = readJournal(tmpDir);
    const corrected = findCorrected(journal, TEST_EVENT, TEST_MATCHER);
    assert.ok(corrected, 'install_hook_order_corrected must be emitted');
    assert.strictEqual(corrected.detail.peer_layout, 'after', 'peer_layout must be "after"');
  });

  // ── Case 3: Layout B — peers contiguous before, drift ──────────────────
  test('Layout B (peers contiguous before, drift): preserves peer at head; emits install_hook_order_corrected{peer_layout:before}', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return;

    const ourHooks = ae.hooks.filter(h => (h.command || '').includes('orchestray'));
    if (ourHooks.length < 2) return;

    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];

    // Swap orchestray hooks (drift) + prepend a peer hook (Layout B).
    const peerHook = { type: 'command', command: 'node /some/other/plugin/bin/peer-pre.js', timeout: 5 };
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    ae.hooks.unshift(peerHook);
    saveSettings(tmpDir, settings);
    clearJournal(tmpDir);

    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'second install must succeed');

    const settings2 = readSettings(tmpDir);
    const ae2 = getAgentEntry(settings2);
    assert.ok(ae2, 'agentEntry must exist');

    // Peer must be first.
    assert.strictEqual(ae2.hooks[0].command, peerHook.command, 'peer hook must remain at head');
    // Canonical order restored.
    assert.strictEqual(ae2.hooks[1].command, h0.command, 'first orch hook restored');
    assert.strictEqual(ae2.hooks[2].command, h1.command, 'second orch hook restored');

    const journal = readJournal(tmpDir);
    const corrected = findCorrected(journal, TEST_EVENT, TEST_MATCHER);
    assert.ok(corrected, 'install_hook_order_corrected must be emitted');
    assert.strictEqual(corrected.detail.peer_layout, 'before', 'peer_layout must be "before"');
  });

  // ── Case 4: Layout D — interleaved, orchestray order already canonical ──
  test('Layout D (interleaved, no orchestray drift): no install_hook_order_corrected or skipped_interleaved for Agent|Explore|Task', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return;

    // Insert a peer hook BETWEEN first two orchestray hooks (interleaved).
    // Orchestray order remains canonical — only peer breaks interleaving.
    const peerHook = { type: 'command', command: 'node /other/plugin/bin/mid-peer.js', timeout: 5 };
    ae.hooks.splice(1, 0, peerHook);
    saveSettings(tmpDir, settings);
    clearJournal(tmpDir);

    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'second install must succeed');

    const journal = readJournal(tmpDir);
    assert.ok(
      !findCorrected(journal, TEST_EVENT, TEST_MATCHER),
      'install_hook_order_corrected must NOT be emitted for Agent|Explore|Task when orchestray order is canonical'
    );
    assert.ok(
      !findSkipped(journal, TEST_EVENT, TEST_MATCHER),
      'install_hook_order_skipped_interleaved must NOT be emitted when orchestray order matches canonical'
    );
  });

  // ── Case 5: Layout D — interleaved AND drift → warn only, no reorder ───
  test('Layout D (interleaved + drift): no reorder; emits install_hook_order_skipped_interleaved + stderr warn', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return;

    const ourHooks = ae.hooks.filter(h => (h.command || '').includes('orchestray'));
    if (ourHooks.length < 2) return;

    // Swap orchestray hooks (drift) AND insert peer between them (interleaved).
    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];
    const peerHook = { type: 'command', command: 'node /other/plugin/bin/between-peer.js', timeout: 5 };
    // Build: [h1, peerHook, h0, ...rest]
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    ae.hooks.splice(1, 0, peerHook); // insert peer between h1 and h0
    saveSettings(tmpDir, settings);
    clearJournal(tmpDir);

    const res2 = runRealInstall(tmpDir);
    assert.strictEqual(res2.status, 0, 'install must succeed');

    // Must NOT have reordered the target matcher.
    assert.ok(
      !findCorrected(readJournal(tmpDir), TEST_EVENT, TEST_MATCHER),
      'install_hook_order_corrected must NOT be emitted for Layout D'
    );

    // Must have emitted skipped_interleaved for the target matcher.
    const skipped = findSkipped(readJournal(tmpDir), TEST_EVENT, TEST_MATCHER);
    assert.ok(skipped, 'install_hook_order_skipped_interleaved must be emitted for Layout D + drift');
    assert.strictEqual(skipped.severity, 'warn', 'severity must be warn');
    assert.ok(Array.isArray(skipped.detail.peer_basenames), 'peer_basenames must be array');
    assert.ok(skipped.detail.peer_basenames.length > 0, 'peer_basenames must include the peer hook');

    // Must print a stderr warn.
    assert.ok(
      res2.stderr.includes('interleaved') || res2.stderr.includes('not auto-reorder'),
      `expected stderr warn about interleaved hooks, got: ${res2.stderr.slice(0, 300)}`
    );
  });

  // ── Case 6: No drift ────────────────────────────────────────────────────
  test('No drift: install_hook_order_corrected NOT emitted for Agent|Explore|Task', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    clearJournal(tmpDir);

    // Re-run install without any manual drift.
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'second install must succeed');

    const journal = readJournal(tmpDir);
    assert.ok(
      !findCorrected(journal, TEST_EVENT, TEST_MATCHER),
      'install_hook_order_corrected must NOT be emitted for Agent|Explore|Task when no drift'
    );
    assert.ok(
      !findSkipped(journal, TEST_EVENT, TEST_MATCHER),
      'install_hook_order_skipped_interleaved must NOT be emitted for Agent|Explore|Task when no drift'
    );
  });

  // ── Case 7: SessionStart validator drift ────────────────────────────────
  test('SessionStart validator: drift emits hook_chain_drift_detected, exit 0', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return;

    // Swap first two hooks to create drift.
    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    saveSettings(tmpDir, settings);

    // Run the validator with stdin that sets cwd to tmpDir.
    const payload = JSON.stringify({ cwd: tmpDir });
    const baseEnv = Object.assign({}, process.env);
    delete baseEnv.ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED;
    const r = cp.spawnSync(NODE, [VALIDATOR_JS], {
      input:    payload,
      cwd:      tmpDir,
      env:      Object.assign({}, baseEnv, { HOME: tmpDir }),
      encoding: 'utf8',
      timeout:  10000,
    });

    assert.strictEqual(r.status, 0, `validator must exit 0 even on drift, stderr: ${r.stderr}`);

    const events = readEvents(tmpDir);
    const driftEvent = events.find(e => e.event_type === 'hook_chain_drift_detected');
    assert.ok(driftEvent, 'hook_chain_drift_detected must be emitted');
    assert.strictEqual(driftEvent.schema_version, 1, 'schema_version must be 1');
    assert.ok(
      typeof driftEvent.divergence_at_index === 'number' || driftEvent.divergence_at_index === null,
      'divergence_at_index must be number or null'
    );
    assert.ok(Array.isArray(driftEvent.canonical_basenames), 'canonical_basenames must be array');
    assert.ok(Array.isArray(driftEvent.live_basenames), 'live_basenames must be array');
    assert.ok(driftEvent.canonical_basenames.length > 0, 'canonical_basenames must be non-empty');
  });

  // ── Case 8: SessionStart validator kill switch ──────────────────────────
  test('SessionStart validator kill switch: ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED=1 → exit 0, no emit', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return;

    // Introduce drift to ensure the validator would fire without kill switch.
    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    saveSettings(tmpDir, settings);

    const payload = JSON.stringify({ cwd: tmpDir });
    const r = cp.spawnSync(NODE, [VALIDATOR_JS], {
      input:    payload,
      cwd:      tmpDir,
      env:      Object.assign({}, process.env, {
        HOME:                                      tmpDir,
        ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED: '1',
      }),
      encoding: 'utf8',
      timeout:  10000,
    });

    assert.strictEqual(r.status, 0, 'must exit 0 with kill switch');
    const events = readEvents(tmpDir);
    assert.ok(
      !events.find(e => e.event_type === 'hook_chain_drift_detected'),
      'hook_chain_drift_detected must NOT be emitted with kill switch'
    );
  });

  // ── Case 9: Install kill switch (Layout A) ──────────────────────────────
  test('Install kill switch: ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED=1 skips Layout A/B/C reorder; Layout D still warns', () => {
    tmpDir = makeTmpTarget();
    assert.strictEqual(runRealInstall(tmpDir).status, 0, 'fresh install must succeed');

    const settings = readSettings(tmpDir);
    const ae = getAgentEntry(settings);
    if (!ae || !ae.hooks || ae.hooks.length < 2) return;

    const ourHooks = ae.hooks.filter(h => (h.command || '').includes('orchestray'));
    if (ourHooks.length < 2) return;

    // Layout B drift: peer at head + swapped orchestray hooks.
    const peerHook = { type: 'command', command: 'node /other/plugin/bin/peer-b.js', timeout: 5 };
    const h0 = ae.hooks[0];
    const h1 = ae.hooks[1];
    ae.hooks[0] = h1;
    ae.hooks[1] = h0;
    ae.hooks.unshift(peerHook);
    saveSettings(tmpDir, settings);
    clearJournal(tmpDir);

    // Run with kill switch.
    const res2 = runRealInstall(tmpDir, { ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED: '1' });
    assert.strictEqual(res2.status, 0, 'install with kill switch must succeed');

    // install_hook_order_corrected must NOT be emitted for the target matcher.
    assert.ok(
      !findCorrected(readJournal(tmpDir), TEST_EVENT, TEST_MATCHER),
      'install_hook_order_corrected must NOT be emitted with kill switch'
    );

    // Order was NOT fixed — peer should still be at head.
    const settings2 = readSettings(tmpDir);
    const ae2 = getAgentEntry(settings2);
    assert.ok(ae2, 'agentEntry must exist');
    assert.strictEqual(
      ae2.hooks[0].command,
      peerHook.command,
      'peer hook must still be at head (reorder skipped)'
    );

    // Part B: Layout D still warns even with kill switch.
    // Create a new tmpDir with Layout D interleaved + drift.
    const tmpDir2 = makeTmpTarget();
    try {
      assert.strictEqual(runRealInstall(tmpDir2).status, 0, 'fresh install for LayoutD test must succeed');

      const settings3 = readSettings(tmpDir2);
      const ae3 = getAgentEntry(settings3);
      if (!ae3 || !ae3.hooks || ae3.hooks.length < 2) return;

      const ours3 = ae3.hooks.filter(h => (h.command || '').includes('orchestray'));
      if (ours3.length < 2) return;

      const dPeer = { type: 'command', command: 'node /d/plugin/bin/interleave.js', timeout: 5 };
      const dH0 = ae3.hooks[0];
      const dH1 = ae3.hooks[1];
      ae3.hooks[0] = dH1; // drift
      ae3.hooks[1] = dH0;
      ae3.hooks.splice(1, 0, dPeer); // interleave peer between drifted hooks
      saveSettings(tmpDir2, settings3);
      clearJournal(tmpDir2);

      const resD = runRealInstall(tmpDir2, { ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED: '1' });
      assert.strictEqual(resD.status, 0, 'Layout D install with kill switch must succeed');

      const journalD = readJournal(tmpDir2);
      const skippedD = findSkipped(journalD, TEST_EVENT, TEST_MATCHER);
      assert.ok(
        skippedD,
        'install_hook_order_skipped_interleaved MUST be emitted for Layout D even with kill switch'
      );
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

});
