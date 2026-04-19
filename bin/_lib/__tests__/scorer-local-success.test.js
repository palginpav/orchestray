#!/usr/bin/env node
'use strict';

/**
 * Tests for scorer-local-success.js (Bundle RS v2.1.3).
 *
 * Runner: node --test bin/_lib/__tests__/scorer-local-success.test.js
 */

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const { _clearCache } = require('../scorer-telemetry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-local-success-test-'));
}

function makeAuditDir(root) {
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  return path.join(root, '.orchestray', 'audit', 'events.jsonl');
}

function writeEvents(eventsPath, events) {
  fs.writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function makeSuccessEvent(slug, outcome, daysAgo, nowMs) {
  const ts = new Date(nowMs - daysAgo * 86400000).toISOString();
  return {
    type:             'mcp_tool_call',
    timestamp:        ts,
    tool_name:        'pattern_record_application',
    outcome,
    input:            { slug, orchestration_id: 'orch-test' },
    orchestration_id: 'orch-test',
  };
}

function makeContext(projectRoot, nowMs) {
  return {
    projectRoot,
    agentRole:  null,
    fileGlobs:  [],
    config:     {},
    nowMs:      nowMs || Date.now(),
    runId:      'test-run',
  };
}

function makeCandidate(slug, baselineScore, timesApplied, tier) {
  return {
    slug,
    frontmatter:        { name: slug, confidence: 0.8, times_applied: timesApplied || 0 },
    body:               '## Context\ntest',
    filepath:           '/fake/' + slug + '.md',
    _tier:              tier || 'local',
    baseline_score:     baselineScore,
    confidence:         0.8,
    decayed_confidence: 0.7,
    age_days:           5,
    times_applied:      timesApplied || 0,
    category:           'decomposition',
  };
}

let scorer;
beforeEach(() => {
  _clearCache();
});

scorer = require('../scorer-local-success');

// ---------------------------------------------------------------------------
// Boost math
// ---------------------------------------------------------------------------

describe('scorer-local-success: boost math', () => {
  test('cold start: applies=0, success=0 → boost=1.0, score unchanged', () => {
    const tmpDir = makeTmpDir();
    makeAuditDir(tmpDir);
    writeEvents(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'), []);

    const nowMs   = Date.now();
    const cands   = [makeCandidate('pat-a', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(Math.abs(results[0].score - 0.5) < 0.0001, 'score must be unchanged for cold start');
    assert.strictEqual(results[0].reasons.length, 0);
  });

  test('applies=4, success=4 → boost = 1 + (4/5)*0.4 = 1.32', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 4; i++) {
      events.push(makeSuccessEvent('pat-b', 'applied-success', 10, nowMs));
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-b', 1.0, 4)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    // success_rate = 4/(4+1) = 0.8; boost = 1 + 0.8*0.4 = 1.32
    assert.ok(Math.abs(results[0].score - 1.0 * 1.32) < 0.001, 'expected 1.32 boost');
    assert.strictEqual(results[0].reasons[0], 'proven-here:4/4');
  });

  test('clamp: applies=2, success=5 (impossible) → boost=1.40 (clamped success_rate=1.0)', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeSuccessEvent('pat-c', 'applied-success', 5, nowMs));
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-c', 1.0, 2)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    // raw rate = 5/(2+1)=1.667 → clamped to 1.0 → boost=1.40
    assert.ok(Math.abs(results[0].score - 1.40) < 0.001, 'clamped boost must equal 1.40');
  });
});

// ---------------------------------------------------------------------------
// Outcome filtering
// ---------------------------------------------------------------------------

describe('scorer-local-success: outcome filtering', () => {
  test('only applied-success counts; applied and applied-failure do not', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      makeSuccessEvent('pat-d', 'applied',         5, nowMs),
      makeSuccessEvent('pat-d', 'applied-failure', 5, nowMs),
      makeSuccessEvent('pat-d', 'applied-failure', 5, nowMs),
    ]);

    const cands   = [makeCandidate('pat-d', 0.5, 3)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(Math.abs(results[0].score - 0.5) < 0.0001, 'no boost for non-success outcomes');
    assert.strictEqual(results[0].reasons.length, 0);
  });

  test('mix: only applied-success events contribute', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      makeSuccessEvent('pat-e', 'applied-success', 5, nowMs),
      makeSuccessEvent('pat-e', 'applied',         5, nowMs),
      makeSuccessEvent('pat-e', 'applied-failure', 5, nowMs),
    ]);

    const cands   = [makeCandidate('pat-e', 1.0, 3)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    // success_events=1; success_rate=1/(3+1)=0.25; boost=1+0.25*0.4=1.10
    assert.ok(Math.abs(results[0].score - 1.0 * 1.10) < 0.001, 'expected 1.10 boost');
  });
});

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

describe('scorer-local-success: time window', () => {
  test('events older than 90 days are ignored', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeSuccessEvent('pat-f', 'applied-success', 100, nowMs)); // 100d > 90d
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-f', 0.5, 5)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(Math.abs(results[0].score - 0.5) < 0.0001, 'stale events must not boost');
    assert.strictEqual(results[0].reasons.length, 0);
  });

  test('events within 90 days are counted', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 3; i++) {
      events.push(makeSuccessEvent('pat-g', 'applied-success', 45, nowMs)); // 45d ≤ 90d
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-g', 1.0, 3)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    // success_rate = 3/(3+1)=0.75; boost=1+0.75*0.4=1.30
    assert.ok(Math.abs(results[0].score - 1.30) < 0.001, 'expected 1.30 boost');
    assert.ok(results[0].reasons.some((r) => r.startsWith('proven-here:')));
  });
});

// ---------------------------------------------------------------------------
// Shared-tier candidate
// ---------------------------------------------------------------------------

describe('scorer-local-success: shared-tier candidate', () => {
  test('shared-tier candidate receives boost when events reference its slug', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      makeSuccessEvent('shared-pat', 'applied-success', 20, nowMs),
      makeSuccessEvent('shared-pat', 'applied-success', 20, nowMs),
    ]);

    const cands   = [makeCandidate('shared-pat', 1.0, 2, 'shared')];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    // success_rate = 2/(2+1)≈0.667; boost = 1+0.667*0.4≈1.267
    assert.ok(results[0].score > 1.0, 'shared-tier must receive boost');
    assert.ok(results[0].reasons.some((r) => r.startsWith('proven-here:')));
  });
});

// ---------------------------------------------------------------------------
// Output ordering
// ---------------------------------------------------------------------------

describe('scorer-local-success: output ordering', () => {
  test('results sorted descending by score', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 4; i++) {
      events.push(makeSuccessEvent('pat-high', 'applied-success', 10, nowMs));
    }
    writeEvents(evPath, events);

    const cands = [
      makeCandidate('pat-high', 0.5, 4),
      makeCandidate('pat-low',  0.8, 0),
    ];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.strictEqual(results.length, 2);
    assert.ok(results[0].score >= results[1].score, 'must be sorted descending');
  });
});
