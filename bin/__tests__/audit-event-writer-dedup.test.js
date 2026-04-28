#!/usr/bin/env node
'use strict';

/**
 * audit-event-writer-dedup.test.js — v2.2.2 Fix B2.
 *
 * Asserts that `bin/_lib/audit-event-writer.js` `writeEvent()` appends
 * EXACTLY ONE line per call to `events.jsonl` across every internal branch:
 *
 *   1. Happy path                — known event type with required fields.
 *   2. Unknown event type        — appends original AND advisory (2 lines, NOT 4).
 *   3. Validation failure        — appends only the surrogate (1 line, NOT 2).
 *   4. Circuit-broken bypass     — appends original as-is (1 line).
 *   5. Schema-unreadable warning — appends original (1 line).
 *   6. Stress: 100 sequential calls produce exactly 100 lines.
 *
 * D2 §Finding 6 surfaced a 2× duplicate-emission pattern in
 * `.orchestray/history/1777284778-orchestration/events.jsonl`. Investigation
 * during v2.2.2 implementation determined the duplicates originate from
 * MULTIPLE HOOK REGISTRATIONS firing concurrently (e.g. SessionStart +
 * UserPromptSubmit phase-slice pair before A5; SubagentStop + TaskCompleted
 * collect-agent-metrics pair) — NOT from a writer-level fall-through. These
 * tests pin the writer's per-call contract so any future regression
 * (whether at the writer or at any caller that adopts a similar pattern) is
 * caught.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const { spawnSync }      = require('node:child_process');
const path               = require('node:path');
const fs                 = require('node:fs');
const os                 = require('node:os');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const GATEWAY     = path.resolve(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');

function makeTmpRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-dedup-test-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  return tmpDir;
}

function readEventsJsonl(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Run a node child that loads writeEvent and invokes it `n` times with the
 * same payload. Returns the parsed events.jsonl rows.
 */
function callWriteEventN(tmpDir, eventPayload, n, extraOpts) {
  const opts = Object.assign({ cwd: tmpDir }, extraOpts || {});
  const harness = `
    const { writeEvent } = require(${JSON.stringify(GATEWAY)});
    const payload = ${JSON.stringify(eventPayload)};
    const opts    = ${JSON.stringify(opts)};
    for (let i = 0; i < ${n}; i++) writeEvent(Object.assign({}, payload), opts);
  `;
  spawnSync(process.execPath, ['-e', harness], { encoding: 'utf8', timeout: 15000 });
  return readEventsJsonl(tmpDir);
}

describe('audit-event-writer dedup (v2.2.2 B2)', () => {

  test('1. Happy path — single writeEvent yields exactly one line', () => {
    const tmpDir = makeTmpRepo();
    try {
      // schema_shadow_hit has just type+version+event_type required.
      // v2.2.9 F1: provide all required fields (timestamp+orchestration_id
      // included) so the autofill telemetry advisory does not fire.
      const lines = callWriteEventN(tmpDir, {
        type: 'schema_shadow_hit',
        version: 1,
        timestamp: '2026-04-28T18:00:00.000Z',
        orchestration_id: 'orch-test',
        event_type: 'tier2_load',
      }, 1);
      assert.equal(lines.length, 1, 'exactly one line appended; got: ' + lines.length);
      assert.equal(lines[0].type, 'schema_shadow_hit');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('2. schema_shadow_miss known event — single call yields one line', () => {
    const tmpDir = makeTmpRepo();
    try {
      // v2.2.9 F1: provide all required fields so the autofill advisory
      // does not fire.
      const lines = callWriteEventN(tmpDir, {
        type: 'schema_shadow_miss',
        version: 1,
        timestamp: '2026-04-28T18:00:00.000Z',
        orchestration_id: 'orch-test',
        event_type: 'tier2_load',
        miss_count_24h: 1,
        source_hash: 'abc123',
      }, 1);
      assert.equal(lines.length, 1, 'exactly one line; got: ' + lines.length);
      assert.equal(lines[0].type, 'schema_shadow_miss');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('3. Unknown event type — appends original + 1 advisory (2 lines, NOT 4)', () => {
    const tmpDir = makeTmpRepo();
    try {
      const lines = callWriteEventN(tmpDir, { type: 'totally_made_up_event_xyz_v222' }, 1);
      assert.equal(lines.length, 2, 'exactly two lines (original + advisory); got: ' + lines.length);
      const original = lines.filter((e) => e.type === 'totally_made_up_event_xyz_v222');
      const advisory = lines.filter((e) => e.type === 'schema_unknown_type_warn');
      assert.equal(original.length, 1, 'original written exactly once');
      assert.equal(advisory.length, 1, 'advisory written exactly once');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('4. Validation failure (missing required) — only the surrogate (1 line, NOT 2)', () => {
    const tmpDir = makeTmpRepo();
    try {
      // tier2_load is in the schema but requires fields. Empty payload triggers
      // the strict drop+surrogate path.
      const lines = callWriteEventN(tmpDir, { type: 'tier2_load' }, 1);
      assert.equal(lines.length, 1, 'exactly one line (the surrogate); got: ' + lines.length);
      assert.equal(lines[0].type, 'schema_shadow_validation_block');
      assert.equal(lines[0].blocked_event_type, 'tier2_load');
      // The original tier2_load MUST NOT be written.
      const originals = lines.filter((e) => e.type === 'tier2_load');
      assert.equal(originals.length, 0, 'original NOT written');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('5. Circuit-broken bypass — single call yields one line', () => {
    const tmpDir = makeTmpRepo();
    try {
      // Trip the sentinel
      fs.writeFileSync(
        path.join(tmpDir, '.orchestray', 'state', '.schema-shadow-disabled'),
        'manual\n'
      );
      const lines = callWriteEventN(tmpDir, { type: 'totally_made_up_event_xyz_v222b' }, 1);
      assert.equal(lines.length, 1, 'exactly one line (bypass); got: ' + lines.length);
      assert.equal(lines[0].type, 'totally_made_up_event_xyz_v222b');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('6. skipValidation branch — single call yields one line', () => {
    const tmpDir = makeTmpRepo();
    try {
      const lines = callWriteEventN(tmpDir, { type: 'schema_shadow_hit', version: 1, event_type: 'tier2_load' }, 1, { skipValidation: true });
      assert.equal(lines.length, 1, 'exactly one line; got: ' + lines.length);
      assert.equal(lines[0].type, 'schema_shadow_hit');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('7. Stress — 100 sequential calls produce exactly 100 lines', () => {
    const tmpDir = makeTmpRepo();
    try {
      // v2.2.9 F1: provide all required fields so the autofill advisory
      // does not fire — the dedup invariant is "1 line per writeEvent
      // when the payload is complete".
      const lines = callWriteEventN(tmpDir, {
        type: 'schema_shadow_hit',
        version: 1,
        timestamp: '2026-04-28T18:00:00.000Z',
        orchestration_id: 'orch-test',
        event_type: 'tier2_load',
      }, 100);
      assert.equal(lines.length, 100, 'exactly 100 lines; got: ' + lines.length);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
