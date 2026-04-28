'use strict';

/**
 * Test sentinel-probe.js session health-check mode (v2.2.8 Item 11).
 *
 * Tests runSessionChecks() without emitting real audit events — we stub
 * writeEvent via environment-level isolation and verify the aggregated result.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

// ---------------------------------------------------------------------------
// Load module under test — sentinel-probe.js exports runSessionChecks.
// We cannot easily stub writeEvent in the module, so we set up a real
// directory structure that passes health checks, and verify the return shape.
// ---------------------------------------------------------------------------

const { runSessionChecks, _isSessionProbeEnabled } = require('../../../bin/sentinel-probe');

function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sentinel-v228-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

// ---------------------------------------------------------------------------
// Helper: create minimal orchestray directory tree
// ---------------------------------------------------------------------------

function scaffoldProject(dir, { withConfig = true, withHooks = true, withOrchestray = true } = {}) {
  if (withOrchestray) {
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  }
  if (withHooks) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}', 'utf8');
  }
  if (withConfig) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ version: '2.2.8' }),
      'utf8'
    );
  }
}

// ---------------------------------------------------------------------------
// Test: fully scaffolded project → overall_status pass
// ---------------------------------------------------------------------------

test('runSessionChecks — fully scaffolded project → overall_status pass', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  const result = runSessionChecks(dir);

  assert.equal(typeof result, 'object');
  assert.equal(result.overall_status, 'pass');
  assert.ok(Array.isArray(result.results));
  assert.ok(result.results.length > 0);

  // Every result must have required fields.
  for (const r of result.results) {
    assert.ok(typeof r.check_name === 'string' && r.check_name.length > 0, 'check_name missing');
    assert.ok(r.status === 'pass' || r.status === 'fail', `status invalid: ${r.status}`);
    assert.ok(typeof r.detail === 'string', 'detail missing');
  }
});

// ---------------------------------------------------------------------------
// Test: missing .orchestray dir → overall_status fail
// ---------------------------------------------------------------------------

test('runSessionChecks — missing .orchestray dir → overall_status fail', (t) => {
  const dir = makeTmpDir(t);
  // Don't create .orchestray
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}', 'utf8');

  const result = runSessionChecks(dir);

  assert.equal(result.overall_status, 'fail');
  const orchCheck = result.results.find(r => r.check_name === 'orchestray_dir');
  assert.ok(orchCheck, 'orchestray_dir check missing from results');
  assert.equal(orchCheck.status, 'fail');
});

// ---------------------------------------------------------------------------
// Test: corrupt config.json → overall_status fail
// ---------------------------------------------------------------------------

test('runSessionChecks — corrupt config.json → overall_status fail', (t) => {
  const dir = makeTmpDir(t);
  fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{"hooks":{}}', 'utf8');
  // Write invalid JSON to config.
  fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'), 'NOT_JSON', 'utf8');

  const result = runSessionChecks(dir);

  assert.equal(result.overall_status, 'fail');
  const cfgCheck = result.results.find(r => r.check_name === 'config_json');
  assert.ok(cfgCheck, 'config_json check missing');
  assert.equal(cfgCheck.status, 'fail');
});

// ---------------------------------------------------------------------------
// Test: result shape has all required fields
// ---------------------------------------------------------------------------

test('runSessionChecks — result shape correct', (t) => {
  const dir = makeTmpDir(t);
  scaffoldProject(dir);

  const result = runSessionChecks(dir);

  assert.ok(result.overall_status === 'pass' || result.overall_status === 'fail');
  assert.ok(Array.isArray(result.results));
});

// ---------------------------------------------------------------------------
// Test: _isSessionProbeEnabled honors config kill-switch
// ---------------------------------------------------------------------------

test('_isSessionProbeEnabled — honors sentinel_probe.enabled: false in config', (t) => {
  const dir = makeTmpDir(t);
  fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({ sentinel_probe: { enabled: false } }),
    'utf8'
  );

  const enabled = _isSessionProbeEnabled(dir);
  assert.equal(enabled, false);
});

test('_isSessionProbeEnabled — returns true when no config', (t) => {
  const dir = makeTmpDir(t);
  const enabled = _isSessionProbeEnabled(dir);
  assert.equal(enabled, true);
});

test('_isSessionProbeEnabled — returns true when config has no sentinel_probe key', (t) => {
  const dir = makeTmpDir(t);
  fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({ version: '2.2.8' }),
    'utf8'
  );
  const enabled = _isSessionProbeEnabled(dir);
  assert.equal(enabled, true);
});
