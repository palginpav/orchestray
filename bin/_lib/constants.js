'use strict';

/**
 * constants.js — Shared numeric constants for Orchestray hook scripts.
 *
 * T3 X3: Extract MAX_INPUT_BYTES from bin/record-mcp-checkpoint.js (line 49)
 * and bin/gate-agent-spawn.js (line 28) into a single source of truth to
 * eliminate the fragile cross-file coupling by comment that existed previously.
 *
 * Usage: import in bin-level scripts via the _lib path (relative to each script).
 */

/**
 * Maximum stdin bytes accepted by hook scripts before failing open.
 * Guards against runaway payloads OOMing the hook process.
 * Mirrors the 1 MB cap originally hardcoded in both record-mcp-checkpoint.js
 * and gate-agent-spawn.js.
 *
 * @type {number}
 */
const MAX_INPUT_BYTES = 1024 * 1024; // 1 MB

module.exports = {
  MAX_INPUT_BYTES,
};
