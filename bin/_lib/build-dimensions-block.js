'use strict';

/**
 * build-dimensions-block.js — shared renderer (v2.3.31 W8B).
 *
 * Extracted from the now-retired bin/inject-review-dimensions.js. Renders the
 * `## Dimensions to Apply` markdown block, byte-identical to the format
 * documented in agents/pm-reference/delegation-templates.md.
 */

const FRAGMENT_LEGEND =
  '- code-quality   → agents/reviewer-dimensions/code-quality.md\n' +
  '- performance    → agents/reviewer-dimensions/performance.md\n' +
  '- documentation  → agents/reviewer-dimensions/documentation.md\n' +
  '- operability    → agents/reviewer-dimensions/operability.md\n' +
  '- api-compat     → agents/reviewer-dimensions/api-compat.md';

/**
 * Build the `## Dimensions to Apply` block.
 *
 * @param {"all"|string[]} review_dimensions
 * @returns {string}
 */
function buildDimensionsBlock(review_dimensions) {
  if (review_dimensions === 'all') {
    return (
      '\n\n## Dimensions to Apply\n\n' +
      'all\n\n' +
      'For each item, Read the matching fragment file BEFORE forming findings:\n' +
      FRAGMENT_LEGEND + '\n\n' +
      'Read all five files. Correctness and Security are always reviewed and live in your core prompt — do NOT request fragment files for them.'
    );
  }

  const bulletList = review_dimensions.map((d) => '- ' + d).join('\n');
  return (
    '\n\n## Dimensions to Apply\n\n' +
    bulletList + '\n\n' +
    'For each item above, Read the matching fragment file BEFORE forming findings:\n' +
    FRAGMENT_LEGEND + '\n\n' +
    'Correctness and Security are always reviewed and live in your core prompt — do NOT request fragment files for them.'
  );
}

module.exports = { buildDimensionsBlock, FRAGMENT_LEGEND };
