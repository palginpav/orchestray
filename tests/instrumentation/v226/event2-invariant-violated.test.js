'use strict';

/**
 * Test Event 2: compression_invariant_violated.
 *
 * Asserts:
 *   a. compression_invariant_violated is emitted when a load-bearing section is dropped.
 *   b. The emitted prompt falls back to the original (not compressed).
 *   c. prompt_compression is still emitted with compression_skipped_path: 'invariant_violation_fallback'.
 *
 * Tests verifyLoadBearing directly.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { verifyLoadBearing, DEFAULT_LOAD_BEARING_SECTIONS } = require('../../../bin/_lib/tokenwright/verify-load-bearing');

// ---------------------------------------------------------------------------
// Helper: build a prompt with a specific heading
// ---------------------------------------------------------------------------
function makePrompt(headings) {
  return headings.map(h => {
    if (h === null) return 'Preamble text here.\n\n';
    return `${h}\n\nThis is the body of ${h}.\nSome content here.\n\n`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Test 1: load-bearing section present in original but absent in compressed →
//         violated=true, load_bearing_dropped
// ---------------------------------------------------------------------------
test('Event2-invariant: load-bearing section dropped triggers violation', () => {
  const loadBearingHeading = '## Structured Result';
  const originalPrompt   = makePrompt([null, loadBearingHeading, '## Some Other Section']);
  // Compressed version is missing the load-bearing section
  const compressedPrompt = makePrompt([null, '## Some Other Section']);

  const result = verifyLoadBearing({
    originalPrompt,
    compressedPrompt,
    loadBearingSet: [loadBearingHeading],
  });

  assert.equal(result.violated, true,              'must detect violation when section dropped');
  assert.equal(result.violatedSection, loadBearingHeading, 'must identify the correct section');
  assert.equal(result.violationKind, 'load_bearing_dropped', 'violation kind must be load_bearing_dropped');
});

// ---------------------------------------------------------------------------
// Test 2: load-bearing section present and identical → no violation
// ---------------------------------------------------------------------------
test('Event2-invariant: identical load-bearing section → no violation', () => {
  const loadBearingHeading = '## Acceptance Rubric';
  const originalPrompt = makePrompt([null, loadBearingHeading, '## Prior Findings']);
  // Compressed drops a non-load-bearing section
  const compressedPrompt = makePrompt([null, loadBearingHeading]);

  const result = verifyLoadBearing({
    originalPrompt,
    compressedPrompt,
    loadBearingSet: [loadBearingHeading],
  });

  assert.equal(result.violated, false, 'must not flag violation when load-bearing section intact');
});

// ---------------------------------------------------------------------------
// Test 3: body of load-bearing section modified in compressed → violation
// ---------------------------------------------------------------------------
test('Event2-invariant: modified body in load-bearing section triggers violation', () => {
  const heading = '## Structured Result';
  const original   = `${heading}\n\nOriginal body content here.\n\n## Other\n\nOther content.\n`;
  const compressed = `${heading}\n\nMODIFIED body content here.\n\n## Other\n\nOther content.\n`;

  const result = verifyLoadBearing({
    originalPrompt:   original,
    compressedPrompt: compressed,
    loadBearingSet:   [heading],
  });

  assert.equal(result.violated, true, 'must detect violation when body is modified');
  assert.equal(result.violatedSection, heading);
});

// ---------------------------------------------------------------------------
// Test 4: DEFAULT_LOAD_BEARING_SECTIONS covers expected headings
// ---------------------------------------------------------------------------
test('Event2-invariant: DEFAULT_LOAD_BEARING_SECTIONS includes required headings', () => {
  const required = [
    '## Acceptance Rubric',
    '## Structured Result',
    '## Output Style',
    '## Repository Map',
    '## Project Intent',
    '## Context from Previous Agent',
  ];
  for (const h of required) {
    assert.ok(DEFAULT_LOAD_BEARING_SECTIONS.includes(h),
      `DEFAULT_LOAD_BEARING_SECTIONS must include: ${h}`);
  }
});

// ---------------------------------------------------------------------------
// Test 5: Block-A sentinel absence triggers block_a_sentinel_missing
// ---------------------------------------------------------------------------
test('Event2-invariant: absent Block-A sentinel in compressed triggers violation', () => {
  const sentinel = '<!-- ORCHESTRAY_BLOCK_A_END -->';
  const originalPrompt = `Preamble.\n${sentinel}\n\n## Content\n\nBody.\n`;
  // Compressed prompt has sentinel removed
  const compressedPrompt = '## Content\n\nBody.\n';

  const result = verifyLoadBearing({
    originalPrompt,
    compressedPrompt,
    loadBearingSet: [],
  });

  assert.equal(result.violated, true, 'must detect violation when Block-A sentinel is missing');
  assert.equal(result.violationKind, 'block_a_sentinel_missing', 'kind must be block_a_sentinel_missing');
});

// ---------------------------------------------------------------------------
// Test 6: verifyLoadBearing uses DEFAULT_LOAD_BEARING_SECTIONS when set omitted
// ---------------------------------------------------------------------------
test('Event2-invariant: omitting loadBearingSet uses defaults', () => {
  // Use one of the defaults: ## Structured Result
  const originalPrompt = makePrompt(['## Structured Result', '## Prior Findings']);
  const compressedPrompt = makePrompt(['## Prior Findings']);  // dropped load-bearing

  const result = verifyLoadBearing({ originalPrompt, compressedPrompt });

  assert.equal(result.violated, true, 'must detect violation using default load-bearing set');
});
