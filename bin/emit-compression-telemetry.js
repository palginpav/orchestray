#!/usr/bin/env node
'use strict';

/**
 * emit-compression-telemetry.js — SubagentStart hook.
 *
 * v2.1.10 R1 — Telemetry enforcement for CiteCache / SpecSketch / RepoMapDelta.
 *
 * Greps the delegation prompt (read from agent_transcript_path) for three
 * compression markers introduced in v2.1.8:
 *
 *   Pattern A (CiteCache hit):      substring `[CACHED — loaded by`
 *   Pattern B (SpecSketch):         `spec_sketch:` at the start of a line
 *   Pattern C (RepoMapDelta):       `repo_map_delta:` at the start of a line
 *
 * For each detected pattern, appends one event to
 *   `${cwd}/.orchestray/audit/events.jsonl`
 *
 * Contract:
 *   - exit 0 ALWAYS — non-blocking telemetry.
 *   - one event per match TYPE (not per occurrence); match_count records cardinality.
 *   - honours env kill-switch ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1.
 *   - honours .orchestray/config.json → context_compression_v218.telemetry_enabled (default true).
 *   - silent on any I/O or parse error.
 *
 * Input:  JSON on stdin (Claude Code SubagentStart hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

// ---------------------------------------------------------------------------
// Compression marker patterns
// ---------------------------------------------------------------------------

/**
 * Pattern A: CiteCache hit marker.
 * The em-dash in `[CACHED — loaded by` is U+2014 (—), not a hyphen.
 * Match as a plain substring (case-sensitive).
 */
const CITE_CACHE_MARKER = '[CACHED — loaded by';

/**
 * Pattern B: SpecSketch YAML preamble key.
 * Must appear at the start of a line (or indented inside a YAML/code fence).
 * Anchored to line start (optionally preceded by whitespace) to avoid
 * false positives from prose like "the spec_sketch: field".
 */
const SPEC_SKETCH_RE = /^\s*spec_sketch\s*:/m;

/**
 * Pattern C: RepoMapDelta YAML/fence marker.
 * Same anchor rule as Pattern B.
 */
const REPO_MAP_DELTA_RE = /^\s*repo_map_delta\s*:/m;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true if telemetry emission is enabled.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isTelemetryEnabled(cwd) {
  if (process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED === '1') return false;
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (
      cfg &&
      cfg.context_compression_v218 &&
      cfg.context_compression_v218.telemetry_enabled === false
    ) {
      return false;
    }
  } catch (_e) {
    // Config missing or unreadable — default to enabled.
  }
  return true;
}

/**
 * Resolve orchestration_id from current-orchestration.json.
 * Returns null if the file is missing or unreadable.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return (orchData && orchData.orchestration_id) ? orchData.orchestration_id : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Read the delegation prompt text from the subagent's transcript file.
 *
 * The transcript is a JSONL file. The very first user-role entry contains the
 * delegation prompt that was passed to the subagent. We read the first 64 KB
 * of the file (sufficient for any delegation prompt) and search for the first
 * line matching one of the known user-message shapes:
 *
 *   { "type": "user", "message": { "content": "..." } }
 *   { "role": "user", "content": "..." }
 *
 * Returns null if the transcript is missing, unreadable, or has no user entry.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {string|null}
 */
function readDelegationPrompt(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let raw;
  try {
    // Read only the first 64 KB — delegation prompts are large but bounded.
    const HEAD_BYTES = 64 * 1024;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      raw = buf.slice(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_e) {
    return null;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch (_e) { continue; }

    // Shape 1: { type: "user", message: { role: "user", content: "..." } }
    if (entry.type === 'user' && entry.message && typeof entry.message.content === 'string') {
      return entry.message.content;
    }
    // Shape 2: flat { role: "user", content: "..." }
    if (entry.role === 'user' && typeof entry.content === 'string') {
      return entry.content;
    }
    // Shape 3: content may be an array of content blocks
    if (
      (entry.type === 'user' || entry.role === 'user') &&
      Array.isArray(entry.message ? entry.message.content : entry.content)
    ) {
      const blocks = entry.message ? entry.message.content : entry.content;
      const textBlocks = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text);
      if (textBlocks.length > 0) return textBlocks.join('\n');
    }
  }
  return null;
}

/**
 * Count all non-overlapping occurrences of `marker` (plain string) in `text`.
 *
 * @param {string} text
 * @param {string} marker
 * @returns {number}
 */
function countOccurrences(text, marker) {
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(marker, idx)) !== -1) {
    count++;
    idx += marker.length;
  }
  return count;
}

/**
 * Append a compression telemetry event to events.jsonl.
 * Fail-open on any error.
 *
 * @param {string} cwd
 * @param {object} record
 */
function emitEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), record);
  } catch (_e) {
    // Swallow — telemetry must never crash the hook.
  }
}

// ---------------------------------------------------------------------------
// Exported entry points (used by tests)
// ---------------------------------------------------------------------------

/**
 * Process a SubagentStart event payload and emit compression telemetry events.
 *
 * @param {object} event - Parsed hook payload
 * @returns {{ eventsEmitted: string[] }} Names of event types emitted.
 */
function handleSubagentStart(event) {
  const cwd = resolveSafeCwd(event.cwd);

  if (!isTelemetryEnabled(cwd)) {
    return { eventsEmitted: [] };
  }

  const orchestrationId = resolveOrchestrationId(cwd);
  const agentType = event.agent_type || null;
  const ts = new Date().toISOString();

  const promptText = readDelegationPrompt(event.agent_transcript_path);
  if (!promptText) {
    // No prompt text available — nothing to grep. Exit cleanly.
    return { eventsEmitted: [] };
  }

  const emitted = [];

  // Pattern A: CiteCache hit
  const citeCacheCount = countOccurrences(promptText, CITE_CACHE_MARKER);
  if (citeCacheCount > 0) {
    emitEvent(cwd, {
      event: 'cite_cache_hit',
      orchestration_id: orchestrationId,
      ts,
      subagent_type: agentType,
      match_count: citeCacheCount,
    });
    emitted.push('cite_cache_hit');
  }

  // Pattern B: SpecSketch injection
  const specSketchMatches = promptText.match(new RegExp(SPEC_SKETCH_RE.source, 'gm'));
  if (specSketchMatches && specSketchMatches.length > 0) {
    emitEvent(cwd, {
      event: 'spec_sketch_generated',
      orchestration_id: orchestrationId,
      ts,
      subagent_type: agentType,
      match_count: specSketchMatches.length,
    });
    emitted.push('spec_sketch_generated');
  }

  // Pattern C: RepoMapDelta injection
  const repoMapMatches = promptText.match(new RegExp(REPO_MAP_DELTA_RE.source, 'gm'));
  if (repoMapMatches && repoMapMatches.length > 0) {
    emitEvent(cwd, {
      event: 'repo_map_delta_injected',
      orchestration_id: orchestrationId,
      ts,
      subagent_type: agentType,
      match_count: repoMapMatches.length,
    });
    emitted.push('repo_map_delta_injected');
  }

  return { eventsEmitted: emitted };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      const event = input.length > 0 ? JSON.parse(input) : {};
      handleSubagentStart(event);
    } catch (_e) {
      // Malformed stdin — fail-open silently.
    }
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  handleSubagentStart,
  readDelegationPrompt,
  countOccurrences,
  isTelemetryEnabled,
  CITE_CACHE_MARKER,
  SPEC_SKETCH_RE,
  REPO_MAP_DELTA_RE,
};

if (require.main === module) {
  main();
}
