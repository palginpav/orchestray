#!/usr/bin/env node
'use strict';

/**
 * p33-housekeeper-baseline-missing-schema.test.js — F-002 (v2.2.0 fix-pass).
 *
 * Verifies that the `housekeeper_baseline_missing` event the drift hook
 * emits matches the schema row at
 * `agents/pm-reference/event-schemas.md §housekeeper_baseline_missing`:
 *   - `reason` is one of the documented enum values
 *     (`missing | unreadable | malformed`).
 *   - `baseline_path` is present and equals
 *     `bin/_lib/_housekeeper-baseline.js`.
 *   - `quarantine_sentinel_written` is a boolean reflecting whether the
 *     sentinel write succeeded.
 *
 * Without these assertions, the schema-vs-emit drift documented in F-002
 * could regress silently.
 *
 * Runner: node --test bin/__tests__/p33-housekeeper-baseline-missing-schema.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DRIFT_HOOK = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-drift.js');
const REAL_AGENT = path.join(REPO_ROOT, 'agents', 'orchestray-housekeeper.md');
const REAL_BASELINE = path.join(REPO_ROOT, 'bin', '_lib', '_housekeeper-baseline.js');

const VALID_REASONS = new Set(['missing', 'unreadable', 'malformed']);

function setupSandbox(opts) {
  opts = opts || {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p33-bm-schema-'));
  fs.mkdirSync(path.join(tmp, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'bin', '_lib'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });

  fs.writeFileSync(path.join(tmp, 'agents', 'orchestray-housekeeper.md'),
    fs.readFileSync(REAL_AGENT, 'utf8'), 'utf8');
  fs.writeFileSync(path.join(tmp, '.orchestray', 'config.json'),
    JSON.stringify({ haiku_routing: { housekeeper_enabled: true } }), 'utf8');

  if (opts.baselineMode === 'malformed') {
    // Module loads but exports do not match the contract.
    fs.writeFileSync(
      path.join(tmp, 'bin', '_lib', '_housekeeper-baseline.js'),
      'module.exports = { wrong_field: "wrong value" };\n',
      'utf8'
    );
  } else if (opts.baselineMode === 'unreadable') {
    // Syntactically broken — require() throws.
    fs.writeFileSync(
      path.join(tmp, 'bin', '_lib', '_housekeeper-baseline.js'),
      "this is not valid javascript {[(\n",
      'utf8'
    );
  } else if (opts.baselineMode === 'missing') {
    // Intentionally do not write the file. The cwd-side path is missing;
    // the production fallback (script-relative) is the real repo's
    // baseline. To force the test to see "missing", override with the
    // env var the production fallback path can't resolve.
    // We emulate by writing a baseline that points at no exports AND
    // make the cwd-relative file absent so the production fallback applies.
    // For "missing", we WANT the CWD-side file absent — but then the
    // hook falls back to the production baseline (this repo's), which
    // exists. To trigger "missing" deterministically we have to ensure
    // BOTH paths are absent. The prod path is the script's own location;
    // we cannot remove it. So this branch leaves the cwd-side absent and
    // expects the test to verify this is the "production fallback" case
    // (which lands on the real baseline → no event).
    // Therefore the "missing" behavior is best exercised via the
    // unreadable-or-malformed branches; this branch is a no-op control.
  } else if (opts.baselineMode === 'valid') {
    fs.writeFileSync(path.join(tmp, 'bin', '_lib', '_housekeeper-baseline.js'),
      fs.readFileSync(REAL_BASELINE, 'utf8'), 'utf8');
  }

  return tmp;
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

function runHook(tmp) {
  return spawnSync('node', [DRIFT_HOOK], {
    input: JSON.stringify({ cwd: tmp, hook_event_name: 'SessionStart' }),
    encoding: 'utf8',
    timeout: 10_000,
    cwd: tmp,
  });
}

describe('P3.3 F-002 — housekeeper_baseline_missing schema/emit alignment', () => {

  test('malformed baseline → emit reason=malformed + baseline_path + quarantine_sentinel_written', () => {
    const tmp = setupSandbox({ baselineMode: 'malformed' });
    try {
      const r = runHook(tmp);
      assert.equal(r.status, 0, 'hook must exit 0; stderr=' + r.stderr);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_baseline_missing');
      assert.ok(hit, 'expected housekeeper_baseline_missing event');
      assert.equal(hit.reason, 'malformed',
        'reason must be `malformed` when exports are missing fields');
      assert.ok(VALID_REASONS.has(hit.reason),
        'reason must be in documented enum {missing|unreadable|malformed}; got: ' +
        hit.reason);
      assert.equal(hit.baseline_path, 'bin/_lib/_housekeeper-baseline.js',
        'baseline_path must be the documented relative path');
      assert.equal(typeof hit.quarantine_sentinel_written, 'boolean',
        'quarantine_sentinel_written must be a boolean per schema');
      assert.equal(hit.quarantine_sentinel_written, true,
        'sentinel write should succeed in a writable sandbox');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('syntactically broken baseline → emit reason=unreadable', () => {
    const tmp = setupSandbox({ baselineMode: 'unreadable' });
    try {
      const r = runHook(tmp);
      assert.equal(r.status, 0);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_baseline_missing');
      assert.ok(hit, 'expected housekeeper_baseline_missing event');
      assert.equal(hit.reason, 'unreadable',
        'reason must be `unreadable` when require() throws');
      assert.ok(VALID_REASONS.has(hit.reason));
      assert.equal(hit.baseline_path, 'bin/_lib/_housekeeper-baseline.js');
      assert.equal(hit.quarantine_sentinel_written, true);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  test('emitted reason is NEVER the legacy opaque string baseline_module_unavailable', () => {
    // Regression guard for the F-002 fix direction (Option A).
    const tmp = setupSandbox({ baselineMode: 'malformed' });
    try {
      runHook(tmp);
      const events = readEvents(tmp);
      const hit = events.find(e => e.type === 'housekeeper_baseline_missing');
      assert.ok(hit);
      assert.notEqual(hit.reason, 'baseline_module_unavailable',
        'F-002 fix: code MUST emit the documented enum, not the legacy ' +
        'opaque string. If you see this assertion fail you re-introduced ' +
        'the schema-vs-emit drift.');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

});
