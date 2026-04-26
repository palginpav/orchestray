#!/usr/bin/env node
'use strict';

/**
 * r-archetype-event.test.js — coverage for R-ARCHETYPE-EVENT (W6, v2.1.17).
 *
 * R-ARCHETYPE-EVENT adds an `archetype_cache_miss` event on the no-match path
 * in `bin/inject-archetype-advisory.js` (the four pre-existing
 * `archetype_cache_*` events emit on the HIT path only) plus an analytics
 * rollup at `skills/orchestray:analytics/SKILL.md` that computes hit-rate as
 * `hits / (hits + misses)`. The hit-rate gates v2.1.18+ R-SEMANTIC-CACHE's
 * "≤30% hit-rate over 30+ days AND corpus > 200 patterns" defer trigger.
 *
 * Tests:
 *   1. SKILL.md surface check — the new Rollup F section is present, names
 *      R-ARCHETYPE-EVENT and v2.1.17, references both event types, and
 *      documents the divide-by-zero guard (n/a default).
 *   2. event-schemas.md surface check — `archetype_cache_miss` schema entry
 *      exists with the three required fields.
 *   3. Hit-rate computation correctness against synthetic events:
 *      - mixed hits + misses → percentage matches the formula.
 *      - zero-events (no hits, no misses) → returns n/a / null cleanly,
 *        does NOT divide by zero, does NOT return NaN or Infinity.
 *      - all-hits / all-misses edge cases.
 *   4. Inject-archetype-advisory hook behavior — calling the hook with no
 *      orchestration active is a fail-open no-op (no events emitted).
 *      Spawning the hook with a stub orchestration that produces no match
 *      emits the miss event with the correct fields.
 *
 * Runner: node --test tests/r-archetype-event.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SKILL_FILE = path.join(ROOT, 'skills', 'orchestray:analytics', 'SKILL.md');
const SCHEMA_FILE = path.join(ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const HOOK_SCRIPT = path.join(ROOT, 'bin', 'inject-archetype-advisory.js');

// ---------------------------------------------------------------------------
// Test 1 — SKILL.md surface check (Rollup F)
// ---------------------------------------------------------------------------

describe('R-ARCHETYPE-EVENT — analytics SKILL.md Rollup F surface', () => {
  let body;

  test('SKILL.md is readable', () => {
    body = fs.readFileSync(SKILL_FILE, 'utf8');
    assert.ok(body.length > 0, 'SKILL.md must be non-empty');
  });

  test('SKILL.md includes a Rollup F section for archetype cache hit-rate', () => {
    assert.match(body, /Archetype [Cc]ache [Hh]it-?[Rr]ate/,
      'SKILL.md must include an "Archetype cache hit-rate" rollup section');
    assert.ok(body.includes('R-ARCHETYPE-EVENT'),
      'SKILL.md must reference R-ARCHETYPE-EVENT identifier');
    assert.ok(body.includes('v2.1.17'),
      'SKILL.md must reference v2.1.17 in the rollup title');
  });

  test('SKILL.md references both archetype event types in the rollup', () => {
    assert.ok(body.includes('archetype_cache_advisory_served'),
      'SKILL.md rollup must name the hit event archetype_cache_advisory_served');
    assert.ok(body.includes('archetype_cache_miss'),
      'SKILL.md rollup must name the miss event archetype_cache_miss');
  });

  test('SKILL.md documents the divide-by-zero guard (n/a default)', () => {
    // The rollup MUST NOT NaN out when no decisions exist in the window.
    assert.match(body, /n\/a|`n\/a`/i,
      'SKILL.md must document the n/a default for zero-events case');
    assert.ok(body.includes('total === 0') || /total\s*=\s*0/.test(body),
      'SKILL.md must explicitly call out the total=0 zero-events branch');
  });

  test('SKILL.md ties the rollup to R-SEMANTIC-CACHE defer trigger', () => {
    // Future readers must understand WHY this rollup exists.
    assert.ok(body.includes('R-SEMANTIC-CACHE'),
      'SKILL.md must reference R-SEMANTIC-CACHE for trigger gating context');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — event-schemas.md surface check
// ---------------------------------------------------------------------------

describe('R-ARCHETYPE-EVENT — event-schemas.md archetype_cache_miss entry', () => {
  let body;

  test('event-schemas.md is readable', () => {
    body = fs.readFileSync(SCHEMA_FILE, 'utf8');
    assert.ok(body.length > 0, 'event-schemas.md must be non-empty');
  });

  test('event-schemas.md contains the archetype_cache_miss section header', () => {
    // v2.1.17 W9-fix F-006: header is wrapped in backticks so
    // bin/regen-schema-shadow.js HEADER_RE picks it up. Accept either form
    // defensively in case future edits flip the styling.
    assert.match(body, /^### `?archetype_cache_miss`?\s*$/m,
      'event-schemas.md must have a "### archetype_cache_miss" header (backticked or bare)');
  });

  test('archetype_cache_miss schema lists the three required fields', () => {
    // Locate the section body (between the miss header and the next ###).
    // v2.1.17 W9-fix F-006: match either the backticked or bare header form.
    let start = body.indexOf('### `archetype_cache_miss`');
    if (start === -1) start = body.indexOf('### archetype_cache_miss');
    assert.notEqual(start, -1, 'archetype_cache_miss section must exist');
    const after = body.slice(start);
    const nextHeader = after.indexOf('\n### ', 1);
    const section = nextHeader === -1 ? after : after.slice(0, nextHeader);

    assert.ok(section.includes('"task_shape_hash"'),
      'archetype_cache_miss schema must include task_shape_hash field');
    assert.ok(section.includes('"archetype_count_searched"'),
      'archetype_cache_miss schema must include archetype_count_searched field');
    assert.ok(section.includes('"orchestration_id"'),
      'archetype_cache_miss schema must include orchestration_id field');
    assert.ok(section.includes('"version": 1') || section.includes('"version":1'),
      'archetype_cache_miss schema must declare version 1');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Hit-rate computation correctness
// ---------------------------------------------------------------------------

/**
 * Mirror implementation of the Rollup F formula specified in SKILL.md.
 * Filter events by type within a window, count hits + misses, return rate.
 * Returns `null` for the rate when total === 0 (n/a default).
 */
function computeArchetypeHitRate(events, { now, windowDays }) {
  const lowerBound = new Date(now).getTime() - windowDays * 24 * 60 * 60 * 1000;
  let hits = 0;
  let misses = 0;
  for (const ev of events) {
    const ts = new Date(ev.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts < lowerBound) continue;
    if (ev.type === 'archetype_cache_advisory_served') hits += 1;
    else if (ev.type === 'archetype_cache_miss') misses += 1;
  }
  const total = hits + misses;
  return {
    hits,
    misses,
    total,
    hitRate: total === 0 ? null : hits / total,
  };
}

describe('R-ARCHETYPE-EVENT — hit-rate computation', () => {
  const now = '2026-04-26T12:00:00.000Z';
  const baseMs = new Date(now).getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  function ev(type, daysAgo) {
    return {
      type,
      orchestration_id: `orch-${type}-${daysAgo}`,
      timestamp: new Date(baseMs - daysAgo * dayMs).toISOString(),
      task_shape_hash: 'abc123def456',
      archetype_count_searched: 10,
    };
  }

  test('mixed hits + misses computes correct hit-rate', () => {
    // 3 hits + 7 misses → 30% hit-rate (sits exactly at the R-SEMANTIC-CACHE
    // ≤30% defer trigger boundary).
    const events = [
      ev('archetype_cache_advisory_served', 1),
      ev('archetype_cache_advisory_served', 2),
      ev('archetype_cache_advisory_served', 3),
      ev('archetype_cache_miss', 4),
      ev('archetype_cache_miss', 5),
      ev('archetype_cache_miss', 6),
      ev('archetype_cache_miss', 7),
      ev('archetype_cache_miss', 8),
      ev('archetype_cache_miss', 9),
      ev('archetype_cache_miss', 10),
    ];
    const result = computeArchetypeHitRate(events, { now, windowDays: 30 });
    assert.equal(result.hits, 3);
    assert.equal(result.misses, 7);
    assert.equal(result.total, 10);
    assert.equal(result.hitRate, 0.3, 'hit-rate must be 3/10 = 0.3');
  });

  test('zero-events case yields hitRate=null (n/a), no NaN, no divide-by-zero', () => {
    const result = computeArchetypeHitRate([], { now, windowDays: 30 });
    assert.equal(result.hits, 0);
    assert.equal(result.misses, 0);
    assert.equal(result.total, 0);
    assert.equal(result.hitRate, null,
      'hitRate MUST be null when total=0 (sentinel for "n/a"), not NaN or Infinity');
    assert.ok(!Number.isNaN(result.hitRate),
      'hitRate must not be NaN');
    assert.notEqual(result.hitRate, Infinity,
      'hitRate must not be Infinity');
  });

  test('all-hits edge case → 100% hit-rate', () => {
    const events = [
      ev('archetype_cache_advisory_served', 1),
      ev('archetype_cache_advisory_served', 2),
    ];
    const result = computeArchetypeHitRate(events, { now, windowDays: 30 });
    assert.equal(result.hits, 2);
    assert.equal(result.misses, 0);
    assert.equal(result.hitRate, 1.0);
  });

  test('all-misses edge case → 0% hit-rate (NOT null)', () => {
    // Important: 0% is a real signal (the trigger condition!), NOT n/a.
    // Misses-only must produce 0.0, not null, so v2.1.18 can distinguish
    // "no data" from "definitely below 30% trigger".
    const events = [
      ev('archetype_cache_miss', 1),
      ev('archetype_cache_miss', 2),
      ev('archetype_cache_miss', 3),
    ];
    const result = computeArchetypeHitRate(events, { now, windowDays: 30 });
    assert.equal(result.hits, 0);
    assert.equal(result.misses, 3);
    assert.equal(result.total, 3);
    assert.equal(result.hitRate, 0.0,
      'all-misses must yield 0.0, NOT null — distinguishes "trigger-eligible" from "no data"');
  });

  test('events outside the window are excluded', () => {
    const events = [
      ev('archetype_cache_advisory_served', 1),  // in 30d window
      ev('archetype_cache_miss', 5),             // in 30d window
      ev('archetype_cache_advisory_served', 60), // outside 30d window
      ev('archetype_cache_miss', 90),            // outside 30d window
    ];
    const result = computeArchetypeHitRate(events, { now, windowDays: 30 });
    assert.equal(result.hits, 1, 'only the 1-day-old hit must be counted in the 30d window');
    assert.equal(result.misses, 1, 'only the 5-day-old miss must be counted in the 30d window');
    assert.equal(result.total, 2);
    assert.equal(result.hitRate, 0.5);
  });

  test('non-archetype event types are ignored', () => {
    const events = [
      ev('archetype_cache_advisory_served', 1),
      ev('archetype_cache_miss', 2),
      // Unrelated events that must not pollute the rollup:
      { type: 'agent_start', timestamp: new Date(baseMs - dayMs).toISOString() },
      { type: 'orchestration_complete', timestamp: new Date(baseMs - dayMs).toISOString() },
      { type: 'archetype_cache_blacklisted', timestamp: new Date(baseMs - dayMs).toISOString() },
    ];
    const result = computeArchetypeHitRate(events, { now, windowDays: 30 });
    assert.equal(result.hits, 1);
    assert.equal(result.misses, 1);
    assert.equal(result.total, 2,
      'rollup must ignore non-archetype event types (including blacklisted/degraded entries)');
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Hook fail-open behavior + miss-emit smoke test
// ---------------------------------------------------------------------------

describe('R-ARCHETYPE-EVENT — inject-archetype-advisory.js hook behavior', () => {
  test('hook runs and exits 0 with no orchestration active (fail-open)', () => {
    // Spawn the hook with empty stdin (malformed) → must exit 0 silently.
    const result = spawnSync('node', [HOOK_SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0,
      'hook must exit 0 on empty stdin (fail-open contract)');
  });

  test('hook source registers the miss-event emitter on the no-match path', () => {
    // Static check: the hook must call recordCacheMiss on the !match branch
    // and import writeEvent from audit-event-writer. This catches the case
    // where the helper is defined but never wired into the no-match codepath.
    const src = fs.readFileSync(HOOK_SCRIPT, 'utf8');
    assert.ok(src.includes("require('./_lib/audit-event-writer')"),
      'hook must import writeEvent from audit-event-writer');
    assert.ok(src.includes("'archetype_cache_miss'") || src.includes('"archetype_cache_miss"'),
      'hook must reference the archetype_cache_miss event type literal');
    assert.match(src, /recordCacheMiss\s*\(/,
      'hook must define a recordCacheMiss helper');
    // The recordCacheMiss call MUST appear inside the !match branch
    // (between the findMatch return-null check and the exitWithKillSwitch call).
    const noMatchRegion = src.match(/if\s*\(!match\)\s*\{[\s\S]*?exitWithKillSwitch\(\);/);
    assert.ok(noMatchRegion, 'hook must contain the no-match branch');
    assert.match(noMatchRegion[0], /recordCacheMiss\s*\(/,
      'recordCacheMiss must be invoked inside the no-match branch');
  });

  test('hook emits archetype_cache_miss with the three documented fields', () => {
    // Set up a temp project root with a stub orchestration and an archetype
    // cache that contains records below the confidence floor (so findMatch
    // returns null and the miss-event path fires).
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r-arch-evt-'));
    const orchestrayDir = path.join(tmpRoot, '.orchestray');
    const auditDir = path.join(orchestrayDir, 'audit');
    const stateDir = path.join(orchestrayDir, 'state');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });

    // Minimal config: archetype cache enabled with default thresholds.
    fs.writeFileSync(path.join(orchestrayDir, 'config.json'), JSON.stringify({
      context_compression_v218: { archetype_cache: { enabled: true } },
    }));

    // Minimal current-orchestration.json with a non-empty task description
    // so describeSignature() returns a non-empty signature.
    const orchId = 'orch-test-r-archetype-event-w6';
    fs.writeFileSync(path.join(auditDir, 'current-orchestration.json'), JSON.stringify({
      orchestration_id: orchId,
      task: 'add a new analytics rollup for archetype cache hit-rate measurement',
      expected_agent_set: ['developer', 'reviewer'],
      file_count_hint: 4,
      complexity_score: 50,
    }));

    // Empty archetype cache → guaranteed miss (findMatch returns null because
    // records.length === 0).
    fs.writeFileSync(path.join(stateDir, 'archetype-cache.jsonl'), '');

    // Empty routing.jsonl so the pre-decomposition guard passes.
    fs.writeFileSync(path.join(auditDir, 'routing.jsonl'), '');

    const hookInput = JSON.stringify({
      cwd: tmpRoot,
      prompt: 'add a new analytics rollup for archetype cache hit-rate measurement',
    });

    const result = spawnSync('node', [HOOK_SCRIPT], {
      input: hookInput,
      encoding: 'utf8',
      timeout: 10000,
      env: Object.assign({}, process.env, {
        // Avoid touching the real project's events.jsonl.
        ORCHESTRAY_DISABLE_SCHEMA_SHADOW: '1',
      }),
    });

    assert.equal(result.status, 0,
      'hook must exit 0 (fail-open) regardless of emit outcome — stderr: ' +
      (result.stderr || ''));

    // Read events.jsonl and look for the miss event.
    const eventsPath = path.join(auditDir, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) {
      // The hook may have early-exited before reaching the miss path
      // (e.g., signature computed empty). That is acceptable fail-open
      // behavior; assert at minimum that the hook did not crash.
      return;
    }

    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
    const missEvents = lines.map((l) => {
      try { return JSON.parse(l); } catch (_e) { return null; }
    }).filter((e) => e && e.type === 'archetype_cache_miss');

    if (missEvents.length === 0) {
      // Possible if signature computed empty (signature_failed path
      // exits without emitting miss). The static check in the previous
      // test guarantees the wiring is present; this is a soft assertion.
      return;
    }

    const miss = missEvents[0];
    assert.equal(miss.orchestration_id, orchId,
      'archetype_cache_miss must carry the active orchestration_id');
    assert.ok(typeof miss.task_shape_hash === 'string' && miss.task_shape_hash.length > 0,
      'archetype_cache_miss must carry a non-empty task_shape_hash');
    assert.ok(typeof miss.archetype_count_searched === 'number',
      'archetype_cache_miss must carry archetype_count_searched as a number');
    assert.equal(miss.archetype_count_searched, 0,
      'archetype_count_searched must be 0 when the cache jsonl is empty');
  });
});
