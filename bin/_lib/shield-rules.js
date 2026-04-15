'use strict';

/**
 * shield-rules.js — Rule table for the context-shield PreToolUse:Read hook.
 *
 * Starts with a single rule: R14 (Read dedup / cache-replay elimination).
 * Future rules (R15, R16, …) can be appended as additional entries in the
 * RULES array without touching the hook entry-point (bin/context-shield.js).
 *
 * Rule interface:
 *   {
 *     id: string,           — e.g. 'R14'
 *     description: string,  — human-readable, for logs/docs
 *     apply(ctx): Result    — see Result typedef below
 *   }
 *
 * ctx (RuleContext):
 *   {
 *     toolName:     string,          — always 'Read' for the current hook
 *     toolInput:    object,          — raw tool_input from the hook payload
 *     event:        object,          — full hook payload
 *     cwd:          string,          — resolved project root
 *     sessionId:    string,          — session_id from payload
 *     fileStat:     fs.Stats|null,   — stat of the target file (null if unreadable)
 *     config:       object,          — shield config section from config-schema.js
 *   }
 *
 * Result:
 *   { decision: 'allow' }
 *   { decision: 'deny', reason: string }
 *
 * Fail-open contract: if a rule's apply() throws, the caller (context-shield.js)
 * catches the error and treats it as { decision: 'allow' }.
 */

const path = require('path');
const { lookupCache, recordRead } = require('./shield-session-cache');

// ---------------------------------------------------------------------------
// R14 — Read dedup (cache-replay elimination)
// ---------------------------------------------------------------------------

/**
 * R14: If the same (file_path, offset, limit) triple was already served in this
 * session with the same mtime, deny the re-read and return a hint pointing to
 * the previous turn.
 *
 * On a cache miss (first read, or mtime changed, or different offset/limit):
 *   - Record the triple in the session cache.
 *   - Return { decision: 'allow' }.
 *
 * On a cache hit (unchanged triple AND same mtime):
 *   - Return { decision: 'deny', reason: '…already read at turn N…' }.
 */
const R14 = {
  id: 'R14',
  description: 'Dedup Read calls: deny re-reads of unchanged (path, offset, limit) triples within a session',

  apply(ctx) {
    const { toolInput, cwd, sessionId, fileStat, event } = ctx;

    // Extract the target file path from the tool input.
    const rawFilePath = toolInput.file_path || toolInput.path || '';
    if (!rawFilePath) {
      // No path to cache — allow through.
      return { decision: 'allow' };
    }

    // W2 (T2 F2): Normalize the file path to absolute BEFORE building any cache
    // key. Claude Code may send a relative path on one invocation and an absolute
    // path on another for the same file; without normalization, the two strings
    // produce two distinct cache keys, defeating dedup silently.
    const filePath = path.resolve(cwd, rawFilePath);

    // W3 (T2 F3): If the file does not exist (fileStat is null), allow through
    // unconditionally — a non-existent file has no mtime to deduplicate on.
    // The CHANGELOG comment "Rules handle null fileStat as 'no mtime → allow
    // through'" documents this intent; this guard enforces it.  Caching an
    // empty-string mtime for a missing file causes a false-deny on the second
    // probe of the same nonexistent path (e.g., checking before creating).
    if (!fileStat) {
      return { decision: 'allow' };
    }

    // Normalise offset and limit.  Claude Code may omit them (first full read).
    // undefined/null → null (not explicitly set).
    const offset = (toolInput.offset !== undefined && toolInput.offset !== null) ? toolInput.offset : null;
    const limit = (toolInput.limit !== undefined && toolInput.limit !== null) ? toolInput.limit : null;

    // T2 F6: Treat a `pages` parameter (PDF page-range reads) as a sliced read
    // signal, mirroring the offset/limit bypass.  Two reads of the same PDF
    // with different page ranges have identical offset=null/limit=null but
    // request different content; they must both be allowed through.
    const pages = (toolInput.pages !== undefined && toolInput.pages !== null) ? toolInput.pages : null;

    // If the caller explicitly provides offset, limit, OR pages, they are doing
    // a targeted slice.  Sliced reads are ALWAYS allowed through — the dedup
    // targets full-file re-reads only.  This ensures the agent can always
    // re-slice with different bounds without being blocked.
    if (offset !== null || limit !== null || pages !== null) {
      return { decision: 'allow' };
    }

    // No offset/limit/pages — this is a full-file read.
    // Get the current mtime for freshness checking.
    const currentMtime = fileStat.mtime.toISOString();
    const turn = event.turn_number || event.turn || 0;

    // Check the cache.  Cache key is built with offset=null and limit=null
    // (encoded as 0 in the key string — see buildCacheKey).
    const { hit, turn: cachedTurn } = lookupCache(cwd, sessionId, filePath, null, null, currentMtime);

    if (hit) {
      // Cache hit: this exact file at this exact mtime was already read.
      const hint = 'orchestray-shield: already read at turn ' +
        cachedTurn +
        '. To re-fetch, call with explicit offset+limit.';
      return { decision: 'deny', reason: hint };
    }

    // Cache miss: record and allow.
    try { recordRead(cwd, sessionId, filePath, null, null, currentMtime, turn); } catch (_e) {}
    return { decision: 'allow' };
  },
};

// ---------------------------------------------------------------------------
// Rule table — ordered list; rules are evaluated in sequence, first deny wins.
// Future rules (R15, R16, …) should be appended here.
// ---------------------------------------------------------------------------

const RULES = [R14];

module.exports = { RULES };
