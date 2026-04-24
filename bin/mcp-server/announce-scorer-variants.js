'use strict';

/**
 * announce-scorer-variants.js — W8 (v2.1.13 R-RET-PROMOTE).
 *
 * One-time stderr announcement for the newly selectable scorer variants.
 * On first pattern_find call after upgrading to v2.1.13, prints a short hint
 * on stderr telling the operator that `retrieval.scorer_variant` now accepts
 * `skip-down`, `local-success`, and `composite` in addition to the default
 * `baseline`. A sentinel file at
 *   <projectRoot>/.orchestray/state/.scorer-variants-announced-2113
 * is written on first run to suppress the message on all subsequent calls.
 *
 * Contract:
 *   - Fully silent on any I/O error — never throws, never affects caller.
 *   - Idempotent: the sentinel check + write is atomic enough for practical
 *     purposes (the worst case is a duplicate message if two pattern_find
 *     calls race within a single new install, which is harmless).
 *   - Per-process guard (_announcedThisProcess) prevents re-printing when the
 *     sentinel could not be written for any reason (e.g. read-only FS).
 */

const fs   = require('node:fs');
const path = require('node:path');

// Bump if the announcement text changes and you want it to re-fire.
const SENTINEL_FILENAME = '.scorer-variants-announced-2113';

const ANNOUNCEMENT_MESSAGE =
  '[orchestray] retrieval.scorer_variant is now selectable: "skip-down" ' +
  '(patterns you skip rank lower), "local-success" (patterns that worked ' +
  'here rank higher), "composite" (both), or the default "baseline" ' +
  '(unchanged). To opt in: add "retrieval": { "scorer_variant": ' +
  '"composite" } to .orchestray/config.json.';

// Per-process guard — defence-in-depth when sentinel writes fail (e.g. RO fs).
let _announcedThisProcess = false;

/**
 * Emit the one-time announcement if it has not yet fired for this install.
 *
 * @param {string} projectRoot — absolute path to the project root.
 * @returns {boolean} true iff the message was printed this call.
 */
function maybeAnnounce(projectRoot) {
  if (_announcedThisProcess) return false;

  // No projectRoot → cannot write sentinel → stay silent to avoid log spam.
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return false;
  }

  const stateDir    = path.join(projectRoot, '.orchestray', 'state');
  const sentinelPath = path.join(stateDir, SENTINEL_FILENAME);

  // Sentinel already present → already announced on a prior call.
  try {
    if (fs.existsSync(sentinelPath)) {
      _announcedThisProcess = true;
      return false;
    }
  } catch (_) {
    // fall through — attempt the write + log below.
  }

  // Ensure state directory exists, then write sentinel.
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(sentinelPath, new Date().toISOString() + '\n', {
      flag: 'wx', // fail silently if file was created concurrently.
    });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      // Concurrent write won — treat as already announced.
      _announcedThisProcess = true;
      return false;
    }
    // Any other write failure → flip the in-process flag anyway so repeated
    // calls within this process do not spam stderr.
    _announcedThisProcess = true;
    // Deliberately swallow: announcer must never disrupt pattern_find.
    return false;
  }

  _announcedThisProcess = true;
  try {
    process.stderr.write(ANNOUNCEMENT_MESSAGE + '\n');
  } catch (_) {
    // stderr write should never throw, but belt-and-braces.
  }
  return true;
}

/**
 * Test hook: reset the per-process guard. Not part of the public API.
 */
function _resetForTests() {
  _announcedThisProcess = false;
}

module.exports = {
  maybeAnnounce,
  _resetForTests,
  ANNOUNCEMENT_MESSAGE,
  SENTINEL_FILENAME,
};
