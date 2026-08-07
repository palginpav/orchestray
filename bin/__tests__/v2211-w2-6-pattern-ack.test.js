#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-6-pattern-ack.test.js — validate-pattern-ack.js tests.
 *
 * Rewritten twice. Original v2.2.11 W2-6 tests covered the legacy
 * architect-only, text-scan, `{matches: [...]}` full-mode-shaped fixture.
 * First rewrite (v2.3.19 Phase 2, design §4.2) generalized past-architect
 * and added structured-fields coverage, but derived the offered set from a
 * `<mcp-grounding>` fence embedded in the prompt — which only 4 of 15 roles
 * ever receive (RV-2 Issue 2). This rewrite drops all grounding-block
 * fixtures: the offered set now comes from a Phase-1 offer-ledger row
 * (.orchestray/state/pattern-offers.jsonl, the file bin/record-pattern-offers.js
 * writes), exactly as the hook itself now reads it. Coverage:
 *   - the ledger-lookup fix itself (curatedOfferedSlugs, and the RV-2
 *     reproduction: a developer spawn with a curated offer row and no
 *     patterns_used/rejected must now produce events, where it previously
 *     produced none),
 *   - ambient offers do NOT drive the coverage check (design §5.4 priority),
 *   - patterns_used/patterns_rejected coverage (the structured-fields path),
 *   - the pattern-acks.jsonl ledger row,
 *   - the pattern_ack_captured / pattern_application_withheld events.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const mod = require('../validate-pattern-ack.js');
const SCRIPT = path.resolve(__dirname, '..', 'validate-pattern-ack.js');

const ORCH_ID = 'orch-test-1';

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-w2-6-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Marks ORCH_ID as the active orchestration — mirrors what a real run's
 * orchestration-state writer leaves behind, and what record-pattern-offers.js
 * reads via peekOrchestrationId() when it wrote the offer row under test. */
function writeOrchMarker(orchId) {
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId })
  );
}

function offerRow({ orchestrationId = ORCH_ID, spawnId = 'spawn-test-001', agentRole = 'developer', taskId = 'W1', offers }) {
  return {
    timestamp: '2026-08-07T09:00:00.000Z',
    orchestration_id: orchestrationId,
    spawn_id: spawnId,
    agent_role: agentRole,
    task_id: taskId,
    offers,
    shape_detected: 'uri_only',
    unresolved_slugs: [],
  };
}

/** Seeds the Phase-1 offer ledger exactly as bin/record-pattern-offers.js would. */
function writeOfferRows(rows) {
  const offersPath = path.join(tmpDir, '.orchestray', 'state', 'pattern-offers.jsonl');
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFileSync(offersPath, lines);
}

function buildPayload({
  summary = '', role = 'developer', patternsUsed, patternsRejected, spawnId = 'spawn-test-001',
} = {}) {
  const sr = { status: 'success', summary, files_changed: [], files_read: [], issues: [], assumptions: [] };
  if (patternsUsed !== undefined) sr.patterns_used = patternsUsed;
  if (patternsRejected !== undefined) sr.patterns_rejected = patternsRejected;

  const toolResponse = ['Some reasoning.', '', '## Structured Result', '```json', JSON.stringify(sr), '```'].join('\n');

  return {
    tool_name: 'Agent',
    tool_input: { subagent_type: role, prompt: 'Do the task.', agent_id: spawnId },
    tool_response: toolResponse,
    cwd: tmpDir,
  };
}

function runHook(payload, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });

  if (result.error) throw result.error;

  let stdout = {};
  try { stdout = JSON.parse(result.stdout || '{}'); } catch (_) {}

  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  const events = [];
  if (fs.existsSync(eventsPath)) {
    for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch (_) {}
    }
  }

  const ackPath = path.join(tmpDir, '.orchestray', 'state', 'pattern-acks.jsonl');
  const acks = [];
  if (fs.existsSync(ackPath)) {
    for (const line of fs.readFileSync(ackPath, 'utf8').split('\n').filter(Boolean)) {
      try { acks.push(JSON.parse(line)); } catch (_) {}
    }
  }

  return { stdout, events, acks };
}

// ---------------------------------------------------------------------------
// RV-2 Issue 2 — the reproduction from the review, run against the fix
// ---------------------------------------------------------------------------

test('RV-2 repro: developer spawn with a curated offer row and no patterns_used/rejected ' +
     'now produces events and (via the legacy scan) a coverage-gap signal — was silently zero', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({
      spawnId: 'spawn-dev-1',
      offers: [{ slug: 'decomposition-audit-fix-verify-cycle', offer_kind: 'curated', confidence: 0.9 }],
    })]);
    const payload = buildPayload({ role: 'developer', spawnId: 'spawn-dev-1', summary: 'did it' });
    const { events, acks } = runHook(payload);

    const captured = events.filter((e) => e.type === 'pattern_ack_captured');
    assert.equal(captured.length, 1, 'pattern_ack_captured must fire for a non-architect role now');
    assert.equal(captured[0].ack_source, 'legacy_text_scan', 'no patterns_used/rejected fields → legacy fallback');
    const withheld = events.filter((e) => e.type === 'pattern_application_withheld');
    assert.equal(withheld.length, 1, 'the offered curated slug was never acknowledged');
    assert.equal(withheld[0].slug, 'decomposition-audit-fix-verify-cycle');
    // Legacy-scan path never writes to the Phase-3 join ledger (unreliable signal) — documented, not a gap.
    assert.equal(acks.length, 0);
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Role generalization — any subagent_type with a curated offer row is checked
// ---------------------------------------------------------------------------

describe('role generalization', () => {
  for (const role of ['developer', 'tester', 'reviewer', 'architect']) {
    test('role=' + role + ': curated offer with full coverage → coverage_complete=true', () => {
      setup();
      try {
        writeOrchMarker(ORCH_ID);
        writeOfferRows([offerRow({
          agentRole: role,
          offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }],
        })]);
        const payload = buildPayload({
          role,
          patternsUsed: [{ slug: 'decompose-parallel', how: 'drove the task split across three agents' }],
          patternsRejected: [],
        });
        const { events } = runHook(payload);
        const captured = events.filter((e) => e.type === 'pattern_ack_captured');
        assert.equal(captured.length, 1);
        assert.equal(captured[0].coverage_complete, true);
        assert.equal(events.filter((e) => e.type === 'pattern_application_withheld').length, 0);
      } finally { teardown(); }
    });
  }
});

// ---------------------------------------------------------------------------
// Ambient offers must not drive the coverage check (design §5.4 priority)
// ---------------------------------------------------------------------------

test('ambient-only offer row → no check at all (curated is the only signal this hook reasons about)', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({
      offers: [{ slug: 'ambient-only-slug', offer_kind: 'ambient', confidence: 0.75 }],
    })]);
    const payload = buildPayload({ summary: 'Design completed without any pattern references.' });
    const { stdout, events } = runHook(payload);
    assert.deepEqual(stdout, { continue: true });
    assert.equal(events.filter((e) => e.type === 'pattern_ack_captured').length, 0);
    assert.equal(events.filter((e) => e.type === 'pattern_application_withheld').length, 0);
  } finally { teardown(); }
});

test('mixed offer row (curated + ambient) → only the curated slug enters the offered set', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({
      offers: [
        { slug: 'curated-slug', offer_kind: 'curated', confidence: 0.9 },
        { slug: 'ambient-slug', offer_kind: 'ambient', confidence: 0.6 },
      ],
    })]);
    const payload = buildPayload({ summary: 'no mentions' });
    const { events } = runHook(payload);
    const withheld = events.filter((e) => e.type === 'pattern_application_withheld');
    assert.equal(withheld.length, 1, 'only the curated slug should be tracked as offered');
    assert.equal(withheld[0].slug, 'curated-slug');
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// No offer row → safe-on-missing (generalized: no grounding-block dependency)
// ---------------------------------------------------------------------------

test('no offer-ledger row for this spawn_id → no check, 0 emits (safe-on-missing)', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    // No writeOfferRows() call at all.
    const payload = buildPayload({ summary: 'nothing offered' });
    const { stdout, events } = runHook(payload);
    assert.deepEqual(stdout, { continue: true });
    assert.equal(events.length, 0);
  } finally { teardown(); }
});

test('offer row exists but for a different spawn_id → not joined, no check', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({
      spawnId: 'spawn-other',
      offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }],
    })]);
    const payload = buildPayload({ spawnId: 'spawn-test-001', summary: 'irrelevant' });
    const { events } = runHook(payload);
    assert.equal(events.length, 0, 'offers belonging to a sibling spawn must not leak into this one');
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Structured-fields path — patterns_used/patterns_rejected coverage (§4.2)
// ---------------------------------------------------------------------------

test('structured fields: full coverage (1 used, 1 rejected) → coverage_complete=true, no withheld', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({
      offers: [
        { slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 },
        { slug: 'event-schema-declare', offer_kind: 'curated', confidence: 0.9 },
      ],
    })]);
    const payload = buildPayload({
      summary: 'ok',
      patternsUsed: [{ slug: 'decompose-parallel', how: 'drove the task split across three agents' }],
      patternsRejected: [{ slug: 'event-schema-declare', why: 'no new event types in this change' }],
    });
    const { events, acks } = runHook(payload);
    const captured = events.filter((e) => e.type === 'pattern_ack_captured');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].coverage_complete, true);
    assert.equal(captured[0].ack_source, 'structured_fields');
    assert.deepEqual(captured[0].used_slugs.sort(), ['decompose-parallel']);
    assert.deepEqual(captured[0].rejected_slugs.sort(), ['event-schema-declare']);
    assert.equal(events.filter((e) => e.type === 'pattern_application_withheld').length, 0);

    assert.equal(acks.length, 1, 'structured-fields path must write an ack ledger row');
    assert.equal(acks[0].orchestration_id, ORCH_ID);
    assert.equal(acks[0].source, 'structured_result');
    assert.equal(acks[0].used.length, 1);
    assert.equal(acks[0].used[0].slug, 'decompose-parallel');
    assert.ok(acks[0].used[0].how_len > 0);
    assert.equal(acks[0].rejected.length, 1);
    assert.ok(acks[0].rejected[0].why_len > 0);
  } finally { teardown(); }
});

test('structured fields: symmetry rule violated (only 1 of 2 offered slugs covered) → 1 withheld', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({
      offers: [
        { slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 },
        { slug: 'event-schema-declare', offer_kind: 'curated', confidence: 0.9 },
      ],
    })]);
    const payload = buildPayload({
      summary: 'ok',
      patternsUsed: [{ slug: 'decompose-parallel', how: 'drove the task split across three agents' }],
      patternsRejected: [],
    });
    const { events } = runHook(payload);
    const captured = events.filter((e) => e.type === 'pattern_ack_captured')[0];
    assert.equal(captured.coverage_complete, false);
    const withheld = events.filter((e) => e.type === 'pattern_application_withheld');
    assert.equal(withheld.length, 1);
    assert.equal(withheld[0].slug, 'event-schema-declare');
  } finally { teardown(); }
});

test('structured fields: legacy text-scan fallback is NOT used when patterns_used/rejected are present ' +
     'even if empty (an agent that legitimately used nothing)', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({ offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.8 }] })]);
    const payload = buildPayload({
      summary: 'mentions decompose-parallel by name but explicitly rejected it below',
      patternsUsed: [],
      patternsRejected: [{ slug: 'decompose-parallel', why: 'considered but not a fit for this task shape' }],
    });
    const { events } = runHook(payload);
    const captured = events.filter((e) => e.type === 'pattern_ack_captured')[0];
    assert.equal(captured.ack_source, 'structured_fields');
    assert.equal(captured.coverage_complete, true, 'explicit rejection must count even though the summary also mentions the slug');
    assert.deepEqual(captured.used_slugs, []);
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test('kill switch ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1 → 0 emits', () => {
  setup();
  try {
    writeOrchMarker(ORCH_ID);
    writeOfferRows([offerRow({ offers: [{ slug: 'decompose-parallel', offer_kind: 'curated', confidence: 0.85 }] })]);
    const payload = buildPayload({ summary: 'Design with no slug reference.' });
    const { stdout, events } = runHook(payload, { ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED: '1' });
    assert.deepEqual(stdout, { continue: true });
    assert.equal(events.length, 0, 'kill switch must suppress all events');
  } finally { teardown(); }
});

// ---------------------------------------------------------------------------
// Event-schema shadow allowlist — the superseded event type is retained
// ---------------------------------------------------------------------------

test('schema validation: architect_pattern_ack_missing is retained in the shadow allowlist', () => {
  const shadowPath = path.resolve(__dirname, '..', '..', 'agents', 'pm-reference', 'event-schemas.shadow.json');
  assert.ok(fs.existsSync(shadowPath), 'shadow file must exist');
  const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
  assert.ok('architect_pattern_ack_missing' in shadow,
    'architect_pattern_ack_missing entry must be retained (dark-event auditor still resolves it)');
});

// ---------------------------------------------------------------------------
// curatedOfferedSlugs — direct unit coverage of the fixed join
// ---------------------------------------------------------------------------

describe('curatedOfferedSlugs (unit)', () => {
  test('no spawnId → [] without reading the ledger', () => {
    setup();
    try {
      assert.deepEqual(mod.curatedOfferedSlugs(tmpDir, ORCH_ID, null), []);
    } finally { teardown(); }
  });

  test('unions curated slugs across multiple rows for the same spawn_id (retry case), excludes ambient', () => {
    setup();
    try {
      writeOfferRows([
        offerRow({ offers: [{ slug: 'a', offer_kind: 'curated', confidence: 0.8 }] }),
        offerRow({ offers: [
          { slug: 'a', offer_kind: 'curated', confidence: 0.8 },
          { slug: 'b', offer_kind: 'curated', confidence: 0.7 },
          { slug: 'c', offer_kind: 'ambient', confidence: 0.9 },
        ] }),
      ]);
      const slugs = mod.curatedOfferedSlugs(tmpDir, ORCH_ID, 'spawn-test-001').sort();
      assert.deepEqual(slugs, ['a', 'b']);
    } finally { teardown(); }
  });

  test('rows for a different orchestration_id are not joined', () => {
    setup();
    try {
      writeOfferRows([offerRow({ orchestrationId: 'orch-other', offers: [{ slug: 'a', offer_kind: 'curated', confidence: 0.8 }] })]);
      assert.deepEqual(mod.curatedOfferedSlugs(tmpDir, ORCH_ID, 'spawn-test-001'), []);
    } finally { teardown(); }
  });
});
