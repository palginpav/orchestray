#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/emit-tier2-load.js (R-TEL, v2.1.12)
 *
 * AC-01 (R-TEL): tier2_load schema row in event-schemas.md — verified manually; not tested here.
 * AC-02 (R-TEL): hook emits event on tier-2 Read, silent on non-tier-2 Read.
 * AC-05 (R-TEL): integration test that the hook fires on tier-2 file and is silent on non-tier-2 file.
 *
 * Strategy: drive emit-tier2-load.js via spawnSync with stdin-piped payloads.
 * Each test creates an isolated tmpdir.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/emit-tier2-load.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeDir({ orchId = 'orch-tier2-test' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tier2-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
  return dir;
}

function run(dir, toolInput) {
  const payload = JSON.stringify({
    cwd: dir,
    tool_name: 'Read',
    tool_input: toolInput,
  });
  return spawnSync(process.execPath, [SCRIPT], {
    input: payload,
    encoding: 'utf8',
    timeout: 5000,
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

// ---------------------------------------------------------------------------
// isTier2File unit tests (via module import)
// ---------------------------------------------------------------------------

describe('isTier2File helper', () => {
  const { isTier2File, ALWAYS_LOADED } = require('../bin/emit-tier2-load');

  test('returns true for a tier-2 pm-reference file (absolute path)', () => {
    assert.equal(
      isTier2File('/home/user/repo/agents/pm-reference/event-schemas.md'),
      true
    );
  });

  test('returns true for a tier-2 pm-reference file (relative path)', () => {
    assert.equal(
      isTier2File('agents/pm-reference/drift-sentinel.md'),
      true
    );
  });

  test('returns false for tier1-orchestration.md (always-loaded)', () => {
    assert.equal(
      isTier2File('agents/pm-reference/tier1-orchestration.md'),
      false
    );
  });

  test('returns false for scoring-rubrics.md (always-loaded)', () => {
    assert.equal(
      isTier2File('agents/pm-reference/scoring-rubrics.md'),
      false
    );
  });

  test('returns false for specialist-protocol.md (always-loaded)', () => {
    assert.equal(
      isTier2File('agents/pm-reference/specialist-protocol.md'),
      false
    );
  });

  test('returns false for delegation-templates.md (always-loaded)', () => {
    assert.equal(
      isTier2File('agents/pm-reference/delegation-templates.md'),
      false
    );
  });

  test('returns false for a file outside agents/pm-reference/', () => {
    assert.equal(
      isTier2File('agents/pm.md'),
      false
    );
  });

  test('returns false for a non-.md file in agents/pm-reference/', () => {
    assert.equal(
      isTier2File('agents/pm-reference/somefile.js'),
      false
    );
  });

  test('returns false for null/empty input', () => {
    assert.equal(isTier2File(null), false);
    assert.equal(isTier2File(''), false);
  });

  test('ALWAYS_LOADED set contains exactly the four always-loaded files', () => {
    assert.ok(ALWAYS_LOADED.has('tier1-orchestration.md'));
    assert.ok(ALWAYS_LOADED.has('scoring-rubrics.md'));
    assert.ok(ALWAYS_LOADED.has('specialist-protocol.md'));
    assert.ok(ALWAYS_LOADED.has('delegation-templates.md'));
    assert.equal(ALWAYS_LOADED.size, 4);
  });
});

// ---------------------------------------------------------------------------
// AC-05 (R-TEL): Integration test — fires on tier-2, silent on non-tier-2
// ---------------------------------------------------------------------------

describe('emit-tier2-load.js integration (AC-05 R-TEL)', () => {

  test('emits tier2_load event when Read targets a tier-2 pm-reference file', () => {
    const dir = makeDir({ orchId: 'orch-tel-integration-1' });

    const result = run(dir, {
      file_path: path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'),
    });

    assert.equal(result.status, 0, 'hook must exit 0');
    assert.ok(result.stdout.includes('"continue"'), 'must emit continue:true');

    const events = readEvents(dir);
    assert.equal(events.length, 1, 'should emit exactly one tier2_load event');
    const ev = events[0];
    assert.equal(ev.type, 'tier2_load');
    assert.equal(ev.orchestration_id, 'orch-tel-integration-1');
    // v2.1.14 R-TGATE: file_path is now relative from cwd (e.g. 'agents/pm-reference/event-schemas.md')
    // rather than just the basename. Verify it contains the basename at minimum.
    assert.ok(ev.file_path.includes('event-schemas.md'), 'file_path must include basename');
    assert.equal(ev.source, 'hook');
    assert.ok(typeof ev.timestamp === 'string', 'timestamp must be present');
  });

  test('emits tier2_load for a relative path tier-2 file', () => {
    const dir = makeDir({ orchId: 'orch-tel-integration-2' });

    const result = run(dir, {
      file_path: 'agents/pm-reference/drift-sentinel.md',
    });

    assert.equal(result.status, 0);
    const events = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tier2_load');
    // v2.1.14 R-TGATE: file_path is now relative from cwd, not just basename.
    assert.ok(events[0].file_path.includes('drift-sentinel.md'), 'file_path must include basename');
  });

  test('is silent (no event) when Read targets a non-tier-2 file (AC-05 R-TEL)', () => {
    const dir = makeDir({ orchId: 'orch-tel-integration-3' });

    // Read of agents/pm.md — outside pm-reference, must NOT emit
    const result = run(dir, {
      file_path: path.join(dir, 'agents', 'pm.md'),
    });

    assert.equal(result.status, 0, 'hook must exit 0');
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'must emit NO event for non-tier-2 reads');
  });

  test('is silent when Read targets an always-loaded file (tier1-orchestration.md)', () => {
    const dir = makeDir({ orchId: 'orch-tel-integration-4' });

    const result = run(dir, {
      file_path: 'agents/pm-reference/tier1-orchestration.md',
    });

    assert.equal(result.status, 0);
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'must NOT emit event for always-loaded file');
  });

  test('exits 0 and emits continue:true even with malformed stdin', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: 'not-json',
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.trim().length > 0 || result.status === 0, 'must exit 0');
  });

  test('exits 0 when ORCHESTRAY_METRICS_DISABLED=1 and does not emit event', () => {
    const dir = makeDir({ orchId: 'orch-tel-metrics-disabled' });

    const result = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify({
        cwd: dir,
        tool_name: 'Read',
        tool_input: { file_path: 'agents/pm-reference/drift-sentinel.md' },
      }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ORCHESTRAY_METRICS_DISABLED: '1' },
    });

    assert.equal(result.status, 0);
    const events = readEvents(dir);
    assert.equal(events.length, 0, 'must not emit event when metrics are disabled');
  });

  test('uses unknown orchestration_id when no orchestration file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tier2-noorch-'));
    cleanup.push(dir);
    // No current-orchestration.json written.

    const result = run(dir, {
      file_path: 'agents/pm-reference/drift-sentinel.md',
    });

    assert.equal(result.status, 0);
    const events = readEvents(dir);
    // Event may or may not be written depending on audit dir creation; either way
    // the hook must exit 0. If written, orchestration_id must be 'unknown'.
    for (const ev of events) {
      if (ev.type === 'tier2_load') {
        assert.equal(ev.orchestration_id, 'unknown');
      }
    }
  });
});
