'use strict';

/**
 * R-RV-DIMS classifier unit tests (v2.1.16 W7).
 *
 * Imports the pure function from bin/_lib/classify-review-dimensions.js.
 * Covers the 5 archetypes from the design plan plus 3 edge cases.
 *
 * Design source: .orchestray/kb/artifacts/v2116-w6-rv-dims-design.md §8
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  classifyReviewDimensions,
  ALL_OPTIONAL,
} = require('../bin/_lib/classify-review-dimensions');

const ENABLED = { enabled: true };

// Shared post-conditions every test result must satisfy.
function assertCommonInvariants(result) {
  assert.ok(result, 'result is truthy');
  assert.ok(
    result.review_dimensions === 'all'
      || Array.isArray(result.review_dimensions),
    'review_dimensions is "all" or string[]'
  );
  assert.ok(typeof result.rationale === 'string', 'rationale is a string');
  assert.ok(result.rationale.length > 0, 'rationale is non-empty');
  assert.ok(result.rationale.length <= 120, 'rationale ≤ 120 chars');
  if (Array.isArray(result.review_dimensions)) {
    for (const d of result.review_dimensions) {
      assert.notStrictEqual(d, 'correctness',
        'never includes literal "correctness" — always-on, lives in core');
      assert.notStrictEqual(d, 'security',
        'never includes literal "security" — always-on, lives in core');
      assert.ok(ALL_OPTIONAL.includes(d),
        `dimension "${d}" is in the allowed enum`);
    }
  }
}

// ---------------------------------------------------------------------------
// Case 1 — doc-only diff
// ---------------------------------------------------------------------------

test('case 1: doc-only diff returns ["documentation"]', () => {
  const r = classifyReviewDimensions({
    files_changed: ['README.md', 'CHANGELOG.md', 'docs/intro.md'],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.deepStrictEqual(r.review_dimensions, ['documentation']);
});

// ---------------------------------------------------------------------------
// Case 2 — UI / CLI / message-string diff
// ---------------------------------------------------------------------------

test('case 2: UI/CLI diff returns ["code-quality","documentation","operability"]', () => {
  const r = classifyReviewDimensions({
    files_changed: ['agents/pm.md', 'bin/statusline.js'],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.deepStrictEqual(
    r.review_dimensions,
    ['code-quality', 'documentation', 'operability']
  );
});

// ---------------------------------------------------------------------------
// Case 2b — F-001 regression: lone agents/*.md must classify as UI/CLI archetype,
// NOT as documentation-only.
//
// Background (v2.1.16 W12-fix): the original case 2 above paired agents/pm.md
// with bin/statusline.js, which made the doc-only rule fail its "every path
// matches" check and let rule 5 (UI/CLI) fire correctly. But for a diff
// containing JUST agents/pm.md (the most common real-world shape — system
// prompt edits), the doc-only rule matched first and reviewers were spawned
// against documentation only, losing code-quality + operability scoping.
// See .orchestray/kb/artifacts/v2116-w12-release-review.md F-001 for evidence.
// ---------------------------------------------------------------------------

test('case 2b (F-001 regression): lone agents/pm.md classifies as UI/CLI, not doc-only', () => {
  const r = classifyReviewDimensions({
    files_changed: ['agents/pm.md'],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.deepStrictEqual(
    r.review_dimensions,
    ['code-quality', 'documentation', 'operability'],
    'agents/pm.md is system-prompt code, not documentation — must hit UI/CLI archetype'
  );
});

test('case 2b (F-001 regression): lone skills/foo/SKILL.md classifies as UI/CLI, not doc-only', () => {
  const r = classifyReviewDimensions({
    files_changed: ['skills/orchestray:run/SKILL.md'],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.deepStrictEqual(
    r.review_dimensions,
    ['code-quality', 'documentation', 'operability'],
    'SKILL.md is a command surface, not documentation — must hit UI/CLI archetype'
  );
});

// ---------------------------------------------------------------------------
// Case 3 — backend API diff
// ---------------------------------------------------------------------------

test('case 3: backend API diff returns ["code-quality","performance","operability","api-compat"]', () => {
  const r = classifyReviewDimensions({
    files_changed: [
      'bin/inject-active-phase-slice.js',
      'agents/pm-reference/event-schemas.md',
    ],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.deepStrictEqual(
    r.review_dimensions,
    ['code-quality', 'performance', 'operability', 'api-compat']
  );
});

// ---------------------------------------------------------------------------
// Case 4 — config / schema diff
// ---------------------------------------------------------------------------

test('case 4: config/schema diff returns ["api-compat","documentation","operability"]', () => {
  const r = classifyReviewDimensions({
    files_changed: [
      'agents/pm-reference/event-schemas.md',
      'specs/config.schema.json',
    ],
    config: ENABLED,
  });
  // Note: this case overlaps with backend (rule 6 hits event-schemas.md too).
  // Per the design's first-match-wins ordering, rule 6 (backend) fires before
  // rule 7 (config/schema) when the diff contains a backend-archetype path.
  // The test verifies the design's deterministic ordering rather than the
  // archetype-table mapping, because event-schemas.md is in the backend list.
  assertCommonInvariants(r);
  assert.deepStrictEqual(
    r.review_dimensions,
    ['code-quality', 'performance', 'operability', 'api-compat'],
    'first-match-wins: backend (rule 6) fires before config/schema (rule 7) ' +
    'when event-schemas.md is in files_changed — see design §4'
  );
});

// ---------------------------------------------------------------------------
// Case 4b — pure config/schema diff (no backend overlap)
// ---------------------------------------------------------------------------

test('case 4b: pure config/schema diff (no backend path) returns ["api-compat","documentation","operability"]', () => {
  const r = classifyReviewDimensions({
    files_changed: ['specs/config.schema.json', 'docs/config.md'],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.deepStrictEqual(
    r.review_dimensions,
    ['api-compat', 'documentation', 'operability']
  );
});

// ---------------------------------------------------------------------------
// Case 5 — unclassified / mixed general diff
// ---------------------------------------------------------------------------

test('case 5: unclassified mixed diff returns "all"', () => {
  const r = classifyReviewDimensions({
    files_changed: ['lib/foo.js', 'src/bar.ts'],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.strictEqual(r.review_dimensions, 'all');
});

// ---------------------------------------------------------------------------
// Case 6 — unknown task_kind (helper called from non-reviewer flow)
//
// Implementation choice (per design §8 row 6): the helper IGNORES task_kind
// and falls through to path-based rules. This test documents that behavior:
// passing task_kind: "tester" with backend-shaped paths still classifies by
// path, returning the backend archetype dimensions — never throws.
// ---------------------------------------------------------------------------

test('case 6: unknown task_kind ("tester") falls through to path-based rules (no throw)', () => {
  const r = classifyReviewDimensions({
    files_changed: ['bin/inject-active-phase-slice.js'],
    task_kind: 'tester',
    config: ENABLED,
  });
  assertCommonInvariants(r);
  // Backend archetype wins on bin/inject-*; helper does NOT throw on unknown task_kind.
  assert.deepStrictEqual(
    r.review_dimensions,
    ['code-quality', 'performance', 'operability', 'api-compat']
  );
});

// ---------------------------------------------------------------------------
// Case 7 — mixed diff with security-flagged path
// ---------------------------------------------------------------------------

test('case 7: security-flagged path wins, returns ["code-quality","operability","api-compat"]', () => {
  const r = classifyReviewDimensions({
    files_changed: ['bin/validate-task-completion.js', 'docs/intro.md'],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.deepStrictEqual(
    r.review_dimensions,
    ['code-quality', 'operability', 'api-compat'],
    'security archetype wins; security itself stays in core'
  );
});

// ---------------------------------------------------------------------------
// Case 8 — empty diff
// ---------------------------------------------------------------------------

test('case 8: empty diff returns "all" with defensive-fallback rationale', () => {
  const r = classifyReviewDimensions({
    files_changed: [],
    config: ENABLED,
  });
  assertCommonInvariants(r);
  assert.strictEqual(r.review_dimensions, 'all');
  assert.match(r.rationale, /empty diff — defensive fallback/);
});

// ---------------------------------------------------------------------------
// AC-8 smoke test: 5 fragment files exist and are >100 bytes each
// ---------------------------------------------------------------------------

test('AC-8: all 5 reviewer-dimensions fragment files exist and are >100 bytes', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const fragments = [
    'code-quality.md',
    'performance.md',
    'documentation.md',
    'operability.md',
    'api-compat.md',
  ];
  for (const f of fragments) {
    const p = path.join(repoRoot, 'agents', 'reviewer-dimensions', f);
    assert.ok(fs.existsSync(p), `${f} exists at ${p}`);
    const sz = fs.statSync(p).size;
    assert.ok(sz > 100, `${f} is >100 bytes (got ${sz})`);
  }
});

// ---------------------------------------------------------------------------
// Kill-switch: config.enabled === false → "all"
// ---------------------------------------------------------------------------

test('kill switch: config.enabled = false returns "all"', () => {
  const r = classifyReviewDimensions({
    files_changed: ['bin/inject-active-phase-slice.js'],
    config: { enabled: false },
  });
  assertCommonInvariants(r);
  assert.strictEqual(r.review_dimensions, 'all');
});
