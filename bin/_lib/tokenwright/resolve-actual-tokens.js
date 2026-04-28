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
 * Sum `usage.input_tokens` across all `assistant` entries in a JSONL transcript.
 *
 * Reads at most MAX_TRANSCRIPT_BYTES from the file to bound latency.
 * Returns `null` on any read or parse failure.
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
        // Normalize role — transcript entries can have role at top level
        // or nested under message (same shape collect-agent-metrics.js handles)
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
