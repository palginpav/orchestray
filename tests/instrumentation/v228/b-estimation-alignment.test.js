'use strict';

/**
 * Test v2.2.8 Issue B: Estimation accuracy alignment.
 *
 * Prior behavior summed all assistant input_tokens from the transcript (~23000)
 * while the estimate measured only the delegation prompt bytes/4 (~1500),
 * producing 1461–1655% estimation_error_pct.
 *
 * Fixed behavior reads the first user message from the transcript and applies
 * the same bytes/4 heuristic, producing apples-to-apples comparison.
 *
 * Verifies:
 *   1. resolveActualTokens returns 'transcript-user-prompt' source for transcripts
 *      with a user message.
 *   2. estimation_error_pct is < 5% when actual and estimate are aligned
 *      (both measuring the same prompt via bytes/4).
 *   3. readFirstUserMessageTokens handles string content, array content,
 *      and nested message.content shapes.
 *   4. readTranscriptTokensCumulative (legacy export) still sums assistant tokens.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  resolveActualTokens,
  readFirstUserMessageTokens,
  readTranscriptTokensCumulative,
} = require('../../../bin/_lib/tokenwright/resolve-actual-tokens');

// ---------------------------------------------------------------------------
// Helper: isolated tmp dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v228-b-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

/**
 * Compute estimation_error_pct mirroring the formula in capture-tokenwright-realized.js.
 * estimatedPre > 0 guard matches the capture script.
 */
function computeErrorPct(estimated, actual) {
  if (estimated <= 0) return 0;
  return Math.abs(actual - estimated) / estimated * 100;
}

// ---------------------------------------------------------------------------
// Test 1: apples-to-apples comparison — error_pct < 5%
// ---------------------------------------------------------------------------
test('Issue-B: estimation_error_pct < 5% when estimate and actual both use bytes/4', (t) => {
  const tmpDir = makeTmpDir(t);

  // Build a delegation prompt of known size (4000 bytes).
  // inject-tokenwright would estimate: ceil(4000 / 4) = 1000 tokens.
  const delegationPrompt = 'X'.repeat(4000);
  const inputTokenEstimate = Math.ceil(Buffer.byteLength(delegationPrompt, 'utf8') / 4);

  // Transcript: first user message IS that delegation prompt (verbatim or close to it).
  // After inject-tokenwright compression, the prompt may be slightly shorter.
  // Use the same prompt to get ~0% error.
  const transcriptPath = path.join(tmpDir, 'session.jsonl');
  const entries = [
    { role: 'user',      content: delegationPrompt },
    // Large assistant entries that would have caused 1461% error in old code:
    { role: 'assistant', usage: { input_tokens: 23000, output_tokens: 500 } },
    { role: 'assistant', usage: { input_tokens: 22500, output_tokens: 400 } },
  ];
  fs.writeFileSync(
    transcriptPath,
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );

  const event = { agent_transcript_path: transcriptPath };
  const result = resolveActualTokens(event, tmpDir);

  assert.equal(result.source, 'transcript-user-prompt', 'source must be transcript-user-prompt');
  assert.equal(result.tokens, inputTokenEstimate, 'actual tokens must equal estimate (bytes/4 of same prompt)');

  const errorPct = computeErrorPct(inputTokenEstimate, result.tokens);
  assert.ok(errorPct < 5, `estimation_error_pct must be < 5%, got ${errorPct.toFixed(2)}%`);
});

// ---------------------------------------------------------------------------
// Test 2: old cumulative approach would have produced > 1400% error on same data
// ---------------------------------------------------------------------------
test('Issue-B: legacy cumulative approach produced > 1400% error (confirms the fix is necessary)', (t) => {
  const tmpDir = makeTmpDir(t);

  const delegationPrompt = 'X'.repeat(4000);
  const inputTokenEstimate = Math.ceil(Buffer.byteLength(delegationPrompt, 'utf8') / 4); // 1000

  const transcriptPath = path.join(tmpDir, 'old-style.jsonl');
  const entries = [
    { role: 'user',      content: delegationPrompt },
    // Realistic full-session token counts (system prompt + tools + all turns)
    { role: 'assistant', usage: { input_tokens: 23000, output_tokens: 500 } },
    { role: 'assistant', usage: { input_tokens: 22000, output_tokens: 400 } },
  ];
  fs.writeFileSync(
    transcriptPath,
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );

  const legacyCumulative = readTranscriptTokensCumulative(transcriptPath);
  assert.equal(legacyCumulative, 45000, 'legacy cumulative must sum to 45000');

  const legacyErrorPct = computeErrorPct(inputTokenEstimate, legacyCumulative);
  // 45000 vs 1000 → error = |45000 - 1000| / 1000 * 100 = 4400%
  assert.ok(legacyErrorPct > 1000, `legacy error_pct must be > 1000%, got ${legacyErrorPct.toFixed(0)}%`);
});

// ---------------------------------------------------------------------------
// Test 3: readFirstUserMessageTokens — string content
// ---------------------------------------------------------------------------
test('Issue-B: readFirstUserMessageTokens reads string content field correctly', (t) => {
  const tmpDir = makeTmpDir(t);
  const transcriptPath = path.join(tmpDir, 'string-content.jsonl');

  // 800 bytes → ceil(800/4) = 200 tokens
  const entries = [
    { role: 'user', content: 'A'.repeat(800) },
    { role: 'assistant', usage: { input_tokens: 10000 } },
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const tokens = readFirstUserMessageTokens(transcriptPath);
  assert.equal(tokens, 200, 'must return ceil(800/4)=200 tokens');
});

// ---------------------------------------------------------------------------
// Test 4: readFirstUserMessageTokens — message.content nesting
// ---------------------------------------------------------------------------
test('Issue-B: readFirstUserMessageTokens handles message.content nesting', (t) => {
  const tmpDir = makeTmpDir(t);
  const transcriptPath = path.join(tmpDir, 'nested.jsonl');

  // Nested message.content (some Claude Code transcript formats use this shape)
  const entries = [
    { role: 'user', message: { content: 'B'.repeat(400) } },
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const tokens = readFirstUserMessageTokens(transcriptPath);
  assert.equal(tokens, 100, 'must return ceil(400/4)=100 tokens from message.content');
});

// ---------------------------------------------------------------------------
// Test 5: readFirstUserMessageTokens — skips non-user entries, returns first user
// ---------------------------------------------------------------------------
test('Issue-B: readFirstUserMessageTokens skips system/assistant entries to find first user', (t) => {
  const tmpDir = makeTmpDir(t);
  const transcriptPath = path.join(tmpDir, 'skip-entries.jsonl');

  const entries = [
    { role: 'system',    content: 'S'.repeat(10000) },  // large but skipped
    { role: 'assistant', usage: { input_tokens: 5000 } },  // skipped
    { role: 'user',      content: 'D'.repeat(2000) },   // 500 tokens — this one wins
    { role: 'user',      content: 'E'.repeat(8000) },   // second user — not read
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const tokens = readFirstUserMessageTokens(transcriptPath);
  assert.equal(tokens, 500, 'must return ceil(2000/4)=500 tokens from FIRST user entry');
});

// ---------------------------------------------------------------------------
// Test 6: resolveActualTokens — falls back to hook_event when no user message
// ---------------------------------------------------------------------------
test('Issue-B: resolveActualTokens falls back to hook_event when transcript has no user message', (t) => {
  const tmpDir = makeTmpDir(t);
  const transcriptPath = path.join(tmpDir, 'no-user.jsonl');

  // Transcript with only assistant entries (no user message)
  const entries = [
    { role: 'assistant', usage: { input_tokens: 5000 } },
  ];
  fs.writeFileSync(transcriptPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const event = {
    agent_transcript_path: transcriptPath,
    usage: { input_tokens: 300 },
  };
  const result = resolveActualTokens(event, tmpDir);

  assert.equal(result.source, 'hook_event', 'must fall back to hook_event when no user message in transcript');
  assert.equal(result.tokens, 300, 'must use hook_event tokens');
});
