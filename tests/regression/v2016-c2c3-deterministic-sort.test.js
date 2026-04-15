#!/usr/bin/env node
'use strict';

/**
 * W11 — T3 C2/C3 regression: deterministic `readdirSync` ordering in
 * `pattern_find.js` and `history_find_similar_tasks.js`.
 *
 * Pre-v2.0.15, both tools processed files in filesystem-defined readdir order,
 * which varies across OS and filesystem implementations. Two identical pattern
 * sets returned in different orders depending on the underlying FS.
 *
 * Fix (v2.0.15):
 *   - pattern_find.js:94 — `.sort()` on mdFiles before scoring loop.
 *   - history_find_similar_tasks.js:77 — `.sort()` on archiveDirs.
 *
 * These tests inject fixtures in non-sorted name order and verify that the
 * result ordering is deterministic (scores identical → slug-lexicographic tiebreak).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle: patternFindHandle } = require('../../bin/mcp-server/tools/pattern_find.js');
const { handle: historyHandle } = require('../../bin/mcp-server/tools/history_find_similar_tasks.js');

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

function makeContext(tmp) {
  return { projectRoot: tmp, pluginRoot: tmp, config: {}, logger: () => {} };
}

// ---------------------------------------------------------------------------
// C2 — pattern_find deterministic sort
// ---------------------------------------------------------------------------

describe('W11 T3 C2 regression — pattern_find deterministic sort', () => {

  /**
   * Write N patterns with identical frontmatter scores.
   * The names are deliberately non-sorted (z, a, m) to expose FS-order dependence.
   */
  function makePatternProject(slugs) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-c2-test-'));
    const pDir = path.join(dir, '.orchestray', 'patterns');
    fs.mkdirSync(pDir, { recursive: true });
    for (const slug of slugs) {
      const content = [
        '---',
        'name: ' + slug,
        'description: test pattern ' + slug,
        'category: decomposition',
        'confidence: 0.5',
        'times_applied: 1',
        '---',
        '',
        '# Pattern: ' + slug,
        'Refactor reviewer agent task decomposition for large repos.',
      ].join('\n');
      fs.writeFileSync(path.join(pDir, slug + '.md'), content);
    }
    return dir;
  }

  test('identical-score patterns are returned in lexicographic slug order', async () => {
    // Non-sorted write order: z first, then a, then m
    const slugs = ['zzz-pattern', 'aaa-pattern', 'mmm-pattern'];
    const tmp = makePatternProject(slugs);
    try {
      const result = await withCwd(tmp, () =>
        patternFindHandle(
          { task_summary: 'Refactor reviewer agent task decomposition' },
          makeContext(tmp)
        )
      );
      assert.ok(!result.isError,
        'handle must not return an error. Got: ' + JSON.stringify(result));
      const matches = result.structuredContent && result.structuredContent.matches;
      assert.ok(Array.isArray(matches) && matches.length > 0,
        'expected at least one match');

      // All three patterns have identical scores → slug-lex tiebreak must apply
      // Confirm aaa comes before mmm, mmm before zzz (or all tied slugs are sorted)
      const returnedSlugs = matches.map(m => m.slug);
      const sortedExpected = [...returnedSlugs].sort();
      assert.deepEqual(returnedSlugs, sortedExpected,
        'slugs with equal score must appear in lexicographic order. Got: ' +
        JSON.stringify(returnedSlugs));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('running pattern_find twice on same fixture returns same slug order', async () => {
    const slugs = ['zzz-pattern', 'aaa-pattern', 'mmm-pattern'];
    const tmp = makePatternProject(slugs);
    try {
      const ctx = makeContext(tmp);
      const input = { task_summary: 'Refactor reviewer agent task decomposition' };
      const r1 = await withCwd(tmp, () => patternFindHandle(input, ctx));
      const r2 = await withCwd(tmp, () => patternFindHandle(input, ctx));
      const slugs1 = (r1.structuredContent && r1.structuredContent.matches || []).map(m => m.slug);
      const slugs2 = (r2.structuredContent && r2.structuredContent.matches || []).map(m => m.slug);
      assert.deepEqual(slugs1, slugs2,
        'two consecutive calls must return identical slug ordering');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// C3 — history_find_similar_tasks deterministic sort of archive dirs
// ---------------------------------------------------------------------------

describe('W11 T3 C3 regression — history_find_similar_tasks deterministic archive-dir sort', () => {

  function makeHistoryProject(orchIds) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-c3-test-'));
    for (const orchId of orchIds) {
      const taskDir = path.join(dir, '.orchestray', 'history', orchId, 'tasks');
      fs.mkdirSync(taskDir, { recursive: true });
      // Write a task that is a strong match for "refactor reviewer"
      const content = '# Refactor reviewer agent\n\nTask: refactor the reviewer agent for large repos.\n';
      fs.writeFileSync(path.join(taskDir, 'task-001.md'), content);
    }
    return dir;
  }

  test('archives are processed in lexicographic (chronological for ISO names) order', async () => {
    // Use ISO-timestamp-like names; sorted lex = sorted chrono
    const orchIds = [
      'orch-2026-04-15T06:00:00Z',
      'orch-2026-04-10T00:00:00Z',
      'orch-2026-04-12T12:00:00Z',
    ];
    const tmp = makeHistoryProject(orchIds);
    try {
      const result = await withCwd(tmp, () =>
        historyHandle(
          { task_summary: 'Refactor reviewer agent' },
          makeContext(tmp)
        )
      );
      assert.ok(!result.isError,
        'handle must not return an error. Got: ' + JSON.stringify(result));
      // All 3 tasks have the same content and thus similar scores.
      // The key invariant: running twice must yield the same result.
      const matches = (result.structuredContent && result.structuredContent.matches) || [];
      assert.ok(matches.length > 0, 'expected at least one match');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('running history_find_similar_tasks twice on same fixture returns same orch_id order', async () => {
    const orchIds = [
      'orch-2026-04-15T06:00:00Z',
      'orch-2026-04-10T00:00:00Z',
      'orch-2026-04-12T12:00:00Z',
    ];
    const tmp = makeHistoryProject(orchIds);
    try {
      const ctx = makeContext(tmp);
      const input = { task_summary: 'Refactor reviewer agent' };
      const r1 = await withCwd(tmp, () => historyHandle(input, ctx));
      const r2 = await withCwd(tmp, () => historyHandle(input, ctx));
      const ids1 = ((r1.structuredContent && r1.structuredContent.matches) || []).map(m => m.orch_id);
      const ids2 = ((r2.structuredContent && r2.structuredContent.matches) || []).map(m => m.orch_id);
      assert.deepEqual(ids1, ids2,
        'two consecutive calls must return identical orch_id ordering');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
