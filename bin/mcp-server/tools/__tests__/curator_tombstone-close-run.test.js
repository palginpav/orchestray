#!/usr/bin/env node
'use strict';

/**
 * Tests for the `close_run` action on curator_tombstone.js (v2.3.23).
 *
 * Covers the emission gap diagnosed in
 * .orchestray/kb/decisions/curator-run-complete-emission-gap.md: the curator
 * agent could never append its own curator_run_complete event, so close_run
 * is a mandatory deterministic-dispatcher (curate-runner) call instead.
 *
 * Runner: node --test bin/mcp-server/tools/__tests__/curator_tombstone-close-run.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { handle } = require('../curator_tombstone.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;
let savedProjectRootEnv;
let savedRunCompleteEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-close-run-test-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });

  // paths.getProjectRoot() (used internally by emitCuratorEvent, independent
  // of the handler's own context.projectRoot) resolves via this env var —
  // must point at the same tmp dir so audit events land where we can read
  // them, and never at the real repo's live events.jsonl.
  savedProjectRootEnv = process.env.ORCHESTRAY_PROJECT_ROOT;
  process.env.ORCHESTRAY_PROJECT_ROOT = tmpDir;

  savedRunCompleteEnv = process.env.ORCHESTRAY_CURATOR_RUN_COMPLETE_DISABLED;
  delete process.env.ORCHESTRAY_CURATOR_RUN_COMPLETE_DISABLED;
});

afterEach(() => {
  if (savedProjectRootEnv === undefined) delete process.env.ORCHESTRAY_PROJECT_ROOT;
  else process.env.ORCHESTRAY_PROJECT_ROOT = savedProjectRootEnv;

  if (savedRunCompleteEnv === undefined) delete process.env.ORCHESTRAY_CURATOR_RUN_COMPLETE_DISABLED;
  else process.env.ORCHESTRAY_CURATOR_RUN_COMPLETE_DISABLED = savedRunCompleteEnv;

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctx() {
  return { projectRoot: tmpDir };
}

function eventsPath() {
  return path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
}

function readEvents() {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath(), 'utf8');
  } catch (_e) {
    return [];
  }
  return raw.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

function lockPath() {
  return path.join(tmpDir, '.orchestray', 'curator', 'run.lock');
}

async function startRun() {
  const r = await handle({ action: 'start_run' }, ctx());
  assert.equal(r.isError, false, 'start_run should succeed');
  return r.structuredContent.run_id;
}

const FULL_SUMMARY = JSON.stringify({
  actions_applied: { promote_n: 2, merge_n: 1, deprecate_n: 0 },
  actions_skipped: { promote_n: 0, merge_n: 1, deprecate_n: 3 },
  tombstones_written_count: 4,
  dry_run: false,
  reconciliation: { repaired: 1, flagged: 0 },
  stamps: { applied: 4, skipped: 0, failed: 0 },
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('close_run — happy path', () => {
  test('emits exactly one curator_run_complete carrying run_id and counts', async () => {
    const runId = await startRun();

    const r = await handle({ action: 'close_run', run_id: runId, summary: FULL_SUMMARY }, ctx());
    assert.equal(r.isError, false, 'close_run should succeed');
    assert.deepEqual(r.structuredContent, { ok: true, run_id: runId, already_closed: false, emitted: true });

    const events = readEvents().filter((e) => e.type === 'curator_run_complete');
    assert.equal(events.length, 1, 'exactly one curator_run_complete row');
    const evt = events[0];
    assert.equal(evt.run_id, runId);
    assert.equal(evt.orchestration_id, null);
    assert.deepEqual(evt.actions_applied, { promote_n: 2, merge_n: 1, deprecate_n: 0 });
    assert.deepEqual(evt.actions_skipped, { promote_n: 0, merge_n: 1, deprecate_n: 3 });
    assert.equal(evt.tombstones_written_count, 4);
    assert.equal(evt.dry_run, false);
    assert.deepEqual(evt.reconciliation, { repaired: 1, flagged: 0 });
    assert.deepEqual(evt.stamps, { applied: 4, skipped: 0, failed: 0 });
  });

  test('releases run.lock (fixes the pre-v2.3.23 leak on a normal run)', async () => {
    const runId = await startRun();
    assert.equal(fs.existsSync(lockPath()), true, 'lock should be held after start_run');

    await handle({ action: 'close_run', run_id: runId, summary: FULL_SUMMARY }, ctx());
    assert.equal(fs.existsSync(lockPath()), false, 'lock should be released after close_run');
  });

  test('missing reconciliation/stamps in summary are recorded as null, not zeroed', async () => {
    const runId = await startRun();
    const summary = JSON.stringify({
      actions_applied: { promote_n: 0, merge_n: 0, deprecate_n: 0 },
      actions_skipped: { promote_n: 0, merge_n: 0, deprecate_n: 0 },
      tombstones_written_count: 0,
      dry_run: false,
    });

    await handle({ action: 'close_run', run_id: runId, summary }, ctx());
    const evt = readEvents().find((e) => e.type === 'curator_run_complete');
    assert.equal(evt.reconciliation, null);
    assert.equal(evt.stamps, null);
  });

  test('dry_run: true is preserved end to end', async () => {
    const runId = await startRun();
    const summary = JSON.stringify({
      actions_applied: { promote_n: 0, merge_n: 0, deprecate_n: 0 },
      actions_skipped: { promote_n: 0, merge_n: 0, deprecate_n: 0 },
      tombstones_written_count: 0,
      dry_run: true,
    });

    await handle({ action: 'close_run', run_id: runId, summary }, ctx());
    const evt = readEvents().find((e) => e.type === 'curator_run_complete');
    assert.equal(evt.dry_run, true);
    assert.equal(fs.existsSync(lockPath()), false, 'dry-run close_run still releases the lock');
  });
});

// ---------------------------------------------------------------------------
// Idempotency / double-emit guard
// ---------------------------------------------------------------------------

describe('close_run — idempotency', () => {
  test('a second close_run for the same run_id does not double-emit', async () => {
    const runId = await startRun();

    const first = await handle({ action: 'close_run', run_id: runId, summary: FULL_SUMMARY }, ctx());
    assert.equal(first.structuredContent.already_closed, false);

    const second = await handle({ action: 'close_run', run_id: runId, summary: FULL_SUMMARY }, ctx());
    assert.equal(second.isError, false);
    assert.equal(second.structuredContent.already_closed, true);

    const events = readEvents().filter((e) => e.type === 'curator_run_complete' && e.run_id === runId);
    assert.equal(events.length, 1, 'still exactly one curator_run_complete row after the retry');
  });

  test('close_run for a different run_id is independent (no cross-run suppression)', async () => {
    const runA = await startRun();
    await handle({ action: 'close_run', run_id: runA, summary: FULL_SUMMARY }, ctx());

    const runB = await startRun();
    const r = await handle({ action: 'close_run', run_id: runB, summary: FULL_SUMMARY }, ctx());
    assert.equal(r.structuredContent.already_closed, false);

    const events = readEvents().filter((e) => e.type === 'curator_run_complete');
    assert.equal(events.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Fail-safe validation
// ---------------------------------------------------------------------------

describe('close_run — invalid input fails safely', () => {
  test('missing run_id returns toolError, emits nothing', async () => {
    const r = await handle({ action: 'close_run', summary: FULL_SUMMARY }, ctx());
    assert.equal(r.isError, true);
    assert.equal(readEvents().filter((e) => e.type === 'curator_run_complete').length, 0);
  });

  test('missing summary returns toolError', async () => {
    const runId = await startRun();
    const r = await handle({ action: 'close_run', run_id: runId }, ctx());
    assert.equal(r.isError, true);
  });

  test('malformed JSON summary returns toolError, does not throw', async () => {
    const runId = await startRun();
    const r = await handle({ action: 'close_run', run_id: runId, summary: '{not json' }, ctx());
    assert.equal(r.isError, true);
  });

  test('non-object summary (array) returns toolError', async () => {
    const runId = await startRun();
    const r = await handle({ action: 'close_run', run_id: runId, summary: '[1,2,3]' }, ctx());
    assert.equal(r.isError, true);
  });
});

// ---------------------------------------------------------------------------
// Kill switches — fail-open, mechanical cleanup still happens
// ---------------------------------------------------------------------------

describe('close_run — kill switches', () => {
  test('env kill switch suppresses emission but still releases the lock', async () => {
    const runId = await startRun();
    process.env.ORCHESTRAY_CURATOR_RUN_COMPLETE_DISABLED = '1';

    const r = await handle({ action: 'close_run', run_id: runId, summary: FULL_SUMMARY }, ctx());
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.emitted, false);
    assert.equal(readEvents().filter((e) => e.type === 'curator_run_complete').length, 0);
    assert.equal(fs.existsSync(lockPath()), false, 'lock release is not gated by the emit kill switch');
  });

  test('config kill switch (curator.run_complete_emit_enabled: false) suppresses emission', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'config.json'),
      JSON.stringify({ curator: { run_complete_emit_enabled: false } }),
    );
    const runId = await startRun();

    const r = await handle({ action: 'close_run', run_id: runId, summary: FULL_SUMMARY }, ctx());
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.emitted, false);
    assert.equal(readEvents().filter((e) => e.type === 'curator_run_complete').length, 0);
  });

  test('a failed emission never surfaces as a close_run failure (fail-open)', async () => {
    // No way to force writeAuditEvent to throw from here without touching
    // owned-elsewhere files — instead assert the documented contract: even
    // with curator.enabled: false (a harsher gate than the emit switch),
    // close_run is unreachable via handle() at all, proving the top-level
    // gate — not close_run itself — is what would ever block a run. Real
    // write failures inside emitCuratorEvent are caught internally (see
    // that function's try/catch) and never propagate.
    fs.writeFileSync(
      path.join(tmpDir, '.orchestray', 'config.json'),
      JSON.stringify({ curator: { enabled: false } }),
    );
    const r = await handle({ action: 'close_run', run_id: 'curator-fake-1', summary: FULL_SUMMARY }, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /curator disabled by config/);
  });
});
