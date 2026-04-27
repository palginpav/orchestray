#!/usr/bin/env node
'use strict';

/**
 * observe-output-shape.js — SubagentStop hook (v2.2.3 Phase-2 W2).
 *
 * Pairs with `bin/inject-output-shape.js` (PreToolUse:Agent). The injection
 * hook fires BEFORE the agent runs and emits `output_shape_applied` with
 * `baseline_output_tokens` (role-budget cache) and `cap_output_tokens` (the
 * actually-injected cap), but cannot know `observed_output_tokens` —
 * that figure only exists after the agent stops. This hook closes that loop:
 *
 *   1. On SubagentStop, parse the hook payload for
 *      (orchestration_id, agent_type, agent_id, transcript_path, usage).
 *   2. Compute observed output tokens — preferring the hook payload's
 *      `usage.output_tokens` field, falling back to a transcript scan, and
 *      finally null when both are unavailable.
 *   3. Look up the most-recent matching `output_shape_applied` event for the
 *      same (orchestration_id, role) — the canonical pairing key, since
 *      `output_shape_applied` carries no agent_id (PreToolUse:Agent boundary
 *      has no agent_id either; per `bin/inject-output-shape.js:117`).
 *   4. Emit a NEW `output_shape_observed` audit event:
 *        { type, version, timestamp, orchestration_id, session_id,
 *          role, agent_id, agent_type,
 *          observed_output_tokens, cap_output_tokens, cap_respected }
 *      Append-only — never mutates the original `output_shape_applied` row.
 *      Rollups join the two by (orchestration_id, role) most-recent-pair.
 *
 * Fail-open contract: any thrown exception → silent { continue: true } exit.
 * Hook is observability-only and must never block the SubagentStop pipeline.
 *
 * Cost: one bounded JSONL tail-scan (32 KB) plus one transcript head-scan when
 * the payload usage is missing. No network, no large reads.
 *
 * Cross-references:
 *   - bin/inject-output-shape.js     — emits the paired output_shape_applied row
 *   - agents/pm-reference/event-schemas.md
 *                                    — canonical schemas for both rows
 *   - .orchestray/kb/artifacts/v223-p2-output-shape-token-populate.md
 *                                    — design + verification plan
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { writeEvent }                  = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

// Cap on the events.jsonl tail scanned to find the most-recent applied row.
// 32 KB is enough to cover ~80–120 recent rows; output_shape_applied is
// emitted at most ~3–8 per orch so a recent match is always within range.
const EVENTS_TAIL_BYTES = 32 * 1024;

// Cap on the transcript scanned for usage when the hook payload omits it.
// 256 KB tail is sufficient to hit the closing usage block of any normal turn.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// stdout helper — fail-open exit shape Claude Code expects.
// ---------------------------------------------------------------------------

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }));
}

// ---------------------------------------------------------------------------
// Resolve orchestration_id (best-effort; matches inject-output-shape.js).
// ---------------------------------------------------------------------------

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return orchData && typeof orchData.orchestration_id === 'string'
      ? orchData.orchestration_id
      : null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Read the tail of a file, bounded. Avoids loading large logs into memory.
// Returns "" on any error (caller treats this as "no data").
// ---------------------------------------------------------------------------

function readFileTail(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= maxBytes) {
      return fs.readFileSync(filePath, 'utf8');
    }
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
      return buf.slice(0, read).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  } catch (_e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Find the most-recent `output_shape_applied` event matching
// (orchestration_id, role) by tail-scanning events.jsonl. Returns the parsed
// row or null. The pairing key is (orch, role) because PreToolUse:Agent has
// no agent_id (Claude Code does not pass one on that boundary), so neither
// does the applied row — see bin/inject-output-shape.js comment.
// ---------------------------------------------------------------------------

function findMatchingApplied(cwd, orchestrationId, role) {
  if (!orchestrationId || !role) return null;
  const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  const tail = readFileTail(eventsPath, EVENTS_TAIL_BYTES);
  if (!tail) return null;

  const lines = tail.split('\n');
  // Walk backwards — first match is the most recent.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (line.indexOf('"output_shape_applied"') === -1) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_e) { continue; }
    if (!ev || ev.type !== 'output_shape_applied') continue;
    if (ev.orchestration_id !== orchestrationId) continue;
    if (ev.role !== role) continue;
    return ev;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Compute observed output_tokens for this stop. Strategy:
//   1. Prefer hook payload `usage.output_tokens` (Claude Code surfaces this
//      on SubagentStop).
//   2. Fall back to a transcript tail-scan summing `usage.output_tokens`
//      across assistant messages (mirrors collect-agent-metrics.js logic
//      but bounded — we only need an order-of-magnitude figure for
//      cap_respected).
//   3. null when both are missing.
// ---------------------------------------------------------------------------

function computeObservedTokens(event) {
  // 1. Direct usage from hook payload.
  const usage = event && event.usage;
  if (usage && typeof usage === 'object') {
    const v = Number(usage.output_tokens);
    if (Number.isFinite(v) && v >= 0) return v;
  }

  // 2. Transcript fallback (best-effort, bounded read).
  const transcriptPath = (event && typeof event.agent_transcript_path === 'string')
    ? event.agent_transcript_path
    : (event && typeof event.transcript_path === 'string' ? event.transcript_path : null);
  if (!transcriptPath) return null;

  const tail = readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (!tail) return null;

  let total = 0;
  let any = false;
  const lines = tail.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch (_e) { continue; }
    const u = entry && (entry.usage || (entry.message && entry.message.usage));
    if (u && typeof u === 'object') {
      const v = Number(u.output_tokens);
      if (Number.isFinite(v) && v >= 0) {
        total += v;
        any = true;
      }
    }
  }
  return any ? total : null;
}

// ---------------------------------------------------------------------------
// Main stdin processor — same fail-open shape as the other SubagentStop hooks.
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { emitContinue(); process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write(
      '[orchestray] observe-output-shape: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; failing open\n'
    );
    emitContinue();
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    let event;
    try {
      event = JSON.parse(input || '{}');
    } catch (_e) {
      emitContinue();
      process.exit(0);
      return;
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event && event.cwd);
    } catch (_e) {
      cwd = process.cwd();
    }

    // Role discovery — the SubagentStop payload carries `agent_type`. Some
    // legacy callers or team events use other keys; mirror the collect-agent-
    // metrics.js precedence so nothing slips through.
    const role = (event && typeof event.agent_type === 'string' && event.agent_type.length > 0)
      ? event.agent_type
      : null;

    const orchestrationId = resolveOrchestrationId(cwd);

    // Without a role or orchestration id we cannot pair — silent exit.
    if (!role || !orchestrationId) {
      emitContinue();
      process.exit(0);
      return;
    }

    const applied = findMatchingApplied(cwd, orchestrationId, role);
    if (!applied) {
      // No matching applied row — either the role is excluded
      // (pm/haiku-scout/etc.), the kill switch tripped, or the row scrolled
      // out of the bounded tail. Either way, no observation to emit.
      emitContinue();
      process.exit(0);
      return;
    }

    const observed = computeObservedTokens(event);
    const cap = (typeof applied.cap_output_tokens === 'number')
      ? applied.cap_output_tokens
      : (typeof applied.length_cap === 'number' ? applied.length_cap : null);

    let capRespected = null;
    if (typeof observed === 'number' && typeof cap === 'number') {
      capRespected = observed <= cap;
    }

    const payload = {
      version: 1,
      type: 'output_shape_observed',
      orchestration_id: orchestrationId,
      session_id: typeof event.session_id === 'string' ? event.session_id : (applied.session_id || null),
      agent_id: typeof event.agent_id === 'string' ? event.agent_id : null,
      agent_type: role,
      role: role,
      observed_output_tokens: typeof observed === 'number' ? observed : null,
      cap_output_tokens: cap,
      cap_respected: capRespected,
      baseline_output_tokens: typeof applied.baseline_output_tokens === 'number'
        ? applied.baseline_output_tokens
        : null,
    };

    try { writeEvent(payload, { cwd }); } catch (_e) { /* swallow */ }

    emitContinue();
    process.exit(0);
  } catch (_e) {
    try { emitContinue(); } catch (_inner) { /* swallow */ }
    process.exit(0);
  }
});

// Exported for test access (no side effects on require).
module.exports = {
  findMatchingApplied,
  computeObservedTokens,
  readFileTail,
  EVENTS_TAIL_BYTES,
  TRANSCRIPT_TAIL_BYTES,
};
