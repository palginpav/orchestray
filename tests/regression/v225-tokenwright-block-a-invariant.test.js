'use strict';

/**
 * Regression: Block-A sentinel region must be byte-identical pre/post pipeline.
 *
 * Invariant: every byte from index 0 up to and including the sentinel string
 * itself must survive the full parse→classify→dedup→reassemble pipeline
 * unchanged for any fixture and any combination of sections.
 *
 * Reference: design doc §R1 mitigation, llmlingua-analog-design.v222.md C10.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSections, reassembleSections } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/parse-sections.js')
);
const { classifySection, BLOCK_A_SENTINEL } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/classify-section.js')
);
const { applyMinHashDedup } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/dedup-minhash.js')
);

/**
 * Run the full compression pipeline at the 'safe' policy (MinHash dedup only)
 * and return the reassembled output string.
 */
function runPipeline(input) {
  const sections = parseSections(input);
  const classified = sections.map(s => ({
    ...s,
    ...classifySection(s),
  }));
  applyMinHashDedup(classified);
  return reassembleSections(classified);
}

/**
 * Assert that every byte from 0..sentinelEnd (inclusive) in `output`
 * is identical to the same range in `input`.
 */
function assertBlockAByteIdentical(input, output) {
  const sentinelEnd = input.indexOf(BLOCK_A_SENTINEL) + BLOCK_A_SENTINEL.length;
  assert.ok(sentinelEnd > BLOCK_A_SENTINEL.length - 1, 'sentinel must be in input');
  const inputPrefix = input.slice(0, sentinelEnd);
  const outputPrefix = output.slice(0, sentinelEnd);
  assert.equal(
    outputPrefix,
    inputPrefix,
    `Block-A prefix (0..${sentinelEnd}) must be byte-identical in output`
  );
}

// ---------------------------------------------------------------------------
// Fixture 1: No Block A — pipeline runs normally; output is subset of input
// ---------------------------------------------------------------------------

test('Block-A invariant: no Block-A in fixture — pipeline runs without error', () => {
  const input = [
    'Preamble content without any sentinel.',
    '',
    '## Prior Reviewer Findings',
    'Findings from round one. Issue 1: config validation missing.',
    'Issue 2: missing auth check in admin endpoint.',
    '',
    '## Prior Reviewer Findings',
    'Findings from round one. Issue 1: config validation missing.',
    'Issue 2: missing auth check in admin endpoint.',
    '',
    '## Acceptance Rubric',
    '- verify output format',
    '- verify no hallucinated headings',
    '',
  ].join('\n');

  const output = runPipeline(input);
  // No Block A — just assert output doesn't crash and is non-empty.
  assert.ok(typeof output === 'string');
  assert.ok(output.length > 0);
  // Preserve section must still be in output.
  assert.ok(output.includes('## Acceptance Rubric'), 'preserve section must survive');
});

// ---------------------------------------------------------------------------
// Fixture 2: Block A present — prefix up to sentinel is byte-identical
// ---------------------------------------------------------------------------

test('Block-A invariant: simple Block-A fixture — prefix bytes are identical', () => {
  const blockA = [
    'System prompt preamble line one.',
    'System prompt preamble line two.',
    'This is the Block-A region that must not be mutated.',
    BLOCK_A_SENTINEL,
    '',
  ].join('\n');

  const input = blockA + [
    '## Some Heading',
    'Section body content after Block A.',
    '',
    '## Prior Reviewer Findings',
    'Findings that might be deduped.',
    '',
  ].join('\n');

  const output = runPipeline(input);
  assertBlockAByteIdentical(input, output);
});

// ---------------------------------------------------------------------------
// Fixture 3: Block A + duplicate-heavy body — Block A preserved, duplicates dropped
// ---------------------------------------------------------------------------

test('Block-A invariant: Block-A with duplicate sections — sentinel prefix intact and duplicates dropped', () => {
  const blockA = [
    'PM preamble: orchestration id oxabc123.',
    'Phase: implementation.',
    'Spawning developer agent.',
    BLOCK_A_SENTINEL,
    '',
  ].join('\n');

  const findingsBody = [
    'Prior reviewer findings from round 2.',
    'Finding A: the route handler does not validate input length.',
    'Finding B: the session token is stored in localStorage without expiry.',
    'Finding C: error messages expose internal stack traces to the browser.',
    'All findings require developer attention before release.',
  ].join('\n');

  const input = blockA + [
    '## Prior Reviewer Findings',
    findingsBody,
    '',
    '## Prior Findings',
    findingsBody, // near-identical duplicate
    '',
    '## Acceptance Rubric',
    '- verify structured result format',
    '- verify no hallucinated sections',
    '',
  ].join('\n');

  const output = runPipeline(input);

  // Block A prefix must be byte-identical.
  assertBlockAByteIdentical(input, output);

  // The preserve section must still be in output.
  assert.ok(output.includes('## Acceptance Rubric'), 'Acceptance Rubric must survive');

  // Output should be shorter than input (one duplicate dropped).
  assert.ok(output.length < input.length, 'duplicate sections should have been dropped');
});

// ---------------------------------------------------------------------------
// Fixture 4: Block A inside a section whose heading would be dedup-eligible
//            — sentinel wins, section is preserved
// ---------------------------------------------------------------------------

test('Block-A invariant: sentinel inside normally dedup-eligible section heading preserves that section', () => {
  // The sentinel can land inside a section that would otherwise be classified
  // as dedup-eligible. The sentinel must force-preserve it.
  const input = [
    '## Prior Reviewer Findings',
    'Preamble content before the sentinel.',
    BLOCK_A_SENTINEL,
    'Content after the sentinel within the same section.',
    '',
    '## Prior Findings',
    'Some other findings that should also be preserved (since above is preserved).',
    '',
  ].join('\n');

  const output = runPipeline(input);

  // The section containing the sentinel must be present in output.
  assert.ok(
    output.includes(BLOCK_A_SENTINEL),
    'sentinel must appear in output when it is inside a section'
  );

  // Block A prefix intact (sentinel is in first section body).
  assertBlockAByteIdentical(input, output);
});

// ---------------------------------------------------------------------------
// Fixture 5: Empty input — no crash
// ---------------------------------------------------------------------------

test('Block-A invariant: empty input does not crash', () => {
  const output = runPipeline('');
  assert.equal(output, '');
});
