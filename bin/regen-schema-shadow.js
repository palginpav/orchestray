#!/usr/bin/env node
'use strict';

/**
 * regen-schema-shadow.js — R-SHDW generator (v2.1.14).
 *
 * Reads agents/pm-reference/event-schemas.md and extracts a compact JSON index
 * of every event type, written to agents/pm-reference/event-schemas.shadow.json.
 *
 * The shadow has the shape:
 *   {
 *     "_meta": { version, source_hash, shadow_size_bytes },
 *     "<event_type>": { version, required, optional, enum_dialect_hash },
 *     ...
 *   }
 *
 * Note: generated_at was removed in v2.2.14 G-10 — the timestamp caused the
 * file to appear modified in git status on every regen even when no event
 * schema changed. source_hash is sufficient to detect staleness.
 *
 * Output target: ≤ 8 KB. Script errors out if the shadow exceeds this limit.
 * (Raised from 4 KB to 8 KB in v2.1.16 W12-fix F-005 — the v2.1.16 file landed
 * at 4052/4096 bytes leaving only 44 bytes of headroom, and v2.1.17's
 * R-DOCUMENTER-EVENT + R-ARCHETYPE-EVENT were guaranteed to overflow the cap.
 * 8 KB still sits well under PIPE_BUF on every supported platform.)
 *
 * Usage: node bin/regen-schema-shadow.js [--cwd <dir>]
 *
 * Idempotent: running multiple times with unchanged source produces byte-
 * identical output and does NOT write the file (mtime preserved, git status
 * stays clean). File is only written when content actually changes.
 *
 * Fail contract (when run standalone):
 *   - Exits 0 on success.
 *   - Exits 1 on parse error or size overflow (stderr message).
 *
 * When called via main() from another hook:
 *   - Returns the shadow object on success.
 *   - Throws on hard failure.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// v2.2.0 P1.3: parser extracted to bin/_lib/event-schemas-parser.js so the
// shadow generator and the new tier2-index generator never disagree about
// which slugs the source declares.
const _parser = require('./_lib/event-schemas-parser');

// v2.2.7 zone1-stability fix: after a successful regen the shadow content
// changes, which will cause validate-cache-invariant.js to detect a mismatch
// on the very next tool call (stored hash was computed without the new shadow).
// Nulling zone1_hash here lets compose-block-a.js re-pin with the correct hash
// on the next UserPromptSubmit, avoiding a spurious violation → sentinel trip.
const { invalidateZone1Hash } = require('./_lib/invalidate-block-a-zone1');

const MAX_SHADOW_BYTES = 16384; // 16 KB hard ceiling — raised from 12288 (12 KB) in v2.2.11
                                // because v2.2.12 is expected to add ≥4 new event types
                                // (pushing shadow past the former 12 KB limit before the
                                // release shipped). Previous raise was 8192→12288 in v2.2.9
                                // to absorb the 23 new event types added by the mechanisation
                                // release. Value stays well under Linux PIPE_BUF (65536).

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseCwd() {
  const args = process.argv.slice(2);
  const cwdIdx = args.indexOf('--cwd');
  if (cwdIdx !== -1 && args[cwdIdx + 1]) {
    return path.resolve(args[cwdIdx + 1]);
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Event-type extraction (delegated to bin/_lib/event-schemas-parser.js)
// ---------------------------------------------------------------------------
//
// The actual section-walk + JSON-fence parser lives in event-schemas-parser.js
// so the new tier2-index generator can re-use the exact same logic. Re-export
// the same surface (`parseEventSchemas`, `extractFields`,
// `computeEnumDialectHash`) here for callers that previously imported from
// this module.

const SECTION_RE          = _parser.SECTION_RE;
const extractFields       = _parser.extractFields;
const computeEnumDialectHash = _parser.computeEnumDialectHash;
const parseEventSchemas   = _parser.parseEventSchemas;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Generate the shadow and write it to disk.
 * @param {string} cwd - Project root directory.
 * @returns {object} The shadow object.
 * @throws {Error} If the shadow exceeds the size limit.
 */
function main(cwd) {
  const schemaPath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md');
  const outPath    = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');

  let content;
  try {
    content = fs.readFileSync(schemaPath, 'utf8');
  } catch (err) {
    throw new Error('regen-schema-shadow: cannot read ' + schemaPath + ': ' + err.message);
  }

  const sourceHash = crypto.createHash('sha256').update(content).digest('hex');
  const events = parseEventSchemas(content);

  if (events.length === 0) {
    throw new Error('regen-schema-shadow: no event types found in ' + schemaPath);
  }

  // Build shadow object.
  // To stay within the 4 KB budget with 60+ event types, we use a compact
  // per-entry format: { v: version, r: req_count, o: opt_count, h: enum_hash }
  // The full required/optional lists live in the authoritative event-schemas.md.
  // The shadow answers "does this event type exist?" and "might its enums have drifted?"
  const shadow = {
    _meta: {
      version: 1,
      source_hash: sourceHash,
      // generated_at intentionally omitted (v2.2.14 G-10): timestamp made the
      // file dirty in git status on every regen even when nothing changed.
      shadow_size_bytes: 0, // filled in after serialization
      event_count: events.length,
    },
  };

  for (const ev of events) {
    // Compact entry: v=version, r=required_count, o=optional_count, h=enum_dialect_hash
    // F3 (v2.2.9): f=1 marker when the source MD declares `feature_optional: true`
    // in its Field-notes block. Consumed by `bin/audit-promised-events.js` to
    // skip events that are legitimately dark (opt-in slash commands, negative-
    // path guards, untriggered failure-recovery paths).
    const entry = { v: ev.version, r: ev.required.length, o: ev.optional.length };
    if (ev.enum_dialect_hash !== 'none') {
      entry.h = ev.enum_dialect_hash;
    }
    if (ev.feature_optional === true) {
      entry.f = 1;
    }
    shadow[ev.slug] = entry;
  }

  // Serialize without pretty-print to minimize size; the shadow is a machine-read hint
  const json = JSON.stringify(shadow);
  const sizeBytes = Buffer.byteLength(json, 'utf8');

  if (sizeBytes > MAX_SHADOW_BYTES) {
    throw new Error(
      'regen-schema-shadow: shadow size ' + sizeBytes + ' bytes exceeds limit of ' +
      MAX_SHADOW_BYTES + ' bytes. Reduce fields extracted per event type.'
    );
  }

  // Update the size field now that we know it
  shadow._meta.shadow_size_bytes = sizeBytes;
  const finalJson = JSON.stringify(shadow);

  // Auto-clear three-strike sentinel on regeneration
  const stateDir      = path.join(cwd, '.orchestray', 'state');
  const sentinelPath  = path.join(stateDir, '.schema-shadow-disabled');
  try {
    if (fs.existsSync(sentinelPath)) {
      fs.unlinkSync(sentinelPath);
    }
  } catch (_e) {
    // Best-effort sentinel clear
  }

  // Write-only-on-content-diff (v2.2.14 G-10): skip the write when the
  // generated content is byte-identical to what's already on disk. This keeps
  // git status clean and preserves the file mtime on no-op regens.
  const newContent = finalJson + '\n';
  let existingContent = null;
  try {
    existingContent = fs.readFileSync(outPath, 'utf8');
  } catch (_e) {
    // File doesn't exist yet — proceed with write
  }
  if (existingContent === newContent) {
    return shadow; // no-op: content unchanged
  }

  fs.writeFileSync(outPath, newContent, 'utf8');

  return shadow;
}

// ---------------------------------------------------------------------------
// Standalone invocation
// ---------------------------------------------------------------------------

if (require.main === module) {
  try {
    const cwd    = parseCwd();
    const shadow = main(cwd);
    const count  = Object.keys(shadow).filter(k => k !== '_meta').length;
    process.stdout.write(
      '[regen-schema-shadow] OK — ' + count + ' event types, ' +
      shadow._meta.shadow_size_bytes + ' bytes → agents/pm-reference/event-schemas.shadow.json\n'
    );
    // v2.2.7 zone1-stability fix: null out zone1_hash so the next compose-block-a
    // run re-pins with the freshly-regenerated shadow included. Fail-open: if
    // invalidation throws, warn to stderr and continue — the regen itself succeeded.
    invalidateZone1Hash(cwd, { reason: 'shadow_regenerated', caller: 'regen-schema-shadow' });
    process.exit(0);
  } catch (err) {
    process.stderr.write('[regen-schema-shadow] ERROR: ' + err.message + '\n');
    process.exit(1);
  }
}

module.exports = { main, parseEventSchemas };
