#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/history_find_similar_tasks.js
 *
 * Per v2011c-stage2-plan.md §4, §13; v2011b-architecture.md §3.2.4.
 *
 * Contract under test:
 *   module exports: { definition, handle }
 *
 *   async handle(input, context)
 *     -> { isError, content, structuredContent: { matches: [...] } }
 *
 * Similarity: case-folded token Jaccard against archived
 *   .orchestray/history/<orch-id>/tasks/<task-id>.md
 * computed over (title + first 200 body chars).
 *
 * Each match has { orch_id, task_id, similarity, outcome?, patterns_applied?, ref }.
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
} = require('../../../bin/mcp-server/tools/history_find_similar_tasks.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-find-similar-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
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

function writeTask(tmp, orchId, taskId, title, body) {
  const dir = path.join(tmp, '.orchestray', 'history', orchId, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const content = (title != null ? `# ${title}\n\n` : '') + (body || '');
  fs.writeFileSync(path.join(dir, taskId + '.md'), content);
}

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

describe('history_find_similar_tasks definition', () => {

  test('exports a tool definition with name "history_find_similar_tasks"', () => {
    assert.equal(definition.name, 'history_find_similar_tasks');
    assert.ok(definition.inputSchema);
  });

});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('history_find_similar_tasks input validation', () => {

  test('rejects input missing task_summary', async () => {
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

  test('rejects task_summary shorter than 3 chars', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ task_summary: 'ab' }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects task_summary longer than 1000 chars', async () => {
    const tmp = makeTmpProject();
    try {
      const long = 'x'.repeat(1001);
      const result = await withCwd(tmp, () =>
        handle({ task_summary: long }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects min_similarity outside [0,1]', async () => {
    const tmp = makeTmpProject();
    try {
      const neg = await withCwd(tmp, () =>
        handle({ task_summary: 'refactor reviewer', min_similarity: -0.1 }, makeContext(tmp))
      );
      const big = await withCwd(tmp, () =>
        handle({ task_summary: 'refactor reviewer', min_similarity: 1.5 }, makeContext(tmp))
      );
      assert.equal(neg.isError, true);
      assert.equal(big.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects limit outside [1,10]', async () => {
    const tmp = makeTmpProject();
    try {
      const low = await withCwd(tmp, () =>
        handle({ task_summary: 'foo bar', limit: 0 }, makeContext(tmp))
      );
      const high = await withCwd(tmp, () =>
        handle({ task_summary: 'foo bar', limit: 11 }, makeContext(tmp))
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

describe('history_find_similar_tasks behavior', () => {

  test('returns empty matches when no archives exist', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ task_summary: 'refactor reviewer to scan changed files only' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.matches, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns deterministic results for the same input (Jaccard is deterministic)', async () => {
    const tmp = makeTmpProject();
    try {
      writeTask(tmp, 'orch-a', 'T1', 'Refactor reviewer to scan only changed files', 'Scope the reviewer subagent to the files changed in the PR.');
      writeTask(tmp, 'orch-a', 'T2', 'Add caching layer to database queries', 'Introduce LRU cache for read-heavy endpoints.');
      writeTask(tmp, 'orch-b', 'T1', 'Reviewer scan scope tweak', 'Narrow reviewer scan to changed files and add tests.');

      const input = { task_summary: 'Refactor reviewer to scan changed files only' };
      const r1 = await withCwd(tmp, () => handle(input, makeContext(tmp)));
      const r2 = await withCwd(tmp, () => handle(input, makeContext(tmp)));
      const fp1 = r1.structuredContent.matches.map((m) => `${m.orch_id}:${m.task_id}:${m.similarity}`);
      const fp2 = r2.structuredContent.matches.map((m) => `${m.orch_id}:${m.task_id}:${m.similarity}`);
      assert.deepEqual(fp1, fp2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns matches sorted by similarity descending', async () => {
    const tmp = makeTmpProject();
    try {
      writeTask(tmp, 'orch-a', 'T1', 'Refactor reviewer to scan only changed files', 'Scope reviewer to changed files.');
      writeTask(tmp, 'orch-a', 'T2', 'Something totally unrelated about databases', 'Database caching improvements.');
      writeTask(tmp, 'orch-b', 'T1', 'Reviewer scan changed files scope adjustment', 'Changed files only reviewer subagent.');

      const result = await withCwd(tmp, () =>
        handle({ task_summary: 'refactor reviewer to scan changed files only' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const matches = result.structuredContent.matches;
      assert.ok(matches.length >= 2);
      for (let i = 1; i < matches.length; i++) {
        assert.ok(matches[i - 1].similarity >= matches[i].similarity,
          'matches must be sorted by similarity descending');
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('applies min_similarity filter', async () => {
    const tmp = makeTmpProject();
    try {
      writeTask(tmp, 'orch-a', 'T1', 'Refactor reviewer to scan only changed files', '');
      writeTask(tmp, 'orch-a', 'T2', 'Something totally unrelated about databases', '');
      const result = await withCwd(tmp, () =>
        handle(
          { task_summary: 'refactor reviewer to scan changed files only', min_similarity: 0.3 },
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      for (const m of result.structuredContent.matches) {
        assert.ok(m.similarity >= 0.3, `match similarity ${m.similarity} should be >= 0.3`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('respects limit cap', async () => {
    const tmp = makeTmpProject();
    try {
      for (let i = 0; i < 5; i++) {
        writeTask(tmp, 'orch-' + i, 'T1', 'Refactor reviewer to scan changed files ' + i, '');
      }
      const result = await withCwd(tmp, () =>
        handle(
          { task_summary: 'refactor reviewer to scan changed files', limit: 2 },
          makeContext(tmp)
        )
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length <= 2);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips task file with missing title and continues', async () => {
    const tmp = makeTmpProject();
    try {
      // Task with a proper title.
      writeTask(tmp, 'orch-a', 'T1', 'Refactor reviewer subagent', 'Body text here.');
      // Task with no title line (no "# " header).
      writeTask(tmp, 'orch-a', 'T2', null, 'Random body without any title line.\n');

      const result = await withCwd(tmp, () =>
        handle({ task_summary: 'refactor reviewer subagent' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      // The titled task should appear; the titleless one should be skipped.
      const ids = result.structuredContent.matches.map((m) => m.task_id);
      assert.ok(ids.includes('T1'));
      assert.ok(!ids.includes('T2'), 'titleless task must be skipped');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('each match contains orch_id, task_id, similarity, and ref', async () => {
    const tmp = makeTmpProject();
    try {
      writeTask(tmp, 'orch-1744197600', 'T1', 'Refactor reviewer to scan changed files', 'Body text.');
      const result = await withCwd(tmp, () =>
        handle({ task_summary: 'refactor reviewer to scan changed files' }, makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.ok(result.structuredContent.matches.length >= 1);
      const m = result.structuredContent.matches[0];
      assert.ok('orch_id' in m);
      assert.ok('task_id' in m);
      assert.ok('similarity' in m);
      assert.ok('ref' in m);
      assert.equal(typeof m.similarity, 'number');
      assert.ok(m.ref.startsWith('orchestray:history://'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
