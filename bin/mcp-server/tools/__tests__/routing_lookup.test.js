#!/usr/bin/env node
'use strict';

/**
 * Tests for R-FPX field projection in routing_lookup (v2.1.12).
 *
 * Test plan:
 *   T1. No `fields` → full legacy response (backward compat)
 *   T2. fields=["ts","agent_type"] → only those keys in each match
 *   T3. fields=["nonexistent"] → empty objects per match (unknown fields silently skipped)
 *   T4. fields="ts,model" (comma string) → projection works with string form
 *   T5. fields="ts.model" (dot notation) → isError, forbidden
 *   T6. Byte-count reduction ≥ 50% on representative fixture (AC-03)
 *
 * Runner: node --test bin/mcp-server/tools/__tests__/routing_lookup.test.js
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle } = require('../routing_lookup.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rl-test-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'audit'), { recursive: true });
  return projectRoot;
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

/**
 * Write a routing.jsonl with N entries for the given orchestration_id.
 */
function writeRoutingEntries(projectRoot, orchId, count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
      orchestration_id: orchId,
      task_id: 'task-' + (i + 1),
      agent_type: i % 2 === 0 ? 'developer' : 'reviewer',
      model: 'sonnet',
      effort: 'medium',
      description: 'Task description ' + i + ' with a longer rationale to add bulk to the entry',
      rationale: 'This rationale is intentionally verbose to make the entry large enough for byte reduction tests. ' +
        'It contains many words to ensure a significant byte difference between full and projected responses.',
      complexity_score: 50 + i,
      decided_by: 'pm',
      decided_at: new Date().toISOString(),
    }));
  }
  const routingPath = path.join(projectRoot, '.orchestray', 'state', 'routing.jsonl');
  fs.writeFileSync(routingPath, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routing_lookup field projection (R-FPX)', () => {
  let projectRoot;

  before(() => {
    projectRoot = makeTmpProject();
    writeRoutingEntries(projectRoot, 'orch-test-123', 5);
  });

  after(() => {
    cleanup(projectRoot);
  });

  test('T1: no fields → full legacy response (backward compat)', async () => {
    const result = await handle(
      { orchestration_id: 'orch-test-123' },
      { projectRoot }
    );
    assert.equal(result.isError, false, 'should not be an error');
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.matches), 'matches should be an array');
    assert.ok(resp.matches.length > 0, 'should have at least one match');
    // Full response should have multiple fields per entry
    const firstMatch = resp.matches[0];
    assert.ok(Object.keys(firstMatch).length > 2, 'full response should have many fields');
  });

  test('T2: fields=["ts","agent_type"] → only those keys in each match', async () => {
    const result = await handle(
      { orchestration_id: 'orch-test-123', fields: ['ts', 'agent_type'] },
      { projectRoot }
    );
    assert.equal(result.isError, false);
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.matches));
    assert.ok(resp.matches.length > 0);
    for (const match of resp.matches) {
      const keys = Object.keys(match);
      // Should have only the requested keys (some may be absent if not in the entry)
      for (const key of keys) {
        assert.ok(['ts', 'agent_type'].includes(key), 'unexpected key: ' + key);
      }
    }
  });

  test('T3: fields=["nonexistent"] → empty objects per match (unknown fields silently skipped)', async () => {
    const result = await handle(
      { orchestration_id: 'orch-test-123', fields: ['nonexistent'] },
      { projectRoot }
    );
    assert.equal(result.isError, false);
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.matches));
    for (const match of resp.matches) {
      assert.deepEqual(match, {}, 'unknown fields should produce empty objects');
    }
  });

  test('T4: fields="ts,model" (comma string) → projection works', async () => {
    const result = await handle(
      { orchestration_id: 'orch-test-123', fields: 'ts,model' },
      { projectRoot }
    );
    assert.equal(result.isError, false);
    const resp = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(resp.matches));
    for (const match of resp.matches) {
      for (const key of Object.keys(match)) {
        assert.ok(['ts', 'model'].includes(key), 'unexpected key: ' + key);
      }
    }
  });

  test('T5: fields="ts.model" (dot notation) → error, forbidden', async () => {
    const result = await handle(
      { orchestration_id: 'orch-test-123', fields: 'ts.model' },
      { projectRoot }
    );
    assert.equal(result.isError, true, 'dot notation should be rejected');
  });

  test('T6: byte-count reduction ≥ 50% with fields=["ts","agent_type"] (AC-03)', async () => {
    // Full response
    const fullResult = await handle(
      { orchestration_id: 'orch-test-123' },
      { projectRoot }
    );
    const fullText = fullResult.content[0].text;

    // Projected response
    const projResult = await handle(
      { orchestration_id: 'orch-test-123', fields: ['ts', 'agent_type'] },
      { projectRoot }
    );
    const projText = projResult.content[0].text;

    const fullBytes = Buffer.byteLength(fullText, 'utf8');
    const projBytes = Buffer.byteLength(projText, 'utf8');

    assert.ok(
      projBytes < fullBytes * 0.5,
      'projected response should be < 50% of full response size; got ' +
        projBytes + ' vs ' + fullBytes + ' bytes (' +
        ((projBytes / fullBytes) * 100).toFixed(1) + '%)'
    );
  });
});
