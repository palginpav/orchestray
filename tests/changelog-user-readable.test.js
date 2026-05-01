#!/usr/bin/env node
'use strict';

/**
 * T19 — CHANGELOG opener user-readability gate (v2.2.21)
 *
 * Parses CHANGELOG.md, extracts the opener paragraph for v2.2.17 and v2.2.18,
 * and asserts that internal symbols do not leak into user-facing release notes.
 *
 * Patterns banned from openers:
 *   - FN-\d+  (internal finding IDs)
 *   - drainer-tombstone  (internal component name)
 *   - deferred backlog  (internal planning term)
 *   - same-day FN-\d+ hotfix  (internal release-process jargon)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHANGELOG = path.resolve(__dirname, '..', 'CHANGELOG.md');

const BANNED = [
  { pattern: /FN-\d+/, label: 'internal finding ID (FN-\\d+)' },
  { pattern: /drainer-tombstone/, label: 'internal symbol "drainer-tombstone"' },
  { pattern: /deferred backlog/, label: 'internal term "deferred backlog"' },
  { pattern: /same-day FN-\d+ hotfix/, label: 'internal jargon "same-day FN-\\d+ hotfix"' },
];

/**
 * Extract the opener paragraph(s) for a given version section.
 * The opener is the prose between the `## [x.y.z]` heading and the first `###` subsection.
 */
function extractOpener(changelog, version) {
  const lines = changelog.split('\n');
  const sectionHeading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`);

  let inSection = false;
  let openerLines = [];

  for (const line of lines) {
    if (sectionHeading.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // Stop at next ## heading (next version) or ### subsection
      if (/^##/.test(line)) break;
      openerLines.push(line);
    }
  }

  // Trim trailing blank lines and return only up to first ### subsection
  const subsectionIdx = openerLines.findIndex(l => /^###/.test(l));
  if (subsectionIdx !== -1) {
    openerLines = openerLines.slice(0, subsectionIdx);
  }

  return openerLines.join('\n').trim();
}

describe('CHANGELOG opener user-readability', () => {
  let changelog;

  test('CHANGELOG.md exists and is readable', () => {
    assert.ok(fs.existsSync(CHANGELOG), `CHANGELOG.md not found at ${CHANGELOG}`);
    changelog = fs.readFileSync(CHANGELOG, 'utf8');
    assert.ok(changelog.length > 0, 'CHANGELOG.md is empty');
  });

  for (const version of ['2.2.17', '2.2.18']) {
    describe(`v${version} opener`, () => {
      test(`v${version} section exists`, () => {
        changelog = changelog || fs.readFileSync(CHANGELOG, 'utf8');
        const opener = extractOpener(changelog, version);
        assert.ok(opener.length > 0, `v${version} section opener is empty or missing`);
      });

      for (const { pattern, label } of BANNED) {
        test(`v${version} opener: no ${label}`, () => {
          changelog = changelog || fs.readFileSync(CHANGELOG, 'utf8');
          const opener = extractOpener(changelog, version);
          assert.ok(
            opener.length > 0,
            `v${version} opener not found — cannot validate banned symbols`
          );
          assert.ok(
            !pattern.test(opener),
            `v${version} opener contains banned internal symbol [${label}]:\n\n${opener}`
          );
        });
      }
    });
  }
});
