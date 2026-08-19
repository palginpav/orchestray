#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/_lib/kb-extract-source.js (v2.3.30 — kb/-sourced
 * extraction, time-windowed join key, no orchestration_id dependency).
 *
 * Runner: node --test bin/_lib/__tests__/kb-extract-source.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const {
  readLastRunStamp,
  writeLastRunStamp,
  collectKbEntriesSince,
  deriveCategoryForEntry,
  buildProposalFromKbEntry,
  buildKbProposalContent,
} = require('../kb-extract-source.js');
const { validateProposal } = require('../proposal-validator.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-kb-extract-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeKbFile(bucket, slug, frontmatter, body) {
  const dir = path.join(tmpDir, '.orchestray', 'kb', bucket);
  fs.mkdirSync(dir, { recursive: true });
  const fmLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  const content = ['---', ...fmLines, '---', '', body].join('\n');
  fs.writeFileSync(path.join(dir, slug + '.md'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Last-run stamp
// ---------------------------------------------------------------------------

describe('last-run stamp', () => {
  test('readLastRunStamp returns null when absent', () => {
    assert.equal(readLastRunStamp(tmpDir), null);
  });

  test('writeLastRunStamp then readLastRunStamp round-trips', () => {
    const at = '2026-08-01T00:00:00.000Z';
    assert.equal(writeLastRunStamp(tmpDir, at), true);
    assert.equal(readLastRunStamp(tmpDir), at);
  });

  test('corrupt stamp file is treated as first run (null), not a crash', () => {
    const stampPath = path.join(tmpDir, '.orchestray', 'state', 'kb-extract-last-run.json');
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, 'not json', 'utf8');
    assert.equal(readLastRunStamp(tmpDir), null);
  });
});

// ---------------------------------------------------------------------------
// collectKbEntriesSince — time-window join, no orchestration_id anywhere
// ---------------------------------------------------------------------------

describe('collectKbEntriesSince', () => {
  test('sinceIso=null returns every kb entry across all three buckets', () => {
    writeKbFile('facts', 'a', { author: 'developer', topic: 'x' }, '# A\n\nbody a');
    writeKbFile('decisions', 'b', { author: 'architect', topic: 'y' }, '# B\n\nbody b');
    writeKbFile('artifacts', 'c', { author: 'researcher', topic: 'z' }, '# C\n\nbody c');

    const entries = collectKbEntriesSince(tmpDir, null);
    assert.equal(entries.length, 3);
    for (const e of entries) {
      assert.equal(e.frontmatter.orchestration_id, undefined, 'kb entries never carry orchestration_id');
    }
  });

  test('missing kb/ directory returns empty array, no throw', () => {
    assert.deepEqual(collectKbEntriesSince(tmpDir, null), []);
  });

  test('entries with mtime at or before sinceIso are excluded', async () => {
    writeKbFile('facts', 'old', { author: 'developer', topic: 'old one' }, '# Old\n\nold body');
    // Force a distinct, controllable mtime window.
    const cutoff = new Date(Date.now() + 50).toISOString();
    await new Promise((r) => setTimeout(r, 80));
    writeKbFile('facts', 'new', { author: 'developer', topic: 'new one' }, '# New\n\nnew body');

    const entries = collectKbEntriesSince(tmpDir, cutoff);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].slug, 'new');
  });
});

// ---------------------------------------------------------------------------
// deriveCategoryForEntry — only the 3 kb-derivable categories, never fabricated
// ---------------------------------------------------------------------------

describe('deriveCategoryForEntry', () => {
  test('anti-pattern keywords map to anti-pattern', () => {
    const entry = {
      title: 'Never mock the database',
      frontmatter: { topic: 'this is an anti-pattern landmine' },
      body: 'Never do this again, it is a gotcha.',
    };
    assert.equal(deriveCategoryForEntry(entry), 'anti-pattern');
  });

  test('user-correction keywords map to user-correction', () => {
    const entry = {
      title: 'Commit style',
      frontmatter: { topic: 'user corrected the commit message format' },
      body: 'The user said no co-authoring trailers, ever.',
    };
    assert.equal(deriveCategoryForEntry(entry), 'user-correction');
  });

  test('specialization keywords map to specialization', () => {
    const entry = {
      title: 'Route to security specialist',
      frontmatter: { topic: 'delegate to a specialist agent role' },
      body: 'Use model routing to assign this specialization to security-engineer.',
    };
    assert.equal(deriveCategoryForEntry(entry), 'specialization');
  });

  test('no keyword match returns null, never a fabricated category', () => {
    const entry = {
      title: 'Quarterly numbers',
      frontmatter: { topic: 'unrelated business summary' },
      body: 'Revenue grew by ten percent this quarter across all regions.',
    };
    assert.equal(deriveCategoryForEntry(entry), null);
  });

  test('never returns decomposition or routing — kb has no task-graph data', () => {
    // Even a body stuffed with those literal words must not resolve to
    // decomposition/routing, because those categories have no keyword table.
    const entry = {
      title: 'decomposition and routing outcome',
      frontmatter: { topic: 'decomposition routing_outcome task-graph' },
      body: 'decomposition routing routing_outcome task-graph.md',
    };
    assert.equal(deriveCategoryForEntry(entry), null);
  });
});

// ---------------------------------------------------------------------------
// buildProposalFromKbEntry + buildKbProposalContent — provenance & validity
// ---------------------------------------------------------------------------

describe('buildProposalFromKbEntry', () => {
  function makeEntry(overrides) {
    return Object.assign({
      slug: 'never-mock-db',
      bucket: 'facts',
      relPath: '.orchestray/kb/facts/never-mock-db.md',
      mtimeIso: '2026-08-19T00:00:00.000Z',
      frontmatter: { topic: 'never mock the database in integration tests, an anti-pattern' },
      body: 'This is a landmine that masked a broken migration last quarter. Never do this again.',
      title: 'Never mock the database',
    }, overrides || {});
  }

  test('produces a proposal that passes validateProposal', () => {
    const entry = makeEntry();
    const proposal = buildProposalFromKbEntry(entry, 'anti-pattern');
    const result = validateProposal(proposal, { strict: true });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  test('evidence_orch_id carries the kb- infix, distinct from a real orchestration id', () => {
    const entry = makeEntry();
    const proposal = buildProposalFromKbEntry(entry, 'anti-pattern');
    assert.match(proposal.evidence_orch_id, /^orch-kb-\d{8}$/);
  });

  test('name is prefixed kb- and satisfies the name regex', () => {
    const entry = makeEntry();
    const proposal = buildProposalFromKbEntry(entry, 'anti-pattern');
    assert.match(proposal.name, /^kb-[a-z0-9-]{2,61}$/);
  });

  test('buildKbProposalContent frontmatter carries provenance: kb and source path', () => {
    const entry = makeEntry();
    const proposal = buildProposalFromKbEntry(entry, 'anti-pattern');
    const content = buildKbProposalContent(proposal, entry);
    assert.match(content, /provenance: kb/);
    assert.match(content, /kb_source_path: \.orchestray\/kb\/facts\/never-mock-db\.md/);
    assert.match(content, /kb_source_bucket: facts/);
  });
});
