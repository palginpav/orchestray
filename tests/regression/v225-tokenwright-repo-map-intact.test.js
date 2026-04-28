'use strict';

/**
 * Regression: the body of "## Repo Map (Aider-style, top-K symbols)" and
 * "## Repository Map" blocks must be byte-identical pre/post pipeline even
 * when their content is highly repetitive.
 *
 * Strategy: build a fixture containing the repo-map block (preserve) plus
 * a dedup-eligible block whose content closely resembles the repo map.
 * Assert: the dedup-eligible duplicate is dropped AND the repo-map section
 * raw text is untouched.
 *
 * Reference: roadmap §5.3 "v22n-tokenwright-repo-map-intact.test.js".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSections, reassembleSections } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/parse-sections.js')
);
const { classifySection } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/classify-section.js')
);
const { applyMinHashDedup } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/dedup-minhash.js')
);

function runPipeline(input) {
  const sections = parseSections(input);
  const classified = sections.map(s => ({ ...s, ...classifySection(s) }));
  const { dropped } = applyMinHashDedup(classified);
  const output = reassembleSections(classified);
  return { output, sections: classified, dropped };
}

// ---------------------------------------------------------------------------
// Repo-map body — highly repetitive (many similar symbol lines)
// This content, if it were dedup-eligible, would look like a duplicate target.
// ---------------------------------------------------------------------------

const REPO_MAP_BODY = [
  'src/index.js',
  '  orchestrate(task, opts)',
  '  resolveAgents(agentList, context)',
  '  dispatchSubagent(agentDef, prompt)',
  'src/config.js',
  '  loadConfig(configPath)',
  '  validateConfig(config, schema)',
  '  mergeDefaults(config, defaults)',
  'src/agent/pm.js',
  '  decomposeTasks(prompt, budget)',
  '  scoreComplexity(prompt)',
  '  buildDelegationPrompt(task, agent)',
  'src/bin/inject-tokenwright.js',
  '  injectTokenwright(toolInput, policy)',
  '  applyLayer1(sections)',
  '  emitCompressionEvent(stats)',
  'src/bin/_lib/tokenwright/parse-sections.js',
  '  parseSections(input)',
  '  reassembleSections(sections)',
  'src/bin/_lib/tokenwright/classify-section.js',
  '  classifySection(section, opts)',
  'src/bin/_lib/tokenwright/dedup-minhash.js',
  '  applyMinHashDedup(sections, opts)',
  '  signature(text, k)',
  '  jaccard(sigA, sigB)',
].join('\n') + '\n';

// KB References block that reuses very similar symbol names — intended to
// look like a near-duplicate of the repo map (same symbol vocabulary).
const DEDUP_SIMILAR_BODY = [
  'References: src/index.js orchestrate resolveAgents dispatchSubagent',
  'References: src/config.js loadConfig validateConfig mergeDefaults',
  'References: src/agent/pm.js decomposeTasks scoreComplexity buildDelegationPrompt',
  'References: src/bin/inject-tokenwright.js injectTokenwright applyLayer1 emitCompressionEvent',
  'References: src/bin/_lib/tokenwright/parse-sections.js parseSections reassembleSections',
  'References: src/bin/_lib/tokenwright/classify-section.js classifySection',
  'References: src/bin/_lib/tokenwright/dedup-minhash.js applyMinHashDedup signature jaccard',
].join('\n') + '\n';

// ---------------------------------------------------------------------------
// Fixture 1: Aider-style repo map + near-similar dedup-eligible block
// ---------------------------------------------------------------------------

test('repo-map-intact: Aider-style repo map is byte-identical pre/post pipeline', () => {
  const repoMapSection = `## Repo Map (Aider-style, top-K symbols)\n${REPO_MAP_BODY}`;
  const input = [
    'Preamble content.',
    '',
    `## KB References\n${DEDUP_SIMILAR_BODY}`,
    '',
    repoMapSection,
    '',
    `## Prior Reviewer Findings\n${DEDUP_SIMILAR_BODY}`,
    '',
  ].join('\n');

  const { output } = runPipeline(input);

  // The repo-map section must appear verbatim.
  assert.ok(
    output.includes(repoMapSection),
    'Repo Map section raw text must be byte-identical in output'
  );
});

test('repo-map-intact: Aider-style repo map section heading is preserved in output', () => {
  const input = [
    '## Repo Map (Aider-style, top-K symbols)',
    REPO_MAP_BODY,
    '',
    '## KB References',
    DEDUP_SIMILAR_BODY,
    '',
  ].join('\n');

  const { output } = runPipeline(input);
  assert.ok(
    output.includes('## Repo Map (Aider-style, top-K symbols)'),
    'Repo map heading must be in output'
  );
});

// ---------------------------------------------------------------------------
// Fixture 2: Standard "## Repository Map" heading
// ---------------------------------------------------------------------------

test('repo-map-intact: "## Repository Map" block is byte-identical pre/post pipeline', () => {
  const repoMapSection = `## Repository Map\n${REPO_MAP_BODY}`;
  const input = [
    'Preamble.',
    '',
    repoMapSection,
    '',
    `## KB References\n${DEDUP_SIMILAR_BODY}`,
    '',
    `## Prior Reviewer Findings\n${DEDUP_SIMILAR_BODY}`,
    '',
  ].join('\n');

  const { output } = runPipeline(input);
  assert.ok(
    output.includes(repoMapSection),
    '"## Repository Map" section must be byte-identical in output'
  );
});

// ---------------------------------------------------------------------------
// Fixture 3: repo map + dedup-eligible near-duplicate — duplicate is dropped
// ---------------------------------------------------------------------------

test('repo-map-intact: dedup-eligible near-duplicate of repo-map content IS dropped', () => {
  // Use identical body in both dedup-eligible sections so Jaccard is 1.0 and
  // the second is definitely dropped. The repo-map (preserve) is sandwiched
  // between them.
  const dedupBody = [
    'Prior reviewer findings from round 2.',
    'Issue 1: the route handler does not validate input length on the admin API.',
    'Issue 2: session token stored in localStorage without expiry policy.',
    'Issue 3: error messages expose internal stack traces to the end user.',
    'Issue 4: no rate limiting on the authentication endpoint.',
    'All findings require developer remediation before next release.',
  ].join('\n') + '\n';

  const input = [
    '## Prior Reviewer Findings',
    dedupBody,
    '',
    '## Repo Map (Aider-style, top-K symbols)',
    REPO_MAP_BODY,
    '',
    '## KB References',
    dedupBody, // identical duplicate of Prior Reviewer Findings
    '',
  ].join('\n');

  const { sections, dropped } = runPipeline(input);

  // At least one dedup-eligible section must have been dropped.
  assert.ok(dropped >= 1, `Expected at least 1 dropped section, got ${dropped}`);

  // The repo-map section must NOT be dropped.
  const repoMapSection = sections.find(s => s.heading === '## Repo Map (Aider-style, top-K symbols)');
  assert.ok(repoMapSection, 'Repo map section must be in classified sections');
  assert.notEqual(repoMapSection.dropped, true, 'Repo map section must NOT be dropped');
  assert.equal(repoMapSection.kind, 'preserve', 'Repo map section must be classified as preserve');
});

// ---------------------------------------------------------------------------
// Fixture 4: repetitive repo-map body — repetition alone must not trigger drop
// ---------------------------------------------------------------------------

test('repo-map-intact: repo-map body with repetitive content is never dropped', () => {
  // A repo map that has many repeated symbol patterns (looks dedup-like).
  const repetitiveBody = Array.from({ length: 20 }, (_, i) =>
    `src/module${i}.js\n  func${i}()\n  helper${i}()\n`
  ).join('');

  const input = [
    `## Repo Map (Aider-style, top-K symbols)\n${repetitiveBody}`,
    '',
    `## Prior Reviewer Findings\n${repetitiveBody}`, // near-identical to repo map body
    '',
  ].join('\n');

  const { sections } = runPipeline(input);

  const repoMap = sections.find(s => s.heading === '## Repo Map (Aider-style, top-K symbols)');
  assert.ok(repoMap, 'repo map section must exist');
  // applyMinHashDedup only sets dropped:true on sections it actually drops;
  // preserve sections are never touched, so .dropped is undefined (falsy), not false.
  assert.notEqual(repoMap.dropped, true, 'preserve repo map must never be dropped');
  assert.equal(repoMap.kind, 'preserve');
});
