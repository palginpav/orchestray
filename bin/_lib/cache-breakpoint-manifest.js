'use strict';

/**
 * cache-breakpoint-manifest.js — 4-slot manifest builder (P2.1, v2.2.0).
 *
 * Converts the assembled `additionalContext` payload (Block-Z + Zone 1 + Zone 2
 * + Zone 3) into a deterministic 4-slot manifest of cache-control markers. The
 * manifest is the input to the strict invariant validator and the source of
 * `cache_breakpoint_emit` telemetry.
 *
 * The 4 slots:
 *
 *   Slot 1 — Tier-0 immutable (Block-Z body).         TTL 1h (default)
 *   Slot 2 — Per-orch (Zone 2).                       TTL 1h (default)
 *   Slot 3 — Per-turn boundary (head of Zone 3).       TTL 5m (always)
 *   Slot 4 — Opportunistic (long-lived artifacts).    TTL 5m (always)
 *
 * TTL auto-downgrade rule (CRITICAL — addresses W7 P2.1 Risk #2):
 *   IF pm_protocol.estimated_orch_duration_minutes < 25
 *   THEN Slots 1 and 2 downgrade to TTL '5m'
 *   ELSE Slots 1 and 2 stay at '1h'
 *
 * Anthropic accepts at most 4 explicit cache_control blocks per request. Slot
 * count is exactly 4. Slot 4 may be degenerate (marker_byte_offset === total_bytes)
 * when no opportunistic artifacts are supplied — v2.2.0 ships Slot 4 as a shell.
 *
 * Failure modes (fail-soft):
 *   - blockZ.error is non-null    → { slots: [], error: 'block_z_missing' }
 *   - Computed offsets non-monotonic → { slots: [], error: 'non_monotonic' }
 *
 * Public API: { buildManifest, SLOT_DEFINITIONS }
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Slot definitions (binding)
// ---------------------------------------------------------------------------

const SLOT_DEFINITIONS = Object.freeze([
  Object.freeze({ slot: 1, region: 'block_z',    default_ttl: '1h' }),
  Object.freeze({ slot: 2, region: 'zone2',      default_ttl: '1h' }),
  Object.freeze({ slot: 3, region: 'zone3_head', default_ttl: '5m' }),
  Object.freeze({ slot: 4, region: 'zone3_tail', default_ttl: '5m' }),
]);

const TTL_DOWNGRADE_THRESHOLD_MIN = 25;
const MAX_OPPORTUNISTIC_BYTES = 1 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the 4-slot cache-control manifest for a freshly-composed prompt.
 *
 * @param {object} opts
 * @param {string} [opts.cwd]                                 Project root.
 * @param {object} opts.blockZ                                { text, hash, components, error }
 * @param {object} opts.zone1                                 { content, hash, bytes }
 * @param {object} opts.zone2                                 { content, hash, bytes }
 * @param {object} opts.zone3                                 { content, bytes }
 * @param {object|null} [opts.pmProtocol]                     pm_protocol JSON sub-object.
 *                                                            Reads estimated_orch_duration_minutes.
 * @param {Array<{path: string, bytes: number}>} [opts.opportunisticArtifacts]
 * @returns {{
 *   slots: Array<{
 *     slot:                 1|2|3|4,
 *     ttl:                  '1h'|'5m',
 *     marker_byte_offset:   number,
 *     prefix_hash:           string,
 *     prefix_token_estimate: number
 *   }>,
 *   total_bytes:           number,
 *   ttl_downgrade_applied: boolean,
 *   error:                 string|null
 * }}
 */
function buildManifest(opts) {
  opts = opts || {};
  const blockZ  = opts.blockZ  || {};
  const zone1   = opts.zone1   || {};
  const zone2   = opts.zone2   || {};
  const zone3   = opts.zone3   || {};

  if (!blockZ.text || blockZ.error) {
    return {
      slots: [],
      total_bytes: 0,
      ttl_downgrade_applied: false,
      error: 'block_z_missing',
    };
  }

  // ---------------------------------------------------------------------------
  // Reconstruct the assembled byte layout. Order matches compose-block-a.js
  // §3 Change C: <block-z>…</block-z>\n\n<block-a-zone-1>…</block-a-zone-1>
  // [\n\n<block-a-zone-2>…</block-a-zone-2>] \n\n<block-a-zone-3>…</block-a-zone-3>
  // ---------------------------------------------------------------------------

  const blockZWrapped = '<block-z cache_hint="immutable-1h">\n' + blockZ.text + '\n</block-z>';
  const zone1Wrapped  = '<block-a-zone-1 cache_hint="stable-1h">\n' + (zone1.content || '') + '\n</block-a-zone-1>';
  const zone2Wrapped  = zone2.content
    ? '<block-a-zone-2 cache_hint="per-orch-1h">\n' + zone2.content + '\n</block-a-zone-2>'
    : '';
  const zone3Wrapped  = '<block-a-zone-3 cache_hint="mutable">\n' + (zone3.content || '') + '\n</block-a-zone-3>';

  const sep = '\n\n';
  const segments = [blockZWrapped, zone1Wrapped];
  if (zone2Wrapped) segments.push(zone2Wrapped);
  segments.push(zone3Wrapped);

  // Compute per-segment byte offsets within the joined payload.
  const offsets = [0];
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    cursor += Buffer.byteLength(segments[i], 'utf8');
    if (i < segments.length - 1) {
      cursor += Buffer.byteLength(sep, 'utf8');
      offsets.push(cursor);
    }
  }
  const totalBytes = cursor;
  const fullPayload = segments.join(sep);

  // Slot anchors:
  //   Slot 1 — end of Block-Z wrapper (first segment).
  //   Slot 2 — end of Zone 2 wrapper (or end of Zone 1 when Zone 2 absent).
  //   Slot 3 — start of Zone 3 wrapper.
  //   Slot 4 — end of payload (degenerate) or end of largest opportunistic artifact.

  const blockZEndOffset = Buffer.byteLength(segments[0], 'utf8');
  let zone2EndOffset;
  let zone3StartOffset;
  if (zone2Wrapped) {
    // segments = [blockZ, zone1, zone2, zone3]
    zone2EndOffset = offsets[2] + Buffer.byteLength(zone2Wrapped, 'utf8');
    zone3StartOffset = offsets[3];
  } else {
    // segments = [blockZ, zone1, zone3]
    zone2EndOffset = offsets[1] + Buffer.byteLength(zone1Wrapped, 'utf8');
    zone3StartOffset = offsets[2];
  }

  // TTL decision
  const estimatedMin = (opts.pmProtocol && typeof opts.pmProtocol.estimated_orch_duration_minutes === 'number')
    ? opts.pmProtocol.estimated_orch_duration_minutes
    : null;
  const downgrade = estimatedMin !== null && estimatedMin < TTL_DOWNGRADE_THRESHOLD_MIN;
  const slot12Ttl = downgrade ? '5m' : '1h';

  // Slot 4 (P3.2, v2.2.0): if any opportunistic artifact is supplied, position
  // the marker BEFORE the largest one so the cacheable prefix INCLUDES every
  // byte up to (but not including) that artifact. The artifact itself sits in
  // the per-turn delta region. Cache-stacking discipline per W1 §Q4.
  //
  // F-012/F-008 (v2.2.0 pre-ship cross-phase fix-pass): the
  // `opportunisticArtifacts` BRANCH below is dead code in v2.2.0 — no
  // caller passes the field today (compose-block-a.js builds slot 4 from
  // totalBytes only). Kept structurally for v2.2.1 staging when artifact
  // pre-positioning ships; remove if the v2.2.1 design picks a different
  // strategy. Documented here to prevent silent removal during refactor.
  let slot4Offset = totalBytes;
  const arts = Array.isArray(opts.opportunisticArtifacts) ? opts.opportunisticArtifacts : [];
  if (arts.length > 0) {
    const eligible = arts.filter(a => a && typeof a.bytes === 'number' && a.bytes <= MAX_OPPORTUNISTIC_BYTES);
    if (eligible.length > 0) {
      const largest = eligible.slice().sort((a, b) => b.bytes - a.bytes)[0];
      slot4Offset = Math.max(0, totalBytes - largest.bytes);
    }
  }

  // Compose slots
  const slotsRaw = [
    { slot: 1, ttl: slot12Ttl, marker_byte_offset: blockZEndOffset },
    { slot: 2, ttl: slot12Ttl, marker_byte_offset: zone2EndOffset  },
    { slot: 3, ttl: '5m',      marker_byte_offset: zone3StartOffset },
    { slot: 4, ttl: '5m',      marker_byte_offset: slot4Offset      },
  ];

  // Defensive: assert non-strict monotonicity (slot 3 may equal slot 2 when
  // zone2 absent and zone3 immediately follows; in normal runs all four are
  // strictly increasing).
  for (let i = 1; i < slotsRaw.length; i++) {
    if (slotsRaw[i].marker_byte_offset < slotsRaw[i - 1].marker_byte_offset) {
      return {
        slots: [],
        total_bytes: totalBytes,
        ttl_downgrade_applied: downgrade,
        error: 'non_monotonic',
      };
    }
  }

  // Compute prefix_hash and token estimates for each slot.
  const slots = slotsRaw.map((s) => {
    const prefixBytes = fullPayload.slice(0, s.marker_byte_offset);
    const prefixHash = crypto.createHash('sha256').update(prefixBytes, 'utf8').digest('hex');
    const prefixTokenEstimate = Math.floor(Buffer.byteLength(prefixBytes, 'utf8') / 4);
    return {
      slot: s.slot,
      ttl: s.ttl,
      marker_byte_offset: s.marker_byte_offset,
      prefix_hash: prefixHash,
      prefix_token_estimate: prefixTokenEstimate,
    };
  });

  return {
    slots,
    total_bytes: totalBytes,
    ttl_downgrade_applied: downgrade,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Opportunistic-artifact registration (P3.2, v2.2.0)
// ---------------------------------------------------------------------------
//
// In-memory queue of Slot-4 artifact candidates the PM has registered for the
// next compose-block-a turn. Keyed by orchestration_id. Cleared per orch on
// orchestration_close (caller responsibility).
//
// State is process-local — drained on the NEXT UserPromptSubmit (which fires
// AFTER the PM's reasoning step that registers, no race per design §3 OQ-3).

const opportunisticQueue = new Map();   // orchestration_id → Array<{path, bytes, prefix_hash}>

/**
 * Register an opportunistic artifact as a Slot-4 cache-breakpoint candidate
 * for the NEXT compose-block-a turn.
 *
 * @param {object} opts
 * @param {number} opts.slot                  Currently 4 only.
 * @param {string} opts.path                  Absolute or cwd-relative path.
 * @param {number} opts.bytes                 utf-8 byte length.
 * @param {string} opts.prefix_hash           Cross-link to spawn-context-delta.
 * @param {string} [opts.orchestration_id]    Defaults to '__default__'.
 * @returns {void}                            Fail-open.
 */
function registerOpportunisticArtifact(opts) {
  try {
    if (!opts || typeof opts !== 'object') return;
    if (opts.slot !== 4) return;                       // v2.2.0 only Slot 4
    if (typeof opts.path !== 'string' || !opts.path) return;
    if (typeof opts.bytes !== 'number' || opts.bytes <= 0) return;

    const orch = String(opts.orchestration_id || '__default__');
    const entry = {
      path:        opts.path,
      bytes:       opts.bytes,
      prefix_hash: typeof opts.prefix_hash === 'string' ? opts.prefix_hash : null,
    };
    if (!opportunisticQueue.has(orch)) opportunisticQueue.set(orch, []);
    opportunisticQueue.get(orch).push(entry);
  } catch (_e) {
    // Fail-open by design.
  }
}

/**
 * Drain the registered artifact list for a given orchestration. Caller is
 * compose-block-a.js immediately before invoking buildManifest.
 *
 * @param {string} [orchestration_id]
 * @returns {Array<{path:string, bytes:number, prefix_hash:string|null}>}
 */
function drainOpportunisticArtifacts(orchestration_id) {
  const orch = String(orchestration_id || '__default__');
  const arr  = opportunisticQueue.get(orch);
  if (!arr || arr.length === 0) return [];
  opportunisticQueue.delete(orch);
  return arr;
}

function __resetOpportunisticQueue() {
  opportunisticQueue.clear();
}

module.exports = {
  buildManifest,
  SLOT_DEFINITIONS,
  TTL_DOWNGRADE_THRESHOLD_MIN,
  registerOpportunisticArtifact,
  drainOpportunisticArtifacts,
  __resetOpportunisticQueue,
};
