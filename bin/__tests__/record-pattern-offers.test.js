#!/usr/bin/env node
'use strict';

/**
 * record-pattern-offers.test.js — Phase 1 offer-ledger hook tests.
 *
 * Verifies:
 *   1. Curated citation to an existing pattern → ledger row + pattern_offered event.
 *   2. Ambient TOON-catalog offer to an existing pattern → same, offer_kind=ambient.
 *   3. No patterns in prompt → 0 ledger rows, 0 events.
 *   4. Unresolvable slug only (pattern file absent) → 0 ledger rows, 0 events
 *      (design §8.1: pattern_offered fires only when ≥1 slug resolves).
 *   5. Kill switch ORCHESTRAY_PATTERN_EVIDENCE_DISABLED=1 → 0 emits.
 *   6. Non-Agent tool_name → no-op.
 *   7. task_id / spawn_id / agent_role resolved onto both the ledger row and the event.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/__tests__/record-pattern-offers.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'record-pattern-offers.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-offer-hook-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'patterns'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writePatternFile(slug) {
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'patterns', slug + '.md'),
    '---\nslug: ' + slug + '\nconfidence: 0.8\n---\n# ' + slug + '\n'
  );
}

function runHook(payload, extraEnv) {
  const env = Object.assign({}, process.env, extraEnv || {});
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  if (result.error) throw result.error;

  let stdout = {};
  try { stdout = JSON.parse(result.stdout || '{}'); } catch (_) {}

  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  const events = [];
  if (fs.existsSync(eventsPath)) {
    for (const line of fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch (_) {}
    }
  }

  const offersPath = path.join(tmpDir, '.orchestray', 'state', 'pattern-offers.jsonl');
  const offerRows = [];
  if (fs.existsSync(offersPath)) {
    for (const line of fs.readFileSync(offersPath, 'utf8').split('\n').filter(Boolean)) {
      try { offerRows.push(JSON.parse(line)); } catch (_) {}
    }
  }

  return { stdout, events, offerRows };
}

function buildPayload({ prompt, toolName = 'Agent', extraToolInput = {} }) {
  return {
    tool_name: toolName,
    tool_input: Object.assign({ subagent_type: 'developer', prompt, agent_id: 'spawn-001' }, extraToolInput),
    cwd: tmpDir,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('TC-1: curated citation to an existing pattern → ledger row + pattern_offered event', () => {
  writePatternFile('foo-bar');
  const payload = buildPayload({ prompt: 'Use @orchestray:pattern://foo-bar [local] conf 0.82, applied 3x here.' });

  const { stdout, events, offerRows } = runHook(payload);

  assert.deepEqual(stdout, { continue: true });
  assert.equal(offerRows.length, 1);
  assert.equal(offerRows[0].offers[0].slug, 'foo-bar');
  assert.equal(offerRows[0].offers[0].offer_kind, 'curated');

  const offered = events.filter((e) => e.type === 'pattern_offered');
  assert.equal(offered.length, 1);
  assert.deepEqual(offered[0].slugs_curated, ['foo-bar']);
  assert.deepEqual(offered[0].slugs_ambient, []);
  assert.equal(offered[0].shape_detected, 'uri_only');
});

test('TC-2: ambient TOON-catalog offer to an existing pattern → offer_kind=ambient', () => {
  writePatternFile('toon-slug');
  const grounding = [
    '<mcp-grounding cache_hint="transient">',
    '## pattern_find results',
    JSON.stringify({ mode: 'catalog', catalog: 'PATTERN slug=toon-slug confidence=0.70 one_line="" hook=""' }, null, 2),
    '</mcp-grounding>',
  ].join('\n');
  const payload = buildPayload({ prompt: 'Task.\n\n' + grounding });

  const { events, offerRows } = runHook(payload);

  assert.equal(offerRows.length, 1);
  assert.equal(offerRows[0].offers[0].offer_kind, 'ambient');
  assert.equal(offerRows[0].shape_detected, 'toon_catalog');

  const offered = events.filter((e) => e.type === 'pattern_offered');
  assert.equal(offered.length, 1);
  assert.deepEqual(offered[0].slugs_ambient, ['toon-slug']);
});

test('TC-3: no patterns in prompt → 0 ledger rows, 0 events', () => {
  const payload = buildPayload({ prompt: 'Just implement the feature, no patterns here.' });
  const { stdout, events, offerRows } = runHook(payload);
  assert.deepEqual(stdout, { continue: true });
  assert.equal(offerRows.length, 0);
  assert.equal(events.filter((e) => e.type === 'pattern_offered').length, 0);
});

test('TC-4: unresolvable slug only (no pattern file) → 0 ledger rows, 0 events', () => {
  // No writePatternFile() call — "fake-slug" resolves to nothing on disk.
  const payload = buildPayload({ prompt: 'Consider @orchestray:pattern://fake-slug for this task.' });
  const { events, offerRows } = runHook(payload);
  assert.equal(offerRows.length, 0);
  assert.equal(events.filter((e) => e.type === 'pattern_offered').length, 0);
});

test('TC-5: kill switch ORCHESTRAY_PATTERN_EVIDENCE_DISABLED=1 → 0 emits', () => {
  writePatternFile('foo-bar');
  const payload = buildPayload({ prompt: 'Use @orchestray:pattern://foo-bar here.' });
  const { events, offerRows } = runHook(payload, { ORCHESTRAY_PATTERN_EVIDENCE_DISABLED: '1' });
  assert.equal(offerRows.length, 0);
  assert.equal(events.filter((e) => e.type === 'pattern_offered').length, 0);
});

test('TC-5b: config.pattern_evidence.enabled=false → 0 emits', () => {
  writePatternFile('foo-bar');
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'config.json'),
    JSON.stringify({ pattern_evidence: { enabled: false } })
  );
  const payload = buildPayload({ prompt: 'Use @orchestray:pattern://foo-bar here.' });
  const { offerRows } = runHook(payload);
  assert.equal(offerRows.length, 0);
});

test('TC-6: non-Agent tool_name → no-op', () => {
  writePatternFile('foo-bar');
  const payload = buildPayload({ prompt: 'Use @orchestray:pattern://foo-bar here.', toolName: 'Bash' });
  const { stdout, offerRows } = runHook(payload);
  assert.deepEqual(stdout, { continue: true });
  assert.equal(offerRows.length, 0);
});

test('TC-7: task_id/spawn_id/agent_role resolved onto the ledger row and event', () => {
  writePatternFile('foo-bar');
  const payload = buildPayload({
    prompt: 'Use @orchestray:pattern://foo-bar here.',
    extraToolInput: { task_id: 'W7', agent_id: 'spawn-xyz', subagent_type: 'tester' },
  });
  const { events, offerRows } = runHook(payload);

  assert.equal(offerRows[0].task_id, 'W7');
  assert.equal(offerRows[0].spawn_id, 'spawn-xyz');
  assert.equal(offerRows[0].agent_role, 'tester');

  const offered = events.find((e) => e.type === 'pattern_offered');
  assert.equal(offered.task_id, 'W7');
  assert.equal(offered.spawn_id, 'spawn-xyz');
  assert.equal(offered.agent_role, 'tester');
});
