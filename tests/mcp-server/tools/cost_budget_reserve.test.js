#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/tools/cost_budget_reserve.js
 *
 * Per v2016-reviewer-audit.md F03 — covers W4 test plan cases.
 *
 * Coverage:
 *   A — basic reserve: creates a record and returns the expected shape
 *   B — reservation_id idempotency (F04): same id → same record, no duplicate row
 *   C — atomic-append concurrent-writers regression (F05): atomicAppendJsonl is used
 *   D — effort multiplier reflected in projected cost
 *   E — reservation appears in cost_budget_check accumulated_cost_usd (F01 critical test)
 *   F — input validation: missing required fields returns toolError
 *   G — custom agent_type (non-enum role) is accepted
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { handle } = require('../../../bin/mcp-server/tools/cost_budget_reserve');
const { handle: checkHandle } = require('../../../bin/mcp-server/tools/cost_budget_check');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reserve-test-'));
  cleanup.push(dir);
  // Create the state directory up-front so the tool can write to it.
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function reservationsPath(projectRoot) {
  return path.join(projectRoot, '.orchestray', 'state', 'cost-reservations.jsonl');
}

function baseInput(overrides = {}) {
  return Object.assign(
    {
      orchestration_id: 'orch-test-001',
      task_id: 'task-1',
      agent_type: 'developer',
      model: 'sonnet',
    },
    overrides
  );
}

function makeContext(projectRoot, config = {}) {
  return { projectRoot, config };
}

function readAllRows(projectRoot) {
  const p = reservationsPath(projectRoot);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// A: basic reserve
// ---------------------------------------------------------------------------

describe('A: basic reserve', () => {
  test('returns success with the expected output shape', async () => {
    const dir = makeProjectRoot();
    const result = await handle(baseInput(), makeContext(dir));
    assert.equal(result.isError, false, 'must not be an error');
    const body = result.structuredContent;
    assert.ok(typeof body.reservation_id === 'string', 'reservation_id must be a string');
    assert.ok(body.reservation_id.startsWith('res-'), 'reservation_id must start with res-');
    assert.equal(body.orchestration_id, 'orch-test-001');
    assert.equal(body.task_id, 'task-1');
    assert.equal(body.agent_type, 'developer');
    assert.equal(body.model, 'sonnet');
    assert.equal(body.model_tier, 'sonnet');
    assert.ok(typeof body.projected_cost_usd === 'number' && body.projected_cost_usd > 0,
      'projected_cost_usd must be a positive number');
    assert.ok(typeof body.expires_at === 'string', 'expires_at must be a string');
    assert.ok(typeof body.created_at === 'string', 'created_at must be a string');
    // expires_at must be ~30 minutes after created_at
    const ttlMs = new Date(body.expires_at).getTime() - new Date(body.created_at).getTime();
    assert.ok(ttlMs >= 29 * 60 * 1000 && ttlMs <= 31 * 60 * 1000,
      'TTL must be approximately 30 minutes; got ' + ttlMs + 'ms');
  });

  test('writes exactly one JSONL row to cost-reservations.jsonl', async () => {
    const dir = makeProjectRoot();
    await handle(baseInput(), makeContext(dir));
    const rows = readAllRows(dir);
    assert.equal(rows.length, 1, 'exactly one row must be appended');
    assert.ok(rows[0].reservation_id, 'row must have reservation_id');
    assert.equal(rows[0].orchestration_id, 'orch-test-001');
  });

  test('each call without a reservation_id generates a unique id', async () => {
    const dir = makeProjectRoot();
    const r1 = await handle(baseInput(), makeContext(dir));
    const r2 = await handle(baseInput(), makeContext(dir));
    assert.notEqual(
      r1.structuredContent.reservation_id,
      r2.structuredContent.reservation_id,
      'two calls without reservation_id must produce unique ids'
    );
    const rows = readAllRows(dir);
    assert.equal(rows.length, 2, 'two rows must be written');
  });
});

// ---------------------------------------------------------------------------
// B: reservation_id idempotency (F04)
// ---------------------------------------------------------------------------

describe('B: reservation_id idempotency (F04)', () => {
  test('calling with the same reservation_id twice returns the same record', async () => {
    const dir = makeProjectRoot();
    const input = baseInput({ reservation_id: 'res-idempotency-test-1' });

    const r1 = await handle(input, makeContext(dir));
    const r2 = await handle(input, makeContext(dir));

    assert.equal(r1.isError, false, 'first call must succeed');
    assert.equal(r2.isError, false, 'second call must succeed');
    assert.equal(r1.structuredContent.reservation_id, 'res-idempotency-test-1');
    assert.equal(r2.structuredContent.reservation_id, 'res-idempotency-test-1');
    // All cost fields must match between calls.
    assert.equal(
      r1.structuredContent.projected_cost_usd,
      r2.structuredContent.projected_cost_usd,
      'projected_cost_usd must be identical on idempotent return'
    );
    assert.equal(r1.structuredContent.expires_at, r2.structuredContent.expires_at);
    assert.equal(r1.structuredContent.created_at, r2.structuredContent.created_at);
  });

  test('idempotent call writes only one row to the ledger (no duplicate)', async () => {
    const dir = makeProjectRoot();
    const input = baseInput({ reservation_id: 'res-dedup-check-1' });

    await handle(input, makeContext(dir));
    await handle(input, makeContext(dir));
    await handle(input, makeContext(dir));

    const rows = readAllRows(dir);
    const matching = rows.filter(r => r.reservation_id === 'res-dedup-check-1');
    assert.equal(matching.length, 1, 'only one row must exist for the reservation_id');
  });

  test('two distinct reservation_ids create two rows', async () => {
    const dir = makeProjectRoot();
    await handle(baseInput({ reservation_id: 'res-aaa' }), makeContext(dir));
    await handle(baseInput({ reservation_id: 'res-bbb' }), makeContext(dir));

    const rows = readAllRows(dir);
    assert.equal(rows.length, 2, 'two distinct ids must create two rows');
  });
});

// ---------------------------------------------------------------------------
// C: atomic-append regression (F05)
// ---------------------------------------------------------------------------

describe('C: atomic-append concurrent-writers regression (F05)', () => {
  test('concurrent appends do not produce interleaved or corrupt lines', async () => {
    const dir = makeProjectRoot();

    // Fire 5 concurrent reserves — each should produce a clean parseable line.
    const promises = Array.from({ length: 5 }, (_, i) =>
      handle(baseInput({ task_id: 'task-' + i }), makeContext(dir))
    );
    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.isError, false, 'each concurrent reserve must succeed');
    }

    // All 5 rows must be present and parseable.
    const rows = readAllRows(dir);
    assert.equal(rows.length, 5, '5 concurrent reserves must produce 5 valid rows');
    for (const row of rows) {
      assert.ok(row.reservation_id, 'each row must have a reservation_id');
      assert.ok(typeof row.projected_cost_usd === 'number', 'each row must have a numeric projected_cost_usd');
    }
  });
});

// ---------------------------------------------------------------------------
// D: effort multiplier reflected in cost
// ---------------------------------------------------------------------------

describe('D: effort multiplier reflected in projected cost', () => {
  test('effort=high produces a higher projected cost than no effort', async () => {
    const dir = makeProjectRoot();

    const rBase = await handle(baseInput({ model: 'sonnet' }), makeContext(dir));
    const rHigh = await handle(baseInput({ model: 'sonnet', effort: 'high' }), makeContext(dir));

    assert.equal(rBase.isError, false);
    assert.equal(rHigh.isError, false);

    const baseCost = rBase.structuredContent.projected_cost_usd;
    const highCost = rHigh.structuredContent.projected_cost_usd;

    assert.ok(highCost > baseCost,
      'effort=high must produce higher cost than no effort; base=' + baseCost + ', high=' + highCost);
  });

  test('effort=low produces a lower projected cost than no effort', async () => {
    const dir = makeProjectRoot();

    const rBase = await handle(baseInput({ model: 'sonnet' }), makeContext(dir));
    const rLow = await handle(baseInput({ model: 'sonnet', effort: 'low' }), makeContext(dir));

    assert.equal(rBase.isError, false);
    assert.equal(rLow.isError, false);

    const baseCost = rBase.structuredContent.projected_cost_usd;
    const lowCost = rLow.structuredContent.projected_cost_usd;

    assert.ok(lowCost < baseCost,
      'effort=low must produce lower cost than no effort; base=' + baseCost + ', low=' + lowCost);
  });
});

// ---------------------------------------------------------------------------
// E: reservation appears in cost_budget_check accumulator (F01 critical test)
// ---------------------------------------------------------------------------

describe('E: reservation appears in cost_budget_check accumulated_cost_usd (F01)', () => {
  test('after reserving, cost_budget_check includes the reservation in accumulated_cost_usd', async () => {
    const dir = makeProjectRoot();
    const orchId = 'orch-f01-test-001';

    // Reserve a spawn cost.
    const resResult = await handle(
      baseInput({ orchestration_id: orchId, model: 'opus' }),
      makeContext(dir)
    );
    assert.equal(resResult.isError, false, 'reserve must succeed');
    const reservedCost = resResult.structuredContent.projected_cost_usd;
    assert.ok(reservedCost > 0, 'reservation must have a positive cost');

    // Now call cost_budget_check for the same orchestration — it must include the reservation.
    const checkResult2 = await checkHandle(
      { model: 'sonnet', orchestration_id: orchId },
      { projectRoot: dir, config: {} }
    );
    assert.equal(checkResult2.isError, false, 'cost_budget_check must succeed');
    const accumulated = checkResult2.structuredContent.accumulated_cost_usd;

    assert.ok(accumulated >= reservedCost,
      'accumulated_cost_usd (' + accumulated + ') must include the reservation cost (' + reservedCost + ')'
    );
  });

  test('expired reservation is NOT counted in accumulated_cost_usd', async () => {
    const dir = makeProjectRoot();
    const orchId = 'orch-f01-test-002';

    // Write an already-expired reservation directly into the ledger.
    const expiredRecord = {
      reservation_id: 'res-expired-001',
      orchestration_id: orchId,
      task_id: 'task-expired',
      agent_type: 'developer',
      model: 'opus',
      model_tier: 'opus',
      effort: null,
      effort_multiplier: 1.0,
      projected_cost_usd: 9999.00, // large value — should be ignored when expired
      input_tokens_used: 100000,
      output_tokens_used: 15000,
      token_estimates_from_defaults: true,
      pricing_source: 'builtin',
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
      expires_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // expired 30 min ago
    };
    fs.writeFileSync(
      reservationsPath(dir),
      JSON.stringify(expiredRecord) + '\n',
      'utf8'
    );

    const checkResult = await checkHandle(
      { model: 'sonnet', orchestration_id: orchId },
      { projectRoot: dir, config: {} }
    );
    assert.equal(checkResult.isError, false);
    const accumulated = checkResult.structuredContent.accumulated_cost_usd;

    // The $9999 expired reservation must NOT be counted.
    assert.ok(accumulated < 1,
      'expired reservation must not be counted; accumulated=' + accumulated);
  });
});

// ---------------------------------------------------------------------------
// F: input validation
// ---------------------------------------------------------------------------

describe('F: input validation', () => {
  test('missing orchestration_id returns toolError', async () => {
    const dir = makeProjectRoot();
    const result = await handle(
      { task_id: 'task-1', agent_type: 'developer', model: 'sonnet' },
      makeContext(dir)
    );
    assert.equal(result.isError, true, 'missing required field must return toolError');
  });

  test('missing model returns toolError', async () => {
    const dir = makeProjectRoot();
    const result = await handle(
      { orchestration_id: 'orch-1', task_id: 'task-1', agent_type: 'developer' },
      makeContext(dir)
    );
    assert.equal(result.isError, true, 'missing model must return toolError');
  });

  test('invalid effort value returns toolError', async () => {
    const dir = makeProjectRoot();
    const result = await handle(
      baseInput({ effort: 'ultra' }),
      makeContext(dir)
    );
    assert.equal(result.isError, true, 'invalid effort value must return toolError');
  });
});

// ---------------------------------------------------------------------------
// G: custom agent_type accepted
// ---------------------------------------------------------------------------

describe('G: custom agent_type (non-enum role) accepted', () => {
  test('specialist role name is accepted without validation error', async () => {
    const dir = makeProjectRoot();
    const result = await handle(
      baseInput({ agent_type: 'database-specialist' }),
      makeContext(dir)
    );
    assert.equal(result.isError, false,
      'custom agent_type must be accepted; got isError=true: ' +
      (result.content && result.content[0] && result.content[0].text));
    assert.equal(result.structuredContent.agent_type, 'database-specialist');
  });
});
