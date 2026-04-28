'use strict';

/**
 * Test B1: Transcript-first token resolution — single-turn alignment fix.
 *
 * Verifies that resolveActualTokens:
 *   1. Returns the FIRST assistant turn's token sum (not cumulative across all turns).
 *   2. Includes all three input-token fields from that first turn.
 *   3. Falls back correctly when transcript is absent / empty.
 *
 * Background: The estimated side (estimated_input_tokens_pre) is computed from
 * the byte length of a single delegation prompt. To keep the comparison meaningful,
 * the actual side must also reflect a single turn (the first assistant response to
 * the delegation). Summing across all turns (commit 7bf1da1 regression) inflates
 * the actual by 100–600× on long agents, producing 60,469% error vs. 96% original.
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
// Happy-path: multi-turn transcript — only the FIRST assistant turn is returned.
//
// Transcript has two assistant turns (800 and 700 tokens). The fix must return
// 800 (first turn only), not 1500 (cumulative).
// ---------------------------------------------------------------------------
test('resolveActualTokens: returns first-turn tokens only (800), not cumulative (1500)', (t) => {
  const tmpDir = makeTmpDir(t);

  const transcriptPath = path.join(tmpDir, 'session.jsonl');
  const entries = [
    { role: 'user',      content: 'delegation prompt'                     },
    { role: 'assistant', usage: { input_tokens: 800, output_tokens: 100 } },
    { role: 'assistant', usage: { input_tokens: 700, output_tokens: 200 } },
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const event = { agent_transcript_path: transcriptPath };
  const result = resolveActualTokens(event, tmpDir);

  assert.equal(result.source, 'transcript', 'source must be transcript');
  // First turn only: 800. Must NOT be 1500 (cumulative).
  assert.equal(result.tokens, 800,
    'must return first-turn tokens (800), not cumulative sum (1500)');
});

// ---------------------------------------------------------------------------
// Cache-token inclusion: first turn must sum all three input fields.
//
// Real subagent transcripts (observed 2026-04-28) look like:
//   Turn 1: input_tokens=2, cache_creation_input_tokens=22252, cache_read_input_tokens=0
//   Turn 2: input_tokens=3, cache_creation_input_tokens=2515, cache_read_input_tokens=22252
//
// The fix must return 22254 (turn 1 only: 2+22252+0), not 5 (input_tokens-only
// original bug) and not 49024 (cumulative 7bf1da1 regression).
// ---------------------------------------------------------------------------
test('resolveActualTokens: includes cache fields but from first turn only (22254, not 5 or 49024)', (t) => {
  const tmpDir = makeTmpDir(t);
  const transcriptPath = path.join(tmpDir, 'subagent.jsonl');

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

  // Expected: first turn only = 2 + 22252 + 0 = 22254
  const expectedFirstTurn = 2 + 22252 + 0;
  const cumulativeAll     = (2 + 22252 + 0) + (3 + 2515 + 22252); // 49024 — wrong
  const inputTokensOnly   = 2 + 3; // 5 — also wrong (original bug)

  assert.equal(result.tokens, expectedFirstTurn,
    `expected first-turn sum ${expectedFirstTurn}, got ${result.tokens}. ` +
    `cumulative would be ${cumulativeAll}, input_tokens-only would be ${inputTokensOnly}.`);
  assert.notEqual(result.tokens, cumulativeAll,
    'must NOT return cumulative sum across all turns (7bf1da1 regression)');
  assert.notEqual(result.tokens, inputTokensOnly,
    'must NOT return input_tokens-only (original 96% error bug)');
});

// ---------------------------------------------------------------------------
// regression: cumulative-7bf1da1
//
// Documents the regression introduced in commit 7bf1da1 which summed cache tokens
// across ALL assistant turns. On a 189-turn agent observed 2026-04-28:
//   T1  (first turn)   =     39,648
//   T_all (cumulative) = 22,492,865
//
// With estimate ~37,500 (delegation_bytes/4), the cumulative actual produced
// estimation_error_pct = 60,469% vs. the original ~96% error. The fix (single-turn)
// should produce near-0% error for the fixture below.
// ---------------------------------------------------------------------------
test('regression: cumulative-7bf1da1 — multi-turn fixture must not return cumulative sum', (t) => {
  const tmpDir = makeTmpDir(t);
  const transcriptPath = path.join(tmpDir, 'multi-turn.jsonl');

  // Simulate a moderate agent: first turn ~1500 tokens, subsequent turns add ~5000 more.
  // The estimate for this agent would have been ~1500 (delegation_bytes/4).
  // Cumulative (7bf1da1) returns 6500 → 333% error. Single-turn (fix) returns 1500 → 0%.
  const entries = [
    { type: 'user',      message: { role: 'user', content: 'delegation' }                                      },
    { type: 'assistant', message: { usage: { input_tokens: 500, cache_creation_input_tokens: 1000 } }          },
    { type: 'user',      message: { role: 'user', content: 'tool result' }                                     },
    { type: 'assistant', message: { usage: { cache_read_input_tokens: 5000 } }                                 },
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const event = { agent_transcript_path: transcriptPath };
  const result = resolveActualTokens(event, tmpDir);

  assert.equal(result.source, 'transcript');

  const firstTurnExpected = 500 + 1000; // 1500
  const cumulativeWrong   = 500 + 1000 + 5000; // 6500

  assert.equal(result.tokens, firstTurnExpected,
    `regression guard: expected ${firstTurnExpected} (first turn), got ${result.tokens}. ` +
    `If ${cumulativeWrong} is returned, the 7bf1da1 cumulative regression is present.`);
  assert.notEqual(result.tokens, cumulativeWrong,
    'must not return cumulative 6500 — that is the 7bf1da1 regression');
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
