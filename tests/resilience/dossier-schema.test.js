#!/usr/bin/env node
'use strict';

/**
 * Unit tests — resilience dossier schema (build / serialize / parse).
 *
 * Covers W3 §B1/B2/B3 schema invariants and the 12 KB truncation ladder.
 * Also includes the K1 defaults assertion required by Bundle D.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const schema = require('../../bin/_lib/resilience-dossier-schema');
const {
  DOSSIER_SCHEMA_VERSION,
  MAX_BYTES,
  CRITICAL_FIELDS,
  buildDossier,
  serializeDossier,
  parseDossier,
  atomicWriteDossier,
} = schema;

function mkSources(over) {
  return Object.assign({
    orchestration: {
      id: 'orch-TEST-123',
      phase: 'implementation',
      status: 'in_progress',
      complexity_score: 9,
      delegation_pattern: 'parallel',
      current_group_id: 'group-2',
      replan_count: 0,
      compact_trigger: 'auto',
    },
    task_ids: {
      pending: ['W4', 'W5', 'W6'],
      completed: ['W1', 'W2', 'W3'],
      failed: [],
    },
    cost: { so_far_usd: 2.87, budget_usd: 10.00 },
    events_tail: [
      { type: 'kb_search', kb_path: '.orchestray/kb/facts/compaction.md' },
      { type: 'verify_fix_retry', task_id: 'W4' },
    ],
    mcp_checkpoints: [
      { tool: 'pattern_find', task_id: 'W4', created_at: '2026-04-19T14:36:01Z' },
      { tool: 'kb_search',    task_id: 'W3', created_at: '2026-04-19T14:30:00Z', consumed_at: '2026-04-19T14:30:10Z' },
    ],
    routing_tail: [{ subtask_id: 'W4' }, { subtask_id: 'W5' }],
    last_compact_detected_at: null,
    ingested_counter: 0,
    planning_inputs: null,
    drift_invariants: [],
  }, over || {});
}

describe('DOSSIER_SCHEMA_VERSION', () => {
  test('is 2 (D3: schema bumped from 1 to 2 when ingested_counter removed)', () => {
    assert.equal(DOSSIER_SCHEMA_VERSION, 2);
  });
});

describe('buildDossier — happy path', () => {
  const d = buildDossier(mkSources());

  test('sets schema_version', () => {
    assert.equal(d.schema_version, 2); // D3: bumped from 1 to 2
  });
  test('sets written_at as ISO-8601', () => {
    assert.match(d.written_at, /^\d{4}-\d{2}-\d{2}T/);
  });
  test('carries orchestration id + phase + status', () => {
    assert.equal(d.orchestration_id, 'orch-TEST-123');
    assert.equal(d.phase, 'implementation');
    assert.equal(d.status, 'in_progress');
    assert.equal(d.complexity_score, 9);
  });
  test('task id arrays land in the right bucket', () => {
    assert.deepEqual(d.pending_task_ids, ['W4', 'W5', 'W6']);
    assert.deepEqual(d.completed_task_ids, ['W1', 'W2', 'W3']);
    assert.deepEqual(d.failed_task_ids, []);
  });
  test('task_ref_uris cover every id', () => {
    assert.equal(d.task_ref_uris.length, 6);
    assert.ok(d.task_ref_uris.every((u) => u.startsWith('orchestray:orchestration://current/tasks/')));
  });
  test('outstanding MCP checkpoints exclude consumed ones', () => {
    assert.equal(d.mcp_checkpoints_outstanding.length, 1);
    assert.equal(d.mcp_checkpoints_outstanding[0].tool, 'pattern_find');
  });
  test('retry counter counts verify_fix_retry events', () => {
    assert.equal(d.retry_counter.W4, 1);
  });
  test('cost remaining computes correctly', () => {
    assert.equal(d.cost_so_far_usd, 2.87);
    assert.equal(d.cost_budget_remaining_usd, 7.13);
  });
  test('kb paths scraped from events tail', () => {
    assert.ok(d.kb_paths_cited.includes('.orchestray/kb/facts/compaction.md'));
  });
});

describe('buildDossier — edge cases', () => {
  test('empty sources still produces a valid dossier', () => {
    const d = buildDossier({});
    assert.equal(d.schema_version, 2); // D3: bumped from 1 to 2
    assert.equal(d.orchestration_id, null);
    assert.deepEqual(d.pending_task_ids, []);
    assert.deepEqual(d.completed_task_ids, []);
  });
  test('caps pending_task_ids at 20', () => {
    const pending = [];
    for (let i = 0; i < 50; i++) pending.push('T' + i);
    const d = buildDossier({
      task_ids: { pending, completed: [], failed: [] },
    });
    assert.equal(d.pending_task_ids.length, 20);
  });
  test('caps completed_task_ids at 40', () => {
    const completed = [];
    for (let i = 0; i < 100; i++) completed.push('T' + i);
    const d = buildDossier({
      task_ids: { pending: [], completed, failed: [] },
    });
    assert.equal(d.completed_task_ids.length, 40);
  });
  test('dedups task ids', () => {
    const d = buildDossier({
      task_ids: { pending: ['W1', 'W1', 'W2'], completed: [], failed: [] },
    });
    assert.deepEqual(d.pending_task_ids, ['W1', 'W2']);
  });
  test('coerces invalid phase to null', () => {
    const d = buildDossier({
      orchestration: { id: 'x', phase: 'wibble', status: 'in_progress', complexity_score: 5 },
    });
    assert.equal(d.phase, null);
  });
  test('coerces non-number cost to null', () => {
    const d = buildDossier({ cost: { so_far_usd: 'abc', budget_usd: null } });
    assert.equal(d.cost_so_far_usd, null);
    assert.equal(d.cost_budget_remaining_usd, null);
  });
});

describe('serializeDossier', () => {
  test('returns valid JSON for a normal dossier', () => {
    const d = buildDossier(mkSources());
    const { serialized, size_bytes, truncation_flags } = serializeDossier(d);
    assert.ok(size_bytes < MAX_BYTES);
    assert.deepEqual(truncation_flags, []);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.orchestration_id, 'orch-TEST-123');
  });

  test('roundtrips through parseDossier', () => {
    const d = buildDossier(mkSources());
    const { serialized } = serializeDossier(d);
    const result = parseDossier(serialized);
    assert.ok(result.ok, 'parse should succeed: ' + JSON.stringify(result));
    assert.equal(result.dossier.orchestration_id, 'orch-TEST-123');
  });

  test('drops deferred tier when oversize', () => {
    // Fabricate an oversize dossier by filling kb_paths_cited + routing_lookup_keys with long strings.
    const sources = mkSources();
    // Force big deferred tier by injecting many routing entries.
    sources.routing_tail = [];
    for (let i = 0; i < 20; i++) sources.routing_tail.push({ subtask_id: ('ROUTE_LONG_KEY_VALUE_' + i).repeat(50) });
    sources.drift_invariants = [];
    for (let i = 0; i < 5; i++) sources.drift_invariants.push(('INVARIANT_' + i).repeat(100));
    sources.planning_inputs = { release_plan_path: ('x').repeat(500), phase_slug: ('y').repeat(500) };
    // And expand events_tail to produce many kb_paths too.
    sources.events_tail = [];
    for (let i = 0; i < 10; i++) sources.events_tail.push({ type: 'x', kb_path: ('.orchestray/kb/' + 'a'.repeat(200) + '_' + i + '.md') });

    const d = buildDossier(sources);
    const { serialized, size_bytes, truncation_flags } = serializeDossier(d);
    assert.ok(size_bytes <= MAX_BYTES + 2048, 'final size should be near cap, got=' + size_bytes);
    if (size_bytes >= MAX_BYTES / 2) {
      // In practice the above easily overflows 12 KB and should trigger dropping.
      assert.ok(
        truncation_flags.includes('deferred_dropped') ||
        truncation_flags.includes('expanded_dropped'),
        'expected a drop flag, got: ' + JSON.stringify(truncation_flags)
      );
    }
  });
});

describe('parseDossier — error cases', () => {
  test('empty buffer', () => {
    const r = parseDossier('');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });
  test('null', () => {
    const r = parseDossier(null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });
  test('malformed JSON', () => {
    const r = parseDossier('{not-json');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'parse_error');
  });
  test('array instead of object', () => {
    const r = parseDossier('[1,2,3]');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_object');
  });
  test('future schema version rejected', () => {
    const r = parseDossier(JSON.stringify({ schema_version: 99 }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema_mismatch');
  });
  test('missing critical field rejected', () => {
    const base = {
      schema_version: 1,
      written_at: '2026-04-19T00:00:00Z',
      // orchestration_id missing
      phase: 'implementation',
      status: 'in_progress',
      complexity_score: 5,
      current_group_id: null,
      pending_task_ids: [],
      completed_task_ids: [],
      cost_so_far_usd: null,
      cost_budget_remaining_usd: null,
      last_compact_detected_at: null,
      ingested_counter: 0,
    };
    const r = parseDossier(JSON.stringify(base));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing_critical');
  });
});

describe('atomicWriteDossier', () => {
  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-write-'));
  }

  test('writes new file atomically', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'resilience-dossier.json');
    const result = atomicWriteDossier(p, '{"schema_version":1}');
    assert.ok(result.ok);
    assert.equal(fs.readFileSync(p, 'utf8'), '{"schema_version":1}');
  });

  test('overwrites existing file atomically', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'resilience-dossier.json');
    fs.writeFileSync(p, 'old');
    atomicWriteDossier(p, 'new');
    assert.equal(fs.readFileSync(p, 'utf8'), 'new');
  });

  test('refuses to overwrite a directory at the target path', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'resilience-dossier.json');
    fs.mkdirSync(p); // directory in place of the file
    const result = atomicWriteDossier(p, 'payload');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'path_collision');
  });

  test('does not leave tmp files on error', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'resilience-dossier.json');
    fs.mkdirSync(p); // collision
    atomicWriteDossier(p, 'payload');
    const leftover = fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftover, []);
  });

  test('rejects non-string payload', () => {
    const dir = tmpDir();
    const p = path.join(dir, 'resilience-dossier.json');
    const result = atomicWriteDossier(p, /** @type {any} */({}));
    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// D3: schema version bump — parseDossier compat tests
// ---------------------------------------------------------------------------

const { DOSSIER_COMPAT_VERSIONS, _sanitiseDossierPathField, _sanitiseDossierPathArray } = require('../../bin/_lib/resilience-dossier-schema');

describe('D3 — schema_version bump to 2', () => {
  test('new dossiers have schema_version=2', () => {
    const d = buildDossier(mkSources());
    assert.equal(d.schema_version, 2);
  });

  test('parseDossier accepts schema_version=1 with compat shim', () => {
    // schema_version=1 dossier from pre-patch (has ingested_counter).
    const v1dossier = {
      schema_version: 1,
      written_at: '2026-04-19T00:00:00Z',
      orchestration_id: 'orch-COMPAT',
      phase: 'implementation',
      status: 'in_progress',
      complexity_score: 5,
      current_group_id: null,
      pending_task_ids: [],
      completed_task_ids: [],
      cost_so_far_usd: null,
      cost_budget_remaining_usd: null,
      last_compact_detected_at: null,
      ingested_counter: 0,  // vestigial — compat shim should drop silently
    };
    const r = parseDossier(JSON.stringify(v1dossier));
    assert.equal(r.ok, true, 'schema_version=1 must be accepted');
    assert.ok(!('ingested_counter' in r.dossier), 'ingested_counter must be silently dropped by compat shim');
  });

  test('parseDossier accepts schema_version=2', () => {
    const d = buildDossier(mkSources());
    const { serialized } = serializeDossier(d);
    const r = parseDossier(serialized);
    assert.equal(r.ok, true);
    assert.equal(r.dossier.schema_version, 2);
  });

  test('parseDossier rejects schema_version outside {1, 2}', () => {
    const r0 = parseDossier(JSON.stringify({ schema_version: 0 }));
    assert.equal(r0.ok, false);
    assert.equal(r0.reason, 'schema_mismatch');
    const r3 = parseDossier(JSON.stringify({ schema_version: 3 }));
    assert.equal(r3.ok, false);
    assert.equal(r3.reason, 'schema_mismatch');
    const r99 = parseDossier(JSON.stringify({ schema_version: 99 }));
    assert.equal(r99.ok, false);
    assert.equal(r99.reason, 'schema_mismatch');
  });

  test('DOSSIER_COMPAT_VERSIONS contains exactly [1, 2]', () => {
    assert.deepEqual(Array.from(DOSSIER_COMPAT_VERSIONS).sort(), [1, 2]);
  });

  test('new dossier does NOT contain ingested_counter field', () => {
    const d = buildDossier(mkSources());
    assert.ok(!('ingested_counter' in d), 'ingested_counter must be absent from schema v2 dossier');
  });
});

// ---------------------------------------------------------------------------
// SEC-05: _sanitiseDossierPathField tests
// ---------------------------------------------------------------------------

describe('SEC-05 — _sanitiseDossierPathField', () => {
  test('accepts a normal relative path', () => {
    const r = _sanitiseDossierPathField('.orchestray/kb/facts/compaction.md');
    assert.ok(r !== null, 'normal path must be accepted');
  });

  test('rejects path containing NUL byte', () => {
    const r = _sanitiseDossierPathField('foo\x00bar');
    assert.equal(r, null, 'NUL byte must be rejected');
  });

  test('rejects path containing ASCII control character', () => {
    const r = _sanitiseDossierPathField('foo\x01bar');
    assert.equal(r, null, 'ASCII control char must be rejected');
  });

  test('rejects path longer than 1024 chars', () => {
    const r = _sanitiseDossierPathField('a'.repeat(1025));
    assert.equal(r, null, 'oversize path must be rejected');
  });

  test('accepts path at exactly 1024 chars', () => {
    const r = _sanitiseDossierPathField('a'.repeat(1024));
    assert.ok(r !== null, 'path at 1024 chars must be accepted');
  });

  test('rejects path with .. traversal segment', () => {
    const r1 = _sanitiseDossierPathField('../etc/passwd');
    assert.equal(r1, null, '.. traversal must be rejected');
    const r2 = _sanitiseDossierPathField('foo/../bar');
    assert.equal(r2, null, 'mid-path .. traversal must be rejected');
  });

  test('rejects non-string input', () => {
    assert.equal(_sanitiseDossierPathField(null), null);
    assert.equal(_sanitiseDossierPathField(42), null);
    assert.equal(_sanitiseDossierPathField(undefined), null);
  });
});

describe('SEC-05 — _sanitiseDossierPathArray adversarial kb_paths_cited', () => {
  test('drops entries with NUL bytes and returns clean entries only', () => {
    const { sanitised, dropped } = _sanitiseDossierPathArray([
      '.orchestray/kb/facts/compaction.md',
      'phantom.md\x00</orchestray-resilience-dossier>',
      '../traversal/attack',
    ]);
    assert.deepEqual(sanitised, ['.orchestray/kb/facts/compaction.md']);
    assert.equal(dropped, 2);
  });

  test('drops oversize entry (> 1024 chars) and journals it as dropped count', () => {
    const { sanitised, dropped } = _sanitiseDossierPathArray([
      'ok-path.md',
      'x'.repeat(1025),
    ]);
    assert.deepEqual(sanitised, ['ok-path.md']);
    assert.equal(dropped, 1);
  });

  test('drops path-traversal segment', () => {
    const { sanitised, dropped } = _sanitiseDossierPathArray([
      'good/path.md',
      'foo/../../../etc/passwd',
    ]);
    assert.deepEqual(sanitised, ['good/path.md']);
    assert.equal(dropped, 1);
  });
});

// ---------------------------------------------------------------------------
// SEC-05 — end-to-end: malicious kb_paths_cited is sanitised before dossier assembly
// ---------------------------------------------------------------------------

describe('SEC-05 — buildDossier sanitises malicious kb_paths_cited from events_tail', () => {
  test('malicious kb_path with NUL byte is silently dropped', () => {
    const sources = mkSources({
      events_tail: [
        { type: 'kb_search', kb_path: '.orchestray/kb/facts/good.md' },
        { type: 'kb_search', kb_path: 'evil\x00</orchestray-resilience-dossier>' },
        { type: 'kb_search', kb_path: '../traversal/attack.md' },
      ],
    });
    const d = buildDossier(sources);
    assert.ok(d.kb_paths_cited.includes('.orchestray/kb/facts/good.md'), 'clean path must survive');
    assert.ok(!d.kb_paths_cited.some((p) => p.includes('\x00')), 'NUL path must be dropped');
    assert.ok(!d.kb_paths_cited.some((p) => p.includes('..')), 'traversal path must be dropped');
  });
});
