#!/usr/bin/env node
'use strict';

/**
 * Golden-file test for W5 — §22c Stage A prompt hardening (v2.0.15).
 *
 * Asserts that agents/pm-reference/tier1-orchestration.md §22c contains:
 *   1. The "§22c Stage A" subsection heading.
 *   2. The Stage-B-gated-on-OQ1 marker comment (prevents accidental Stage B landing).
 *   3. The escalation ladder (Stage A → Stage B → Stage C).
 *   4. Advisory-only framing (warn, not block).
 *
 * If any of these fail, it means the §22c Stage A wording was accidentally removed,
 * softened, or the Stage B gate-comment was stripped — this test exists to make
 * that drift loud.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TIER1_PATH = path.resolve(__dirname, '../agents/pm-reference/tier1-orchestration.md');
const src = fs.readFileSync(TIER1_PATH, 'utf8');

// Extract §22c section: starts at "### 22c." and ends just before the next "\n### " heading.
const section22cIdx = src.indexOf('### 22c.');
const section22cEnd = src.indexOf('\n### ', section22cIdx + 1);
const section22c = src.slice(section22cIdx, section22cEnd === -1 ? undefined : section22cEnd);

describe('W5 golden-file — §22c Stage A prompt (v2.0.15)', () => {

  test('§22c section is present in tier1-orchestration.md', () => {
    assert.ok(
      section22cIdx !== -1,
      'tier1-orchestration.md must contain a "### 22c." section'
    );
  });

  test('§22c Stage A subsection heading is present', () => {
    // DEV-3 W5 deliverable: "§22c Stage A" subsection must exist.
    assert.ok(
      section22c.includes('§22c Stage A') || section22c.includes('22c Stage A'),
      '§22c must contain a "§22c Stage A" subsection heading (v2.0.15 warn-mode delivery)'
    );
  });

  test('Stage-B-gated-on-OQ1 marker comment is present (prevents accidental Stage B landing)', () => {
    // The HTML comment "<!-- Stage B gated on OQ1 — do NOT land blocking enforcement
    // here until OQ1 resolves -->" must be present in §22c to prevent an accidental
    // Stage B enforcement landing before OQ1 is resolved.
    assert.ok(
      src.includes('Stage B gated on OQ1'),
      '§22c must contain the "Stage B gated on OQ1" marker comment to block accidental Stage B landing'
    );
  });

  test('Stage-B-gated-on-OQ1 comment is an HTML comment (not plain text)', () => {
    // Must be inside <!-- --> so it does not render as visible prompt text.
    const commentIdx = src.indexOf('<!-- Stage B gated on OQ1');
    assert.ok(
      commentIdx !== -1,
      'The Stage B gate-comment must be an HTML comment (<!-- ... -->) not plain text'
    );
  });

  test('§22c documents an escalation ladder (Stage A → Stage B)', () => {
    // The escalation ladder must reference both Stage A and Stage B.
    assert.ok(
      section22c.includes('Stage A') && section22c.includes('Stage B'),
      '§22c must document both Stage A and Stage B in its escalation ladder'
    );
  });

  test('§22c Stage A is described as warn-only (advisory), not blocking', () => {
    // Stage A must be advisory-only (warn), not blocking.
    // The DEV-3 report: "advisory-only, no blocking" — current, warn mode.
    assert.ok(
      section22c.includes('warn') || section22c.includes('advisory'),
      '§22c Stage A must describe warn/advisory mode (not blocking)'
    );
  });

  test('§22c references pattern_record_skipped advisory event', () => {
    // The Stage A advisory is tied to the pattern_record_skipped event emitted
    // by bin/record-pattern-skip.js when neither tool has been called.
    assert.ok(
      section22c.includes('pattern_record_skipped') || src.includes('pattern_record_skipped'),
      '§22c must reference the pattern_record_skipped advisory event'
    );
  });

  test('§22c Stage A marker is in the correct section (scoped to §22c)', () => {
    // Guard against the marker existing in a different section.
    assert.ok(
      section22c.includes('Stage A'),
      '"Stage A" text must appear within §22c itself (not just in another section)'
    );
  });

  test('§22c does NOT contain blocking enforcement language at Stage A level', () => {
    // Stage A is warn-only. "block" or "blocking" must not describe Stage A behavior.
    // We check that the section does not say Stage A blocks spawns.
    // Allow "block" only if it refers to Stage B or Stage C (not Stage A).
    // Simple heuristic: no sentence that contains both "Stage A" and "block" nearby.
    const stageAIdx = section22c.indexOf('Stage A');
    if (stageAIdx !== -1) {
      // Check the 200-char window after "Stage A" for "block" language.
      const window = section22c.slice(stageAIdx, stageAIdx + 200).toLowerCase();
      // Allow "block" only when it's referring to blocking Stage B from landing
      // (e.g., "do NOT land blocking enforcement here"). If it says something like
      // "Stage A blocks spawns", that's wrong.
      const hasBlockingRef = window.includes('blocks spawn') ||
                             window.includes('blocking spawn') ||
                             window.includes('exit 2 on first');
      assert.ok(
        !hasBlockingRef,
        '§22c Stage A must not describe blocking behavior (Stage A is warn-only)'
      );
    }
    // If "Stage A" is not found, the section-present test above would already fail.
  });

});
