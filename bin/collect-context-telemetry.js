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
const { runJanitor }             = require('./_lib/subagent-janitor');

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
    let stagedKey = null;
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
        stagedKey = latestKey; // Equals the PreToolUse tool_use_id when one was present.
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

    // Resolve model in priority order: staged > .meta.json > transcript first-assistant
    // > parent's session model > null.
    // The parent fallback (v2.0.21) handles inherit-mode subagents whose own model is
    // not yet known at SubagentStart — without it, the row renders with a 200K context
    // window default even though Opus subagents have 1M.
    let resolvedModel = (staged && staged.model) || metaModel || null;
    if (!resolvedModel && transcriptPath) {
      resolvedModel = extractFirstAssistantModel(transcriptPath);
    }
    if (!resolvedModel && cache.session && cache.session.model) {
      resolvedModel = cache.session.model;
    }

    // Resolve context window.
    const contextWindow = resolveContextWindow(resolvedModel, null);

    const now = new Date().toISOString();
    // tool_use_id links this row back to the PreToolUse event so PostToolUse
    // can remove the row even when its payload omits agent_id (v2.0.21 fix).
    // Only store real Claude Code tool ids (toolu_*); synthetic spawn-* keys are
    // an internal staging-map detail and can't match any future PostToolUse event.
    const toolUseIdLink = (stagedKey && stagedKey.startsWith('toolu_')) ? stagedKey : null;
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
      tool_use_id:     toolUseIdLink,
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
    if (!cache.active_subagents) cache.active_subagents = [];
    const idx = cache.active_subagents.findIndex((r) => r.agent_id === agentId);
    if (idx >= 0) {
      const row = cache.active_subagents[idx];
      cache.active_subagents[idx] = Object.assign({}, row, {
        tokens:       finalTokens || row.tokens,
        last_seen_at: new Date().toISOString(),
      });
    }

    // v2.0.21: also sweep stale siblings while we're holding the lock. The
    // parent Stop hook (capture-pm-turn.js) was the only janitor before, but
    // Stop fires too rarely to keep the cache fresh in long sessions.
    try {
      const sessId = cache.session_id || event.session_id || null;
      if (sessId) runJanitor(cwd, sessId, cache);
    } catch (_e) {
      // Janitor is best-effort; never block the cache write.
    }

    return cache;
  });
}

/**
 * post-spawn: Remove the active_subagents[] row on PostToolUse(Agent|Explore|Task).
 *
 * v2.0.21: PostToolUse payloads do NOT include `agent_id` at the top level the way
 * SubagentStop does. The pre-v2.0.21 implementation read `event.agent_id` and
 * early-returned, leaving every row to expire via the slow janitor path (which
 * itself only ran on the rarely-firing parent Stop hook). Now we try multiple
 * locator strategies and fall back to a stale-row sweep, so the row is removed
 * even when none of the identifiers are present.
 *
 * @param {object} event
 * @param {string} cwd
 */
function handlePostSpawn(event, cwd) {
  // Try every identifier the payload might offer, in priority order.
  const topAgentId  = event.agent_id || null;
  const respAgentId = (event.tool_response && event.tool_response.agent_id) || null;
  const toolUseId   = event.tool_use_id || null;

  updateCache(cwd, (cache) => {
    if (!Array.isArray(cache.active_subagents) || cache.active_subagents.length === 0) {
      return cache;
    }

    const before = cache.active_subagents.length;
    cache.active_subagents = cache.active_subagents.filter((r) => {
      if (topAgentId  && r.agent_id    === topAgentId)  return false;
      if (respAgentId && r.agent_id    === respAgentId) return false;
      if (toolUseId   && r.tool_use_id === toolUseId)   return false;
      return true;
    });

    // If no identifier matched, fall back to a janitor sweep so we still
    // converge on the right state instead of letting rows accumulate.
    if (cache.active_subagents.length === before) {
      try {
        const sessId = cache.session_id || event.session_id || null;
        if (sessId) runJanitor(cwd, sessId, cache);
      } catch (_e) { /* best-effort */ }
    }

    return cache;
  });
}

// ── Session janitor ───────────────────────────────────────────────────────────
// v2.0.21: The janitor is called from BOTH `capture-pm-turn.js` (Stop hook) and
// `handleStop` here (SubagentStop hook). The latter is necessary because the
// parent Stop hook fires far less often than user prompts in practice, leaving
// the cache stale between bursts of subagent activity. The shared implementation
// lives in `_lib/subagent-janitor.js`.
//
// Note about scope: subagent-side hooks DO have access to the parent session's
// subagents directory because `event.session_id` here is the parent's session,
// and `cache.session_id` is populated by reset-context-telemetry.js at session
// start. The earlier comment claiming otherwise was incorrect.

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
