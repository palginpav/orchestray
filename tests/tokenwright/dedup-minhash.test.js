'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  applyMinHashDedup,
  signature,
  jaccard,
  shingles,
  SIGNATURE_ROWS,
  DEFAULT_THRESHOLD,
  DEFAULT_K,
} = require(path.join(__dirname, '../../bin/_lib/tokenwright/dedup-minhash.js'));

// ---------------------------------------------------------------------------
// signature()
// ---------------------------------------------------------------------------

test('signature: returns a Uint32Array of length SIGNATURE_ROWS', () => {
  const sig = signature('hello world this is a test sentence');
  assert.ok(sig instanceof Uint32Array, 'result must be Uint32Array');
  assert.equal(sig.length, SIGNATURE_ROWS);
});

test('signature: empty string returns Uint32Array filled with 0xffffffff', () => {
  const sig = signature('');
  assert.ok(sig instanceof Uint32Array);
  for (let i = 0; i < sig.length; i++) {
    assert.equal(sig[i], 0xffffffff, `row ${i} should be MAX for empty input`);
  }
});

test('signature: very short text (fewer words than k) returns non-empty signature', () => {
  // With k=3 default, a single word falls back to single shingle — should not crash.
  const sig = signature('hello');
  assert.ok(sig instanceof Uint32Array);
  assert.equal(sig.length, SIGNATURE_ROWS);
  // At least one row should not be MAX (we have a shingle).
  const hasNonMax = Array.from(sig).some(v => v !== 0xffffffff);
  assert.ok(hasNonMax, 'short text should produce at least one non-MAX row');
});

test('signature: two identical strings produce identical signatures', () => {
  const text = 'The quick brown fox jumps over the lazy dog. Repeated content here.';
  const sig1 = signature(text);
  const sig2 = signature(text);
  for (let i = 0; i < SIGNATURE_ROWS; i++) {
    assert.equal(sig1[i], sig2[i], `row ${i} must match for identical inputs`);
  }
});

test('signature: SIGNATURE_ROWS constant is 64', () => {
  assert.equal(SIGNATURE_ROWS, 64);
});

test('signature: DEFAULT_K constant is 3', () => {
  assert.equal(DEFAULT_K, 3);
});

test('signature: DEFAULT_THRESHOLD constant is 0.85', () => {
  assert.equal(DEFAULT_THRESHOLD, 0.85);
});

test('signature: deterministic across multiple calls with same input', () => {
  const text = 'Determinism test: this text should always hash the same way.';
  const sigs = Array.from({ length: 5 }, () => signature(text));
  for (let i = 1; i < sigs.length; i++) {
    for (let r = 0; r < SIGNATURE_ROWS; r++) {
      assert.equal(sigs[i][r], sigs[0][r], `row ${r} must be deterministic across calls`);
    }
  }
});

// ---------------------------------------------------------------------------
// jaccard()
// ---------------------------------------------------------------------------

test('jaccard: identical signatures return 1.0', () => {
  const text = 'Same text produces same signature and Jaccard of one.';
  const sig = signature(text);
  assert.equal(jaccard(sig, sig), 1.0);
});

test('jaccard: identical signatures constructed from same string return 1.0', () => {
  const text = 'The project-intent block arrives once per spawn and is cached at the prefix.';
  const sigA = signature(text);
  const sigB = signature(text);
  assert.equal(jaccard(sigA, sigB), 1.0);
});

test('jaccard: two completely unrelated strings produce similarity well below default threshold', () => {
  const textA = [
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod',
    'tempor incididunt ut labore et dolore magna aliqua ut enim ad minim',
    'veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea',
  ].join(' ');
  const textB = [
    'The orchestray plugin automatically detects complex tasks and delegates them',
    'to specialized AI agents that coordinate across architecture implementation',
    'review debugging testing documentation and security engineering roles.',
  ].join(' ');
  const sim = jaccard(signature(textA), signature(textB));
  assert.ok(
    sim < DEFAULT_THRESHOLD,
    `Unrelated strings should have Jaccard < ${DEFAULT_THRESHOLD}, got ${sim}`
  );
});

test('jaccard: both empty signatures (all-MAX) return 0 — not similar', () => {
  const sigA = signature('');
  const sigB = signature('');
  assert.equal(jaccard(sigA, sigB), 0);
});

test('jaccard: throws on signature length mismatch', () => {
  const sigA = new Uint32Array(64);
  const sigB = new Uint32Array(32);
  assert.throws(() => jaccard(sigA, sigB), /signature length mismatch/);
});

test('jaccard: near-duplicate text (minor edits) produces similarity above threshold', () => {
  const base = [
    'Prior reviewer findings from orchestration run 42.',
    'Issue 1: missing error handling in the config loader.',
    'Issue 2: the reviewer flagged the auth middleware for session token storage.',
    'Issue 3: output-shape inject hook was not idempotent on retry.',
    'All issues were addressed in the subsequent developer pass.',
  ].join('\n');
  // Tiny edit: change one word at the end.
  const nearDup = base.replace('subsequent developer pass', 'subsequent developer run');
  const sim = jaccard(signature(base), signature(nearDup));
  assert.ok(
    sim >= DEFAULT_THRESHOLD,
    `Near-duplicate text should have Jaccard >= ${DEFAULT_THRESHOLD}, got ${sim}`
  );
});

// ---------------------------------------------------------------------------
// shingles() (exported for tests)
// ---------------------------------------------------------------------------

test('shingles: produces k-grams from text', () => {
  const result = shingles('one two three four', 3);
  assert.deepEqual(result, ['one two three', 'two three four']);
});

test('shingles: text shorter than k returns single fallback shingle', () => {
  const result = shingles('hello world', 3);
  assert.deepEqual(result, ['hello world']);
});

test('shingles: empty text returns empty array', () => {
  const result = shingles('', 3);
  assert.deepEqual(result, []);
});

test('shingles: lowercases text', () => {
  const result = shingles('FOO BAR BAZ QUX', 2);
  assert.deepEqual(result, ['foo bar', 'bar baz', 'baz qux']);
});

// ---------------------------------------------------------------------------
// applyMinHashDedup()
// ---------------------------------------------------------------------------

test('applyMinHashDedup: throws TypeError on non-array input', () => {
  assert.throws(() => applyMinHashDedup(null), { name: 'TypeError' });
  assert.throws(() => applyMinHashDedup('string'), { name: 'TypeError' });
});

test('applyMinHashDedup: empty array returns dropped count of zero', () => {
  const { dropped } = applyMinHashDedup([]);
  assert.equal(dropped, 0);
});

test('applyMinHashDedup: single section is never dropped', () => {
  const sections = [
    { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body: 'Some findings here.', dropped: false },
  ];
  applyMinHashDedup(sections);
  assert.equal(sections[0].dropped, false);
});

test('applyMinHashDedup: drops SECOND of two near-duplicate dedup-eligible sections, keeps first', () => {
  const body = [
    'Prior reviewer findings from round 3.',
    'Issue 1: missing error handling in the config loader module.',
    'Issue 2: reviewer flagged auth middleware for session token storage concerns.',
    'Issue 3: output-shape inject hook was not idempotent on retry.',
    'All issues were addressed in the subsequent developer pass.',
  ].join('\n');
  // Near-dup: one word different.
  const bodyDup = body.replace('developer pass', 'developer run');

  const sections = [
    { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body, dropped: false },
    { kind: 'dedup-eligible', heading: '## Prior Findings', body: bodyDup, dropped: false },
  ];
  const { dropped } = applyMinHashDedup(sections);
  assert.equal(dropped, 1);
  assert.equal(sections[0].dropped, false, 'first section must be kept');
  assert.equal(sections[1].dropped, true, 'second near-duplicate must be dropped');
  assert.ok(sections[1].dropped_reason, 'dropped section should have a dropped_reason');
  assert.ok(
    sections[1].dropped_reason.startsWith('minhash-jaccard-'),
    `dropped_reason should start with minhash-jaccard-, got: ${sections[1].dropped_reason}`
  );
});

test('applyMinHashDedup: preserve sections are NEVER dropped even if byte-identical to an earlier section', () => {
  const body = [
    'The Acceptance Rubric is a PRESERVE section.',
    'It must never be deduplicated regardless of content similarity.',
    'Even if two identical acceptance rubrics appear in the prompt.',
    'Both must survive the dedup pass without modification.',
  ].join('\n');

  const sections = [
    { kind: 'preserve', heading: '## Acceptance Rubric', body, dropped: false },
    { kind: 'preserve', heading: '## Acceptance Rubric', body, dropped: false },
  ];
  const { dropped } = applyMinHashDedup(sections);
  assert.equal(dropped, 0, 'preserve sections must never be dropped');
  assert.equal(sections[0].dropped, false);
  assert.equal(sections[1].dropped, false);
});

test('applyMinHashDedup: preserve section before dedup-eligible does not cause dedup-eligible to be dropped when not similar', () => {
  const preserveBody = [
    'Acceptance rubric content: verify output format matches contract.',
    'Verify all required fields are present in structured result.',
    'Verify no hallucinated section headings appear.',
  ].join('\n');
  const dedupBody = [
    'Prior reviewer findings from the security audit.',
    'Credential exposure in environment variable handling.',
    'No validation on user-supplied path inputs.',
    'Authentication bypass via malformed JWT tokens.',
  ].join('\n');

  const sections = [
    { kind: 'preserve', heading: '## Acceptance Rubric', body: preserveBody, dropped: false },
    { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body: dedupBody, dropped: false },
  ];
  applyMinHashDedup(sections);
  assert.equal(sections[1].dropped, false, 'unrelated dedup-eligible section must not be dropped');
});

test('applyMinHashDedup: unique dedup-eligible section is NOT dropped', () => {
  const body = [
    'These findings are completely unique and appear only once.',
    'The MinHash algorithm should not drop a singleton section.',
    'Distinct vocabulary prevents spurious Jaccard overlap here.',
  ].join('\n');

  const sections = [
    { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body, dropped: false },
  ];
  applyMinHashDedup(sections);
  assert.equal(sections[0].dropped, false);
});

test('applyMinHashDedup: score-eligible sections are not dropped (only dedup-eligible are eligible)', () => {
  const body = [
    'Task description: implement the tokenwright compression layer.',
    'This section describes the work to be done in detail.',
    'The developer agent should implement MinHash deduplication.',
  ].join('\n');
  const bodyDup = body; // identical

  const sections = [
    { kind: 'score-eligible', heading: '## Task Description', body, dropped: false },
    { kind: 'score-eligible', heading: '## Task Description', body: bodyDup, dropped: false },
  ];
  applyMinHashDedup(sections);
  assert.equal(sections[0].dropped, false);
  assert.equal(sections[1].dropped, false, 'score-eligible sections must not be dropped by minhash dedup');
});

test('applyMinHashDedup: idempotent — calling twice on same array equals calling once', () => {
  const body = [
    'Prior reviewer findings from round 3.',
    'Issue 1: missing error handling in the config loader module.',
    'Issue 2: reviewer flagged auth middleware for session token storage concerns.',
    'Issue 3: output-shape inject hook was not idempotent on retry.',
    'All issues were addressed in the subsequent developer pass.',
  ].join('\n');
  const bodyDup = body.replace('developer pass', 'developer run');

  // Make two deep copies to run independently.
  function makeSections() {
    return [
      { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body, dropped: false },
      { kind: 'dedup-eligible', heading: '## Prior Findings', body: bodyDup, dropped: false },
    ];
  }

  const onceArr = makeSections();
  applyMinHashDedup(onceArr);

  const twiceArr = makeSections();
  applyMinHashDedup(twiceArr);
  applyMinHashDedup(twiceArr);

  // Both should have same dropped state on every section.
  for (let i = 0; i < onceArr.length; i++) {
    assert.equal(
      twiceArr[i].dropped,
      onceArr[i].dropped,
      `section[${i}].dropped should be identical after one vs two passes`
    );
  }
});

test('applyMinHashDedup: already-dropped sections are skipped as candidates', () => {
  const body = [
    'Prior reviewer findings from round 3.',
    'Issue 1: missing error handling in the config loader module.',
    'Issue 2: reviewer flagged auth middleware for session token storage concerns.',
  ].join('\n');

  const sections = [
    { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body, dropped: true },
    { kind: 'dedup-eligible', heading: '## Prior Findings', body, dropped: false },
  ];
  // Section[0] is already dropped so it should NOT count as a reference.
  // Section[1] should survive since no non-dropped prior section shares its content.
  applyMinHashDedup(sections);
  assert.equal(sections[1].dropped, false, 'section with only pre-dropped predecessors should not be dropped');
});

test('applyMinHashDedup: returns { dropped: N } with correct count', () => {
  const body = [
    'Prior reviewer findings from round 3.',
    'Issue 1: missing error handling in the config loader module.',
    'Issue 2: reviewer flagged auth middleware for session token storage concerns.',
    'Issue 3: output-shape inject hook was not idempotent on retry.',
    'All issues were addressed in the subsequent developer pass.',
  ].join('\n');

  const sections = [
    { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body, dropped: false },
    { kind: 'dedup-eligible', heading: '## Prior Findings', body, dropped: false },
    { kind: 'dedup-eligible', heading: '## Audit Round Findings', body, dropped: false },
  ];
  const { dropped } = applyMinHashDedup(sections);
  assert.equal(dropped, 2, 'should drop 2 near-duplicate sections (2nd and 3rd)');
  assert.equal(sections[0].dropped, false);
  assert.equal(sections[1].dropped, true);
  assert.equal(sections[2].dropped, true);
});

test('applyMinHashDedup: whitespace-only body returns dropped:0 and leaves sections intact', () => {
  const sections = [
    { kind: 'dedup-eligible', heading: '## Prior Reviewer Findings', body: '   \n\t  \n', dropped: false },
    { kind: 'dedup-eligible', heading: '## Prior Findings', body: '   \n\t  \n', dropped: false },
  ];
  // Both empty bodies → jaccard returns 0 (both-empty guard) → neither dropped.
  const { dropped } = applyMinHashDedup(sections);
  assert.equal(dropped, 0, 'whitespace-only bodies produce jaccard=0; neither section should be dropped');
  assert.equal(sections[0].dropped, false);
  assert.equal(sections[1].dropped, false);
});
