'use strict';

/**
 * resolve-actual-tokens.js — Transcript-first token resolution (W4 §B1).
 *
 * Returns the actual input token count for a SubagentStop event using a
 * three-source fallback chain:
 *   1. Primary:   agent transcript JSONL (event.agent_transcript_path)
 *   2. Secondary: event.usage.input_tokens (top-level hook payload)
 *   3. Tertiary:  event.tool_response.usage.input_tokens
 *
 * Mirrors the transcript-parse pattern from collect-agent-metrics.js lines 320–376.
 *
 * Pure-sync, no top-level side effects, never throws. Fail-safe: always
 * returns a valid { tokens, source } pair even on error.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

/**
 * Maximum bytes to read from a transcript file (W4 §R1 latency mitigation).
 *
 * 256 KB was too small: real subagent transcripts run 100–600 KB and grow with
 * each turn. Usage entries near the end of a long transcript would be silently
 * truncated, causing under-counting. 2 MB covers observed subagent sizes with
 * ample headroom while bounding I/O to a few ms on local storage.
 */
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Resolve a path safely, falling back to path.resolve on ENOENT.
 * Mirrors the safeRealpath pattern in collect-agent-metrics.js.
 *
 * @param {string} p
 * @returns {string}
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_e) {
    return path.resolve(p);
  }
}

/**
 * Check that `resolvedPath` is contained within `cwd` or `~/.claude/`.
 *
 * @param {string} resolvedPath  — already resolved via safeRealpath
 * @param {string} cwd           — project root (may be a symlink)
 * @returns {boolean}
 */
function isContained(resolvedPath, cwd) {
  try {
    const cwdResolved    = safeRealpath(cwd);
    const claudeHome     = safeRealpath(path.join(os.homedir(), '.claude'));
    const insideCwd      = resolvedPath === cwdResolved ||
                           resolvedPath.startsWith(cwdResolved + path.sep);
    const insideClaudeHome = resolvedPath === claudeHome ||
                             resolvedPath.startsWith(claudeHome + path.sep);
    return insideCwd || insideClaudeHome;
  } catch (_e) {
    return false;
  }
}

/**
 * Return the input token count for the FIRST `assistant` entry in a JSONL transcript.
 *
 * SINGLE-TURN ALIGNMENT FIX (W1, orch-20260428T123030Z-w226-mechanical-redo):
 *
 * The estimated side (`estimated_input_tokens_pre`) is computed at delegation time
 * from the byte length of the outbound delegation prompt (bytes/4). It captures
 * exactly ONE delegation → ONE model turn. The actual side must measure the same
 * scope: the input tokens the model received for that first response.
 *
 * Prior attempt (commit 7bf1da1) summed cache tokens across ALL assistant turns,
 * which made things worse: on a 189-turn agent the cumulative total was 22,492,865
 * while the estimate was ~37,500 → 60,469% error vs. the original 96% error.
 * See `regression: cumulative-7bf1da1` test case.
 *
 * The first assistant turn's usage reflects exactly the delegation prompt the model
 * received. It carries all three input-token fields:
 *   - input_tokens                 — uncached tokens billed at full rate
 *   - cache_creation_input_tokens  — tokens written to the prompt cache this turn
 *   - cache_read_input_tokens      — tokens read from the prompt cache
 *
 * Summing these three fields for ONLY the first assistant turn keeps the actual
 * denominator on the same footing as the estimate.
 *
 * Reads at most MAX_TRANSCRIPT_BYTES from the beginning of the file. The first
 * assistant turn appears early in every transcript, so this is cheap even for
 * large multi-turn agents.
 *
 * Returns `null` on any read or parse failure, or if no assistant entry exists.
 *
 * @param {string} transcriptPath
 * @returns {number|null}
 */
function readTranscriptTokens(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return null;

    const fileSize = stat.size;
    const readBytes = Math.min(fileSize, MAX_TRANSCRIPT_BYTES);

    // Read from the beginning. The first assistant entry always appears early;
    // 2 MB is ample even for the largest observed subagent transcripts (~600 KB).
    const fd = fs.openSync(transcriptPath, 'r');
    let content;
    try {
      const buf = Buffer.alloc(readBytes);
      const bytesRead = fs.readSync(fd, buf, 0, readBytes, 0);
      content = buf.slice(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        // Normalize role — transcript entries can have role at top level
        // or nested under message (same shape collect-agent-metrics.js handles)
        const role = entry.role || entry.type || (entry.message && entry.message.role);
        if (role !== 'assistant') continue;
        const usage = entry.usage || (entry.message && entry.message.usage);
        if (!usage) continue;

        // Sum the three input-token fields for THIS turn only (first assistant turn).
        // Each field defaults to 0 if absent. A turn may have zero uncached tokens
        // but nonzero cache tokens (typical after the first spawn), so we must not
        // skip turns where input_tokens === 0.
        const inputTokens       = Number(usage.input_tokens)                || 0;
        const cacheCreateTokens = Number(usage.cache_creation_input_tokens) || 0;
        const cacheReadTokens   = Number(usage.cache_read_input_tokens)     || 0;
        const firstTurnTotal    = inputTokens + cacheCreateTokens + cacheReadTokens;

        // Return immediately — we only want the FIRST assistant turn.
        // Do not accumulate across turns; that is the 7bf1da1 regression.
        return firstTurnTotal > 0 ? firstTurnTotal : null;
      } catch (_e) {
        // Skip malformed lines; keep scanning for the first valid assistant entry
      }
    }

    return null; // No assistant entry found
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve the actual input token count from a SubagentStop hook event.
 *
 * @param {object} event   — raw hook event payload (may be partial/malformed)
 * @param {string} [cwd]   — project root for containment check (defaults to process.cwd())
 * @returns {{ tokens: number, source: 'transcript'|'hook_event'|'tool_response'|'unknown' }}
 */
function resolveActualTokens(event, cwd) {
  try {
    if (!event || typeof event !== 'object') {
      return { tokens: 0, source: 'unknown' };
    }

    const effectiveCwd = (typeof cwd === 'string' && cwd) ? cwd : process.cwd();

    // --- Primary: transcript JSONL ---
    const transcriptPath = event.agent_transcript_path || null;
    if (typeof transcriptPath === 'string' && transcriptPath) {
      let resolvedPath;
      try { resolvedPath = safeRealpath(transcriptPath); } catch (_e) { resolvedPath = null; }

      if (resolvedPath && isContained(resolvedPath, effectiveCwd)) {
        const tokens = readTranscriptTokens(resolvedPath);
        if (typeof tokens === 'number' && tokens > 0) {
          return { tokens, source: 'transcript' };
        }
      }
    }

    // --- Secondary: top-level hook payload usage ---
    const hookTokens = event.usage && typeof event.usage.input_tokens === 'number'
      ? event.usage.input_tokens
      : 0;
    if (hookTokens > 0) {
      return { tokens: hookTokens, source: 'hook_event' };
    }

    // --- Tertiary: tool_response.usage.input_tokens ---
    const toolRespTokens =
      event.tool_response &&
      event.tool_response.usage &&
      typeof event.tool_response.usage.input_tokens === 'number'
        ? event.tool_response.usage.input_tokens
        : 0;
    if (toolRespTokens > 0) {
      return { tokens: toolRespTokens, source: 'tool_response' };
    }

    return { tokens: 0, source: 'unknown' };
  } catch (_e) {
    return { tokens: 0, source: 'unknown' };
  }
}

module.exports = { resolveActualTokens };
