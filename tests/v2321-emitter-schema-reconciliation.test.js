#!/usr/bin/env node
'use strict';

/**
 * v2321-emitter-schema-reconciliation.test.js — emitter/schema shape parity.
 *
 * `schema_shape_violation` fired 339 times across 9 event types before this
 * suite existed: every one is an emit site whose payload does not carry the
 * fields its `event-schemas.md` section declares required. The validator wrote
 * the advisory into the audit log and no surface read it, so the drift was
 * invisible.
 *
 * Method: derive the emitted key set from the emit site IN THE SOURCE (so the
 * test tracks the emitter, not a copy of it), push it through the real
 * `writeEvent` gateway inside a tmp project root that carries a copy of the
 * real `event-schemas.md`, and assert the gateway emitted no
 * `schema_shape_violation` advisory for that type.
 *
 * Coverage (one case per violating type):
 *   1. mcp_grounding_prefetched  — bin/prefetch-mcp-grounding.js
 *   2. orchestration_roi         — bin/audit-on-orch-complete.js
 *   3. spawn_requested           — bin/mcp-server/tools/spawn_agent.js
 *   4. auto_extract_skipped      — bin/post-orchestration-extract.js (all sites)
 *   5. no_deferral_block         — bin/validate-no-deferral.js
 *   6. dossier_injected          — bin/inject-resilience-dossier.js (both sites)
 *   7. orchestration_start       — bin/ox.js `events append` (PM hand-append path)
 *   8. orchestration_complete    — bin/ox.js `events append` (PM hand-append path)
 *   9. curator_run_complete      — bin/mcp-server/tools/curator_tombstone.js close_run
 *                                  (v2.3.23; schema example self-validation)
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const REPO_ROOT   = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const GATEWAY     = path.resolve(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');
const OX          = path.resolve(REPO_ROOT, 'bin', 'ox.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-emit-parity-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function readEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Extract the top-level key names of the object literal an emit site passes,
 * identified by its `type: '<eventType>'` line. `occurrence` selects the Nth
 * emit site of that type in the file (1-based).
 */
function emitSiteKeys(absFile, eventType, occurrence) {
  const src = fs.readFileSync(absFile, 'utf8');
  const re  = new RegExp("type:\\s*'" + eventType + "'", 'g');
  let m, hit = 0, idx = -1;
  while ((m = re.exec(src)) !== null) {
    hit += 1;
    if (hit === (occurrence || 1)) { idx = m.index; break; }
  }
  assert.ok(idx >= 0, `emit site #${occurrence || 1} for "${eventType}" not found in ${absFile}`);

  const open = src.lastIndexOf('{', idx);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, `unbalanced object literal at emit site for "${eventType}"`);

  const keys = [];
  let d = 0;
  for (const line of src.slice(open + 1, end).split('\n')) {
    const stripped = line.replace(/\/\/.*$/, '');
    if (d === 0) {
      // `key: value` plus ES6 shorthand (`truncated,`).
      const km = stripped.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/)
        || stripped.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*$/);
      if (km) keys.push(km[1]);
    }
    d += (stripped.match(/[{[(]/g) || []).length - (stripped.match(/[}\])]/g) || []).length;
  }
  return keys;
}

/** Count of emit sites of `eventType` in `absFile`. */
function emitSiteCount(absFile, eventType) {
  const src = fs.readFileSync(absFile, 'utf8');
  const m = src.match(new RegExp("type:\\s*'" + eventType + "'", 'g'));
  return m ? m.length : 0;
}

/**
 * Emit one event through the real gateway in a fresh process (the gateway
 * rate-limits shape advisories to one per type per process, so every case
 * needs its own).  Returns the rows written to the tmp root's events.jsonl.
 */
function emitThroughGateway(tmpDir, payload) {
  const harness = `
    const { writeEvent } = require(${JSON.stringify(GATEWAY)});
    writeEvent(${JSON.stringify(payload)}, { cwd: ${JSON.stringify(tmpDir)} });
  `;
  const r = spawnSync(process.execPath, ['-e', harness], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: tmpDir,
    env: Object.assign({}, process.env, { ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED: '1' }),
  });
  assert.equal(r.status, 0, `gateway harness failed: ${r.stderr}`);
  return readEvents(tmpDir);
}

/** Placeholder payload built from a source-derived key set. */
function payloadFromKeys(eventType, keys) {
  const payload = { type: eventType };
  for (const k of keys) {
    if (k === 'type') continue;
    payload[k] = k.endsWith('_n') || k.endsWith('_count') || k.endsWith('_bytes') ? 1 : 'x';
  }
  return payload;
}

/** Assert no schema_shape_violation advisory was raised for `eventType`. */
function assertNoShapeViolation(rows, eventType) {
  const v = rows.filter((e) => e.type === 'schema_shape_violation' && e.event_type === eventType);
  const errs = v.flatMap((e) => (Array.isArray(e.validation_errors) ? e.validation_errors : []));
  assert.equal(
    v.length, 0,
    `${eventType} emit violates its schema:\n  ${errs.join('\n  ')}`,
  );
}

/** Emit the source-derived shape of one emit site and assert schema parity. */
function assertEmitSiteMatchesSchema(relFile, eventType, occurrence) {
  const tmpDir = makeTmpRepo();
  try {
    const keys = emitSiteKeys(path.resolve(REPO_ROOT, relFile), eventType, occurrence);
    const rows = emitThroughGateway(tmpDir, payloadFromKeys(eventType, keys));
    assertNoShapeViolation(rows, eventType);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Run `ox` in a tmp root with an initialised orchestration marker. */
function runOx(tmpDir, args) {
  return spawnSync(process.execPath, [OX].concat(args), {
    encoding: 'utf8',
    timeout: 15000,
    cwd: tmpDir,
    env: Object.assign({}, process.env, {
      ORCHESTRAY_PROJECT_ROOT: tmpDir,
      ORCHESTRAY_AUTOFILL_SAMPLE_DISABLED: '1',
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2.3.21 — emitter/schema shape reconciliation', () => {

  test('1. mcp_grounding_prefetched — per-spawn summary emit matches its schema', () => {
    assertEmitSiteMatchesSchema('bin/prefetch-mcp-grounding.js', 'mcp_grounding_prefetched', 1);
  });

  test('2. orchestration_roi — code emitter matches its schema', () => {
    assertEmitSiteMatchesSchema('bin/audit-on-orch-complete.js', 'orchestration_roi', 1);
  });

  test('2b. orchestration_roi — agent_count is computed, not a placeholder', () => {
    const src = fs.readFileSync(path.resolve(REPO_ROOT, 'bin/audit-on-orch-complete.js'), 'utf8');
    assert.match(
      src, /agent_count/,
      'orchestration_roi must carry a computed agent_count, not omit it',
    );
    assert.match(
      src, /agent_stop/,
      'agent_count must come from the agent_stop rows the ROI scan already walks',
    );
  });

  test('3. spawn_requested — MCP tool emit matches its schema', () => {
    assertEmitSiteMatchesSchema('bin/mcp-server/tools/spawn_agent.js', 'spawn_requested', 1);
  });

  test('4. auto_extract_skipped — every skip-reason emit site matches its schema', () => {
    const rel = 'bin/post-orchestration-extract.js';
    const n = emitSiteCount(path.resolve(REPO_ROOT, rel), 'auto_extract_skipped');
    assert.ok(n >= 6, `expected the skip-reason fanout (>=6 emit sites), found ${n}`);
    for (let i = 1; i <= n; i += 1) {
      assertEmitSiteMatchesSchema(rel, 'auto_extract_skipped', i);
    }
  });

  test('5. no_deferral_block — emitted field names match the declared ones', () => {
    assertEmitSiteMatchesSchema('bin/validate-no-deferral.js', 'no_deferral_block', 1);
    const keys = emitSiteKeys(
      path.resolve(REPO_ROOT, 'bin/validate-no-deferral.js'), 'no_deferral_block', 1,
    );
    assert.ok(keys.includes('matched_phrase'), 'emitter must use the declared name matched_phrase');
    assert.ok(keys.includes('context_snippet'), 'emitter must use the declared name context_snippet');
  });

  test('6. dossier_injected — both the UserPromptSubmit and SessionStart emits match', () => {
    const rel = 'bin/inject-resilience-dossier.js';
    const n = emitSiteCount(path.resolve(REPO_ROOT, rel), 'dossier_injected');
    assert.equal(n, 2, `expected 2 dossier_injected emit sites, found ${n}`);
    assertEmitSiteMatchesSchema(rel, 'dossier_injected', 1);
    assertEmitSiteMatchesSchema(rel, 'dossier_injected', 2);
  });

  test('7. orchestration_start — `ox events append` completes the required fields', () => {
    const tmpDir = makeTmpRepo();
    try {
      const init = runOx(tmpDir, ['state', 'init', 'orch-20260101T000000Z-parity']);
      assert.equal(init.status, 0, `ox state init failed: ${init.stderr}`);
      const r = runOx(tmpDir, ['events', 'append', '--event-type=orchestration_start']);
      assert.equal(r.status, 0, `ox events append failed: ${r.stderr}`);

      const rows = readEvents(tmpDir);
      assertNoShapeViolation(rows, 'orchestration_start');
      const appended = rows.filter((e) => e.type === 'orchestration_start');
      assert.ok(appended.length >= 1, 'orchestration_start row written');
      assert.ok('task' in appended[appended.length - 1], 'task key present (nullable per schema)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('8. orchestration_complete — `ox events append` completes the required fields', () => {
    const tmpDir = makeTmpRepo();
    try {
      const init = runOx(tmpDir, ['state', 'init', 'orch-20260101T000000Z-parity']);
      assert.equal(init.status, 0, `ox state init failed: ${init.stderr}`);
      const r = runOx(tmpDir, ['events', 'append', '--event-type=orchestration_complete']);
      assert.equal(r.status, 0, `ox events append failed: ${r.stderr}`);

      const rows = readEvents(tmpDir);
      assertNoShapeViolation(rows, 'orchestration_complete');
      const appended = rows.filter((e) => e.type === 'orchestration_complete');
      assert.ok(appended.length >= 1, 'orchestration_complete row written');
      assert.equal(appended[appended.length - 1].status, 'success', 'status defaults to success');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('8b. `ox events append` still flags data the PM has and the code emitter does not', () => {
    const tmpDir = makeTmpRepo();
    try {
      runOx(tmpDir, ['state', 'init', 'orch-20260101T000000Z-parity']);
      // orchestration_roi's cost/git fields are nullable so the event-log-derived
      // code emitter can be honest; a PM hand-append must still carry them.
      const bare = runOx(tmpDir, ['events', 'append', '--event-type=orchestration_roi']);
      assert.equal(bare.status, 0, 'audit appends stay fail-open');
      assert.match(bare.stderr, /total_cost_usd/, 'warns about unmeasured cost');
      assert.match(bare.stderr, /files_changed_count/, 'warns about unmeasured file count');

    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const clean = makeTmpRepo();
    try {
      runOx(clean, ['state', 'init', 'orch-20260101T000000Z-parity']);
      const full = runOx(clean, ['events', 'append', '--event-type=orchestration_roi',
        '--extra={"agent_count":3,"total_cost_usd":1.5,"files_changed_count":9,"efficiency_ratio":6}']);
      assert.equal(full.stderr.trim(), '', `complete emit must be silent, got: ${full.stderr}`);
      assertNoShapeViolation(readEvents(clean), 'orchestration_roi');
    } finally {
      fs.rmSync(clean, { recursive: true, force: true });
    }
  });

  test('9. curator_run_complete — the schema example validates against its own schema', () => {
    const tmpDir = makeTmpRepo();
    try {
      // v2.3.23: emitted by curator_tombstone.js's close_run action (called
      // from curate-runner's deterministic protocol) — the curator agent
      // itself never had a viable write path, see
      // .orchestray/kb/decisions/curator-run-complete-emission-gap.md. The
      // documented example is still the contract under test.
      const rows = emitThroughGateway(tmpDir, {
        type: 'curator_run_complete',
        run_id: 'curator-run-2026-01-01T00:00:00Z',
        orchestration_id: null,
        actions_applied: { promote_n: 2, merge_n: 1, deprecate_n: 3 },
        actions_skipped: { promote_n: 0, merge_n: 1, deprecate_n: 0 },
        tombstones_written_count: 3,
        dry_run: false,
        reconciliation: { repaired: 0, flagged: 0 },
        stamps: { applied: 3, skipped: 0, failed: 0 },
      });
      assertNoShapeViolation(rows, 'curator_run_complete');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
