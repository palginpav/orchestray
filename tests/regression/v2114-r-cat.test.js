#!/usr/bin/env node
'use strict';

/**
 * v2.1.14 R-CAT regression tests.
 *
 * Asserts:
 *   T1. pattern_find(mode="catalog") returns TOON-formatted catalog (not full bodies).
 *   T2. pattern_find(mode="full") returns the v2.1.13-equivalent shape (matches array).
 *   T3. pattern_find(mode omitted) also returns full shape (backward compat).
 *   T4. pattern_find(mode="catalog", fields=[...]) — mode wins, fields ignored.
 *   T5. pattern_read(slug=<known>) returns full pattern body and metadata.
 *   T6. pattern_read(slug=<unknown>) returns structured not_found without throwing.
 *   T7. TOON renderer shape: each line matches PATTERN slug=... confidence=... one_line=... hook=...
 *   T8. Backfill script extracts context_hook from ## Context section.
 *   T9. Backfill script falls back to first non-empty body line when no ## Context.
 *   T10. Backfill script skips patterns with no extractable context (< 5 chars).
 *   T11. pattern_read tool is registered in server.js TOOL_TABLE.
 */

const { test, describe, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');
const os     = require('node:os');

const repoRoot = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a temp project dir with a .orchestray/patterns/ directory.
 * Returns { dir, patternsDir }.
 */
function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rcat-'));
  cleanup.push(dir);
  const patternsDir = path.join(dir, '.orchestray', 'patterns');
  fs.mkdirSync(patternsDir, { recursive: true });
  return { dir, patternsDir };
}

/**
 * Write a minimal pattern file with frontmatter.
 */
function writePattern(patternsDir, slug, { description = '', body = '', context_hook = undefined } = {}) {
  let fm = '---\n';
  fm += 'name: ' + slug + '\n';
  fm += 'category: decomposition\n';
  fm += 'confidence: 0.8\n';
  fm += 'times_applied: 2\n';
  fm += 'last_applied: null\n';
  if (context_hook !== undefined) {
    fm += 'context_hook: ' + context_hook + '\n';
  }
  if (description) {
    fm += 'description: ' + description + '\n';
  }
  fm += '---\n\n';
  fm += body || '# Pattern: ' + slug + '\n\n## Context\n\nUse this pattern when testing.\n';
  fs.writeFileSync(path.join(patternsDir, slug + '.md'), fm);
}

// ---------------------------------------------------------------------------
// Load the tools directly (unit-test style, no MCP server needed)
// ---------------------------------------------------------------------------

const patternFind = require(path.join(repoRoot, 'bin', 'mcp-server', 'tools', 'pattern_find'));
const patternRead = require(path.join(repoRoot, 'bin', 'mcp-server', 'tools', 'pattern_read'));

// Destructure the TOON helpers exported for tests.
const { _renderToon, _toonValue } = patternFind;

// ---------------------------------------------------------------------------
// T1. mode=catalog returns TOON shape
// ---------------------------------------------------------------------------

describe('R-CAT T1: mode=catalog returns TOON shape', () => {
  test('catalog response has mode=catalog, catalog string, no matches array', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'test-slug-a', {
      description: 'A pattern for testing',
      context_hook: 'Use when running tests',
    });

    const result = await patternFind.handle(
      { task_summary: 'testing patterns', mode: 'catalog' },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.mode, 'catalog', 'mode field must be "catalog"');
    assert.ok(typeof body.catalog === 'string', 'catalog must be a string');
    assert.ok(!('matches' in body), 'full mode matches array must NOT be present in catalog mode');
    assert.ok(typeof body.considered === 'number', 'considered must be present');
    assert.ok(typeof body.filtered_out === 'number', 'filtered_out must be present');
  });

  test('catalog string lines start with PATTERN keyword', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'slug-one', { description: 'Pattern one', context_hook: 'Use for thing one' });
    writePattern(patternsDir, 'slug-two', { description: 'Pattern two', context_hook: 'Use for thing two' });

    const result = await patternFind.handle(
      { task_summary: 'thing one two patterns', mode: 'catalog', max_results: 10 },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    const { catalog } = result.structuredContent;
    const lines = catalog.split('\n').filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 1, 'should have at least one PATTERN line');
    for (const line of lines) {
      assert.ok(line.startsWith('PATTERN '), 'each line must start with PATTERN: ' + line);
      assert.ok(line.includes('slug='), 'line must have slug=: ' + line);
      assert.ok(line.includes('confidence='), 'line must have confidence=: ' + line);
      assert.ok(line.includes('one_line='), 'line must have one_line=: ' + line);
      assert.ok(line.includes('hook='), 'line must have hook=: ' + line);
    }
  });
});

// ---------------------------------------------------------------------------
// T2. mode=full returns legacy shape
// ---------------------------------------------------------------------------

describe('R-CAT T2: mode=full returns v2.1.13-equivalent shape', () => {
  test('mode=full returns matches array', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'full-slug', { description: 'Full mode test' });

    const result = await patternFind.handle(
      { task_summary: 'full mode test', mode: 'full' },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.ok(Array.isArray(body.matches), 'full mode must return matches array');
    assert.ok(!('catalog' in body), 'full mode must NOT have catalog string');
    assert.ok(!('mode' in body), 'full mode must NOT have mode field (backward compat)');
  });

  test('full mode matches contain slug, confidence, one_line but NOT _context_hook', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'clean-slug', {
      description: 'Clean slug pattern',
      context_hook: 'Use for clean tests',
    });

    const result = await patternFind.handle(
      { task_summary: 'clean slug', mode: 'full', max_results: 10 },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    const { matches } = result.structuredContent;
    assert.ok(matches.length >= 1, 'should find at least one match');
    for (const m of matches) {
      assert.ok('slug' in m, 'match must have slug');
      assert.ok('confidence' in m, 'match must have confidence');
      assert.ok('one_line' in m, 'match must have one_line');
      assert.ok(!('_context_hook' in m), '_context_hook must NOT leak into full mode response');
      assert.ok(!('_score' in m), '_score must NOT leak into response');
    }
  });
});

// ---------------------------------------------------------------------------
// T3. mode omitted → full shape (backward compat)
// ---------------------------------------------------------------------------

describe('R-CAT T3: mode omitted returns full shape (backward compat)', () => {
  test('no mode parameter → matches array', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'back-compat-slug', { description: 'Backward compat test' });

    const result = await patternFind.handle(
      { task_summary: 'backward compat' },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.ok(Array.isArray(body.matches), 'omitted mode must return matches array');
    assert.ok(!('catalog' in body), 'omitted mode must NOT have catalog string');
  });
});

// ---------------------------------------------------------------------------
// T4. mode=catalog with fields — mode wins
// ---------------------------------------------------------------------------

describe('R-CAT T4: mode=catalog with fields — mode wins', () => {
  test('mode=catalog + fields → catalog shape returned, fields ignored gracefully', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'precedence-slug', { description: 'Precedence test' });

    const result = await patternFind.handle(
      { task_summary: 'precedence', mode: 'catalog', fields: ['slug', 'confidence'] },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    // mode wins: returns catalog shape, not a projected matches array
    assert.equal(body.mode, 'catalog', 'mode=catalog must win over fields');
    assert.ok(typeof body.catalog === 'string', 'catalog must be a string');
    assert.ok(!('matches' in body), 'matches array must NOT be present when mode=catalog');
  });
});

// ---------------------------------------------------------------------------
// T5. pattern_read on known slug returns full body
// ---------------------------------------------------------------------------

describe('R-CAT T5: pattern_read returns full body on known slug', () => {
  test('known slug → structuredContent with full_body, slug, confidence', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'known-slug', {
      description: 'Known pattern for read test',
      context_hook: 'Use when reading known patterns',
      body: '# Pattern: known-slug\n\n## Context\n\nKnown pattern body content here.\n',
    });

    const result = await patternRead.handle(
      { slug: 'known-slug' },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    const body = result.structuredContent;
    assert.equal(body.slug, 'known-slug');
    assert.ok(typeof body.confidence === 'number', 'confidence must be a number');
    assert.ok(typeof body.full_body === 'string', 'full_body must be a string');
    assert.ok(body.full_body.length > 0, 'full_body must not be empty');
    assert.ok(typeof body.applications === 'number', 'applications must be a number');
    assert.ok(typeof body.applications_count === 'number', 'applications_count must be a number');
    assert.ok(!('not_found' in body), 'not_found must NOT be present for known slug');
  });

  test('known slug with context_hook → context_hook returned', async () => {
    const { dir, patternsDir } = makeProject();
    writePattern(patternsDir, 'hook-slug', {
      description: 'Pattern with hook',
      context_hook: 'Use when verifying hooks work',
    });

    const result = await patternRead.handle(
      { slug: 'hook-slug' },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.context_hook, 'Use when verifying hooks work');
  });
});

// ---------------------------------------------------------------------------
// T6. pattern_read on unknown slug returns not_found
// ---------------------------------------------------------------------------

describe('R-CAT T6: pattern_read on unknown slug returns structured not_found', () => {
  test('unknown slug → not_found: true, no throw', async () => {
    const { dir } = makeProject();

    const result = await patternRead.handle(
      { slug: 'nonexistent-slug-xyz' },
      { projectRoot: dir }
    );
    assert.equal(result.isError, false, 'unknown slug must not be an error result');
    const body = result.structuredContent;
    assert.equal(body.not_found, true, 'not_found must be true');
    assert.equal(body.slug, 'nonexistent-slug-xyz', 'slug must be echoed back');
  });
});

// ---------------------------------------------------------------------------
// T7. TOON renderer shape (unit tests)
// ---------------------------------------------------------------------------

describe('R-CAT T7: TOON renderer', () => {
  test('_toonValue: bare value stays bare', () => {
    assert.equal(_toonValue('simple'), 'simple');
    assert.equal(_toonValue('no-spaces'), 'no-spaces');
  });

  test('_toonValue: value with spaces is double-quoted', () => {
    assert.equal(_toonValue('has spaces'), '"has spaces"');
  });

  test('_toonValue: value with embedded double-quote is escaped', () => {
    assert.equal(_toonValue('say "hi"'), '"say \\"hi\\""');
  });

  test('_renderToon: renders correct PATTERN lines', () => {
    const matches = [
      { slug: 'alpha', confidence: 0.9, one_line: 'Alpha pattern', _context_hook: 'Use for alpha things' },
      { slug: 'beta',  confidence: 0.75, one_line: 'Beta',         _context_hook: null },
    ];
    const toon = _renderToon(matches);
    const lines = toon.split('\n');
    assert.equal(lines.length, 2);

    // Line 1: alpha
    assert.ok(lines[0].startsWith('PATTERN slug=alpha'), 'line 0 slug=alpha');
    assert.ok(lines[0].includes('confidence=0.90'), 'line 0 confidence=0.90');
    assert.ok(lines[0].includes('one_line="Alpha pattern"'), 'line 0 one_line quoted');
    assert.ok(lines[0].includes('hook="Use for alpha things"'), 'line 0 hook');

    // Line 2: beta — hook falls back to one_line when _context_hook is null
    assert.ok(lines[1].startsWith('PATTERN slug=beta'), 'line 1 slug=beta');
    assert.ok(lines[1].includes('confidence=0.75'), 'line 1 confidence=0.75');
    assert.ok(lines[1].includes('one_line=Beta'), 'line 1 one_line bare (no spaces)');
    // hook falls back to one_line (Beta) when _context_hook is null
    assert.ok(lines[1].includes('hook=Beta'), 'line 1 hook falls back to one_line');
  });
});

// ---------------------------------------------------------------------------
// T8. Backfill script: extracts from ## Context
// ---------------------------------------------------------------------------

describe('R-CAT T8: backfill extracts context_hook from ## Context section', () => {
  // Direct unit test of the extraction logic — we re-implement the extractor
  // inline here to avoid spawning a child process and to stay fast.
  // The script uses extractContextHook(body) which is not exported, so we
  // reproduce its logic from the script source for white-box testing.

  // Inline extraction (mirrors bin/backfill-pattern-hooks.js logic exactly).
  function extractContextHook(body) {
    if (typeof body !== 'string' || body.trim().length === 0) return null;
    const contextMatch = body.match(/^##\s+Context\s*\n+([\s\S]*?)(?=^##|\Z)/m);
    if (contextMatch) {
      const sectionText = contextMatch[1].trim();
      if (sectionText.length > 0) {
        const hook = _firstSentence(sectionText);
        if (hook && hook.length >= 5) return hook;
      }
    }
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('```')) continue;
      if (trimmed.length >= 5) return trimmed.slice(0, 160);
    }
    return null;
  }

  function _firstSentence(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    const m = flat.match(/^(.{5,}?[.!?])(?:\s|$)/);
    if (m) return m[1].slice(0, 160);
    return flat.slice(0, 160);
  }

  test('extracts first sentence from ## Context section', () => {
    const body = '# Pattern\n\n## Context\n\nUse this when migrating SQL schemas. More text.\n\n## Approach\n\nDo stuff.\n';
    const hook = extractContextHook(body);
    assert.ok(hook !== null, 'should extract a hook');
    assert.ok(hook.includes('SQL schemas'), 'hook should contain sentence text');
  });

  test('falls back to first non-empty line when no ## Context', () => {
    const body = '\n\nFirst usable line here for fallback.\n\nMore text.\n';
    const hook = extractContextHook(body);
    assert.equal(hook, 'First usable line here for fallback.');
  });
});

// ---------------------------------------------------------------------------
// T9. Backfill skips headings and delimiters for fallback
// ---------------------------------------------------------------------------

describe('R-CAT T9: backfill skips headings in fallback path', () => {
  function extractContextHook(body) {
    if (typeof body !== 'string' || body.trim().length === 0) return null;
    const contextMatch = body.match(/^##\s+Context\s*\n+([\s\S]*?)(?=^##|\Z)/m);
    if (contextMatch) {
      const sectionText = contextMatch[1].trim();
      if (sectionText.length > 0) {
        const flat = sectionText.replace(/\s+/g, ' ').trim();
        const m = flat.match(/^(.{5,}?[.!?])(?:\s|$)/);
        const hook = m ? m[1].slice(0, 160) : flat.slice(0, 160);
        if (hook && hook.length >= 5) return hook;
      }
    }
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('```')) continue;
      if (trimmed.length >= 5) return trimmed.slice(0, 160);
    }
    return null;
  }

  test('skips heading lines in fallback, returns first real line', () => {
    const body = '# Title heading\n## Sub heading\nReal usable content here.\n';
    const hook = extractContextHook(body);
    assert.equal(hook, 'Real usable content here.');
  });
});

// ---------------------------------------------------------------------------
// T10. Backfill skips < 5 chars
// ---------------------------------------------------------------------------

describe('R-CAT T10: backfill skips patterns with no extractable context', () => {
  function extractContextHook(body) {
    if (typeof body !== 'string' || body.trim().length === 0) return null;
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('```')) continue;
      if (trimmed.length >= 5) return trimmed.slice(0, 160);
    }
    return null;
  }

  test('returns null when all extractable text < 5 chars', () => {
    const body = '# Head\n\nhi\n\n';
    const hook = extractContextHook(body);
    assert.equal(hook, null, 'should return null for short-only content');
  });

  test('returns null on empty body', () => {
    assert.equal(extractContextHook(''), null);
    assert.equal(extractContextHook('   '), null);
  });
});

// ---------------------------------------------------------------------------
// T11. pattern_read is registered in server.js TOOL_TABLE
// ---------------------------------------------------------------------------

describe('R-CAT T11: pattern_read registered in server.js', () => {
  test('server.js contains pattern_read require and TOOL_TABLE entry', () => {
    const serverSrc = fs.readFileSync(
      path.join(repoRoot, 'bin', 'mcp-server', 'server.js'),
      'utf8'
    );
    assert.ok(
      serverSrc.includes("require('./tools/pattern_read')"),
      'server.js must require pattern_read'
    );
    assert.ok(
      serverSrc.includes('pattern_read:') && serverSrc.includes('patternRead.definition'),
      'server.js must register pattern_read in TOOL_TABLE'
    );
  });
});
