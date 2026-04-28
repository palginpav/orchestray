#!/usr/bin/env node
'use strict';

/**
 * _lib/invalidate-block-a-zone1.js — Shared zone1 invalidation helper (v2.2.7).
 *
 * Null out zone1_hash in block-a-zones.json so the next compose-block-a.js run
 * re-pins it with the current shadow content included.
 *
 * Why this exists: both regen-schema-shadow.js (CLI path) and
 * regen-schema-shadow-hook.js (PostToolUse hook path) need to invalidate zone1
 * after a successful shadow regen. Centralising here prevents the two callers
 * from drifting apart on the exact fields they clear.
 *
 * Fail-open contract: any error is written to stderr and the function returns
 * false. The caller's primary operation (shadow regen) already succeeded; this
 * step is cleanup and must never abort the parent process.
 *
 * @param {string} cwd - Absolute path to the project root.
 * @param {object} [opts]
 * @param {string} [opts.reason='shadow_regenerated'] - Recorded in updated_at field.
 * @param {string} [opts.caller='regen-schema-shadow'] - Prefix for stderr messages.
 * @returns {boolean} true if zone1_hash was cleared, false if already null / error.
 */

const fs   = require('fs');
const path = require('path');

const STATE_DIR  = path.join('.orchestray', 'state');
const ZONES_FILE = 'block-a-zones.json';

function invalidateZone1Hash(cwd, opts) {
  opts = opts || {};
  const reason = opts.reason || 'shadow_regenerated';
  const caller = opts.caller || 'regen-schema-shadow';

  try {
    const zonesPath = path.join(cwd, STATE_DIR, ZONES_FILE);
    if (!fs.existsSync(zonesPath)) return false; // nothing to clear
    const raw    = fs.readFileSync(zonesPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return false;
    if (!parsed.zone1_hash) return false; // already null / cleared
    parsed.zone1_hash             = null;
    parsed.zone1_file_hashes      = null;
    parsed.updated_at             = new Date().toISOString();
    parsed.zone1_invalidated_reason = reason;
    const tmp = zonesPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    try { fs.renameSync(tmp, zonesPath); }
    catch (_e2) { fs.writeFileSync(zonesPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8'); }
    process.stderr.write(
      '[' + caller + '] zone1_hash invalidated — will re-pin on next compose-block-a run\n'
    );
    return true;
  } catch (err) {
    // Fail-open: primary operation already succeeded; do not abort for this cleanup step.
    process.stderr.write('[' + caller + '] zone1 invalidation skipped: ' + err.message + '\n');
    return false;
  }
}

module.exports = { invalidateZone1Hash };
