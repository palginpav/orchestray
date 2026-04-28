'use strict';

/**
 * Test Event 2 (load-bearing set): every heading in DEFAULT_LOAD_BEARING_SECTIONS
 * trips the invariant when dropped; headings NOT in the list do not trip it.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { verifyLoadBearing, DEFAULT_LOAD_BEARING_SECTIONS } = require('../../../bin/_lib/tokenwright/verify-load-bearing');

// ---------------------------------------------------------------------------
// Helper: build a two-section prompt that includes a specific heading
// ---------------------------------------------------------------------------
function promptWithHeading(heading) {
  return `${heading}\n\nBody for ${heading}.\nSome substantial content goes here.\n\n## Filler\n\nFiller body.\n`;
}

function promptWithoutHeading() {
  return `## Filler\n\nFiller body only.\n`;
}

// ---------------------------------------------------------------------------
// For each DEFAULT_LOAD_BEARING_SECTIONS heading: dropping it triggers violation
// ---------------------------------------------------------------------------
for (const heading of DEFAULT_LOAD_BEARING_SECTIONS) {
  test(`Event2-load-bearing-set: dropping "${heading}" triggers invariant violation`, () => {
    const originalPrompt   = promptWithHeading(heading);
    const compressedPrompt = promptWithoutHeading();  // heading absent

    const result = verifyLoadBearing({
      originalPrompt,
      compressedPrompt,
      loadBearingSet: [heading],
    });

    assert.equal(result.violated, true,
      `dropping "${heading}" must trigger a violation`);
    assert.equal(result.violatedSection, heading,
      `violatedSection must be "${heading}"`);
  });
}

// ---------------------------------------------------------------------------
// A heading NOT in the load-bearing set does not trip the invariant
// ---------------------------------------------------------------------------
test('Event2-load-bearing-set: non-load-bearing heading dropped does not violate', () => {
  const nonProtectedHeading = '## Prior Findings';
  const originalPrompt   = `${nonProtectedHeading}\n\nSome findings body.\n`;
  const compressedPrompt = '## Other\n\nOther body.\n';

  // Explicitly exclude the non-protected heading from the load-bearing set
  const loadBearingSet = DEFAULT_LOAD_BEARING_SECTIONS.filter(h => h !== nonProtectedHeading);

  const result = verifyLoadBearing({
    originalPrompt,
    compressedPrompt,
    loadBearingSet,
  });

  // The dropped section is not in the load-bearing set, so no violation
  assert.equal(result.violated, false,
    'dropping a non-load-bearing section must not trigger a violation');
});
