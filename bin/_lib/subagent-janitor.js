'use strict';

/**
 * subagent-janitor.js — Reconcile cache.active_subagents[] with on-disk subagent state.
 *
 * 1. Recover lost SubagentStart: any agent-<id>.jsonl mtime-touched within STALE_MS
 *    but missing from active_subagents[] is re-inserted from .meta.json.
 * 2. Reap stale rows: any row whose last_seen_at AND transcript .jsonl mtime are
 *    both older than STALE_MS (or transcript_path is unreadable/missing).
 *
 * Mutates `cache.active_subagents` in place. Fail-open: any I/O error is swallowed.
 *
 * Originally inlined in bin/capture-pm-turn.js (W3 / v2.0.19). Extracted in v2.0.21
 * so SubagentStop can also trigger a sweep — not just the parent Stop hook.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { encodeProjectPath } = require('./path-containment');
const { resolveContextWindow } = require('./models');

const STALE_MS = 60000; // 60 seconds — same window used since v2.0.19.

/**
 * @param {string} cwd
 * @param {string|null} sessionId
 * @param {object} cache  - Cache object (cache.active_subagents mutated in place).
 */
function runJanitor(cwd, sessionId, cache) {
  if (!sessionId) return;

  const subDir = path.join(os.homedir(), '.claude', 'projects',
    '-' + encodeProjectPath(cwd),
    sessionId, 'subagents');

  let entries;
  try {
    entries = fs.readdirSync(subDir);
  } catch (_e) {
    // Subagents dir does not exist yet — nothing to recover, but still reap.
    entries = [];
  }

  const now = Date.now();

  if (!Array.isArray(cache.active_subagents)) cache.active_subagents = [];
  const activeIds = new Set(cache.active_subagents.map((r) => r.agent_id));

  // 1. Recover lost SubagentStart events.
  for (const entry of entries) {
    const match = entry.match(/^agent-([^.]+)\.jsonl$/);
    if (!match) continue;
    const agentId = match[1];
    if (activeIds.has(agentId)) continue;

    const jsonlPath = path.join(subDir, entry);
    let mtime;
    try { mtime = fs.statSync(jsonlPath).mtimeMs; } catch (_e) { continue; }
    if (now - mtime > STALE_MS) continue;

    const metaPath = path.join(subDir, 'agent-' + agentId + '.meta.json');
    const meta = (() => {
      try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_e) { return null; }
    })();

    cache.active_subagents.push({
      agent_id:        agentId,
      agent_type:      (meta && meta.agentType) || 'unknown',
      description:     (meta && meta.description) || null,
      model:           (meta && meta.model) || null,
      effort:          null,
      context_window:  resolveContextWindow((meta && meta.model) || null, null),
      tokens:          null,
      started_at:      new Date(mtime).toISOString(),
      last_seen_at:    new Date(mtime).toISOString(),
      transcript_path: jsonlPath,
      tool_use_id:     null, // Recovered rows have no staged tool_use_id link.
    });
    activeIds.add(agentId);
  }

  // 2. Reap stale rows.
  cache.active_subagents = cache.active_subagents.filter((row) => {
    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (now - lastSeen <= STALE_MS) return true;

    const tPath = row.transcript_path;
    if (tPath) {
      try {
        const mtime = fs.statSync(tPath).mtimeMs;
        if (now - mtime <= STALE_MS) return true;
      } catch (_e) { /* file gone — fall through to reap */ }
    }
    return false;
  });
}

module.exports = { runJanitor };
