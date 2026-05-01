'use strict';

/**
 * role-write-allowlists.js — per-role write path allowlists (v2.2.9 B-2.4).
 *
 * Imported by bin/gate-role-write-paths.js.
 *
 * Glob-style patterns (minimatch syntax):
 *   **   matches any path segments
 *   *    matches within a single segment
 *
 * Roles not listed here have no write restrictions applied by the gate
 * (only the roles in RESTRICTED_ROLES are gated).
 *
 * Kill switch: ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1 bypasses all checks.
 *
 * v2.2.21 T8 (CWE-22 Path Traversal hardening):
 *   - All glob patterns are root-anchored at compile time. The `compileGlob`
 *     helper produces `^(?:\\./)?<glob>$`, so the regex never floats. The gate
 *     additionally rejects any `relPath` containing a `..` segment BEFORE
 *     consulting these regexes (defense in depth).
 *   - The `__test__` named export exposes the compiled regex map so the
 *     traversal-hardening test fixture can assert anchoring directly.
 */

const ROLE_WRITE_ALLOWLISTS = {
  reviewer: [
    '.orchestray/kb/**',
    '.orchestray/kb/artifacts/**.md',   // G-08: explicit artifact write (covered by kb/** but stated for clarity)
    '.orchestray/audit/**',
  ],
  tester: [
    '**/*.test.*',
    '**/*.spec.*',
    '**/test*/**',
    '**/__tests__/**',
    '**/*.test.js',
    '**/*.spec.js',
    '**/*.test.ts',
    '**/*.spec.ts',
  ],
  documenter: [
    'docs/**',
    '*.md',
    '**/*.md',
    'README*',
    'CHANGELOG*',
  ],
  'release-manager': [
    'CHANGELOG.md',
    'CHANGELOG',
    'README.md',
    'README',
    'package.json',
    'VERSION',
    '.claude-plugin/plugin.json',
    'agents/pm-reference/event-schemas.md',
    'agents/pm-reference/event-schemas.shadow.json',
    'agents/pm-reference/event-schemas.tier2-index.json',
  ],
  debugger: [
    '.orchestray/kb/artifacts/**.md',  // G-08: debugger may write findings artifacts (v2.2.14)
  ],
};

/**
 * Roles that are subject to write gating.
 * Developer, architect, inventor, refactorer, researcher are NOT gated —
 * they legitimately need broad write access.
 */
const RESTRICTED_ROLES = new Set(Object.keys(ROLE_WRITE_ALLOWLISTS));

// ---------------------------------------------------------------------------
// Compiled regex map (v2.2.21 T8): root-anchored conversion of glob patterns.
// Kept here (rather than only in the gate) so the test fixture can inspect
// the compiled regexes directly via the `__test__` export and assert that
// every pattern starts with `^`.
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a root-anchored RegExp.
 *
 * Anchoring rules:
 *   - `^` at the start (mandatory) — pattern is rooted at the project tree.
 *   - `(?:\./)?` permits an optional leading `./` after the root anchor.
 *   - `$` at the end — pattern matches the full relative path.
 *
 * Glob expansion:
 *   - `**` → `.*` (any chars including `/`)
 *   - `*`  → `[^/]*` (any chars within a single segment)
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function compileGlob(glob) {
  let regStr = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
    .replace(/\*\*/g, '\x00')              // sentinel for **
    .replace(/\*/g, '[^/]*')              // * → any segment chars
    .replace(/\x00/g, '.*');              // ** → any chars (incl. /)
  return new RegExp('^(?:\\./)?' + regStr + '$');
}

/**
 * Compile every role's allowlist into a `{ role: RegExp[] }` map.
 *
 * @returns {Object<string, RegExp[]>}
 */
function compileAllowlists() {
  const out = {};
  for (const role of Object.keys(ROLE_WRITE_ALLOWLISTS)) {
    out[role] = ROLE_WRITE_ALLOWLISTS[role].map(compileGlob);
  }
  return out;
}

const COMPILED_ALLOWLISTS = compileAllowlists();

module.exports = {
  ROLE_WRITE_ALLOWLISTS,
  RESTRICTED_ROLES,
  compileGlob,
  COMPILED_ALLOWLISTS,
  // Test-only export: gives the unit test direct access to the compiled regex
  // map so it can assert root-anchoring without re-importing the gate's
  // private cache. Stable; documented in T8-W1-path-traversal-block.md.
  __test__: { COMPILED_ALLOWLISTS, compileGlob },
};
