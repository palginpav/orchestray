#!/usr/bin/env node
'use strict';

/**
 * validate-cache-invariant.js — PreToolUse hook (R-PIN, v2.1.14).
 *
 * On every tool call, recomputes Zone 1's hash from current source files and
 * compares against the stored hash in .orchestray/state/block-a-zones.json.
 *
 * If the hash differs:
 *   - Emits a cache_invariant_broken audit event with the delta.
 *   - Increments a 24h violation counter.
 *   - If violations >= threshold in 24h, writes auto-disable sentinel.
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
 *   mode, a malformed manifest exits 2. v2.2.0 ships strict_invariant=false
 *   for safety (UserPromptSubmit exit-2 hard-blocks the user typing); v2.2.1
 *   may flip the default after telemetry confirms zero false positives.
 *
 * Kill switches (any one → no-op):
 *   - process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1'
 *   - config.block_a_zone_caching.enabled === false
 *   - sentinel: .orchestray/state/.block-a-zone-caching-disabled exists
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
// atomicAppendJsonl is retained for the non-events.jsonl violations file (line 127);
// events.jsonl emissions now route through the central audit-event gateway.
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { writeEvent }        = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

const STATE_DIR        = path.join('.orchestray', 'state');
const ZONES_FILE       = 'block-a-zones.json';
const VIOLATIONS_FILE  = 'block-a-zone-violations.jsonl';
const SENTINEL_FILE    = '.block-a-zone-caching-disabled';
const MANIFEST_FILE    = 'cache-breakpoint-manifest.json';
const VIOLATION_WINDOW = 24 * 60 * 60 * 1000; // 24 hours in ms

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
  const defaults = { enabled: true, invariant_violation_threshold_24h: 5 };
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const raw    = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const block = parsed.block_a_zone_caching;
    if (!block || typeof block !== 'object' || Array.isArray(block)) return defaults;
    return Object.assign({}, defaults, block);
  } catch (_e) {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

function isSentinelActive(cwd) {
  return fs.existsSync(path.join(cwd, STATE_DIR, SENTINEL_FILE));
}

function writeSentinel(cwd) {
  try {
    const stateDir = path.join(cwd, STATE_DIR);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, SENTINEL_FILE),
      'auto-disabled by validate-cache-invariant.js at ' + new Date().toISOString() + '\n',
      'utf8'
    );
  } catch (_e) {}
}

// ---------------------------------------------------------------------------
// Violation counter
// ---------------------------------------------------------------------------

/**
 * Record a violation and return the count of violations within the window.
 * @param {string} cwd
 * @returns {number} violations in last 24h including this one
 */
function recordViolationAndCount(cwd) {
  try {
    const stateDir     = path.join(cwd, STATE_DIR);
    const violPath     = path.join(stateDir, VIOLATIONS_FILE);
    const now          = Date.now();
    const windowStart  = now - VIOLATION_WINDOW;

    fs.mkdirSync(stateDir, { recursive: true });

    // Append this violation
    const entry = { ts: new Date(now).toISOString() };
    atomicAppendJsonl(violPath, entry);

    // Count recent violations
    try {
      const raw   = fs.readFileSync(violPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      let count   = 0;
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          const ts = parsed && parsed.ts ? new Date(parsed.ts).getTime() : 0;
          if (ts >= windowStart) count++;
        } catch (_e) {}
      }
      return count;
    } catch (_e) {
      return 1;
    }
  } catch (_e) {
    return 1;
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
 * @param {string} cwd
 * @returns {{ hash: string, deltaFiles: string[] }}
 *   hash: the recomputed hash
 *   deltaFiles: files that were hashed (for diff reporting)
 */
function recomputeZone1Hash(cwd) {
  const parts      = [];
  const deltaFiles = [];

  for (const relPath of ZONE1_SOURCES) {
    try {
      const absPath = path.join(cwd, relPath);
      const text    = fs.readFileSync(absPath, 'utf8');
      parts.push('<!-- zone1:file:' + relPath + ' -->\n' + text);
      deltaFiles.push(relPath);
    } catch (_e) {}
  }

  // Schema shadow (must match compose-block-a.js logic)
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
      parts.push(shadowContent);
      deltaFiles.push('agents/pm-reference/event-schemas.shadow.json');
    }
  } catch (_e) {}

  const content = parts.join('\n\n');
  const hash    = crypto.createHash('sha256').update(content).digest('hex');
  return { hash, deltaFiles };
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

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Kill switches
    if (process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1') {
      process.exit(0);
      return;
    }

    const cfg = loadBlockAConfig(cwd);
    if (cfg.enabled === false) {
      process.exit(0);
      return;
    }

    if (isSentinelActive(cwd)) {
      process.exit(0);
      return;
    }

    // Load stored hashes
    const stored = loadStoredHashes(cwd);
    if (!stored || !stored.zone1_hash) {
      // No baseline yet — nothing to compare
      process.exit(0);
      return;
    }

    // Recompute Zone 1 hash
    const { hash: currentHash, deltaFiles } = recomputeZone1Hash(cwd);

    if (currentHash === stored.zone1_hash) {
      // Zone 1 is stable
      process.exit(0);
      return;
    }

    // Zone 1 hash mismatch — emit advisory event
    const violationCount = recordViolationAndCount(cwd);
    const threshold      = cfg.invariant_violation_threshold_24h || 5;

    emitAuditEvent(cwd, 'cache_invariant_broken', {
      zone:          'zone1',
      expected_hash: stored.zone1_hash.substring(0, 12),
      actual_hash:   currentHash.substring(0, 12),
      delta_files:   deltaFiles,
    });

    process.stderr.write(
      '[compose-block-a] cache_invariant_broken: zone1 hash changed ' +
      '(was ' + stored.zone1_hash.substring(0, 8) + ', now ' +
      currentHash.substring(0, 8) + '). ' +
      'Run node bin/invalidate-block-a-zone1.js to refresh.\n'
    );

    // Auto-disable if threshold exceeded
    if (violationCount >= threshold) {
      writeSentinel(cwd);
      process.stderr.write(
        '[compose-block-a] auto-disabled block_a_zone_caching: ' +
        violationCount + ' violations in 24h (threshold=' + threshold + ').\n'
      );
    }

    // Exit 0 — advisory only, never blocks
    process.exit(0);

  } catch (_e) {
    // Fail-open
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// P2.1 (v2.2.0) manifest invariant — UserPromptSubmit-mounted check
// ---------------------------------------------------------------------------

const HEX_64_RE = /^[0-9a-f]{64}$/;
const VALID_TTLS = new Set(['1h', '5m']);

/**
 * Validate the persisted 4-slot manifest. Returns { valid, reason }.
 *
 * @param {string} cwd
 * @returns {{ valid: boolean, reason: string|null, manifest: object|null }}
 */
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

/**
 * UserPromptSubmit handler for manifest invariant. Advisory by default;
 * exits 2 only when caching.engineered_breakpoints.strict_invariant === true.
 */
function handleManifestMode(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Kill switches: same suite as Zone 1 advisory, plus the caching.* knobs.
    if (process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1') { process.exit(0); return; }
    if (process.env.ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS === '1') { process.exit(0); return; }

    const cfg = loadBlockAConfig(cwd);
    if (cfg.enabled === false) { process.exit(0); return; }
    if (isSentinelActive(cwd)) { process.exit(0); return; }

    // Read engineered_breakpoints.* knobs from config (this loader does NOT
    // include them — read raw config to avoid duplicating logic).
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

    // Emit the cache_invariant_broken event with zone='manifest' + reason.
    emitAuditEvent(cwd, 'cache_invariant_broken', {
      zone:          'manifest',
      reason:        result.reason,
      expected_hash: 'manifest',
      actual_hash:   result.reason,
      delta_files:   [],
    });

    // Strict mode: exit 2 (blocks user prompt). Default: exit 0 (advisory).
    // Manifest-missing is ALWAYS advisory regardless of strict mode — the
    // first turn after a fresh install legitimately has no manifest yet.
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
    // Fail-open — never block the user prompt on internal errors.
    process.exit(0);
  }
}

// Expose manifest helpers for tests.
module.exports = {
  recomputeManifestInvariant,
};
