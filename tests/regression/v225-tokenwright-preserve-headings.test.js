'use strict';

/**
 * Regression: every heading in DEFAULT_PRESERVE_HEADINGS (plus the two
 * repo-map variants) must be byte-identical pre/post pipeline.
 *
 * Strategy: assemble a single fixture containing ALL preserve headings plus
 * several dedup-eligible sections with repetitive content, run the full
 * pipeline, and assert that every preserve section's raw text appears
 * verbatim in the output.
 *
 * Reference: roadmap §5.3 "v22n-tokenwright-preserve-headings.test.js".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSections, reassembleSections } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/parse-sections.js')
);
const {
  classifySection,
  DEFAULT_PRESERVE_HEADINGS,
} = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/classify-section.js')
);
const { applyMinHashDedup } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/dedup-minhash.js')
);

function runPipeline(input) {
  const sections = parseSections(input);
  const classified = sections.map(s => ({ ...s, ...classifySection(s) }));
  applyMinHashDedup(classified);
  return reassembleSections(classified);
}

// ---------------------------------------------------------------------------
// Build a fixture with ALL preserve headings and intervening dedup content
// ---------------------------------------------------------------------------

// Unique bodies for each preserve section so we can assert exact text later.
const PRESERVE_BODIES = {
  '## Acceptance Rubric':
    '- Verify the output conforms to the handoff contract.\n- No hallucinated sections.\n',
  '## Structured Result':
    '```json\n{"status":"pass","summary":"all checks passed"}\n```\n',
  '## Output Style':
    'JSON only. No prose outside the structured result block.\n',
  '## Repository Map':
    'src/index.js\nsrc/config.js\nsrc/agent/pm.js\n',
  '## Repository Map (unchanged this orchestration)':
    'src/index.js (unchanged)\nsrc/config.js (unchanged)\n',
  '## Repo Map (Aider-style, top-K symbols)':
    'src/index.js\n  - orchestrate()\n  - resolveAgents()\nsrc/config.js\n  - loadConfig()\n',
  '## Project Persona':
    'You are the Orchestray PM agent.\n',
  '## Project Intent':
    'Orchestray is a multi-agent orchestration plugin for Claude Code.\n',
  '## Context from Previous Agent':
    'Architect produced design doc v3. Key decision: MinHash at k=3, threshold 0.85.\n',
};

// Dedup-eligible content that will be inserted between preserve sections.
// Use repetitive content to maximize dedup pressure.
const DEDUP_BODY = [
  'Prior reviewer findings from round 2.',
  'Issue 1: the config loader is missing validation for required fields.',
  'Issue 2: the session token is stored without expiry.',
  'Issue 3: error messages leak internal stack traces.',
  'All findings require developer remediation before release.',
].join('\n') + '\n';

function buildFixture() {
  const parts = ['Preamble: task summary for the developer agent.\n\n'];

  // Interleave preserve and dedup sections.
  for (const heading of DEFAULT_PRESERVE_HEADINGS) {
    // Add a dedup-eligible section before each preserve section.
    parts.push(`## Prior Reviewer Findings\n${DEDUP_BODY}\n`);
    const body = PRESERVE_BODIES[heading] || `Unique body for ${heading}.\n`;
    parts.push(`${heading}\n${body}\n`);
  }

  // Add a second set of dedup-eligible sections (near-duplicates of DEDUP_BODY).
  parts.push(`## Prior Findings\n${DEDUP_BODY}\n`);
  parts.push(`## KB References\nReference: tokenwright design doc v222.\n\n`);

  return parts.join('');
}

const FIXTURE = buildFixture();

// ---------------------------------------------------------------------------
// Per-heading tests — one test per preserve heading
// ---------------------------------------------------------------------------

for (const heading of DEFAULT_PRESERVE_HEADINGS) {
  const localHeading = heading; // capture for closure
  test(`preserve-headings: "${localHeading}" section is verbatim in pipeline output`, () => {
    const output = runPipeline(FIXTURE);
    const body = PRESERVE_BODIES[localHeading] || `Unique body for ${localHeading}.\n`;
    const expectedText = `${localHeading}\n${body}`;
    assert.ok(
      output.includes(expectedText),
      `Expected to find verbatim text for "${localHeading}" in output.\n` +
      `Expected to find: ${JSON.stringify(expectedText.slice(0, 120))}`
    );
  });
}

// ---------------------------------------------------------------------------
// Full fixture: all preserve sections survive; dedup-eligible are compressed
// ---------------------------------------------------------------------------

test('preserve-headings: output contains all preserve sections verbatim', () => {
  const output = runPipeline(FIXTURE);
  for (const heading of DEFAULT_PRESERVE_HEADINGS) {
    assert.ok(
      output.includes(heading),
      `Heading "${heading}" must appear in pipeline output`
    );
  }
});

test('preserve-headings: pipeline output is shorter than input (dedup sections dropped)', () => {
  const output = runPipeline(FIXTURE);
  // Dedup-eligible sections with near-identical content should be dropped,
  // making output shorter. This confirms the pipeline is actually doing work.
  assert.ok(
    output.length < FIXTURE.length,
    `Output (${output.length}) should be shorter than input (${FIXTURE.length}) after dedup`
  );
});

test('preserve-headings: preamble text survives pipeline', () => {
  const output = runPipeline(FIXTURE);
  assert.ok(
    output.includes('Preamble: task summary for the developer agent.'),
    'preamble must survive the pipeline'
  );
});
