#!/usr/bin/env node
'use strict';

/**
 * Golden-file test for W2 — §22b prompt hardening.
 *
 * Asserts that agents/pm-reference/phase-decomp.md §22b (post-W8 split) contains:
 *   1. The non-softened directive naming both tools. v2.3.19 evidence design §6.3
 *      retired the either/or framing (`pattern_record_application` no longer
 *      satisfies the gate — see gate-agent-spawn.js §6.1) in favor of: cite used
 *      patterns as `@orchestray:pattern://<slug>` (no MCP call needed), call
 *      `pattern_record_skip_reason` for every uncited pattern (protocol violation
 *      if skipped), and do NOT call `pattern_record_application` here.
 *   2. The fallback marker format example (pattern_record_skipped_reason:) in a
 *      code block context.
 *   3. All four reason enum values.
 *   4. The W1-W2-boundary marker is ABSENT (W2 removed it).
 *
 * If any of these fail, it means the wording was softened or the fallback path
 * was removed — this test exists to make that drift loud.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// W8 (v2.1.15): §22b moved from tier1-orchestration.md to phase-decomp.md
// during the I-PHASE-GATE split. The header form changed from "### 22b." to
// "## 22b." since the slice file uses H2 for top-level sections.
const SLICE_PATH = path.resolve(__dirname, '../agents/pm-reference/phase-decomp.md');
const src = fs.readFileSync(SLICE_PATH, 'utf8');

// Extract §22b section once for all scoped tests.
// §22b in phase-decomp.md starts at "## 22b." and ends just before the next
// "## " H2 (use a regex that won't greedily skip subsections like §22b.R).
const section22bIdx = src.indexOf('## 22b.');
// Walk forward to find the next H2 (`\n## `) that is NOT a §22b subsection.
let section22bEnd = -1;
{
  let scan = section22bIdx + 1;
  while (scan < src.length) {
    const next = src.indexOf('\n## ', scan);
    if (next === -1) { section22bEnd = -1; break; }
    // §22b subsections (like ## 22b-federation, ## 22b.R) stay inside §22b
    const tail = src.slice(next + 4, next + 20);
    if (tail.startsWith('22b') || tail.startsWith('§22b')) {
      scan = next + 4;
      continue;
    }
    section22bEnd = next;
    break;
  }
}
const section22b = src.slice(section22bIdx, section22bEnd === -1 ? undefined : section22bEnd);

describe('W2 golden-file — §22b prompt hardening', () => {

  test('AC1: non-softened directive is present in §22b (not softened to "should")', () => {
    // v2.3.19 evidence design §6.3 retired "MUST call EITHER" (application no
    // longer gates anything — §6.1). Scoped to §22b so a future edit that softens
    // the replacement directive back to "should" cannot pass silently.
    assert.ok(
      section22b.includes('is a protocol violation'),
      '§22b must state that skipping the skip-reason call is "a protocol violation" — not softened to "should"'
    );
  });

  test('AC1: pattern_record_application is named and explicitly excluded in §22b directive', () => {
    // Scoped to §22b. Post-§6.3, the tool must still be NAMED (so the PM knows
    // not to call it) but paired with an explicit "do NOT call" instruction —
    // removing the tool name entirely would silently reintroduce the confusion
    // this rewrite was meant to resolve.
    assert.ok(
      section22b.includes('pattern_record_application'),
      '§22b must name pattern_record_application explicitly within the §22b section'
    );
    assert.ok(
      /NOT\*\*? call `?mcp__orchestray__pattern_record_application/.test(section22b),
      '§22b must explicitly instruct the PM NOT to call pattern_record_application'
    );
  });

  test('AC1: pattern_record_skip_reason tool is named in §22b directive', () => {
    // Scoped to §22b so removing the tool name from the directive section
    // while leaving it in a different part of the file does not pass.
    assert.ok(
      section22b.includes('pattern_record_skip_reason'),
      '§22b must name pattern_record_skip_reason explicitly within the §22b section'
    );
  });

  test('AC1: timing — "before the first" Agent() spawn is stated in §22b', () => {
    // Guards against a future edit that removes the timing qualifier from §22b.
    assert.ok(
      section22b.includes('before the first'),
      '§22b must state the timing "before the first Agent() spawn"'
    );
  });

  test('AC2: fallback marker key is documented (pattern_record_skipped_reason)', () => {
    assert.ok(
      src.includes('pattern_record_skipped_reason'),
      '§22b must document the fallback marker key pattern_record_skipped_reason'
    );
  });

  test('AC2: fallback reason enum — all-irrelevant is present', () => {
    assert.ok(src.includes('all-irrelevant'), 'reason enum value all-irrelevant must be present');
  });

  test('AC2: fallback reason enum — all-low-confidence is present', () => {
    assert.ok(src.includes('all-low-confidence'), 'reason enum value all-low-confidence must be present');
  });

  test('AC2: fallback reason enum — all-stale is present', () => {
    assert.ok(src.includes('all-stale'), 'reason enum value all-stale must be present');
  });

  test('AC2: fallback reason enum — all four enum values present in §22b', () => {
    // Strengthened: scope to §22b AND check all 4 values appear together so that
    // the trivially-true "other" anywhere in the file cannot satisfy this check.
    // A future edit that removes or renames an enum value in §22b must fail this test.
    assert.ok(section22b.includes('all-irrelevant'),
      'reason enum value all-irrelevant must appear in §22b');
    assert.ok(section22b.includes('all-low-confidence'),
      'reason enum value all-low-confidence must appear in §22b');
    assert.ok(section22b.includes('all-stale'),
      'reason enum value all-stale must appear in §22b');
    assert.ok(section22b.includes('other'),
      'reason enum value other must appear in §22b');
  });

  test('AC4: W1-W2-boundary marker has been removed', () => {
    assert.ok(
      !src.includes('W1-W2-boundary'),
      'The <!-- W1-W2-boundary --> marker left by W1 must be removed by W2'
    );
  });

  test('AC2: fallback format example appears in a code block context', () => {
    // The fallback marker must appear inside a fenced code block so the PM
    // has a concrete copy-paste example. Check that a code fence precedes
    // the pattern_record_skipped_reason: literal within 200 chars.
    const idx = src.indexOf('pattern_record_skipped_reason:');
    assert.ok(idx !== -1, 'pattern_record_skipped_reason: must be present');
    const surrounding = src.slice(Math.max(0, idx - 200), idx);
    assert.ok(
      surrounding.includes('```'),
      'pattern_record_skipped_reason: must appear inside a fenced code block example'
    );
  });

});
