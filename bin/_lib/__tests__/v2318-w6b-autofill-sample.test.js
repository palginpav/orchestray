#!/usr/bin/env node
'use strict';

/**
 * v2318-w6b-autofill-sample.test.js — E2 + E3 (v2.3.18 W6b).
 *
 * E2 — the W1a sampling state file escaped W0's D7 sandbox. `testRedirectFor`
 *   covers only events.jsonl, so a full `npm test` mutated the LIVE production
 *   counters in place: state_file_corrupt 8 -> 1 (crossed the %10 boundary,
 *   emitted, reset), mcp_tool_call 9 -> 5, git_destructive_blocked 5 -> 8 —
 *   while events.jsonl itself was untouched at 25522 lines.
 *
 * E3 — the sampling read-modify-write was lock-free with a bare
 *   `fs.writeFileSync`. Two hook processes could lose an update; a torn read
 *   fails open to `{by_type:{}}`, i.e. the counter RESETS, and under sustained
 *   concurrency it can reset before the interval is ever reached, so
 *   `audit_event_autofilled` never emits at all. Plus a partial window (1-9)
 *   never flushed at orchestration end and bled into the next run.
 *
 * Runner: node --test bin/_lib/__tests__/v2318-w6b-autofill-sample.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawn } = require('node:child_process');

const GATEWAY = path.resolve(__dirname, '..', 'audit-event-writer.js');

const auditEventWriter = require(GATEWAY);
const {
  autofillSamplePath,
  autofillSampleRedirectFor,
  sandboxAutofillSamplePath,
  saveAutofillSample,
  loadAutofillSample,
  PACKAGE_ROOT,
} = auditEventWriter._testHooks;

const LIVE_SAMPLE = path.join(PACKAGE_ROOT, '.orchestray', 'state', 'audit-autofill-sample.json');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYNTHETIC_SCHEMA = `# Event Schemas (minimal fixture for W6b sampling tests)

### \`sample_evt\` event

Test event for E3 sampling.

\`\`\`json
{
  "type": "sample_evt",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx"
}
\`\`\`

### \`orchestration_complete\` event

Closes an orchestration; flushes partial sampling windows.

\`\`\`json
{
  "type": "orchestration_complete",
  "version": 1
}
\`\`\`
`;

function makeTmpRepo(orchId) {
  const tmpDir   = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w6b-sample-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.writeFileSync(path.join(pmRefDir, 'event-schemas.md'), SYNTHETIC_SCHEMA, 'utf8');

  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  setOrchestration(tmpDir, orchId);
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');
  return tmpDir;
}

function setOrchestration(tmpDir, orchId) {
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function readEvents(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function autofillRows(tmpDir) {
  return readEvents(tmpDir).filter((e) => e.type === 'audit_event_autofilled');
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

/** Emit `count` events that omit timestamp+orchestration_id (autofill trigger). */
function sendAutofilling(writer, count, tmpDir) {
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  for (let i = 0; i < count; i++) {
    writer.writeEvent({ type: 'sample_evt', version: 1 }, { cwd: tmpDir, eventsPath });
  }
}

// ---------------------------------------------------------------------------
// E2 — the sampling file obeys the D7 sandbox
// ---------------------------------------------------------------------------

describe('E2 (v2.3.18 W6b): test writes never touch the live sampling file', () => {
  test('the live sample path is redirected to a per-process sandbox under test', () => {
    const resolved = autofillSamplePath(PACKAGE_ROOT);
    assert.notEqual(path.resolve(resolved), LIVE_SAMPLE);
    assert.equal(resolved, sandboxAutofillSamplePath());
  });

  test('a caller-supplied temp cwd is left alone — the correct pattern still works', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w6b-d7-'));
    try {
      const resolved = autofillSamplePath(tmp);
      assert.equal(resolved, path.join(tmp, '.orchestray', 'state', 'audit-autofill-sample.json'));
      assert.equal(autofillSampleRedirectFor(resolved), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('outside the test harness the live path is returned unchanged', () => {
    const savedTest = process.env.ORCHESTRAY_TEST;
    const savedNode = process.env.NODE_ENV;
    delete process.env.ORCHESTRAY_TEST;
    delete process.env.NODE_ENV;
    try {
      assert.equal(autofillSampleRedirectFor(LIVE_SAMPLE), null);
      assert.equal(path.resolve(autofillSamplePath(PACKAGE_ROOT)), LIVE_SAMPLE);
    } finally {
      if (savedTest !== undefined) process.env.ORCHESTRAY_TEST = savedTest;
      if (savedNode !== undefined) process.env.NODE_ENV = savedNode;
    }
  });

  test('a save aimed at the package root does NOT mutate the live sampling file', () => {
    // This is exactly the shape that corrupted production: no cwd, so the
    // writer resolved the sampling path back to the real project root.
    const before = fs.existsSync(LIVE_SAMPLE) ? fs.readFileSync(LIVE_SAMPLE, 'utf8') : null;

    saveAutofillSample(PACKAGE_ROOT, { by_type: { poison_evt: { count: 999, fields: ['x'] } } });

    const after = fs.existsSync(LIVE_SAMPLE) ? fs.readFileSync(LIVE_SAMPLE, 'utf8') : null;
    assert.equal(after, before, 'the live sampling file must not change during tests');

    // ...and the write really did land somewhere.
    const sandboxed = loadAutofillSample(PACKAGE_ROOT);
    assert.equal(sandboxed.by_type.poison_evt.count, 999);
  });

  test('writeEvent with no cwd does NOT mutate the live sampling file', () => {
    const before = fs.existsSync(LIVE_SAMPLE) ? fs.readFileSync(LIVE_SAMPLE, 'utf8') : null;
    for (let i = 0; i < 12; i++) {
      auditEventWriter.writeEvent({ type: 'state_file_corrupt', version: 1, path: '/tmp/x', reason: 'syntax_error' });
    }
    const after = fs.existsSync(LIVE_SAMPLE) ? fs.readFileSync(LIVE_SAMPLE, 'utf8') : null;
    assert.equal(after, before, 'the live sampling counters must not move during tests');
  });
});

// ---------------------------------------------------------------------------
// E3 — locked read-modify-write, tear-free writes, partial-window flush
// ---------------------------------------------------------------------------

describe('E3 (v2.3.18 W6b): sampling RMW is serialized and tear-free', () => {
  test('saveAutofillSample leaves no partial file and no tmp litter', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w6b-atomic-'));
    try {
      const big = { by_type: {} };
      for (let i = 0; i < 500; i++) big.by_type['t' + i] = { count: i, fields: ['a', 'b', 'c'] };
      saveAutofillSample(tmp, big);

      const file = autofillSamplePath(tmp);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), big, 'content must be complete');
      const litter = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp.'));
      assert.deepEqual(litter, [], 'tmp+rename must not leave a temp file behind');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a torn/corrupt sample file fails open without throwing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w6b-torn-'));
    try {
      const file = autofillSamplePath(tmp);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"by_type":{"a":{"count":3,', 'utf8');   // truncated write
      assert.deepEqual(loadAutofillSample(tmp), { by_type: {} });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('4 concurrent processes x 25 events lose no occurrences', async () => {
    // 100 occurrences at interval 10 == exactly 10 sampled rows. Without the
    // advisory lock, concurrent read-modify-write drops updates (and a torn
    // read resets the counter outright), so the count comes in short.
    const tmpDir = makeTmpRepo('orch-w6b-concurrent');
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
    const child = `
      const w = require(${JSON.stringify(GATEWAY)});
      for (let i = 0; i < 25; i++) {
        w.writeEvent({ type: 'sample_evt', version: 1 },
          { cwd: ${JSON.stringify(tmpDir)}, eventsPath: ${JSON.stringify(eventsPath)} });
      }
    `;
    const env = Object.assign({}, process.env, {
      ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED: '1',
      ORCHESTRAY_AUTOFILL_SAMPLE_INTERVAL: '10',
    });
    delete env.ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED;

    try {
      const procs = [];
      for (let i = 0; i < 4; i++) {
        procs.push(spawn(process.execPath, ['-e', child], { env, cwd: tmpDir, stdio: 'ignore' }));
      }
      await Promise.all(procs.map((p) => new Promise((resolve) => p.on('exit', resolve))));

      const rows  = autofillRows(tmpDir);
      const total = rows.reduce((n, r) => n + r.sample_count, 0);
      assert.equal(total, 100, 'every occurrence must be accounted for; got ' + total);
      assert.equal(rows.length, 10, 'expected 100/10 = 10 sampled rows; got ' + rows.length);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a partial window flushes when the orchestration completes', () => {
    const tmpDir = makeTmpRepo('orch-w6b-flush');
    const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
    const saved = process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED;
    process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED = '1';
    const writer = freshWriter();
    try {
      sendAutofilling(writer, 3, tmpDir);
      assert.equal(autofillRows(tmpDir).length, 0, '3 < interval — nothing emitted yet');

      // Fully specified so the close event itself autofills nothing.
      writer.writeEvent({
        type: 'orchestration_complete',
        version: 1,
        timestamp: new Date().toISOString(),
        orchestration_id: 'orch-w6b-flush',
      }, { cwd: tmpDir, eventsPath });

      const rows = autofillRows(tmpDir);
      assert.equal(rows.length, 1, 'the partial window must be flushed at orchestration end');
      assert.equal(rows[0].sample_count, 3);
      assert.equal(rows[0].event_type, 'sample_evt');
    } finally {
      if (saved === undefined) delete process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED;
      else process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED = saved;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a window left behind by a previous orchestration is flushed, not inherited', () => {
    const tmpDir = makeTmpRepo('orch-w6b-first');
    const saved = process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED;
    process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED = '1';
    const writer = freshWriter();
    try {
      sendAutofilling(writer, 4, tmpDir);
      assert.equal(autofillRows(tmpDir).length, 0);

      setOrchestration(tmpDir, 'orch-w6b-second');
      sendAutofilling(writer, 1, tmpDir);

      const rows = autofillRows(tmpDir);
      assert.equal(rows.length, 1, 'rollover flushes the stranded window');
      assert.equal(rows[0].sample_count, 4);
      assert.equal(rows[0].orchestration_id, 'orch-w6b-first',
        'the flushed window belongs to the orchestration that produced it');

      // The occurrence that triggered the rollover starts the new window; it
      // must not be folded into the flushed row.
      const state = loadAutofillSample(tmpDir);
      assert.equal(state.by_type.sample_evt.count, 1);
      assert.equal(state.orchestration_id, 'orch-w6b-second');
    } finally {
      if (saved === undefined) delete process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED;
      else process.env.ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED = saved;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
