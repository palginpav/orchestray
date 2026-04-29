'use strict';

/**
 * peek-orchestration-id.js — shared helper for reading the active
 * orchestration_id from the on-disk marker file.
 *
 * Reads `.orchestray/audit/current-orchestration.json` and returns the
 * `orchestration_id` field, or `null` if the file is missing, malformed,
 * or the field is absent.
 *
 * Contract:
 *   - NEVER throws. All failure modes return null.
 *   - No side effects (read-only).
 *   - Importable as CJS (require) — matches the project's existing module style.
 *
 * Extracted from bin/mark-compact-signal.js `_peekOrchestrationId` (W0d).
 */

const fs = require('fs');
const path = require('path');

/**
 * Return the active orchestration_id from current-orchestration.json.
 *
 * @param {string} cwd - Project root (absolute path).
 * @returns {string|null}
 */
function peekOrchestrationId(cwd) {
  try {
    const markerPath = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
    const raw = fs.readFileSync(markerPath, 'utf8');
    const m = JSON.parse(raw);
    if (m && typeof m.orchestration_id === 'string') return m.orchestration_id;
  } catch (_e) { /* swallow — file missing, parse error, or missing field */ }
  return null;
}

module.exports = { peekOrchestrationId };
