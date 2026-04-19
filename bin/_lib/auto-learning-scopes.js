'use strict';

/**
 * auto-learning-scopes.js — Shared circuit-breaker scope name constants.
 *
 * Single source of truth for scope strings used by both the extraction hook
 * (post-orchestration-extract.js) and the display renderers (status-render.js,
 * patterns-render.js). Importing from here prevents the scope names drifting
 * apart silently and making the TRIPPED banner invisible.
 *
 * v2.1.6 — W8-10 scope consistency fix.
 */

/**
 * Scope used by post-orchestration-extract.js when calling checkAndIncrement(),
 * and by status-render.js / patterns-render.js when calling isTripped().
 *
 * Changing this value changes the sentinel file name on disk
 * (learning-breaker-{scope}.tripped). If you rename this constant, also
 * delete any existing sentinel files from .orchestray/state/ so they are
 * re-created under the new name.
 *
 * @type {string}
 */
const EXTRACTION_BREAKER_SCOPE = 'auto_extract';

module.exports = { EXTRACTION_BREAKER_SCOPE };
