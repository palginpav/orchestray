#!/usr/bin/env node
'use strict';

/**
 * validate-cache-invariant.js — PreToolUse hook (R-PIN, v2.1.14 / v2.2.1 W2).
 *
 * On every tool call, recomputes Zone 1's hash from current source files and
 * compares against the stored hash in .orchestray/state/block-a-zones.json.
 *
 * v2.2.1 W2 — sentinel + validator self-healing redesign. Fixes the false-
 * positive auto-disable cascade documented in
 * `.orchestray/kb/artifacts/v221-w1-validate-cache-invariant-rca.md`:
 *
 *   1. Dedupe violations by (expected_hash, actual_hash) tuple within a
 *      configurable window (default 60s) so one source-file edit produces
 *      one counted violation, not N.
 *   2. Auto-rebaseline on first mismatch when the delta is confined to the
 *      Zone 1 user-editable allowlist (CLAUDE.md, handoff-contract.md,
 *      phase-contract.md). Emits `cache_baseline_refreshed` instead of
 *      `cache_invariant_broken`. The schema shadow is NOT in the allowlist —
 *      drift there must be resolved via explicit `update-schema-shadow.js`.
 *   3. Sentinel has TTL + structured JSON body + trip counter. Bare-string
 *      legacy sentinels (the format v2.1.x and v2.2.0 wrote) are treated as
 *      EXPIRED IMMEDIATELY so users self-heal on the first PreToolUse after
 *      v2.2.1 ships, with no separate post-upgrade step.
 *   4. trip_count >= quarantine_trip_threshold (default 3) latches the
 *      sentinel past TTL and emits `cache_geometry_quarantined`.
 *   5. delta_files now reports the changed-file subset (computed from
 *      per-file SHA256s persisted in zone1_file_hashes), not the entire
 *      hash input set.
 *
 * If the hash differs and auto-rebaseline does not apply:
 *   - Emits a cache_invariant_broken audit event with the true delta.
 *   - Increments a 24h violation counter (deduped per item 1 above).
 *   - If non-deduped count >= threshold, writes the structured sentinel.
 *   - Exits 0 (advisory only — does NOT block the tool call).
 *
 * v2.2.0 (P2.1) extension — UserPromptSubmit-mounted manifest invariant.
 *   Invoked with `--manifest` (or `--mode=manifest`) the script asserts the
 *   persisted 4-slot cache-breakpoint manifest is well-formed:
 *     - exactly 4 slots, slot[i].slot === i+1
 *     - marker_byte_offset is monotonically non-decreasing
 *     - ttl ∈ {'1h', '5m'}
 *     - prefix_hash is 64-char hex; prefix_token_estimate is non-negative int
 *
 *   Default behaviour is ADVISORY (exit 0 + emit `cache_invariant_broken`
 *   with `zone: 'manifest'`). Strict mode is enabled when
 *   `caching.engineered_breakpoints.strict_invariant === true`; in that
 *   mode, a malformed manifest exits 2.
 *
 * Kill switches (any one → no-op):
 *   - process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1'
 *   - config.block_a_zone_caching.enabled === false
 *   - sentinel: .orchestray/state/.block-a-zone-caching-disabled is ACTIVE
 *     (v2.2.1: TTL-aware, JSON-body, ignores legacy bare strings)
 *
 * Input:  JSON on stdin (Claude Code PreToolUse hook payload)
 * Output: exit 0 always (advisory PreToolUse path; manifest mode may exit 2 in strict)
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { loadShadowWithCheck } = require('./_lib/load-schema-shadow');
// atomicAppendJsonl is retained for the non-events.jsonl violations file;
// events.jsonl emissions route through the central audit-event gateway.
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { writeEvent }        = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

const STATE_DIR        = path.join('.orchestray', 'state');
const ZONES_FILE       = 'block-a-zones.json';
const VIOLATIONS_FILE  = 'block-a-zone-violations.jsonl';
const SENTINEL_FILE    = '.block-a-zone-caching-disabled';
const MANIFEST_FILE    = 'cache-breakpoint-manifest.json';
const VIOLATION_WINDOW = 24 * 60 * 60 * 1000; // 24 hours in ms

// v2.2.1 W2 defaults — overridable via .orchestray/config.json under
// caching.cache_invariant_validator.*. Default-on per project memory
// `feedback_default_on_shipping`.
const DEFAULT_DEDUPE_WINDOW_SECONDS     = 60;
const DEFAULT_SENTINEL_TTL_HOURS        = 24;
const DEFAULT_QUARANTINE_TRIP_THRESHOLD = 3;
const DEFAULT_AUTO_REBASELINE_ENABLED   = true;

// Files for which auto-rebaseline is allowed (Zone 1 user-editable sources).
// The schema shadow is intentionally NOT in this list — drift there must
// be resolved via explicit `update-schema-shadow.js`, not silently absorbed.
const AUTO_REBASELINE_ALLOWLIST = new Set([
  'CLAUDE.md',
  'agents/pm-reference/handoff-contract.md',
  'agents/pm-reference/phase-contract.md',
]);

// Zone 1 source files (must match compose-block-a.js ZONE1_SOURCES)
const ZONE1_SOURCES = [
  'CLAUDE.md',
  'agents/pm-reference/handoff-contract.md',
  // v2.1.15 W8: phase-contract.md joins Zone 1 — always-loaded foundation for
  // the I-PHASE-GATE phase-slice split. R-PIN cache invariant watches it.
  'agents/pm-reference/phase-contract.md',
];

// ---------------------------------------------------------------------------
// CLI dispatch — only runs when the script is invoked directly. When required
// (e.g. by tests) the module exports the pure helpers without attaching
// stdin listeners.
// ---------------------------------------------------------------------------

if (require.main === module) {
  const _argv = process.argv.slice(2);
  const _manifestMode = _argv.includes('--manifest') || _argv.includes('--mode=manifest');

  if (_manifestMode) {
    // Read stdin if available (UserPromptSubmit hook payload), but tolerate empty.
    let manifestInput = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('error', () => runManifestInvariantFromStdin(''));
    process.stdin.on('data', (chunk) => {
      manifestInput += chunk;
      if (manifestInput.length > MAX_INPUT_BYTES) {
        runManifestInvariantFromStdin(manifestInput);
      }
    });
    process.stdin.on('end', () => runManifestInvariantFromStdin(manifestInput));
  } else {
    // Original PreToolUse advisory path
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('error', () => process.exit(0));
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (input.length > MAX_INPUT_BYTES) {
        process.exit(0);
      }
    });
    process.stdin.on('end', () => {
      try {
        handle(JSON.parse(input || '{}'));
      } catch (_e) {
        process.exit(0);
      }
    });
  }
}

function runManifestInvariantFromStdin(raw) {
  try {
    let event = {};
    try { event = JSON.parse(raw || '{}') || {}; } catch (_e) {}
    handleManifestMode(event);
  } catch (_e) {
    // Fail-open
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

function loadBlockAConfig(cwd) {
  const defaults = {
    enabled: true,
    invariant_violation_threshold_24h: 5,
    // v2.2.1 W2 self-healing knobs (canonical path: caching.cache_invariant_validator.*)
    dedupe_window_seconds:     DEFAULT_DEDUPE_WINDOW_SECONDS,
    sentinel_ttl_hours:        DEFAULT_SENTINEL_TTL_HOURS,
    quarantine_trip_threshold: DEFAULT_QUARANTINE_TRIP_THRESHOLD,
    auto_rebaseline_enabled:   DEFAULT_AUTO_REBASELINE_ENABLED,
  };
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const raw    = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const out = Object.assign({}, defaults);
    const block = parsed.block_a_zone_caching;
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      Object.assign(out, block);
    }
    if (parsed.caching && typeof parsed.caching === 'object') {
      const civ = parsed.caching.cache_invariant_validator;
      if (civ && typeof civ === 'object' && !Array.isArray(civ)) {
        if (typeof civ.dedupe_window_seconds === 'number' && civ.dedupe_window_seconds >= 0) {
          out.dedupe_window_seconds = civ.dedupe_window_seconds;
        }
        if (typeof civ.sentinel_ttl_hours === 'number' && civ.sentinel_ttl_hours > 0) {
          out.sentinel_ttl_hours = civ.sentinel_ttl_hours;
        }
        if (typeof civ.quarantine_trip_threshold === 'number' && civ.quarantine_trip_threshold >= 1) {
          out.quarantine_trip_threshold = civ.quarantine_trip_threshold;
        }
        if (typeof civ.auto_rebaseline_enabled === 'boolean') {
          out.auto_rebaseline_enabled = civ.auto_rebaseline_enabled;
        }
      }
    }
    return out;
  } catch (_e) {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Sentinel (v2.2.1 W2 — TTL + structured body + trip counter)
//
// Wire format (JSON):
//   {
//     written_at:    "<ISO-8601>",
//     expires_at:    "<ISO-8601>",
//     reason:        "<short reason string>",
//     recovery_hint: "<single-line operator hint>",
//     trip_count:    <integer >= 1>,
//     quarantined:   <boolean>           // true → keep past TTL
//   }
//
// Bare-string sentinels (the legacy v2.1.x / v2.2.0 format that wrote
// "auto-disabled by validate-cache-invariant.js at <ts>") are treated as
// EXPIRED IMMEDIATELY. This is how installed users self-heal on first
// prompt after v2.2.1 ships — no separate post-upgrade step required.
// ---------------------------------------------------------------------------

function _readSentinelBody(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, STATE_DIR, SENTINEL_FILE), 'utf8');
  } catch (_e) {
    return null;
  }
}

/**
 * Parse a sentinel body. Returns null for bare-string / unparseable bodies
 * (caller treats null as expired/legacy).
 */
function parseSentinelBody(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed[0] !== '{') return null; // bare-string → legacy
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

/**
 * Returns true ONLY when the sentinel currently disables zone caching:
 *   - parsed JSON body
 *   - quarantined === true OR expires_at > now
 * Bare-string and TTL-expired sentinels are treated as INACTIVE.
 */
function isSentinelActive(cwd) {
  const sentinelPath = path.join(cwd, STATE_DIR, SENTINEL_FILE);
  if (!fs.existsSync(sentinelPath)) return false;
  const parsed = parseSentinelBody(_readSentinelBody(cwd));
  if (!parsed) return false; // legacy / unparseable → expired
  if (parsed.quarantined === true) return true;
  const expiresAt = parsed.expires_at ? new Date(parsed.expires_at).getTime() : 0;
  if (!expiresAt || isNaN(expiresAt)) return false;
  return expiresAt > Date.now();
}

/**
 * Best-effort: remove a stale sentinel and emit a recovery audit event.
 * Called from hash-OK paths so the disk file is cleaned up on the very
 * next tool call after recovery (sentinel was already INACTIVE per
 * `isSentinelActive` semantics; this just removes the stale file).
 */
function clearStaleSentinelIfAny(cwd, cfg) {
  const sentinelPath = path.join(cwd, STATE_DIR, SENTINEL_FILE);
  if (!fs.existsSync(sentinelPath)) return false;
  const raw = _readSentinelBody(cwd);
  const parsed = parseSentinelBody(raw);
  let staleReason = null;
  if (!parsed) {
    staleReason = 'legacy_bare_string';
  } else if (parsed.quarantined !== true) {
    const expiresAt = parsed.expires_at ? new Date(parsed.expires_at).getTime() : 0;
    if (!expiresAt || isNaN(expiresAt) || expiresAt <= Date.now()) {
      staleReason = 'ttl_expired';
    }
  }
  if (!staleReason) return false;
  try {
    fs.unlinkSync(sentinelPath);
    emitAuditEvent(cwd, 'cache_sentinel_expired', {
      reason:        staleReason,
      previous_body: raw ? raw.slice(0, 256) : null,
      ttl_hours:     cfg && cfg.sentinel_ttl_hours,
    });
    process.stderr.write(
      '[validate-cache-invariant] sentinel expired (' + staleReason +
      '), re-enabling block_a_zone_caching\n'
    );
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Write or refresh the sentinel. Increments trip_count if a structured
 * sentinel already exists; quarantines (latches past TTL + emits
 * cache_geometry_quarantined) when trip_count >= quarantine_trip_threshold.
 *
 * @param {string} cwd
 * @param {object} cfg  validator config
 * @param {object} extra  { reason, recovery_hint }
 * @returns {{ trip_count: number, quarantined: boolean }}
 */
function writeSentinel(cwd, cfg, extra) {
  const stateDir = path.join(cwd, STATE_DIR);
  const sentinelPath = path.join(stateDir, SENTINEL_FILE);
  const now = Date.now();
  const ttlHours = (cfg && cfg.sentinel_ttl_hours) || DEFAULT_SENTINEL_TTL_HOURS;
  const ttlMs    = ttlHours * 60 * 60 * 1000;
  const threshold = (cfg && cfg.quarantine_trip_threshold) || DEFAULT_QUARANTINE_TRIP_THRESHOLD;

  let prior = null;
  try { prior = parseSentinelBody(_readSentinelBody(cwd)); } catch (_e) { prior = null; }
  const tripCount = (prior && Number.isInteger(prior.trip_count) && prior.trip_count > 0)
    ? prior.trip_count + 1
    : 1;
  const quarantined = tripCount >= threshold;

  const body = {
    written_at:    new Date(now).toISOString(),
    expires_at:    new Date(now + ttlMs).toISOString(),
    reason:        (extra && extra.reason) || 'invariant_threshold_exceeded',
    recovery_hint: (extra && extra.recovery_hint) ||
      ('Run: node bin/invalidate-block-a-zone1.js (sentinel auto-clears after ' +
       ttlHours + 'h)'),
    trip_count:    tripCount,
    quarantined,
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = sentinelPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sentinelPath);
  } catch (_e) {
    try { fs.writeFileSync(sentinelPath, JSON.stringify(body, null, 2) + '\n', 'utf8'); }
    catch (_e2) {}
  }

  if (quarantined) {
    emitAuditEvent(cwd, 'cache_geometry_quarantined', {
      trip_count: tripCount,
      threshold,
      reason:     body.reason,
      ttl_hours:  ttlHours,
    });
  }

  return { trip_count: tripCount, quarantined };
}

// ---------------------------------------------------------------------------
// Violation counter (v2.2.1 W2 — dedupe by hash pair within window)
// ---------------------------------------------------------------------------

/**
 * Record a violation and return the count of violations within the window.
 *
 * Dedupe rule: when the most-recent line in `block-a-zone-violations.jsonl`
 * has the same (expected_hash, actual_hash) AND its ts is within
 * `dedupeWindowSeconds`, the new line is NOT appended and the counter is
 * NOT incremented — collapsing one logical edit into one counted violation.
 *
 * @param {string} cwd
 * @param {object} opts { expectedHash, actualHash, dedupeWindowSeconds }
 * @returns {{ count: number, deduped: boolean }}
 */
function recordViolationAndCount(cwd, opts) {
  opts = opts || {};
  const expectedHash = opts.expectedHash || '';
  const actualHash   = opts.actualHash   || '';
  const dedupeWindowMs = (typeof opts.dedupeWindowSeconds === 'number'
    ? opts.dedupeWindowSeconds
    : DEFAULT_DEDUPE_WINDOW_SECONDS) * 1000;

  try {
    const stateDir    = path.join(cwd, STATE_DIR);
    const violPath    = path.join(stateDir, VIOLATIONS_FILE);
    const now         = Date.now();
    const windowStart = now - VIOLATION_WINDOW;

    fs.mkdirSync(stateDir, { recursive: true });

    let existing = [];
    try {
      const raw = fs.readFileSync(violPath, 'utf8');
      existing = raw.split('\n').filter(Boolean);
    } catch (_e) { existing = []; }

    let deduped = false;
    if (existing.length > 0 && expectedHash && actualHash && dedupeWindowMs > 0) {
      for (let i = existing.length - 1; i >= 0; i--) {
        try {
          const last = JSON.parse(existing[i]);
          if (!last) break;
          const lastTs = last.ts ? new Date(last.ts).getTime() : 0;
          if (!lastTs || (now - lastTs) > dedupeWindowMs) break;
          if (last.expected_hash === expectedHash && last.actual_hash === actualHash) {
            deduped = true;
            break;
          }
        } catch (_e) { /* skip malformed */ }
      }
    }

    if (!deduped) {
      const entry = {
        ts: new Date(now).toISOString(),
        expected_hash: expectedHash,
        actual_hash:   actualHash,
      };
      atomicAppendJsonl(violPath, entry);
    }

    let count = 0;
    try {
      const raw = fs.readFileSync(violPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const ts = parsed && parsed.ts ? new Date(parsed.ts).getTime() : 0;
          if (ts >= windowStart) count++;
        } catch (_e) {}
      }
    } catch (_e) { count = 1; }

    return { count: count || 1, deduped };
  } catch (_e) {
    return { count: 1, deduped: false };
  }
}

// ---------------------------------------------------------------------------
// Audit event helper
// ---------------------------------------------------------------------------

function emitAuditEvent(cwd, eventType, extra) {
  try {
    const auditDir   = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) {}

    const entry = Object.assign(
      { version: 1, timestamp: new Date().toISOString(), type: eventType, orchestration_id: orchestrationId },
      extra
    );
    writeEvent(entry, { cwd });
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Zone 1 hash recomputation (must match compose-block-a.js buildZone1)
// ---------------------------------------------------------------------------

/**
 * Recompute Zone 1 hash from current source files on disk.
 *
 * v2.2.1 W2: also returns `fileHashes` (per-file SHA-256) so the validator
 * computes a true `delta_files` (only the paths whose individual sha
 * changed) by diffing against the persisted `zone1_file_hashes` map.
 *
 * v2.2.3 P0-2: schema shadow is EXCLUDED from the invariant hash. Shadow
 * is a derived artifact (regenerated from `event-schemas.md` on every
 * release that adds an event type) — including it caused 38+ false
 * `cache_invariant_broken` self-trips per release and a 24h cache disable
 * (see `.orchestray/kb/artifacts/v223-telemetry-token-savings.md`). Cache
 * prefix continues to include shadow content via `compose-block-a.js` —
 * only the invariant tracking is decoupled. Shadow content drift is
 * surfaced via the separate `cache_zone_shadow_regen_observed` event so
 * release tooling stays observable.
 *
 * @param {string} cwd
 * @returns {{ hash: string, hashedFiles: string[], fileHashes: Record<string,string>, shadowHash: (string|null) }}
 */
function recomputeZone1Hash(cwd) {
  const parts       = [];
  const hashedFiles = [];
  const fileHashes  = {};

  for (const relPath of ZONE1_SOURCES) {
    try {
      const absPath = path.join(cwd, relPath);
      const text    = fs.readFileSync(absPath, 'utf8');
      parts.push('<!-- zone1:file:' + relPath + ' -->\n' + text);
      hashedFiles.push(relPath);
      fileHashes[relPath] = crypto.createHash('sha256').update(text).digest('hex');
    } catch (_e) {}
  }

  // v2.2.3 P0-2: shadow is loaded ONLY for telemetry (cache_zone_shadow_regen_observed).
  // It is NOT folded into the invariant hash — see function header above.
  let shadowHash = null;
  try {
    const { shadow, stale, disabled } = loadShadowWithCheck(cwd, {
      envDisabled:    process.env.ORCHESTRAY_DISABLE_SCHEMA_SHADOW === '1',
      configDisabled: false,
    });
    if (!disabled && !stale && shadow) {
      const eventTypes = Object.keys(shadow).filter(k => k !== '_meta');
      const shadowLine = JSON.stringify(shadow);
      const shadowContent = [
        '<!-- zone1:file:agents/pm-reference/event-schemas.shadow.json -->',
        '<event-schema-shadow>',
        'Schema shadow (v=' + (shadow._meta && shadow._meta.version || '?') +
          ', n=' + eventTypes.length + '): ' + shadowLine,
        'Shadow path: agents/pm-reference/event-schemas.shadow.json',
        'Full schema fallback: agents/pm-reference/event-schemas.md (load on miss)',
        '</event-schema-shadow>',
      ].join('\n');
      shadowHash = crypto.createHash('sha256').update(shadowContent).digest('hex');
    }
  } catch (_e) {}

  const content = parts.join('\n\n');
  const hash    = crypto.createHash('sha256').update(content).digest('hex');
  return { hash, hashedFiles, fileHashes, shadowHash };
}

/**
 * Compute the changed-file subset given current and previous per-file hashes.
 * Falls back to the full hashed set when no prior map exists (preserving
 * pre-v2.2.1 reporting behaviour for installs whose block-a-zones.json was
 * written before this release).
 */
function computeDeltaFiles(current, previous, hashedFiles) {
  if (!previous || typeof previous !== 'object') return hashedFiles.slice();
  const delta = [];
  for (const k of hashedFiles) {
    if (current[k] !== previous[k]) delta.push(k);
  }
  for (const k of Object.keys(previous)) {
    if (!(k in current)) delta.push(k);
  }
  return delta;
}

// ---------------------------------------------------------------------------
// Load stored zone hashes
// ---------------------------------------------------------------------------

function loadStoredHashes(cwd) {
  try {
    const zonesPath = path.join(cwd, STATE_DIR, ZONES_FILE);
    const raw       = fs.readFileSync(zonesPath, 'utf8');
    const parsed    = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

/**
 * v2.2.3 P0-2: opportunistically persist the current shadow hash to
 * `block-a-zones.json` under `zone1_shadow_hash` (additive field — does
 * NOT touch `zone1_hash` or `zone1_file_hashes`). Emits no event;
 * caller emits `cache_zone_shadow_regen_observed` separately when drift
 * is observed. Safe no-op on any I/O error.
 */
function maybeRefreshShadowHash(cwd, stored, shadowHash) {
  if (!shadowHash) return false;
  if (stored && stored.zone1_shadow_hash === shadowHash) return false;
  try {
    const stateDir  = path.join(cwd, STATE_DIR);
    const zonesPath = path.join(stateDir, ZONES_FILE);
    fs.mkdirSync(stateDir, { recursive: true });
    const next = Object.assign({}, stored || {}, {
      zone1_shadow_hash:        shadowHash,
      zone1_shadow_updated_at:  new Date().toISOString(),
    });
    const tmp = zonesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    try { fs.renameSync(tmp, zonesPath); }
    catch (_e) { fs.writeFileSync(zonesPath, JSON.stringify(next, null, 2) + '\n', 'utf8'); }
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    if (process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1') {
      process.exit(0);
      return;
    }

    const cfg = loadBlockAConfig(cwd);
    if (cfg.enabled === false) {
      process.exit(0);
      return;
    }

    // v2.2.1 W2: isSentinelActive() now treats bare-string and TTL-expired
    // sentinels as INACTIVE. The fast-path early-exits only on a still-active
    // (parsed JSON, future expires_at OR quarantined) sentinel.
    if (isSentinelActive(cwd)) {
      process.exit(0);
      return;
    }

    const stored = loadStoredHashes(cwd);
    if (!stored || !stored.zone1_hash) {
      process.exit(0);
      return;
    }

    const { hash: currentHash, hashedFiles, fileHashes, shadowHash } = recomputeZone1Hash(cwd);

    // v2.2.3 P0-2: emit informational shadow-drift event when shadow content
    // hash differs from last-seen. Decoupled from the invariant so a shadow
    // regen never trips zone-1, but release tooling stays observable.
    if (shadowHash && stored.zone1_shadow_hash && shadowHash !== stored.zone1_shadow_hash) {
      emitAuditEvent(cwd, 'cache_zone_shadow_regen_observed', {
        zone:                'zone1',
        previous_shadow_hash: stored.zone1_shadow_hash.substring(0, 12),
        current_shadow_hash:  shadowHash.substring(0, 12),
        note: 'shadow regen excluded from zone-1 invariant per v2.2.3 P0-2',
      });
    }

    if (currentHash === stored.zone1_hash) {
      // Zone 1 stable — opportunistically clean a legacy/expired sentinel.
      // Also opportunistically refresh the persisted shadow hash so future
      // shadow-drift telemetry is accurate (additive — does NOT touch
      // zone1_hash).
      clearStaleSentinelIfAny(cwd, cfg);
      maybeRefreshShadowHash(cwd, stored, shadowHash);
      process.exit(0);
      return;
    }

    // True per-file delta (against persisted zone1_file_hashes if present).
    const deltaFiles = computeDeltaFiles(fileHashes, stored.zone1_file_hashes, hashedFiles);

    // Auto-rebaseline path. If every delta path is in the user-editable
    // allowlist, overwrite block-a-zones.json with the current hash and
    // emit cache_baseline_refreshed instead of cache_invariant_broken.
    const onlyAllowed = deltaFiles.length > 0 &&
      deltaFiles.every(f => AUTO_REBASELINE_ALLOWLIST.has(f));
    if (cfg.auto_rebaseline_enabled && onlyAllowed) {
      try {
        const stateDir  = path.join(cwd, STATE_DIR);
        const zonesPath = path.join(stateDir, ZONES_FILE);
        fs.mkdirSync(stateDir, { recursive: true });
        const next = Object.assign({}, stored, {
          zone1_hash:         currentHash,
          zone1_file_hashes:  fileHashes,
          updated_at:         new Date().toISOString(),
          last_rebaseline_at: new Date().toISOString(),
        });
        // v2.2.3 P0-2: keep shadow telemetry hash fresh on rebaseline.
        if (shadowHash) {
          next.zone1_shadow_hash       = shadowHash;
          next.zone1_shadow_updated_at = new Date().toISOString();
        }
        const tmp = zonesPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
        fs.renameSync(tmp, zonesPath);
      } catch (_e) {}
      emitAuditEvent(cwd, 'cache_baseline_refreshed', {
        zone:          'zone1',
        expected_hash: stored.zone1_hash.substring(0, 12),
        actual_hash:   currentHash.substring(0, 12),
        delta_files:   deltaFiles,
        reason:        'editable_zone1_drift',
      });
      process.exit(0);
      return;
    }

    // Either auto_rebaseline disabled, or delta includes a non-editable file
    // (e.g., the schema shadow). Treat as a real violation.
    const { count: violationCount, deduped } = recordViolationAndCount(cwd, {
      expectedHash:        stored.zone1_hash.substring(0, 12),
      actualHash:          currentHash.substring(0, 12),
      dedupeWindowSeconds: cfg.dedupe_window_seconds,
    });
    const threshold = cfg.invariant_violation_threshold_24h || 5;

    emitAuditEvent(cwd, 'cache_invariant_broken', {
      zone:          'zone1',
      expected_hash: stored.zone1_hash.substring(0, 12),
      actual_hash:   currentHash.substring(0, 12),
      delta_files:   deltaFiles,
      deduped:       deduped === true,
    });

    process.stderr.write(
      '[validate-cache-invariant] cache_invariant_broken: zone1 hash changed ' +
      '(was ' + stored.zone1_hash.substring(0, 8) + ', now ' +
      currentHash.substring(0, 8) + '). ' +
      'Run node bin/invalidate-block-a-zone1.js to refresh.\n'
    );

    if (!deduped && violationCount >= threshold) {
      const result = writeSentinel(cwd, cfg, {
        reason:        'invariant_violation_threshold_exceeded',
        recovery_hint: 'sentinel auto-clears after ' +
                       (cfg.sentinel_ttl_hours || DEFAULT_SENTINEL_TTL_HOURS) +
                       'h; or run: node bin/invalidate-block-a-zone1.js',
      });
      process.stderr.write(
        '[validate-cache-invariant] auto-disabled block_a_zone_caching: ' +
        violationCount + ' violations in 24h (threshold=' + threshold +
        ', trip=' + result.trip_count +
        (result.quarantined ? ', QUARANTINED' : '') + ').\n'
      );
    }

    process.exit(0);
  } catch (_e) {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// P2.1 (v2.2.0) manifest invariant — UserPromptSubmit-mounted check
// ---------------------------------------------------------------------------

const HEX_64_RE = /^[0-9a-f]{64}$/;
const VALID_TTLS = new Set(['1h', '5m']);

function recomputeManifestInvariant(cwd) {
  const manifestPath = path.join(cwd, STATE_DIR, MANIFEST_FILE);
  let manifest;
  try {
    if (!fs.existsSync(manifestPath)) {
      return { valid: false, reason: 'manifest_missing', manifest: null };
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (_e) {
    return { valid: false, reason: 'manifest_missing', manifest: null };
  }
  if (!manifest || !Array.isArray(manifest.slots)) {
    return { valid: false, reason: 'slot_count_mismatch', manifest };
  }
  const slots = manifest.slots;
  if (slots.length !== 4) {
    return { valid: false, reason: 'slot_count_mismatch', manifest };
  }
  for (let i = 0; i < 4; i++) {
    const s = slots[i] || {};
    if (s.slot !== i + 1) return { valid: false, reason: 'slot_count_mismatch', manifest };
    if (!VALID_TTLS.has(s.ttl)) return { valid: false, reason: 'invalid_ttl', manifest };
    if (typeof s.marker_byte_offset !== 'number' || s.marker_byte_offset < 0) {
      return { valid: false, reason: 'non_monotonic_offsets', manifest };
    }
    if (i > 0 && s.marker_byte_offset < slots[i - 1].marker_byte_offset) {
      return { valid: false, reason: 'non_monotonic_offsets', manifest };
    }
    if (typeof s.prefix_hash !== 'string' || !HEX_64_RE.test(s.prefix_hash)) {
      return { valid: false, reason: 'invalid_hash', manifest };
    }
    if (typeof s.prefix_token_estimate !== 'number' || s.prefix_token_estimate < 0 || !Number.isFinite(s.prefix_token_estimate)) {
      return { valid: false, reason: 'invalid_hash', manifest };
    }
  }
  return { valid: true, reason: null, manifest };
}

function handleManifestMode(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    if (process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1') { process.exit(0); return; }
    if (process.env.ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS === '1') { process.exit(0); return; }

    const cfg = loadBlockAConfig(cwd);
    if (cfg.enabled === false) { process.exit(0); return; }
    if (isSentinelActive(cwd)) { process.exit(0); return; }

    let strictInvariant = false;
    let breakpointsEnabled = true;
    try {
      const configPath = path.join(cwd, '.orchestray', 'config.json');
      const parsed     = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && parsed.caching && parsed.caching.engineered_breakpoints) {
        if (typeof parsed.caching.engineered_breakpoints.enabled === 'boolean') {
          breakpointsEnabled = parsed.caching.engineered_breakpoints.enabled;
        }
        if (typeof parsed.caching.engineered_breakpoints.strict_invariant === 'boolean') {
          strictInvariant = parsed.caching.engineered_breakpoints.strict_invariant;
        }
      }
    } catch (_e) { /* defaults */ }

    if (breakpointsEnabled === false) { process.exit(0); return; }

    const result = recomputeManifestInvariant(cwd);
    if (result.valid) {
      process.exit(0);
      return;
    }

    // v2.2.2 Fix A1: `manifest_missing` on the first UserPromptSubmit after a
    // fresh install is a cold-start bootstrap, NOT an invariant violation —
    // `bin/compose-block-a.js` is the sole writer of cache-breakpoint-manifest.json
    // and runs in the SAME UserPromptSubmit batch (slot AFTER this validator,
    // see hooks/hooks.json). Emit a distinct `cache_manifest_bootstrap` info
    // event so the bootstrap path remains visible (and counted) without
    // polluting the `cache_invariant_broken` rollup with non-violations.
    if (result.reason === 'manifest_missing') {
      emitAuditEvent(cwd, 'cache_manifest_bootstrap', {
        slot_count_expected: 4,
        note: 'compose-block-a will seed manifest in same UserPromptSubmit batch',
      });
      process.exit(0);
      return;
    }

    emitAuditEvent(cwd, 'cache_invariant_broken', {
      zone:          'manifest',
      reason:        result.reason,
      expected_hash: 'manifest',
      actual_hash:   result.reason,
      delta_files:   [],
    });

    if (strictInvariant && result.reason !== 'manifest_missing') {
      process.stderr.write(
        '[validate-cache-invariant] manifest invariant broken (' + result.reason +
        '). Run: node bin/invalidate-block-a-zone1.js --watch-pm-md\n'
      );
      process.exit(2);
      return;
    }
    process.exit(0);
  } catch (_e) {
    process.exit(0);
  }
}

// Expose helpers for tests (W5 owns the test suite).
module.exports = {
  recomputeManifestInvariant,
  // v2.2.1 W2 self-healing surface
  loadBlockAConfig,
  isSentinelActive,
  parseSentinelBody,
  writeSentinel,
  clearStaleSentinelIfAny,
  recordViolationAndCount,
  recomputeZone1Hash,
  computeDeltaFiles,
  AUTO_REBASELINE_ALLOWLIST,
  DEFAULT_DEDUPE_WINDOW_SECONDS,
  DEFAULT_SENTINEL_TTL_HOURS,
  DEFAULT_QUARANTINE_TRIP_THRESHOLD,
  // v2.2.3 P0-2 shadow-decoupling surface
  maybeRefreshShadowHash,
  loadStoredHashes,
};
