#!/usr/bin/env node
'use strict';

/**
 * Tests for the W11 (LL1) counterfactual skip-enrichment extension to
 * `bin/mcp-server/tools/pattern_record_skip_reason.js`.
 *
 * Covers:
 *   - All 5 skip_category values accepted; a 6th string rejected with a clear error.
 *   - match_quality enum validated.
 *   - superseded_by accepted only when skip_category: superseded; rejected otherwise.
 *   - pattern_skip_enriched event written to audit trail with all fields canonical-shape.
 *   - forgotten rate > 30% triggers stderr warning; at <=30% no warning fires.
 *   - cited_confidence optional; omitted field doesn't break the call.
 *   - Schema validation preserves existing skip_reason/reason/note handling (backward compat).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  handle,
  definition,
  SKIP_REASONS,
  SKIP_CATEGORIES,
  MATCH_QUALITIES,
} = require('../bin/mcp-server/tools/pattern_record_skip_reason.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmpdir with standard .orchestray audit layout.
 * Returns { projectRoot, eventsPath }.
 */
function makeProjectRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-skip-enrich-test-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const eventsPath = path.join(auditDir, 'events.jsonl');
  return { projectRoot: dir, eventsPath };
}

function makeContext(projectRoot, overrides = {}) {
  return {
    config: {},
    logger: () => {},
    projectRoot,
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    orchestration_id: 'orch-ll1-test-001',
    reason: 'all-irrelevant',
    match_quality: 'strong-match',
    skip_category: 'contextual-mismatch',
    pattern_name: 'parallel-file-exclusive-updates',
    skip_reason: 'Task is cross-cutting, pattern requires file-exclusive parallel work',
    ...overrides,
  };
}

function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe('W11 exports', () => {

  test('exports SKIP_CATEGORIES with all 5 values', () => {
    assert.ok(Array.isArray(SKIP_CATEGORIES));
    assert.equal(SKIP_CATEGORIES.length, 5);
    assert.ok(SKIP_CATEGORIES.includes('contextual-mismatch'));
    assert.ok(SKIP_CATEGORIES.includes('stale'));
    assert.ok(SKIP_CATEGORIES.includes('superseded'));
    assert.ok(SKIP_CATEGORIES.includes('operator-override'));
    assert.ok(SKIP_CATEGORIES.includes('forgotten'));
  });

  test('exports MATCH_QUALITIES with all 3 values', () => {
    assert.ok(Array.isArray(MATCH_QUALITIES));
    assert.equal(MATCH_QUALITIES.length, 3);
    assert.ok(MATCH_QUALITIES.includes('strong-match'));
    assert.ok(MATCH_QUALITIES.includes('weak-match'));
    assert.ok(MATCH_QUALITIES.includes('edge-case'));
  });

  test('still exports SKIP_REASONS (backward compat)', () => {
    assert.ok(Array.isArray(SKIP_REASONS));
    assert.ok(SKIP_REASONS.includes('all-irrelevant'));
    assert.ok(SKIP_REASONS.includes('all-low-confidence'));
    assert.ok(SKIP_REASONS.includes('all-stale'));
    assert.ok(SKIP_REASONS.includes('other'));
  });

});

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

describe('definition', () => {

  test('name is pattern_record_skip_reason', () => {
    assert.equal(definition.name, 'pattern_record_skip_reason');
  });

  test('inputSchema requires orchestration_id and reason (match_quality/skip_category are recommended but optional)', () => {
    const req = definition.inputSchema.required;
    assert.ok(Array.isArray(req));
    assert.ok(req.includes('orchestration_id'));
    assert.ok(req.includes('reason'));
    // match_quality and skip_category are schema-optional (omitting defaults to forgotten/edge-case
    // with a stderr notice, for backward compat with old callers).
    // They appear in the properties schema with enum validation when provided.
    assert.ok(definition.inputSchema.properties.match_quality, 'match_quality property must be declared');
    assert.ok(definition.inputSchema.properties.skip_category, 'skip_category property must be declared');
  });

  test('inputSchema match_quality is an enum with 3 values', () => {
    const prop = definition.inputSchema.properties.match_quality;
    assert.ok(prop, 'match_quality property must exist');
    assert.ok(Array.isArray(prop.enum));
    assert.deepEqual([...prop.enum].sort(), ['edge-case', 'strong-match', 'weak-match']);
  });

  test('inputSchema skip_category is an enum with 5 values', () => {
    const prop = definition.inputSchema.properties.skip_category;
    assert.ok(prop, 'skip_category property must exist');
    assert.ok(Array.isArray(prop.enum));
    assert.deepEqual([...prop.enum].sort(), [
      'contextual-mismatch', 'forgotten', 'operator-override', 'stale', 'superseded',
    ]);
  });

  test('description mentions all 5 skip_category values', () => {
    for (const cat of SKIP_CATEGORIES) {
      assert.ok(
        definition.description.includes(cat),
        'description must mention skip_category: ' + cat
      );
    }
  });

});

// ---------------------------------------------------------------------------
// skip_category enum validation
// ---------------------------------------------------------------------------

describe('skip_category — all 5 values accepted', () => {

  test('accepts skip_category: contextual-mismatch', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ skip_category: 'contextual-mismatch' }), makeContext(projectRoot));
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.skip_category, 'contextual-mismatch');
  });

  test('accepts skip_category: stale', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ skip_category: 'stale' }), makeContext(projectRoot));
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.skip_category, 'stale');
  });

  test('accepts skip_category: superseded with superseded_by', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'superseded', superseded_by: 'parallel-file-v2' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.skip_category, 'superseded');
    assert.equal(body.superseded_by, 'parallel-file-v2');
  });

  test('accepts skip_category: operator-override', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'operator-override', reason: 'other', note: 'user said use manual approach' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.skip_category, 'operator-override');
  });

  test('accepts skip_category: forgotten', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'forgotten', reason: 'other', note: 'pattern seen but not explicitly weighed' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.skip_category, 'forgotten');
  });

  test('rejects a 6th unknown skip_category value with a clear error', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'not-a-real-category' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, true);
    const msg = result.content[0].text;
    assert.ok(msg.length > 0, 'error message must be non-empty');
    // The error should mention either the bad value or the enum
    assert.ok(
      msg.includes('not-a-real-category') || msg.includes('skip_category') || msg.includes('one of'),
      'error message should reference the invalid category; got: ' + msg
    );
  });

});

// ---------------------------------------------------------------------------
// match_quality enum validation
// ---------------------------------------------------------------------------

describe('match_quality — enum validated', () => {

  test('accepts match_quality: strong-match', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ match_quality: 'strong-match' }), makeContext(projectRoot));
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.match_quality, 'strong-match');
  });

  test('accepts match_quality: weak-match', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ match_quality: 'weak-match' }), makeContext(projectRoot));
    assert.equal(result.isError, false);
  });

  test('accepts match_quality: edge-case', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ match_quality: 'edge-case' }), makeContext(projectRoot));
    assert.equal(result.isError, false);
  });

  test('rejects an invalid match_quality value', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ match_quality: 'perfect-match' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, true);
    const msg = result.content[0].text;
    assert.ok(
      msg.includes('perfect-match') || msg.includes('match_quality') || msg.includes('one of'),
      'error should reference the invalid value; got: ' + msg
    );
  });

  test('missing match_quality defaults to edge-case (backward compat — no hard rejection)', async () => {
    // When match_quality is omitted, the tool defaults to "edge-case" and emits a
    // stderr notice. This preserves backward compatibility with old callers.
    const { projectRoot } = makeProjectRoot();
    const input = validInput();
    delete input.match_quality;
    const result = await handle(input, makeContext(projectRoot));
    assert.equal(result.isError, false, 'missing match_quality must not hard-reject');
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.match_quality, 'edge-case', 'must default to edge-case');
  });

});

// ---------------------------------------------------------------------------
// superseded_by cross-field validation
// ---------------------------------------------------------------------------

describe('superseded_by — cross-field validation', () => {

  test('superseded_by accepted when skip_category is superseded', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'superseded', superseded_by: 'newer-parallel-approach' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.superseded_by, 'newer-parallel-approach');
  });

  test('superseded_by rejected when skip_category is contextual-mismatch', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'contextual-mismatch', superseded_by: 'some-other-pattern' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, true);
    const msg = result.content[0].text;
    assert.ok(
      msg.includes('superseded_by') && (msg.includes('superseded') || msg.includes('only meaningful')),
      'error must explain superseded_by constraint; got: ' + msg
    );
  });

  test('superseded_by rejected when skip_category is stale', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'stale', superseded_by: 'some-other-pattern' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, true);
  });

  test('superseded_by rejected when skip_category is forgotten', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({
        skip_category: 'forgotten',
        superseded_by: 'some-other-pattern',
        reason: 'other',
        note: 'fallback',
      }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, true);
  });

  test('omitting superseded_by when skip_category is superseded is allowed', async () => {
    // superseded_by is optional even for superseded category
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ skip_category: 'superseded' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.ok(!('superseded_by' in body), 'superseded_by must be absent when not provided');
  });

});

// ---------------------------------------------------------------------------
// pattern_skip_enriched audit event
// ---------------------------------------------------------------------------

describe('pattern_skip_enriched audit event', () => {

  test('event written to audit trail on success', async () => {
    const { projectRoot, eventsPath } = makeProjectRoot();
    await handle(validInput(), makeContext(projectRoot));
    const events = readEvents(eventsPath);
    const skipEvents = events.filter(e => e.type === 'pattern_skip_enriched');
    assert.equal(skipEvents.length, 1, 'exactly one pattern_skip_enriched event must be written');
  });

  test('event has canonical shape: timestamp, type, orchestration_id, pattern_name, match_quality, skip_category, skip_reason', async () => {
    const { projectRoot, eventsPath } = makeProjectRoot();
    await handle(
      validInput({
        pattern_name: 'my-test-pattern',
        match_quality: 'weak-match',
        skip_category: 'stale',
        skip_reason: 'confidence was 0.28',
      }),
      makeContext(projectRoot)
    );
    const events = readEvents(eventsPath);
    const ev = events.find(e => e.type === 'pattern_skip_enriched');
    assert.ok(ev, 'event must exist');
    // timestamp: ISO 8601
    assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0, 'timestamp must be a non-empty string');
    assert.ok(!isNaN(new Date(ev.timestamp).getTime()), 'timestamp must be a valid ISO date');
    // type
    assert.equal(ev.type, 'pattern_skip_enriched');
    // orchestration_id
    assert.equal(ev.orchestration_id, 'orch-ll1-test-001');
    // pattern_name
    assert.equal(ev.pattern_name, 'my-test-pattern');
    // match_quality
    assert.equal(ev.match_quality, 'weak-match');
    // skip_category
    assert.equal(ev.skip_category, 'stale');
    // skip_reason
    assert.equal(ev.skip_reason, 'confidence was 0.28');
  });

  test('event includes cited_confidence when provided', async () => {
    const { projectRoot, eventsPath } = makeProjectRoot();
    await handle(
      validInput({ cited_confidence: 0.28 }),
      makeContext(projectRoot)
    );
    const events = readEvents(eventsPath);
    const ev = events.find(e => e.type === 'pattern_skip_enriched');
    assert.ok(ev);
    assert.equal(ev.cited_confidence, 0.28);
  });

  test('event does NOT include cited_confidence when not provided', async () => {
    const { projectRoot, eventsPath } = makeProjectRoot();
    await handle(validInput(), makeContext(projectRoot));
    const events = readEvents(eventsPath);
    const ev = events.find(e => e.type === 'pattern_skip_enriched');
    assert.ok(ev);
    assert.ok(!('cited_confidence' in ev), 'cited_confidence must be absent when not provided');
  });

  test('event includes superseded_by when skip_category is superseded', async () => {
    const { projectRoot, eventsPath } = makeProjectRoot();
    await handle(
      validInput({ skip_category: 'superseded', superseded_by: 'the-other-pattern' }),
      makeContext(projectRoot)
    );
    const events = readEvents(eventsPath);
    const ev = events.find(e => e.type === 'pattern_skip_enriched');
    assert.ok(ev);
    assert.equal(ev.superseded_by, 'the-other-pattern');
  });

  test('event skip_reason falls back to note when skip_reason is absent', async () => {
    const { projectRoot, eventsPath } = makeProjectRoot();
    // Provide note but not skip_reason
    const input = validInput({ note: 'legacy prose note' });
    delete input.skip_reason;
    await handle(input, makeContext(projectRoot));
    const events = readEvents(eventsPath);
    const ev = events.find(e => e.type === 'pattern_skip_enriched');
    assert.ok(ev);
    assert.equal(ev.skip_reason, 'legacy prose note', 'skip_reason should fall back to note');
  });

  test('no event written on validation error', async () => {
    const { projectRoot, eventsPath } = makeProjectRoot();
    await handle(validInput({ skip_category: 'not-valid' }), makeContext(projectRoot));
    const events = readEvents(eventsPath);
    const skipEvents = events.filter(e => e.type === 'pattern_skip_enriched');
    assert.equal(skipEvents.length, 0, 'no event must be written when input is invalid');
  });

});

// ---------------------------------------------------------------------------
// forgotten rate warning
// ---------------------------------------------------------------------------

describe('forgotten rate > 30% triggers stderr warning', () => {

  /**
   * Helper: write N pre-existing pattern_skip_enriched events to events.jsonl.
   * forgottenCount of them will have skip_category: forgotten.
   */
  function preSeedSkipEvents(eventsPath, orchId, total, forgottenCount) {
    const lines = [];
    for (let i = 0; i < total; i++) {
      const cat = i < forgottenCount ? 'forgotten' : 'contextual-mismatch';
      lines.push(JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'pattern_skip_enriched',
        orchestration_id: orchId,
        pattern_name: 'pattern-' + i,
        match_quality: 'strong-match',
        skip_category: cat,
        skip_reason: 'pre-seeded',
      }));
    }
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n');
  }

  test('forgotten rate > 30%: stderr warning fired when 8 of 10 recent are forgotten', async () => {
    const orchId = 'orch-forgotten-rate-001';
    const { projectRoot, eventsPath } = makeProjectRoot();

    // Pre-seed 9 events: 8 forgotten, 1 contextual-mismatch (within window of 25)
    // After the 10th call below (also forgotten), rate = 9/10 = 90% > 30%
    preSeedSkipEvents(eventsPath, orchId, 9, 8);

    // Capture stderr
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };

    try {
      await handle(
        validInput({
          orchestration_id: orchId,
          skip_category: 'forgotten',
          reason: 'other',
          note: 'pattern seen but not weighed',
        }),
        makeContext(projectRoot)
      );
    } finally {
      process.stderr.write = origWrite;
    }

    const allStderr = stderrLines.join('');
    assert.ok(
      allStderr.includes('forgotten'),
      'stderr must mention "forgotten"; got: ' + allStderr
    );
    assert.ok(
      allStderr.includes('pattern skip enrichment'),
      'stderr must include "pattern skip enrichment" prefix; got: ' + allStderr
    );
    assert.ok(
      allStderr.includes('consider explicit categorisation'),
      'stderr must include the suggestion; got: ' + allStderr
    );
  });

  test('forgotten rate <= 30%: no stderr warning when only 2 of 10 are forgotten', async () => {
    const orchId = 'orch-forgotten-rate-002';
    const { projectRoot, eventsPath } = makeProjectRoot();

    // Pre-seed 9 events: 1 forgotten, 8 contextual-mismatch
    preSeedSkipEvents(eventsPath, orchId, 9, 1);

    // The 10th call is also forgotten → 2/10 = 20% <= 30%, no warning expected
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };

    try {
      await handle(
        validInput({
          orchestration_id: orchId,
          skip_category: 'forgotten',
          reason: 'other',
          note: 'fallback',
        }),
        makeContext(projectRoot)
      );
    } finally {
      process.stderr.write = origWrite;
    }

    const allStderr = stderrLines.join('');
    assert.ok(
      !allStderr.includes('consider explicit categorisation'),
      'stderr must NOT include the warning at <=30% rate; got: ' + allStderr
    );
  });

  test('no stderr warning when skip_category is not forgotten (even if other rate is high)', async () => {
    const orchId = 'orch-forgotten-rate-003';
    const { projectRoot } = makeProjectRoot();

    // Non-forgotten category must never trigger the warning
    const stderrLines = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return origWrite(chunk, ...args);
    };

    try {
      await handle(
        validInput({ orchestration_id: orchId, skip_category: 'stale' }),
        makeContext(projectRoot)
      );
    } finally {
      process.stderr.write = origWrite;
    }

    const allStderr = stderrLines.join('');
    assert.ok(
      !allStderr.includes('consider explicit categorisation'),
      'stderr must NOT include the warning for non-forgotten skip_category; got: ' + allStderr
    );
  });

});

// ---------------------------------------------------------------------------
// cited_confidence optional
// ---------------------------------------------------------------------------

describe('cited_confidence — optional field', () => {

  test('omitting cited_confidence does not break the call', async () => {
    const { projectRoot } = makeProjectRoot();
    const input = validInput();
    // Explicitly ensure it is absent
    delete input.cited_confidence;
    const result = await handle(input, makeContext(projectRoot));
    assert.equal(result.isError, false);
  });

  test('cited_confidence 0.0 accepted', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ cited_confidence: 0.0 }), makeContext(projectRoot));
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.cited_confidence, 0.0);
  });

  test('cited_confidence 1.0 accepted', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ cited_confidence: 1.0 }), makeContext(projectRoot));
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.cited_confidence, 1.0);
  });

  test('cited_confidence below 0 rejected', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ cited_confidence: -0.1 }), makeContext(projectRoot));
    assert.equal(result.isError, true);
  });

  test('cited_confidence above 1 rejected', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ cited_confidence: 1.1 }), makeContext(projectRoot));
    assert.equal(result.isError, true);
  });

});

// ---------------------------------------------------------------------------
// Backward compatibility — existing skip_reason/reason/note handling preserved
// ---------------------------------------------------------------------------

describe('backward compatibility — existing reason/note handling', () => {

  test('legacy reason enum all four values still accepted', async () => {
    const { projectRoot } = makeProjectRoot();
    for (const reason of ['all-irrelevant', 'all-low-confidence', 'all-stale']) {
      const result = await handle(validInput({ reason }), makeContext(projectRoot));
      assert.equal(result.isError, false, 'reason "' + reason + '" must be accepted');
    }
  });

  test('reason: other with note accepted (legacy path still works)', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ reason: 'other', note: 'some explanation', skip_category: 'operator-override' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.reason, 'other');
    assert.equal(body.note, 'some explanation');
  });

  test('reason: other without note still rejected (legacy validation preserved)', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(
      validInput({ reason: 'other', skip_category: 'operator-override' }),
      makeContext(projectRoot)
    );
    assert.equal(result.isError, true);
    const msg = result.content[0].text;
    assert.ok(
      msg.toLowerCase().includes('note') || msg.toLowerCase().includes('required'),
      'error must reference note requirement; got: ' + msg
    );
  });

  test('success result still includes reason and recorded:true', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput({ reason: 'all-stale' }), makeContext(projectRoot));
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.reason, 'all-stale');
    assert.equal(body.recorded, true);
    assert.equal(body.orchestration_id, 'orch-ll1-test-001');
  });

  test('structuredContent matches text content (structural contract preserved)', async () => {
    const { projectRoot } = makeProjectRoot();
    const result = await handle(validInput(), makeContext(projectRoot));
    assert.equal(result.isError, false);
    const fromText = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, fromText);
  });

  test('missing orchestration_id still rejected', async () => {
    const { projectRoot } = makeProjectRoot();
    const input = validInput();
    delete input.orchestration_id;
    const result = await handle(input, makeContext(projectRoot));
    assert.equal(result.isError, true);
  });

  test('note absent from success result when not provided (existing behavior preserved)', async () => {
    const { projectRoot } = makeProjectRoot();
    const input = validInput();
    delete input.note;
    const result = await handle(input, makeContext(projectRoot));
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.ok(!('note' in body), 'note must not appear in result when not provided');
  });

});
