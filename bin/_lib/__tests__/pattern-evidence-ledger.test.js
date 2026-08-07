#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/pattern-evidence-ledger.js.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/_lib/__tests__/pattern-evidence-ledger.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const ledger = require('../pattern-evidence-ledger');

function makeTmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-pattern-ledger-test-'));
}

// ---------------------------------------------------------------------------
// appendOffer / readOffersForOrch
// ---------------------------------------------------------------------------

describe('appendOffer + readOffersForOrch', () => {
  test('round-trips a row and creates the parent directory', () => {
    const dir = makeTmpProject();
    try {
      const offersPath = ledger._offersPath(dir);
      assert.equal(fs.existsSync(offersPath), false);

      ledger.appendOffer(dir, {
        timestamp: '2026-08-07T09:00:00.000Z',
        orchestration_id: 'orch-1',
        spawn_id: 'spawn-a',
        agent_role: 'developer',
        task_id: 'W3',
        offers: [{ slug: 'foo-bar', offer_kind: 'curated', confidence: 0.8 }],
        shape_detected: 'uri_only',
        unresolved_slugs: [],
      });

      assert.equal(fs.existsSync(offersPath), true);
      const rows = ledger.readOffersForOrch(dir, 'orch-1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].spawn_id, 'spawn-a');
      assert.equal(rows[0].offers[0].slug, 'foo-bar');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('filters strictly by orchestration_id', () => {
    const dir = makeTmpProject();
    try {
      ledger.appendOffer(dir, { orchestration_id: 'orch-1', spawn_id: 's1', offers: [] });
      ledger.appendOffer(dir, { orchestration_id: 'orch-2', spawn_id: 's2', offers: [] });
      ledger.appendOffer(dir, { orchestration_id: 'orch-1', spawn_id: 's3', offers: [] });

      const rows = ledger.readOffersForOrch(dir, 'orch-1');
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.spawn_id), ['s1', 's3']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// appendAck / readAcksForOrch
// ---------------------------------------------------------------------------

describe('appendAck + readAcksForOrch', () => {
  test('round-trips a row', () => {
    const dir = makeTmpProject();
    try {
      ledger.appendAck(dir, {
        timestamp: '2026-08-07T09:04:00.000Z',
        orchestration_id: 'orch-1',
        spawn_id: 'spawn-a',
        agent_role: 'developer',
        task_id: 'W3',
        source: 'structured_result',
        used: [{ slug: 'foo-bar', how_len: 84 }],
        rejected: [],
        agent_status: 'success',
      });

      const rows = ledger.readAcksForOrch(dir, 'orch-1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].used[0].slug, 'foo-bar');
      assert.equal(rows[0].agent_status, 'success');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// appendJournal
// ---------------------------------------------------------------------------

describe('appendJournal', () => {
  test('round-trips a counter-mutation row', () => {
    const dir = makeTmpProject();
    try {
      ledger.appendJournal(dir, {
        timestamp: '2026-08-07T18:00:00.000Z',
        orchestration_id: 'orch-1',
        slug: 'foo-bar',
        field: 'times_applied',
        before: 3,
        after: 4,
        committer: 'commit-pattern-applications',
      });

      const raw = fs.readFileSync(ledger._journalPath(dir), 'utf8').trim();
      const row = JSON.parse(raw);
      assert.equal(row.field, 'times_applied');
      assert.equal(row.after, 4);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-open contracts
// ---------------------------------------------------------------------------

describe('fail-open behaviour', () => {
  test('readOffersForOrch returns [] when the file does not exist', () => {
    const dir = makeTmpProject();
    try {
      assert.deepEqual(ledger.readOffersForOrch(dir, 'orch-1'), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('malformed lines are skipped, not thrown', () => {
    const dir = makeTmpProject();
    try {
      const offersPath = ledger._offersPath(dir);
      fs.mkdirSync(path.dirname(offersPath), { recursive: true });
      fs.writeFileSync(
        offersPath,
        'not json\n' +
        JSON.stringify({ orchestration_id: 'orch-1', spawn_id: 'ok', offers: [] }) + '\n'
      );
      const rows = ledger.readOffersForOrch(dir, 'orch-1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].spawn_id, 'ok');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('appendOffer to an unwritable path does not throw', () => {
    assert.doesNotThrow(() => {
      ledger.appendOffer('/dev/null/not-a-dir/nonexistent', { orchestration_id: 'orch-1' });
    });
  });

  test('oversize offers file is skipped on read (fail-open to [])', () => {
    const dir = makeTmpProject();
    const prevOverride = process.env.MAX_JSONL_READ_BYTES_OVERRIDE;
    try {
      // Force a tiny read cap so a small seeded file already exceeds it,
      // without writing megabytes of fixture data.
      process.env.MAX_JSONL_READ_BYTES_OVERRIDE = '10';
      delete require.cache[require.resolve('../atomic-append')];
      delete require.cache[require.resolve('../pattern-evidence-ledger')];
      const freshLedger = require('../pattern-evidence-ledger');

      const offersPath = freshLedger._offersPath(dir);
      fs.mkdirSync(path.dirname(offersPath), { recursive: true });
      fs.writeFileSync(offersPath, JSON.stringify({ orchestration_id: 'orch-1', spawn_id: 'x', offers: [] }) + '\n');

      const rows = freshLedger.readOffersForOrch(dir, 'orch-1');
      assert.deepEqual(rows, []);
    } finally {
      if (prevOverride === undefined) delete process.env.MAX_JSONL_READ_BYTES_OVERRIDE;
      else process.env.MAX_JSONL_READ_BYTES_OVERRIDE = prevOverride;
      delete require.cache[require.resolve('../atomic-append')];
      delete require.cache[require.resolve('../pattern-evidence-ledger')];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
