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
 */

const ROLE_WRITE_ALLOWLISTS = {
  reviewer: [
    '.orchestray/kb/**',
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
  debugger: [], // fully read-only — no writes allowed
};

/**
 * Roles that are subject to write gating.
 * Developer, architect, inventor, refactorer, researcher are NOT gated —
 * they legitimately need broad write access.
 */
const RESTRICTED_ROLES = new Set(Object.keys(ROLE_WRITE_ALLOWLISTS));

module.exports = {
  ROLE_WRITE_ALLOWLISTS,
  RESTRICTED_ROLES,
};
