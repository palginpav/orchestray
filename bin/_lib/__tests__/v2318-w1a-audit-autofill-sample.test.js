#!/usr/bin/env node
'use strict';

/**
 * v2318-w1a-audit-autofill-sample.test.js — D4 (v2.3.18 W1a).
 *
 * `audit_event_autofilled` used to fire 1:1 with every autofilled field
 * (9,781 rows/day baseline, doubling log volume for no extra diagnostic
 * value). Fixed by sampling: 1 row per AUTOFILL_SAMPLE_INTERVAL (default 10)
 * occurrences per event_type, carrying the union of autofilled field names
 * across the window so no diagnostic signal is lost.
 *
 * Also covers the paired fix: `audit_event_autofill_threshold_exceeded`
 * bypasses the writeEvent gateway (raw appendFileSync) and never got a
 * `timestamp` — every production row (48/48) violated the required-field
 * contract it exists to police.
 *
 * Coverage:
 *   1. N=25 autofilling writeEvent calls for the same type → exactly
 *      floor(25/10)=2 audit_event_autofilled rows, not 25.
 *   2. Each emitted row's fields_autofilled is the union across its window;
 *      sample_count reflects the window size.
 *   3. Kill switch ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED=1 reverts to 1:1.
 *   4. audit_event_autofill_threshold_exceeded rows carry a timestamp field.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const GATEWAY = path.resolve(__dirname, '..', 'audit-event-writer.js');

// ---------------------------------------------------------------------------
// Minimal synthetic schema — one type, timestamp+orchestration_id autofilled.
// ---------------------------------------------------------------------------
const SYNTHETIC_SCHEMA = `# Event Schemas (minimal fixture for W1a sampling tests)

### \`sample_evt\` event

Test event for D4 sampling.

\`\`\`json
{
  "type": "sample_evt",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx"
}
\`\`\`
`;

function makeTmpRepo(orchId) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w1a-sample-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.writeFileSync(path.join(pmRefDir, 'event-schemas.md'), SYNTHETIC_SCHEMA, 'utf8');

  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');
  return tmpDir;
}

function freshWriter() {
  for (const key of Object.keys(require.cache)) {
    if (
      key.includes('audit-event-writer') ||
      key.includes('schema-emit-validator') ||
      key.includes('load-schema-shadow') ||
      key.includes('peek-orchestration-id')
    ) {
      delete require.cache[key];
    }
  }
  return require(GATEWAY);
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Send `count` events that omit timestamp+orchestration_id (autofill trigger). */
function sendAutofillingEvents(writer, count, tmpDir) {
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  for (let i = 0; i < count; i++) {
    writer.writeEvent({ type: 'sample_evt', version: 1 }, { cwd: tmpDir, eventsPath });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('D4 (v2.3.18 W1a) — audit_event_autofilled sampling', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = {
      ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED:  process.env.ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED,
      ORCHESTRAY_AUTOFILL_SAMPLE_INTERVAL:  process.env.ORCHESTRAY_AUTOFILL_SAMPLE_INTERVAL,
      ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED: process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED,
    };
    delete process.env.ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED;
    delete process.env.ORCHESTRAY_AUTOFILL_SAMPLE_INTERVAL;
    // Threshold tracking is a separate feature; disable so it doesn't add
    // audit_event_autofill_threshold_exceeded noise to these counts.
    process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED = '1';
  });

  afterEach(() => {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  test('25 autofilling calls emit exactly 2 audit_event_autofilled rows (default interval=10)', () => {
    const orchId = 'orch-w1a-t1';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();
    try {
      sendAutofillingEvents(writer, 25, tmpDir);

      const events    = readEvents(tmpDir);
      const autofills = events.filter((e) => e.type === 'audit_event_autofilled');
      assert.equal(autofills.length, 2,
        `expected floor(25/10)=2 audit_event_autofilled rows; got ${autofills.length}`);

      for (const row of autofills) {
        assert.equal(row.sample_count, 10, 'each sampled row represents a window of 10 occurrences');
        assert.ok(Array.isArray(row.fields_autofilled) && row.fields_autofilled.length > 0,
          'fields_autofilled must be non-empty');
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED=1 reverts to 1:1 emission', () => {
    const orchId = 'orch-w1a-t2';
    const tmpDir = makeTmpRepo(orchId);
    process.env.ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED = '1';
    const writer = freshWriter();
    try {
      sendAutofillingEvents(writer, 5, tmpDir);

      const events    = readEvents(tmpDir);
      const autofills = events.filter((e) => e.type === 'audit_event_autofilled');
      assert.equal(autofills.length, 5,
        `kill switch: expected 1:1 (5 rows for 5 calls); got ${autofills.length}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('ORCHESTRAY_AUTOFILL_SAMPLE_INTERVAL overrides the default window size', () => {
    const orchId = 'orch-w1a-t3';
    const tmpDir = makeTmpRepo(orchId);
    process.env.ORCHESTRAY_AUTOFILL_SAMPLE_INTERVAL = '5';
    const writer = freshWriter();
    try {
      sendAutofillingEvents(writer, 12, tmpDir);

      const events    = readEvents(tmpDir);
      const autofills = events.filter((e) => e.type === 'audit_event_autofilled');
      assert.equal(autofills.length, 2,
        `expected floor(12/5)=2 audit_event_autofilled rows; got ${autofills.length}`);
      assert.equal(autofills[0].sample_count, 5);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('sub-interval occurrences are queued, not lost, on the next sampling window', () => {
    // 10 calls emit 1 row; 3 more calls (13 total) should still show only 1
    // row (3 < interval), and the 3 partial occurrences are queued in the
    // state file for the NEXT window rather than being dropped.
    const orchId = 'orch-w1a-t4';
    const tmpDir = makeTmpRepo(orchId);
    const writer = freshWriter();
    try {
      sendAutofillingEvents(writer, 13, tmpDir);
      let autofills = readEvents(tmpDir).filter((e) => e.type === 'audit_event_autofilled');
      assert.equal(autofills.length, 1, 'only the first full window (10) has emitted so far');

      // 7 more calls complete the second window (3 queued + 7 = 10).
      sendAutofillingEvents(writer, 7, tmpDir);
      autofills = readEvents(tmpDir).filter((e) => e.type === 'audit_event_autofilled');
      assert.equal(autofills.length, 2, 'queued occurrences count toward the next window');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('D4 (v2.3.18 W1a) — audit_event_autofill_threshold_exceeded timestamp', () => {
  test('threshold-exceeded rows carry a timestamp field', () => {
    const orchId = 'orch-w1a-thresh';
    const tmpDir = makeTmpRepo(orchId);
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
    const writer = freshWriter();
    const testHooks = writer._testHooks;
    testHooks.resetForOrch(orchId);
    try {
      // 15 conformant + 5 autofilled = 20 total, ratio = 0.25 > default 0.20.
      for (let i = 0; i < 15; i++) testHooks.trackThreshold('sample_evt', false, orchId, tmpDir, eventsPath);
      for (let i = 0; i < 5;  i++) testHooks.trackThreshold('sample_evt', true,  orchId, tmpDir, eventsPath);

      const events    = readEvents(tmpDir);
      const exceeded  = events.filter((e) => e.type === 'audit_event_autofill_threshold_exceeded');
      assert.equal(exceeded.length, 1, 'expected exactly 1 threshold emit');
      assert.equal(typeof exceeded[0].timestamp, 'string', 'timestamp must be present and a string');
      assert.ok(!isNaN(Date.parse(exceeded[0].timestamp)), 'timestamp must be a valid ISO date');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
