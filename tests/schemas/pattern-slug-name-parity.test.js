#!/usr/bin/env node
'use strict';

/**
 * Corpus invariant: slug (filename stem) === category + '-' + name.
 *
 * A pattern has two identifiers — slug (what pattern_find, the offer ledger,
 * closed-set matching, and credit all key on) and the `name:` frontmatter
 * field (what the document calls itself, and the only identity visible to an
 * agent reading the pattern body). When they diverge, a system keying on one
 * and a reader seeing the other disagree about what the pattern is called —
 * this already cost a real application its credit in v2.3.20 (see
 * .orchestray/kb/decisions/pattern-ack-slug-fidelity-limit.md). This test
 * pins the invariant so a new pattern in either tier cannot reintroduce it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseFrontmatter } = require('../../schemas/_yaml.js');
const { getSharedPatternsDir } = require('../../bin/mcp-server/lib/paths');

const ROOT = path.join(__dirname, '..', '..');
const LOCAL_DIR = path.join(ROOT, '.orchestray', 'patterns');

/**
 * @param {string|null} dir
 * @returns {string[]} human-readable violation descriptions, empty if none
 */
function violationsIn(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const violations = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue; // skip roi-snapshot.json and similar
    const slug = f.slice(0, -3);
    const raw = fs.readFileSync(path.join(dir, f), 'utf8');
    const parsed = parseFrontmatter(raw);
    const fm = parsed && parsed.frontmatter;
    if (!fm || !fm.name || !fm.category) {
      violations.push(`${f}: missing name/category frontmatter`);
      continue;
    }
    const expected = `${fm.category}-${fm.name}`;
    if (expected !== slug) {
      violations.push(`${f}: slug "${slug}" !== category-name "${expected}"`);
    }
  }
  return violations;
}

describe('pattern corpus — slug/name parity', () => {
  test('every local pattern satisfies slug === category + "-" + name', () => {
    const v = violationsIn(LOCAL_DIR);
    assert.deepEqual(v, [], `local pattern corpus has slug/name drift:\n${v.join('\n')}`);
  });

  test('every shared-tier pattern satisfies slug === category + "-" + name', () => {
    const v = violationsIn(getSharedPatternsDir());
    assert.deepEqual(v, [], `shared pattern corpus has slug/name drift:\n${v.join('\n')}`);
  });
});
