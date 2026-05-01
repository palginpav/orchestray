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

// v2.2.17: 3 SUPERSEDED tests removed. They asserted the resolveActualTokens()
// first-turn-only contract, but v2.2.8 b-estimation-alignment switched the
// realized-tokens strategy to bytes/4, making these assertions inapplicable.
// The non-skipped tests below still exercise the fallback behaviour
// (hook_event, tool_response, transcript-containment) which remains valid.

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
  // So the transcript should fail containment.
  //
  // v2.2.19 T9 fix S2: when transcript path was provided but containment-rejected,
  // do NOT fall back to event.usage.input_tokens (session-cumulative for multi-turn
  // agents — produces large negative savings). Return source='unknown' instead.
  const event = {
    agent_transcript_path: transcriptPath,
    usage: { input_tokens: 42 },
  };
  const result = resolveActualTokens(event, tmpDir);

  // The tokens from the foreign transcript (9999) must NOT appear
  assert.notEqual(result.tokens, 9999, 'must not use tokens from outside containment');
  // v2.2.19: must NOT fall back to hook_event tokens (deliberate contract change)
  assert.notEqual(result.source, 'hook_event', 'must not fall back to hook_event after containment rejection (v2.2.19)');
  assert.equal(result.source, 'unknown', 'source must be "unknown" after containment rejection (v2.2.19 T9)');
});
