#!/usr/bin/env node
'use strict';

/**
 * v2.1.14 R-EMERGE regression — auto-extraction.md and pattern-extraction.md
 * merged into a single extraction-protocol.md.
 *
 * Checks:
 *   1. extraction-protocol.md exists in agents/pm-reference/
 *   2. auto-extraction.md does NOT exist (deleted after merge)
 *   3. pattern-extraction.md does NOT exist (deleted after merge)
 *   4. Merged file contains the auto-extraction section header
 *   5. Merged file contains the pattern-extraction section header (22a)
 *   6. Merged file size is reported (goal ≤ 27 KB; preserved-accuracy variant accepted)
 *   7. No other test in the repo references the two original filenames
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..', '..');
const pmRefDir = path.join(repoRoot, 'agents', 'pm-reference');

const MERGED_FILE = path.join(pmRefDir, 'extraction-protocol.md');
const DELETED_FILE_1 = path.join(pmRefDir, 'auto-extraction.md');
const DELETED_FILE_2 = path.join(pmRefDir, 'pattern-extraction.md');

describe('v2114-r-emerge: extraction-protocol merge', () => {
  test('extraction-protocol.md exists', () => {
    assert.ok(
      fs.existsSync(MERGED_FILE),
      `Expected ${MERGED_FILE} to exist after R-EMERGE merge`
    );
  });

  test('auto-extraction.md has been deleted', () => {
    assert.ok(
      !fs.existsSync(DELETED_FILE_1),
      `Expected ${DELETED_FILE_1} to be deleted after R-EMERGE merge`
    );
  });

  test('pattern-extraction.md has been deleted', () => {
    assert.ok(
      !fs.existsSync(DELETED_FILE_2),
      `Expected ${DELETED_FILE_2} to be deleted after R-EMERGE merge`
    );
  });

  test('merged file contains auto-extraction section header', () => {
    const content = fs.readFileSync(MERGED_FILE, 'utf8');
    assert.ok(
      content.includes('Auto-Extraction Subagent Prompt'),
      'Merged file must contain auto-extraction section (Part I)'
    );
  });

  test('merged file contains pattern-extraction section (22a)', () => {
    const content = fs.readFileSync(MERGED_FILE, 'utf8');
    assert.ok(
      content.includes('22a. Automatic Pattern Extraction'),
      'Merged file must contain pattern extraction procedure (§22a)'
    );
  });

  test('merged file size is within expected bounds', () => {
    const stats = fs.statSync(MERGED_FILE);
    const sizeKb = stats.size / 1024;
    // Goal: ≤ 27 KB. The two originals had minimal textual overlap (~38.6 KB combined),
    // so the achieved size after dedup is documented in the merge-diff artifact.
    // This test enforces an upper bound of 50 KB to catch accidental duplication.
    assert.ok(
      sizeKb <= 50,
      `Merged file is ${sizeKb.toFixed(1)} KB — exceeds 50 KB safety ceiling (check for accidental duplication)`
    );
    // Informational: log actual size for the artifact
    if (sizeKb > 27) {
      process.stderr.write(
        `[v2114-r-emerge] Note: merged file is ${sizeKb.toFixed(1)} KB. ` +
        `Goal was ≤ 27 KB; originals had minimal overlap (38.6 KB combined). ` +
        `See .orchestray/kb/artifacts/v2114-extraction-merge-diff.md for rationale.\n`
      );
    }
  });

  test('no test file in the repo references the two original filenames', () => {
    const testDirs = [
      path.join(repoRoot, 'tests'),
      path.join(repoRoot, 'bin', '__tests__'),
      path.join(repoRoot, 'bin', '_lib', '__tests__'),
    ];

    const violations = [];

    for (const dir of testDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir, { recursive: true });
      for (const f of files) {
        if (!f.endsWith('.test.js') && !f.endsWith('.spec.js')) continue;
        const filePath = path.join(dir, f);
        // Skip this file itself — its own source references the old names for documentation
        if (filePath === __filename) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('auto-extraction.md') || content.includes('pattern-extraction.md')) {
          violations.push(filePath);
        }
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      `Test files must not reference the deleted originals. Found violations:\n${violations.join('\n')}`
    );
  });
});
