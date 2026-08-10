#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/curator-recently-curated.js's `backfillPromoteStamps()`
 * (v2.3.24) — see .orchestray/kb/decisions/v2324-curate-followups.md §Item 1.
 *
 * Runner: node --test tests/_lib-curator-stamp-backfill.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const {
  readStamp,
  backfillPromoteStamps,
  _internal: { BACKFILL_RUN_ID, BACKFILL_ACTION_ID_PREFIX },
} = require('../bin/_lib/curator-recently-curated.js');

const { computeBodyHash } = require('../bin/_lib/curator-diff.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let projectRoot;
let sharedRoot;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-backfill-project-'));
  sharedRoot  = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-backfill-shared-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(sharedRoot, 'patterns'), { recursive: true });
  process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedRoot;
});

afterEach(() => {
  delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(sharedRoot, { recursive: true, force: true });
});

function writeLocalPattern(filename, extraFm = '') {
  const fm = `---\nname: ${filename.replace(/\.md$/, '')}\ncategory: anti-pattern\nconfidence: 0.7\n${extraFm}---\n`;
  const body = `\n# Pattern\n\nBody content for ${filename}.\n`;
  const fp = path.join(projectRoot, '.orchestray', 'patterns', filename);
  fs.writeFileSync(fp, fm + body, 'utf8');
  return fp;
}

function writeSharedPattern(filename) {
  const fm = `---\nname: ${filename.replace(/\.md$/, '')}\ncategory: anti-pattern\nconfidence: 0.7\norigin: shared\n---\n`;
  fs.writeFileSync(path.join(sharedRoot, 'patterns', filename), fm + '\nshared body\n', 'utf8');
}

function eventsPath() {
  return path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
}

function readAuditEvents() {
  try {
    const raw = fs.readFileSync(eventsPath(), 'utf8');
    return raw.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
  } catch (_e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe('backfillPromoteStamps', () => {
  test('pattern present in the shared tier without a stamp gets one', () => {
    const fp = writeLocalPattern('anti-pattern-half-shipped-enum.md');
    writeSharedPattern('anti-pattern-half-shipped-enum.md');

    assert.equal(readStamp(fp), null, 'precondition: no stamp yet');

    const summary = backfillPromoteStamps({ projectRoot });

    assert.deepEqual(summary.backfilled, ['anti-pattern-half-shipped-enum.md']);
    assert.deepEqual(summary.skipped, []);
    assert.deepEqual(summary.failed, []);

    const stamp = readStamp(fp);
    assert.ok(stamp, 'stamp now present');
    assert.equal(stamp.action, 'promote');
    assert.ok(stamp.at, 'timestamp set');
    assert.equal(stamp.body_sha256, computeBodyHash(fp), 'body hash matches current body — isDirty will see it as clean');
  });

  test('pattern absent from the shared tier does not get a stamp', () => {
    const fp = writeLocalPattern('anti-pattern-not-shared.md');
    // No corresponding file written to sharedRoot.

    const summary = backfillPromoteStamps({ projectRoot });

    assert.deepEqual(summary.backfilled, []);
    assert.deepEqual(summary.skipped, ['anti-pattern-not-shared.md']);
    assert.equal(readStamp(fp), null, 'still unstamped');
  });

  test('provenance marker present: distinguishable from an earned stamp', () => {
    const fp = writeLocalPattern('anti-pattern-provenance-check.md');
    writeSharedPattern('anti-pattern-provenance-check.md');

    backfillPromoteStamps({ projectRoot });
    const stamp = readStamp(fp);

    assert.ok(stamp.action_id.startsWith(BACKFILL_ACTION_ID_PREFIX), 'action_id carries the backfill prefix');
    assert.equal(stamp.run_id, BACKFILL_RUN_ID);
    assert.ok(stamp.run_id.startsWith('backfill-'), 'run_id carries the backfill prefix');
    assert.match(stamp.why, /^backfilled:/, 'why explicitly states this was backfilled');

    // A real curator run_id is shaped curator-run-<ISO8601> and a real
    // action_id is shaped <orch_id>-a<NN> — neither ever starts with
    // "backfill-", so this cannot collide with a real tombstone action_id
    // (curator-diff.js's isDirty rollback-touched check).
    assert.ok(!/^curator-run-/.test(stamp.run_id));
  });

  test('idempotent: a second run does not re-stamp or change anything', () => {
    const fp = writeLocalPattern('anti-pattern-idempotent.md');
    writeSharedPattern('anti-pattern-idempotent.md');

    const first = backfillPromoteStamps({ projectRoot });
    assert.equal(first.backfilled.length, 1);
    const stampAfterFirst = readStamp(fp);

    const second = backfillPromoteStamps({ projectRoot });
    assert.deepEqual(second.backfilled, [], 'nothing left to backfill');
    assert.deepEqual(second.skipped, ['anti-pattern-idempotent.md']);
    const stampAfterSecond = readStamp(fp);

    assert.deepEqual(stampAfterSecond, stampAfterFirst, 'stamp unchanged by the second run');
  });

  test('never overwrites an existing stamp of any action, even if the pattern is shared', () => {
    const fp = writeLocalPattern('anti-pattern-already-stamped.md');
    writeSharedPattern('anti-pattern-already-stamped.md');

    const { writeStamp } = require('../bin/_lib/curator-recently-curated.js');
    writeStamp(fp, {
      at: '2026-01-01T00:00:00Z',
      action: 'evaluated',
      action_id: 'curator-run-2026-01-01T00:00:00Z-a001',
      run_id: 'curator-run-2026-01-01T00:00:00Z',
      why: 'no-op',
      body_sha256: computeBodyHash(fp),
    });

    const summary = backfillPromoteStamps({ projectRoot });
    assert.deepEqual(summary.backfilled, []);
    assert.deepEqual(summary.skipped, ['anti-pattern-already-stamped.md']);

    const stamp = readStamp(fp);
    assert.equal(stamp.action, 'evaluated', 'earned stamp is untouched, not clobbered by the backfill');
  });

  test('dry run: reports what would happen, writes nothing', () => {
    const fp = writeLocalPattern('anti-pattern-dry-run.md');
    writeSharedPattern('anti-pattern-dry-run.md');

    const summary = backfillPromoteStamps({ projectRoot, dryRun: true });
    assert.deepEqual(summary.backfilled, ['anti-pattern-dry-run.md']);
    assert.equal(readStamp(fp), null, 'dry run must not write a stamp');
    assert.deepEqual(readAuditEvents(), [], 'dry run must not emit an audit event');
  });

  test('federation disabled / no shared tier resolvable → no-op, nothing backfilled', () => {
    // getSharedPatternsDir() ignores the `projectRoot` option passed to
    // backfillPromoteStamps — it resolves its own project root via
    // getProjectRoot(), which prefers CLAUDE_PROJECT_DIR over cwd walk-up.
    // Point it at this test's temp projectRoot (no .orchestray/config.json,
    // so federation.shared_dir_enabled defaults to false) rather than
    // whatever real project this test happens to run inside of.
    delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
    const savedClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const savedOrchestrayProjectRoot = process.env.ORCHESTRAY_PROJECT_ROOT;
    process.env.CLAUDE_PROJECT_DIR = projectRoot;
    delete process.env.ORCHESTRAY_PROJECT_ROOT;

    try {
      writeLocalPattern('anti-pattern-no-federation.md');

      const summary = backfillPromoteStamps({ projectRoot });
      assert.deepEqual(summary.backfilled, [], 'nothing backfilled — no shared tier to verify against');
      assert.deepEqual(summary.skipped, [], 'early-return path does not even enumerate local files into skipped');
      assert.deepEqual(summary.failed, []);
    } finally {
      if (savedClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = savedClaudeProjectDir;
      if (savedOrchestrayProjectRoot === undefined) delete process.env.ORCHESTRAY_PROJECT_ROOT;
      else process.env.ORCHESTRAY_PROJECT_ROOT = savedOrchestrayProjectRoot;
    }
  });

  test('pattern absent from the real shared tier (federation enabled, no matching file) → skipped, not backfilled', () => {
    // Distinct from the test above: here the shared tier DOES resolve (via
    // the ORCHESTRAY_TEST_SHARED_DIR override, already set in beforeEach)
    // but has no file matching this pattern's filename.
    writeLocalPattern('anti-pattern-no-match.md');
    // Deliberately do not call writeSharedPattern for this filename.

    const summary = backfillPromoteStamps({ projectRoot });
    assert.deepEqual(summary.backfilled, []);
    assert.deepEqual(summary.skipped, ['anti-pattern-no-match.md']);
  });

  test('emits curator_stamp_backfilled with the correct shape', () => {
    writeLocalPattern('anti-pattern-event-shape.md');
    writeSharedPattern('anti-pattern-event-shape.md');

    backfillPromoteStamps({ projectRoot });

    const events = readAuditEvents().filter((e) => e.type === 'curator_stamp_backfilled');
    assert.equal(events.length, 1);
    assert.equal(events[0].count, 1);
    assert.deepEqual(events[0].slugs, ['anti-pattern-event-shape']);
    assert.equal(events[0].dry_run, false);
  });

  test('multiple patterns: only the shared-and-unstamped ones are backfilled', () => {
    const shared1 = writeLocalPattern('anti-pattern-multi-shared-1.md');
    const shared2 = writeLocalPattern('anti-pattern-multi-shared-2.md');
    const notShared = writeLocalPattern('anti-pattern-multi-not-shared.md');
    writeSharedPattern('anti-pattern-multi-shared-1.md');
    writeSharedPattern('anti-pattern-multi-shared-2.md');

    const summary = backfillPromoteStamps({ projectRoot });

    assert.deepEqual(
      summary.backfilled.sort(),
      ['anti-pattern-multi-shared-1.md', 'anti-pattern-multi-shared-2.md'].sort()
    );
    assert.deepEqual(summary.skipped, ['anti-pattern-multi-not-shared.md']);
    assert.ok(readStamp(shared1));
    assert.ok(readStamp(shared2));
    assert.equal(readStamp(notShared), null);
  });

  test('no local patterns directory → empty result, no throw', () => {
    fs.rmSync(path.join(projectRoot, '.orchestray', 'patterns'), { recursive: true, force: true });
    const summary = backfillPromoteStamps({ projectRoot });
    assert.deepEqual(summary, { backfilled: [], skipped: [], failed: [] });
  });
});
