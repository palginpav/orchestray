'use strict';

/**
 * double-fire-guard.js — Tokenwright backward-compatibility shim.
 *
 * Originally a standalone Tokenwright-only guard (W4 §B3 / event 6).
 * In v2.2.8 the implementation moved to `bin/_lib/double-fire-guard.js`
 * (generalized for non-Tokenwright hooks). This module is a thin wrapper
 * that preserves the existing `checkDoubleFire` API so callers like
 * `bin/inject-tokenwright.js` and `bin/capture-tokenwright-realized.js`
 * continue to work without changes.
 *
 * Behavior contract preserved: same TTL (60s), same JSONL state path
 * (`.orchestray/state/tokenwright-dedup.jsonl` — renamed by the generalized
 * helper to `<guardName>-dedup.jsonl`, but the legacy filename is still
 * the canonical Tokenwright location). The `doubleFireEvent` payload
 * carries `guard_name: 'tokenwright'` and `dedup_key` (renamed from
 * `dedup_token` in the generalized API) so existing analytics readers
 * continue to match it.
 */

const { requireGuard } = require('../double-fire-guard');

/**
 * Tokenwright-flavored guard call. Translates the legacy
 * `{ dedupToken, callerPath, stateDir, orchestrationId }` shape into the
 * generalized `requireGuard` parameters.
 *
 * @param {object} args
 * @param {string} args.dedupToken     Tokenwright spawn token (renamed to dedup_key).
 * @param {string} args.callerPath     __filename of the calling hook.
 * @param {string} args.stateDir       `.orchestray/state/` directory.
 * @param {string} args.orchestrationId
 * @returns {{ shouldFire: boolean, doubleFireEvent: object|null }}
 */
function checkDoubleFire({ dedupToken, callerPath, stateDir, orchestrationId }) {
  return requireGuard({
    guardName:       'tokenwright',
    dedupKey:        dedupToken,
    ttlMs:           60 * 1000, // preserve original 60s TTL
    stateDir,
    callerPath,
    orchestrationId,
  });
}

module.exports = { checkDoubleFire };
