#!/usr/bin/env node
'use strict';

/**
 * r-delta-handoff.test.js — R-DELTA-HANDOFF TDD tests (v2.1.15, W5).
 *
 * Verifies the delta-only re-delegation handoff feature:
 *   1. Default path returns {summary, issues[], diff} — not the full artifact.
 *   2. delta_handoff_fallback event payload is correctly structured.
 *   3. Three deterministic fallback triggers fire (issue_gap, hedged_summary,
 *      cross_orch_scope).
 *   4. Kill switch (config.delta_handoff.force_full=true) reverts to full
 *      artifact injection (fetched=true, reason="force_config").
 *
 * Strategy: unit-test `bin/generate-handoff-delta.js` directly (no subprocess
 * spawn needed — the module exports pure functions). Document-structure tests
 * for delegation-templates.md and event-schemas.md additions verify that the
 * PM's runtime instruction set is updated correctly.
 *
 * Runner: node --test tests/r-delta-handoff.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
const {
  generateDelta,
  shouldFetchFull,
  buildFallbackEvent,
} = require('../bin/generate-handoff-delta');

const DELEGATION_TEMPLATES = path.join(
  ROOT, 'agents', 'pm-reference', 'delegation-templates.md'
);
const EVENT_SCHEMAS = path.join(
  ROOT, 'agents', 'pm-reference', 'event-schemas.md'
);
const CONFIG_PATH = path.join(ROOT, '.orchestray', 'config.json');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_REVIEWER_FINDINGS = {
  summary: 'All checks passed. Function validateInput updated at L42.',
  issues: [
    { severity: 'error', file: 'src/api/tasks.ts', line: 42, message: 'Missing null check' },
  ],
  diff: 'diff --git a/src/api/tasks.ts b/src/api/tasks.ts\n@@ -40,6 +40,8 @@\n+  if (!input) throw new Error("null input");\n',
};

const EMPTY_ISSUES_FINDINGS = {
  summary: 'All checks passed.',
  issues: [],
  diff: 'diff --git a/bin/foo.js b/bin/foo.js\n@@ -1,3 +1,4 @@\n+console.log("x");\n',
};

const HEDGED_FINDINGS = {
  summary: 'Looks mostly fine but recommend reviewing the auth flow more carefully.',
  issues: [],
  diff: '',
};

// ---------------------------------------------------------------------------
// Test 1 — Default path: generateDelta returns delta payload only
// ---------------------------------------------------------------------------

describe('generateDelta — default (delta-only) mode', () => {
  test('returns summary, issues array, and diff fields', () => {
    const result = generateDelta(SAMPLE_REVIEWER_FINDINGS, { artifactPath: null });
    assert.ok('summary' in result, 'result must have summary field');
    assert.ok('issues' in result, 'result must have issues field');
    assert.ok('diff' in result, 'result must have diff field');
    assert.ok(Array.isArray(result.issues), 'issues must be an array');
  });

  test('does NOT include full artifact content in delta output', () => {
    const result = generateDelta(SAMPLE_REVIEWER_FINDINGS, { artifactPath: null });
    // The delta payload must not have a "full_artifact" or "artifact_content" key
    assert.ok(!('full_artifact' in result), 'delta must not include full_artifact');
    assert.ok(!('artifact_content' in result), 'delta must not include artifact_content');
  });

  test('propagates reviewer findings accurately', () => {
    const result = generateDelta(SAMPLE_REVIEWER_FINDINGS, { artifactPath: null });
    assert.equal(result.summary, SAMPLE_REVIEWER_FINDINGS.summary);
    assert.deepEqual(result.issues, SAMPLE_REVIEWER_FINDINGS.issues);
    assert.equal(result.diff, SAMPLE_REVIEWER_FINDINGS.diff);
  });

  test('includes detail_artifact field when artifactPath is provided', () => {
    const result = generateDelta(SAMPLE_REVIEWER_FINDINGS, {
      artifactPath: '.orchestray/kb/artifacts/reviewer-pass1.md',
    });
    assert.equal(result.detail_artifact, '.orchestray/kb/artifacts/reviewer-pass1.md');
  });

  test('omits detail_artifact when artifactPath is null', () => {
    const result = generateDelta(SAMPLE_REVIEWER_FINDINGS, { artifactPath: null });
    assert.ok(!('detail_artifact' in result), 'detail_artifact must be absent when null');
  });
});

// ---------------------------------------------------------------------------
// Test 2 — delta_handoff_fallback event structure
// ---------------------------------------------------------------------------

describe('buildFallbackEvent — event payload structure', () => {
  test('fetched=true event has required fields', () => {
    const evt = buildFallbackEvent({
      fetched: true,
      reason: 'issue_gap',
      orchestrationId: 'orch-1777200000',
      taskId: 'T3-developer-fix',
      agentType: 'developer',
      summaryChars: 340,
      detailArtifact: '.orchestray/kb/artifacts/reviewer-pass1.md',
    });

    assert.equal(evt.event_type, 'delta_handoff_fallback');
    assert.equal(evt.version, 1);
    assert.equal(evt.fetched, true);
    assert.equal(evt.reason, 'issue_gap');
    assert.equal(evt.orchestration_id, 'orch-1777200000');
    assert.equal(evt.task_id, 'T3-developer-fix');
    assert.equal(evt.agent_type, 'developer');
    assert.equal(evt.summary_chars, 340);
    assert.equal(evt.detail_artifact, '.orchestray/kb/artifacts/reviewer-pass1.md');
    assert.ok(typeof evt.timestamp === 'string', 'timestamp must be a string');
  });

  test('fetched=false event emits correctly with reason omitted', () => {
    const evt = buildFallbackEvent({
      fetched: false,
      orchestrationId: 'orch-abc',
      taskId: 'T1',
      agentType: 'developer',
      summaryChars: 120,
      detailArtifact: '.orchestray/kb/artifacts/r.md',
    });

    assert.equal(evt.fetched, false);
    assert.equal(evt.event_type, 'delta_handoff_fallback');
    assert.ok(!evt.reason || evt.reason === null, 'reason should be absent or null when not fetching');
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Three deterministic fallback triggers (P-DELTA-FALLBACK Gap 2)
// ---------------------------------------------------------------------------

describe('shouldFetchFull — three deterministic triggers', () => {
  // Rule 1: issue_gap — issues[] empty AND planned change touches file not named in summary
  test('rule 1 (issue_gap): empty issues + summary does not name planned file → fetch', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'All checks passed.',
      plannedFiles: ['bin/foo.js'],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'issue_gap');
  });

  test('rule 1 (issue_gap): empty issues but summary names the planned file → no fetch', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'Updated bin/foo.js with error handling fix.',
      plannedFiles: ['bin/foo.js'],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, false);
  });

  test('rule 1: non-empty issues list → no issue_gap trigger', () => {
    const result = shouldFetchFull({
      issues: [{ message: 'fix something' }],
      summary: 'Some issues found.',
      plannedFiles: ['bin/bar.js'],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    // issues is non-empty, so issue_gap doesn't apply; hedged_summary and
    // cross_orch_scope don't apply here either
    assert.equal(result.fetch, false);
  });

  // Rule 2: hedged_summary — summary contains hedge phrases
  test('rule 2 (hedged_summary): "recommend reviewing" triggers fetch', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'Looks mostly fine but recommend reviewing the auth flow.',
      plannedFiles: [],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'hedged_summary');
  });

  test('rule 2 (hedged_summary): "see details" triggers fetch', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'Passed all checks. See details for minor notes.',
      plannedFiles: [],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'hedged_summary');
  });

  test('rule 2 (hedged_summary): "additional context" triggers fetch', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'Additional context is available in the artifact.',
      plannedFiles: [],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'hedged_summary');
  });

  test('rule 2 (hedged_summary): "depends on" triggers fetch', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'This fix depends on the refactor described elsewhere.',
      plannedFiles: [],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'hedged_summary');
  });

  test('rule 2 (hedged_summary): "may need" triggers fetch', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'The implementation may need further validation.',
      plannedFiles: [],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'hedged_summary');
  });

  test('rule 2: clean summary with no hedge phrases → no fetch', () => {
    const result = shouldFetchFull({
      issues: [{ message: 'fix null check at L42' }],
      summary: 'Fixed null check at L42 in src/api/tasks.ts.',
      plannedFiles: ['src/api/tasks.ts'],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, false);
  });

  // Rule 3: cross_orch_scope — planned file predates current orchestration
  test('rule 3 (cross_orch_scope): file predates orchestration → fetch', () => {
    const orchStart = new Date('2026-04-25T10:00:00Z');
    const fileCommitDate = new Date('2026-04-24T08:00:00Z'); // before orch start

    const result = shouldFetchFull({
      issues: [],
      summary: 'Nothing to fix.',
      plannedFiles: ['src/legacy/auth.ts'],
      config: { delta_handoff: { enabled: true, force_full: false } },
      // Provide the file commit date and orch start as context
      fileLastCommitDates: { 'src/legacy/auth.ts': fileCommitDate.toISOString() },
      orchestrationStartedAt: orchStart.toISOString(),
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'cross_orch_scope');
  });

  test('rule 3: file committed during orchestration → no cross_orch trigger', () => {
    const orchStart = new Date('2026-04-25T10:00:00Z');
    const fileCommitDate = new Date('2026-04-25T11:00:00Z'); // after orch start

    // Use a non-empty issues list to avoid triggering issue_gap, and name the
    // file in the summary to avoid that path. This isolates cross_orch_scope.
    const result = shouldFetchFull({
      issues: [{ message: 'Fixed the new feature at src/new/feature.ts' }],
      summary: 'Updated src/new/feature.ts with the requested changes.',
      plannedFiles: ['src/new/feature.ts'],
      config: { delta_handoff: { enabled: true, force_full: false } },
      fileLastCommitDates: { 'src/new/feature.ts': fileCommitDate.toISOString() },
      orchestrationStartedAt: orchStart.toISOString(),
    });
    assert.equal(result.fetch, false);
  });

  test('rule 3: no file commit date provided → no cross_orch trigger (defensive)', () => {
    // Use non-empty issues and file named in summary to isolate cross_orch check.
    const result = shouldFetchFull({
      issues: [{ message: 'check src/unknown.ts' }],
      summary: 'Updated src/unknown.ts as requested.',
      plannedFiles: ['src/unknown.ts'],
      config: { delta_handoff: { enabled: true, force_full: false } },
      fileLastCommitDates: {},
      orchestrationStartedAt: new Date('2026-04-25T10:00:00Z').toISOString(),
    });
    // Without date info, we cannot determine cross_orch — should not trigger
    assert.equal(result.fetch, false);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Kill switch: force_full=true overrides all rules
// ---------------------------------------------------------------------------

describe('shouldFetchFull — kill switch (force_full)', () => {
  test('force_full=true forces fetch regardless of rules, reason="force_config"', () => {
    const result = shouldFetchFull({
      issues: [{ message: 'already covers the change' }],
      summary: 'Fixed the issue at src/api/tasks.ts:42.',
      plannedFiles: ['src/api/tasks.ts'],
      config: { delta_handoff: { enabled: true, force_full: true } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'force_config');
  });

  test('force_full=true with hedged summary still reports force_config (not hedged_summary)', () => {
    const result = shouldFetchFull({
      issues: [],
      summary: 'Please recommend reviewing this carefully.',
      plannedFiles: [],
      config: { delta_handoff: { enabled: true, force_full: true } },
    });
    assert.equal(result.fetch, true);
    assert.equal(result.reason, 'force_config');
  });

  test('force_full=false leaves rule evaluation active', () => {
    // With force_full=false and clean input, no fetch
    const result = shouldFetchFull({
      issues: [{ message: 'fix at L10' }],
      summary: 'Fixed null check at bin/tool.js line 10.',
      plannedFiles: ['bin/tool.js'],
      config: { delta_handoff: { enabled: true, force_full: false } },
    });
    assert.equal(result.fetch, false);
    assert.ok(!result.reason || result.reason === null);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Config block presence in .orchestray/config.json
// ---------------------------------------------------------------------------

describe('.orchestray/config.json — delta_handoff block', () => {
  test('config.json contains delta_handoff block', () => {
    assert.ok(fs.existsSync(CONFIG_PATH), `config.json must exist at ${CONFIG_PATH}`);
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.ok('delta_handoff' in cfg, 'config.json must have delta_handoff key');
  });

  test('delta_handoff.enabled defaults to true', () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.equal(cfg.delta_handoff.enabled, true, 'delta_handoff.enabled must be true by default');
  });

  test('delta_handoff.force_full kill switch defaults to false', () => {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    assert.equal(cfg.delta_handoff.force_full, false, 'force_full must be false by default');
  });
});

// ---------------------------------------------------------------------------
// Test 6 — delegation-templates.md document structure
// ---------------------------------------------------------------------------

describe('delegation-templates.md — re-delegation delta branch', () => {
  let content;

  test('file exists', () => {
    assert.ok(fs.existsSync(DELEGATION_TEMPLATES), `${DELEGATION_TEMPLATES} must exist`);
    content = fs.readFileSync(DELEGATION_TEMPLATES, 'utf8');
  });

  test('contains delta re-delegation section', () => {
    content = content || fs.readFileSync(DELEGATION_TEMPLATES, 'utf8');
    assert.ok(
      content.includes('delta') || content.includes('Delta'),
      'delegation-templates.md must document delta re-delegation path'
    );
  });

  test('documents detail_artifact field', () => {
    content = content || fs.readFileSync(DELEGATION_TEMPLATES, 'utf8');
    assert.ok(
      content.includes('detail_artifact'),
      'delegation-templates.md must document the detail_artifact field'
    );
  });

  test('contains Fallback: full-artifact fetch section with 3 triggers', () => {
    content = content || fs.readFileSync(DELEGATION_TEMPLATES, 'utf8');
    assert.ok(
      content.includes('Fallback') && content.includes('full-artifact'),
      'must have Fallback: full-artifact fetch section'
    );
    assert.ok(content.includes('issue_gap'), 'must document issue_gap trigger');
    assert.ok(content.includes('hedged_summary'), 'must document hedged_summary trigger');
    assert.ok(content.includes('cross_orch_scope'), 'must document cross_orch_scope trigger');
  });
});

// ---------------------------------------------------------------------------
// Test 7 — event-schemas.md document structure
// ---------------------------------------------------------------------------

describe('event-schemas.md — delta_handoff_fallback event', () => {
  let content;

  test('file exists', () => {
    assert.ok(fs.existsSync(EVENT_SCHEMAS), `${EVENT_SCHEMAS} must exist`);
    content = fs.readFileSync(EVENT_SCHEMAS, 'utf8');
  });

  test('contains delta_handoff_fallback event schema', () => {
    content = content || fs.readFileSync(EVENT_SCHEMAS, 'utf8');
    assert.ok(
      content.includes('delta_handoff_fallback'),
      'event-schemas.md must define delta_handoff_fallback event'
    );
  });

  test('schema documents fetched and reason fields', () => {
    content = content || fs.readFileSync(EVENT_SCHEMAS, 'utf8');
    // Find the actual schema section (v2.1.15 additions block), not the Summary Index entry.
    // The schema section header is "## v2.1.15 additions (R-DELTA-HANDOFF)".
    const sectionMarker = 'v2.1.15 additions (R-DELTA-HANDOFF)';
    const sectionStart = content.indexOf(sectionMarker);
    assert.ok(sectionStart !== -1, 'v2.1.15 additions (R-DELTA-HANDOFF) section must exist');
    const sectionText = content.slice(sectionStart, sectionStart + 2000);
    assert.ok(sectionText.includes('"fetched"'), 'schema must document fetched field');
    assert.ok(sectionText.includes('"reason"'), 'schema must document reason field');
  });

  test('delta_handoff_fallback appears in Summary Index at top of file', () => {
    content = content || fs.readFileSync(EVENT_SCHEMAS, 'utf8');
    // Check the summary index section (before END CONDITIONAL-LOAD NOTICE)
    const endNotice = content.indexOf('END CONDITIONAL-LOAD NOTICE');
    if (endNotice !== -1) {
      const header = content.slice(0, endNotice);
      assert.ok(
        header.includes('delta_handoff_fallback'),
        'delta_handoff_fallback must be listed in the Summary Index'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8 — pm.md document structure
// ---------------------------------------------------------------------------

describe('agents/pm.md — delegation-templates section references delta path', () => {
  test('pm.md references delta_handoff or delta path in delegation context', () => {
    const pmPath = path.join(ROOT, 'agents', 'pm.md');
    assert.ok(fs.existsSync(pmPath), 'agents/pm.md must exist');
    const content = fs.readFileSync(pmPath, 'utf8');
    assert.ok(
      content.includes('delta_handoff') || content.includes('delta payload'),
      'pm.md must reference delta_handoff or delta payload in delegation section'
    );
  });

  test('pm.md documents delta_handoff kill switch', () => {
    const pmPath = path.join(ROOT, 'agents', 'pm.md');
    const content = fs.readFileSync(pmPath, 'utf8');
    assert.ok(
      content.includes('force_full') || content.includes('delta_handoff.force_full'),
      'pm.md must document the delta_handoff force_full kill switch'
    );
  });
});
