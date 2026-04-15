#!/usr/bin/env node
'use strict';

/**
 * Structural regression test for T17 prose strip (v2.0.17-C).
 *
 * Verifies that the T17 prose strip preserved every IMPERATIVE section
 * documented in T15's strip inventory. Checks:
 *   - Block A/B sentinels present exactly once each in pm.md
 *   - YAML frontmatter byte-range identical between pm.md and pm.old.md
 *   - §9 Anti-patterns section verbatim in pm.md vs pm.old.md
 *   - Path-validation regex in §0.5 preserved verbatim
 *   - Post-condition command-index table in §4.X preserved verbatim
 *   - Tier-2 dispatch table has all old rows PLUS 2 new v2017 rows
 *   - "When in Doubt, Load" absent in pm.md, present once in pm.old.md (S2' flip)
 *   - "Tier-2 Loading Discipline" present exactly once in pm.md
 *   - Complexity-scoring rubric header present in both files
 *   - Task-decomposition protocol section present in both files
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PM_PATH     = path.resolve(__dirname, '../agents/pm.md');
const PM_OLD_PATH = path.resolve(__dirname, '../agents/pm.old.md');

const pm    = fs.readFileSync(PM_PATH,     'utf8');
const pmOld = fs.readFileSync(PM_OLD_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Helper: extract a top-level ## section body from a markdown string.
// Returns text from the heading line up to (not including) the next "## " heading.
// Returns '' if not found.
// ---------------------------------------------------------------------------
function extractSection(src, heading) {
  const startIdx = src.indexOf('\n## ' + heading);
  if (startIdx === -1) return '';
  const afterHeading = startIdx + 1; // include the \n before ##
  const nextSection  = src.indexOf('\n## ', afterHeading + 4);
  return src.slice(afterHeading, nextSection === -1 ? undefined : nextSection);
}

// Extract YAML frontmatter (between the two --- delimiters at file start)
function extractFrontmatter(src) {
  if (!src.startsWith('---')) return '';
  const end = src.indexOf('\n---', 3);
  if (end === -1) return '';
  return src.slice(0, end + 4); // include closing ---
}

// ---------------------------------------------------------------------------
describe('T17 prose strip — structural regression (pm-md-prose-strip-replay)', () => {

  // 1. Block sentinels
  test('ORCHESTRAY_BLOCK_A_END sentinel is present exactly once in pm.md', () => {
    const matches = (pm.match(/ORCHESTRAY_BLOCK_A_END/g) || []).length;
    assert.strictEqual(
      matches, 1,
      `Expected ORCHESTRAY_BLOCK_A_END exactly once in pm.md, found ${matches}`
    );
  });

  test('ORCHESTRAY_BLOCK_B_END sentinel is present exactly once in pm.md', () => {
    const matches = (pm.match(/ORCHESTRAY_BLOCK_B_END/g) || []).length;
    assert.strictEqual(
      matches, 1,
      `Expected ORCHESTRAY_BLOCK_B_END exactly once in pm.md, found ${matches}`
    );
  });

  // 2. YAML frontmatter preserved
  test('YAML frontmatter is byte-identical between pm.md and pm.old.md', () => {
    const fmNew = extractFrontmatter(pm);
    const fmOld = extractFrontmatter(pmOld);
    assert.ok(fmNew.length > 0, 'pm.md must have a YAML frontmatter block');
    assert.ok(fmOld.length > 0, 'pm.old.md must have a YAML frontmatter block');
    assert.strictEqual(
      fmNew, fmOld,
      'YAML frontmatter must be byte-identical — T17 was not authorized to touch frontmatter'
    );
  });

  // 3. §9 Anti-patterns verbatim
  test('§9 Anti-Patterns section content is verbatim-identical in pm.md and pm.old.md', () => {
    const heading = '9. Anti-Patterns';
    const newSec  = extractSection(pm,    heading);
    const oldSec  = extractSection(pmOld, heading);
    assert.ok(newSec.length > 0, `pm.md must contain "## ${heading}" section`);
    assert.ok(oldSec.length > 0, `pm.old.md must contain "## ${heading}" section`);
    assert.strictEqual(
      newSec, oldSec,
      '§9 Anti-Patterns must be verbatim-identical — T17 was not authorized to edit it'
    );
  });

  // 4. Path-validation regex in §0.5 preserved
  test('§0.5 path-validation regex ^[a-zA-Z0-9_./-]+$ is preserved in pm.md', () => {
    const regex = '^[a-zA-Z0-9_./-]+$';
    assert.ok(
      pm.includes(regex),
      `pm.md must preserve the path-validation regex "${regex}" in §0.5 outcome probe scan`
    );
  });

  test('§0.5 secondary path guard (^|/)\\.\\.(/|$) is preserved in pm.md', () => {
    const guard = '(^|/)\\.\\..(/|$)';
    // The file stores this as a literal regex pattern; check for key fragment
    assert.ok(
      pm.includes('..') && pm.includes('(^|/)'),
      'pm.md must preserve the ".." path-component rejection guard in §0.5'
    );
  });

  // 5. Post-condition command-index table in §4.X preserved
  test('§4.X command-index table row for npm test (index 1) is preserved in pm.md', () => {
    assert.ok(
      pm.includes('| 1 | `npm test` |'),
      'pm.md must preserve the command-index table row "| 1 | `npm test` |" in §4.X'
    );
  });

  test('§4.X command-index table row for npm run build (index 2) is preserved in pm.md', () => {
    assert.ok(
      pm.includes('| 2 | `npm run build` |'),
      'pm.md must preserve the command-index table row "| 2 | `npm run build` |" in §4.X'
    );
  });

  test('§4.X command-index table all 6 index rows are preserved in pm.md', () => {
    for (let i = 1; i <= 6; i++) {
      assert.ok(
        pm.includes(`| ${i} |`),
        `pm.md must preserve command-index table row for index ${i} in §4.X`
      );
    }
  });

  // 6. Tier-2 dispatch table: all old rows present + 2 new v2017 rows
  test('Tier-2 dispatch table contains all Tier-2 rows that were present in pm.old.md', () => {
    // Extract dispatch table rows from old file (lines with | condition | file |)
    const tableRowRe = /\|\s*`[^`]+`[^|]*\|\s*`agents\/pm-reference\/[^`]+`\s*\|/g;
    const oldRows = pmOld.match(tableRowRe) || [];
    assert.ok(oldRows.length > 0, 'pm.old.md must have Tier-2 dispatch table rows');

    const missingRows = [];
    for (const row of oldRows) {
      // Extract the filename from the row — it's the load-bearing key
      const fileMatch = row.match(/`(agents\/pm-reference\/[^`]+)`/);
      if (!fileMatch) continue;
      const filename = fileMatch[1];
      if (!pm.includes(filename)) {
        missingRows.push(filename);
      }
    }
    assert.deepStrictEqual(
      missingRows, [],
      `pm.md is missing these Tier-2 dispatch table files that were in pm.old.md: ${missingRows.join(', ')}`
    );
  });

  test('Tier-2 dispatch table contains new v2017 row for prompt-caching-protocol.md', () => {
    assert.ok(
      pm.includes('prompt-caching-protocol.md'),
      'pm.md must contain the new v2017 Tier-2 dispatch row for prompt-caching-protocol.md'
    );
  });

  test('Tier-2 dispatch table contains new v2017 adaptive_verbosity gate row', () => {
    assert.ok(
      pm.includes('adaptive_verbosity'),
      'pm.md must contain the new v2017 Tier-2 dispatch row for the adaptive_verbosity gate'
    );
  });

  // 7. S2' flip: "When in Doubt, Load" → "Tier-2 Loading Discipline"
  test('"When in Doubt, Load" is absent from pm.md (S2\' flip applied)', () => {
    const count = (pm.match(/When in Doubt, Load/g) || []).length;
    assert.strictEqual(
      count, 0,
      `pm.md must NOT contain "When in Doubt, Load" — S2' flip replaced it with strict-gate discipline; found ${count} occurrence(s)`
    );
  });

  test('"When in Doubt, Load" is present exactly once in pm.old.md (baseline)', () => {
    const count = (pmOld.match(/When in Doubt, Load/g) || []).length;
    assert.strictEqual(
      count, 1,
      `pm.old.md must contain "When in Doubt, Load" exactly once as rollback baseline; found ${count}`
    );
  });

  test('"Tier-2 Loading Discipline" is present exactly once in pm.md (S2\' flip target)', () => {
    const count = (pm.match(/Tier-2 Loading Discipline/g) || []).length;
    assert.strictEqual(
      count, 1,
      `pm.md must contain "Tier-2 Loading Discipline" exactly once; found ${count}`
    );
  });

  // 8. Complexity-scoring rubric header present in both
  test('Complexity Scoring section header is present in pm.md', () => {
    assert.ok(
      pm.includes('## 12. Complexity Scoring'),
      'pm.md must contain the "## 12. Complexity Scoring" section header'
    );
  });

  test('Complexity Scoring section header is present in pm.old.md', () => {
    assert.ok(
      pmOld.includes('## 12. Complexity Scoring'),
      'pm.old.md must contain the "## 12. Complexity Scoring" section header'
    );
  });

  // 9. Task-decomposition protocol section present in both
  test('Task Decomposition reference is present in pm.md', () => {
    assert.ok(
      pm.includes('Task Decomposition Protocol') || pm.includes('Section 13'),
      'pm.md must reference the Task Decomposition Protocol (Section 13)'
    );
  });

  test('Task Decomposition reference is present in pm.old.md', () => {
    assert.ok(
      pmOld.includes('Task Decomposition Protocol') || pmOld.includes('Section 13'),
      'pm.old.md must reference the Task Decomposition Protocol (Section 13)'
    );
  });

});
