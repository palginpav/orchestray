#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/lib/tool-counts.js
 *
 * Per v2016-release-plan.md §W6 and fixb task V2016-FIXB.
 *
 * Coverage:
 *   T1 — basic: recordSuccess increments ledger; checkLimit reflects new count
 *   T2 — rate-limit exceeded: checkLimit returns exceeded:true when count >= max
 *   T3 — oversize ledger FAILS CLOSED when maxAllowed is set (enforcement mode)
 *   T4 — oversize ledger FAILS OPEN when maxAllowed is null (informational mode)
 *   T5 — counter only increments on recordSuccess, NOT on checkLimit
 *   T6 — rotation on oversize append: archived file created, fresh file used
 *   T7 — bumpAndCheck deprecated alias: check + record combined in one call
 *   T8 — bad params fail-open (missing orchestration_id)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  checkLimit,
  recordSuccess,
  bumpAndCheck,
  readLedger,
  countCalls,
  readMaxPerTask,
  COUNTS_FILE,
  MAX_COUNTS_READ,
} = require('../../../bin/mcp-server/lib/tool-counts.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-tool-counts-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function ledgerPath(projectRoot) {
  return path.join(projectRoot, COUNTS_FILE);
}

function makeConfig(maxPerTask) {
  // maxPerTask: object like { ask_user: 5 } or null for no limit
  if (!maxPerTask) return {};
  return { mcp_server: { max_per_task: maxPerTask } };
}

function makeParams(overrides = {}) {
  return {
    orchestration_id: 'orch-test-123',
    task_id: 'task-abc',
    tool_name: 'ask_user',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T1 — basic: recordSuccess increments ledger; checkLimit reflects it
// ---------------------------------------------------------------------------

describe('T1 — basic count increment', () => {

  test('recordSuccess writes a record; checkLimit sees the updated count', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams();
      const config = makeConfig({ ask_user: 10 });

      // Before any record: count should be 0, not exceeded.
      const before = checkLimit(params, tmp, config);
      assert.equal(before.exceeded, false);
      assert.equal(before.count, 0);

      // Record one success.
      recordSuccess(params, tmp, config);

      // After one record: count should be 1.
      const after = checkLimit(params, tmp, config);
      assert.equal(after.exceeded, false);
      assert.equal(after.count, 1);

      // Confirm the ledger file was actually written.
      assert.ok(fs.existsSync(ledgerPath(tmp)), 'ledger file should exist after recordSuccess');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('counts are isolated per (orchestration_id, task_id, tool_name) tuple', () => {
    const tmp = makeTmpProject();
    try {
      const config = makeConfig({ ask_user: 10, kb_write: 10 });

      const paramsA = makeParams({ tool_name: 'ask_user' });
      const paramsB = makeParams({ tool_name: 'kb_write' });
      const paramsC = makeParams({ orchestration_id: 'orch-other', tool_name: 'ask_user' });

      recordSuccess(paramsA, tmp, config);
      recordSuccess(paramsA, tmp, config);
      recordSuccess(paramsB, tmp, config);
      recordSuccess(paramsC, tmp, config);

      assert.equal(checkLimit(paramsA, tmp, config).count, 2);
      assert.equal(checkLimit(paramsB, tmp, config).count, 1);
      assert.equal(checkLimit(paramsC, tmp, config).count, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T2 — rate-limit exceeded: checkLimit returns exceeded:true when count >= max
// ---------------------------------------------------------------------------

describe('T2 — rate-limit exceeded', () => {

  test('checkLimit returns exceeded:true when existing count equals maxAllowed', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = makeConfig({ ask_user: 3 });

      // Write exactly 3 records.
      recordSuccess(params, tmp, config);
      recordSuccess(params, tmp, config);
      recordSuccess(params, tmp, config);

      const result = checkLimit(params, tmp, config);
      assert.equal(result.exceeded, true, 'should be exceeded at count == maxAllowed');
      assert.equal(result.count, 3);
      assert.equal(result.maxAllowed, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('checkLimit returns exceeded:true when existing count exceeds maxAllowed', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'kb_write' });
      const config = makeConfig({ kb_write: 2 });

      // Write 4 records (beyond limit).
      for (let i = 0; i < 4; i++) recordSuccess(params, tmp, config);

      const result = checkLimit(params, tmp, config);
      assert.equal(result.exceeded, true);
      assert.ok(result.count >= 2, 'count should be >= maxAllowed');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('checkLimit returns exceeded:false when count is below maxAllowed', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = makeConfig({ ask_user: 5 });

      recordSuccess(params, tmp, config);
      recordSuccess(params, tmp, config);

      const result = checkLimit(params, tmp, config);
      assert.equal(result.exceeded, false);
      assert.equal(result.count, 2);
      assert.equal(result.maxAllowed, 5);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T3 — oversize ledger FAILS CLOSED in enforcement mode (maxAllowed set)
// ---------------------------------------------------------------------------

describe('T3 — oversize ledger fails closed when maxAllowed is set', () => {

  test('checkLimit returns exceeded:true with reason ledger-oversize when file > 1MB and limit is set', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = makeConfig({ ask_user: 100 });

      // Write a ledger file that exceeds MAX_COUNTS_READ (1 MB).
      const lp = ledgerPath(tmp);
      // Pad to just over 1 MB with valid JSONL so the stat check triggers.
      const padding = Buffer.alloc(MAX_COUNTS_READ + 1024, 0x20); // spaces
      fs.writeFileSync(lp, padding);

      const result = checkLimit(params, tmp, config);
      assert.equal(result.exceeded, true, 'oversize ledger must fail closed in enforcement mode');
      assert.equal(result.reason, 'ledger-oversize');
      assert.equal(result.count, 'unknown');
      assert.equal(result.maxAllowed, 100);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T4 — oversize ledger FAILS OPEN in informational mode (maxAllowed null)
// ---------------------------------------------------------------------------

describe('T4 — oversize ledger fails open when maxAllowed is null', () => {

  test('readLedger returns [] (not oversize sentinel) when maxAllowed is null/undefined', () => {
    const tmp = makeTmpProject();
    try {
      const lp = ledgerPath(tmp);
      const padding = Buffer.alloc(MAX_COUNTS_READ + 1024, 0x20);
      fs.writeFileSync(lp, padding);

      // readLedger(path, null) -> informational mode, fail open -> returns []
      const records = readLedger(lp, null);
      assert.ok(Array.isArray(records), 'should return array (not oversize sentinel) when maxAllowed is null');
      assert.equal(records.length, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('checkLimit returns exceeded:false when no config limit is set (unlimited)', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = {}; // no max_per_task -> null limit

      // Even writing a big ledger won't cause exceeded when there's no limit.
      const lp = ledgerPath(tmp);
      const padding = Buffer.alloc(MAX_COUNTS_READ + 1024, 0x20);
      fs.writeFileSync(lp, padding);

      const result = checkLimit(params, tmp, config);
      assert.equal(result.exceeded, false, 'unlimited config should never fail closed');
      assert.equal(result.maxAllowed, null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T5 — counter only increments on recordSuccess, NOT on checkLimit
// ---------------------------------------------------------------------------

describe('T5 — checkLimit is read-only; counter only increments via recordSuccess', () => {

  test('calling checkLimit multiple times does not increment the ledger', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = makeConfig({ ask_user: 10 });

      // Call checkLimit 5 times without any recordSuccess.
      for (let i = 0; i < 5; i++) {
        checkLimit(params, tmp, config);
      }

      // Ledger should either not exist or have 0 matching records.
      const lp = ledgerPath(tmp);
      if (fs.existsSync(lp)) {
        const raw = fs.readFileSync(lp, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        // countCalls via parsing
        let n = 0;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (
              obj.orchestration_id === params.orchestration_id &&
              obj.task_id === params.task_id &&
              obj.tool_name === params.tool_name
            ) n++;
          } catch (_) {}
        }
        assert.equal(n, 0, 'checkLimit must not write any records to the ledger');
      }

      // Now record one success and verify count becomes exactly 1.
      recordSuccess(params, tmp, config);
      const result = checkLimit(params, tmp, config);
      assert.equal(result.count, 1, 'count should be 1 after exactly one recordSuccess');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T6 — rotation on oversize append
// ---------------------------------------------------------------------------

describe('T6 — ledger rotation on oversize append', () => {

  test('appendRecord via recordSuccess rotates oversize ledger and creates archived file', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = makeConfig({ ask_user: 999 });
      const lp = ledgerPath(tmp);

      // Pre-populate ledger beyond MAX_COUNTS_READ so the next append triggers rotation.
      const padding = Buffer.alloc(MAX_COUNTS_READ + 1024, 0x20);
      fs.writeFileSync(lp, padding);

      // Trigger append via recordSuccess (which uses appendRecord internally).
      recordSuccess(params, tmp, config);

      // The original oversize file should have been moved to an archived name.
      const stateDir = path.dirname(lp);
      const entries = fs.readdirSync(stateDir);
      const archived = entries.filter((e) => e.includes('archived-'));
      assert.ok(archived.length >= 1, 'at least one archived ledger file should exist after rotation');

      // The fresh ledger file should exist and be small (just the new record).
      assert.ok(fs.existsSync(lp), 'fresh ledger file should exist after rotation');
      const freshStat = fs.statSync(lp);
      assert.ok(
        freshStat.size < MAX_COUNTS_READ,
        'fresh ledger should be smaller than MAX_COUNTS_READ after rotation'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T7 — bumpAndCheck deprecated alias
// ---------------------------------------------------------------------------

describe('T7 — bumpAndCheck deprecated alias', () => {

  test('bumpAndCheck checks and records in one call, returns exceeded:false when under limit', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = makeConfig({ ask_user: 5 });

      const result = bumpAndCheck(params, tmp, config);
      assert.equal(result.exceeded, false);

      // The call should have been recorded.
      const count = checkLimit(params, tmp, config).count;
      assert.equal(count, 1, 'bumpAndCheck should record the call');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('bumpAndCheck returns exceeded:true when at limit, does NOT record the excess call', () => {
    const tmp = makeTmpProject();
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      const config = makeConfig({ ask_user: 2 });

      // Fill up the limit.
      recordSuccess(params, tmp, config);
      recordSuccess(params, tmp, config);

      const result = bumpAndCheck(params, tmp, config);
      assert.equal(result.exceeded, true);
      assert.ok(result.max === 2 || result.maxAllowed === 2 || result.count === 'unknown' || result.count >= 2);

      // Count should still be 2, not 3 (excess call was blocked, not recorded).
      const count = checkLimit(params, tmp, config).count;
      assert.equal(count, 2, 'bumpAndCheck must not record when already exceeded');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T8 — bad params fail-open
// ---------------------------------------------------------------------------

describe('T8 — bad params fail-open', () => {

  test('checkLimit with missing orchestration_id returns exceeded:false', () => {
    const tmp = makeTmpProject();
    try {
      const params = { orchestration_id: '', task_id: 'task-1', tool_name: 'ask_user' };
      const config = makeConfig({ ask_user: 1 });
      const result = checkLimit(params, tmp, config);
      assert.equal(result.exceeded, false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('recordSuccess with missing tool_name is a no-op (no throw)', () => {
    const tmp = makeTmpProject();
    try {
      const params = { orchestration_id: 'orch-1', task_id: 'task-1', tool_name: '' };
      const config = makeConfig({ ask_user: 5 });
      assert.doesNotThrow(() => recordSuccess(params, tmp, config));
      // Ledger should not be created.
      const lp = ledgerPath(tmp);
      assert.equal(fs.existsSync(lp), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// T9 — validated-value round-trip via loadMcpServerConfig (Bundle C, v2.1.7)
// ---------------------------------------------------------------------------

const { loadMcpServerConfig } = require('../../../bin/_lib/config-schema.js');

describe('T9 — readMaxPerTask uses validated shape from loadMcpServerConfig', () => {

  function makeTmpProjectWithConfig(configObj) {
    const dir = makeTmpProject();
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(configObj),
      'utf8'
    );
    return dir;
  }

  test('readMaxPerTask with cwd returns validated value (25) for ask_user', () => {
    const tmp = makeTmpProjectWithConfig({
      mcp_server: { max_per_task: { ask_user: 25 } },
    });
    try {
      const v = readMaxPerTask(null, 'ask_user', tmp);
      assert.equal(v, 25, 'should return validated value 25');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readMaxPerTask with cwd returns null for tool with no configured limit', () => {
    const tmp = makeTmpProjectWithConfig({
      mcp_server: { max_per_task: { ask_user: 10 } },
    });
    try {
      // kb_write has a default (20) but the validator returns it; check unlimited
      // case by using a tool not in defaults and not in config.
      const v = readMaxPerTask(null, 'nonexistent_tool', tmp);
      assert.equal(v, null, 'tool absent from validated shape returns null (unlimited)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('readMaxPerTask without cwd falls back to raw config direct-read', () => {
    const tmp = makeTmpProject();
    try {
      const config = makeConfig({ ask_user: 7 });
      const v = readMaxPerTask(config, 'ask_user');
      assert.equal(v, 7, 'direct-read fallback should return 7');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('checkLimit enforces validated value; budget exceeded at validated limit', () => {
    const tmp = makeTmpProjectWithConfig({
      mcp_server: { max_per_task: { ask_user: 2 } },
    });
    try {
      const params = makeParams({ tool_name: 'ask_user' });
      // Use raw config matching the validated shape so checkLimit applies the limit.
      const config = makeConfig({ ask_user: 2 });

      recordSuccess(params, tmp, config);
      recordSuccess(params, tmp, config);

      const result = checkLimit(params, tmp, config);
      assert.equal(result.exceeded, true, 'should be exceeded at validated limit of 2');
      assert.equal(result.maxAllowed, 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
