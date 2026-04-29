#!/usr/bin/env node
'use strict';

/**
 * v2211 W0d — dossier inject orchestration_id attribution fix + peekOrchestrationId helper.
 *
 * Test matrix:
 *   1. Helper unit: no current-orchestration.json → returns null.
 *   2. Helper unit: malformed JSON → returns null (no throw).
 *   3. Helper unit: valid JSON → returns orchestration_id field value.
 *   4. mark-compact-signal.js regression: handleSessionStart still works after
 *      _peekOrchestrationId was replaced by the shared helper.
 *   5. inject-resilience-dossier integration: dossier with orchestration_id null +
 *      active current-orchestration.json → dossier_injected carries the peeked id.
 *   6. Attribution match: audit-dossier-orphan does NOT flag as orphan after the fix.
 *   7. Primary path preserved: dossier with non-null orchestration_id → emitted
 *      orchestration_id matches dossier (NOT the peek result).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const PEEK_HELPER = path.resolve(__dirname, '..', '_lib', 'peek-orchestration-id.js');
const MARK_COMPACT = path.resolve(__dirname, '..', 'mark-compact-signal.js');
const INJECT_DOSSIER = path.resolve(__dirname, '..', 'inject-resilience-dossier.js');
const ORPHAN_AUDIT = path.resolve(__dirname, '..', 'audit-dossier-orphan.js');

const { peekOrchestrationId } = require(PEEK_HELPER);
const { handleSessionStart: markCompactHandleSessionStart, LOCK_BASENAME } = require(MARK_COMPACT);
const { handleSessionStart: injectHandleSessionStart } = require(INJECT_DOSSIER);
const { runAudit, tallyDossierEvents, isOrphan } = require(ORPHAN_AUDIT);

const {
  buildDossier,
  serializeDossier,
} = require('../_lib/resilience-dossier-schema');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCurrentOrchFile(cwd, orchId) {
  const auditDir = path.join(cwd, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }) + '\n',
  );
}

function buildDossierRaw(orchId) {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: {
      id: orchId,
      phase: 'executing',
      status: 'in_progress',
      complexity_score: 5,
    },
    task_ids: { pending: ['W1'], completed: [], failed: [] },
  }));
  return serialized;
}

function makeInjectProjectDir({ dossierRaw, withCurrentOrch = null } = {}) {
  const tmp = makeTmpDir('w0d-inject-');
  const stateDir = path.join(tmp, '.orchestray', 'state');
  const auditDir = path.join(tmp, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  if (dossierRaw !== undefined) {
    fs.writeFileSync(path.join(stateDir, 'resilience-dossier.json'), dossierRaw);
  }

  if (withCurrentOrch) {
    writeCurrentOrchFile(tmp, withCurrentOrch);
  }

  return tmp;
}

function readAuditEvents(cwd) {
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const out = [];
  for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_e) {}
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Helper unit: no current-orchestration.json → returns null
// ---------------------------------------------------------------------------

describe('peekOrchestrationId helper', () => {
  test('returns null when current-orchestration.json is absent', () => {
    const tmp = makeTmpDir('w0d-peek-');
    const result = peekOrchestrationId(tmp);
    assert.strictEqual(result, null);
  });

  // 2. Helper unit: malformed JSON → returns null (does not throw)
  test('returns null on malformed JSON without throwing', () => {
    const tmp = makeTmpDir('w0d-peek-malformed-');
    const auditDir = path.join(tmp, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, 'current-orchestration.json'), '{ NOT VALID JSON !!');
    const result = peekOrchestrationId(tmp);
    assert.strictEqual(result, null);
  });

  // 3. Helper unit: valid JSON → returns orchestration_id field
  test('returns orchestration_id from valid JSON', () => {
    const tmp = makeTmpDir('w0d-peek-valid-');
    writeCurrentOrchFile(tmp, 'orch-test-w0d');
    const result = peekOrchestrationId(tmp);
    assert.strictEqual(result, 'orch-test-w0d');
  });

  test('returns null when orchestration_id field is missing from JSON', () => {
    const tmp = makeTmpDir('w0d-peek-nofield-');
    const auditDir = path.join(tmp, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ other_field: 'x' }) + '\n',
    );
    const result = peekOrchestrationId(tmp);
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// 4. mark-compact-signal.js regression: handleSessionStart works after refactor
// ---------------------------------------------------------------------------

describe('mark-compact-signal regression after helper extraction', () => {
  test('handleSessionStart drops a lock file on source=compact', () => {
    const tmp = makeTmpDir('w0d-mcs-');
    fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
    const result = markCompactHandleSessionStart({ source: 'compact', cwd: tmp });
    assert.strictEqual(result.dropped, true);
    assert.strictEqual(result.source, 'compact');
    const lockPath = path.join(tmp, '.orchestray', 'state', LOCK_BASENAME);
    assert.ok(fs.existsSync(lockPath), 'compact-signal.lock must exist');
  });

  test('handleSessionStart is a no-op on source=clear (K2 rule)', () => {
    const tmp = makeTmpDir('w0d-mcs-clear-');
    const result = markCompactHandleSessionStart({ source: 'clear', cwd: tmp });
    assert.strictEqual(result.dropped, false);
    assert.match(result.reason, /source_not_eligible/);
  });

  test('handleSessionStart respects ORCHESTRAY_RESILIENCE_DISABLED=1', () => {
    const tmp = makeTmpDir('w0d-mcs-disabled-');
    const prev = process.env.ORCHESTRAY_RESILIENCE_DISABLED;
    try {
      process.env.ORCHESTRAY_RESILIENCE_DISABLED = '1';
      const result = markCompactHandleSessionStart({ source: 'compact', cwd: tmp });
      assert.strictEqual(result.dropped, false);
      assert.match(result.reason, /env_kill_switch/);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_RESILIENCE_DISABLED;
      else process.env.ORCHESTRAY_RESILIENCE_DISABLED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// 5. inject-resilience-dossier integration: null-dossier orchId → peek fallback
// ---------------------------------------------------------------------------

describe('inject-resilience-dossier attribution fix', () => {
  test('dossier_injected carries peeked orchestration_id when dossier.orchestration_id is null', () => {
    // Build a dossier with no orchestration_id (id: null → orchestration_id: null in schema)
    const { serialized } = serializeDossier(buildDossier({
      orchestration: {
        id: null,
        phase: null,
        status: 'in_progress',
        complexity_score: 0,
      },
      task_ids: { pending: [], completed: [], failed: [] },
    }));

    const tmp = makeInjectProjectDir({
      dossierRaw: serialized,
      withCurrentOrch: 'orch-test-w0d',
    });

    const result = injectHandleSessionStart({ source: 'compact', cwd: tmp });
    // Should have injected (not skipped — dossier has status in_progress)
    assert.ok(result.action === 'injected' || result.action === 'shadow_dry_run',
      `Expected action=injected or shadow_dry_run, got: ${result.action}`);

    const events = readAuditEvents(tmp);
    const injected = events.find((e) => e.type === 'dossier_injected');
    assert.ok(injected, 'dossier_injected event must be emitted');
    assert.strictEqual(injected.orchestration_id, 'orch-test-w0d',
      'dossier_injected.orchestration_id must carry the peeked value');
  });

  // 7. Primary path preserved: dossier with non-null orchestration_id → use dossier's value
  test('dossier_injected preserves dossier.orchestration_id when non-null (no peek fallback)', () => {
    const tmp = makeInjectProjectDir({
      dossierRaw: buildDossierRaw('orch-real'),
      withCurrentOrch: 'orch-different-peek',
    });

    const result = injectHandleSessionStart({ source: 'compact', cwd: tmp });
    assert.ok(result.action === 'injected' || result.action === 'shadow_dry_run',
      `Expected action=injected or shadow_dry_run, got: ${result.action}`);

    const events = readAuditEvents(tmp);
    const injected = events.find((e) => e.type === 'dossier_injected');
    assert.ok(injected, 'dossier_injected event must be emitted');
    assert.strictEqual(injected.orchestration_id, 'orch-real',
      'primary orchestration_id from dossier must take precedence over peek result');
  });

  // Kill switch regression: ORCHESTRAY_RESILIENCE_DISABLED=1 suppresses inject entirely
  test('ORCHESTRAY_RESILIENCE_DISABLED=1 disables inject path', () => {
    const tmp = makeInjectProjectDir({
      dossierRaw: buildDossierRaw('orch-killswitch'),
      withCurrentOrch: 'orch-killswitch',
    });
    const prev = process.env.ORCHESTRAY_RESILIENCE_DISABLED;
    try {
      process.env.ORCHESTRAY_RESILIENCE_DISABLED = '1';
      const result = injectHandleSessionStart({ source: 'compact', cwd: tmp });
      assert.ok(
        result.action === 'skipped_kill_switch',
        `Expected action=skipped_kill_switch, got: ${result.action}`
      );
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_RESILIENCE_DISABLED;
      else process.env.ORCHESTRAY_RESILIENCE_DISABLED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Attribution match: orphan detector does NOT flag when inject carries orchId
// ---------------------------------------------------------------------------

describe('audit-dossier-orphan does not flag with attribution fix', () => {
  test('paired dossier_written + dossier_injected (with peeked id) is NOT an orphan', () => {
    const orchId = 'orch-test-w0d';
    const tmp = makeTmpDir('w0d-orphan-');
    const auditDir = path.join(tmp, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    // Write synthetic events.jsonl with matching orchestration_id on both events
    const events = [
      { type: 'dossier_written', orchestration_id: orchId, ts: new Date().toISOString() },
      { type: 'dossier_injected', orchestration_id: orchId, ts: new Date().toISOString() },
    ];
    fs.writeFileSync(
      path.join(auditDir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    const { orphans } = runAudit({ cwd: tmp, orchestrationIds: [orchId] });
    assert.strictEqual(orphans.length, 0,
      'Paired dossier_written/dossier_injected must NOT produce orphan detection');
  });

  test('tallyDossierEvents + isOrphan reflects the pairing correctly', () => {
    const orchId = 'orch-test-w0d';
    const events = [
      { type: 'dossier_written', orchestration_id: orchId },
      { type: 'dossier_injected', orchestration_id: orchId },
    ];
    const tally = tallyDossierEvents(events);
    assert.strictEqual(tally.write_count, 1);
    assert.strictEqual(tally.inject_count, 1);
    assert.strictEqual(isOrphan(tally), false, 'Paired events must not be an orphan');
  });

  test('dossier_written with no matching dossier_injected IS an orphan (baseline)', () => {
    const orchId = 'orch-test-orphan';
    const events = [
      { type: 'dossier_written', orchestration_id: orchId },
    ];
    const tally = tallyDossierEvents(events);
    assert.strictEqual(isOrphan(tally), true, 'Unmatched dossier_written must be an orphan');
  });
});
