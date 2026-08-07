#!/usr/bin/env node
'use strict';

/**
 * v2.2.15 Wave B-1 validator tests.
 *
 * Coverage:
 *   P1-05 detectMultipleStructuredResultBlocks (validate-task-completion.js)
 *   P1-08 pattern-citation-render.js reviewer  ≥3 cases
 *
 * P1-06/07/09/10 covered the four point-gates the Claim–Evidence Ledger
 * retired in v2.3.18 (W4). Their cases now live in
 * `v2318-w4-claim-evidence-ledger.test.js` under "retirement proofs".
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

  test('two blocks → emits multiple_structured_result_blocks with block_count 2 (exit 2 in v2.2.17)', () => {
    const block = '## Structured Result\n\n```json\n{"status":"success","summary":"done","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```';
    const output = block + '\n\nSome more content\n\n' + block;
    const { status, stderr, tmp } = runHookP105(output);
    const events = readEvents(tmp);
    cleanup(tmp);
    // Promoted to exit 2 in v2.2.17 (was warn-only in v2.2.15).
    assert.equal(status, 2, 'exit 2 (P1-05 promoted in v2.2.17)');
    const multiEvent = events.find(e => e.type === 'multiple_structured_result_blocks');
    assert.ok(multiEvent, 'multiple_structured_result_blocks event must be emitted');
    assert.equal(multiEvent.block_count, 2, 'block_count must be 2');
    assert.ok(stderr.includes('BLOCKED'), 'stderr must include BLOCKED');
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

