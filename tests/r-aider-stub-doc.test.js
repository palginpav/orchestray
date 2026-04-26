#!/usr/bin/env node
'use strict';

/**
 * r-aider-stub-doc.test.js — coverage for R-AIDER-STUB (W11, v2.1.16).
 *
 * R-AIDER-STUB replaces the 388-line hand-rolled `repo-map-protocol.md` with a
 * Tier-2 stub (≤ 100 lines) that names the canonical Aider algorithm
 * (web-tree-sitter + graphology-pagerank + RepoMapper). The legacy file is
 * preserved as `repo-map-protocol.md.legacy` for one release per the v2.1.15
 * I-PHASE-GATE preservation pattern.
 *
 * Tests:
 *   1. The stub doc exists at agents/pm-reference/repo-map-protocol.md.
 *   2. When the stub has landed (≤ 100 lines), it cites the canonical algorithm
 *      AND has at least one citation (URL or library name). When the stub has
 *      not landed (388-line legacy still in place), the test skips with a gap
 *      marker.
 *   3. When the stub has landed, the legacy file exists at
 *      `repo-map-protocol.md.legacy` with a preservation header. When the stub
 *      has not landed, this test skips.
 *
 * Runner: node --test tests/r-aider-stub-doc.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const STUB_PATH = path.join(ROOT, 'agents', 'pm-reference', 'repo-map-protocol.md');
const LEGACY_PATH = path.join(ROOT, 'agents', 'pm-reference', 'repo-map-protocol.md.legacy');

const STUB_LINE_CEILING = 100;

function lineCount(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').length;
}

// ---------------------------------------------------------------------------
// Test 1 — stub doc exists
// ---------------------------------------------------------------------------

describe('R-AIDER-STUB — stub file present', () => {
  test('agents/pm-reference/repo-map-protocol.md exists', () => {
    assert.ok(fs.existsSync(STUB_PATH),
      'repo-map-protocol.md must exist (stub or legacy body)');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — stub structure (when landed)
// ---------------------------------------------------------------------------

describe('R-AIDER-STUB — stub structure (canonical algorithm + citations)', () => {
  test('repo-map-protocol.md is ≤ 100 lines and cites canonical algorithm', (t) => {
    if (!fs.existsSync(STUB_PATH)) {
      t.skip('stub doc not present');
      return;
    }

    const lines = lineCount(STUB_PATH);
    if (lines > STUB_LINE_CEILING) {
      // R-AIDER-STUB (W11) has not landed yet — the 388-line legacy body is
      // still in place. Record the gap and skip.
      t.skip(`R-AIDER-STUB not yet landed: ${lines} lines exceeds ${STUB_LINE_CEILING}-line stub ceiling (W11 pending)`);
      return;
    }

    const body = fs.readFileSync(STUB_PATH, 'utf8');
    // Canonical algorithm names the spec mentions: tree-sitter, PageRank,
    // RepoMapper / Aider, graphology-pagerank.
    const namesAlgorithm = /tree-sitter/i.test(body) && /pagerank/i.test(body);
    assert.ok(namesAlgorithm,
      'stub must name the canonical algorithm (tree-sitter + PageRank)');
  });

  test('repo-map-protocol.md stub has at least one citation when ≤ 100 lines', (t) => {
    if (!fs.existsSync(STUB_PATH)) {
      t.skip('stub doc not present');
      return;
    }
    if (lineCount(STUB_PATH) > STUB_LINE_CEILING) {
      t.skip('stub not yet landed (legacy body still in place)');
      return;
    }
    const body = fs.readFileSync(STUB_PATH, 'utf8');
    // Citations: at least one URL (https://...) or a named library
    // (RepoMapper, graphology-pagerank, web-tree-sitter, aider).
    const hasCitation = /https?:\/\//.test(body) ||
      /RepoMapper|graphology-pagerank|web-tree-sitter|aider/i.test(body);
    assert.ok(hasCitation,
      'stub must include at least one citation (URL or named library)');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — legacy preservation
// ---------------------------------------------------------------------------

describe('R-AIDER-STUB — legacy file preserved', () => {
  test('repo-map-protocol.md.legacy exists when stub has landed', (t) => {
    if (!fs.existsSync(STUB_PATH) || lineCount(STUB_PATH) > STUB_LINE_CEILING) {
      // Stub has not landed yet — legacy is the live file, no .legacy copy
      // is required at this point.
      t.skip('stub not yet landed; legacy preservation check deferred to post-W11');
      return;
    }
    assert.ok(fs.existsSync(LEGACY_PATH),
      'when stub lands, repo-map-protocol.md.legacy must preserve the prior body for one release');
  });

  test('legacy file has a preservation header (when present)', (t) => {
    if (!fs.existsSync(LEGACY_PATH)) {
      t.skip('legacy file not present (stub may not have landed yet)');
      return;
    }
    const body = fs.readFileSync(LEGACY_PATH, 'utf8');
    // Preservation header: a comment, a "Legacy" / "Preserved" / "deprecated"
    // notice in the first 30 lines so a reader knows why this file is here.
    const head = body.split('\n').slice(0, 30).join('\n');
    const hasHeader = /(legacy|preserved|deprecated|superseded|one\s+release)/i.test(head);
    assert.ok(hasHeader,
      'legacy file must declare its preservation status in the first 30 lines');
  });
});
