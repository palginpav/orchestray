'use strict';

/**
 * caller-identity.js — Resolve a hook caller's real subagent type.
 *
 * Extracted from bin/gate-agent-spawn.js (v2.3.19 W-AC-4) so consumers can
 * reuse the resolution without requiring an entire hook: the module-scope
 * `require('./gate-agent-spawn')` in detect-tool-grant-shortfall.js pulled in
 * zod + ~87 extra modules and ~45 ms on every SubagentStop.
 *
 * Exported API:
 *   stripCollisionSuffix(rosterName) → string
 *   resolveCallerAgentTypeFromMeta(rosterName, sessionId, cwd) → string|null
 *
 * ---------------------------------------------------------------------------
 * W-AC-4 caller identity (v2.3.19).
 *
 * `event.agent_type` carries the ROSTER NAME the caller was spawned under (the
 * Agent Teams `name:` field), not the `subagent_type` that decides what the
 * agent actually is. Authorizing on it was wrong in both directions:
 *
 *   False negative (observed twice, v2.3.18): a legitimate `curate-runner`
 *   spawned as `curate-v2318` / `curate-runner-2` read as that name, failed the
 *   allowlist, and could not spawn Agent(curator).
 *
 *   False positive: any agent spawned with `name: "pm"` read as `pm` and passed
 *   — a caller-chosen string defeating the gate it is supposed to feed.
 *
 * Claude Code writes the real type to a sidecar it owns:
 *   ~/.claude/projects/-<encoded-cwd>/<session_id>/subagents/agent-a<roster>-<hash>.meta.json
 *   { "name": "<roster name>", "customAgentType": "<subagent_type>", ... }
 *
 * `customAgentType` is recorded by the runtime at spawn time and is not chosen
 * by the calling agent, so it — not `agent_type` — is what we authorize on.
 * Verified against 55/55 sidecars in a live session: every one carries
 * `customAgentType`, and `agentType` always equals the roster `name`.
 * ---------------------------------------------------------------------------
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { encodeProjectPath, safeRealpath, isInsideAllowed } = require('./path-containment');

/** Cap on sidecars parsed per lookup — bounds the worst case on a hot path. */
const MAX_META_CANDIDATES = 8;

/** Session ids are runtime-issued UUIDs; anything else cannot name a directory. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Strip a Claude Code collision suffix (`-2`, `-3`, …) from a roster name.
 *
 * NOT AUTHORIZATION — this is a lossy fallback used only when the spawn-metadata
 * sidecar cannot be read. It repairs the false negative (a legitimate role whose
 * roster name was auto-suffixed after a name collision) but does nothing about
 * the false positive: the input is still a caller-chosen string, so a caller
 * that names itself `pm` still authorizes on this path.
 *
 * @param {*} rosterName
 * @returns {*} Suffix-stripped name, or the input unchanged if not a string.
 */
function stripCollisionSuffix(rosterName) {
  if (typeof rosterName !== 'string') return rosterName;
  return rosterName.replace(/-\d+$/, '');
}

/**
 * Resolve the caller's true subagent type from Claude Code's spawn metadata.
 *
 * Returns null when the sidecar cannot be located or read — the caller must
 * then fall back to the roster-name heuristic and accept that it is not
 * authoritative.
 *
 * @param {string} rosterName - event.agent_type (caller-chosen roster name).
 * @param {string} sessionId  - event.session_id.
 * @param {string} cwd        - Resolved project root.
 * @returns {string|null} The runtime-recorded customAgentType, or null.
 */
function resolveCallerAgentTypeFromMeta(rosterName, sessionId, cwd) {
  if (typeof rosterName !== 'string' || !rosterName) return null;
  if (typeof sessionId  !== 'string' || !sessionId)  return null;
  if (typeof cwd        !== 'string' || !cwd)        return null;

  // F2: session_id is payload data — reject anything that could name a
  // directory outside the session tree before it reaches path.join.
  if (!SESSION_ID_RE.test(sessionId) || sessionId.includes('..')) return null;

  const claudeHome = path.join(os.homedir(), '.claude');
  const subDir = path.join(
    claudeHome, 'projects', '-' + encodeProjectPath(cwd), sessionId, 'subagents'
  );
  // Belt-and-braces: the regex already blocks traversal, but every hook that
  // builds a path from payload data confirms containment before reading.
  if (!isInsideAllowed(safeRealpath(subDir), claudeHome, claudeHome)) return null;

  let entries;
  try { entries = fs.readdirSync(subDir); } catch (_e) { return null; }

  // Sidecar filenames are `agent-a<roster name>-<runtime hash>.meta.json`, so
  // anchor on that exact prefix. A bare `includes` charged the parse budget
  // against any filename merely containing the roster name — nine such files
  // exhausted the budget and forced the (weaker) roster-name fallback.
  // The prefix still cannot disambiguate `curate-runner` from
  // `curate-runner-2`, so `meta.name` remains the deciding check.
  const prefix = 'agent-a' + rosterName + '-';
  let parsed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json') || !entry.startsWith(prefix)) continue;
    if (++parsed > MAX_META_CANDIDATES) break;
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(subDir, entry), 'utf8'));
    } catch (_e) { continue; }
    if (meta && meta.name === rosterName &&
        typeof meta.customAgentType === 'string' && meta.customAgentType) {
      return meta.customAgentType;
    }
  }
  return null;
}

module.exports = {
  MAX_META_CANDIDATES,
  stripCollisionSuffix,
  resolveCallerAgentTypeFromMeta,
};
