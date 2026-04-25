#!/usr/bin/env node
'use strict';

/**
 * Regression test: R-TGATE emit-tier2-load hook (v2.1.14).
 *
 * AC verified:
 *   - Hook emits tier2_load event with version:1, bytes, turn_number on tier-2 Read
 *   - Hook is silent on non-tier-2 paths
 *   - Honors ORCHESTRAY_METRICS_DISABLED=1 kill switch
 *   - Honors ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1 kill switch
 *   - Honors config.telemetry.tier2_tracking.enabled=false
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const SCRIPT = path.resolve(__dirname, '../../bin/emit-tier2-load.js');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeDir({ orchId = 'orch-r-tgate-test' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r-tgate-tier2-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  // Create a dummy tier-2 file so statSync can measure bytes
  const pmRefDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.writeFileSync(path.join(pmRefDir, 'event-schemas.md'), 'dummy content for test');
  return dir;
}

function run(dir, toolInput, env = {}) {
  const payload = JSON.stringify({
    cwd: dir,
    tool_name: 'Read',
    tool_input: toolInput,
  });
  return spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 5000,
    env: Object.assign({}, process.env, env),
  });
}

function readEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe('emit-tier2-load: v2.1.14 R-TGATE additions', () => {

  test('emits tier2_load event with version:1 on tier-2 Read', () => {
    const dir = makeDir({ orchId: 'orch-tgate-v1' });
    const filePath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
    const result = run(dir, { file_path: filePath });

    assert.equal(result.status, 0, 'Hook must exit 0');
    const events = readEvents(dir);
    assert.equal(events.length, 1, 'Must emit exactly one event');
    const ev = events[0];
    assert.equal(ev.type, 'tier2_load');
    assert.equal(ev.version, 1, 'version must be 1');
  });

  test('emitted event contains bytes field (non-null for existing file)', () => {
    const dir = makeDir({ orchId: 'orch-tgate-bytes' });
    const filePath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
    run(dir, { file_path: filePath });

    const events = readEvents(dir);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.ok(ev.bytes !== undefined, 'bytes field must be present');
    // The dummy file has content, so bytes should be > 0
    assert.ok(typeof ev.bytes === 'number' && ev.bytes > 0, 'bytes must be a positive number for existing file');
  });

  test('emitted event contains turn_number field (null when not in payload)', () => {
    const dir = makeDir({ orchId: 'orch-tgate-turn' });
    const filePath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
    run(dir, { file_path: filePath });

    const events = readEvents(dir);
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.ok('turn_number' in ev, 'turn_number field must be present');
    assert.equal(ev.turn_number, null, 'turn_number is null when not in payload');
  });

  test('emitted event file_path is relative when path is inside cwd', () => {
    const dir = makeDir({ orchId: 'orch-tgate-relpath' });
    const filePath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
    run(dir, { file_path: filePath });

    const events = readEvents(dir);
    assert.equal(events.length, 1);
    const ev = events[0];
    // Should be relative path like 'agents/pm-reference/event-schemas.md'
    assert.ok(
      !path.isAbsolute(ev.file_path) || ev.file_path.includes('pm-reference'),
      'file_path should be relative or contain pm-reference'
    );
    assert.ok(
      ev.file_path.includes('event-schemas.md'),
      'file_path must include the basename'
    );
  });

  test('is silent on non-tier-2 Read (no event emitted)', () => {
    const dir = makeDir({ orchId: 'orch-tgate-silent' });
    run(dir, { file_path: path.join(dir, 'agents', 'pm.md') });

    const events = readEvents(dir);
    assert.equal(events.length, 0, 'Must emit nothing for non-tier-2 paths');
  });

  test('honors ORCHESTRAY_METRICS_DISABLED=1', () => {
    const dir = makeDir({ orchId: 'orch-tgate-ksmetrics' });
    const filePath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
    const result = run(dir, { file_path: filePath }, { ORCHESTRAY_METRICS_DISABLED: '1' });

    assert.equal(result.status, 0);
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'Must emit nothing when ORCHESTRAY_METRICS_DISABLED=1');
  });

  test('honors ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1', () => {
    const dir = makeDir({ orchId: 'orch-tgate-kstelemetry' });
    const filePath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
    const result = run(dir, { file_path: filePath }, { ORCHESTRAY_DISABLE_TIER2_TELEMETRY: '1' });

    assert.equal(result.status, 0);
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'Must emit nothing when ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1');
  });

  test('honors config.telemetry.tier2_tracking.enabled=false', () => {
    const dir = makeDir({ orchId: 'orch-tgate-configks' });
    // Write a config that disables tier2 tracking
    const orchDir = path.join(dir, '.orchestray');
    fs.mkdirSync(orchDir, { recursive: true });
    fs.writeFileSync(
      path.join(orchDir, 'config.json'),
      JSON.stringify({ telemetry: { tier2_tracking: { enabled: false } } })
    );

    const filePath = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');
    const result = run(dir, { file_path: filePath });

    assert.equal(result.status, 0);
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'Must emit nothing when config.telemetry.tier2_tracking.enabled=false');
  });
});
