'use strict';

/**
 * transcript-tools.js — bounded transcript reader (v2.3.18, CEL).
 *
 * An agent's Structured Result is testimony; its tool calls are evidence. This
 * module produces the evidence side: the ordered `tool_use` blocks a spawn
 * actually emitted, read from the transcript JSONL.
 *
 * Transcript format: one JSON object per line; assistant lines carry
 * `message.content[]` with `{ type: 'tool_use', name, input }` blocks.
 *
 * Bounded by construction — only the last `maxBytes` are scanned. The spawn
 * window is not marked anywhere we can read at SubagentStop, so the tail is the
 * approximation: it over-includes earlier turns (evidence-permissive, never
 * evidence-inventing) and under-includes only on transcripts whose single spawn
 * exceeds the cap.
 *
 * Path safety reuses `_lib/path-containment.js`, exactly as
 * `validate-no-deferral.js` does.
 */

const fs = require('fs');
const { validateTranscriptPath } = require('./path-containment');

const DEFAULT_MAX_BYTES = 512 * 1024;

/** Cap per-call stringify so a pathological tool input cannot stall a regex. */
const MAX_INPUT_CHARS = 8 * 1024;

/**
 * The transcript belonging to the spawn a `SubagentStop` payload describes.
 *
 * A real payload carries BOTH keys and they are DIFFERENT files:
 *
 *   transcript_path        <proj>/<session>.jsonl                — parent session
 *   agent_transcript_path  <proj>/<session>/subagents/agent-*.jsonl — this spawn
 *
 * Reading `transcript_path` first — as this module's callers did until v2.3.19
 * W1 — pointed the evidence side at the PM's transcript. Any tool call the PM
 * ever made discharged the subagent's claim, and the subagent's own calls were
 * never examined: evidence laundering in the direction that always passes.
 *
 * The spawn's own transcript therefore leads. `transcript_path` stays as the
 * fallback for the shapes that carry only it (synthesised events, and the
 * in-process teammate payloads `collect-agent-metrics.js:357` documents as
 * session-keyed) — an approximate transcript still beats no evidence at all,
 * and the fallback only ever runs when there is no spawn transcript to prefer.
 *
 * @param {object} event  a hook payload
 * @returns {string}  a path, or '' when the payload names no transcript
 */
function resolveSpawnTranscript(event) {
  if (!event || typeof event !== 'object') return '';
  for (const field of ['agent_transcript_path', 'transcript_path']) {
    const v = event[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/**
 * Extract tool_use blocks from a transcript JSONL tail.
 *
 * @param {string} transcriptPath
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]  tail size to scan (default 512 KB)
 * @param {string} [opts.cwd]       project root, for path containment
 * @param {function} [opts.onContainmentFail] (eventType, reason) => void
 * @returns {{name:string, input:object, idx:number}[]} in transcript order
 */
function extractToolCalls(transcriptPath, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
    ? opts.maxBytes
    : DEFAULT_MAX_BYTES;
  const cwd = opts.cwd || process.cwd();

  let safe = '';
  try {
    safe = validateTranscriptPath(transcriptPath, cwd, opts.onContainmentFail);
  } catch (_e) { return []; }
  if (!safe) return [];

  let text = '';
  try {
    const { size } = fs.statSync(safe);
    if (size === 0) return [];
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(safe, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.slice(0, read).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  } catch (_e) { return []; }

  const calls = [];
  let idx = 0;
  for (const line of text.split('\n')) {
    // A tail read can slice the first line mid-object; skip anything that is
    // not a whole JSON object.
    if (!line.startsWith('{')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_e) { continue; }
    const content = rec && rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_use') {
        calls.push({
          name: String(block.name || ''),
          input: (block.input && typeof block.input === 'object') ? block.input : {},
          idx: idx++,
        });
      }
    }
  }
  return calls;
}

/**
 * Haystack for evidence matching: tool NAME + stringified input.
 *
 * Name inclusion is load-bearing — a rule like /grep|rg\b|Grep/ must be
 * satisfiable by the `Grep` tool itself, whose input (`{"pattern":"foo"}`)
 * contains no such token. Caught by running the prototype.
 *
 * @param {{name:string, input:object}} call
 * @returns {string}
 */
function callHaystack(call) {
  if (!call) return '';
  let serialized = '';
  try { serialized = JSON.stringify(call.input || {}); } catch (_e) { serialized = ''; }
  if (serialized.length > MAX_INPUT_CHARS) serialized = serialized.slice(0, MAX_INPUT_CHARS);
  return String(call.name || '') + ' ' + serialized;
}

module.exports = {
  resolveSpawnTranscript,
  extractToolCalls,
  callHaystack,
  DEFAULT_MAX_BYTES,
  MAX_INPUT_CHARS,
};
