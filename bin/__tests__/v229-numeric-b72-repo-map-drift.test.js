'use strict';

/**
 * v2.2.9 B-7.2 — repo-map threshold drift detector (shadow-mode).
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { detectDrift } = require('../_lib/repo-map-drift-detector');
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

test('B-7.2: detectDrift returns empty when prose has no numeric thresholds', () => {
  const root = makeSandbox();
  fs.writeFileSync(path.join(root, 'agents', 'pm.md'), '# pm\n\nNo numbers here.\n');
  const result = detectDrift(root);
  assert.deepEqual(result.drifts, []);
  assert.equal(result.shadow_mode, true);
});

test('B-7.2: detectDrift flags a numeric mismatch with line/file metadata', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ repo_map_thresholds: { max_size_kb: 96, shadow_mode: true } })
  );
  fs.writeFileSync(
    path.join(root, 'agents', 'pm.md'),
    [
      'line 1', 'line 2', 'line 3',
      'The repo-map cap is max 64 KB per W4 §3.',
      'line 5',
    ].join('\n') + '\n'
  );
  const result = detectDrift(root);
  assert.equal(result.drifts.length, 1);
  const d = result.drifts[0];
  assert.equal(d.config_value, 96);
  assert.equal(d.pm_prose_value, 64);
  assert.equal(d.source_pm_line, 4);
  assert.equal(d.source_file, 'pm.md');
});

test('B-7.2: detectDrift returns no entry when prose number matches config', () => {
  const root = makeSandbox();
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({ repo_map_thresholds: { max_size_kb: 64, shadow_mode: true } })
  );
  fs.writeFileSync(
    path.join(root, 'agents', 'pm.md'),
    'The repo-map cap is max 64 KB per W4 §3.\n'
  );
  const result = detectDrift(root);
  assert.deepEqual(result.drifts, []);
});
