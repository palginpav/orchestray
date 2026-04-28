'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  classifySection,
  BLOCK_A_SENTINEL,
  DEFAULT_PRESERVE_HEADINGS,
  DEDUP_ELIGIBLE_HEADINGS,
  SCORE_ELIGIBLE_HEADINGS,
} = require(path.join(__dirname, '../../bin/_lib/tokenwright/classify-section.js'));

// Helper to build a minimal section object.
function makeSection(heading, body) {
  return { heading, body: body || 'Some body content here.\n', raw: '' };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('classifySection: throws TypeError on null section', () => {
  assert.throws(() => classifySection(null), { name: 'TypeError' });
});

test('classifySection: throws TypeError when body is not a string', () => {
  assert.throws(() => classifySection({ heading: '## Foo', body: 42, raw: '' }), { name: 'TypeError' });
});

// ---------------------------------------------------------------------------
// Null heading (preamble) — always preserve
// ---------------------------------------------------------------------------

test('classifySection: null heading returns preserve', () => {
  const result = classifySection(makeSection(null));
  assert.equal(result.kind, 'preserve');
  assert.equal(result.heading, null);
});

test('classifySection: null heading with empty body returns preserve', () => {
  const result = classifySection({ heading: null, body: '', raw: '' });
  assert.equal(result.kind, 'preserve');
});

// ---------------------------------------------------------------------------
// DEFAULT_PRESERVE_HEADINGS — all must classify as preserve
// ---------------------------------------------------------------------------

test('classifySection: "## Acceptance Rubric" → preserve', () => {
  const result = classifySection(makeSection('## Acceptance Rubric'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Structured Result" → preserve', () => {
  const result = classifySection(makeSection('## Structured Result'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Output Style" → preserve', () => {
  const result = classifySection(makeSection('## Output Style'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Repository Map" → preserve', () => {
  const result = classifySection(makeSection('## Repository Map'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Repository Map (unchanged this orchestration)" → preserve', () => {
  const result = classifySection(makeSection('## Repository Map (unchanged this orchestration)'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Repo Map (Aider-style, top-K symbols)" → preserve', () => {
  const result = classifySection(makeSection('## Repo Map (Aider-style, top-K symbols)'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Project Persona" → preserve', () => {
  const result = classifySection(makeSection('## Project Persona'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Project Intent" → preserve', () => {
  const result = classifySection(makeSection('## Project Intent'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: "## Context from Previous Agent" → preserve', () => {
  const result = classifySection(makeSection('## Context from Previous Agent'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: every heading in DEFAULT_PRESERVE_HEADINGS classifies as preserve', () => {
  for (const heading of DEFAULT_PRESERVE_HEADINGS) {
    const result = classifySection(makeSection(heading));
    assert.equal(
      result.kind,
      'preserve',
      `Expected preserve for "${heading}" but got "${result.kind}"`
    );
  }
});

// ---------------------------------------------------------------------------
// DEDUP_ELIGIBLE_HEADINGS
// ---------------------------------------------------------------------------

test('classifySection: "## Prior Reviewer Findings" → dedup-eligible', () => {
  const result = classifySection(makeSection('## Prior Reviewer Findings'));
  assert.equal(result.kind, 'dedup-eligible');
});

test('classifySection: "## Prior Findings" → dedup-eligible', () => {
  const result = classifySection(makeSection('## Prior Findings'));
  assert.equal(result.kind, 'dedup-eligible');
});

test('classifySection: "## Audit Round Findings" → dedup-eligible', () => {
  const result = classifySection(makeSection('## Audit Round Findings'));
  assert.equal(result.kind, 'dedup-eligible');
});

test('classifySection: "## Knowledge Base References" → dedup-eligible', () => {
  const result = classifySection(makeSection('## Knowledge Base References'));
  assert.equal(result.kind, 'dedup-eligible');
});

test('classifySection: "## KB References" → dedup-eligible', () => {
  const result = classifySection(makeSection('## KB References'));
  assert.equal(result.kind, 'dedup-eligible');
});

test('classifySection: every heading in DEDUP_ELIGIBLE_HEADINGS classifies as dedup-eligible', () => {
  for (const heading of DEDUP_ELIGIBLE_HEADINGS) {
    const result = classifySection(makeSection(heading));
    assert.equal(
      result.kind,
      'dedup-eligible',
      `Expected dedup-eligible for "${heading}" but got "${result.kind}"`
    );
  }
});

// ---------------------------------------------------------------------------
// SCORE_ELIGIBLE_HEADINGS
// ---------------------------------------------------------------------------

test('classifySection: "## Task Description" → score-eligible', () => {
  const result = classifySection(makeSection('## Task Description'));
  assert.equal(result.kind, 'score-eligible');
});

test('classifySection: "## Context Paragraph" → score-eligible', () => {
  const result = classifySection(makeSection('## Context Paragraph'));
  assert.equal(result.kind, 'score-eligible');
});

test('classifySection: "## Prior Agent Summary" → score-eligible', () => {
  const result = classifySection(makeSection('## Prior Agent Summary'));
  assert.equal(result.kind, 'score-eligible');
});

test('classifySection: every heading in SCORE_ELIGIBLE_HEADINGS classifies as score-eligible', () => {
  for (const heading of SCORE_ELIGIBLE_HEADINGS) {
    const result = classifySection(makeSection(heading));
    assert.equal(
      result.kind,
      'score-eligible',
      `Expected score-eligible for "${heading}" but got "${result.kind}"`
    );
  }
});

// ---------------------------------------------------------------------------
// Default-safe: unknown heading → preserve
// ---------------------------------------------------------------------------

test('classifySection: unknown heading "## Random Notes" → preserve (default-safe)', () => {
  const result = classifySection(makeSection('## Random Notes'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: unknown heading "## Some Arbitrary Section" → preserve', () => {
  const result = classifySection(makeSection('## Some Arbitrary Section'));
  assert.equal(result.kind, 'preserve');
});

test('classifySection: unknown heading "## Totally Made Up" → preserve (never compress unknown)', () => {
  const result = classifySection(makeSection('## Totally Made Up'));
  assert.equal(result.kind, 'preserve');
});

// ---------------------------------------------------------------------------
// Block-A sentinel: force-classify as preserve regardless of heading
// ---------------------------------------------------------------------------

test('classifySection: body containing BLOCK_A_SENTINEL → preserve even if heading is null', () => {
  const body = `Some preamble content.\n${BLOCK_A_SENTINEL}\nMore content.\n`;
  const result = classifySection({ heading: null, body, raw: '' });
  assert.equal(result.kind, 'preserve');
});

test('classifySection: Block-A sentinel in body overrides dedup-eligible heading → preserve', () => {
  // "## Prior Reviewer Findings" would normally be dedup-eligible, but the
  // sentinel in the body must win — this tests that the sentinel check
  // runs before the heading lookup.
  const body = `${BLOCK_A_SENTINEL}\nSome findings here.\n`;
  const result = classifySection({ heading: '## Prior Reviewer Findings', body, raw: '' });
  assert.equal(
    result.kind,
    'preserve',
    'Block-A sentinel must force preserve even on dedup-eligible heading'
  );
});

test('classifySection: Block-A sentinel in body overrides score-eligible heading → preserve', () => {
  const body = `Task description.\n${BLOCK_A_SENTINEL}\n`;
  const result = classifySection({ heading: '## Task Description', body, raw: '' });
  assert.equal(result.kind, 'preserve');
});

test('classifySection: Block-A sentinel in body overrides unknown heading → preserve', () => {
  const body = `Content.\n${BLOCK_A_SENTINEL}\n`;
  const result = classifySection({ heading: '## Some Unknown Section', body, raw: '' });
  assert.equal(result.kind, 'preserve');
});

test('classifySection: section without sentinel in body but normally dedup-eligible stays dedup-eligible', () => {
  // Sanity check: sentinel only fires when it actually appears in the body.
  const result = classifySection(makeSection('## Prior Reviewer Findings'));
  assert.equal(result.kind, 'dedup-eligible');
});

// ---------------------------------------------------------------------------
// opts.preserveExtra
// ---------------------------------------------------------------------------

test('classifySection: opts.preserveExtra adds heading to preserve set', () => {
  const result = classifySection(
    makeSection('## Custom Section'),
    { preserveExtra: ['## Custom Section'] }
  );
  assert.equal(result.kind, 'preserve');
});

test('classifySection: opts.preserveExtra with multiple headings all get preserve', () => {
  const extras = ['## Custom Section A', '## Custom Section B', '## My Special Notes'];
  for (const heading of extras) {
    const result = classifySection(makeSection(heading), { preserveExtra: extras });
    assert.equal(result.kind, 'preserve', `${heading} should be preserve via preserveExtra`);
  }
});

test('classifySection: opts.preserveExtra does not affect classification of other headings', () => {
  // dedup-eligible heading stays dedup-eligible even when extras are provided
  const result = classifySection(
    makeSection('## Prior Reviewer Findings'),
    { preserveExtra: ['## Custom Section'] }
  );
  assert.equal(result.kind, 'dedup-eligible');
});

test('classifySection: opts.preserveExtra of non-array is ignored gracefully', () => {
  // Passing preserveExtra: 'not-an-array' should not crash; unknown heading → preserve
  const result = classifySection(
    makeSection('## Some Section'),
    { preserveExtra: 'not-an-array' }
  );
  assert.equal(result.kind, 'preserve');
});

// ---------------------------------------------------------------------------
// Return value shape
// ---------------------------------------------------------------------------

test('classifySection: return value always contains kind and heading fields', () => {
  const result = classifySection(makeSection('## Acceptance Rubric'));
  assert.ok('kind' in result, 'result must have kind field');
  assert.ok('heading' in result, 'result must have heading field');
  assert.equal(result.heading, '## Acceptance Rubric');
});

test('classifySection: heading in return value matches input heading exactly', () => {
  const heading = '## Prior Reviewer Findings';
  const result = classifySection(makeSection(heading));
  assert.equal(result.heading, heading);
});
