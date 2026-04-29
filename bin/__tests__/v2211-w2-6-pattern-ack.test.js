#!/usr/bin/env node
'use strict';

/**
 * v2211-w2-6-pattern-ack.test.js — W2-6 validate-pattern-ack.js tests.
 *
 * Verifies:
 *   1. Architect spawn with 0 high-confidence patterns offered → 0 emits.
 *   2. Architect spawn with 2 patterns offered, summary references 1 → 0 emits.
 *   3. Architect spawn with 2 patterns offered, 0 referenced → 1 emit with both slugs.
 *   4. Non-architect spawn (developer) → 0 emits regardless of grounding.
 *   5. Kill switch ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1 → 0 emits.
 *   6. Schema validation: emitted event passes shadow allowlist check.
 *
 * Runner: node --test bin/__tests__/v2211-w2-6-pattern-ack.test.js
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'validate-pattern-ack.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-w2-6-'));
  // Minimal .orchestray/audit directory
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal <mcp-grounding> block embedding pattern_find results.
 *
 * @param {Array<{slug: string, confidence: number}>} patterns
 * @returns {string}
 */
function buildGrounding(patterns) {
  const pfSection = JSON.stringify({ matches: patterns }, null, 2);
  return [
    '<mcp-grounding cache_hint="transient">',
    '[role: architect | timestamp: 2026-01-01T00:00:00.000Z]',
    '## pattern_find results',
    pfSection,
    '</mcp-grounding>',
  ].join('\n');
}

/**
 * Build a minimal architect PostToolUse:Agent payload.
 *
 * @param {object} opts
 * @param {string[]}  opts.patterns  - Array of {slug, confidence} pattern objects
 * @param {string}    opts.summary   - Structured result summary text
 * @param {string}    [opts.role]    - Subagent role (default: architect)
 * @returns {object}
 */
function buildPayload({ patterns = [], summary = '', role = 'architect' } = {}) {
  const groundingBlock = buildGrounding(patterns);
  const structuredResult = JSON.stringify({
    status: 'success',
    summary,
    files_changed: [],
    files_read: [],
    issues: [],
    assumptions: [],
  });
  const prompt = [
    '# Architect Task',
    groundingBlock,
    '## Task description',
    'Design something.',
  ].join('\n\n');

  const toolResponse = [
    'Some architect reasoning.',
    '',
    '## Structured Result',
    '```json',
    structuredResult,
    '```',
  ].join('\n');

  return {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: role,
      prompt,
      agent_id: 'spawn-test-001',
    },
    tool_response: toolResponse,
    cwd: tmpDir,
  };
}

/**
 * Run the validator script with the given payload, returning parsed stdout and
 * the list of emitted audit events.
 *
 * @param {object} payload
 * @param {object} [extraEnv]
 * @returns {{ stdout: object, events: object[] }}
 */
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

  // Read emitted events from audit/events.jsonl
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  const events = [];
  if (fs.existsSync(eventsPath)) {
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch (_) {}
    }
  }

  return { stdout, events };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('TC-1: 0 high-confidence patterns offered → 0 emits', () => {
  const payload = buildPayload({
    patterns: [
      { slug: 'low-confidence-slug', confidence: 0.3 },
      { slug: 'medium-slug', confidence: 0.5 },
    ],
    summary: 'Design completed without any pattern references.',
  });

  const { stdout, events } = runHook(payload);

  assert.deepEqual(stdout, { continue: true }, 'stdout must be { continue: true }');
  const ackEvents = events.filter(e => e.type === 'architect_pattern_ack_missing');
  assert.equal(ackEvents.length, 0, 'no architect_pattern_ack_missing events expected');
});

test('TC-2: 2 patterns offered, summary references 1 slug → 0 emits', () => {
  const payload = buildPayload({
    patterns: [
      { slug: 'decompose-parallel', confidence: 0.8 },
      { slug: 'event-schema-declare', confidence: 0.9 },
    ],
    summary: 'Used decompose-parallel pattern to split work across agents.',
  });

  const { stdout, events } = runHook(payload);

  assert.deepEqual(stdout, { continue: true });
  const ackEvents = events.filter(e => e.type === 'architect_pattern_ack_missing');
  assert.equal(ackEvents.length, 0, 'acknowledged slug should suppress event');
});

test('TC-3: 2 patterns offered, 0 referenced → 1 emit with both slugs', () => {
  const payload = buildPayload({
    patterns: [
      { slug: 'decompose-parallel', confidence: 0.8 },
      { slug: 'event-schema-declare', confidence: 0.9 },
    ],
    summary: 'Design uses a new approach not from the catalog.',
  });

  const { stdout, events } = runHook(payload);

  assert.deepEqual(stdout, { continue: true });
  const ackEvents = events.filter(e => e.type === 'architect_pattern_ack_missing');
  assert.equal(ackEvents.length, 1, 'exactly 1 architect_pattern_ack_missing event expected');

  const evt = ackEvents[0];
  assert.equal(evt.type, 'architect_pattern_ack_missing');
  assert.ok(Array.isArray(evt.pattern_slugs_offered), 'pattern_slugs_offered must be array');
  assert.equal(evt.pattern_slugs_offered.length, 2, 'both slugs must be in pattern_slugs_offered');
  assert.ok(evt.pattern_slugs_offered.includes('decompose-parallel'), 'decompose-parallel must be included');
  assert.ok(evt.pattern_slugs_offered.includes('event-schema-declare'), 'event-schema-declare must be included');
  assert.equal(evt.schema_version, 1, 'schema_version must be 1');
  assert.equal(evt.spawn_id, 'spawn-test-001', 'spawn_id must match tool_input.agent_id');
});

test('TC-4: non-architect spawn (developer) → 0 emits regardless of grounding', () => {
  const payload = buildPayload({
    role: 'developer',
    patterns: [
      { slug: 'decompose-parallel', confidence: 0.9 },
    ],
    summary: 'Implemented without referencing any patterns.',
  });

  const { stdout, events } = runHook(payload);

  assert.deepEqual(stdout, { continue: true });
  const ackEvents = events.filter(e => e.type === 'architect_pattern_ack_missing');
  assert.equal(ackEvents.length, 0, 'non-architect spawns must not trigger pattern-ack check');
});

test('TC-5: kill switch ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1 → 0 emits', () => {
  const payload = buildPayload({
    patterns: [
      { slug: 'decompose-parallel', confidence: 0.85 },
    ],
    summary: 'Design with no slug reference.',
  });

  const { stdout, events } = runHook(payload, { ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED: '1' });

  assert.deepEqual(stdout, { continue: true });
  const ackEvents = events.filter(e => e.type === 'architect_pattern_ack_missing');
  assert.equal(ackEvents.length, 0, 'kill switch must suppress all events');
});

test('TC-6: schema validation — emitted event passes shadow allowlist', () => {
  // Read shadow JSON from worktree (real schema file).
  const shadowPath = path.resolve(__dirname, '..', '..', 'agents', 'pm-reference', 'event-schemas.shadow.json');
  assert.ok(fs.existsSync(shadowPath), 'shadow file must exist');
  const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
  assert.ok('architect_pattern_ack_missing' in shadow,
    'architect_pattern_ack_missing must be declared in event-schemas.shadow.json');

  const entry = shadow['architect_pattern_ack_missing'];
  assert.ok(entry && typeof entry === 'object', 'shadow entry must be an object');
  assert.equal(entry.v, 1, 'version must be 1 in shadow entry');
});

test('TC-7: no grounding block in prompt → no check, 0 emits (safe-on-missing)', () => {
  // Payload with architect but no <mcp-grounding> in prompt.
  const payload = {
    tool_name: 'Agent',
    tool_input: {
      subagent_type: 'architect',
      prompt: '# Task\n\nDesign without grounding.',
      agent_id: 'spawn-no-ground',
    },
    tool_response: '## Structured Result\n```json\n{"status":"success","summary":"done","files_changed":[],"files_read":[],"issues":[],"assumptions":[]}\n```',
    cwd: tmpDir,
  };

  const { stdout, events } = runHook(payload);

  assert.deepEqual(stdout, { continue: true });
  const ackEvents = events.filter(e => e.type === 'architect_pattern_ack_missing');
  assert.equal(ackEvents.length, 0, 'missing grounding must result in no-op');
});
