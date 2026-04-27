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
// P2.1 (v2.2.0): Block-Z + 4-slot cache-breakpoint manifest.
const { buildBlockZ }    = require('./_lib/block-z');
const { buildManifest }  = require('./_lib/cache-breakpoint-manifest');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

const STATE_DIR       = path.join('.orchestray', 'state');
const ZONES_FILE      = 'block-a-zones.json';
const SENTINEL_FILE   = '.block-a-zone-caching-disabled';
const MANIFEST_FILE   = 'cache-breakpoint-manifest.json';

// P3.1 (v2.2.0): audit-round digest sidecar + inline-body byte cap.
// `archiveRound()` writes here; buildZone2 reads it to substitute the
// per-round verbatim transcript subsection with an XML-tagged digest
// pointer block. Default cap = 3 KB (≤ 0.10 ratio target preserved).
const AUDIT_ROUND_ARCHIVE_SIDECAR = path.join('.orchestray', 'state', 'audit-round-archive.json');
const DEFAULT_AUDIT_ROUND_INLINE_MAX_BYTES = 3072;

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
if (require.main === module) {
  // CLI mode — wire stdin only when invoked as a script. Skipping when
  // require()'d makes the module unit-testable (p3-fixpass-hardening §S-005).
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
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load block_a_zone_caching config block.
 * @param {string} cwd
 * @returns {{ enabled: boolean, invariant_violation_threshold_24h: number }}
 */
function loadBlockAConfig(cwd) {
  const defaults = {
    enabled: true,
    invariant_violation_threshold_24h: 5,
    // P2.1 (v2.2.0) defaults — kept on this object so the kill-switch
    // surface is a single struct. `caching.*` is the canonical config path;
    // this loader merges those values under flat keys for readability.
    block_z_enabled: true,
    engineered_breakpoints_enabled: true,
    engineered_breakpoints_strict_invariant: false,
  };
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const raw    = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;

    const out = Object.assign({}, defaults);

    // Existing block_a_zone_caching block (kept for back-compat).
    const block = parsed.block_a_zone_caching;
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      Object.assign(out, block);
    }

    // P2.1 caching block (new in v2.2.0).
    const caching = parsed.caching;
    if (caching && typeof caching === 'object' && !Array.isArray(caching)) {
      if (caching.block_z && typeof caching.block_z === 'object') {
        if (typeof caching.block_z.enabled === 'boolean') out.block_z_enabled = caching.block_z.enabled;
      }
      if (caching.engineered_breakpoints && typeof caching.engineered_breakpoints === 'object') {
        if (typeof caching.engineered_breakpoints.enabled === 'boolean') {
          out.engineered_breakpoints_enabled = caching.engineered_breakpoints.enabled;
        }
        if (typeof caching.engineered_breakpoints.strict_invariant === 'boolean') {
          out.engineered_breakpoints_strict_invariant = caching.engineered_breakpoints.strict_invariant;
        }
      }
    }
    return out;
  } catch (_e) {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// Sentinel check (v2.2.1 W2 — TTL + structured body)
//
// Mirrors `bin/validate-cache-invariant.js` parseSentinelBody / isSentinelActive.
// Bare-string and TTL-expired sentinels are treated as INACTIVE so installed
// users self-heal on the first UserPromptSubmit after v2.2.1 ships. The
// stale file is best-effort unlinked here so subsequent reads don't repeat
// the work.
// ---------------------------------------------------------------------------

function _parseSentinelBody(raw) {
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

function isSentinelActive(cwd) {
  const sentinelPath = path.join(cwd, STATE_DIR, SENTINEL_FILE);
  if (!fs.existsSync(sentinelPath)) return false;
  let raw = null;
  try { raw = fs.readFileSync(sentinelPath, 'utf8'); } catch (_e) { return false; }
  const parsed = _parseSentinelBody(raw);
  if (!parsed) {
    try { fs.unlinkSync(sentinelPath); } catch (_e) {}
    return false;
  }
  if (parsed.quarantined === true) return true;
  const expiresAt = parsed.expires_at ? new Date(parsed.expires_at).getTime() : 0;
  if (!expiresAt || isNaN(expiresAt)) return false;
  if (expiresAt <= Date.now()) {
    try { fs.unlinkSync(sentinelPath); } catch (_e) {}
    return false;
  }
  return true;
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
 * v2.2.1 W2: also returns per-file SHA-256s so saveZoneHashes can persist
 * `zone1_file_hashes` for the validator's true delta-files computation.
 *
 * @param {string} cwd
 * @returns {{ content: string, hash: string, bytes: number, fileHashes: Record<string,string> }}
 */
function buildZone1(cwd) {
  const parts = [];
  const fileHashes = {};

  // Core source files
  for (const relPath of ZONE1_SOURCES) {
    try {
      const absPath = path.join(cwd, relPath);
      const text    = fs.readFileSync(absPath, 'utf8');
      parts.push('<!-- zone1:file:' + relPath + ' -->\n' + text);
      fileHashes[relPath] = crypto.createHash('sha256').update(text).digest('hex');
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
      fileHashes['agents/pm-reference/event-schemas.shadow.json'] =
        crypto.createHash('sha256').update(shadowContent).digest('hex');
    }
  } catch (_e) {
    // Schema shadow load failure — skip gracefully
  }

  const content = parts.join('\n\n');
  const hash    = crypto.createHash('sha256').update(content).digest('hex');
  return { content, hash, bytes: Buffer.byteLength(content, 'utf8'), fileHashes };
}

// ---------------------------------------------------------------------------
// P3.1 (v2.2.0): audit-round archive helpers for buildZone2.
// ---------------------------------------------------------------------------

/**
 * Load the audit-round archive sidecar for the given orchestration. Returns
 * the array of round-archive entries (may be empty). Fail-open: any read
 * or parse error returns []. Honours the env kill switch (env=1 → []) and
 * the audit.round_archive.enabled config flag.
 */
function loadAuditRoundArchives(cwd, orchestrationId) {
  if (process.env.ORCHESTRAY_DISABLE_AUDIT_ROUND_ARCHIVE === '1') return [];
  try {
    const cfgRaw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const cfgParsed = JSON.parse(cfgRaw);
    const block = cfgParsed && cfgParsed.audit && cfgParsed.audit.round_archive;
    if (block && block.enabled === false) return [];
  } catch (_e) { /* defaults apply */ }
  try {
    const raw = fs.readFileSync(path.join(cwd, AUDIT_ROUND_ARCHIVE_SIDECAR), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.archives)) return [];
    return parsed.archives.filter(a =>
      a && typeof a === 'object' && a.orchestration_id === orchestrationId
    );
  } catch (_e) {
    return [];
  }
}

/**
 * Build the inline `<audit-round-digest>` block for one archive entry.
 * Inline body is read from the digest file on disk and capped at the
 * configured byte limit (default 3 KB) — over-cap → truncate body and
 * append `<truncated/>`. Failure to read the file → returns null
 * (caller falls through to verbatim transcript per fail-open).
 */
function buildAuditRoundDigestBlock(cwd, archive, inlineMaxBytes) {
  if (!archive || !archive.digest_path) return null;
  let body = '';
  try {
    body = fs.readFileSync(path.join(cwd, archive.digest_path), 'utf8');
  } catch (_e) {
    return null;
  }
  let inline = body;
  let truncated = false;
  const max = (typeof inlineMaxBytes === 'number' && inlineMaxBytes > 0)
    ? inlineMaxBytes
    : DEFAULT_AUDIT_ROUND_INLINE_MAX_BYTES;
  if (Buffer.byteLength(inline, 'utf8') > max) {
    // F-007 (v2.2.0 fix-pass): UTF-8-safe truncation. The naive
    // `Buffer.slice(0,max).toString('utf8')` lands inside a multi-byte
    // sequence and produces a U+FFFD replacement char on the boundary
    // for non-ASCII content. Walk the byte at `max` backward to the
    // nearest valid UTF-8 lead-byte boundary so the truncated body is
    // pure valid UTF-8 (no replacement chars), regardless of the
    // digest body's character set.
    const buf = Buffer.from(inline, 'utf8');
    let cut = max;
    // Continuation bytes are 10xxxxxx (0x80..0xBF). Walk back until the
    // byte at `cut` is NOT a continuation byte — that's the start of a
    // codepoint and a safe slice boundary. Bound the walk at 4 bytes
    // (max UTF-8 codepoint length) to guarantee O(1).
    for (let i = 0; i < 4 && cut > 0; i++) {
      const b = buf[cut];
      if (b === undefined) break;
      if ((b & 0xC0) !== 0x80) break;
      cut--;
    }
    inline = buf.slice(0, cut).toString('utf8');
    truncated = true;
  }
  // S-005 (v2.2.0 fix-pass): XML-escape interpolated attribute values.
  // `digest_path` and `finding_ids` flow from sidecar data which traces
  // back to attacker-controllable `task_id` / `orchestration_id` fields
  // in events.jsonl. An unescaped `"` in an attribute value would close
  // the attribute early and let a forged `trustworthy="true"` token
  // poison the cached prefix replayed across spawns (Slot 1/2, 1h TTL).
  function xmlAttrEscape(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  const ids = Array.isArray(archive.finding_ids) ? archive.finding_ids.join(',') : '';
  const attrs = [
    'round="'         + (archive.round_n || 0) + '"',
    'digest_path="'   + xmlAttrEscape(archive.digest_path || '') + '"',
    'full_bytes="'    + (archive.full_transcript_bytes || 0) + '"',
    'digest_bytes="'  + (archive.digest_bytes || 0) + '"',
    'ratio="'         + (typeof archive.ratio === 'number' ? archive.ratio : 0) + '"',
    'finding_ids="'   + xmlAttrEscape(ids) + '"',
  ].join(' ');
  const trail = truncated ? '\n<truncated/>' : '';
  return '<!-- zone2:audit-round-archive round=' + (archive.round_n || 0) + ' -->\n' +
         '<audit-round-digest ' + attrs + '>\n' +
         inline + trail + '\n' +
         '</audit-round-digest>';
}

/**
 * Build Zone 2 content (per-orch-pinned). Reads orchestration header.
 *
 * @param {string} cwd
 * @returns {{ content: string, hash: string, bytes: number }}
 */
function buildZone2(cwd) {
  const parts = [];
  let orchestrationId = null;

  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    if (orchData) {
      orchestrationId = orchData.orchestration_id || null;
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

  // P3.1 (v2.2.0): substitute archived rounds' verbatim transcripts with
  // <audit-round-digest> pointer blocks. Sidecar absent / disabled →
  // fall through to today's behaviour (verbatim transcript, today: noop).
  if (orchestrationId) {
    let inlineMax = DEFAULT_AUDIT_ROUND_INLINE_MAX_BYTES;
    try {
      const cfgRaw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
      const cfg    = JSON.parse(cfgRaw);
      const block  = cfg && cfg.audit && cfg.audit.round_archive;
      if (block && typeof block.inline_digest_max_bytes === 'number' &&
          block.inline_digest_max_bytes > 0) {
        inlineMax = block.inline_digest_max_bytes;
      }
    } catch (_e) { /* defaults apply */ }

    const archives = loadAuditRoundArchives(cwd, orchestrationId)
      .slice()
      .sort((a, b) => (a.round_n || 0) - (b.round_n || 0));
    for (const archive of archives) {
      const block = buildAuditRoundDigestBlock(cwd, archive, inlineMax);
      if (block) parts.push(block);
    }
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
 *
 * v2.2.1 W2: optional `zone1FileHashes` arg (Record<path,sha256>) is
 * persisted as the additive `zone1_file_hashes` field. The validator
 * uses it to compute true `delta_files`. The legacy `zone1_hash` field
 * stays so older readers (and the upstream invariant check) keep working.
 *
 * @param {string} cwd
 * @param {string} zone1Hash
 * @param {string} zone2Hash
 * @param {Record<string,string>=} zone1FileHashes
 */
function saveZoneHashes(cwd, zone1Hash, zone2Hash, zone1FileHashes) {
  try {
    const stateDir   = path.join(cwd, STATE_DIR);
    const zonesPath  = path.join(stateDir, ZONES_FILE);
    fs.mkdirSync(stateDir, { recursive: true });
    const data = {
      zone1_hash: zone1Hash,
      zone2_hash: zone2Hash,
      updated_at: new Date().toISOString(),
    };
    if (zone1FileHashes && typeof zone1FileHashes === 'object') {
      data.zone1_file_hashes = zone1FileHashes;
    }
    const tmp = zonesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    try { fs.renameSync(tmp, zonesPath); }
    catch (_e) { fs.writeFileSync(zonesPath, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
  } catch (_e) {
    // Fail-open
  }
}

/**
 * Persist the 4-slot cache-breakpoint manifest (P2.1, v2.2.0).
 *
 * Writes `.orchestray/state/cache-breakpoint-manifest.json` with the slot
 * array, the Block-Z hash for cross-reference, and the per-component shas
 * the invalidation script consumes.
 *
 * Atomic pattern: write to .tmp + rename. Fail-open on any error.
 */
function saveManifest(cwd, manifest, blockZ) {
  try {
    const stateDir   = path.join(cwd, STATE_DIR);
    const manifestP  = path.join(stateDir, MANIFEST_FILE);
    fs.mkdirSync(stateDir, { recursive: true });
    const data = {
      slots:                 manifest.slots,
      total_bytes:           manifest.total_bytes,
      ttl_downgrade_applied: manifest.ttl_downgrade_applied,
      block_z_hash:          (blockZ && blockZ.hash) || null,
      block_z_components:    (blockZ && Array.isArray(blockZ.components)) ? blockZ.components : [],
      composed_at:           new Date().toISOString(),
      error:                 manifest.error || null,
    };
    const tmp = manifestP + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, manifestP);
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

    // P2.1 (v2.2.0): build Block-Z first. Env kill switch and config flag both
    // honoured. Fail-soft: an empty blockZ.text falls through to today's
    // 3-zone payload byte-identical to v2.1.17.
    let blockZ = { text: '', hash: null, components: [], error: 'disabled' };
    if (process.env.ORCHESTRAY_DISABLE_BLOCK_Z === '1') {
      blockZ = { text: '', hash: null, components: [], error: 'disabled' };
    } else if (cfg.block_z_enabled !== false) {
      try {
        blockZ = buildBlockZ({ cwd });
      } catch (_e) {
        blockZ = { text: '', hash: null, components: [], error: 'missing_input' };
      }
    }

    // Build zones
    const zone1 = buildZone1(cwd);
    const zone2 = buildZone2(cwd);
    const zone3 = buildZone3(cwd);

    // Save hashes for the invariant validator (v2.2.1 W2: include per-file
    // hashes so the validator computes true `delta_files`).
    saveZoneHashes(cwd, zone1.hash, zone2.hash, zone1.fileHashes);

    // P2.1 (v2.2.0): build the 4-slot manifest after zones are computed.
    // Fail-soft: error → manifest.slots = [] and we skip persistence below.
    let manifest = { slots: [], total_bytes: 0, ttl_downgrade_applied: false, error: 'disabled' };
    const breakpointsEnabled =
      process.env.ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS !== '1' &&
      cfg.engineered_breakpoints_enabled !== false &&
      blockZ && blockZ.hash;
    if (breakpointsEnabled) {
      let pmProtocol = null;
      try {
        const orchFileLocal = getCurrentOrchestrationFile(cwd);
        const orchDataLocal = JSON.parse(fs.readFileSync(orchFileLocal, 'utf8'));
        if (orchDataLocal && orchDataLocal.pm_protocol && typeof orchDataLocal.pm_protocol === 'object') {
          pmProtocol = orchDataLocal.pm_protocol;
        }
      } catch (_e) { /* fall through with pmProtocol=null → long-orch default */ }

      try {
        manifest = buildManifest({
          cwd, blockZ, zone1, zone2, zone3,
          pmProtocol, opportunisticArtifacts: [],
        });
      } catch (_e) {
        manifest = { slots: [], total_bytes: 0, ttl_downgrade_applied: false, error: 'build_error' };
      }
      if (manifest && Array.isArray(manifest.slots) && manifest.slots.length > 0) {
        saveManifest(cwd, manifest, blockZ);
      }
    }

    // Assemble the additionalContext payload — Block-Z FIRST when available.
    const sections = [];

    if (blockZ && blockZ.text) {
      sections.push(
        '<block-z cache_hint="immutable-1h">\n' +
        blockZ.text + '\n' +
        '</block-z>'
      );
    }

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

    // Emit block_a_zone_composed audit event (P2.1: extended with Block-Z fields)
    emitAuditEvent(cwd, 'block_a_zone_composed', {
      orchestration_id:    orchestrationId,
      turn_number:         null,
      zone1_hash:          zone1.hash,
      zone2_hash:          zone2.hash,
      zone3_bytes:         zone3.bytes,
      cache_breakpoints:   (blockZ && blockZ.hash && manifest.slots.length === 4) ? 4 : 3,
      block_z_hash:        (blockZ && blockZ.hash) || null,
      manifest_slot_count: (manifest && Array.isArray(manifest.slots)) ? manifest.slots.length : 0,
    });

    // P2.1: emit block_z_emit + cache_breakpoint_emit telemetry.
    if (blockZ && (blockZ.hash || blockZ.error)) {
      const componentByName = {};
      for (const c of (blockZ.components || [])) componentByName[c.name] = c.sha;
      const bodyForToken = blockZ.text || '';
      const tokenEstimate = Math.floor(Buffer.byteLength(bodyForToken, 'utf8') / 4);
      const projectHash = require('crypto').createHash('sha256').update(cwd, 'utf8').digest('hex');
      emitAuditEvent(cwd, 'block_z_emit', {
        orchestration_id:       orchestrationId,
        project_hash:           projectHash,
        pm_md_hash:             componentByName['agents/pm.md'] || null,
        claude_md_hash:         componentByName['CLAUDE.md'] || null,
        handoff_contract_hash:  componentByName['agents/pm-reference/handoff-contract.md'] || null,
        phase_contract_hash:    componentByName['agents/pm-reference/phase-contract.md'] || null,
        block_z_hash:           blockZ.hash || null,
        prefix_token_estimate:  tokenEstimate,
        byte_length:            Buffer.byteLength(bodyForToken, 'utf8'),
        error:                  blockZ.error || null,
      });
    }
    if (manifest && Array.isArray(manifest.slots)) {
      for (const slot of manifest.slots) {
        emitAuditEvent(cwd, 'cache_breakpoint_emit', {
          orchestration_id:       orchestrationId,
          slot:                   slot.slot,
          ttl:                    slot.ttl,
          marker_byte_offset:     slot.marker_byte_offset,
          prefix_hash:            slot.prefix_hash,
          prefix_token_estimate:  slot.prefix_token_estimate,
          ttl_downgrade_applied:  manifest.ttl_downgrade_applied && (slot.slot === 1 || slot.slot === 2),
        });
      }
    }

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

// ---------------------------------------------------------------------------
// Module exports (testability — p3-fixpass-hardening §S-005)
// ---------------------------------------------------------------------------

module.exports = {
  buildZone1,
  buildZone2,
  buildZone3,
  buildAuditRoundDigestBlock,
  loadAuditRoundArchives,
  loadBlockAConfig,
  isSentinelActive,
  emitAuditEvent,
  saveZoneHashes,
  saveManifest,
  handle,
};
