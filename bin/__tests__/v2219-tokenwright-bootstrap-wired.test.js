#!/usr/bin/env node
'use strict';

/**
 * v2219-tokenwright-bootstrap-wired.test.js — S2 wiring acceptance tests.
 *
 * Verifies that inject-tokenwright.js calls bootstrapEstimate() instead of
 * the static bytes/4 formula when historical samples exist.
 *
 * Tests:
 *   1. No samples → static fallback (500) is used as inTokEst; journal entry
 *      contains input_token_estimate: 500.
 *   2. Sufficient samples present → rolling median is used; journal entry
 *      contains input_token_estimate equal to the median, not bytes/4.
 *   3. resolveActualTokens: transcript-path provided but containment-rejected →
 *      returns source:'unknown', does NOT fall back to event.usage.input_tokens.
 *
 * Runner: node --test bin/__tests__/v2219-tokenwright-bootstrap-wired.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const INJECT_PATH    = path.join(REPO_ROOT, 'bin', 'inject-tokenwright.js');
const RESOLVE_PATH   = path.join(REPO_ROOT, 'bin', '_lib', 'tokenwright', 'resolve-actual-tokens');
const SCHEMA_PATH    = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE           = process.execPath;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2219-bootstrap-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  if (fs.existsSync(SCHEMA_PATH)) {
    fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  }
  // Disable shadow validation to avoid version-field noise in tests.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'config.json'),
    JSON.stringify({
      event_schema_shadow: { enabled: false },
      // Enable L1 so inject runs compression (and writes journal) in these tests.
      tokenwright: { l1_compression_enabled: true },
    }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-bootstrap-test' }),
    'utf8'
  );
  return root;
}

function writeSavingsEvents(root, agentType, tokenValues) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  const lines = tokenValues.map(t => JSON.stringify({
    type:                  'tokenwright_realized_savings',
    event_type:            'tokenwright_realized_savings',
    agent_type:            agentType,
    actual_input_tokens:   t,
    estimated_input_tokens_pre: 500,
    technique_tag:         'safe-l1',
    version:               1,
    timestamp:             new Date().toISOString(),
  }));
  fs.writeFileSync(eventsPath, lines.join('\n') + '\n', 'utf8');
}

function runInject(root, agentType, prompt) {
  const payload = {
    tool_name:  'Agent',
    tool_input: { subagent_type: agentType, prompt },
    cwd:        root,
  };
  const env = Object.assign({}, process.env, {
    ORCHESTRAY_PROJECT_ROOT: root,
  });
  return cp.spawnSync(NODE, [INJECT_PATH], {
    input:    JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout:  8000,
  });
}

function readPending(root) {
  const p = path.join(root, '.orchestray', 'state', 'tokenwright-pending.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2219-S2-bootstrap-wired', () => {

  test('1. no historical samples → static fallback 500 used as inTokEst', () => {
    const root = makeTmpRoot();
    // No events.jsonl written — bootstrap will see 0 samples and return STATIC_FALLBACK=500.
    const prompt = 'Hello researcher, please investigate the following topic: tokenwright.';
    const result = runInject(root, 'researcher', prompt);

    assert.equal(result.status, 0, 'hook should exit 0\nstderr: ' + result.stderr);

    const entries = readPending(root);
    assert.ok(entries.length > 0, 'should have written a pending journal entry');
    const entry = entries[0];
    assert.equal(entry.input_token_estimate, 500,
      'static fallback of 500 expected when no samples; got ' + entry.input_token_estimate);
  });

  test('2. sufficient samples present → rolling median used, not bytes/4', () => {
    const root = makeTmpRoot();
    // Write 5 samples with median = 1000.
    writeSavingsEvents(root, 'developer', [800, 900, 1000, 1100, 1200]);

    // Use a prompt long enough that bytes/4 would differ significantly from 1000.
    // 4000 bytes → bytes/4 = 1000. To make them differ, use ~8000 bytes → bytes/4 = 2000.
    const prompt = 'x'.repeat(8000);
    const result = runInject(root, 'developer', prompt);

    assert.equal(result.status, 0, 'hook should exit 0\nstderr: ' + result.stderr);

    const entries = readPending(root);
    assert.ok(entries.length > 0, 'should have written a pending journal entry');
    const entry = entries[0];
    // bootstrapEstimate with median=1000 should win over bytes/4=2000.
    assert.equal(entry.input_token_estimate, 1000,
      'rolling median 1000 expected; got ' + entry.input_token_estimate +
      ' (bytes/4 would be ' + Math.round(Buffer.byteLength(prompt, 'utf8') / 4) + ')');
  });

  test('3. resolveActualTokens: transcript-path provided but containment-rejected → source unknown, does not use event.usage.input_tokens', () => {
    // This test exercises the fix directly on resolve-actual-tokens.js (unit test).
    const { resolveActualTokens } = require(RESOLVE_PATH);

    // Fabricate a fake cwd that the transcript path is NOT inside.
    const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'v2219-cwd-'));

    // Transcript path points somewhere outside fakeCwd (e.g. /tmp itself).
    const outsidePath = os.tmpdir();

    const event = {
      agent_transcript_path: outsidePath,
      usage: {
        // Large cumulative session value — should NOT be returned.
        input_tokens: 99999,
      },
    };

    const result = resolveActualTokens(event, fakeCwd);

    assert.equal(result.source, 'unknown',
      'containment-rejected transcript must yield source:"unknown", got: ' + result.source);
    assert.equal(result.tokens, 0,
      'containment-rejected transcript must yield tokens:0, got: ' + result.tokens);
  });

});
