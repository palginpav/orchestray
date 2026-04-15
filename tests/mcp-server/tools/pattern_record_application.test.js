#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/pattern_record_application.js
 *
 * Per v2011c-stage2-plan.md §4, §6, §13; v2011b-architecture.md §3.2.2.
 *
 * Contract under test:
 *   module exports: { definition, handle }
 *
 *   async handle(input, context)
 *     -> { isError, content, structuredContent? }
 *
 * Behavior:
 *   - Increments frontmatter.times_applied by 1.
 *   - Sets frontmatter.last_applied to current ISO timestamp.
 *   - Preserves body and other frontmatter byte-identically.
 *   - Unknown slug -> isError: true, content mentions "pattern not found".
 *   - Path traversal attempts -> isError: true.
 *
 * Concurrent-writer behavior is undefined in Stage 2 — see v2011c-stage2-plan.md §6
 * This file only tests single-writer correctness.
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
} = require('../../../bin/mcp-server/tools/pattern_record_application.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pattern-record-test-'));
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
  const content = '---\n' + fmLines + '\n---\n\n' + (body || `# Pattern: ${slug}\n\nBody text.\n`);
  fs.writeFileSync(path.join(tmp, '.orchestray', 'patterns', slug + '.md'), content);
}

function readPatternRaw(tmp, slug) {
  return fs.readFileSync(path.join(tmp, '.orchestray', 'patterns', slug + '.md'), 'utf8');
}

function validInput(overrides = {}) {
  return {
    slug: 'sample',
    orchestration_id: 'orch-1744197600',
    outcome: 'applied',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

describe('pattern_record_application definition', () => {

  test('exports a tool definition with name "pattern_record_application"', () => {
    assert.equal(definition.name, 'pattern_record_application');
    assert.ok(typeof definition.description === 'string');
    assert.ok(definition.inputSchema);
  });

});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('pattern_record_application input validation', () => {

  test('rejects input missing slug', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ orchestration_id: 'orch-1', outcome: 'applied' }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.toLowerCase().includes('slug'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects input missing orchestration_id', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ slug: 'foo', outcome: 'applied' }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects input missing outcome', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle({ slug: 'foo', orchestration_id: 'orch-1' }, makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects outcome not in enum', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle(validInput({ outcome: 'magic' }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects slug longer than 200 chars', async () => {
    const tmp = makeTmpProject();
    try {
      const longSlug = 'x'.repeat(201);
      const result = await withCwd(tmp, () =>
        handle(validInput({ slug: longSlug }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects slug containing ".." (path traversal)', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle(validInput({ slug: '..' }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Behavior
// ---------------------------------------------------------------------------

describe('pattern_record_application behavior', () => {

  test('returns isError and "pattern not found" for unknown slug', async () => {
    const tmp = makeTmpProject();
    try {
      const result = await withCwd(tmp, () =>
        handle(validInput({ slug: 'nonexistent' }), makeContext(tmp))
      );
      assert.equal(result.isError, true);
      assert.ok(
        result.content[0].text.toLowerCase().includes('pattern not found') ||
        result.content[0].text.toLowerCase().includes('not found')
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('increments times_applied on applied outcome', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 2,
        last_applied: '2026-04-01T00:00:00Z',
      });
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const after = readPatternRaw(tmp, 'sample');
      assert.ok(after.includes('times_applied: 3'));
      assert.ok(!after.includes('times_applied: 2'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('updates last_applied to an ISO-8601 timestamp', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 0,
        last_applied: '2026-04-01T00:00:00Z',
      });
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const after = readPatternRaw(tmp, 'sample');
      // Some ISO-8601 form should appear on the last_applied line.
      const m = /last_applied:\s*(\S+)/.exec(after);
      assert.ok(m, 'last_applied line should exist');
      const iso = m[1].replace(/^['"]|['"]$/g, '');
      // Must parse as a valid Date and not be the old value.
      const parsed = new Date(iso);
      assert.ok(!Number.isNaN(parsed.getTime()), 'last_applied should be a valid Date');
      assert.notEqual(iso, '2026-04-01T00:00:00Z');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('adds times_applied field when missing from frontmatter', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample',
        category: 'decomposition',
        confidence: 0.7,
        // no times_applied, no last_applied
      });
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const after = readPatternRaw(tmp, 'sample');
      // Missing field should have been treated as 0 and incremented to 1
      // (per §6: "adds a missing field at end of frontmatter").
      assert.ok(after.includes('times_applied: 1'));
      assert.ok(/last_applied:/.test(after));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('preserves body and other frontmatter fields byte-identically', async () => {
    const tmp = makeTmpProject();
    try {
      const body = '\n# Pattern: Sample\n\n## Context\n\nThe body must not change.\n\n## Approach\n\n- bullet 1\n- bullet 2\n';
      writePattern(
        tmp,
        'sample',
        {
          name: 'sample',
          category: 'decomposition',
          confidence: 0.75,
          times_applied: 1,
          last_applied: '2026-04-01T00:00:00Z',
          description: 'A static description',
          created_from: 'orch-original',
        },
        body.slice(1) // body without leading \n since writer adds it
      );
      const before = readPatternRaw(tmp, 'sample');
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const after = readPatternRaw(tmp, 'sample');
      // All preserved fields should still appear unchanged.
      assert.ok(after.includes('name: sample'));
      assert.ok(after.includes('category: decomposition'));
      assert.ok(after.includes('confidence: 0.75'));
      assert.ok(after.includes('description: A static description'));
      assert.ok(after.includes('created_from: orch-original'));
      // Body lines should be unchanged.
      assert.ok(after.includes('## Context'));
      assert.ok(after.includes('The body must not change.'));
      assert.ok(after.includes('## Approach'));
      assert.ok(after.includes('- bullet 1'));
      assert.ok(after.includes('- bullet 2'));
      // The only changed lines should be times_applied and last_applied.
      const diffBefore = before.split('\n').filter((l) => !/^times_applied:|^last_applied:/.test(l));
      const diffAfter = after.split('\n').filter((l) => !/^times_applied:|^last_applied:/.test(l));
      assert.deepEqual(diffAfter, diffBefore, 'non-updated lines must be byte-identical');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('single writer: sequential calls increment monotonically', async () => {
    // Concurrent-writer behavior is undefined in Stage 2 — see v2011c-stage2-plan.md §6
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 0,
      });
      for (let i = 1; i <= 3; i++) {
        const result = await withCwd(tmp, () =>
          handle(validInput(), makeContext(tmp))
        );
        assert.equal(result.isError, false, `iteration ${i} should succeed`);
      }
      const after = readPatternRaw(tmp, 'sample');
      assert.ok(after.includes('times_applied: 3'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// W6 rate-limit: pre-check happens before pattern write; failure no count
// ---------------------------------------------------------------------------

const { COUNTS_FILE } = require('../../../bin/mcp-server/lib/tool-counts.js');

function makeContextWithLimit(tmp, maxPerTask) {
  return {
    projectRoot: tmp,
    pluginRoot: tmp,
    config: { mcp_server: { max_per_task: maxPerTask } },
    logger: () => {},
  };
}

function countLedgerRecords(tmp, orchId, taskId, toolName) {
  const lp = path.join(tmp, COUNTS_FILE);
  if (!fs.existsSync(lp)) return 0;
  const lines = fs.readFileSync(lp, 'utf8').split('\n').filter(Boolean);
  let n = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.orchestration_id === orchId && obj.task_id === taskId && obj.tool_name === toolName) n++;
    } catch (_) {}
  }
  return n;
}

describe('W6 rate-limit behavior', () => {

  test('rate-limit pre-check blocks call before pattern write when limit exceeded', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample', category: 'decomposition', confidence: 0.7, times_applied: 0,
      });

      // Pre-fill ledger to the limit.
      const lp = path.join(tmp, COUNTS_FILE);
      fs.mkdirSync(path.dirname(lp), { recursive: true });
      const record = (n) => JSON.stringify({
        ts: new Date().toISOString(),
        orchestration_id: 'orch-rl', task_id: 'task-rl', tool_name: 'pattern_record_application', n,
      }) + '\n';
      fs.writeFileSync(lp, record(1) + record(2));

      const ctx = makeContextWithLimit(tmp, { pattern_record_application: 2 });
      const result = await handle(
        validInput({ orchestration_id: 'orch-rl', task_id: 'task-rl' }),
        ctx
      );
      assert.equal(result.isError, true, 'should be blocked by rate limit');
      assert.ok(
        result.content[0].text.includes('rate limit') || result.content[0].text.includes('max_per_task'),
        'error must mention rate limit'
      );

      // Pattern file times_applied must NOT have been incremented.
      const raw = readPatternRaw(tmp, 'sample');
      assert.ok(raw.includes('times_applied: 0'), 'pattern file must not be modified when rate-limited');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('failed pattern_record_application (unknown slug) does not increment ledger counter', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContextWithLimit(tmp, { pattern_record_application: 10 });

      // Call with a slug that doesn't exist — handler will fail after pre-check.
      const result = await handle(
        validInput({ slug: 'nonexistent-rl', orchestration_id: 'orch-nc', task_id: 'task-nc' }),
        ctx
      );
      assert.equal(result.isError, true, 'should fail for unknown slug');

      // Counter must NOT have incremented on the failed call.
      const count = countLedgerRecords(tmp, 'orch-nc', 'task-nc', 'pattern_record_application');
      assert.equal(count, 0, 'failed call must not increment the counter');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('successful pattern_record_application increments ledger counter exactly once', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample', category: 'decomposition', confidence: 0.7, times_applied: 0,
      });
      const ctx = makeContextWithLimit(tmp, { pattern_record_application: 10 });

      const result = await handle(
        validInput({ orchestration_id: 'orch-once', task_id: 'task-once' }),
        ctx
      );
      assert.equal(result.isError, false);

      const count = countLedgerRecords(tmp, 'orch-once', 'task-once', 'pattern_record_application');
      assert.equal(count, 1, 'exactly one ledger record after one successful call');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
