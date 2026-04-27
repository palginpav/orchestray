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
const { writeEvent } = require('./_lib/audit-event-writer');
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

/**
 * Pattern D (v2.2.3 W3 P1-6): Repository Map heading.
 * Emitted by `bin/_lib/repo-map-delta.js#injectRepoMap()` as the section
 * heading prefix. Two shapes:
 *   `## Repository Map`                              — full content or first emission
 *   `## Repository Map (unchanged this orchestration)` — pointer / cache hit
 * Both shapes start with `## Repository Map`. We anchor to line-start so prose
 * mentions ("the Repository Map") are not false-matched.
 */
const REPO_MAP_HEADING_RE = /^## Repository Map(?: \(unchanged this orchestration\))?\s*$/m;
const REPO_MAP_HEADING_CACHE_RE = /^## Repository Map \(unchanged this orchestration\)\s*$/m;

/**
 * Per-spawn repo-map opt-out list. Haiku-default agents that run on tiny
 * scoped tasks and do not benefit from a structural repo map. Emit
 * `repo_map_skipped` with reason='agent_opted_out' when the spawn type
 * matches AND the prompt does not contain a Repository Map heading.
 *
 * Source: agents/*.md frontmatter `model: haiku` agents that handle
 * size-bounded scoped work (W3 §A — these agents accounted for 0 spawns
 * receiving the map post-v2.2.0, but we still want explicit skip telemetry
 * to distinguish "opted out" from "leaked").
 */
const REPO_MAP_OPT_OUT_AGENTS = new Set([
  'haiku-scout',
  'orchestray-housekeeper',
  'project-intent',
  'pattern-extractor',
]);

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
 * v2.2.3 W3 P1-6: Read the `enable_repo_map` config flag. Defaults to true.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isRepoMapEnabled(cwd) {
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg && typeof cfg.enable_repo_map === 'boolean') {
      return cfg.enable_repo_map;
    }
    // Nested top-level repo_map.enabled also disables (R-AIDER-FULL knob).
    if (cfg && cfg.repo_map && cfg.repo_map.enabled === false) {
      return false;
    }
  } catch (_e) { /* default true */ }
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
    writeEvent(record, { cwd });
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
      // v2.1.13 R-EVENT-NAMING: canonical snake_case shape.
      // Legacy v2.1.12 emissions used `event`/`ts` — back-compat read path
      // in bin/read-event.js maps both forms.
      type: 'cite_cache_hit',
      orchestration_id: orchestrationId,
      timestamp: ts,
      subagent_type: agentType,
      match_count: citeCacheCount,
    });
    emitted.push('cite_cache_hit');
  }

  // Pattern B: SpecSketch injection
  const specSketchMatches = promptText.match(new RegExp(SPEC_SKETCH_RE.source, 'gm'));
  if (specSketchMatches && specSketchMatches.length > 0) {
    emitEvent(cwd, {
      // v2.1.13 R-EVENT-NAMING: canonical snake_case shape (see cite_cache_hit above).
      type: 'spec_sketch_generated',
      orchestration_id: orchestrationId,
      timestamp: ts,
      subagent_type: agentType,
      match_count: specSketchMatches.length,
    });
    emitted.push('spec_sketch_generated');
  }

  // Pattern C: RepoMapDelta injection
  const repoMapMatches = promptText.match(new RegExp(REPO_MAP_DELTA_RE.source, 'gm'));
  if (repoMapMatches && repoMapMatches.length > 0) {
    emitEvent(cwd, {
      // v2.1.13 R-EVENT-NAMING: canonical snake_case shape (see cite_cache_hit above).
      type: 'repo_map_delta_injected',
      orchestration_id: orchestrationId,
      timestamp: ts,
      subagent_type: agentType,
      match_count: repoMapMatches.length,
    });
    emitted.push('repo_map_delta_injected');
  }

  // -------------------------------------------------------------------------
  // Pattern D (v2.2.3 W3 P1-6): per-delegation repo_map injected/skipped.
  //
  // `repo_map_built` fires once at build time but does not prove the spawn
  // received the rendered map. Detect the `## Repository Map` heading in the
  // delegation prompt and emit one of:
  //   - repo_map_injected — heading present
  //   - repo_map_skipped  — heading absent, with a reason
  //
  // Repo-map injection is gated by `enable_repo_map` (top-level) AND
  // `repo_map.enabled` (R-AIDER-FULL block). When config disables it we
  // emit `repo_map_skipped { skip_reason: 'disabled_by_config' }`.
  // -------------------------------------------------------------------------
  const repoMapEnabled = isRepoMapEnabled(cwd);
  const repoMapSection = extractRepoMapSection(promptText);

  if (!repoMapEnabled) {
    emitEvent(cwd, {
      version: 1,
      type: 'repo_map_skipped',
      orchestration_id: orchestrationId,
      timestamp: ts,
      subagent_type: agentType,
      agent_id: event.agent_id || null,
      skip_reason: 'disabled_by_config',
    });
    emitted.push('repo_map_skipped');
  } else if (repoMapSection) {
    const bytes = Buffer.byteLength(repoMapSection.text, 'utf8');
    // Heuristic ~4 chars/token (matches v2.1.17 W8 budget math).
    const tokens = Math.ceil(bytes / 4);
    emitEvent(cwd, {
      version: 1,
      type: 'repo_map_injected',
      orchestration_id: orchestrationId,
      timestamp: ts,
      subagent_type: agentType,
      agent_id: event.agent_id || null,
      repo_map_bytes: bytes,
      repo_map_tokens: tokens,
      repo_map_source: repoMapSection.source,
    });
    emitted.push('repo_map_injected');
  } else if (REPO_MAP_OPT_OUT_AGENTS.has(agentType || '')) {
    emitEvent(cwd, {
      version: 1,
      type: 'repo_map_skipped',
      orchestration_id: orchestrationId,
      timestamp: ts,
      subagent_type: agentType,
      agent_id: event.agent_id || null,
      skip_reason: 'agent_opted_out',
    });
    emitted.push('repo_map_skipped');
  } else {
    // Heading absent AND config-enabled AND agent not on opt-out list.
    // Possible causes (in priority order):
    //   1. size_exceeded — on-disk repo-map.md > cap (rare; configured)
    //   2. template_drift — a NEAR-MISS heading is present (e.g.,
    //      `### Repository Map`, lowercased, indented, or `## Repo Map`)
    //      indicating PM template drift, NOT an injection-pipeline bug.
    //   3. error — true leak; PM forgot to call injectRepoMap().
    //
    // v2.2.3 P2 follow-up: detect template_drift first so analytics do not
    // conflate template-drift with real leaks. Reviewer's W3 issue.
    const skipReason = inferSkipReason(cwd, promptText);
    emitEvent(cwd, {
      version: 1,
      type: 'repo_map_skipped',
      orchestration_id: orchestrationId,
      timestamp: ts,
      subagent_type: agentType,
      agent_id: event.agent_id || null,
      skip_reason: skipReason,
    });
    emitted.push('repo_map_skipped');
  }

  return { eventsEmitted: emitted };
}

/**
 * Extract the `## Repository Map` section from a delegation prompt.
 *
 * Returns { text, source } where:
 *   - text is the raw section text (heading line through next `## ` or EOF).
 *   - source is 'cache' when the heading is the "(unchanged this orchestration)"
 *     pointer variant or contains a `repo_map_delta:` marker; 'fresh'
 *     otherwise. (Note: `stale` is reserved for future use — it is not
 *     directly observable from the rendered prompt.)
 *
 * Returns null when no Repository Map heading is found.
 *
 * @param {string} promptText
 * @returns {{ text: string, source: 'fresh'|'cache' } | null}
 */
function extractRepoMapSection(promptText) {
  if (!promptText || typeof promptText !== 'string') return null;

  const re = new RegExp(REPO_MAP_HEADING_RE.source, 'gm');
  const match = re.exec(promptText);
  if (!match) return null;

  const sectionStart = match.index;
  // Find the next top-level `## ` heading (not the same one).
  const remainder = promptText.slice(sectionStart + match[0].length);
  const nextHeadingRe = /^## (?!Repository Map\b)/m;
  const nextMatch = remainder.match(nextHeadingRe);
  const sectionEnd = nextMatch
    ? sectionStart + match[0].length + nextMatch.index
    : promptText.length;

  const text = promptText.slice(sectionStart, sectionEnd);

  // Determine source. Cache pointer block has the "(unchanged ...)" suffix
  // OR the body contains a `repo_map_delta:` marker (delta-mode pointer).
  const isCachePointer = REPO_MAP_HEADING_CACHE_RE.test(match[0]);
  const hasDeltaMarker = REPO_MAP_DELTA_RE.test(text);
  const source = (isCachePointer || hasDeltaMarker) ? 'cache' : 'fresh';

  return { text, source };
}

/**
 * Near-miss detector for Repository Map headings. Catches template drift
 * BEFORE reporting a true injection-pipeline gap. Matches:
 *
 *   `### Repository Map`            — wrong heading level
 *   `## repository map`             — lowercase
 *   `   ## Repository Map`          — leading whitespace / indented
 *   `## Repo Map`                   — alternate name
 *   `## RepositoryMap`              — collapsed whitespace
 *
 * Anchored line-start (with optional leading whitespace) and case-insensitive
 * over `repo(?:sitory)?\s*map`. Rejects prose mid-sentence ("the Repository Map
 * for context") because the regex requires `^\s*#{1,6}\s+` heading prefix.
 *
 * Returns true when a near-miss is found and the canonical regex did NOT match
 * (callers should only invoke this AFTER confirming `extractRepoMapSection`
 * returned null).
 *
 * @param {string} promptText
 * @returns {boolean}
 */
function hasNearMissRepoMapHeading(promptText) {
  if (!promptText || typeof promptText !== 'string') return false;
  // 1-to-6 hashes, optional leading whitespace, then "repo" / "repository" map.
  // Case-insensitive, multiline.
  const re = /^[ \t]*#{1,6}[ \t]+repo(?:sitory)?[ \t]*map\b/im;
  return re.test(promptText);
}

/**
 * Infer the skip reason for a missing Repository Map heading when no other
 * signal is available.
 *
 *   1. size_exceeded — config has `repo_map.max_inject_bytes` AND the on-disk
 *      `.orchestray/kb/facts/repo-map.md` exceeds the cap.
 *   2. template_drift — a NEAR-MISS heading is present in the prompt
 *      (e.g., `### Repository Map`, lowercase, indented, `## Repo Map`).
 *      The PM's delegation template drifted; the injection pipeline is fine.
 *   3. error — heading absent AND no near-miss; most likely a true leak
 *      (PM forgot to call `injectRepoMap()`).
 *
 * This deliberately distinguishes template_drift from error so analytics
 * surface the two failure classes separately. v2.2.3 P2 follow-up.
 *
 * @param {string} cwd
 * @param {string|null} [promptText] - delegation prompt; pass to enable the
 *   `template_drift` near-miss heuristic. When omitted, only size_exceeded
 *   vs error is distinguished (back-compat for callers that already checked).
 * @returns {'size_exceeded'|'template_drift'|'error'}
 */
function inferSkipReason(cwd, promptText) {
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const cap = cfg && cfg.repo_map && typeof cfg.repo_map.max_inject_bytes === 'number'
      ? cfg.repo_map.max_inject_bytes
      : null;
    if (cap !== null) {
      const mapPath = path.join(cwd, '.orchestray', 'kb', 'facts', 'repo-map.md');
      try {
        const stat = fs.statSync(mapPath);
        if (stat.size > cap) return 'size_exceeded';
      } catch (_e) { /* file missing */ }
    }
  } catch (_e) { /* fail-open */ }
  // Template-drift check: only when caller passed promptText.
  if (typeof promptText === 'string' && hasNearMissRepoMapHeading(promptText)) {
    return 'template_drift';
  }
  return 'error';
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
  isRepoMapEnabled,
  extractRepoMapSection,
  inferSkipReason,
  hasNearMissRepoMapHeading,
  CITE_CACHE_MARKER,
  SPEC_SKETCH_RE,
  REPO_MAP_DELTA_RE,
  REPO_MAP_HEADING_RE,
  REPO_MAP_HEADING_CACHE_RE,
  REPO_MAP_OPT_OUT_AGENTS,
};

if (require.main === module) {
  main();
}
