#!/usr/bin/env node
'use strict';

/**
 * p33-housekeeper-baseline-missing.test.js — P3.3 fail-CLOSED on missing baseline.
 *
 * Verifies that when `bin/_lib/_housekeeper-baseline.js` is unavailable
 * (deleted, syntactically broken, or exports the wrong shape):
 *   1. `bin/audit-housekeeper-drift.js` emits `housekeeper_baseline_missing`.
 *   2. The hook writes the quarantine sentinel.
 *   3. The hook stderr includes `baseline missing`.
 *   4. The hook exits 0 (does NOT crash session start).
 *   5. A subsequent `bin/gate-agent-spawn.js` call to spawn an
 *      `orchestray-housekeeper` is refused with exit 2 due to the sentinel.
 *
 * Runner: node --test bin/__tests__/p33-housekeeper-baseline-missing.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DRIFT_HOOK = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-drift.js');
const SPAWN_GATE = path.join(REPO_ROOT, 'bin', 'gate-agent-spawn.js');
const REAL_AGENT = path.join(REPO_ROOT, 'agents', 'orchestray-housekeeper.md');

function setupSandboxNoBaseline() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-baseline-'));
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'bin', '_lib'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });

  fs.writeFileSync(path.join(tmp, 'agents', 'orchestray-housekeeper.md'),
    fs.readFileSync(REAL_AGENT, 'utf8'), 'utf8');
  fs.writeFileSync(path.join(tmp, '.orchestray', 'config.json'),
    JSON.stringify({ haiku_routing: { housekeeper_enabled: true } }), 'utf8');
  // intentionally NO bin/_lib/_housekeeper-baseline.js
  return tmp;
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function sentinel(tmp) {
  return path.join(tmp, '.orchestray', 'state', 'housekeeper-quarantined');
}

describe('P3.3 — fail-CLOSED on missing baseline', () => {

  test('drift hook emits housekeeper_baseline_missing event when baseline broken', () => {
    const tmp = setupSandboxNoBaseline();
    try {
      // Write a syntactically broken baseline so `require()` throws.
      fs.writeFileSync(
        path.join(tmp, 'bin', '_lib', '_housekeeper-baseline.js'),
        '// missing exports — module returns nothing useful\nmodule.exports = {};\n',
        'utf8'
      );
      const r = spawnSync('node', [DRIFT_HOOK], {
        input: JSON.stringify({ cwd: tmp, hook_event_name: 'SessionStart' }),
        encoding: 'utf8',
        timeout: 10_000,
        cwd: tmp,
      });
      assert.equal(r.status, 0, 'hook must exit 0 even when baseline missing; stderr=' + r.stderr);
      assert.match(r.stderr, /baseline missing/);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_baseline_missing');
      assert.ok(hit,
        'expected housekeeper_baseline_missing event; got: ' +
        JSON.stringify(events.map(e => e.type)));
      assert.equal(fs.existsSync(sentinel(tmp)), true,
        'quarantine sentinel must be written when baseline missing');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('subsequent gate-agent-spawn refuses housekeeper spawn (sentinel present)', () => {
    const tmp = setupSandboxNoBaseline();
    try {
      // Pre-write the sentinel directly (simulating the drift hook's effect).
      fs.writeFileSync(sentinel(tmp), '{"reason":"baseline_missing"}', 'utf8');

      // Synthesize a PreToolUse Agent payload for orchestray-housekeeper.
      const payload = {
        cwd: tmp,
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'orchestray-housekeeper',
          model: 'haiku',
          description: 'rollup recompute',
        },
      };
      const r = spawnSync('node', [SPAWN_GATE], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 10_000,
        cwd: tmp,
      });
      assert.equal(r.status, 2,
        'gate must refuse housekeeper spawn while sentinel present; stderr=' + r.stderr);
      assert.match(r.stderr, /quarantine/i);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

});
