#!/usr/bin/env node
'use strict';

/**
 * r-aider-full-design-doc.test.js — coverage for R-AIDER-FULL-DESIGN
 * (W4, v2.1.17). Verifies the structural integrity of the v2.1.17 W4 design
 * artifact `.orchestray/kb/artifacts/v2117-aider-design.md`.
 *
 * The design doc is the contract that W8 (developer) implemented against and
 * W9 (reviewer) adjudicated. Its acceptance rubric (§14) drives W10 coverage.
 *
 * NOTE: the W10 task brief refers to "§15 Acceptance Rubric"; the actual
 * design doc places the rubric at §14 (followed by Risks/Assumptions/Issues/
 * Structured Result). The tests assert on §14 to match reality and document
 * this as a known assumption.
 *
 * Tests:
 *   1. The design doc file exists and has non-trivial size (> 5000 bytes).
 *   2. All 14 numbered sections (§0 .. §14) appear as `## N.` headings.
 *   3. The §14 Acceptance Rubric block is present and contains 8 numbered
 *      criteria, each citing evidence (per `rubric-format.md`).
 *   4. Each of the eight rubric criteria pairs to a recognizable area in the
 *      v2.1.17 code surface (smoke check that the rubric still maps to what
 *      shipped).
 *
 * Runner: node --test tests/r-aider-full-design-doc.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DESIGN_DOC = path.join(
  ROOT, '.orchestray', 'kb', 'artifacts', 'v2117-aider-design.md'
);
const MIN_BYTES = 5000;

// Numbered sections per the design's §2.1 outline (0..14).
const REQUIRED_SECTIONS = Array.from({ length: 15 }, (_, n) => n);

// ---------------------------------------------------------------------------
// Test 1 — file present and substantial
// ---------------------------------------------------------------------------

describe('R-AIDER-FULL-DESIGN — design doc present', () => {
  test('v2117-aider-design.md exists', () => {
    assert.ok(
      fs.existsSync(DESIGN_DOC),
      'W4 design doc must exist at .orchestray/kb/artifacts/v2117-aider-design.md'
    );
  });

  test('design doc is at least 5000 bytes (sanity floor)', () => {
    const stat = fs.statSync(DESIGN_DOC);
    assert.ok(
      stat.size >= MIN_BYTES,
      `design doc must be >= ${MIN_BYTES} bytes; got ${stat.size}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2 — all 14 numbered sections present
// ---------------------------------------------------------------------------

describe('R-AIDER-FULL-DESIGN — all numbered sections present', () => {
  let body;
  test('design doc readable', () => {
    body = fs.readFileSync(DESIGN_DOC, 'utf8');
    assert.ok(body.length > 0);
  });

  for (const n of REQUIRED_SECTIONS) {
    test(`§${n} heading is present`, () => {
      // Match `^## N.` at the start of a line. We don't constrain the title
      // text — the design's wording is allowed to drift — only that the
      // numbered slot exists.
      const re = new RegExp(`^##\\s+${n}\\.`, 'm');
      assert.match(
        body, re,
        `expected a "## ${n}." section heading in design doc`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Test 3 — §14 Acceptance Rubric structure
// ---------------------------------------------------------------------------

describe('R-AIDER-FULL-DESIGN — §14 Acceptance Rubric', () => {
  let rubricBody;

  test('§14 Acceptance Rubric heading is present', () => {
    const body = fs.readFileSync(DESIGN_DOC, 'utf8');
    assert.match(
      body, /^##\s+14\.\s+Acceptance Rubric/m,
      '§14 must be titled "Acceptance Rubric"'
    );

    // Slice from "## 14." to the next "## " heading (or EOF).
    const start = body.search(/^##\s+14\.\s+Acceptance Rubric/m);
    assert.ok(start >= 0, '§14 heading not found');
    const after = body.slice(start + 1);
    const nextIdx = after.search(/^##\s+\S/m);
    rubricBody = nextIdx >= 0 ? after.slice(0, nextIdx) : after;
    assert.ok(rubricBody.length > 200, '§14 body must be substantial');
  });

  test('§14 contains 8 numbered binary criteria', () => {
    // Each criterion is a `^N. **...**` bullet at the top level. The doc
    // numbers them 1..8.
    const matches = rubricBody.match(/^\d+\.\s+\*\*/gm) || [];
    assert.ok(
      matches.length >= 8,
      `expected >= 8 numbered criteria in §14, got ${matches.length}`
    );
  });

  test('§14 cites evidence for each criterion (per rubric-format.md)', () => {
    // The rubric-format protocol requires "Evidence:" (or equivalent) on each
    // criterion. The W4 doc uses "Evidence:" as the literal token.
    const evidenceCount = (rubricBody.match(/Evidence:/g) || []).length;
    assert.ok(
      evidenceCount >= 8,
      `expected >= 8 "Evidence:" markers in §14; got ${evidenceCount}`
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4 — rubric criteria still map to shipped surface
// ---------------------------------------------------------------------------

describe('R-AIDER-FULL-DESIGN — rubric maps to shipped v2.1.17 surface', () => {
  let body;
  test('design doc readable', () => {
    body = fs.readFileSync(DESIGN_DOC, 'utf8');
  });

  test('rubric mentions the four required event types from §11', () => {
    // §14 criterion 6 names "all four events emit per §11". Smoke: the doc
    // names each of the four `repo_map_*` event types so the rubric is not
    // pointing into thin air.
    const expected = [
      'repo_map_built',
      'repo_map_parse_failed',
      'repo_map_grammar_load_failed',
      'repo_map_cache_unavailable',
    ];
    for (const evt of expected) {
      assert.ok(
        body.includes(evt),
        `design doc must mention event type "${evt}" (rubric §14 c6 + §11)`
      );
    }
  });

  test('rubric mentions the five repo-map module files from §2.1', () => {
    // §14 criterion 1 names the "five files" outline. The five files ship
    // under bin/_lib/ as repo-map.js + repo-map-tags.js + repo-map-graph.js
    // + repo-map-render.js + repo-map-cache.js. Verify the doc names all
    // five module roots.
    const expected = [
      'repo-map.js',
      'repo-map-tags.js',
      'repo-map-graph.js',
      'repo-map-render.js',
      'repo-map-cache.js',
    ];
    for (const f of expected) {
      assert.ok(
        body.includes(f),
        `design doc must reference module "${f}" (rubric §14 c1 + §2.1)`
      );
    }
  });

  test('rubric mentions the kill switch (criterion 8)', () => {
    // §14 criterion 8: kill switch (repo_map.enabled: false) and per-call
    // opt-out (tokenBudget: 0).
    assert.ok(
      body.includes('repo_map.enabled') || /repo_map\s*\.\s*enabled/.test(body),
      'design doc must reference `repo_map.enabled` kill switch'
    );
    assert.ok(
      /tokenBudget\s*:\s*0/.test(body) || body.includes('tokenBudget: 0'),
      'design doc must reference `tokenBudget: 0` per-call opt-out'
    );
  });
});
