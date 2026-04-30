#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * v221-self-heal.js — v2.2.1 install-side one-shot cleanup.
 *
 * Owned by W2. Invoked from `bin/install.js` after the standard install
 * sequence so users upgrading from v2.1.x or v2.2.0 get the bad-state
 * artefacts swept on the same `npm install` (rather than waiting for the
 * first PreToolUse / UserPromptSubmit hook to land).
 *
 * What it cleans (per-project, only the project that owns this install):
 *
 *   1. `.orchestray/state/.block-a-zone-caching-disabled` — sentinel.
 *      v2.2.0 wrote a bare-string body with no TTL. v2.2.1 ignores
 *      bare-string sentinels at runtime (they self-expire on the first
 *      PreToolUse), but install-time removal also makes the recovery
 *      visible immediately and emits a single audit event.
 *
 *   2. `.orchestray/state/housekeeper-quarantined` — sentinel written by
 *      v2.2.0 `audit-housekeeper-drift.js` from a false-positive drift
 *      detector. W3 (separate task in this orchestration) is fixing the
 *      detector itself; this script removes the EXISTING quarantine
 *      markers so currently-quarantined projects come back online.
 *      Bare-string bodies are removed unconditionally; JSON bodies with
 *      a `keep_until` timestamp in the future are preserved.
 *
 * Other projects on the same machine are NOT touched — install.js only
 * knows its own cwd. They will self-heal on their first PreToolUse /
 * UserPromptSubmit (sentinel auto-expiry) without needing this script.
 *
 * Idempotent: writes a sentinel at `.orchestray/state/.v221-self-heal-done`
 * so subsequent install runs are no-ops. Fail-open at every step — never
 * fails the install on cleanup errors.
 *
 * Audit events emitted:
 *   - v221_cache_sentinel_cleared   (per .block-a-zone-caching-disabled removed)
 *   - v221_housekeeper_quarantine_cleared (per housekeeper-quarantined removed)
 *   - v221_self_heal_complete       (once, on completion)
 */

const fs   = require('fs');
const path = require('path');

const STATE_DIR = path.join('.orchestray', 'state');
const DONE_SENTINEL = '.v221-self-heal-done';
const CACHE_SENTINEL_FILE = '.block-a-zone-caching-disabled';
const HOUSEKEEPER_SENTINEL_FILE = 'housekeeper-quarantined';

function _emit(cwd, type, extra) {
  // Use the central writer when available; fail-open if missing.
  try {
    const { writeEvent } = require('./_lib/audit-event-writer');
    const entry = Object.assign(
      { version: 1, timestamp: new Date().toISOString(), type, orchestration_id: 'install-v221-self-heal' },
      extra
    );
    writeEvent(entry, { cwd });
  } catch (_e) { /* fail-open */ }
}

function _readBody(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; }
}

function _isStaleCacheSentinel(raw) {
  if (raw == null) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return true;
  if (trimmed[0] !== '{') return true; // legacy bare string
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return true;
    if (parsed.quarantined === true) return false; // explicit latch — preserve
    const expiresAt = parsed.expires_at ? new Date(parsed.expires_at).getTime() : 0;
    if (!expiresAt || isNaN(expiresAt)) return true;
    return expiresAt <= Date.now();
  } catch (_e) { return true; }
}

function _isStaleHousekeeperSentinel(raw) {
  if (raw == null) return false;
  const trimmed = String(raw).trim();
  if (!trimmed) return true;
  if (trimmed[0] !== '{') return true; // legacy bare string — false positive era
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return true;
    if (parsed.preserve === true) return false;
    const keepUntil = parsed.keep_until ? new Date(parsed.keep_until).getTime() : 0;
    if (keepUntil && !isNaN(keepUntil) && keepUntil > Date.now()) return false;
    return true;
  } catch (_e) { return true; }
}

function _clearIfStale(cwd, fileName, isStaleFn, eventType) {
  const fullPath = path.join(cwd, STATE_DIR, fileName);
  if (!fs.existsSync(fullPath)) return false;
  const raw = _readBody(fullPath);
  if (!isStaleFn(raw)) return false;
  try {
    fs.unlinkSync(fullPath);
    _emit(cwd, eventType, {
      file: path.join(STATE_DIR, fileName),
      previous_body: raw ? raw.slice(0, 256) : null,
    });
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Run the self-heal sweep against the given project root.
 * Returns a small summary object (used by the install script for the
 * console output).
 */
function runSelfHeal(cwd) {
  const stateDir   = path.join(cwd, STATE_DIR);
  const doneMarker = path.join(stateDir, DONE_SENTINEL);

  // Idempotency: bail if already run for this install.
  if (fs.existsSync(doneMarker)) {
    return { ran: false, reason: 'already_done' };
  }

  let cacheCleared = false;
  let housekeeperCleared = false;

  try {
    fs.mkdirSync(stateDir, { recursive: true });
  } catch (_e) { /* fail-open */ }

  try {
    cacheCleared = _clearIfStale(
      cwd, CACHE_SENTINEL_FILE, _isStaleCacheSentinel, 'v221_cache_sentinel_cleared'
    );
  } catch (_e) { /* fail-open */ }

  try {
    housekeeperCleared = _clearIfStale(
      cwd, HOUSEKEEPER_SENTINEL_FILE, _isStaleHousekeeperSentinel, 'v221_housekeeper_quarantine_cleared'
    );
  } catch (_e) { /* fail-open */ }

  // Drop the done sentinel so re-running the installer is cheap.
  try {
    fs.writeFileSync(
      doneMarker,
      JSON.stringify({
        ran_at: new Date().toISOString(),
        cache_sentinel_cleared: cacheCleared,
        housekeeper_quarantine_cleared: housekeeperCleared,
      }, null, 2) + '\n',
      'utf8'
    );
  } catch (_e) { /* fail-open */ }

  _emit(cwd, 'v221_self_heal_complete', {
    cache_sentinel_cleared: cacheCleared,
    housekeeper_quarantine_cleared: housekeeperCleared,
  });

  return {
    ran: true,
    cache_sentinel_cleared: cacheCleared,
    housekeeper_quarantine_cleared: housekeeperCleared,
  };
}

if (require.main === module) {
  const cwd = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  try {
    const result = runSelfHeal(cwd);
    if (result.ran) {
      const cleared = [];
      if (result.cache_sentinel_cleared) cleared.push('cache-disable sentinel');
      if (result.housekeeper_quarantine_cleared) cleared.push('housekeeper quarantine');
      if (cleared.length > 0) {
        process.stdout.write(
          '[orchestray] v2.2.1 self-heal: cleared ' + cleared.join(', ') + '\n'
        );
      }
    }
  } catch (_e) {
    // Fail-open: never fail the install.
  }
  process.exit(0);
}

module.exports = { runSelfHeal };
