#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/pattern_record_application.js
 *
 * pattern-application-evidence-design.md §7.1 (v2.3.19 Phase 2): this tool
 * is now the out-of-band self-report channel. It no longer mutates pattern
 * frontmatter — see times-applied-undercount-diagnosis.md for why direct
 * mutation from a cheap self-report call was the root cause of the 26-vs-6945
 * gradient.
 *
 * Contract under test:
 *   module exports: { definition, handle }
 *
 *   async handle(input, context)
 *     -> { isError, content, structuredContent? }
 *
 * Behavior:
 *   - Does NOT mutate times_applied / last_applied in the pattern file.
 *   - Appends a `source: "self_report"` ack row to
 *     .orchestray/state/pattern-acks.jsonl.
 *   - Emits a typed `pattern_application_recorded` event with
 *     evidence_grade: "self_report".
 *   - Unknown slug -> isError: true, content mentions "pattern not found".
 *   - Path traversal attempts -> isError: true.
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

function readAckRows(tmp) {
  const p = path.join(tmp, '.orchestray', 'state', 'pattern-acks.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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
// Behavior — self-report, no frontmatter mutation
// ---------------------------------------------------------------------------

describe('pattern_record_application behavior (self-report channel)', () => {

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

  test('does NOT mutate times_applied or last_applied on the pattern file', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 2,
        last_applied: '2026-04-01T00:00:00Z',
      });
      const before = readPatternRaw(tmp, 'sample');
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const after = readPatternRaw(tmp, 'sample');
      assert.equal(after, before, 'pattern frontmatter must be byte-identical — no mutation');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('response reports current (unchanged) times_applied and evidence_grade self_report', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', {
        name: 'sample', category: 'decomposition', confidence: 0.7, times_applied: 5,
      });
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.times_applied, 5);
      assert.equal(result.structuredContent.evidence_grade, 'self_report');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('appends a source:"self_report" row to pattern-acks.jsonl', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', { name: 'sample', category: 'decomposition', confidence: 0.7, times_applied: 0 });
      const result = await withCwd(tmp, () =>
        handle(validInput({ note: 'applied in-line during PM review' }), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const rows = readAckRows(tmp);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source, 'self_report');
      assert.equal(rows[0].orchestration_id, 'orch-1744197600');
      assert.equal(rows[0].used.length, 1);
      assert.equal(rows[0].used[0].slug, 'sample');
      assert.ok(rows[0].used[0].how_len > 0);
      assert.deepEqual(rows[0].rejected, []);
      assert.equal(rows[0].agent_status, 'success');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('outcome "applied-failure" maps to agent_status "failure" in the ack row', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', { name: 'sample', category: 'decomposition', confidence: 0.7, times_applied: 0 });
      const result = await withCwd(tmp, () =>
        handle(validInput({ outcome: 'applied-failure' }), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const rows = readAckRows(tmp);
      assert.equal(rows[0].agent_status, 'failure');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits a typed pattern_application_recorded event with evidence_grade self_report', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', { name: 'sample', category: 'decomposition', confidence: 0.7, times_applied: 3 });
      const result = await withCwd(tmp, () =>
        handle(validInput(), makeContext(tmp))
      );
      assert.equal(result.isError, false);
      const events = readEvents(tmp).filter((e) => e.type === 'pattern_application_recorded');
      assert.equal(events.length, 1, 'fixes §0.3 — this event type was never emitted before');
      assert.equal(events[0].slug, 'sample');
      assert.equal(events[0].pattern_name, 'sample');
      assert.equal(events[0].evidence_grade, 'self_report');
      assert.equal(events[0].times_applied_before, 3);
      assert.equal(events[0].times_applied_after, 3, 'no mutation happened — before/after must match');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('multiple calls append multiple ack rows and events (no counter to interleave on)', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'sample', { name: 'sample', category: 'decomposition', confidence: 0.7, times_applied: 0 });
      for (let i = 1; i <= 3; i++) {
        const result = await withCwd(tmp, () => handle(validInput(), makeContext(tmp)));
        assert.equal(result.isError, false, `iteration ${i} should succeed`);
      }
      assert.equal(readAckRows(tmp).length, 3);
      assert.equal(readEvents(tmp).filter((e) => e.type === 'pattern_application_recorded').length, 3);
      // Frontmatter is still untouched after repeated calls.
      const after = readPatternRaw(tmp, 'sample');
      assert.ok(after.includes('times_applied: 0'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// W6 rate-limit: pre-check happens before any ledger/event write
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

  test('rate-limit pre-check blocks call before any ledger write when limit exceeded', async () => {
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

      // No ack row must have been written when rate-limited.
      assert.equal(readAckRows(tmp).length, 0, 'ack ledger must not be written when rate-limited');
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
