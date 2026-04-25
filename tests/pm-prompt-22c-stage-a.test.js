#!/usr/bin/env node
'use strict';

/**
 * Golden-file test for W5 — §22c Stage A prompt hardening (v2.0.15).
 *
 * Updated in v2.0.16: Stage C shipped (hook-strict is now the default). The OQ1
 * gate-comment (<!-- Stage B gated on OQ1 -->) has been intentionally removed as a
 * stale artifact — OQ1 resolved, Stage C landed. The test suite has been updated to
 * reflect the new reality instead of asserting the presence of the removed guard.
 *
 * Asserts that agents/pm-reference/phase-close.md §22c (post-W8 split) contains:
 *   1. The "§22c Stage A" subsection heading.
 *   2. The escalation ladder (Stage A → Stage B → Stage C).
 *   3. Advisory-only framing (warn, not block) at Stage A.
 *   4. Stage C is reflected as shipped in 2.0.16.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// W8 (v2.1.15): §22c moved from tier1-orchestration.md to phase-close.md
// during the I-PHASE-GATE split. Header level changed too (now H3 under H2).
const SLICE_PATH = path.resolve(__dirname, '../agents/pm-reference/phase-close.md');
const src = fs.readFileSync(SLICE_PATH, 'utf8');

// Extract §22c section: starts at "### 22c." and ends just before the next "\n### " heading.
const section22cIdx = src.indexOf('### 22c.');
const section22cEnd = src.indexOf('\n### ', section22cIdx + 1);
const section22c = src.slice(section22cIdx, section22cEnd === -1 ? undefined : section22cEnd);

describe('W5 golden-file — §22c Stage A prompt (v2.0.15)', () => {

  test('§22c section is present in phase-close.md', () => {
    assert.ok(
      section22cIdx !== -1,
      'phase-close.md must contain a "### 22c." section'
    );
  });

  test('§22c Stage A subsection heading is present', () => {
    // DEV-3 W5 deliverable: "§22c Stage A" subsection must exist.
    assert.ok(
      section22c.includes('§22c Stage A') || section22c.includes('22c Stage A'),
      '§22c must contain a "§22c Stage A" subsection heading (v2.0.15 warn-mode delivery)'
    );
  });

  test('Stage C (v2.0.16) is documented as shipped, not a future candidate', () => {
    // Stage C shipped in v2.0.16 — the prompt must NOT say Stage C is "deferred"
    // or a "2.0.17 candidate". The OQ1 gate comment was intentionally removed.
    assert.ok(
      !src.includes('Stage C (2.0.17 candidate)') && !src.includes('Deferred to 2.0.17'),
      '§22c must not describe Stage C as deferred or a 2.0.17 candidate (it shipped in 2.0.16)'
    );
  });

  test('hook-strict is documented as the 2.0.16 default', () => {
    // Stage C flipped the default to hook-strict — the section must reflect this.
    assert.ok(
      section22c.includes('hook-strict') &&
      (section22c.includes('default') || section22c.includes('shipped')),
      '§22c must document hook-strict as the shipped default in 2.0.16'
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
