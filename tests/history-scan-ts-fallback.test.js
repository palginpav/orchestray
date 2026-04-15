#!/usr/bin/env node
'use strict';

/**
 * FC2 regression tests: ts/timestamp field-name normalisation in history_scan.js
 *
 * The orchestration_start event (and any early event) emitted by the PM may use
 * legacy field names `ts` and `event` instead of the canonical `timestamp` and
 * `type`.  Before this fix, rows with only `ts` were silently dropped on the
 * live-audit path because _normalizeEvent() did not remap `ts` -> `timestamp`
 * and the post-normalisation guard `if typeof normalized.timestamp !== 'string'`
 * caused the row to be skipped.
 *
 * Four cases under test:
 *   1. Row with only `ts` + `event` -> normalised to `timestamp` + `type`, NOT dropped.
 *   2. Row with only `timestamp` + `type` -> preserved unchanged (regression guard).
 *   3. Row with BOTH `ts` and `timestamp` -> `timestamp` wins; no duplication.
 *   4. Row with neither -> dropped + one-time stderr warning.
 *
 * Plus one end-to-end live-path integration test confirming the ts-only row is
 * now yielded by scanEvents on the isLive=true path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  scanEvents,
  queryEvents,
} = require('../bin/mcp-server/lib/history_scan.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-fc2-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  return dir;
}

function rootsFor(tmp) {
  return {
    liveAudit: path.join(tmp, '.orchestray', 'audit', 'events.jsonl'),
    historyDir: path.join(tmp, '.orchestray', 'history'),
  };
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function writeLiveJsonl(liveAuditPath, events) {
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(liveAuditPath), { recursive: true });
  fs.writeFileSync(liveAuditPath, content);
}

// ---------------------------------------------------------------------------
// Access _normalizeEvent via a thin wrapper: write a fixture archive and
// collect the single normalised event.  This tests _normalizeEvent indirectly
// while also exercising the full scanEvents stack.
// ---------------------------------------------------------------------------

// Helper: write a single-row archive (not live) and collect its events.
async function normalizeViaArchive(tmp, row) {
  const roots = rootsFor(tmp);
  const archiveDir = path.join(roots.historyDir, 'fc2-fixture');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'events.jsonl'), JSON.stringify(row) + '\n');
  return collect(scanEvents({ roots }));
}

// ---------------------------------------------------------------------------
// Case 1: ts + event only -> normalised to timestamp + type, NOT dropped
// ---------------------------------------------------------------------------

describe('history-scan-ts-fallback (FC2)', () => {

  test('case 1: ts+event row is normalised to timestamp+type and NOT dropped', async () => {
    const tmp = makeTmpProject();
    try {
      // This is the exact shape that orchestration_start uses when emitted by the PM.
      const row = {
        ts: '2026-04-15T17:45:00Z',
        event: 'orchestration_start',
        orchestration_id: 'orch-fc2-test',
        complexity_score: 7,
      };
      const events = await normalizeViaArchive(tmp, row);
      assert.equal(events.length, 1, 'ts-only row must NOT be dropped by normalisation');
      const ev = events[0];
      assert.equal(ev.timestamp, '2026-04-15T17:45:00Z', 'ts must be remapped to timestamp');
      assert.equal(ev.type, 'orchestration_start', 'event must be remapped to type');
      assert.equal(ev.ts, undefined, 'legacy ts field must be removed from output');
      assert.equal(ev.event, undefined, 'legacy event field must be removed from output');
      assert.equal(ev.orchestration_id, 'orch-fc2-test', 'other fields must be preserved');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Case 2: timestamp + type only -> preserved unchanged
  // -------------------------------------------------------------------------

  test('case 2: timestamp+type row is preserved unchanged (regression guard)', async () => {
    const tmp = makeTmpProject();
    try {
      const row = {
        timestamp: '2026-04-15T18:00:00Z',
        type: 'agent_start',
        orchestration_id: 'orch-fc2-canonical',
        agent_role: 'developer',
      };
      const events = await normalizeViaArchive(tmp, row);
      assert.equal(events.length, 1, 'canonical row must be preserved');
      const ev = events[0];
      assert.equal(ev.timestamp, '2026-04-15T18:00:00Z');
      assert.equal(ev.type, 'agent_start');
      assert.equal(ev.orchestration_id, 'orch-fc2-canonical');
      assert.equal(ev.agent_role, 'developer');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Case 3: both ts and timestamp present -> timestamp wins
  // -------------------------------------------------------------------------

  test('case 3: when both ts and timestamp present, timestamp wins', async () => {
    const tmp = makeTmpProject();
    try {
      const row = {
        ts: '2026-01-01T00:00:00Z',          // older / wrong value
        timestamp: '2026-04-15T19:00:00Z',   // canonical value that must win
        type: 'orchestration_start',
        orchestration_id: 'orch-fc2-both',
      };
      const events = await normalizeViaArchive(tmp, row);
      assert.equal(events.length, 1, 'row with both ts and timestamp must be yielded once');
      const ev = events[0];
      assert.equal(ev.timestamp, '2026-04-15T19:00:00Z', 'canonical timestamp must win over ts');
      assert.equal(ev.ts, undefined, 'ts field must be removed from output');
      // Sanity: only one event (no duplication)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Case 4: neither ts nor timestamp -> dropped + stderr warning
  // -------------------------------------------------------------------------

  test('case 4: row with neither ts nor timestamp is dropped with stderr warning on live path', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      // Write a live audit file with: one row missing both ts and timestamp,
      // followed by a well-formed row.
      writeLiveJsonl(roots.liveAudit, [
        { event: 'orchestration_start', orchestration_id: 'orch-no-ts' }, // no ts, no timestamp
        { timestamp: '2026-04-15T20:00:00Z', type: 'agent_start', orchestration_id: 'orch-good' },
      ]);

      // Capture stderr during the scan.
      const originalWrite = process.stderr.write.bind(process.stderr);
      const stderrLines = [];
      process.stderr.write = (chunk, ...args) => {
        stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        return originalWrite(chunk, ...args);
      };

      let events;
      try {
        events = await collect(scanEvents({ roots }));
      } finally {
        process.stderr.write = originalWrite;
      }

      // The no-ts row must be dropped (only the good row survives on live path).
      assert.equal(events.length, 1, 'row without timestamp must be dropped on live path');
      assert.equal(events[0].type, 'agent_start');

      // A stderr warning must have been emitted.
      const allStderr = stderrLines.join('');
      assert.ok(
        allStderr.includes('missing timestamp') || allStderr.includes('skipping'),
        'stderr must contain a warning about the missing timestamp; got: ' + allStderr
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // End-to-end: live path with ts-only orchestration_start row is now yielded
  // This mirrors the real fixture at .orchestray/history/20260415T134847Z-v2017E-orchestration
  // -------------------------------------------------------------------------

  test('end-to-end: live path yields ts-only orchestration_start row', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      // Exact shape of the first row in the real history fixture.
      writeLiveJsonl(roots.liveAudit, [
        {
          ts: '2026-04-15T17:45:00Z',
          event: 'orchestration_start',
          orchestration_id: 'orch-20260415T134847Z-v2017E',
          version: 'v2.0.17-E',
          scope: 'scope-expansion+audit-loop',
          budget: 'uncapped',
        },
        {
          timestamp: '2026-04-15T13:49:07.565Z',
          type: 'task_created',
          orchestration_id: 'orch-20260415T134847Z-v2017E',
        },
      ]);

      const result = await queryEvents(
        { event_types: ['orchestration_start'] },
        { roots }
      );

      assert.equal(result.total_matching, 1, 'orchestration_start must be found via history_query_events');
      assert.equal(result.events.length, 1);
      const ev = result.events[0];
      assert.equal(ev.type, 'orchestration_start');
      assert.equal(ev.timestamp, '2026-04-15T17:45:00Z');
      assert.equal(ev.orchestration_id, 'orch-20260415T134847Z-v2017E');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
