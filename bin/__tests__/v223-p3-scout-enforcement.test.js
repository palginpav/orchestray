#!/usr/bin/env node
'use strict';

/**
 * v223-p3-scout-enforcement.test.js — Phase 3 W4 enforcement upgrade.
 *
 * Verifies bin/track-scout-decision.js gained three modes:
 *   - "off"   → emits inline_read_observed (legacy P2 W1)
 *   - "warn"  → emits scout_spawn_required, does NOT block
 *   - "block" → emits inline_read_forced AND blocks the Read
 *
 * Plus exempt-path bypass and ORCHESTRAY_SCOUT_BYPASS env override.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'track-scout-decision.js');
const NODE       = process.execPath;

// ---------------------------------------------------------------------------
// Test root scaffolding
// ---------------------------------------------------------------------------

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p3-scout-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  return root;
}

function writeOrchMarker(root, orchId) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function writeConfig(root, cfg) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify(cfg || {}),
    'utf8'
  );
}

function writeFileSized(root, relPath, bytes) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'a'.repeat(bytes), 'utf8');
  return abs;
}

function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  // Strip parent-test bypass if any so the env override test is reliable.
  if (!('ORCHESTRAY_SCOUT_BYPASS' in (opts.env || {}))) {
    delete env.ORCHESTRAY_SCOUT_BYPASS;
  }
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  return r;
}

function readEvents(root) {
  const p = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function scoutEvents(root) {
  return readEvents(root).filter((e) => e.type === 'scout_decision');
}

// ---------------------------------------------------------------------------
// 1. Mode "off" — legacy P2 W1 observe-only
// ---------------------------------------------------------------------------

describe('P3 enforcement — mode "off"', () => {

  test('emits inline_read_observed, allows Read', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-off-1');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'off',
      },
    });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0, 'allow exits 0');
    assert.equal(r.stdout.trim(), '{"continue":true}');

    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'inline_read_observed',
      'mode "off" preserves legacy P2 W1 decision value');
  });

});

// ---------------------------------------------------------------------------
// 2. Mode "warn" (default) — emit + allow
// ---------------------------------------------------------------------------

describe('P3 enforcement — mode "warn" (default)', () => {

  test('emits scout_spawn_required, allows Read', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-warn-1');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'warn',
      },
    });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0, 'warn does NOT block');
    assert.equal(r.stdout.trim(), '{"continue":true}');

    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'scout_spawn_required');
    assert.equal(evs[0].file_bytes, 13000);
  });

  test('default mode (config block omits scout_enforcement) is "warn"', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-warn-default');
    writeConfig(root, { haiku_routing: { scout_min_bytes: 12288 } });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0, 'default warn does not block');

    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'scout_spawn_required',
      'default decision value is scout_spawn_required (warn)');
  });

  test('invalid scout_enforcement value falls back to default "warn"', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-warn-invalid');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'maybe',  // not in enum
      },
    });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0);

    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'scout_spawn_required');
  });

});

// ---------------------------------------------------------------------------
// 3. Mode "block" — emit + block Read
// ---------------------------------------------------------------------------

describe('P3 enforcement — mode "block"', () => {

  test('emits inline_read_forced AND blocks Read (exit 2, continue:false)', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-block-1');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'block',
      },
    });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 2, 'block exits 2');
    const stdout = JSON.parse(r.stdout);
    assert.equal(stdout.continue, false, 'continue:false signals block');
    assert.ok(typeof stdout.reason === 'string' && stdout.reason.startsWith('scout_spawn_required:'),
      'reason starts with scout_spawn_required:');
    assert.ok(/big\.md/.test(stdout.reason), 'reason includes path');
    assert.ok(r.stderr.includes('Section 23'),
      'stderr cites Section 23');
    assert.ok(r.stderr.includes('haiku-scout'),
      'stderr names haiku-scout');
    assert.ok(r.stderr.includes('ORCHESTRAY_SCOUT_BYPASS'),
      'stderr cites bypass env var');
    assert.ok(r.stderr.includes('12288'),
      'stderr includes scout_min_bytes value');
    assert.ok(r.stderr.includes('13000'),
      'stderr includes file_bytes value');

    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'inline_read_forced',
      'block mode emits inline_read_forced');
  });

  test('block mode allows sub-threshold Reads (no enforcement under min_bytes)', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-block-sub');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'block',
      },
    });
    const abs = writeFileSized(root, 'small.md', 1000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0, 'sub-threshold not blocked even in block mode');
    assert.equal(r.stdout.trim(), '{"continue":true}');
    assert.equal(scoutEvents(root).length, 0, 'no event below threshold');
  });

});

// ---------------------------------------------------------------------------
// 4. Exempt paths — bypass enforcement in all modes
// ---------------------------------------------------------------------------

describe('P3 enforcement — exempt paths', () => {

  function exemptCases(mode) {
    return [
      { name: '.orchestray/state/orchestration.md',
        rel:  '.orchestray/state/orchestration.md' },
      { name: '.orchestray/state/state.json',
        rel:  '.orchestray/state/state.json' },
      { name: '.orchestray/config.json',
        rel:  '.orchestray/config.json' },
      { name: 'agents/pm-reference/tier1-orchestration.md',
        rel:  'agents/pm-reference/tier1-orchestration.md' },
    ].map((c) => Object.assign({}, c, { mode }));
  }

  for (const mode of ['off', 'warn', 'block']) {
    for (const c of exemptCases(mode)) {
      test('mode "' + mode + '": ' + c.name + ' is exempt', () => {
        const root = makeRoot();
        writeOrchMarker(root, 'orch-p3-exempt-' + mode);
        writeConfig(root, {
          haiku_routing: {
            scout_min_bytes: 12288,
            scout_enforcement: mode,
          },
        });
        // Note: .orchestray/config.json was already written by writeConfig.
        // For the config.json exempt case, just enlarge the existing file.
        if (c.rel === '.orchestray/config.json') {
          // Pad the config file to be over threshold but stay valid JSON.
          const cfg = {
            haiku_routing: {
              scout_min_bytes: 12288,
              scout_enforcement: mode,
            },
            // Filler key to push size over 12288.
            _filler: 'x'.repeat(13000),
          };
          fs.writeFileSync(
            path.join(root, '.orchestray', 'config.json'),
            JSON.stringify(cfg),
            'utf8'
          );
        } else {
          writeFileSized(root, c.rel, 13000);
        }
        const abs = path.join(root, c.rel);

        const r = runHook({
          tool_name: 'Read',
          cwd: root,
          tool_input: { file_path: abs },
        });
        assert.equal(r.status, 0, 'exempt path always allowed (mode=' + mode + ')');
        assert.equal(r.stdout.trim(), '{"continue":true}');

        const evs = scoutEvents(root);
        assert.equal(evs.length, 1, 'exactly one event for exempt path');
        assert.equal(evs[0].decision, 'exempt_path_observed',
          'exempt paths emit exempt_path_observed (mode=' + mode + ')');
      });
    }
  }

  test('current-orchestration KB artifact is exempt', () => {
    const root = makeRoot();
    const orchId = 'orch-p3-current-orch-kb';
    writeOrchMarker(root, orchId);
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'block',
      },
    });
    // Match the dynamic exempt prefix.
    const rel = '.orchestray/kb/artifacts/' + orchId + '-design.md';
    const abs = writeFileSized(root, rel, 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 0, 'current-orch KB is exempt even in block mode');
    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'exempt_path_observed');
  });

  test('OTHER orchestration KB artifact is NOT exempt (block in block mode)', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-current');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'block',
      },
    });
    // A KB artifact from a DIFFERENT orchestration must NOT match the
    // dynamic prefix (`<current_orch_id>-`).
    const rel = '.orchestray/kb/artifacts/orch-some-other-design.md';
    const abs = writeFileSized(root, rel, 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    });
    assert.equal(r.status, 2, 'foreign KB artifact still blocked');
    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'inline_read_forced');
  });

});

// ---------------------------------------------------------------------------
// 5. ORCHESTRAY_SCOUT_BYPASS=1 disables enforcement (single-session override)
// ---------------------------------------------------------------------------

describe('P3 enforcement — ORCHESTRAY_SCOUT_BYPASS=1', () => {

  test('bypass forces mode "off" — emits inline_read_observed, never blocks', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-bypass-1');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'block',  // would otherwise block
      },
    });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    }, { env: { ORCHESTRAY_SCOUT_BYPASS: '1' } });
    assert.equal(r.status, 0, 'bypass exits 0');
    assert.equal(r.stdout.trim(), '{"continue":true}');

    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'inline_read_observed',
      'bypass forces "off" semantics (legacy decision value)');
  });

  test('bypass also overrides "warn" mode', () => {
    const root = makeRoot();
    writeOrchMarker(root, 'orch-p3-bypass-warn');
    writeConfig(root, {
      haiku_routing: {
        scout_min_bytes: 12288,
        scout_enforcement: 'warn',
      },
    });
    const abs = writeFileSized(root, 'big.md', 13000);

    const r = runHook({
      tool_name: 'Read',
      cwd: root,
      tool_input: { file_path: abs },
    }, { env: { ORCHESTRAY_SCOUT_BYPASS: '1' } });
    assert.equal(r.status, 0);

    const evs = scoutEvents(root);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].decision, 'inline_read_observed',
      'bypass collapses warn to off');
  });

});

// ---------------------------------------------------------------------------
// 6. Module exports — direct unit checks
// ---------------------------------------------------------------------------

describe('P3 enforcement — exported helpers', () => {

  // Clear require cache so we pick up the latest module shape.
  delete require.cache[HOOK_PATH];
  const mod = require(HOOK_PATH);

  test('exports the expected new helpers', () => {
    assert.equal(typeof mod.resolveEnforcementMode, 'function');
    assert.equal(typeof mod.isExemptPath, 'function');
    assert.equal(typeof mod.buildBlockMessage, 'function');
    assert.equal(mod.DEFAULT_ENFORCEMENT_MODE, 'warn',
      'v2.2.3 default is "warn"');
    assert.ok(Array.isArray(mod.STATIC_EXEMPT_PATTERNS));
    assert.ok(mod.STATIC_EXEMPT_PATTERNS.length >= 3);
  });

  test('resolveEnforcementMode: ORCHESTRAY_SCOUT_BYPASS=1 forces "off"', () => {
    const orig = process.env.ORCHESTRAY_SCOUT_BYPASS;
    process.env.ORCHESTRAY_SCOUT_BYPASS = '1';
    try {
      assert.equal(
        mod.resolveEnforcementMode({ haiku_routing: { scout_enforcement: 'block' } }),
        'off'
      );
    } finally {
      if (orig === undefined) delete process.env.ORCHESTRAY_SCOUT_BYPASS;
      else process.env.ORCHESTRAY_SCOUT_BYPASS = orig;
    }
  });

  test('resolveEnforcementMode: missing config → default "warn"', () => {
    const orig = process.env.ORCHESTRAY_SCOUT_BYPASS;
    delete process.env.ORCHESTRAY_SCOUT_BYPASS;
    try {
      assert.equal(mod.resolveEnforcementMode({}), 'warn');
      assert.equal(mod.resolveEnforcementMode(null), 'warn');
    } finally {
      if (orig !== undefined) process.env.ORCHESTRAY_SCOUT_BYPASS = orig;
    }
  });

  test('isExemptPath: static patterns', () => {
    assert.equal(mod.isExemptPath('.orchestray/state/orchestration.md', 'orch-x'), true);
    assert.equal(mod.isExemptPath('.orchestray/state/state.json', 'orch-x'), true);
    assert.equal(mod.isExemptPath('.orchestray/config.json', 'orch-x'), true);
    assert.equal(mod.isExemptPath('agents/pm-reference/tier1-orchestration.md', 'orch-x'), true);
    assert.equal(mod.isExemptPath('agents/pm.md', 'orch-x'), false);
    assert.equal(mod.isExemptPath('bin/track-scout-decision.js', 'orch-x'), false);
  });

  test('isExemptPath: dynamic current-orch KB prefix', () => {
    assert.equal(
      mod.isExemptPath('.orchestray/kb/artifacts/orch-foo-design.md', 'orch-foo'),
      true
    );
    assert.equal(
      mod.isExemptPath('.orchestray/kb/artifacts/orch-bar-design.md', 'orch-foo'),
      false,
      'foreign orch artifacts not exempt'
    );
    assert.equal(
      mod.isExemptPath('.orchestray/kb/artifacts/orch-foo-design.md', 'unknown'),
      false,
      'unknown orchestration_id disables dynamic exemption'
    );
  });

  test('buildBlockMessage cites Section 23, haiku-scout, and bypass env', () => {
    const msg = mod.buildBlockMessage('big.md', 13000, 12288);
    assert.match(msg, /Section 23/);
    assert.match(msg, /haiku-scout/);
    assert.match(msg, /ORCHESTRAY_SCOUT_BYPASS=1/);
    assert.match(msg, /13000/);
    assert.match(msg, /12288/);
  });

});
