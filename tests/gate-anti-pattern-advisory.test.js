#!/usr/bin/env node
'use strict';

/**
 * Tests for W12 (LL3): Anti-pattern pre-spawn advisory gate in gate-agent-spawn.js.
 *
 * Covers the hot-path advisory injection logic:
 *   - Happy path: trigger match + high confidence → additionalContext returned, event emitted
 *   - Sub-threshold: match but decayed_confidence < 0.65 → no advisory
 *   - No match: description has no trigger keywords → no advisory
 *   - Cap at 1: multiple matches → only top 1 advisory emitted, exactly 1 event
 *   - Skip-enriched suppression: contextual-mismatch skip in recent events → advisory suppressed
 *   - Kill flag: anti_pattern_gate.enabled=false → gate bypassed entirely
 *   - Latency guard: hook with 20 pattern files must complete in <200ms (hard wall: 5s)
 *   - Exit 0 invariant: all match/no-match scenarios exit 0, never non-zero
 *   - Malformed pattern file: missing confidence → skip file, no crash, exits 0
 *   - Config absence: no anti_pattern_gate block → defaults apply, no crash
 *
 * Drive strategy: spawnSync (mirrors gate-agent-spawn.test.js pattern for the hook's
 * CLI-invocation contract). Internal helper functions are tested via the exported
 * helpers where possible; hook integration is tested end-to-end.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/gate-agent-spawn.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated project root with the standard orchestray layout.
 * Optionally write a current-orchestration.json and config.json.
 */
function makeProject({ withOrch = true, orchId = 'orch-w12-test-001', config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w12-apg-test-'));
  cleanup.push(dir);

  const auditDir = path.join(dir, '.orchestray', 'audit');
  const patternsDir = path.join(dir, '.orchestray', 'patterns');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(patternsDir, { recursive: true });

  if (withOrch) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );
  }

  if (config !== null) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(config)
    );
  }

  return { dir, patternsDir, eventsPath: path.join(auditDir, 'events.jsonl') };
}

/**
 * Write an anti-pattern file with specified frontmatter fields.
 */
function writeAntiPattern(patternsDir, slug, fields) {
  const fmLines = Object.entries(fields)
    .map(([k, v]) => {
      if (Array.isArray(v)) {
        return `${k}:\n` + v.map(item => `  - ${item}`).join('\n');
      }
      return `${k}: ${v === null ? 'null' : v}`;
    })
    .join('\n');
  const content = `---\n${fmLines}\n---\n\n# Pattern: ${slug}\n\n## Context\nTest pattern.\n\n## Approach\nTest mitigation approach.\n`;
  fs.writeFileSync(path.join(patternsDir, `anti-pattern-${slug}.md`), content);
}

/**
 * Read events.jsonl and return parsed event objects.
 */
function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l));
}

/**
 * Run gate-agent-spawn.js with a PreToolUse Agent payload.
 * The payload is augmented with a valid model and routing setup so other gate
 * checks pass and the anti-pattern gate is reached. We skip orchestration
 * routing.jsonl checks by not providing withOrch=true in the routing sense —
 * we provide an orch file but no routing.jsonl, which causes the routing check
 * to fall through (routing.jsonl absent → allow).
 */
function runGate(dir, toolInput) {
  const payload = {
    tool_name: 'Agent',
    cwd: dir,
    tool_input: {
      model: 'claude-sonnet-4-6', // valid model to pass model checks
      subagent_type: 'developer',
      ...toolInput,
    },
  };
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// T1: Happy path — description matches trigger_actions, confidence >= 0.65
// ---------------------------------------------------------------------------

describe('happy path — advisory fired', () => {
  test('returns additionalContext with advisory text and emits audit event', () => {
    const { dir, patternsDir, eventsPath } = makeProject();

    writeAntiPattern(patternsDir, 'whole-codebase-reviewer', {
      name: 'whole-codebase-reviewer',
      category: 'anti-pattern',
      confidence: 0.8,
      times_applied: 0,
      last_applied: null, // use mtime → fresh file → no decay
      created_from: 'orch-test',
      description: 'Reviewer subagents hit maxTurns on whole-codebase scans',
      trigger_actions: ['whole codebase', 'full audit'],
    });

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Review the whole codebase for security issues',
    });

    assert.equal(status, 0, 'gate must always exit 0; stderr: ' + stderr);

    // Should have emitted additionalContext
    assert.ok(stdout.length > 0, 'expected stdout with additionalContext; got empty');
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      assert.fail('stdout must be valid JSON; got: ' + stdout);
    }
    assert.ok(parsed.additionalContext, 'expected additionalContext field in stdout JSON');
    assert.ok(
      parsed.additionalContext.includes('[Anti-pattern advisory]'),
      'advisory must contain [Anti-pattern advisory] marker'
    );
    assert.ok(
      parsed.additionalContext.includes('whole codebase'),
      'advisory must mention the matched trigger'
    );

    // Audit event must have been written
    const events = readEvents(eventsPath);
    const advisory = events.find(e => e.type === 'anti_pattern_advisory_shown');
    assert.ok(advisory, 'expected anti_pattern_advisory_shown event in events.jsonl');
    assert.equal(advisory.pattern_name, 'whole-codebase-reviewer');
    assert.ok(typeof advisory.decayed_confidence === 'number');
    assert.ok(advisory.decayed_confidence >= 0.65);
    assert.equal(advisory.matched_trigger, 'whole codebase');
    assert.ok(advisory.timestamp, 'event must have timestamp field');
    assert.ok(advisory.orchestration_id, 'event must have orchestration_id field');
  });
});

// ---------------------------------------------------------------------------
// T2: Sub-threshold — match but decayed_confidence < 0.65
// ---------------------------------------------------------------------------

describe('sub-threshold — no advisory emitted', () => {
  test('old pattern with decayed confidence below threshold is suppressed', () => {
    const { dir, patternsDir, eventsPath } = makeProject();

    writeAntiPattern(patternsDir, 'stale-test-pattern', {
      name: 'stale-test-pattern',
      category: 'anti-pattern',
      confidence: 0.8,
      times_applied: 0,
      // Set last_applied to 2 years ago → 720 days → 0.8 * 0.5^(720/90) ≈ 0.003 << 0.65
      last_applied: new Date(Date.now() - 720 * 86400000).toISOString(),
      created_from: 'orch-test',
      description: 'Stale pattern that should not advise',
      trigger_actions: ['whole codebase', 'full scan'],
    });

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Scan whole codebase for issues',
    });

    assert.equal(status, 0, 'must exit 0; stderr: ' + stderr);
    // No additionalContext
    if (stdout.trim().length > 0) {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (_) { /* non-JSON stdout → no advisory */ }
      if (parsed) {
        assert.ok(!parsed.additionalContext, 'sub-threshold pattern must not produce additionalContext');
      }
    }
    // No advisory event
    const events = readEvents(eventsPath);
    const advisory = events.find(e => e.type === 'anti_pattern_advisory_shown');
    assert.ok(!advisory, 'sub-threshold pattern must not emit advisory event');
  });
});

// ---------------------------------------------------------------------------
// T3: No match — description has no trigger keyword
// ---------------------------------------------------------------------------

describe('no match — no advisory', () => {
  test('description unrelated to triggers → no additionalContext, no event', () => {
    const { dir, patternsDir, eventsPath } = makeProject();

    writeAntiPattern(patternsDir, 'reviewer-scope', {
      name: 'reviewer-scope',
      category: 'anti-pattern',
      confidence: 0.9,
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Reviewer subagent scope too broad',
      trigger_actions: ['whole codebase', 'full audit', 'review entire'],
    });

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Fix the typo in README.md line 42',
    });

    assert.equal(status, 0, 'must exit 0; stderr: ' + stderr);
    // No advisory
    if (stdout.trim().length > 0) {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (_) { /* ok */ }
      if (parsed) {
        assert.ok(!parsed.additionalContext, 'no-match must not produce additionalContext');
      }
    }
    const events = readEvents(eventsPath);
    const advisory = events.find(e => e.type === 'anti_pattern_advisory_shown');
    assert.ok(!advisory, 'no-match must not emit advisory event');
  });
});

// ---------------------------------------------------------------------------
// T4: Cap at 1 — multiple patterns match, only top 1 advisory emitted
// ---------------------------------------------------------------------------

describe('cap at 1 — multiple matches yield exactly 1 advisory', () => {
  test('3 matching patterns → 1 additionalContext, 1 advisory event', () => {
    const { dir, patternsDir, eventsPath } = makeProject();

    // Three patterns all matching "whole codebase", varying confidence.
    for (const [slug, confidence] of [
      ['scope-a', 0.8],
      ['scope-b', 0.75],
      ['scope-c', 0.7],
    ]) {
      writeAntiPattern(patternsDir, slug, {
        name: slug,
        category: 'anti-pattern',
        confidence,
        times_applied: 0,
        last_applied: null,
        created_from: 'orch-test',
        description: 'Pattern ' + slug,
        trigger_actions: ['whole codebase'],
      });
    }

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Review the whole codebase for all issues',
    });

    assert.equal(status, 0, 'must exit 0; stderr: ' + stderr);

    // Exactly one advisory in stdout
    assert.ok(stdout.trim().length > 0, 'expected stdout');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.additionalContext, 'expected additionalContext');

    // Count occurrences of the advisory marker
    const markerCount = (parsed.additionalContext.match(/\[Anti-pattern advisory\]/g) || []).length;
    assert.equal(markerCount, 1, 'must have exactly 1 advisory marker (cap=1)');

    // Exactly one advisory event emitted
    const events = readEvents(eventsPath);
    const advisoryEvents = events.filter(e => e.type === 'anti_pattern_advisory_shown');
    assert.equal(advisoryEvents.length, 1, 'must emit exactly 1 advisory event per spawn');
  });
});

// ---------------------------------------------------------------------------
// T5: Skip-enriched suppression — contextual-mismatch in recent events
// ---------------------------------------------------------------------------

describe('skip-enriched suppression', () => {
  test('pattern with recent contextual-mismatch skip is suppressed', () => {
    const orchId = 'orch-w12-suppress-test';
    const { dir, patternsDir, eventsPath } = makeProject({ orchId });

    writeAntiPattern(patternsDir, 'suppressed-pattern', {
      name: 'suppressed-pattern',
      category: 'anti-pattern',
      confidence: 0.9,
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Pattern that should be suppressed due to contextual-mismatch',
      trigger_actions: ['whole codebase'],
    });

    // Write a pattern_skip_enriched event with contextual-mismatch for this pattern.
    fs.appendFileSync(eventsPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'pattern_skip_enriched',
      orchestration_id: orchId,
      pattern_name: 'suppressed-pattern',
      skip_category: 'contextual-mismatch',
      match_quality: 'strong-match',
      reason: 'all-irrelevant',
    }) + '\n');

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Audit whole codebase security',
    });

    assert.equal(status, 0, 'must exit 0; stderr: ' + stderr);

    // No advisory for the suppressed pattern
    if (stdout.trim().length > 0) {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (_) { /* ok */ }
      if (parsed) {
        assert.ok(!parsed.additionalContext, 'suppressed pattern must not produce additionalContext');
      }
    }
    const events = readEvents(eventsPath);
    const advisory = events.find(e => e.type === 'anti_pattern_advisory_shown');
    assert.ok(!advisory, 'suppressed pattern must not emit advisory event');
  });

  test('different orchestration contextual-mismatch does NOT suppress current orch', () => {
    const orchId = 'orch-w12-current';
    const otherOrchId = 'orch-w12-other';
    const { dir, patternsDir, eventsPath } = makeProject({ orchId });

    writeAntiPattern(patternsDir, 'cross-orch-pattern', {
      name: 'cross-orch-pattern',
      category: 'anti-pattern',
      confidence: 0.9,
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Pattern should fire because mismatch was from different orch',
      trigger_actions: ['whole codebase'],
    });

    // Write skip event for a DIFFERENT orchestration — should NOT suppress.
    fs.appendFileSync(eventsPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'pattern_skip_enriched',
      orchestration_id: otherOrchId, // different orch
      pattern_name: 'cross-orch-pattern',
      skip_category: 'contextual-mismatch',
    }) + '\n');

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Review whole codebase thoroughly',
    });

    assert.equal(status, 0, 'must exit 0; stderr: ' + stderr);
    // Advisory SHOULD fire (different orch's skip does not suppress)
    assert.ok(stdout.trim().length > 0, 'expected advisory for different-orch skip');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.additionalContext, 'cross-orch mismatch must not suppress current advisory');
  });
});

// ---------------------------------------------------------------------------
// T6: Kill flag — anti_pattern_gate.enabled=false → gate bypassed
// ---------------------------------------------------------------------------

describe('kill flag', () => {
  test('anti_pattern_gate.enabled=false disables advisory logic entirely', () => {
    const { dir, patternsDir, eventsPath } = makeProject({
      config: {
        anti_pattern_gate: { enabled: false },
      },
    });

    writeAntiPattern(patternsDir, 'kill-flag-test', {
      name: 'kill-flag-test',
      category: 'anti-pattern',
      confidence: 0.99,
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'This should never fire when kill flag is set',
      trigger_actions: ['whole codebase', 'full audit', 'fix', 'implement', 'review'],
    });

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Review whole codebase for all issues with full audit',
    });

    assert.equal(status, 0, 'must exit 0 even with kill flag; stderr: ' + stderr);

    // No advisory context — gate was killed
    if (stdout.trim().length > 0) {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (_) { /* ok */ }
      if (parsed) {
        assert.ok(!parsed.additionalContext, 'kill flag must prevent additionalContext');
      }
    }

    // No advisory event
    const events = readEvents(eventsPath);
    const advisory = events.find(e => e.type === 'anti_pattern_advisory_shown');
    assert.ok(!advisory, 'kill flag must prevent advisory event emission');
  });

  // Updated for 2.1.11 (R-DX1): missing model now auto-resolves to sonnet (exit 0)
  // instead of hard-blocking (exit 2). The anti_pattern_gate kill flag only disables
  // advisory logic — the rest of the gate still runs, including auto-resolve.
  test('kill flag does not affect other gate logic (model auto-resolves via R-DX1)', () => {
    const { dir } = makeProject({
      config: {
        anti_pattern_gate: { enabled: false },
        mcp_enforcement: { pattern_record_application: 'allow' },
      },
    });

    // Omit model — R-DX1 auto-resolves to sonnet (exit 0).
    const payload = {
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'developer',
        description: 'Fix whole codebase review',
        // model intentionally omitted — auto-resolved by R-DX1
      },
    };
    const result = spawnSync(process.execPath, [SCRIPT], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10000,
      // v2.2.9 B-7.4: opt out of strict-model hard-block to exercise R-DX1 auto-resolve path.
      env: Object.assign({}, process.env, { ORCHESTRAY_STRICT_MODEL_REQUIRED: '0' }),
    });
    // R-DX1: auto-resolve to global_default_sonnet → exit 0.
    // Kill flag only disables advisory logic — gate still processes the spawn.
    assert.equal(result.status, 0, 'R-DX1 auto-resolve must still run when anti-pattern kill flag is set');
    assert.match(result.stderr, /defaulting to "sonnet"/, 'Expected auto-resolve warning in stderr');
  });
});

// ---------------------------------------------------------------------------
// T7: Latency regression guard — <200ms with 20 pattern files (hard wall: 5s)
// ---------------------------------------------------------------------------

describe('latency regression guard', () => {
  test('hook invocation with 20 anti-pattern files completes in <200ms (hard wall 5s)', () => {
    const { dir, patternsDir } = makeProject();

    // Create 20 anti-pattern files to simulate a populated pattern KB.
    for (let i = 0; i < 20; i++) {
      writeAntiPattern(patternsDir, `load-test-${i}`, {
        name: `load-test-${i}`,
        category: 'anti-pattern',
        confidence: 0.7 + (i % 3) * 0.05,
        times_applied: 0,
        last_applied: null,
        created_from: 'orch-load-test',
        description: `Load test anti-pattern number ${i}`,
        trigger_actions: ['load test trigger', `pattern-${i}`],
      });
    }

    const start = process.hrtime.bigint();
    const { status, stderr } = runGate(dir, {
      description: 'Fix a small bug in the configuration parser',
    });
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6; // ms

    assert.equal(status, 0, 'must exit 0; stderr: ' + stderr);

    // Hard wall: must complete in under 5s (absolute regression guard)
    assert.ok(elapsed < 5000, `hook took ${elapsed.toFixed(0)}ms — exceeds 5s hard wall`);

    // Target: under 200ms for normal operation on warm disk
    // Note: on CI with cold disk this may be slower; the 5s wall is the safety net.
    if (elapsed >= 200) {
      process.stderr.write(
        `[test warning] hook took ${elapsed.toFixed(0)}ms with 20 patterns — ` +
        'exceeds 200ms target (acceptable on cold CI disk, hard wall is 5s)\n'
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T8: Exit 0 invariant — 10 scenarios all must exit 0
// ---------------------------------------------------------------------------

describe('exit 0 invariant — advisory NEVER blocks a spawn', () => {
  const scenarios = [
    { desc: 'no patterns directory exists', setup: (dir) => { /* patternsDir absent — just don't create it */ }, description: 'Fix the login bug' },
    { desc: 'empty patterns directory', setup: () => {}, description: 'Fix the login bug' },
    { desc: 'pattern without trigger_actions', setup: (dir, patternsDir) => {
      writeAntiPattern(patternsDir, 'no-triggers', {
        name: 'no-triggers', category: 'anti-pattern', confidence: 0.9,
        times_applied: 0, last_applied: null, created_from: 'orch-test',
        description: 'Pattern without trigger_actions field',
      });
    }, description: 'Fix the whole codebase now' },
    { desc: 'trigger match fires advisory', setup: (dir, patternsDir) => {
      writeAntiPattern(patternsDir, 'high-conf', {
        name: 'high-conf', category: 'anti-pattern', confidence: 0.95,
        times_applied: 0, last_applied: null, created_from: 'orch-test',
        description: 'High confidence anti-pattern', trigger_actions: ['whole codebase'],
      });
    }, description: 'Audit whole codebase' },
    { desc: 'trigger match sub-threshold', setup: (dir, patternsDir) => {
      writeAntiPattern(patternsDir, 'stale', {
        name: 'stale', category: 'anti-pattern', confidence: 0.8,
        times_applied: 0,
        last_applied: new Date(Date.now() - 500 * 86400000).toISOString(),
        created_from: 'orch-test',
        description: 'Stale pattern', trigger_actions: ['whole codebase'],
      });
    }, description: 'Scan whole codebase' },
    { desc: 'pattern with malformed confidence', setup: (dir, patternsDir) => {
      // Write raw file with string confidence
      fs.writeFileSync(path.join(patternsDir, 'anti-pattern-bad-conf.md'),
        '---\nname: bad-conf\ncategory: anti-pattern\nconfidence: "invalid"\ntrigger_actions:\n  - whole codebase\n---\n# Bad\n');
    }, description: 'Review whole codebase' },
    { desc: 'kill flag enabled: false', setup: (dir, patternsDir) => {
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'config.json'),
        JSON.stringify({ anti_pattern_gate: { enabled: false } })
      );
      writeAntiPattern(patternsDir, 'kill-test', {
        name: 'kill-test', category: 'anti-pattern', confidence: 0.99,
        times_applied: 0, last_applied: null, created_from: 'orch-test',
        description: 'Should never fire', trigger_actions: ['whole codebase'],
      });
    }, description: 'Review whole codebase' },
    { desc: 'no orchestration file present', setup: () => {}, description: 'Fix a bug', noOrch: true },
    { desc: 'description is empty string', setup: (dir, patternsDir) => {
      writeAntiPattern(patternsDir, 'empty-desc', {
        name: 'empty-desc', category: 'anti-pattern', confidence: 0.9,
        times_applied: 0, last_applied: null, created_from: 'orch-test',
        description: 'Pattern for empty description', trigger_actions: ['whole codebase'],
      });
    }, description: '' },
    { desc: 'config absent entirely', setup: () => {
      // No config.json — should use defaults
    }, description: 'Fix a small bug' },
  ];

  for (const scenario of scenarios) {
    test(`exits 0: ${scenario.desc}`, () => {
      const { dir, patternsDir } = makeProject({ withOrch: !scenario.noOrch });

      if (scenario.setup) {
        scenario.setup(dir, patternsDir);
      }

      const { status, stderr } = runGate(dir, {
        description: scenario.description,
      });

      assert.equal(
        status,
        0,
        `scenario "${scenario.desc}" must exit 0 — got status ${status}; stderr: ${stderr}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// T9: Malformed pattern file — missing confidence → skip, no crash, exits 0
// ---------------------------------------------------------------------------

describe('malformed pattern file handling', () => {
  test('anti-pattern with no confidence field is skipped gracefully', () => {
    const { dir, patternsDir, eventsPath } = makeProject();

    // Write a malformed pattern (no confidence field).
    fs.writeFileSync(
      path.join(patternsDir, 'anti-pattern-no-confidence.md'),
      '---\nname: no-confidence\ncategory: anti-pattern\ntimes_applied: 0\nlast_applied: null\ncreated_from: orch-test\ndescription: Pattern with no confidence\ntrigger_actions:\n  - whole codebase\n---\n\n# No Confidence Pattern\n'
    );

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Scan whole codebase for vulnerabilities',
    });

    assert.equal(status, 0, 'malformed pattern must not crash the hook; stderr: ' + stderr);
    // Expect a stderr warning about the missing confidence field
    assert.ok(
      stderr.includes('no numeric confidence'),
      'should log stderr warning about missing confidence; got: ' + stderr
    );
    // No advisory emitted for malformed pattern
    const events = readEvents(eventsPath);
    const advisory = events.find(e => e.type === 'anti_pattern_advisory_shown');
    assert.ok(!advisory, 'malformed pattern must not emit advisory event');
  });

  test('anti-pattern with truncated/empty frontmatter is skipped gracefully', () => {
    const { dir, patternsDir } = makeProject();

    // Write a pattern with no frontmatter at all.
    fs.writeFileSync(
      path.join(patternsDir, 'anti-pattern-no-frontmatter.md'),
      '# Pattern Without Frontmatter\n\nJust a heading.\n'
    );

    // Should not crash
    const { status } = runGate(dir, {
      description: 'Scan whole codebase',
    });
    assert.equal(status, 0, 'pattern without frontmatter must not crash the hook');
  });
});

// ---------------------------------------------------------------------------
// T10: Config absence — no anti_pattern_gate block → defaults apply
// ---------------------------------------------------------------------------

describe('config absence', () => {
  test('missing anti_pattern_gate config block falls back to defaults', () => {
    // Config exists but has no anti_pattern_gate key.
    const { dir, patternsDir, eventsPath } = makeProject({
      config: {
        // anti_pattern_gate key intentionally absent
        mcp_enforcement: { global_kill_switch: false },
      },
    });

    writeAntiPattern(patternsDir, 'default-config-test', {
      name: 'default-config-test',
      category: 'anti-pattern',
      confidence: 0.8,
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Pattern for config-absence test',
      trigger_actions: ['whole codebase'],
    });

    const { stdout, stderr, status } = runGate(dir, {
      description: 'Review whole codebase for quality',
    });

    assert.equal(status, 0, 'must exit 0; stderr: ' + stderr);

    // Gate should work with defaults (enabled=true, threshold=0.65)
    assert.ok(stdout.trim().length > 0, 'expected advisory output with default config');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.additionalContext, 'expected advisory with default config settings');

    // Advisory event should be emitted
    const events = readEvents(eventsPath);
    const advisory = events.find(e => e.type === 'anti_pattern_advisory_shown');
    assert.ok(advisory, 'expected advisory event with default config');
  });

  test('completely absent config.json → defaults apply, no crash', () => {
    // No config.json at all (makeProject with config=null)
    const { dir, patternsDir } = makeProject({ config: null });

    writeAntiPattern(patternsDir, 'no-config-test', {
      name: 'no-config-test',
      category: 'anti-pattern',
      confidence: 0.8,
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Pattern for completely absent config test',
      trigger_actions: ['whole codebase'],
    });

    const { status } = runGate(dir, { description: 'Audit whole codebase' });
    assert.equal(status, 0, 'absent config.json must not crash the hook');
  });
});

// ---------------------------------------------------------------------------
// T11: Advisory content quality
// ---------------------------------------------------------------------------

describe('advisory content quality', () => {
  test('advisory includes pattern name, description, trigger, mitigation', () => {
    const { dir, patternsDir } = makeProject();

    writeAntiPattern(patternsDir, 'quality-test', {
      name: 'quality-test-pattern',
      category: 'anti-pattern',
      confidence: 0.85,
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Test pattern for advisory quality verification',
      trigger_actions: ['review entire project'],
    });

    const { stdout, status } = runGate(dir, {
      description: 'Please review entire project structure',
    });

    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    const advisory = parsed.additionalContext;

    assert.ok(advisory.includes('[Anti-pattern advisory]'), 'marker present');
    assert.ok(advisory.includes('quality-test-pattern'), 'pattern name in advisory');
    assert.ok(advisory.includes('review entire project'), 'matched trigger in advisory');
    assert.ok(advisory.includes('decayed_confidence='), 'confidence value in advisory');
    assert.ok(advisory.includes('Mitigation:'), 'mitigation section present');
  });
});

// ---------------------------------------------------------------------------
// T12: Threshold tuning via config
// ---------------------------------------------------------------------------

describe('min_decayed_confidence config tuning', () => {
  test('raising threshold suppresses a mid-confidence match', () => {
    const { dir, patternsDir, eventsPath } = makeProject({
      config: {
        anti_pattern_gate: {
          enabled: true,
          min_decayed_confidence: 0.85, // raised above the pattern's confidence
        },
      },
    });

    writeAntiPattern(patternsDir, 'mid-confidence', {
      name: 'mid-confidence',
      category: 'anti-pattern',
      confidence: 0.8, // below raised threshold of 0.85
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Mid-confidence pattern',
      trigger_actions: ['whole codebase'],
    });

    const { status, stdout } = runGate(dir, {
      description: 'Scan whole codebase',
    });

    assert.equal(status, 0);
    if (stdout.trim().length > 0) {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (_) { /* ok */ }
      if (parsed) {
        assert.ok(!parsed.additionalContext, 'raised threshold must suppress mid-confidence match');
      }
    }
    const events = readEvents(eventsPath);
    assert.ok(!events.find(e => e.type === 'anti_pattern_advisory_shown'), 'no advisory event at raised threshold');
  });

  test('lowering threshold enables a lower-confidence match', () => {
    const { dir, patternsDir, eventsPath } = makeProject({
      config: {
        anti_pattern_gate: {
          enabled: true,
          min_decayed_confidence: 0.5, // lowered
        },
      },
    });

    writeAntiPattern(patternsDir, 'low-confidence', {
      name: 'low-confidence',
      category: 'anti-pattern',
      confidence: 0.6, // above lowered threshold of 0.5 but below default 0.65
      times_applied: 0,
      last_applied: null,
      created_from: 'orch-test',
      description: 'Low-confidence pattern',
      trigger_actions: ['whole codebase'],
    });

    const { status, stdout } = runGate(dir, {
      description: 'Scan whole codebase',
    });

    assert.equal(status, 0);
    assert.ok(stdout.trim().length > 0, 'expected advisory at lowered threshold');
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.additionalContext, 'lowered threshold enables low-confidence match');

    const events = readEvents(eventsPath);
    assert.ok(events.find(e => e.type === 'anti_pattern_advisory_shown'), 'advisory event at lowered threshold');
  });
});
