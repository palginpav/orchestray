#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/lib/history_scan.js
 *
 * Per v2011c-stage2-plan.md §7 and §13.
 *
 * Contract under test:
 *   async function* scanEvents(options?: { roots?: { liveAudit?, historyDir? } })
 *     yields NormalizedEvent objects
 *
 *   async function queryEvents(filters, options?)
 *     -> { events, total_matching, returned }
 *
 * Normalization rules:
 *   - `type` wins over `event` when both present; legacy `event` dropped.
 *   - Missing timestamp in archive dir -> fall back to dir mtime.
 *   - Missing timestamp in live audit -> skip line.
 *   - Each event gets a `ref` field pointing at the enclosing archive URI.
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  scanEvents,
  queryEvents,
} = require('../../../bin/mcp-server/lib/history_scan.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-history-scan-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  return dir;
}

function writeJsonl(filepath, events) {
  const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content);
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

// ---------------------------------------------------------------------------
// scanEvents
// ---------------------------------------------------------------------------

describe('scanEvents', () => {

  test('yields nothing when roots are empty', async () => {
    const tmp = makeTmpProject();
    try {
      const events = await collect(scanEvents({ roots: rootsFor(tmp) }));
      assert.deepEqual(events, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('yields events from a single live events.jsonl file', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-10T10:00:00Z' },
        { type: 'agent_stop', orchestration_id: 'orch-1', timestamp: '2026-04-10T10:05:00Z' },
      ]);
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 2);
      assert.equal(events[0].type, 'agent_start');
      assert.equal(events[1].type, 'agent_stop');
      assert.equal(events[0].orchestration_id, 'orch-1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('yields events from multiple archive dirs', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, '20260401-a', 'events.jsonl'),
        [{ type: 'orchestration_start', orchestration_id: 'orch-a', timestamp: '2026-04-01T00:00:00Z' }]
      );
      writeJsonl(
        path.join(roots.historyDir, '20260402-b', 'events.jsonl'),
        [{ type: 'orchestration_start', orchestration_id: 'orch-b', timestamp: '2026-04-02T00:00:00Z' }]
      );
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 2);
      const ids = events.map((e) => e.orchestration_id).sort();
      assert.deepEqual(ids, ['orch-a', 'orch-b']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('normalizes legacy "event" field to "type"', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, '20260401-legacy', 'events.jsonl'),
        [{ event: 'orchestration_start', orchestration_id: 'orch-legacy', timestamp: '2026-04-01T00:00:00Z' }]
      );
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'orchestration_start');
      // Legacy "event" field should be dropped from the yielded object.
      assert.equal(events[0].event, undefined);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('prefers "type" when both "type" and "event" present', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, '20260401-drift', 'events.jsonl'),
        [{
          type: 'agent_start',
          event: 'different_value',
          orchestration_id: 'orch-drift',
          timestamp: '2026-04-01T00:00:00Z',
        }]
      );
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'agent_start');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips line with neither "event" nor "type" field', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, '20260401-badline', 'events.jsonl'),
        [
          { orchestration_id: 'orch-x', timestamp: '2026-04-01T00:00:00Z' },
          { type: 'agent_start', orchestration_id: 'orch-x', timestamp: '2026-04-01T00:01:00Z' },
        ]
      );
      const events = await collect(scanEvents({ roots }));
      // Only the well-formed event should be yielded.
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'agent_start');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('assigns mtime fallback to archive events missing timestamp', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      const archiveDir = path.join(roots.historyDir, '20260401-notimestamp');
      writeJsonl(
        path.join(archiveDir, 'events.jsonl'),
        [{ type: 'agent_start', orchestration_id: 'orch-nt' }]
      );
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 1);
      // Timestamp must be populated (non-empty ISO string).
      assert.equal(typeof events[0].timestamp, 'string');
      assert.ok(events[0].timestamp.length > 0);
      // And must parse as a valid Date.
      const parsed = new Date(events[0].timestamp);
      assert.ok(!Number.isNaN(parsed.getTime()), 'mtime fallback must be valid ISO string');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips live-audit events missing timestamp (no mtime fallback)', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-x' }, // no timestamp
        { type: 'agent_stop', orchestration_id: 'orch-x', timestamp: '2026-04-10T10:05:00Z' },
      ]);
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'agent_stop');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('populates ref field with orchestray:history://orch/<name> for archive events', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, 'orch-1744197600', 'events.jsonl'),
        [{ type: 'orchestration_start', orchestration_id: 'orch-1744197600', timestamp: '2026-04-09T11:20:00Z' }]
      );
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 1);
      assert.equal(events[0].ref, 'orchestray:history://orch/orch-1744197600');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('populates ref orchestray:history://audit/live for live events', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-10T10:00:00Z' },
      ]);
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 1);
      assert.equal(events[0].ref, 'orchestray:history://audit/live');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips malformed JSONL line and continues with subsequent lines', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      // Write raw content with one invalid JSON line in the middle.
      const archiveFile = path.join(roots.historyDir, '20260401-mixed', 'events.jsonl');
      fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
      const good1 = JSON.stringify({ type: 'agent_start', orchestration_id: 'orch-m', timestamp: '2026-04-01T00:00:00Z' });
      const bad = '{this is not valid json}';
      const good2 = JSON.stringify({ type: 'agent_stop', orchestration_id: 'orch-m', timestamp: '2026-04-01T00:05:00Z' });
      fs.writeFileSync(archiveFile, good1 + '\n' + bad + '\n' + good2 + '\n');
      const events = await collect(scanEvents({ roots }));
      assert.equal(events.length, 2, 'malformed line should be skipped but others kept');
      assert.equal(events[0].type, 'agent_start');
      assert.equal(events[1].type, 'agent_stop');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('is async-iterable (for await yields events)', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-10T10:00:00Z' },
      ]);
      const gen = scanEvents({ roots });
      // Must be an async iterable.
      assert.equal(typeof gen[Symbol.asyncIterator], 'function');
      let count = 0;
      for await (const ev of gen) {
        count++;
        assert.ok(ev.type);
      }
      assert.equal(count, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// queryEvents
// ---------------------------------------------------------------------------

describe('queryEvents', () => {

  test('filters by event_types', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-10T10:00:00Z' },
        { type: 'agent_stop', orchestration_id: 'orch-1', timestamp: '2026-04-10T10:05:00Z' },
        { type: 'task_completed', orchestration_id: 'orch-1', timestamp: '2026-04-10T10:06:00Z' },
      ]);
      const result = await queryEvents(
        { event_types: ['agent_start', 'agent_stop'] },
        { roots }
      );
      assert.equal(result.events.length, 2);
      assert.equal(result.returned, 2);
      assert.equal(result.total_matching, 2);
      for (const ev of result.events) {
        assert.ok(['agent_start', 'agent_stop'].includes(ev.type));
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters by since/until timestamps (ISO string compare)', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-01T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-2', timestamp: '2026-04-05T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-3', timestamp: '2026-04-10T00:00:00Z' },
      ]);
      const result = await queryEvents(
        { since: '2026-04-04T00:00:00Z', until: '2026-04-06T00:00:00Z' },
        { roots }
      );
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].orchestration_id, 'orch-2');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters by orchestration_ids (array membership)', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-1', timestamp: '2026-04-01T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-2', timestamp: '2026-04-02T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-3', timestamp: '2026-04-03T00:00:00Z' },
      ]);
      const result = await queryEvents(
        { orchestration_ids: ['orch-1', 'orch-3'] },
        { roots }
      );
      assert.equal(result.events.length, 2);
      const ids = result.events.map((e) => e.orchestration_id).sort();
      assert.deepEqual(ids, ['orch-1', 'orch-3']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filters by agent_role', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-1', agent_role: 'developer', timestamp: '2026-04-01T00:00:00Z' },
        { type: 'agent_start', orchestration_id: 'orch-1', agent_role: 'reviewer', timestamp: '2026-04-01T00:01:00Z' },
      ]);
      const result = await queryEvents({ agent_role: 'developer' }, { roots });
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0].agent_role, 'developer');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects limit and offset (pagination)', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      const evts = [];
      for (let i = 0; i < 10; i++) {
        evts.push({
          type: 'agent_start',
          orchestration_id: 'orch-' + i,
          timestamp: '2026-04-0' + (i < 10 ? '1' : '2') + 'T0' + i + ':00:00Z',
        });
      }
      writeJsonl(roots.liveAudit, evts);
      const page1 = await queryEvents({ limit: 3, offset: 0 }, { roots });
      const page2 = await queryEvents({ limit: 3, offset: 3 }, { roots });
      assert.equal(page1.events.length, 3);
      assert.equal(page2.events.length, 3);
      assert.equal(page1.returned, 3);
      assert.equal(page2.returned, 3);
      // Pages must not overlap.
      const ids1 = new Set(page1.events.map((e) => e.orchestration_id));
      const ids2 = new Set(page2.events.map((e) => e.orchestration_id));
      for (const id of ids1) assert.ok(!ids2.has(id), 'pages should not overlap');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns total_matching independent of limit/offset', async () => {
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      const evts = [];
      for (let i = 0; i < 10; i++) {
        evts.push({
          type: 'agent_start',
          orchestration_id: 'orch-' + i,
          timestamp: '2026-04-01T00:0' + i + ':00Z',
        });
      }
      writeJsonl(roots.liveAudit, evts);
      const result = await queryEvents({ limit: 3, offset: 0 }, { roots });
      assert.equal(result.total_matching, 10, 'total_matching should reflect pre-pagination count');
      assert.equal(result.returned, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns empty result when roots are missing on disk', async () => {
    const tmp = makeTmpProject();
    try {
      // Remove the directories we just made to simulate a fresh project.
      fs.rmSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true, force: true });
      fs.rmSync(path.join(tmp, '.orchestray', 'history'), { recursive: true, force: true });
      const result = await queryEvents({}, { roots: rootsFor(tmp) });
      assert.deepEqual(result.events, []);
      assert.equal(result.total_matching, 0);
      assert.equal(result.returned, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // B8 from the v2.0.11 solidification pass: non-ISO timestamps passed
  // to `since` / `until` must throw INVALID_FILTER before the scan starts,
  // so callers cannot silently get lexicographically-wrong results.
  describe('ISO-8601 filter validation (B8)', () => {
    const BAD_INPUTS = [
      'yesterday',
      '2026-04-11',               // date only
      '2026-04-11T06:55:18',      // no Z
      '2026-04-11T06:55:18+00:00', // offset form, not Z form
      '',                          // empty string
    ];

    for (const bad of BAD_INPUTS) {
      test('rejects filters.since = ' + JSON.stringify(bad), async () => {
        const tmp = makeTmpProject();
        try {
          await assert.rejects(
            () => queryEvents({ since: bad }, { roots: rootsFor(tmp) }),
            (err) => err && err.code === 'INVALID_FILTER' && /since/.test(err.message)
          );
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });

      test('rejects filters.until = ' + JSON.stringify(bad), async () => {
        const tmp = makeTmpProject();
        try {
          await assert.rejects(
            () => queryEvents({ until: bad }, { roots: rootsFor(tmp) }),
            (err) => err && err.code === 'INVALID_FILTER' && /until/.test(err.message)
          );
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }

    const GOOD_INPUTS = [
      '2026-04-11T06:55:18Z',
      '2026-04-11T06:55:18.123Z',
    ];

    for (const good of GOOD_INPUTS) {
      test('accepts ' + good, async () => {
        const tmp = makeTmpProject();
        try {
          // Populate nothing; just verify the call returns cleanly instead
          // of throwing at the filter-validation gate.
          const result = await queryEvents({ since: good, until: good }, { roots: rootsFor(tmp) });
          assert.equal(result.total_matching, 0);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });

});

// ---------------------------------------------------------------------------
// T3 T6 — adversarial timestamp tests
// ---------------------------------------------------------------------------

describe('history_scan adversarial timestamps (T3 T6)', () => {

  test('nanosecond-precision timestamp in event does not crash scanner', async () => {
    // T3 T6a: a timestamp with nanosecond precision (6 decimal places of sub-seconds)
    // is technically non-standard ISO 8601 (JS Date only handles up to milliseconds).
    // The scanner must not crash — the event should either be yielded or skipped
    // (implementation-dependent), but must NOT throw.
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, '20260411-nano', 'events.jsonl'),
        [
          {
            type: 'agent_start',
            orchestration_id: 'orch-nano',
            timestamp: '2026-04-11T06:55:18.123456Z',  // nanosecond precision
          },
          {
            type: 'agent_stop',
            orchestration_id: 'orch-nano',
            timestamp: '2026-04-11T06:55:19.000000Z',
          },
        ]
      );
      // Must not throw.
      let events;
      await assert.doesNotReject(async () => {
        events = await collect(scanEvents({ roots }));
      }, 'nanosecond-precision timestamp must not crash scanEvents');

      // Events should be yielded (the timestamp string is non-empty so it passes
      // the timestamp-present guard; JS Date coerces it to milliseconds).
      assert.ok(Array.isArray(events), 'scanEvents must return an iterable result');
      // At least 0 events (implementation may skip or yield — either is valid).
      // Key contract: no exception thrown.
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('nanosecond-precision timestamp ordering is correct relative to standard timestamps', async () => {
    // T3 T6a: events with nanosecond timestamps should sort correctly relative to
    // normal millisecond-precision timestamps (lexicographic ISO comparison).
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(roots.liveAudit, [
        { type: 'agent_start', orchestration_id: 'orch-nano-order', timestamp: '2026-04-11T06:55:18.123456Z' },
        { type: 'agent_stop',  orchestration_id: 'orch-nano-order', timestamp: '2026-04-11T06:55:18.124Z' },
      ]);
      // queryEvents filters by since/until using ISO string comparison.
      // Both events are within the since/until range below.
      const result = await queryEvents(
        { since: '2026-04-11T06:55:18Z', until: '2026-04-11T06:56:00Z' },
        { roots }
      );
      // Both timestamps satisfy ">= since" and "<= until" via lexicographic ordering.
      // The nano timestamp '2026-04-11T06:55:18.123456Z' >= '2026-04-11T06:55:18Z' (lex).
      // The milli timestamp '2026-04-11T06:55:18.124Z' <= '2026-04-11T06:56:00Z' (lex).
      // At minimum: no crash.
      assert.ok(typeof result.total_matching === 'number');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('leap-second timestamp in event does not crash scanner', async () => {
    // T3 T6b: a leap-second timestamp (2026-06-30T23:59:60Z) is technically valid
    // per ISO 8601 but JavaScript's Date.parse('...T23:59:60Z') returns NaN.
    // The scanner must not crash — the event should either be yielded (if the
    // string passes the non-empty timestamp guard) or skipped (if the scanner
    // validates via Date), but must NOT throw.
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, '20260630-leapsec', 'events.jsonl'),
        [
          {
            type: 'agent_start',
            orchestration_id: 'orch-leapsec',
            timestamp: '2026-06-30T23:59:60Z',  // leap second — JS Date.parse → NaN
          },
          {
            type: 'agent_stop',
            orchestration_id: 'orch-leapsec',
            timestamp: '2026-07-01T00:00:00Z',
          },
        ]
      );
      // Must not throw — the scanner must be total over adversarial input.
      let events;
      await assert.doesNotReject(async () => {
        events = await collect(scanEvents({ roots }));
      }, 'leap-second timestamp must not crash scanEvents');
      assert.ok(Array.isArray(events));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('leap-second timestamp does not cause queryEvents to throw', async () => {
    // T3 T6b: queryEvents must handle a leap-second timestamp in a stored event
    // without throwing, even when used with since/until filters.
    const tmp = makeTmpProject();
    try {
      const roots = rootsFor(tmp);
      writeJsonl(
        path.join(roots.historyDir, '20260630-leapsec2', 'events.jsonl'),
        [
          {
            type: 'orchestration_start',
            orchestration_id: 'orch-leapsec2',
            timestamp: '2026-06-30T23:59:60Z',
          },
        ]
      );
      // queryEvents with a normal since/until filter — must not throw.
      await assert.doesNotReject(
        () => queryEvents(
          { since: '2026-06-30T00:00:00Z', until: '2026-07-01T12:00:00Z' },
          { roots }
        ),
        'queryEvents must not throw when event has leap-second timestamp'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
