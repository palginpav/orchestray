'use strict';

/**
 * v2.2.9 B-7.2 — repo-map threshold config loading.
 *
 * detectDrift() / repo-map-drift-detector.js was removed in v2.3.19 (E3
 * dark-event triage, item 3): its single `cwd` param conflated the plugin's
 * static `agents/pm.md` prose (fixed per plugin version) with the project's
 * `.orchestray/config.json` override (fixed per project) — two different
 * roots in any install where the plugin is not installed inside the project
 * being orchestrated. Wiring it as designed would have either silently
 * no-op'd forever (project cwd has no `agents/` dir) or false-positived on
 * legitimate per-project config overrides. `loadRepoMapThresholds()` remains
 * live (used by other consumers) and keeps its coverage here.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadRepoMapThresholds } = require('../_lib/numeric-thresholds');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b72-'));
  fs.mkdirSync(path.join(root, '.orchestray'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', 'pm-reference'), { recursive: true });
  return root;
}

test('B-7.2: defaults — max_size_kb=96, shadow_mode=true', () => {
  const root = makeSandbox();
  const t = loadRepoMapThresholds(root);
  assert.equal(t.max_size_kb, 96);
  assert.equal(t.shadow_mode, true);
});

test('B-7.2: config override is honoured', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ repo_map_thresholds: { max_size_kb: 64, shadow_mode: false } })
  );
  const t = loadRepoMapThresholds(root);
  assert.equal(t.max_size_kb, 64);
  assert.equal(t.shadow_mode, false);
});
