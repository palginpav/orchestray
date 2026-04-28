'use strict';

/**
 * Regression: tokenwright code paths must NEVER open, read, or write
 * `.orchestray/state/routing.jsonl`.
 *
 * Strategy: intercept Node's built-in `fs` methods (readFileSync,
 * writeFileSync, appendFileSync, openSync) to throw if the path matches
 * /routing\.jsonl$/. Then exercise parseSections, classifySection, and
 * applyMinHashDedup on representative fixtures. The test passes if no
 * stubbed call throws.
 *
 * Reference: design doc §3 "ALWAYS preserve: routing.jsonl".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Install stubs BEFORE requiring the modules under test so any eager-init
// code in the modules would also be caught.
// ---------------------------------------------------------------------------

const ROUTING_RE = /routing\.jsonl$/;

const FS_METHODS = ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync'];
const originals = {};

function installStubs() {
  for (const method of FS_METHODS) {
    originals[method] = fs[method];
    fs[method] = function stubbedFsMethod(filePath, ...args) {
      const p = typeof filePath === 'string' ? filePath : String(filePath);
      if (ROUTING_RE.test(p)) {
        throw new Error(
          `tokenwright-routing-guard: fs.${method} was called with routing.jsonl path: ${p}`
        );
      }
      return originals[method].call(fs, filePath, ...args);
    };
  }
}

function removeStubs() {
  for (const method of FS_METHODS) {
    fs[method] = originals[method];
  }
}

installStubs();

// Now require the modules under test.
const { parseSections, reassembleSections } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/parse-sections.js')
);
const { classifySection, BLOCK_A_SENTINEL } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/classify-section.js')
);
const { applyMinHashDedup } = require(
  path.join(__dirname, '../../bin/_lib/tokenwright/dedup-minhash.js')
);

// Remove stubs after module load so other tests in the suite aren't affected.
removeStubs();

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const FIXTURE_SIMPLE = [
  'Preamble content for the agent task.',
  '',
  '## Prior Reviewer Findings',
  'Findings: auth validation missing.',
  '',
  '## Acceptance Rubric',
  '- verify output format',
  '',
  '## Structured Result',
  '```json\n{"status":"pass"}\n```',
  '',
].join('\n');

const FIXTURE_WITH_BLOCK_A = [
  'System preamble block.',
  BLOCK_A_SENTINEL,
  '',
  '## Prior Reviewer Findings',
  'Findings from a previous agent pass.',
  'Issue: no error handling in the config loader.',
  '',
  '## KB References',
  'Reference: docs on MinHash algorithm.',
  '',
].join('\n');

const FIXTURE_DUPLICATES = (() => {
  const body = [
    'Prior reviewer findings from round 3.',
    'Issue 1: missing error handling in the config loader module.',
    'Issue 2: reviewer flagged auth middleware for session token storage.',
    'Issue 3: output-shape inject hook was not idempotent on retry.',
    'All issues were addressed in the subsequent developer pass.',
  ].join('\n');
  return [
    '## Prior Reviewer Findings',
    body,
    '',
    '## Prior Findings',
    body,
    '',
    '## Acceptance Rubric',
    '- pass all checks',
    '',
  ].join('\n');
})();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function runPipelineWithGuard(input) {
  // Re-install stubs only during the pipeline run.
  installStubs();
  try {
    const sections = parseSections(input);
    const classified = sections.map(s => ({ ...s, ...classifySection(s) }));
    applyMinHashDedup(classified);
    return reassembleSections(classified);
  } finally {
    removeStubs();
  }
}

test('routing-jsonl-untouched: simple fixture does not touch routing.jsonl', () => {
  // If any fs call hits routing.jsonl the stub throws — test fails automatically.
  const output = runPipelineWithGuard(FIXTURE_SIMPLE);
  assert.ok(typeof output === 'string', 'pipeline should return a string');
  assert.ok(output.length > 0, 'output should be non-empty');
});

test('routing-jsonl-untouched: Block-A fixture does not touch routing.jsonl', () => {
  const output = runPipelineWithGuard(FIXTURE_WITH_BLOCK_A);
  assert.ok(typeof output === 'string');
  // The sentinel must survive.
  assert.ok(output.includes(BLOCK_A_SENTINEL), 'Block-A sentinel must be in output');
});

test('routing-jsonl-untouched: duplicate-heavy fixture does not touch routing.jsonl', () => {
  const output = runPipelineWithGuard(FIXTURE_DUPLICATES);
  assert.ok(typeof output === 'string');
  // Dedup should have run.
  assert.ok(output.includes('## Acceptance Rubric'), 'preserve section must survive');
});

test('routing-jsonl-untouched: parseSections alone does not touch routing.jsonl', () => {
  installStubs();
  try {
    const sections = parseSections(FIXTURE_SIMPLE);
    assert.ok(Array.isArray(sections));
  } finally {
    removeStubs();
  }
});

test('routing-jsonl-untouched: classifySection alone does not touch routing.jsonl', () => {
  const sections = parseSections(FIXTURE_SIMPLE);
  installStubs();
  try {
    for (const s of sections) {
      const result = classifySection(s);
      assert.ok(typeof result.kind === 'string');
    }
  } finally {
    removeStubs();
  }
});

test('routing-jsonl-untouched: applyMinHashDedup alone does not touch routing.jsonl', () => {
  const sections = parseSections(FIXTURE_SIMPLE).map(s => ({ ...s, ...classifySection(s) }));
  installStubs();
  try {
    const { dropped } = applyMinHashDedup(sections);
    assert.ok(typeof dropped === 'number');
  } finally {
    removeStubs();
  }
});
