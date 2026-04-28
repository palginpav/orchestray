'use strict';

/**
 * Test B1: Transcript-first token resolution.
 *
 * Verifies that resolveActualTokens:
 *   1. Returns {tokens: 1500, source: 'transcript'} when transcript has usage entries.
 *   2. Returns {tokens: 0, source: 'unknown'} when transcript is empty and hook payload is zero.
 */

const test  = require('node:test');
const assert = require('node:assert/strict');
const fs    = require('node:fs');
const os    = require('node:os');
const path  = require('node:path');
const { resolveActualTokens } = require('../../../bin/_lib/tokenwright/resolve-actual-tokens');

// ---------------------------------------------------------------------------
// Helper: create a throwaway tmp dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-b1-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

// ---------------------------------------------------------------------------
// Happy-path: transcript with two assistant usage entries summing to 1500
// (uncached tokens only — legacy shape still works)
// ---------------------------------------------------------------------------
test('resolveActualTokens: returns tokens=1500 and source=transcript from fixture JSONL', (t) => {
  const tmpDir = makeTmpDir(t);

  // Stage a minimal transcript JSONL in a path that passes the containment guard.
  // resolveActualTokens checks path against cwd OR ~/.claude, so we use tmpDir as cwd.
  const transcriptPath = path.join(tmpDir, 'session.jsonl');

  const entries = [
    { role: 'user',      content: 'hello'                                },
    { role: 'assistant', usage: { input_tokens: 800, output_tokens: 100 } },
    { role: 'assistant', usage: { input_tokens: 700, output_tokens: 200 } },
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const event = { agent_transcript_path: transcriptPath };
  const result = resolveActualTokens(event, tmpDir);

  assert.equal(result.source, 'transcript', 'source must be transcript');
  assert.equal(result.tokens, 1500, 'tokens must sum to 1500');
});

// ---------------------------------------------------------------------------
// Regression: cache tokens must be included in the sum.
//
// This test would have caught the v2.2.6 bug where only `input_tokens` was
// summed, ignoring `cache_creation_input_tokens` and `cache_read_input_tokens`.
//
// Real subagent transcripts (observed 2026-04-28) look like:
//   Turn 1: input_tokens=2, cache_creation_input_tokens=22252, cache_read_input_tokens=0
//   Turn 2: input_tokens=3, cache_creation_input_tokens=2515, cache_read_input_tokens=22252
//
// Old code returned 5 (sum of input_tokens only).
// Correct code must return 49024 (2+22252+0 + 3+2515+22252).
// The estimated side uses prompt_bytes/4 ≈ 22000+ tokens, so returning 5
// caused ~96% estimation_error_pct.
// ---------------------------------------------------------------------------
test('resolveActualTokens: includes cache_creation and cache_read tokens (regression for 96% error bug)', (t) => {
  const tmpDir = makeTmpDir(t);
  const transcriptPath = path.join(tmpDir, 'subagent.jsonl');

  // Mirrors real subagent transcript shape: mostly-cached prompt,
  // tiny uncached slice, plus growing cache_read on later turns.
  const entries = [
    { role: 'user', content: 'task delegation prompt' },
    {
      role: 'assistant',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 22252,
        cache_read_input_tokens: 0,
        output_tokens: 500,
      },
    },
    {
      role: 'assistant',
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 2515,
        cache_read_input_tokens: 22252,
        output_tokens: 300,
      },
    },
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const event = { agent_transcript_path: transcriptPath };
  const result = resolveActualTokens(event, tmpDir);

  assert.equal(result.source, 'transcript', 'source must be transcript');

  // Expected: (2+22252+0) + (3+2515+22252) = 22254 + 24770 = 49024
  const expected = (2 + 22252 + 0) + (3 + 2515 + 22252);
  assert.equal(result.tokens, expected,
    `tokens must include cache fields; expected ${expected}, got ${result.tokens}. ` +
    'If this fails with a small number (~5) the cache-token fix is missing.');

  // Confirm the old code would have returned a much smaller number (just input_tokens sum=5)
  // so this test distinguishes correct from buggy behaviour.
  assert.ok(result.tokens > 100,
    'tokens must be >> input_tokens-only sum (~5); cache fields must contribute');
});

// ---------------------------------------------------------------------------
// Secondary source: hook payload usage wins when transcript is absent
// ---------------------------------------------------------------------------
test('resolveActualTokens: falls back to hook_event when transcript absent and hook usage present', (t) => {
  const tmpDir = makeTmpDir(t);
  const event = {
    usage: { input_tokens: 500, output_tokens: 100 },
  };
  const result = resolveActualTokens(event, tmpDir);
  assert.equal(result.source, 'hook_event', 'source must be hook_event');
  assert.equal(result.tokens, 500, 'tokens must be 500');
});

// ---------------------------------------------------------------------------
// Tertiary source: tool_response.usage wins when transcript and hook absent
// ---------------------------------------------------------------------------
test('resolveActualTokens: falls back to tool_response when only tool_response present', (t) => {
  const tmpDir = makeTmpDir(t);
  const event = {
    tool_response: { usage: { input_tokens: 300 } },
  };
  const result = resolveActualTokens(event, tmpDir);
  assert.equal(result.source, 'tool_response', 'source must be tool_response');
  assert.equal(result.tokens, 300, 'tokens must be 300');
});

// ---------------------------------------------------------------------------
// Unknown: all sources exhausted (empty transcript + hook payload = 0 + no tool_response)
// ---------------------------------------------------------------------------
test('resolveActualTokens: returns tokens=0 and source=unknown when all sources empty', (t) => {
  const tmpDir = makeTmpDir(t);

  // Empty transcript file (no assistant entries)
  const transcriptPath = path.join(tmpDir, 'empty.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');

  const event = {
    agent_transcript_path: transcriptPath,
    usage: { input_tokens: 0 },
  };
  const result = resolveActualTokens(event, tmpDir);

  assert.equal(result.source, 'unknown', 'source must be unknown when all sources empty');
  assert.equal(result.tokens, 0, 'tokens must be 0 when no source resolves');
});

// ---------------------------------------------------------------------------
// Containment guard: transcript outside cwd/~/.claude is rejected
// ---------------------------------------------------------------------------
test('resolveActualTokens: rejects transcript outside containment, falls back', (t) => {
  const tmpDir = makeTmpDir(t);

  // Write a transcript to os.tmpdir() (outside tmpDir and outside ~/.claude)
  // Use a subdirectory of tmpDir as the cwd to ensure the file is outside it.
  const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-b1-foreign-'));
  t.after(() => { try { fs.rmSync(foreignDir, { recursive: true, force: true }); } catch (_e) {} });

  const transcriptPath = path.join(foreignDir, 'foreign.jsonl');
  const entry = { role: 'assistant', usage: { input_tokens: 9999 } };
  fs.writeFileSync(transcriptPath, JSON.stringify(entry) + '\n', 'utf8');

  // cwd is tmpDir; foreignDir is NOT inside tmpDir and NOT inside ~/.claude
  // So the transcript should fail containment. Fall back to hook_event.
  const event = {
    agent_transcript_path: transcriptPath,
    usage: { input_tokens: 42 },
  };
  const result = resolveActualTokens(event, tmpDir);

  // The tokens from the foreign transcript (9999) must NOT appear
  assert.notEqual(result.tokens, 9999, 'must not use tokens from outside containment');
  // Should have fallen back to hook_event
  assert.equal(result.tokens, 42, 'must fall back to hook_event tokens');
  assert.equal(result.source, 'hook_event', 'source must be hook_event after containment rejection');
});
