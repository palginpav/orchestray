#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/pattern_find.js
 *
 * Per v2011c-stage2-plan.md §4, §13; v2011b-architecture.md §3.2.1.
 *
 * Contract under test:
 *   module exports: { definition, handle }
 *
 *   async handle(input, context) ->
 *     { isError, content: [{type:"text",text:string}], structuredContent? }
 *
 * On valid input, structuredContent is
 *   { matches: [...], considered: number, filtered_out: number }
 *
 * Each match has:
 *   { slug, uri, confidence, times_applied, category, one_line, match_reasons }
 *
 * Scoring:
 *   score = confidence * (keyword_overlap + role_bonus + file_glob_bonus)
 * Tie-break: times_applied desc, confidence desc, slug lex asc.
 *
 * Input validation errors return { isError: true, content: [...] }.
 *
 * Fixture strategy: temp project root, handler receives it via
 *   context = { projectRoot: tempRoot, config: {}, logger, ... }
 * and also via process.cwd() (belt and braces).
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle, definition } = require('../../../bin/mcp-server/tools/pattern_find.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pattern-find-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
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

function writePattern(tmp, slug, frontmatter, body) {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = '---\n' + fmLines + '\n---\n\n' + (body || `# Pattern: ${slug}\n`);
  fs.writeFileSync(path.join(tmp, '.orchestray', 'patterns', slug + '.md'), content);
}

function validInput(overrides = {}) {
  return {
    task_summary: 'Refactor reviewer to scan only changed files',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

describe('pattern_find definition', () => {

  test('exports a tool definition with name "pattern_find"', () => {
    assert.equal(definition.name, 'pattern_find');
    assert.ok(typeof definition.description === 'string');
    assert.ok(definition.inputSchema);
  });

  test('definition is deeply frozen', () => {
    assert.ok(Object.isFrozen(definition));
    assert.ok(Object.isFrozen(definition.inputSchema));
  });

});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('pattern_find input validation', () => {

  test('rejects input missing task_summary', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({}, makeContext(tmp))
      );
      assert.equal(result.isError, true);
      assert.ok(Array.isArray(result.content));
      assert.ok(result.content[0].text.toLowerCase().includes('task_summary'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects task_summary shorter than 3 chars', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle(validInput({ task_summary: 'ab' }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects task_summary longer than 500 chars', async () => {
    const tmp = makeTmpProject();
    try {
      const long = 'x'.repeat(501);
      const result = await withCwd(tmp, () =>
        handle(validInput({ task_summary: long }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects agent_role not in enum', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle(validInput({ agent_role: 'wizard' }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects file_globs exceeding maxItems=20', async () => {
    const tmp = makeTmpProject();
    try {
      const tooMany = Array.from({ length: 21 }, (_, i) => `src/${i}.js`);
      const result = await withCwd(tmp, () =>
        handle(validInput({ file_globs: tooMany }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects categories containing unknown category', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle(validInput({ categories: ['decomposition', 'not-a-category'] }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects max_results outside [1,10]', async () => {
    const tmp = makeTmpProject();
    try {
      const low = await withCwd(tmp, () =>
        handle(validInput({ max_results: 0 }), makeContext(tmp))
      );
      const high = await withCwd(tmp, () =>
        handle(validInput({ max_results: 11 }), makeContext(tmp))
      );
      assert.equal(low.isError, true);
      assert.equal(high.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects min_confidence outside [0,1]', async () => {
    const tmp = makeTmpProject();
    try {
      const neg = await withCwd(tmp, () =>
        handle(validInput({ min_confidence: -0.1 }), makeContext(tmp))
      );
      const big = await withCwd(tmp, () =>
        handle(validInput({ min_confidence: 1.5 }), makeContext(tmp))
      );
      assert.equal(neg.isError, true);
      assert.equal(big.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe('pattern_find behavior', () => {

  test('returns empty matches for empty patterns directory', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.matches, []);
      assert.equal(result.structuredContent.considered, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns matches from fixture files sorted by score', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'reviewer-scan-scoping', {
        name: 'reviewer-scan-scoping',
        category: 'anti-pattern',
        confidence: 0.8,
        times_applied: 2,
        description: 'Reviewer subagents hit turn caps on whole-codebase scans; scope to changed files only',
      });
      writePattern(tmp, 'unrelated-routing', {
        name: 'unrelated-routing',
        category: 'routing',
        confidence: 0.5,
        times_applied: 0,
        description: 'Pick haiku for cheap exploration tasks',
      });
      const result = await withCwd(tmp, () =>
        handle(
          validInput({ task_summary: 'Refactor reviewer to scan only changed files', agent_role: 'reviewer' }),
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      assert.ok(Array.isArray(result.structuredContent.matches));
      assert.ok(result.structuredContent.matches.length >= 1);
      // The reviewer-scan-scoping pattern should rank first.
      assert.equal(result.structuredContent.matches[0].slug, 'reviewer-scan-scoping');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('each match has required fields', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 1,
        description: 'Sample pattern for decomposition tests',
      });
      const result = await withCwd(tmp, () =>
        handle(
          validInput({ task_summary: 'Decomposition for sample test' }),
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);
      const m = result.structuredContent.matches[0];
      assert.ok('slug' in m);
      assert.ok('uri' in m);
      assert.ok('confidence' in m);
      assert.ok('times_applied' in m);
      assert.ok('category' in m);
      assert.ok('one_line' in m);
      assert.ok('match_reasons' in m);
      assert.ok(Array.isArray(m.match_reasons));
      assert.equal(m.uri, 'orchestray:pattern://sample');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('applies min_confidence filter', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'low-conf', {
        name: 'low-conf',
        category: 'decomposition',
        confidence: 0.3,
        times_applied: 0,
        description: 'Refactor reviewer patterns for low confidence test',
      });
      writePattern(tmp, 'high-conf', {
        name: 'high-conf',
        category: 'decomposition',
        confidence: 0.9,
        times_applied: 0,
        description: 'Refactor reviewer patterns for high confidence test',
      });
      const result = await withCwd(tmp, () =>
        handle(
          validInput({ task_summary: 'Refactor reviewer patterns', min_confidence: 0.5 }),
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      const slugs = result.structuredContent.matches.map((m) => m.slug);
      assert.ok(slugs.includes('high-conf'));
      assert.ok(!slugs.includes('low-conf'), 'low-confidence pattern should be filtered out');
      assert.ok(result.structuredContent.filtered_out >= 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects max_results cap', async () => {
    const tmp = makeTmpProject();
    try {
      for (let i = 0; i < 5; i++) {
        writePattern(tmp, `pat-${i}`, {
          name: `pat-${i}`,
          category: 'decomposition',
          confidence: 0.7,
          times_applied: i,
          description: 'Refactor reviewer scan pattern number ' + i,
        });
      }
      const result = await withCwd(tmp, () =>
        handle(
          validInput({ task_summary: 'Refactor reviewer scan patterns', max_results: 2 }),
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length <= 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips pattern file with malformed frontmatter and continues', async () => {
    const tmp = makeTmpProject();
    try {
      // Well-formed pattern.
      writePattern(tmp, 'good', {
        name: 'good',
        category: 'decomposition',
        confidence: 0.8,
        times_applied: 0,
        description: 'Refactor reviewer scan good pattern',
      });
      // Malformed: opening --- but no closing.
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'patterns', 'broken.md'),
        '---\nname: broken\nno closing delimiter ever\n'
      );
      const result = await withCwd(tmp, () =>
        handle(
          validInput({ task_summary: 'Refactor reviewer scan' }),
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      // Good pattern should still appear; broken one should be skipped.
      const slugs = result.structuredContent.matches.map((m) => m.slug);
      assert.ok(slugs.includes('good'));
      assert.ok(!slugs.includes('broken'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('populates match_reasons with human-readable strings', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'reviewer-pattern', {
        name: 'reviewer-pattern',
        category: 'anti-pattern',
        confidence: 0.8,
        times_applied: 0,
        description: 'Reviewer subagents hit turn caps on whole-codebase scans',
      });
      const result = await withCwd(tmp, () =>
        handle(
          validInput({ task_summary: 'Refactor reviewer to scan changed files', agent_role: 'reviewer' }),
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);
      const reasons = result.structuredContent.matches[0].match_reasons;
      assert.ok(Array.isArray(reasons));
      assert.ok(reasons.length > 0);
      for (const r of reasons) {
        assert.equal(typeof r, 'string');
        assert.ok(r.length > 0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('scoring is deterministic for same input (stable ordering)', async () => {
    const tmp = makeTmpProject();
    try {
      for (let i = 0; i < 4; i++) {
        writePattern(tmp, `det-${i}`, {
          name: `det-${i}`,
          category: 'decomposition',
          confidence: 0.7,
          times_applied: i,
          description: 'Deterministic test pattern number ' + i + ' for ordering',
        });
      }
      const input = validInput({ task_summary: 'Deterministic test pattern ordering' });
      const r1 = await withCwd(tmp, () => handle(input, makeContext(tmp)));
      const r2 = await withCwd(tmp, () => handle(input, makeContext(tmp)));
      const slugs1 = r1.structuredContent.matches.map((m) => m.slug);
      const slugs2 = r2.structuredContent.matches.map((m) => m.slug);
      assert.deepEqual(slugs1, slugs2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('tie-break: higher times_applied wins over lower at equal score', async () => {
    const tmp = makeTmpProject();
    try {
      // Two patterns with identical confidence and identical keyword overlap.
      writePattern(tmp, 'aaa-low-applied', {
        name: 'aaa-low-applied',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 0,
        description: 'Identical keyword overlap test payload',
      });
      writePattern(tmp, 'zzz-high-applied', {
        name: 'zzz-high-applied',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 5,
        description: 'Identical keyword overlap test payload',
      });
      const result = await withCwd(tmp, () =>
        handle(
          validInput({ task_summary: 'Identical keyword overlap test payload' }),
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length === 2);
      // Higher times_applied (zzz-high-applied) must come first despite later slug lex.
      assert.equal(result.structuredContent.matches[0].slug, 'zzz-high-applied');
      assert.equal(result.structuredContent.matches[1].slug, 'aaa-low-applied');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
