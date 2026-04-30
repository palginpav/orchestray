#!/usr/bin/env node
'use strict';

/**
 * v2.2.15 Wave B-1 validator tests.
 *
 * Coverage:
 *   P1-05 detectMultipleStructuredResultBlocks (validate-task-completion.js)
 *   P1-06 validate-tester-runs-tests.js        ≥3 cases
 *   P1-07 validate-pattern-application.js       ≥3 cases
 *   P1-08 pattern-citation-render.js reviewer  ≥3 cases
 *   P1-09 validate-researcher-citations.js      ≥3 cases
 *   P1-10 validate-platform-oracle-grounding.js ≥3 cases
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NODE = process.execPath;
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function makeTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e) {}
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function writeOrchMarker(tmp, orchId) {
  fs.writeFileSync(
    path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

// ---------------------------------------------------------------------------
// P1-05 — detectMultipleStructuredResultBlocks (pure function)
// ---------------------------------------------------------------------------

describe('v2.2.15 P1-05 — detectMultipleStructuredResultBlocks', () => {
  const { detectMultipleStructuredResultBlocks } = require('../validate-task-completion');

  test('single block → not flagged', () => {
    const text = '## Structured Result\n\n```json\n{"status":"success"}\n```';
    const r = detectMultipleStructuredResultBlocks(text);
    assert.equal(r.multipleBlocks, false);
    assert.equal(r.count, 1);
  });

  test('two blocks → flagged with count 2', () => {
    const text = '## Structured Result\n\nfoo\n\n## Structured Result\n\nbar';
    const r = detectMultipleStructuredResultBlocks(text);
    assert.equal(r.multipleBlocks, true);
    assert.equal(r.count, 2);
  });

  test('empty string → not flagged', () => {
    const r = detectMultipleStructuredResultBlocks('');
    assert.equal(r.multipleBlocks, false);
    assert.equal(r.count, 0);
  });

  test('no block → count 0', () => {
    const r = detectMultipleStructuredResultBlocks('some output without structured result');
    assert.equal(r.multipleBlocks, false);
    assert.equal(r.count, 0);
  });
});

// ---------------------------------------------------------------------------
// P1-05 — emit pipeline integration (single-block/two-block/kill-switch)
// ---------------------------------------------------------------------------

describe('v2.2.15 P1-05 — emit pipeline integration', () => {
  const HOOK = path.resolve(__dirname, '..', 'validate-task-completion.js');

  function runHookP105(outputText, env = {}) {
    const tmp = makeTmp('p105-emit-');
    writeOrchMarker(tmp, 'orch-test-p105-emit');
    const baseEnv = { ...process.env };
    delete baseEnv.ORCHESTRAY_MULTI_STRUCTURED_RESULT_GATE_DISABLED;
    const payload = {
      hook_event_name: 'SubagentStop',
      // Use a synthetic role not in ROLE_SCHEMAS to avoid role-schema gate
      // interference — the P1-05 check runs before role-schema and is
      // role-agnostic, so any non-schema role exercises the same code path.
      subagent_type: 'test-multi-block-p105',
      cwd: tmp,
      output: outputText,
    };
    const r = spawnSync(NODE, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...env },
    });
    return { ...r, tmp };
  }

  test('single block → no multiple_structured_result_blocks event emitted', () => {
    const output = '## Structured Result\n\n```json\n{"status":"success","summary":"ok","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```';
    const { status, tmp } = runHookP105(output);
    const events = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 0);
    const multiEvents = events.filter(e => e.type === 'multiple_structured_result_blocks');
    assert.equal(multiEvents.length, 0, 'no event emitted for single block');
  });

  test('two blocks → emits multiple_structured_result_blocks with block_count 2 (warn-only, exit 0)', () => {
    const block = '## Structured Result\n\n```json\n{"status":"success","summary":"done","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```';
    const output = block + '\n\nSome more content\n\n' + block;
    const { status, stderr, tmp } = runHookP105(output);
    const events = readEvents(tmp);
    cleanup(tmp);
    // Warn-only in v2.2.15 — must NOT exit 2
    assert.equal(status, 0, 'exit 0 (warn-only in v2.2.15)');
    const multiEvent = events.find(e => e.type === 'multiple_structured_result_blocks');
    assert.ok(multiEvent, 'multiple_structured_result_blocks event must be emitted');
    assert.equal(multiEvent.block_count, 2, 'block_count must be 2');
    assert.ok(stderr.includes('WARN'), 'stderr must include WARN');
  });

  test('kill switch active → no event emitted even with two blocks', () => {
    const block = '## Structured Result\n\n```json\n{"status":"success","summary":"done","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```';
    const output = block + '\n\nSome more content\n\n' + block;
    const { status, tmp } = runHookP105(output, { ORCHESTRAY_MULTI_STRUCTURED_RESULT_GATE_DISABLED: '1' });
    const events = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 0);
    // Kill switch suppresses the event entirely — no multiple_structured_result_blocks event.
    const multiEvents = events.filter(e => e.type === 'multiple_structured_result_blocks');
    assert.equal(multiEvents.length, 0, 'no event when kill switch is active');
  });
});

// ---------------------------------------------------------------------------
// P1-06 — validate-tester-runs-tests.js
// ---------------------------------------------------------------------------

describe('v2.2.15 P1-06 — validate-tester-runs-tests', () => {
  const HOOK = path.resolve(__dirname, '..', 'validate-tester-runs-tests.js');

  function runHook(payload, env = {}) {
    const tmp = makeTmp('p106-');
    writeOrchMarker(tmp, 'orch-test-p106');
    const baseEnv = { ...process.env };
    delete baseEnv.ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED;
    const r = spawnSync(NODE, [HOOK], {
      input: JSON.stringify({ ...payload, cwd: tmp, hook_event_name: 'SubagentStop' }),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...env },
    });
    return { ...r, tmp };
  }

  test('non-tester role → pass-through (exit 0)', () => {
    const { status, tmp } = runHook({ subagent_type: 'developer' });
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('tester, tests_passing false → exit 0 (no claim)', () => {
    const sr = JSON.stringify({ status: 'success', summary: 'done', files_changed: [], files_read: [], issues: [], tests_passing: false });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'tester', output });
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('tester, tests_passing true, no evidence → warn (ramp count 1, exit 0)', () => {
    const sr = JSON.stringify({ status: 'success', summary: 'done', files_changed: [], files_read: [], issues: [], tests_passing: true });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'tester', output });
    const events = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 0);
    const warnEvent = events.find(e => e.type === 'tester_runs_tests_gate_warn');
    assert.ok(warnEvent, 'should emit tester_runs_tests_gate_warn');
    assert.equal(warnEvent.ramp_count, 1);
  });

  test('kill switch → bypass entirely (exit 0, no event)', () => {
    const sr = JSON.stringify({ status: 'success', summary: 'done', files_changed: [], files_read: [], issues: [], tests_passing: true });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook(
      { subagent_type: 'tester', output },
      { ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED: '1' }
    );
    const events = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 0);
    assert.equal(events.length, 0);
  });

  test('module exports are present', () => {
    const mod = require('../validate-tester-runs-tests');
    assert.ok(typeof mod.extractTestsPassing === 'function');
    assert.ok(typeof mod.hasTestRunnerEvidence === 'function');
    assert.ok(mod.TEST_RUNNER_RE instanceof RegExp);
    assert.ok(mod.TEST_RUNNER_RE.test('npm test'));
    assert.ok(mod.TEST_RUNNER_RE.test('npx vitest run'));
    assert.ok(!mod.TEST_RUNNER_RE.test('echo hello'));
  });
});

// ---------------------------------------------------------------------------
// P1-07 — validate-pattern-application.js
// ---------------------------------------------------------------------------

describe('v2.2.15 P1-07 — validate-pattern-application', () => {
  const HOOK = path.resolve(__dirname, '..', 'validate-pattern-application.js');
  const { scanAuditWindow } = require('../validate-pattern-application');

  function runHook(payload, eventsContent, env = {}) {
    const tmp = makeTmp('p107-');
    writeOrchMarker(tmp, 'orch-test-p107');
    if (eventsContent) {
      fs.writeFileSync(path.join(tmp, '.orchestray', 'audit', 'events.jsonl'), eventsContent, 'utf8');
    }
    const baseEnv = { ...process.env };
    delete baseEnv.ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED;
    const r = spawnSync(NODE, [HOOK], {
      input: JSON.stringify({ ...payload, cwd: tmp, hook_event_name: 'SubagentStop' }),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...env },
    });
    return { ...r, tmp };
  }

  test('no pattern_find in audit window → pass-through (exit 0)', () => {
    const events = JSON.stringify({ type: 'agent_start', orchestration_id: 'x' }) + '\n';
    const { status, tmp } = runHook({ subagent_type: 'developer' }, events);
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('pattern_find + ack → exit 0', () => {
    const lines = [
      JSON.stringify({ type: 'mcp_checkpoint_recorded', tool: 'mcp__orchestray__pattern_find', slug: 'p' }),
      JSON.stringify({ type: 'mcp_checkpoint_recorded', tool: 'mcp__orchestray__pattern_record_application', slug: 'p' }),
    ].join('\n') + '\n';
    const { status, tmp } = runHook({ subagent_type: 'developer' }, lines);
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('pattern_find without ack → warn event emitted (ramp, exit 0)', () => {
    const lines = JSON.stringify({ type: 'mcp_checkpoint_recorded', tool: 'mcp__orchestray__pattern_find', slug: 'p' }) + '\n';
    const { status, tmp } = runHook({ subagent_type: 'developer' }, lines);
    const evts = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 0);
    const warnEvt = evts.find(e => e.type === 'pattern_application_gate_warn');
    assert.ok(warnEvt, 'should emit pattern_application_gate_warn');
  });

  test('kill switch → bypass entirely (exit 0)', () => {
    const lines = JSON.stringify({ type: 'mcp_checkpoint_recorded', tool: 'mcp__orchestray__pattern_find', slug: 'p' }) + '\n';
    const { status, tmp } = runHook(
      { subagent_type: 'developer' },
      lines,
      { ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED: '1' }
    );
    const evts = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 0);
    // Kill switch: no gate events emitted (seed event from test setup is present but no warn/block)
    const gateEvts = evts.filter(e =>
      e.type === 'pattern_application_gate_warn' ||
      e.type === 'pattern_application_gate_blocked'
    );
    assert.equal(gateEvts.length, 0);
  });

  test('scanAuditWindow: detects pattern_find via tool_name field', () => {
    const tmp = makeTmp('scan-');
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'audit', 'events.jsonl'),
      JSON.stringify({ tool_name: 'mcp__orchestray__pattern_find' }) + '\n',
      'utf8'
    );
    const result = scanAuditWindow(tmp);
    cleanup(tmp);
    assert.equal(result.hasPatternFind, true);
    assert.equal(result.hasAck, false);
  });
});

// ---------------------------------------------------------------------------
// P1-08 — pattern-citation-render.js reviewer never gets [CACHED]
// ---------------------------------------------------------------------------

describe('v2.2.15 P1-08 — pattern-citation-render reviewer no CACHED', () => {
  const { renderCitation } = require('../_lib/pattern-citation-render');

  const mockMatch = {
    slug: 'test-pattern',
    body: 'Pattern body content here.',
    description: 'Pattern description.',
    source: 'local',
    confidence: 0.9,
    times_applied: 5,
  };

  test('reviewer always gets full body (citeCache=true, seen=false)', () => {
    const result = renderCitation(mockMatch, 'reviewer', 'orch-test-1', true, os.tmpdir());
    assert.ok(result.includes('Pattern body content'), 'full body in output');
    assert.ok(!result.includes('[CACHED'), 'no CACHED marker for reviewer');
  });

  test('reviewer always gets full body (citeCache=true, hypothetical seen)', () => {
    // Even if we call twice with same orchId, reviewer should never see CACHED
    const orchId = 'orch-reviewer-test-' + Date.now();
    const tmp = makeTmp('p108-');
    const r1 = renderCitation(mockMatch, 'reviewer', orchId, true, tmp);
    const r2 = renderCitation(mockMatch, 'reviewer', orchId, true, tmp);
    cleanup(tmp);
    assert.ok(!r1.includes('[CACHED'), 'first reviewer cite: no CACHED');
    assert.ok(!r2.includes('[CACHED'), 'second reviewer cite: no CACHED — reviewer always gets full body');
    assert.ok(r2.includes('Pattern body content'), 'second reviewer cite still has body');
  });

  test('non-reviewer CAN see CACHED on second cite', () => {
    const orchId = 'orch-dev-test-' + Date.now();
    const tmp = makeTmp('p108dev-');
    const r1 = renderCitation(mockMatch, 'developer', orchId, true, tmp);
    const r2 = renderCitation(mockMatch, 'developer', orchId, true, tmp);
    cleanup(tmp);
    assert.ok(r1.includes('Pattern body content'), 'first developer cite has body');
    // Second cite for developer should be CACHED
    assert.ok(r2.includes('[CACHED'), 'second developer cite has CACHED marker');
  });

  test('reviewer with citeCache=false still gets full body', () => {
    const result = renderCitation(mockMatch, 'reviewer', 'orch-test-2', false, os.tmpdir());
    assert.ok(result.includes('Pattern body content'), 'full body when citeCache=false');
    assert.ok(!result.includes('[CACHED'), 'no CACHED marker');
  });
});

// ---------------------------------------------------------------------------
// P1-09 — validate-researcher-citations.js
// ---------------------------------------------------------------------------

describe('v2.2.15 P1-09 — validate-researcher-citations', () => {
  const HOOK = path.resolve(__dirname, '..', 'validate-researcher-citations.js');
  const { countSources, isNoClearFit, extractStructuredResult } = require('../validate-researcher-citations');

  function runHook(payload, env = {}) {
    const tmp = makeTmp('p109-');
    const baseEnv = { ...process.env };
    delete baseEnv.ORCHESTRAY_RESEARCHER_CITATIONS_GATE_DISABLED;
    const r = spawnSync(NODE, [HOOK], {
      input: JSON.stringify({ ...payload, cwd: tmp, hook_event_name: 'SubagentStop' }),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...env },
    });
    return { ...r, tmp };
  }

  test('non-researcher role → pass-through (exit 0)', () => {
    const { status, tmp } = runHook({ subagent_type: 'developer' });
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('no_clear_fit verdict → exit 0', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 'no_clear_fit', files_changed: [], files_read: [], issues: [],
      verdict: 'no_clear_fit',
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'researcher', output });
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('verdict present, 3 sources → exit 0', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 'found options', files_changed: [], files_read: [], issues: [],
      verdict: 'recommend_zod',
      sources: [
        { url: 'https://example.com/1', title: 'Source 1' },
        { url: 'https://example.com/2', title: 'Source 2' },
        { url: 'https://example.com/3', title: 'Source 3' },
      ],
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'researcher', output });
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('verdict present, 1 source → exit 2 with gate_blocked event', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 'found one option', files_changed: [], files_read: [], issues: [],
      verdict: 'recommend_zod',
      sources: [{ url: 'https://example.com/1', title: 'Source 1' }],
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'researcher', output });
    const evts = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 2);
    const blocked = evts.find(e => e.type === 'researcher_citations_gate_blocked');
    assert.ok(blocked, 'should emit researcher_citations_gate_blocked');
    assert.equal(blocked.source_count, 1);
    assert.equal(blocked.min_sources, 3);
  });

  test('kill switch → bypass (exit 0)', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 's', files_changed: [], files_read: [], issues: [],
      verdict: 'recommend',
      sources: [],
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook(
      { subagent_type: 'researcher', output },
      { ORCHESTRAY_RESEARCHER_CITATIONS_GATE_DISABLED: '1' }
    );
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('countSources: sources array', () => {
    assert.equal(countSources({ sources: ['a', 'b', 'c'] }), 3);
  });

  test('countSources: citations array fallback', () => {
    assert.equal(countSources({ citations: ['x', 'y'] }), 2);
  });

  test('isNoClearFit: recognizes no_clear_fit verdict', () => {
    assert.equal(isNoClearFit({ verdict: 'no_clear_fit' }), true);
    assert.equal(isNoClearFit({ verdict: 'recommend_zod' }), false);
    assert.equal(isNoClearFit(null), true);
  });
});

// ---------------------------------------------------------------------------
// P1-10 — validate-platform-oracle-grounding.js
// ---------------------------------------------------------------------------

describe('v2.2.15 P1-10 — validate-platform-oracle-grounding', () => {
  const HOOK = path.resolve(__dirname, '..', 'validate-platform-oracle-grounding.js');
  const { validateGrounding, VALID_STABILITY_TIERS } = require('../validate-platform-oracle-grounding');

  function runHook(payload, env = {}) {
    const tmp = makeTmp('p110-');
    const baseEnv = { ...process.env };
    delete baseEnv.ORCHESTRAY_PLATFORM_ORACLE_GROUNDING_GATE_DISABLED;
    const r = spawnSync(NODE, [HOOK], {
      input: JSON.stringify({ ...payload, cwd: tmp, hook_event_name: 'SubagentStop' }),
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...baseEnv, ...env },
    });
    return { ...r, tmp };
  }

  test('non-platform-oracle role → pass-through (exit 0)', () => {
    const { status, tmp } = runHook({ subagent_type: 'developer' });
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('valid single-claim SR → exit 0', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 's', files_changed: [], files_read: [], issues: [],
      stability_tier: 'stable',
      source_url: 'https://docs.claude.ai/foo',
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'platform-oracle', output });
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('missing stability_tier → exit 2 with gate_blocked event', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 's', files_changed: [], files_read: [], issues: [],
      source_url: 'https://docs.claude.ai/foo',
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'platform-oracle', output });
    const evts = readEvents(tmp);
    cleanup(tmp);
    assert.equal(status, 2);
    const blocked = evts.find(e => e.type === 'platform_oracle_grounding_gate_blocked');
    assert.ok(blocked, 'should emit platform_oracle_grounding_gate_blocked');
    assert.ok(blocked.violations.length > 0);
  });

  test('missing source_url → exit 2', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 's', files_changed: [], files_read: [], issues: [],
      stability_tier: 'experimental',
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook({ subagent_type: 'platform-oracle', output });
    cleanup(tmp);
    assert.equal(status, 2);
  });

  test('kill switch → bypass (exit 0)', () => {
    const sr = JSON.stringify({
      status: 'success', summary: 's', files_changed: [], files_read: [], issues: [],
    });
    const output = `## Structured Result\n\n\`\`\`json\n${sr}\n\`\`\``;
    const { status, tmp } = runHook(
      { subagent_type: 'platform-oracle', output },
      { ORCHESTRAY_PLATFORM_ORACLE_GROUNDING_GATE_DISABLED: '1' }
    );
    cleanup(tmp);
    assert.equal(status, 0);
  });

  test('validateGrounding: multi-claim with claims array', () => {
    const sr = {
      claims: [
        { stability_tier: 'stable', source_url: 'https://example.com' },
        { stability_tier: 'experimental', source_url: 'https://example.com/2' },
      ],
    };
    const { valid } = validateGrounding(sr);
    assert.equal(valid, true);
  });

  test('validateGrounding: multi-claim missing source_url', () => {
    const sr = {
      claims: [
        { stability_tier: 'stable' },
      ],
    };
    const { valid, violations } = validateGrounding(sr);
    assert.equal(valid, false);
    assert.ok(violations.some(v => v.includes('source_url')));
  });

  test('VALID_STABILITY_TIERS covers required values', () => {
    assert.ok(VALID_STABILITY_TIERS.has('stable'));
    assert.ok(VALID_STABILITY_TIERS.has('experimental'));
    assert.ok(VALID_STABILITY_TIERS.has('community'));
    assert.equal(VALID_STABILITY_TIERS.size, 3);
  });
});
