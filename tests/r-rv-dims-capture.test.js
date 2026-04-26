#!/usr/bin/env node
'use strict';

/**
 * R-RV-DIMS-CAPTURE tests (v2.1.17 W7).
 *
 * Covers:
 *   (a) `review_dimensions` appears on `agent_start` when the reviewer spawn
 *       carried a `## Dimensions to Apply` block (via PreToolUse staging).
 *   (b) Field is absent when the reviewer spawn did not carry the block.
 *   (c) Field is ignored on non-reviewer spawns even if staged.
 *   (d) Analytics rollup correctly computes adoption %.
 *
 * Spec source: `.orchestray/kb/artifacts/v2117-release-plan.md` §R-RV-DIMS-CAPTURE.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

const AUDIT_EVENT_SCRIPT       = path.join(REPO_ROOT, 'bin', 'audit-event.js');
const COLLECT_TELEMETRY_SCRIPT = path.join(REPO_ROOT, 'bin', 'collect-context-telemetry.js');

const { extractReviewDimensions } = require(path.join(REPO_ROOT, 'bin', '_lib', 'extract-review-dimensions'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-rv-dims-cap-test-'));
}

function readEventsJsonl(auditDir) {
  const p = path.join(auditDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runScript(script, argv, stdinPayload) {
  const r = spawnSync(process.execPath, [script, ...argv], {
    input: typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload || {}),
    encoding: 'utf8',
    timeout: 5000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Build a sample reviewer delegation prompt.
 * @param {"all"|string[]|null} value
 * @returns {string}
 */
function reviewerPrompt(value) {
  let block;
  if (value === 'all') {
    block = '## Dimensions to Apply\nall\n\n';
  } else if (Array.isArray(value)) {
    const bullets = value.map((d) => '- ' + d).join('\n');
    block = '## Dimensions to Apply\n' + bullets + '\n\n';
  } else {
    block = ''; // No block — legacy v2.1.15-style spawn.
  }
  return [
    '# Goal',
    'Review the developer\'s output.',
    '',
    '## Context',
    'Some context here.',
    '',
    block,
    'For each item in the bulleted list, Read the matching fragment file:',
    '- code-quality   → agents/reviewer-dimensions/code-quality.md',
    '- performance    → agents/reviewer-dimensions/performance.md',
    '- documentation  → agents/reviewer-dimensions/documentation.md',
    '- operability    → agents/reviewer-dimensions/operability.md',
    '- api-compat     → agents/reviewer-dimensions/api-compat.md',
    '',
    '## Files to Review',
    '- src/foo.js',
  ].join('\n');
}

/**
 * Stage a spawn via the pre-spawn hook, then fire the SubagentStart hook.
 * Returns the events written to events.jsonl.
 */
function spawnAndCollect({ tmpDir, agentType, prompt, agentId, sessionId }) {
  // Reset cache so prior tests don't leak via the staging cache.
  const cachePath = path.join(tmpDir, '.orchestray', 'state', 'context-telemetry.json');
  try { fs.unlinkSync(cachePath); } catch (_e) { /* ignore */ }

  // Pre-spawn (PreToolUse:Agent) — stage the prompt.
  const preSpawnPayload = {
    cwd: tmpDir,
    tool_use_id: 'toolu_test_' + Date.now(),
    tool_input: {
      subagent_type: agentType,
      model:         'sonnet',
      effort:        'medium',
      description:   'Test spawn for ' + agentType,
      prompt:        prompt,
    },
  };
  const preRes = runScript(COLLECT_TELEMETRY_SCRIPT, ['pre-spawn'], preSpawnPayload);
  assert.equal(preRes.status, 0, 'pre-spawn hook must exit 0');

  // SubagentStart — emit agent_start.
  const startPayload = {
    cwd: tmpDir,
    agent_id:   agentId   || 'agent-test-001',
    agent_type: agentType,
    session_id: sessionId || 'sess-test',
  };
  const startRes = runScript(AUDIT_EVENT_SCRIPT, ['start'], startPayload);
  assert.equal(startRes.status, 0, 'audit-event start must exit 0');

  return readEventsJsonl(path.join(tmpDir, '.orchestray', 'audit'));
}

// ---------------------------------------------------------------------------
// (a) Field appears on agent_start when reviewer spawn carried it
// ---------------------------------------------------------------------------

describe('R-RV-DIMS-CAPTURE (a) — field present when staged', () => {
  test('reviewer spawn with explicit subset → review_dimensions in agent_start', () => {
    const tmpDir = makeTmpDir();
    try {
      const events = spawnAndCollect({
        tmpDir,
        agentType: 'reviewer',
        prompt:    reviewerPrompt(['documentation']),
      });
      const startEv = events.find((e) => e.type === 'agent_start');
      assert.ok(startEv, 'must emit agent_start');
      assert.equal(startEv.agent_type, 'reviewer');
      assert.equal(startEv.version, 2, 'agent_start v2 schema');
      assert.deepStrictEqual(
        startEv.review_dimensions,
        ['documentation'],
        'review_dimensions field must be set to the staged subset'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('reviewer spawn with "all" sentinel → review_dimensions === "all"', () => {
    const tmpDir = makeTmpDir();
    try {
      const events = spawnAndCollect({
        tmpDir,
        agentType: 'reviewer',
        prompt:    reviewerPrompt('all'),
      });
      const startEv = events.find((e) => e.type === 'agent_start');
      assert.ok(startEv);
      assert.equal(startEv.review_dimensions, 'all');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Field absent when reviewer spawn didn't carry it
// ---------------------------------------------------------------------------

describe('R-RV-DIMS-CAPTURE (b) — field absent when not staged', () => {
  test('reviewer spawn without Dimensions block → field absent on agent_start', () => {
    const tmpDir = makeTmpDir();
    try {
      const events = spawnAndCollect({
        tmpDir,
        agentType: 'reviewer',
        prompt:    reviewerPrompt(null), // No block at all.
      });
      const startEv = events.find((e) => e.type === 'agent_start');
      assert.ok(startEv);
      assert.equal(startEv.agent_type, 'reviewer');
      assert.ok(
        !('review_dimensions' in startEv),
        'review_dimensions must NOT appear when prompt did not carry the block'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Field ignored on non-reviewer spawns
// ---------------------------------------------------------------------------

describe('R-RV-DIMS-CAPTURE (c) — field ignored on non-reviewer spawns', () => {
  test('developer spawn with prompt that contains a Dimensions block → field absent', () => {
    const tmpDir = makeTmpDir();
    try {
      // Even though the prompt body includes a `## Dimensions to Apply` block,
      // the agent_type is developer — the emitter must not attach the field.
      const events = spawnAndCollect({
        tmpDir,
        agentType: 'developer',
        prompt:    reviewerPrompt(['code-quality', 'performance']),
      });
      const startEv = events.find((e) => e.type === 'agent_start');
      assert.ok(startEv);
      assert.equal(startEv.agent_type, 'developer');
      assert.ok(
        !('review_dimensions' in startEv),
        'review_dimensions must NOT appear on non-reviewer agent_start events'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (e) F-004 — parallel-reviewer race-window safety
// ---------------------------------------------------------------------------

describe('R-RV-DIMS-CAPTURE (e) — back-to-back reviewer spawns get correct dims', () => {
  test('two reviewer spawns staged within 100ms → each agent_start gets its own dims (FIFO)', () => {
    const tmpDir = makeTmpDir();
    try {
      // Stage reviewer A first, then reviewer B (~50ms later) — both before
      // any SubagentStart fires. Pre-fix behaviour: both A's and B's
      // SubagentStart would peek the latest (B) and both events would carry
      // B's dims. Post-fix: peek picks the OLDEST reviewer entry, so A's
      // SubagentStart gets A's dims; collect-context-telemetry then deletes
      // the latest (B) leaving A; the second SubagentStart picks A's leftover.
      // We only verify the audit-event side of the race here.

      // Stage A — subset=["documentation"]
      const preA = {
        cwd: tmpDir,
        tool_use_id: 'toolu_test_A_' + Date.now(),
        tool_input: {
          subagent_type: 'reviewer',
          model: 'sonnet', effort: 'medium', description: 'review A',
          prompt: reviewerPrompt(['documentation']),
        },
      };
      const preARes = runScript(COLLECT_TELEMETRY_SCRIPT, ['pre-spawn'], preA);
      assert.equal(preARes.status, 0);

      // Tiny delay so staged_at differs by at least 1ms (Date.now() resolution).
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      // Stage B — subset=["code-quality"]
      const preB = {
        cwd: tmpDir,
        tool_use_id: 'toolu_test_B_' + Date.now(),
        tool_input: {
          subagent_type: 'reviewer',
          model: 'sonnet', effort: 'medium', description: 'review B',
          prompt: reviewerPrompt(['code-quality']),
        },
      };
      const preBRes = runScript(COLLECT_TELEMETRY_SCRIPT, ['pre-spawn'], preB);
      assert.equal(preBRes.status, 0);

      // Now SubagentStart fires for A. F-004 fix: peek must pick the OLDEST
      // reviewer entry — A's. (NOTE: this test exercises ONLY audit-event.js,
      // not collect-context-telemetry.js handleStart — the staging entry is
      // not consumed because we don't run the SubagentStart for telemetry.)
      const startA = {
        cwd: tmpDir,
        agent_id: 'agent-A-001', agent_type: 'reviewer', session_id: 'sess-test',
      };
      const startARes = runScript(AUDIT_EVENT_SCRIPT, ['start'], startA);
      assert.equal(startARes.status, 0);

      const events = readEventsJsonl(path.join(tmpDir, '.orchestray', 'audit'));
      const startEvA = events.find((e) => e.type === 'agent_start' && e.agent_id === 'agent-A-001');
      assert.ok(startEvA, 'must emit agent_start for A');
      assert.deepStrictEqual(
        startEvA.review_dimensions,
        ['documentation'],
        'A must get its OWN dims (documentation), not B\'s (code-quality) — F-004 race fix'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('back-to-back reviewer SubagentStarts each get their OWN staged metadata (consume-side FIFO, F-W11-01)', () => {
    // Pre-fix (v2.1.17 W9): the consume side in collect-context-telemetry.js
    // handleStart picked the LATEST staged entry (LIFO) and deleted it. Under
    // back-to-back reviewer spawns A→B both staged before either SubagentStart:
    //   - SubagentStart for A consumed B's entry (wrong — A's row got B's
    //     model/effort/description metadata).
    //   - SubagentStart for B then found an empty staging map (B's row had
    //     no staged metadata at all).
    //
    // Post-fix (W11): mirror the audit-event peek-side logic. The consume
    // picks the OLDEST candidate (FIFO) within the 5s TTL, restricted to
    // reviewer entries when the consumer is a reviewer. This test asserts
    // that A's row gets A's metadata AND B's row gets B's metadata (the
    // critical second-spawn-not-empty assertion called out in the W11 audit).
    const tmpDir = makeTmpDir();
    try {
      // Stage A first.
      const preA = {
        cwd: tmpDir,
        tool_use_id: 'toolu_test_consume_A_' + Date.now(),
        tool_input: {
          subagent_type: 'reviewer',
          model: 'opus', effort: 'high', description: 'review-A-desc',
          prompt: reviewerPrompt(['documentation']),
        },
      };
      const preARes = runScript(COLLECT_TELEMETRY_SCRIPT, ['pre-spawn'], preA);
      assert.equal(preARes.status, 0);

      // Tiny delay so staged_at differs by at least 1 ms (Date.now() resolution).
      const delayStart = Date.now();
      while (Date.now() - delayStart < 5) { /* spin */ }

      // Stage B second.
      const preB = {
        cwd: tmpDir,
        tool_use_id: 'toolu_test_consume_B_' + Date.now(),
        tool_input: {
          subagent_type: 'reviewer',
          model: 'sonnet', effort: 'medium', description: 'review-B-desc',
          prompt: reviewerPrompt(['code-quality']),
        },
      };
      const preBRes = runScript(COLLECT_TELEMETRY_SCRIPT, ['pre-spawn'], preB);
      assert.equal(preBRes.status, 0);

      // SubagentStart fires for A first (telemetry consume side).
      const startA = {
        cwd: tmpDir,
        agent_id: 'agent-A-consume', agent_type: 'reviewer', session_id: 'sess-test',
      };
      const startARes = runScript(COLLECT_TELEMETRY_SCRIPT, ['start'], startA);
      assert.equal(startARes.status, 0);

      // SubagentStart fires for B second.
      const startB = {
        cwd: tmpDir,
        agent_id: 'agent-B-consume', agent_type: 'reviewer', session_id: 'sess-test',
      };
      const startBRes = runScript(COLLECT_TELEMETRY_SCRIPT, ['start'], startB);
      assert.equal(startBRes.status, 0);

      // Read the cache and verify each active_subagents row got its OWN metadata.
      const cachePath = path.join(tmpDir, '.orchestray', 'state', 'context-telemetry.json');
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.ok(Array.isArray(cache.active_subagents), 'active_subagents must exist');

      const rowA = cache.active_subagents.find((r) => r.agent_id === 'agent-A-consume');
      const rowB = cache.active_subagents.find((r) => r.agent_id === 'agent-B-consume');
      assert.ok(rowA, 'must have row for agent A');
      assert.ok(rowB, 'must have row for agent B');

      // The CRITICAL assertion: each row carries its OWN staged metadata.
      assert.equal(rowA.model, 'opus',         'row A must get A\'s model (opus), not B\'s (sonnet)');
      assert.equal(rowA.effort, 'high',        'row A must get A\'s effort (high), not B\'s (medium)');
      assert.equal(rowA.description, 'review-A-desc', 'row A must get A\'s description');

      assert.equal(rowB.model, 'sonnet',       'row B must get B\'s model (not empty / null) — F-W11-01');
      assert.equal(rowB.effort, 'medium',      'row B must get B\'s effort');
      assert.equal(rowB.description, 'review-B-desc', 'row B must get B\'s description');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('staging entry older than 5s is ignored (TTL bound)', () => {
    const tmpDir = makeTmpDir();
    try {
      // Stage reviewer A, then directly manipulate the cache file to backdate
      // its staged_at by 10s. peekStagedReviewDimensions must skip it.
      const preA = {
        cwd: tmpDir,
        tool_use_id: 'toolu_test_stale_' + Date.now(),
        tool_input: {
          subagent_type: 'reviewer',
          model: 'sonnet', effort: 'medium', description: 'stale review',
          prompt: reviewerPrompt(['documentation']),
        },
      };
      const preARes = runScript(COLLECT_TELEMETRY_SCRIPT, ['pre-spawn'], preA);
      assert.equal(preARes.status, 0);

      // Backdate the staging entry by 10 seconds.
      const cachePath = path.join(tmpDir, '.orchestray', 'state', 'context-telemetry.json');
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      assert.ok(cache._spawn_staging, 'staging map must exist');
      const keys = Object.keys(cache._spawn_staging);
      assert.equal(keys.length, 1);
      const tenSecAgo = new Date(Date.now() - 10000).toISOString();
      cache._spawn_staging[keys[0]].staged_at = tenSecAgo;
      fs.writeFileSync(cachePath, JSON.stringify(cache));

      // SubagentStart fires; the stale entry must be ignored.
      const startEv = {
        cwd: tmpDir,
        agent_id: 'agent-stale-001', agent_type: 'reviewer', session_id: 'sess-test',
      };
      const startRes = runScript(AUDIT_EVENT_SCRIPT, ['start'], startEv);
      assert.equal(startRes.status, 0);

      const events = readEventsJsonl(path.join(tmpDir, '.orchestray', 'audit'));
      const startE = events.find((e) => e.type === 'agent_start');
      assert.ok(startE, 'must emit agent_start');
      assert.ok(
        !('review_dimensions' in startE),
        'stale staging entry must be ignored — review_dimensions absent'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (d) Analytics rollup adoption % computation
// ---------------------------------------------------------------------------

describe('R-RV-DIMS-CAPTURE (d) — analytics rollup adoption %', () => {
  /**
   * Replicates the Rollup G aggregation logic from
   * `skills/orchestray:analytics/SKILL.md`. Pure function over an event list.
   */
  function computeAdoption(events) {
    const reviewerStarts = events.filter(
      (e) => e && e.type === 'agent_start' && e.agent_type === 'reviewer'
    );
    const total = reviewerStarts.length;
    const populated = reviewerStarts.filter((e) => {
      const v = e.review_dimensions;
      return v === 'all' || (Array.isArray(v) && v.length > 0);
    });
    const allCount    = populated.filter((e) => e.review_dimensions === 'all').length;
    const subsetCount = populated.length - allCount;
    return {
      total_reviewer_spawns: total,
      spawns_with_field:     populated.length,
      adoption_pct:          total === 0 ? 0 : (populated.length / total) * 100,
      shape: {
        all:    allCount,
        subset: subsetCount,
      },
    };
  }

  test('mixed event stream → adoption % matches expected', () => {
    const events = [
      // 5 reviewer spawns: 3 carry the field, 2 do not → 60%
      { type: 'agent_start', agent_type: 'reviewer', review_dimensions: ['documentation'] },
      { type: 'agent_start', agent_type: 'reviewer', review_dimensions: 'all' },
      { type: 'agent_start', agent_type: 'reviewer', review_dimensions: ['code-quality', 'performance'] },
      { type: 'agent_start', agent_type: 'reviewer' },
      { type: 'agent_start', agent_type: 'reviewer' },
      // Non-reviewer spawn must be ignored even with the field.
      { type: 'agent_start', agent_type: 'developer', review_dimensions: ['x'] },
      // Other event types must be ignored.
      { type: 'agent_stop', agent_type: 'reviewer' },
    ];
    const result = computeAdoption(events);
    assert.equal(result.total_reviewer_spawns, 5);
    assert.equal(result.spawns_with_field, 3);
    assert.equal(result.adoption_pct, 60);
    assert.equal(result.shape.all, 1);
    assert.equal(result.shape.subset, 2);
  });

  test('empty event stream → 0% with no division-by-zero', () => {
    const result = computeAdoption([]);
    assert.equal(result.total_reviewer_spawns, 0);
    assert.equal(result.spawns_with_field, 0);
    assert.equal(result.adoption_pct, 0);
  });

  test('only reviewer spawns without field → 0% adoption', () => {
    const result = computeAdoption([
      { type: 'agent_start', agent_type: 'reviewer' },
      { type: 'agent_start', agent_type: 'reviewer' },
    ]);
    assert.equal(result.total_reviewer_spawns, 2);
    assert.equal(result.spawns_with_field, 0);
    assert.equal(result.adoption_pct, 0);
  });
});

// ---------------------------------------------------------------------------
// Parser unit tests — extract-review-dimensions helper
// ---------------------------------------------------------------------------

describe('extractReviewDimensions parser', () => {
  test('returns null for empty / non-string input', () => {
    assert.equal(extractReviewDimensions(null), null);
    assert.equal(extractReviewDimensions(undefined), null);
    assert.equal(extractReviewDimensions(''), null);
    assert.equal(extractReviewDimensions(42), null);
  });

  test('returns null when no Dimensions block is present', () => {
    assert.equal(extractReviewDimensions('# Goal\nReview things.\n## Context\nfoo'), null);
  });

  test('returns "all" for the literal "all" sentinel', () => {
    assert.equal(extractReviewDimensions('## Dimensions to Apply\nall\n'), 'all');
    assert.equal(extractReviewDimensions('## Dimensions to Apply\n"all"\n'), 'all');
  });

  test('returns "all" for the unsubstituted template stamp', () => {
    // PM omitted substitution — template literal remains. The parser is
    // permissive: returns "all" (the back-compat default).
    const prompt = '## Dimensions to Apply\n{review_dimensions: "all" | bulleted list}\n';
    assert.equal(extractReviewDimensions(prompt), 'all');
  });

  test('returns sorted subset for bulleted dimensions', () => {
    const prompt = reviewerPrompt(['operability', 'code-quality']);
    assert.deepStrictEqual(
      extractReviewDimensions(prompt),
      ['code-quality', 'operability']
    );
  });

  test('strips correctness/security defensively', () => {
    const prompt = '## Dimensions to Apply\n- correctness\n- security\n- documentation\n\n';
    assert.deepStrictEqual(
      extractReviewDimensions(prompt),
      ['documentation']
    );
  });

  test('drops dimensions outside the allowed enum', () => {
    const prompt = '## Dimensions to Apply\n- bogus-dim\n- code-quality\n\n';
    assert.deepStrictEqual(
      extractReviewDimensions(prompt),
      ['code-quality']
    );
  });

  test('returns null when only the legend bullets are present', () => {
    // Block exists but has no chosen bullets before the legend (would happen
    // for a malformed empty subset). Legend-only block → null.
    const prompt = [
      '## Dimensions to Apply',
      '',
      '- code-quality   → agents/reviewer-dimensions/code-quality.md',
      '- performance    → agents/reviewer-dimensions/performance.md',
      '',
      '## Files',
    ].join('\n');
    assert.equal(extractReviewDimensions(prompt), null);
  });
});
