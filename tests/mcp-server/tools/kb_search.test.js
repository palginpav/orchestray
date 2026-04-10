#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/kb_search.js
 *
 * Per v2011c-stage2-plan.md §4, §13; v2011b-architecture.md §3.2.5.
 *
 * Contract under test:
 *   module exports: { definition, handle }
 *
 *   async handle(input, context)
 *     -> { isError, content, structuredContent: { matches: [...] } }
 *
 * Each match has { slug, section, uri, excerpt, score }.
 * Scans .orchestray/kb/{facts,decisions,artifacts}. Reads filesystem
 * directly (ignores any kb/index.json that may be out of sync).
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  handle,
  definition,
} = require('../../../bin/mcp-server/tools/kb_search.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-kb-search-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  return dir;
}

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

function makeContext(tmp, overrides = {}) {
  return {
    projectRoot: tmp,
    pluginRoot: tmp,
    config: {},
    logger: () => {},
    ...overrides,
  };
}

function writeKbFile(tmp, section, slug, content) {
  fs.writeFileSync(path.join(tmp, '.orchestray', 'kb', section, slug + '.md'), content);
}

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

describe('kb_search definition', () => {

  test('exports a tool definition with name "kb_search"', () => {
    assert.equal(definition.name, 'kb_search');
    assert.ok(definition.inputSchema);
  });

});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('kb_search input validation', () => {

  test('rejects input missing query', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({}, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects query shorter than 2 chars', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ query: 'a' }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects query longer than 500 chars', async () => {
    const tmp = makeTmpProject();
    try {
      const long = 'x'.repeat(501);
      const result = await withCwd(tmp, () =>
        handle({ query: long }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects kb_sections containing unknown section', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ query: 'hello', kb_sections: ['facts', 'rumors'] }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects limit outside [1,20]', async () => {
    const tmp = makeTmpProject();
    try {
      const low = await withCwd(tmp, () =>
        handle({ query: 'hello', limit: 0 }, makeContext(tmp))
      );
      const high = await withCwd(tmp, () =>
        handle({ query: 'hello', limit: 21 }, makeContext(tmp))
      );
      assert.equal(low.isError, true);
      assert.equal(high.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe('kb_search behavior', () => {

  test('returns empty for non-existent kb directory', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-kb-empty-'));
    try {
      fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
      const result = await withCwd(tmp, () =>
        handle({ query: 'reviewer' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.matches, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('scans all three sections by default', async () => {
    const tmp = makeTmpProject();
    try {
      writeKbFile(tmp, 'facts', 'fact-reviewer', '# Reviewer fact\n\nThe reviewer subagent scans files.\n');
      writeKbFile(tmp, 'decisions', 'dec-reviewer', '# Reviewer decision\n\nReviewer uses changed-file scoping.\n');
      writeKbFile(tmp, 'artifacts', 'art-reviewer', '# Reviewer artifact\n\nReviewer audit checklist.\n');
      const result = await withCwd(tmp, () =>
        handle({ query: 'reviewer' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const sections = new Set(result.structuredContent.matches.map((m) => m.section));
      assert.ok(sections.has('facts'));
      assert.ok(sections.has('decisions'));
      assert.ok(sections.has('artifacts'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects kb_sections filter', async () => {
    const tmp = makeTmpProject();
    try {
      writeKbFile(tmp, 'facts', 'fact-reviewer', '# Reviewer fact\n\nThe reviewer subagent scans files.\n');
      writeKbFile(tmp, 'decisions', 'dec-reviewer', '# Reviewer decision\n\nReviewer uses changed-file scoping.\n');
      writeKbFile(tmp, 'artifacts', 'art-reviewer', '# Reviewer artifact\n\nReviewer audit checklist.\n');
      const result = await withCwd(tmp, () =>
        handle({ query: 'reviewer', kb_sections: ['facts'] }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      for (const m of result.structuredContent.matches) {
        assert.equal(m.section, 'facts');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('each match has slug, section, uri, excerpt, score', async () => {
    const tmp = makeTmpProject();
    try {
      writeKbFile(tmp, 'facts', 'repo-map', '# Repo map\n\nThe repo is organized into hooks, agents, bin.\n');
      const result = await withCwd(tmp, () =>
        handle({ query: 'repo' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);
      const m = result.structuredContent.matches[0];
      assert.ok('slug' in m);
      assert.ok('section' in m);
      assert.ok('uri' in m);
      assert.ok('excerpt' in m);
      assert.ok('score' in m);
      assert.equal(m.slug, 'repo-map');
      assert.equal(m.section, 'facts');
      assert.equal(m.uri, 'orchestray:kb://facts/repo-map');
      assert.equal(typeof m.score, 'number');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('sorts matches by score descending', async () => {
    const tmp = makeTmpProject();
    try {
      // File with many keyword hits.
      writeKbFile(tmp, 'facts', 'high-hit', '# Reviewer reviewer reviewer\n\nReviewer reviewer.\n');
      // File with few keyword hits.
      writeKbFile(tmp, 'facts', 'low-hit', '# Something else\n\nReviewer once.\n');
      const result = await withCwd(tmp, () =>
        handle({ query: 'reviewer' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const matches = result.structuredContent.matches;
      assert.ok(matches.length >= 2);
      for (let i = 1; i < matches.length; i++) {
        assert.ok(matches[i - 1].score >= matches[i].score,
          'matches must be sorted by score descending');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reads filesystem directly, ignoring stale kb/index.json', async () => {
    const tmp = makeTmpProject();
    try {
      // Write a stale index.json that claims a file exists when it does not,
      // and omits a file that does exist on disk.
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'kb', 'index.json'),
        JSON.stringify({
          facts: ['ghost-entry'],
          decisions: [],
          artifacts: [],
        })
      );
      writeKbFile(tmp, 'facts', 'real-entry', '# Real entry\n\nReviewer content that should be found.\n');
      const result = await withCwd(tmp, () =>
        handle({ query: 'reviewer' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const slugs = result.structuredContent.matches.map((m) => m.slug);
      // The real on-disk file should be found.
      assert.ok(slugs.includes('real-entry'));
      // The ghost entry in index.json should NOT be returned.
      assert.ok(!slugs.includes('ghost-entry'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects limit cap', async () => {
    const tmp = makeTmpProject();
    try {
      for (let i = 0; i < 5; i++) {
        writeKbFile(tmp, 'facts', 'entry-' + i, `# Reviewer entry ${i}\n\nReviewer content ${i}.\n`);
      }
      const result = await withCwd(tmp, () =>
        handle({ query: 'reviewer', limit: 2 }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length <= 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
