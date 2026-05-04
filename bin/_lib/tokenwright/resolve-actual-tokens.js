'use strict';

/**
 * resolve-actual-tokens.js — Transcript-first token resolution (W4 §B1, §B2-issue-b).
 *
 * Issue-B alignment fix (v2.2.8): the pre-compression estimate is computed as
 *   delegation-prompt-bytes / 4
 * The prior approach summed `usage.input_tokens` across ALL assistant turns in
 * the transcript, which includes system prompt, tool definitions, Block-A, and
 * every turn's accumulated context — an apples-to-oranges comparison that produced
 * 1461–1655% estimation_error_pct in practice.
 *
 * Aligned approach (Option 1): read the FIRST `user` message in the transcript
 * (the delegation prompt as it landed verbatim in the subagent's conversation)
 * and apply the same bytes/4 heuristic. This produces an apples-to-apples
 * comparison: both sides measure the same prompt text via the same heuristic,
 * so drift should be < 5% (driven only by JSON serialization rounding differences).
 *
 * The old cumulative-assistant-tokens approach is preserved as
 * `readTranscriptTokensCumulative` for callers that need the full-session token
 * total (e.g. collect-agent-metrics.js). It is NOT used by resolveActualTokens.
 *
 * Source fallback chain for resolveActualTokens:
 *   1. Primary:   first user message in transcript JSONL (bytes/4 heuristic)
 *   2. Secondary: event.usage.input_tokens (top-level hook payload)
 *   3. Tertiary:  event.tool_response.usage.input_tokens
 *
 * Pure-sync, no top-level side effects, never throws. Fail-safe: always
 * returns a valid { tokens, source } pair even on error.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

/** Maximum bytes to read from a transcript file (W4 §R1 latency mitigation). */
const MAX_TRANSCRIPT_BYTES = 256 * 1024; // 256 KB

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
 * Read the FIRST `user` message from a JSONL transcript and estimate its token
 * count using the same bytes/4 heuristic used by inject-tokenwright.js for the
 * pre-compression estimate. This produces an apples-to-apples comparison:
 *
 *   estimated = Buffer.byteLength(delegationPrompt, 'utf8') / 4
 *   actual    = Buffer.byteLength(firstUserMessage,  'utf8') / 4
 *
 * The first user message in the transcript IS the delegation prompt as Claude Code
 * injected it (after inject-tokenwright ran), so any byte difference reflects
 * only compression/injection deltas, not accumulated context bloat.
 *
 * Reads at most MAX_TRANSCRIPT_BYTES from the file to bound latency.
 * Returns `null` on any read or parse failure.
 *
 * @param {string} transcriptPath
 * @returns {number|null}  — estimated token count via bytes/4, or null on failure
 */
function readFirstUserMessageTokens(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return null;

    const fileSize = stat.size;
    const readBytes = Math.min(fileSize, MAX_TRANSCRIPT_BYTES);

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
        if (role !== 'user') continue;

        // Extract text content: top-level `content` field (string or array)
        const content_ = entry.content || (entry.message && entry.message.content);
        if (!content_) continue;

        let text = '';
        if (typeof content_ === 'string') {
          text = content_;
        } else if (Array.isArray(content_)) {
          // Content blocks — concatenate text items
          for (const block of content_) {
            if (typeof block === 'string') {
              text += block;
            } else if (block && typeof block.text === 'string') {
              text += block.text;
            }
          }
        }

        if (!text) continue;

        // Apply the same bytes/4 heuristic as inject-tokenwright.js
        const byteLen = Buffer.byteLength(text, 'utf8');
        const tokens  = Math.ceil(byteLen / 4);
        if (tokens > 0) return tokens;
      } catch (_e) {
        // Skip malformed lines
      }
    }

    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Sum `usage.input_tokens` across all `assistant` entries in a JSONL transcript.
 *
 * NOTE: This is the LEGACY cumulative approach. It measures total model input
 * across all turns (including system prompt, tool defs, Block-A, and accumulated
 * context), NOT just the delegation prompt. It is preserved for callers that need
 * the full session token total (e.g. collect-agent-metrics.js) but is NOT used by
 * resolveActualTokens — which now uses readFirstUserMessageTokens for alignment.
 *
 * Reads at most MAX_TRANSCRIPT_BYTES from the file to bound latency.
 * Returns `null` on any read or parse failure.
 *
 * @param {string} transcriptPath
 * @returns {number|null}
 */
function readTranscriptTokensCumulative(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return null;

    const fileSize = stat.size;
    const readBytes = Math.min(fileSize, MAX_TRANSCRIPT_BYTES);

    // Read from the beginning (most entries are near the start for typical agents)
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
    let total = 0;
    let foundAny = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const role = entry.role || entry.type || (entry.message && entry.message.role);
        if (role !== 'assistant') continue;
        const usage = entry.usage || (entry.message && entry.message.usage);
        if (usage && typeof usage.input_tokens === 'number' && usage.input_tokens > 0) {
          total += usage.input_tokens;
          foundAny = true;
        }
      } catch (_e) {
        // Skip malformed lines
      }
    }

    return foundAny ? total : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve the actual input token count from a SubagentStop (or TaskCompleted)
 * hook event, aligned with the pre-compression estimate scope.
 *
 * ALIGNMENT (v2.2.8 Issue B fix): uses `readFirstUserMessageTokens` as the primary
 * transcript source. This measures the delegation prompt via bytes/4 — the same
 * heuristic inject-tokenwright.js used for `input_token_estimate`. Prior behavior
 * (summing all assistant input_tokens) was apples-to-oranges and produced
 * 1461–1655% estimation_error_pct. The new approach should produce < 5% drift.
 *
 * Fallback chain:
 *   1. Primary:   first user message in transcript JSONL (bytes/4)
 *   2. Secondary: event.usage.input_tokens (top-level hook payload)
 *   3. Tertiary:  event.tool_response.usage.input_tokens
 *
 * @param {object} event   — raw hook event payload (may be partial/malformed)
 * @param {string} [cwd]   — project root for containment check (defaults to process.cwd())
 * @returns {{ tokens: number, source: 'transcript-user-prompt'|'hook_event'|'tool_response'|'unknown' }}
 */
function resolveActualTokens(event, cwd) {
  try {
    if (!event || typeof event !== 'object') {
      return { tokens: 0, source: 'unknown' };
    }

    const effectiveCwd = (typeof cwd === 'string' && cwd) ? cwd : process.cwd();

    // --- Primary: first user message in transcript JSONL (aligned with estimate scope) ---
    const transcriptPath = event.agent_transcript_path || null;
    if (typeof transcriptPath === 'string' && transcriptPath) {
      // When a transcript path is provided, never fall through to event.usage.input_tokens
      // (session-cumulative; produces large negatives for multi-turn agents).
      // Return unknown instead of a misleading value if the transcript is unreadable.
      let resolvedPath;
      try { resolvedPath = safeRealpath(transcriptPath); } catch (_e) { resolvedPath = null; }

      if (resolvedPath && isContained(resolvedPath, effectiveCwd)) {
        const tokens = readFirstUserMessageTokens(resolvedPath);
        if (typeof tokens === 'number' && tokens > 0) {
          return { tokens, source: 'transcript-user-prompt' };
        }
      }
      // Transcript path was provided but unreadable or containment-rejected.
      // Do NOT fall back to event.usage.input_tokens (session-cumulative; apples-to-oranges).
      return { tokens: 0, source: 'unknown' };
    }

    // No transcript path provided — fall back to hook-level token counts.
    // These are only valid when no transcript is available at all.

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

module.exports = {
  resolveActualTokens,
  readFirstUserMessageTokens,
  readTranscriptTokensCumulative,
};
