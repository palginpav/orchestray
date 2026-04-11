'use strict';

/**
 * Safe cwd resolution for hook scripts (W4 fix).
 *
 * Hook scripts receive `event.cwd` from the Claude Code hook payload. This
 * helper normalizes that input into an absolute path suitable for constructing
 * audit/state paths, with minimal defensive validation.
 *
 * Resolution order:
 *   1. If `eventCwd` is a non-empty string without null bytes, resolve it
 *      to an absolute path and return.
 *   2. Fall back to `process.cwd()` as a fail-open default.
 *
 * Design notes:
 *
 * - Hooks must work on the FIRST run in a fresh project, where no
 *   `.orchestray/` directory exists yet — so we cannot require any on-disk
 *   marker file as a "valid project root" signal. An earlier stricter
 *   implementation of this helper demanded `.orchestray/audit/` pre-exist,
 *   which broke every first-ever hook invocation (and every test that used
 *   a fresh tmpdir). That failure mode silently routed writes to the
 *   ancestor project instead, poisoning audit trails — the exact opposite
 *   of what a "safe" helper should do.
 *
 * - The stronger containment the audit flagged (MED1 in audit-security.md)
 *   would require a mechanism the hook contract doesn't expose: a trusted
 *   "expected project root" known out-of-band. Claude Code's hook payload
 *   IS the source of truth for cwd. Our threat model is a local plugin
 *   with a trusted client — a fully-compromised client can already inject
 *   arbitrary stdin frames and has broader capabilities than redirecting
 *   audit writes.
 *
 * - We do reject input containing null bytes (node fs rejects these with
 *   ENOENT anyway, but catching them here gives a cleaner fallback) and
 *   non-string values. Anything else Claude Code gives us, we trust.
 */

const path = require('path');

/**
 * Resolve a safe absolute cwd for hook scripts.
 *
 * @param {string|undefined|null} eventCwd - The `cwd` field from the hook payload.
 * @returns {string} An absolute path — either the resolved eventCwd or process.cwd().
 */
function resolveSafeCwd(eventCwd) {
  if (
    typeof eventCwd === 'string' &&
    eventCwd.length > 0 &&
    !eventCwd.includes('\0')
  ) {
    try {
      return path.resolve(eventCwd);
    } catch (_e) {
      // path.resolve is synchronous and essentially cannot throw for valid
      // strings, but belt-and-suspenders: fall through to process.cwd().
    }
  }
  return process.cwd();
}

module.exports = { resolveSafeCwd };
