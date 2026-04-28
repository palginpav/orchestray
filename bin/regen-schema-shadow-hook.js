#!/usr/bin/env node
'use strict';

/**
 * regen-schema-shadow-hook.js — PostToolUse hook on Edit of event-schemas.md (R-SHDW, v2.1.14).
 *
 * When the agent edits agents/pm-reference/event-schemas.md, this hook
 * auto-regenerates the event-schema shadow JSON so the shadow stays in sync.
 *
 * Fail-open contract: any error → stderr warning, exit 0 (never blocks).
 * The regeneration failure is surfaced as a stderr message; the hook never
 * blocks the Edit that triggered it.
 *
 * Input:  JSON on stdin (Claude Code PostToolUse hook payload)
 * Output: JSON on stdout ({ continue: true }), always exit 0
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { main: regenMain } = require('./regen-schema-shadow');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

// ---------------------------------------------------------------------------
// Zone 1 invalidation helper (v2.2.7 zone1-stability fix).
//
// When the schema shadow is regenerated its content changes, which changes
// the zone1 hash that compose-block-a.js will compute on the next turn.
// If block-a-zones.json still holds the *old* zone1_hash (one that was
// computed when the shadow was stale or absent), validate-cache-invariant.js
// will see a mismatch on the very next PreToolUse call, record a violation,
// and eventually trip the 24-hour quarantine sentinel that silences all
// Block-Z telemetry.
//
// Nulling zone1_hash here causes validate-cache-invariant.js to skip the
// invariant check on the immediately following tool call (stored.zone1_hash
// is null → early-exit). On the NEXT UserPromptSubmit, compose-block-a.js
// runs buildZone1() with the freshly-regenerated shadow and stores the new
// correct hash. From that point on the invariant check passes every time
// and no violation is recorded.
// ---------------------------------------------------------------------------

const STATE_DIR  = path.join('.orchestray', 'state');
const ZONES_FILE = 'block-a-zones.json';

/**
 * Null out zone1_hash in block-a-zones.json so the next compose-block-a.js
 * run re-pins it with the current shadow included. Fail-open.
 *
 * @param {string} cwd
 */
function invalidateZone1Hash(cwd) {
  try {
    const zonesPath = path.join(cwd, STATE_DIR, ZONES_FILE);
    if (!fs.existsSync(zonesPath)) return; // nothing to clear
    const raw    = fs.readFileSync(zonesPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    if (!parsed.zone1_hash) return; // already null / cleared
    parsed.zone1_hash        = null;
    parsed.zone1_file_hashes = null;
    parsed.updated_at        = new Date().toISOString();
    parsed.zone1_invalidated_reason = 'shadow_regenerated';
    const tmp = zonesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    try { fs.renameSync(tmp, zonesPath); }
    catch (_e2) { fs.writeFileSync(zonesPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8'); }
    process.stderr.write(
      '[regen-schema-shadow-hook] zone1_hash invalidated — will re-pin on next compose-block-a run\n'
    );
  } catch (_e) {
    // Fail-open: shadow regen already succeeded; do not block for this cleanup step.
    process.stderr.write('[regen-schema-shadow-hook] zone1 invalidation skipped: ' + _e.message + '\n');
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(CONTINUE_RESPONSE + '\n');
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[regen-schema-shadow-hook] stdin exceeded limit; skipping\n');
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    handle(event);
  } catch (_e) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});

function handle(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Check if the edited file is the canonical event-schemas.md.
    // The PostToolUse payload for Edit has tool_input.file_path.
    // W7 fix-pass L-002 (v2.2.0): match the canonical relative path
    // (agents/pm-reference/event-schemas.md) rather than any path ending
    // with the basename — `attacker-event-schemas.md` must NOT trigger.
    const toolInput = (event && event.tool_input) || {};
    const filePath = toolInput.file_path || '';
    const CANONICAL_REL = path.join('agents', 'pm-reference', 'event-schemas.md').replace(/\\/g, '/');
    const normalized = String(filePath).replace(/\\/g, '/');
    const isEventSchemas = normalized.endsWith('/' + CANONICAL_REL) || normalized === CANONICAL_REL;
    if (!isEventSchemas) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      process.exit(0);
      return;
    }

    // Regenerate the shadow
    let shadowRegenSucceeded = false;
    try {
      const shadow = regenMain(cwd);
      const count = Object.keys(shadow).filter(k => k !== '_meta').length;
      process.stderr.write(
        '[regen-schema-shadow-hook] auto-regenerated shadow: ' + count +
        ' event types, ' + shadow._meta.shadow_size_bytes + ' bytes\n'
      );
      shadowRegenSucceeded = true;
    } catch (regenErr) {
      // Fail-open: warn but do not block
      process.stderr.write('[regen-schema-shadow-hook] regen failed: ' + regenErr.message + '\n');
    }

    // v2.2.7 zone1-stability fix: when shadow is regenerated, its content changes
    // and so will the zone1 hash on the next compose-block-a run. Null out the
    // stored zone1_hash now so validate-cache-invariant.js skips the check on the
    // next tool call (avoiding a spurious violation) and compose-block-a.js re-pins
    // with the correct hash on the next UserPromptSubmit.
    if (shadowRegenSucceeded) {
      invalidateZone1Hash(cwd);
    }

    // v2.2.0 P1.3: also regen the tier2-index sidecar from the same source.
    // Both outputs share the same source-hash; computing twice in lock-step
    // keeps the shadow + index from disagreeing on slug coverage. Fail-open
    // independently of the shadow regen.
    try {
      const { buildIndex } = require('./_lib/tier2-index');
      const index = buildIndex({ cwd });
      const idxCount = Object.keys(index.events).length;
      process.stderr.write(
        '[regen-schema-shadow-hook] auto-regenerated tier2-index: ' + idxCount +
        ' events, ' + index._meta.index_size_bytes + ' bytes\n'
      );
    } catch (idxErr) {
      process.stderr.write(
        '[regen-schema-shadow-hook] tier2-index regen failed: ' + idxErr.message + '\n'
      );
    }
  } catch (_e) {
    process.stderr.write('[regen-schema-shadow-hook] unexpected error: ' + _e.message + '\n');
  }

  process.stdout.write(CONTINUE_RESPONSE + '\n');
  process.exit(0);
}
