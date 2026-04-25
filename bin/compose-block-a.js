#!/usr/bin/env node
'use strict';

/**
 * compose-block-a.js — UserPromptSubmit hook (R-PIN, v2.1.14).
 *
 * Composes Block A into three zones with explicit zone boundary markers.
 * Each zone is delimited by XML-style tags that signal caching intent to
 * the PM orchestrator.
 *
 * Zone 1 (frozen, 1h TTL intent):
 *   CLAUDE.md + handoff-contract.md + static skills list + schema shadow
 *
 * Zone 2 (per-orch-pinned, 1h TTL intent):
 *   orchestration header (id, goal, constraints)
 *
 * Zone 3 (mutable, no cache):
 *   session banners, turn-scoped context
 *
 * Note on cache_control: Claude Code's additionalContext hook output is a
 * plain text string. The Messages API cache_control markers are not available
 * here. Zone markers are emitted as XML boundary tags that establish the zone
 * discipline for PM prompt assembly. See block-a-contract.md §6.
 *
 * Kill switches (any one → no-op):
 *   - process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1'
 *   - config.block_a_zone_caching.enabled === false
 *   - sentinel: .orchestray/state/.block-a-zone-caching-disabled exists
 *
 * On success: emits hookSpecificOutput.additionalContext with the zone text.
 * On no-op or any error: exits 0 with no output (fail-open).
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: JSON on stdout with hookSpecificOutput.additionalContext, or exit 0.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { loadShadowWithCheck } = require('./_lib/load-schema-shadow');
const { writeEvent } = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

const STATE_DIR       = path.join('.orchestray', 'state');
const ZONES_FILE      = 'block-a-zones.json';
const SENTINEL_FILE   = '.block-a-zone-caching-disabled';

// Zone 1 source files relative to project root
const ZONE1_SOURCES = [
  'CLAUDE.md',
  'agents/pm-reference/handoff-contract.md',
  // v2.1.15 W8: phase-contract.md joins Zone 1 — always-loaded foundation for
  // the I-PHASE-GATE phase-slice split.
  'agents/pm-reference/phase-contract.md',
];

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE + '\n');
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[compose-block-a] stdin exceeded limit; skipping\n');
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    handle(JSON.parse(input || '{}'));
  } catch (_e) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load block_a_zone_caching config block.
 * @param {string} cwd
 * @returns {{ enabled: boolean, invariant_violation_threshold_24h: number }}
 */
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
// Sentinel check
// ---------------------------------------------------------------------------

function isSentinelActive(cwd) {
  return fs.existsSync(path.join(cwd, STATE_DIR, SENTINEL_FILE));
}

// ---------------------------------------------------------------------------
// Audit event helper
// ---------------------------------------------------------------------------

function emitAuditEvent(cwd, eventType, extra) {
  try {
    const entry = Object.assign({ version: 1, type: eventType }, extra);
    writeEvent(entry, { cwd });
  } catch (_e) {
    // Fail-open
  }
}

// ---------------------------------------------------------------------------
// Zone builders
// ---------------------------------------------------------------------------

/**
 * Build Zone 1 content (frozen). Reads CLAUDE.md, handoff-contract.md,
 * and the schema shadow (if present and valid).
 *
 * @param {string} cwd
 * @returns {{ content: string, hash: string, bytes: number }}
 */
function buildZone1(cwd) {
  const parts = [];

  // Core source files
  for (const relPath of ZONE1_SOURCES) {
    try {
      const absPath = path.join(cwd, relPath);
      const text    = fs.readFileSync(absPath, 'utf8');
      parts.push('<!-- zone1:file:' + relPath + ' -->\n' + text);
    } catch (_e) {
      // File missing — skip gracefully
    }
  }

  // Schema shadow (R-SHDW content joins Zone 1 when present and non-stale)
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
    }
  } catch (_e) {
    // Schema shadow load failure — skip gracefully
  }

  const content = parts.join('\n\n');
  const hash    = crypto.createHash('sha256').update(content).digest('hex');
  return { content, hash, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Build Zone 2 content (per-orch-pinned). Reads orchestration header.
 *
 * @param {string} cwd
 * @returns {{ content: string, hash: string, bytes: number }}
 */
function buildZone2(cwd) {
  const parts = [];

  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    if (orchData) {
      const header = {
        orchestration_id: orchData.orchestration_id || 'unknown',
        goal:             orchData.goal             || orchData.task_description || '',
        constraints:      orchData.constraints      || [],
      };
      parts.push(
        '<!-- zone2:orchestration-header -->\n' +
        '<orchestration-header>\n' +
        JSON.stringify(header, null, 2) + '\n' +
        '</orchestration-header>'
      );

      // Decomposition summary if present
      if (orchData.decomposition_summary) {
        parts.push(
          '<!-- zone2:decomposition-summary -->\n' +
          '<decomposition-summary>\n' +
          orchData.decomposition_summary + '\n' +
          '</decomposition-summary>'
        );
      }
    }
  } catch (_e) {
    // No active orchestration — Zone 2 is empty
  }

  const content = parts.join('\n\n');
  const hash    = content
    ? crypto.createHash('sha256').update(content).digest('hex')
    : 'empty';
  return { content, hash, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Build Zone 3 content (mutable, no cache). Minimal per-turn metadata.
 *
 * @param {string} cwd
 * @returns {{ content: string, bytes: number }}
 */
function buildZone3(cwd) {
  // Zone 3 is managed by other hooks (resilience dossier, archetype advisory,
  // schema shadow injection). compose-block-a emits a minimal structural marker.
  const ts      = new Date().toISOString();
  const content = '<!-- zone3:mutable turn=' + ts + ' -->';
  return { content, bytes: Buffer.byteLength(content, 'utf8') };
}

// ---------------------------------------------------------------------------
// Zones state persistence
// ---------------------------------------------------------------------------

/**
 * Persist zone hashes to .orchestray/state/block-a-zones.json.
 * @param {string} cwd
 * @param {string} zone1Hash
 * @param {string} zone2Hash
 */
function saveZoneHashes(cwd, zone1Hash, zone2Hash) {
  try {
    const stateDir   = path.join(cwd, STATE_DIR);
    const zonesPath  = path.join(stateDir, ZONES_FILE);
    fs.mkdirSync(stateDir, { recursive: true });
    const data = {
      zone1_hash: zone1Hash,
      zone2_hash: zone2Hash,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(zonesPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (_e) {
    // Fail-open
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Kill switch: env var
    if (process.env.ORCHESTRAY_DISABLE_BLOCK_A_ZONES === '1') {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    // Kill switch: config
    const cfg = loadBlockAConfig(cwd);
    if (cfg.enabled === false) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    // Kill switch: auto-disable sentinel
    if (isSentinelActive(cwd)) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    // Build zones
    const zone1 = buildZone1(cwd);
    const zone2 = buildZone2(cwd);
    const zone3 = buildZone3(cwd);

    // Save hashes for the invariant validator
    saveZoneHashes(cwd, zone1.hash, zone2.hash);

    // Assemble the additionalContext payload
    const sections = [];

    sections.push(
      '<block-a-zone-1 cache_hint="stable-1h">\n' +
      zone1.content + '\n' +
      '</block-a-zone-1>'
    );

    if (zone2.content) {
      sections.push(
        '<block-a-zone-2 cache_hint="per-orch-1h">\n' +
        zone2.content + '\n' +
        '</block-a-zone-2>'
      );
    }

    sections.push(
      '<block-a-zone-3 cache_hint="mutable">\n' +
      zone3.content + '\n' +
      '</block-a-zone-3>'
    );

    const additionalContext = sections.join('\n\n');

    // Determine orchestration_id for audit event
    let orchestrationId = 'unknown';
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      if (orchData && orchData.orchestration_id) orchestrationId = orchData.orchestration_id;
    } catch (_e) {}

    // Emit block_a_zone_composed audit event
    emitAuditEvent(cwd, 'block_a_zone_composed', {
      orchestration_id:  orchestrationId,
      turn_number:       null,
      zone1_hash:        zone1.hash,
      zone2_hash:        zone2.hash,
      zone3_bytes:       zone3.bytes,
      cache_breakpoints: 3,
    });

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName:     'UserPromptSubmit',
        additionalContext,
      },
    });

    process.stdout.write(output + '\n');
    process.exit(0);

  } catch (_e) {
    // Fail-open
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
}
