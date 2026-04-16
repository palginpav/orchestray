#!/usr/bin/env node
'use strict';

/**
 * collect-context-telemetry.js — Multi-subcommand context-telemetry writer.
 *
 * Subcommands (first positional arg):
 *   pre-spawn   PreToolUse(Agent|Task|Explore)  — stage spawn info (model, effort, description)
 *   start       SubagentStart                   — insert active_subagents[] row
 *   stop        SubagentStop                    — update final tokens, or remove row
 *   post-spawn  PostToolUse(Agent|Task|Explore) — remove row if still present
 *
 * Usage: node bin/collect-context-telemetry.js <subcommand>
 * Stdin: Claude Code hook JSON payload.
 *
 * Fail-open contract: any error → stderr → exit 0 ({continue:true}).
 * W3 / v2.0.19 Pillar B.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { resolveSafeCwd }         = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }        = require('./_lib/constants');
const { updateCache }            = require('./_lib/context-telemetry-cache');
const { extractLastAssistantUsage, extractFirstAssistantModel } = require('./_lib/transcript-usage');
const { safeRealpath, isInsideAllowed, encodeProjectPath } = require('./_lib/path-containment');
const { lookupModel, resolveContextWindow } = require('./_lib/models');

let _staging_counter = 0;

const SUBCOMMAND = process.argv[2] || '';

// Print help when invoked with no/unknown subcommand.
if (!['pre-spawn', 'start', 'stop', 'post-spawn'].includes(SUBCOMMAND)) {
  process.stdout.write(
    'collect-context-telemetry.js — Orchestray context telemetry writer\n' +
    'Usage: node collect-context-telemetry.js <subcommand>\n' +
    'Subcommands: pre-spawn, start, stop, post-spawn\n'
  );
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return the base dir for the Claude projects cache for this project.
 * ~/.claude/projects/<encoded>/
 *
 * @param {string} projectDir
 * @returns {string}
 */
function claudeProjectsDir(projectDir) {
  const encoded = encodeProjectPath(projectDir);
  return path.join(os.homedir(), '.claude', 'projects', '-' + encoded);
}

/**
 * Return the subagents dir for a session.
 * ~/.claude/projects/<encoded>/<session_id>/subagents/
 *
 * @param {string} projectDir
 * @param {string} sessionId
 * @returns {string}
 */
function subagentsDir(projectDir, sessionId) {
  return path.join(claudeProjectsDir(projectDir), sessionId, 'subagents');
}

/**
 * Safely read and parse a JSON file. Returns null on any error.
 * @param {string} filePath
 * @returns {object|null}
 */
function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

/**
 * Compute total_prompt from a usage blob.
 * total_prompt = input + cache_read + cache_creation (not output — output is response, not prompt).
 */
function totalPrompt(usage) {
  return (usage.input_tokens || 0) +
         (usage.cache_read_input_tokens || 0) +
         (usage.cache_creation_input_tokens || 0);
}

/**
 * Validate that transcriptPath is inside allowed dirs (project cwd or ~/.claude).
 * Returns null if the path is not allowed; returns the resolved path if allowed.
 *
 * @param {string|null} transcriptPath
 * @param {string} cwd
 * @returns {string|null}
 */
function validateTranscriptPath(transcriptPath, cwd) {
  if (!transcriptPath) return null;
  const resolved    = safeRealpath(transcriptPath);
  const cwdResolved = safeRealpath(cwd);
  const claudeHome  = safeRealpath(path.join(os.homedir(), '.claude'));
  if (!isInsideAllowed(resolved, cwdResolved, claudeHome)) return null;
  return resolved;
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

/**
 * pre-spawn: Stage spawn info from PreToolUse so SubagentStart can enrich the row.
 *
 * We key the staging by `tool_use_id` (if available) or a synthetic key from the
 * description. The staging is stored in the cache's `_spawn_staging` map (transient;
 * not displayed by the renderer).
 *
 * @param {object} event
 * @param {string} cwd
 */
function handlePreSpawn(event, cwd) {
  const toolInput = event.tool_input || {};
  const key = event.tool_use_id || ('spawn-' + Date.now() + '-' + process.pid + '-' + (_staging_counter++));

  updateCache(cwd, (cache) => {
    if (!cache._spawn_staging) cache._spawn_staging = {};
    cache._spawn_staging[key] = {
      model:       toolInput.model       || null,
      effort:      toolInput.effort      || null,
      description: toolInput.description || null,
      staged_at:   new Date().toISOString(),
    };
    // Evict staging entries older than 60s to avoid unbounded growth.
    const now = Date.now();
    for (const [k, v] of Object.entries(cache._spawn_staging)) {
      if (v.staged_at && (now - new Date(v.staged_at).getTime()) > 60000) {
        delete cache._spawn_staging[k];
      }
    }
    return cache;
  });
}

/**
 * start: Insert an active_subagents[] row for the new subagent.
 *
 * Primary source for agent_type: event.agent_type.
 * Model priority: staged spawn info > .meta.json > transcript first-assistant > null.
 *
 * @param {object} event
 * @param {string} cwd
 */
function handleStart(event, cwd) {
  const agentId   = event.agent_id   || null;
  const agentType = event.agent_type || null;
  const transcriptPath = validateTranscriptPath(event.agent_transcript_path, cwd);

  if (!agentId) return; // Can't do anything without an ID.

  updateCache(cwd, (cache) => {
    // Try to consume staged spawn info.
    let staged = null;
    if (cache._spawn_staging) {
      // Find the most recent unstale staging entry.
      let latestKey = null;
      let latestTime = 0;
      for (const [k, v] of Object.entries(cache._spawn_staging)) {
        const t = v.staged_at ? new Date(v.staged_at).getTime() : 0;
        if (t > latestTime) { latestTime = t; latestKey = k; }
      }
      if (latestKey) {
        staged = cache._spawn_staging[latestKey];
        delete cache._spawn_staging[latestKey];
      }
    }

    // Try to read .meta.json sidecar for agent_type override.
    let metaAgentType = agentType;
    let metaModel = null;
    const sessId = cache.session_id;
    if (sessId) {
      const metaPath = path.join(subagentsDir(cwd, sessId), 'agent-' + agentId + '.meta.json');
      const meta = safeReadJson(metaPath);
      if (meta) {
        if (meta.agentType) metaAgentType = meta.agentType;
        if (meta.model)     metaModel     = meta.model;
      }
    }

    // Resolve model in priority order: staged > .meta.json > transcript first-assistant > null.
    let resolvedModel = (staged && staged.model) || metaModel || null;
    if (!resolvedModel && transcriptPath) {
      resolvedModel = extractFirstAssistantModel(transcriptPath);
    }

    // Resolve context window.
    const contextWindow = resolveContextWindow(resolvedModel, null);

    const now = new Date().toISOString();
    const newRow = {
      agent_id:        agentId,
      agent_type:      metaAgentType || 'unknown',
      description:     (staged && staged.description) || null,
      model:           resolvedModel,
      effort:          (staged && staged.effort) || null,
      context_window:  contextWindow,
      tokens:          null,
      started_at:      now,
      last_seen_at:    now,
      transcript_path: transcriptPath || event.agent_transcript_path || null,
    };

    // Upsert: replace existing row for this agent_id if present.
    const idx = (cache.active_subagents || []).findIndex((r) => r.agent_id === agentId);
    if (!cache.active_subagents) cache.active_subagents = [];
    if (idx >= 0) {
      cache.active_subagents[idx] = Object.assign({}, cache.active_subagents[idx], newRow);
    } else {
      cache.active_subagents.push(newRow);
    }

    return cache;
  });
}

/**
 * stop: Update final token counts (or remove the row) on SubagentStop.
 *
 * Reads the subagent transcript tail to get final usage. The row is updated in-place
 * (not removed) because PostToolUse may fire after us and we want the data visible
 * until the parent side confirms the agent is done.
 *
 * @param {object} event
 * @param {string} cwd
 */
function handleStop(event, cwd) {
  const agentId        = event.agent_id || null;
  const transcriptPath = validateTranscriptPath(event.agent_transcript_path, cwd);

  if (!agentId) return;

  // Extract final usage from the transcript (may be slow on cold cache but still < 80ms).
  let finalTokens = null;
  if (transcriptPath) {
    const extracted = extractLastAssistantUsage(transcriptPath);
    if (extracted) {
      finalTokens = {
        input:          extracted.usage.input_tokens,
        output:         extracted.usage.output_tokens,
        cache_read:     extracted.usage.cache_read_input_tokens,
        cache_creation: extracted.usage.cache_creation_input_tokens,
        total_prompt:   totalPrompt(extracted.usage),
      };
    }
  }

  updateCache(cwd, (cache) => {
    if (!cache.active_subagents) return cache;
    const idx = cache.active_subagents.findIndex((r) => r.agent_id === agentId);
    if (idx < 0) return cache; // Row already removed by post-spawn or missing — no-op.

    const row = cache.active_subagents[idx];
    cache.active_subagents[idx] = Object.assign({}, row, {
      tokens:       finalTokens || row.tokens,
      last_seen_at: new Date().toISOString(),
    });
    return cache;
  });
}

/**
 * post-spawn: Remove the active_subagents[] row on PostToolUse.
 *
 * SubagentStop ordering relative to PostToolUse is not guaranteed; we remove
 * the row here idempotently (no-op if already removed by SubagentStop).
 *
 * @param {object} event
 * @param {string} cwd
 */
function handlePostSpawn(event, cwd) {
  const agentId = event.agent_id || null;
  if (!agentId) return;

  updateCache(cwd, (cache) => {
    if (!cache.active_subagents) return cache;
    cache.active_subagents = cache.active_subagents.filter((r) => r.agent_id !== agentId);
    return cache;
  });
}

// ── Session janitor (called from handleStop's updateCache context) ─────────────
// NOTE: The janitor runs on the Stop hook side via capture-pm-turn.js extension
// (updateSessionTelemetry). It is NOT called from the subagent-side SubagentStop
// handler here, because the subagent-side hooks run inside the subagent process
// and do not have access to the parent session's subagents directory listing.
// The janitor is implemented in the updateSessionTelemetry function exported below.

// ── Main ──────────────────────────────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] collect-context-telemetry: stdin exceeded limit; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    const cwd   = resolveSafeCwd(event.cwd);

    switch (SUBCOMMAND) {
      case 'pre-spawn':  handlePreSpawn(event, cwd);  break;
      case 'start':      handleStart(event, cwd);     break;
      case 'stop':       handleStop(event, cwd);      break;
      case 'post-spawn': handlePostSpawn(event, cwd); break;
      default: break; // Already filtered above
    }
  } catch (err) {
    process.stderr.write('[orchestray] collect-context-telemetry ' + SUBCOMMAND + ': error (fail-open): ' + String(err) + '\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
