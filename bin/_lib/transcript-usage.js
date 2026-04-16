'use strict';

/**
 * transcript-usage.js — Shared tail-read helpers for session/subagent transcript parsing.
 *
 * Extracted from bin/capture-pm-turn.js (W3 / v2.0.19) so that both PM-turn capture
 * and the context-telemetry collector share the same parsing logic.
 *
 * Exported API:
 *   extractLastAssistantUsage(transcriptPath) → { usage, model_used, timestamp } | null
 *   extractFirstAssistantModel(transcriptPath) → string | null
 */

const fs = require('fs');

const TAIL_BYTES  = 64 * 1024; // 64 KB — covers several large PM/subagent turns
const HEAD_BYTES  = 16 * 1024; // 16 KB — sufficient to find the first assistant message

/**
 * Internal: parse assistant entry from one raw JSONL line.
 * Handles two shapes:
 *   { role: "assistant", usage, model }
 *   { type: "assistant", message: { role, usage, model } }
 *
 * @param {string} line
 * @returns {{ usage: object, model: string|null, timestamp: string }|null}
 */
function _parseAssistantLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let entry;
  try { entry = JSON.parse(trimmed); } catch (_e) { return null; }

  const role = entry.role || entry.type || (entry.message && entry.message.role);
  if (role !== 'assistant') return null;

  const usage = entry.usage || (entry.message && entry.message.usage);
  if (!usage) return null;

  const model = entry.model || (entry.message && entry.message.model) || null;
  const timestamp = entry.timestamp || (entry.message && entry.message.timestamp) || new Date().toISOString();

  return {
    usage: {
      input_tokens:                Number(usage.input_tokens)                || 0,
      output_tokens:               Number(usage.output_tokens)               || 0,
      cache_read_input_tokens:     Number(usage.cache_read_input_tokens)     || 0,
      cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) || 0,
    },
    model,
    timestamp,
  };
}

/**
 * Read the last assistant message's `usage` block from a transcript JSONL.
 *
 * Strategy: read the file tail (last 64 KB), split into lines, iterate in reverse,
 * return the first assistant usage found. Falls back to a full read when the file
 * is smaller than the tail budget.
 *
 * @param {string} transcriptPath - Absolute path to transcript JSONL.
 * @returns {{ usage: object, model_used: string|null, timestamp: string }|null}
 */
function extractLastAssistantUsage(transcriptPath) {
  let content;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;

    if (stat.size <= TAIL_BYTES) {
      content = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES);
      fs.closeSync(fd);
      content = buf.toString('utf8');
    }
  } catch (_e) {
    return null;
  }

  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = _parseAssistantLine(lines[i]);
    if (parsed) {
      return {
        usage:      parsed.usage,
        model_used: parsed.model,
        timestamp:  parsed.timestamp,
      };
    }
  }

  return null;
}

/**
 * Read the model string from the FIRST assistant message in the transcript.
 *
 * Strategy: read only the first 16 KB of the file, iterate forward, return
 * the model from the first assistant entry found.
 *
 * Used to resolve subagent model when PreToolUse did not carry tool_input.model.
 *
 * @param {string} transcriptPath - Absolute path to transcript JSONL.
 * @returns {string|null}
 */
function extractFirstAssistantModel(transcriptPath) {
  let content;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;

    if (stat.size <= HEAD_BYTES) {
      content = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(HEAD_BYTES);
      fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      fs.closeSync(fd);
      content = buf.toString('utf8');
    }
  } catch (_e) {
    return null;
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parsed = _parseAssistantLine(lines[i]);
    if (parsed && parsed.model) return parsed.model;
  }

  return null;
}

module.exports = { extractLastAssistantUsage, extractFirstAssistantModel };
