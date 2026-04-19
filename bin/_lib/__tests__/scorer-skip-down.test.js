#!/usr/bin/env node
'use strict';

/**
 * Tests for scorer-skip-down.js (Bundle RS v2.1.3).
 *
 * Runner: node --test bin/_lib/__tests__/scorer-skip-down.test.js
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scorer-skip-down-test-'));
}

function makeAuditDir(root) {
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  return path.join(root, '.orchestray', 'audit', 'events.jsonl');
}

function writeEvents(eventsPath, events) {
  fs.writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function makeSkipEvent(patternName, skipCategory, daysAgo, nowMs) {
  const ts = new Date(nowMs - daysAgo * 86400000).toISOString();
  return {
    type:             'pattern_skip_enriched',
    timestamp:        ts,
    pattern_name:     patternName,
    skip_category:    skipCategory,
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

function makeCandidate(slug, baselineScore, timesApplied) {
  return {
    slug,
    frontmatter:        { name: slug, confidence: 0.8, times_applied: timesApplied || 0 },
    body:               '## Context\ntest',
    filepath:           '/fake/' + slug + '.md',
    _tier:              'local',
    baseline_score:     baselineScore,
    confidence:         0.8,
    decayed_confidence: 0.7,
    age_days:           5,
    times_applied:      timesApplied || 0,
    category:           'decomposition',
  };
}

// Load scorer after scorer-shadow is loaded (self-registration requirement).
let scorer;
beforeEach(() => {
  _clearCache();
});

// Load at module level.
scorer = require('../scorer-skip-down');

// ---------------------------------------------------------------------------
// Skip ratio math
// ---------------------------------------------------------------------------

describe('scorer-skip-down: skip ratio math', () => {
  test('zero skips zero applies → penalty 1.0 (score unchanged)', () => {
    const tmpDir = makeTmpDir();
    makeAuditDir(tmpDir);
    writeEvents(path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl'), []);

    const nowMs   = Date.now();
    const cands   = [makeCandidate('pat-a', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].slug, 'pat-a');
    assert.ok(Math.abs(results[0].score - 0.5) < 0.0001, 'score should equal baseline when no skips');
    assert.strictEqual(results[0].reasons.length, 0);
  });

  test('8 contextual-mismatch skips, applies=0 → skip_rate=8/9, penalty≈0.467', () => {
    // skip_rate = 8/(0+8+1) = 8/9 ≈ 0.889
    // penalty = 1 - (8/9)*0.6 ≈ 0.467
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 8; i++) {
      events.push(makeSkipEvent('pat-b', 'contextual-mismatch', 10, nowMs));
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-b', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    const expectedScore = 0.5 * (1 - (8 / 9) * 0.6);
    assert.ok(
      Math.abs(results[0].score - expectedScore) < 0.001,
      'score expected ' + expectedScore.toFixed(4) + ' got ' + results[0].score.toFixed(4)
    );
    assert.ok(results[0].reasons.includes('skip-penalty:contextual-mismatch'));
    assert.ok(results[0].reasons.some((r) => r.startsWith('ratio=')));
  });

  test('applies_p present: skip_rate = skips/(applies+skips+1)', () => {
    // 2 skips, timesApplied=4: skip_rate = 2/(4+2+1) = 2/7
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      makeSkipEvent('pat-c', 'superseded', 5, nowMs),
      makeSkipEvent('pat-c', 'superseded', 5, nowMs),
    ]);

    const cands   = [makeCandidate('pat-c', 1.0, 4)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    const expectedRate    = 2 / 7;
    const expectedPenalty = 1 - expectedRate * 0.6;
    assert.ok(
      Math.abs(results[0].score - 1.0 * expectedPenalty) < 0.001,
      'expected ' + (1.0 * expectedPenalty).toFixed(4)
    );
  });

  test('floor: extreme skip rate never zeros out score', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeSkipEvent('pat-d', 'contextual-mismatch', 5, nowMs));
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-d', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    // floor = 0.01 * 0.5 = 0.005; max-shrinkage score = 0.5*(1-0.6) = 0.2
    assert.ok(results[0].score >= 0.01 * 0.5, 'score must be above floor');
  });
});

// ---------------------------------------------------------------------------
// Category filtering
// ---------------------------------------------------------------------------

describe('scorer-skip-down: category filtering', () => {
  test('forgotten and operator-override are excluded', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      makeSkipEvent('pat-e', 'forgotten',         5, nowMs),
      makeSkipEvent('pat-e', 'operator-override', 5, nowMs),
      makeSkipEvent('pat-e', 'stale',             5, nowMs),
    ]);

    const cands   = [makeCandidate('pat-e', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(Math.abs(results[0].score - 0.5) < 0.0001, 'no penalty for noisy categories');
    assert.strictEqual(results[0].reasons.length, 0);
  });

  test('null pattern_name events dropped', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      { type: 'pattern_skip_enriched', timestamp: new Date(nowMs).toISOString(),
        pattern_name: null, skip_category: 'contextual-mismatch', orchestration_id: 'o1' },
      { type: 'pattern_skip_enriched', timestamp: new Date(nowMs).toISOString(),
        skip_category: 'contextual-mismatch', orchestration_id: 'o1' },
    ]);

    const cands   = [makeCandidate('pat-f', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(Math.abs(results[0].score - 0.5) < 0.0001);
  });
});

// ---------------------------------------------------------------------------
// Time window
// ---------------------------------------------------------------------------

describe('scorer-skip-down: time window', () => {
  test('events older than 180 days are ignored', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeSkipEvent('pat-g', 'contextual-mismatch', 200, nowMs)); // 200d > 180d
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-g', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(Math.abs(results[0].score - 0.5) < 0.0001, 'stale events must not penalise');
    assert.strictEqual(results[0].reasons.length, 0);
  });

  test('events within 180 days are counted', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 5; i++) {
      events.push(makeSkipEvent('pat-h', 'contextual-mismatch', 90, nowMs)); // 90d ≤ 180d
    }
    writeEvents(evPath, events);

    const cands   = [makeCandidate('pat-h', 0.5, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    // skip_rate = 5/(0+5+1) > 0.05 → reasons non-empty
    assert.ok(results[0].reasons.length > 0, 'should have reason for in-window events');
  });
});

// ---------------------------------------------------------------------------
// Dominant category
// ---------------------------------------------------------------------------

describe('scorer-skip-down: dominant category', () => {
  test('contextual-mismatch wins tie', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      makeSkipEvent('pat-i', 'contextual-mismatch', 5, nowMs),
      makeSkipEvent('pat-i', 'superseded',          5, nowMs),
    ]);

    const cands   = [makeCandidate('pat-i', 1.0, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(results[0].reasons.includes('skip-penalty:contextual-mismatch'));
  });

  test('superseded wins when it dominates', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    writeEvents(evPath, [
      makeSkipEvent('pat-j', 'contextual-mismatch', 5, nowMs),
      makeSkipEvent('pat-j', 'superseded',          5, nowMs),
      makeSkipEvent('pat-j', 'superseded',          5, nowMs),
    ]);

    const cands   = [makeCandidate('pat-j', 1.0, 0)];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.ok(results[0].reasons.includes('skip-penalty:superseded'));
  });
});

// ---------------------------------------------------------------------------
// Output ordering
// ---------------------------------------------------------------------------

describe('scorer-skip-down: output ordering', () => {
  test('results sorted descending by score', () => {
    const tmpDir = makeTmpDir();
    const evPath = makeAuditDir(tmpDir);
    const nowMs  = Date.now();

    const events = [];
    for (let i = 0; i < 8; i++) {
      events.push(makeSkipEvent('pat-heavy', 'contextual-mismatch', 10, nowMs));
    }
    writeEvents(evPath, events);

    const cands = [
      makeCandidate('pat-heavy', 0.9, 0),
      makeCandidate('pat-light', 0.5, 0),
    ];
    const results = scorer.score('query', cands, makeContext(tmpDir, nowMs));

    assert.strictEqual(results.length, 2);
    assert.ok(results[0].score >= results[1].score, 'results must be sorted desc');
  });
});
