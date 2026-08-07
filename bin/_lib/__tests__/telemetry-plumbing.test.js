#!/usr/bin/env node
'use strict';

/**
 * Integration test: telemetry plumbing for pattern telemetry.
 *
 * Verifies two bugs fixed in v2.1.0 Phase A:
 *
 *   Bug 1 (F05, superseded by pattern-application-evidence-design.md §7.1,
 *   v2.3.19 Phase 2): pattern_record_application used to increment
 *   times_applied on disk directly. That made it the same cheap self-report
 *   shape as pattern_record_skip_reason, and produced the 26-vs-6945 gradient
 *   diagnosed in times-applied-undercount-diagnosis.md. It is now the
 *   out-of-band self-report channel: no frontmatter mutation, a
 *   source:"self_report" ack row, and a typed pattern_application_recorded
 *   event with evidence_grade:"self_report" — joined through the same §5
 *   bounds as spawn-observed applications at orchestration close.
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
// Bug 1 (superseded): pattern_record_application is now self-report only
// ---------------------------------------------------------------------------

describe('Bug 1 (superseded) — pattern_record_application no longer mutates times_applied; ' +
         'it writes a self-report ack row + typed event instead', () => {

  test('calling handle with outcome "applied" does NOT change times_applied on disk', async () => {
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
      assert.equal(Number(fm.times_applied), 0, 'times_applied must stay 0 — commit happens at §4.3 Phase 3');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('calling handle appends a source:"self_report" row to pattern-acks.jsonl', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern', category: 'decomposition', confidence: 0.6, times_applied: 3,
      });

      const result = await handleApplication(
        { slug: 'test-pattern', orchestration_id: 'orch-plumbing-test', outcome: 'applied-success' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false, 'handle should succeed');
      const ackPath = path.join(tmp, '.orchestray', 'state', 'pattern-acks.jsonl');
      assert.ok(fs.existsSync(ackPath), 'pattern-acks.jsonl must exist after a self-report call');
      const row = JSON.parse(fs.readFileSync(ackPath, 'utf8').trim());
      assert.equal(row.source, 'self_report');
      assert.equal(row.used[0].slug, 'test-pattern');
      assert.equal(row.agent_status, 'success');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('outcome "applied-failure" maps to agent_status "failure" and still does not mutate frontmatter', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern', category: 'anti-pattern', confidence: 0.5, times_applied: 0,
      });

      const result = await handleApplication(
        { slug: 'test-pattern', orchestration_id: 'orch-plumbing-test', outcome: 'applied-failure' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false, 'handle should succeed');
      const fm = readPatternFrontmatter(tmp, 'test-pattern');
      assert.equal(Number(fm.times_applied), 0, 'still no mutation on the failure outcome');
      const ackPath = path.join(tmp, '.orchestray', 'state', 'pattern-acks.jsonl');
      const row = JSON.parse(fs.readFileSync(ackPath, 'utf8').trim());
      assert.equal(row.agent_status, 'failure');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('result payload reports the CURRENT (unchanged) times_applied and evidence_grade self_report', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern', category: 'decomposition', confidence: 0.8, times_applied: 5,
      });

      const result = await handleApplication(
        { slug: 'test-pattern', orchestration_id: 'orch-plumbing-test', outcome: 'applied' },
        makeContext(tmp)
      );

      assert.equal(result.isError, false);
      const payload = JSON.parse(result.content[0].text);
      assert.equal(payload.times_applied, 5, 'unchanged — this call does not commit the counter');
      assert.equal(payload.evidence_grade, 'self_report');
      assert.equal(payload.slug, 'test-pattern');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('emits a typed pattern_application_recorded event (§0.3 dead-aggregator fix)', async () => {
    const tmp = makeTmpProject();
    try {
      writePattern(tmp, 'test-pattern', {
        name: 'test-pattern', category: 'decomposition', confidence: 0.8, times_applied: 5,
      });

      await handleApplication(
        { slug: 'test-pattern', orchestration_id: 'orch-plumbing-test', outcome: 'applied' },
        makeContext(tmp)
      );

      const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
      const rows = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const recorded = rows.filter((e) => e.type === 'pattern_application_recorded');
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0].evidence_grade, 'self_report');
      assert.equal(recorded[0].slug, 'test-pattern');
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
