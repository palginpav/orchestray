#!/usr/bin/env node
'use strict';

/**
 * Integration test: telemetry plumbing for pattern telemetry.
 *
 * Verifies two bugs fixed in v2.1.0 Phase A:
 *
 *   Bug 1 (F05): pattern_record_application increments times_applied on disk.
 *     Root cause: §22c in extraction-protocol.md previously instructed a manual
 *     file write instead of calling the MCP tool, so times_applied stayed 0.
 *     Fix: §22c now calls mcp__orchestray__pattern_record_application with
 *     outcome "applied-success"/"applied-failure".
 *
 *   Bug 2 (F02): pattern_record_skip_reason emits pattern_name in the
 *     pattern_skip_enriched audit event.
 *     Root cause: the PM prompt in tier1-orchestration.md §22b did not instruct
 *     callers to pass pattern_name, so all skip events had pattern_name: null.
 *     Fix: §22b now explicitly requires pattern_name (the slug from pattern_find).
 *
 * Test strategy: create a disposable tmp project directory, call the MCP tool
 * handlers directly with context.projectRoot injection. Tear down the tmp dir
 * in the finally block. No real pattern files are mutated.
 *
 * Runner: node --test bin/_lib/__tests__/telemetry-plumbing.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle: handleApplication } = require('../../mcp-server/tools/pattern_record_application.js');
const { handle: handleSkipReason } = require('../../mcp-server/tools/pattern_record_skip_reason.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-telemetry-plumbing-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function writePattern(tmp, slug, frontmatter) {
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = '---\n' + fmLines + '\n---\n\n# Pattern: ' + slug + '\n\nBody text.\n';
  fs.writeFileSync(path.join(tmp, '.orchestray', 'patterns', slug + '.md'), content);
}

function readPatternFrontmatter(tmp, slug) {
  const raw = fs.readFileSync(path.join(tmp, '.orchestray', 'patterns', slug + '.md'), 'utf8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('no frontmatter in ' + slug);
  const fm = {};
  for (const line of match[1].split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
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

// ---------------------------------------------------------------------------
// Bug 1: times_applied increments via pattern_record_application
// ---------------------------------------------------------------------------

describe('Bug 1 — times_applied is incremented by pattern_record_application', () => {

  test('calling handle with outcome "applied" increments times_applied by 1', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern',
        category: 'decomposition',
        confidence: 0.7,
        times_applied: 0,
        last_applied: 'null',
      });

      const result = await handleApplication(
        {
          slug: 'test-pattern',
          orchestration_id: 'orch-plumbing-test',
          outcome: 'applied',
        },
        makeContext(tmp)
      );

      assert.equal(result.isError, false, 'handle should succeed');
      const fm = readPatternFrontmatter(tmp, 'test-pattern');
      assert.equal(Number(fm.times_applied), 1, 'times_applied must be 1 after one call');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('calling handle with outcome "applied-success" increments times_applied by 1', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern',
        category: 'decomposition',
        confidence: 0.6,
        times_applied: 3,
        last_applied: '2026-01-01T00:00:00.000Z',
      });

      const result = await handleApplication(
        {
          slug: 'test-pattern',
          orchestration_id: 'orch-plumbing-test',
          outcome: 'applied-success',
        },
        makeContext(tmp)
      );

      assert.equal(result.isError, false, 'handle should succeed');
      const fm = readPatternFrontmatter(tmp, 'test-pattern');
      assert.equal(Number(fm.times_applied), 4, 'times_applied must be 4 after incrementing from 3');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('calling handle with outcome "applied-failure" increments times_applied by 1', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern',
        category: 'anti-pattern',
        confidence: 0.5,
        times_applied: 0,
        last_applied: 'null',
      });

      const result = await handleApplication(
        {
          slug: 'test-pattern',
          orchestration_id: 'orch-plumbing-test',
          outcome: 'applied-failure',
        },
        makeContext(tmp)
      );

      assert.equal(result.isError, false, 'handle should succeed');
      const fm = readPatternFrontmatter(tmp, 'test-pattern');
      assert.equal(Number(fm.times_applied), 1, 'times_applied must be 1 after one call from 0');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('result payload reports new times_applied value', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern',
        category: 'decomposition',
        confidence: 0.8,
        times_applied: 5,
        last_applied: '2026-01-01T00:00:00.000Z',
      });

      const result = await handleApplication(
        {
          slug: 'test-pattern',
          orchestration_id: 'orch-plumbing-test',
          outcome: 'applied',
        },
        makeContext(tmp)
      );

      assert.equal(result.isError, false);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.times_applied, 6, 'result payload must report incremented count');
      assert.equal(payload.slug, 'test-pattern');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Bug 2: pattern_record_skip_reason emits pattern_name in audit event
// ---------------------------------------------------------------------------

describe('Bug 2 — pattern_skip_enriched event carries pattern_name when slug is passed', () => {

  test('passing pattern_name produces pattern_name in emitted audit event', async () => {
    const capturedEvents = [];
    const ctx = {
      config: {},
      logger: () => {},
      auditSink: (ev) => capturedEvents.push(ev),
    };

    const result = await handleSkipReason(
      {
        orchestration_id: 'orch-plumbing-test',
        reason: 'all-irrelevant',
        pattern_name: 'some-pattern-slug',
        match_quality: 'weak-match',
        skip_category: 'contextual-mismatch',
      },
      ctx
    );

    assert.equal(result.isError, false, 'handle should succeed');
    assert.equal(capturedEvents.length, 1, 'exactly one audit event must be emitted');
    const ev = capturedEvents[0];
    assert.equal(ev.type, 'pattern_skip_enriched');
    assert.equal(ev.pattern_name, 'some-pattern-slug', 'pattern_name must be the passed slug');
  });

  test('omitting pattern_name results in pattern_name: null — documents the old broken state', async () => {
    // This test documents the root cause of Bug 2: when the caller omits pattern_name,
    // the tool records pattern_name: null in the audit event. The prompt fix in §22b
    // makes callers always pass pattern_name; this test verifies the tool's null-passthrough
    // behavior that made the bug possible.
    const capturedEvents = [];
    const ctx = {
      config: {},
      logger: () => {},
      auditSink: (ev) => capturedEvents.push(ev),
    };

    const result = await handleSkipReason(
      {
        orchestration_id: 'orch-plumbing-test',
        reason: 'all-stale',
        // pattern_name intentionally omitted
      },
      ctx
    );

    assert.equal(result.isError, false, 'tool should still succeed when pattern_name is omitted');
    assert.equal(capturedEvents.length, 1);
    const ev = capturedEvents[0];
    assert.equal(ev.type, 'pattern_skip_enriched');
    assert.equal(ev.pattern_name, null, 'omitting pattern_name produces null — fix is in the prompt, not the tool');
  });

  test('pattern_name appears in the tool result payload when provided', async () => {
    const ctx = {
      config: {},
      logger: () => {},
      auditSink: () => {},
    };

    const result = await handleSkipReason(
      {
        orchestration_id: 'orch-plumbing-test',
        reason: 'all-low-confidence',
        pattern_name: 'decomposition-parallel-writers',
        match_quality: 'strong-match',
        skip_category: 'stale',
        cited_confidence: 0.35,
      },
      ctx
    );

    assert.equal(result.isError, false);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.pattern_name, 'decomposition-parallel-writers');
    assert.equal(payload.skip_category, 'stale');
  });

});
