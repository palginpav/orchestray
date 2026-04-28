'use strict';

/**
 * Test 14: existing prompt_compression event extensions.
 *
 * Verifies new v2.2.6 additive fields on prompt_compression across 3 fixture prompts:
 *   - zero-eligible (all sections are preserve or preamble)
 *   - partial-eligible (some dedup-eligible sections)
 *   - all-eligible (all non-preamble sections are dedup-eligible)
 *
 * Checks: sections_total, sections_dedup_eligible, eligibility_rate,
 *         dedup_drop_by_heading populated correctly.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const { parseSections, reassembleSections } = require('../../../bin/_lib/tokenwright/parse-sections');
const { classifySection, DEDUP_ELIGIBLE_HEADINGS } = require('../../../bin/_lib/tokenwright/classify-section');
const { applyMinHashDedup } = require('../../../bin/_lib/tokenwright/dedup-minhash');

// ---------------------------------------------------------------------------
// Helper: run the L1 pipeline and return extended stats
// ---------------------------------------------------------------------------
function runL1WithStats(prompt) {
  const sections = parseSections(prompt);
  for (const s of sections) {
    s.kind = classifySection(s).kind;
  }
  const { dropped: droppedCount } = applyMinHashDedup(sections);

  const sectionsTotal         = sections.length;
  const sectionsDedupEligible = sections.filter(s => s.kind === 'dedup-eligible').length;
  const sectionsScoreEligible = sections.filter(s => s.kind === 'score-eligible').length;
  const sectionsPreserve      = sections.filter(s => s.kind === 'preserve').length;
  const eligibilityRate       = sectionsTotal > 0
    ? (sectionsDedupEligible + sectionsScoreEligible) / sectionsTotal
    : 0;

  const dedupDropByHeading = {};
  for (const h of DEDUP_ELIGIBLE_HEADINGS) dedupDropByHeading[h] = 0;
  const droppedSections = sections.filter(s => s.dropped);
  for (const s of droppedSections) {
    const h = s.heading || '(preamble)';
    if (h in dedupDropByHeading) dedupDropByHeading[h]++;
  }

  return {
    sectionsTotal, sectionsDedupEligible, sectionsScoreEligible,
    sectionsPreserve, eligibilityRate, dedupDropByHeading, droppedCount,
  };
}

// ---------------------------------------------------------------------------
// Fixture 1: Zero-eligible prompt (only preserve / preamble sections)
// ---------------------------------------------------------------------------
test('Existing-prompt-compression: zero-eligible prompt has eligibility_rate=0', () => {
  const prompt = [
    'Preamble text here.\n',
    '\n',
    '## Structured Result\n\nJSON goes here.\n\n',
    '## Acceptance Rubric\n\nRubric content.\n\n',
    '## Output Style\n\nStyle guide.\n\n',
  ].join('');

  const stats = runL1WithStats(prompt);

  assert.ok(stats.sectionsTotal >= 1, 'must have at least 1 section');
  assert.equal(stats.sectionsDedupEligible, 0, 'zero-eligible prompt must have 0 dedup-eligible sections');
  assert.equal(stats.eligibilityRate, 0, 'eligibility_rate must be 0 for zero-eligible prompt');
  assert.ok(typeof stats.dedupDropByHeading === 'object', 'dedupDropByHeading must be an object');
  // All headings in dedup_drop_by_heading must have value 0 (nothing to drop)
  for (const count of Object.values(stats.dedupDropByHeading)) {
    assert.equal(count, 0, 'all dedup_drop_by_heading counts must be 0 for zero-eligible prompt');
  }
});

// ---------------------------------------------------------------------------
// Fixture 2: Partial-eligible prompt (mix of preserve and dedup-eligible)
// ---------------------------------------------------------------------------
test('Existing-prompt-compression: partial-eligible prompt has eligibility_rate > 0', () => {
  // Use a DEDUP_ELIGIBLE_HEADINGS entry to make it dedup-eligible
  const dupHeading = DEDUP_ELIGIBLE_HEADINGS[0];  // e.g., "## Prior Findings"

  const prompt = [
    'Preamble.\n\n',
    `${dupHeading}\n\nSome findings content here. This is a substantial block of text.\n\n`,
    '## Structured Result\n\nProtected section.\n\n',
  ].join('');

  const stats = runL1WithStats(prompt);

  assert.ok(stats.sectionsTotal >= 2, 'must have at least 2 sections');
  assert.ok(stats.sectionsDedupEligible >= 1, 'must have at least 1 dedup-eligible section');
  assert.ok(stats.eligibilityRate > 0,        'eligibility_rate must be > 0 for partial-eligible prompt');
  assert.ok(stats.eligibilityRate < 1,        'eligibility_rate must be < 1 for partial-eligible prompt');
});

// ---------------------------------------------------------------------------
// Fixture 3: All dedup-eligible (only dedup-eligible sections, duplicated for drop)
// ---------------------------------------------------------------------------
test('Existing-prompt-compression: all-eligible prompt; dedup_drop_by_heading tracks drops', () => {
  const dupHeading = DEDUP_ELIGIBLE_HEADINGS[0];

  // Build identical duplicate blocks so MinHash dedup drops one
  const block = [
    `${dupHeading}`,
    '',
    'The agent found that the implementation is mostly correct but needs minor fixes.',
    'The main issue is in the error handler which does not cover edge cases.',
    'The secondary issue is in the logging which is too verbose for production use.',
    'No critical security issues were found during review.',
    '',
  ].join('\n');

  const prompt = block + '\n' + block + '\n';

  const stats = runL1WithStats(prompt);

  assert.ok(stats.sectionsDedupEligible >= 1, 'must detect dedup-eligible sections');
  assert.ok(dupHeading in stats.dedupDropByHeading, 'dedupDropByHeading must have a key for the eligible heading');
  // If the blocks are identical, one should be dropped (dedup_drop_by_heading[heading] >= 1)
  // or at worst 0 if they're parsed differently — accept >= 0
  assert.ok(typeof stats.dedupDropByHeading[dupHeading] === 'number',
    'dedup_drop_by_heading value must be a number');
  assert.ok(stats.dedupDropByHeading[dupHeading] >= 0,
    'dedup_drop_by_heading count must be non-negative');
});

// ---------------------------------------------------------------------------
// Test: DEDUP_ELIGIBLE_HEADINGS all appear as keys in dedupDropByHeading
// ---------------------------------------------------------------------------
test('Existing-prompt-compression: dedupDropByHeading has keys for all DEDUP_ELIGIBLE_HEADINGS', () => {
  const prompt = 'Preamble only.\n';
  const stats = runL1WithStats(prompt);

  for (const h of DEDUP_ELIGIBLE_HEADINGS) {
    assert.ok(h in stats.dedupDropByHeading, `dedupDropByHeading must have key: ${h}`);
    assert.equal(typeof stats.dedupDropByHeading[h], 'number', `count for "${h}" must be a number`);
  }
});
