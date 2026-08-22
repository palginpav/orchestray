'use strict';

/**
 * read-only-roles.js — canonical source of truth for "read-only role" state
 * across the enforcement surface (v2.3.32, W4 finding #2 reconciliation).
 *
 * BACKGROUND: prior to this module, "read-only" was defined three
 * non-overlapping ways with no cross-reference:
 *   - gate-developer-git.js READ_ONLY_ROLES (6 roles, destructive-git block)
 *   - _lib/role-write-allowlists.js RESTRICTED_ROLES (5 roles live — the
 *     v2.3.31 gate-inventory audit read it as 4 and missed release-manager,
 *     which the allowlist already listed; see integration note)
 *   - validate-task-completion.js READ_ONLY_AGENTS (3 roles live — the
 *     inventory read it as 1/haiku-scout-only; project-intent and
 *     orchestray-housekeeper were added in-flight this release)
 *
 * FINDING (not a bug to silently fix): these are THREE GENUINELY DISTINCT
 * AXES, not one concept badly duplicated. Forcing them into a single set
 * would be wrong — e.g. `debugger` legitimately needs git-destructive block
 * + write-path restriction while still running arbitrary non-destructive
 * Bash; `tester`/`documenter` need write-path restriction but no git
 * restriction (they commit their own W-items); `haiku-scout` needs neither
 * git nor write-path logic because its frontmatter grants no Write/Edit/Bash
 * at all — its axis is "verify the tool grant was honored at Stop time."
 * Each axis answers a different question:
 *
 *   1. GIT_DESTRUCTIVE_BLOCKED  — "may it run destructive git, ever?"
 *   2. WRITE_PATH_RESTRICTED    — "where on disk may it Write/Edit?"
 *   3. RUNTIME_TOOL_VERIFIED    — "did it, in fact, stay inside its
 *                                  frontmatter-declared read-only tool
 *                                  grant, checked at SubagentStop?"
 *
 * A role can be true on 0, 1, 2, or 3 axes independently. This module does
 * NOT collapse them. It re-exports axis 2 from role-write-allowlists.js
 * (the existing single source for that axis) rather than hand-copying it,
 * so the two can never silently diverge again.
 *
 * This module changes NO gate behaviour by itself — it is inert until the
 * three consumers are wired to import from it (see the integration note in
 * the delivering commit / PM handoff). Do not treat its existence as the
 * fix; the fix is the wiring, which touches files this task was explicitly
 * forbidden from editing.
 */

const { RESTRICTED_ROLES: WRITE_PATH_RESTRICTED_ROLES } = require('./role-write-allowlists');

// ---------------------------------------------------------------------------
// Axis 1 — destructive-git block (mirrors gate-developer-git.js READ_ONLY_ROLES
// verbatim as of this release; read from the live file, not the v2.3.31 audit
// doc, since the audit doc's own snapshot matches this list exactly here).
// ---------------------------------------------------------------------------
const GIT_DESTRUCTIVE_BLOCKED_ROLES = new Set([
  'reviewer', 'debugger', 'researcher', 'ux-critic', 'platform-oracle', 'project-intent',
]);

// ---------------------------------------------------------------------------
// Axis 2 — write-path restriction. Re-exported, not copied: role-write-allowlists.js
// remains the single source of truth for which roles are gated and what their
// allowlist is. Live set today: reviewer, tester, documenter, release-manager,
// debugger.
// ---------------------------------------------------------------------------
// (WRITE_PATH_RESTRICTED_ROLES imported above.)

// ---------------------------------------------------------------------------
// Axis 3 — runtime tool-grant verification at SubagentStop/TaskCompleted.
// Mirrors validate-task-completion.js READ_ONLY_AGENTS verbatim as of this
// release (haiku-scout, orchestray-housekeeper, project-intent — all three
// have a frontmatter `tools:` line that grants no Write/Edit/Bash/Glob/Grep,
// so this axis verifies the runtime call log matches that declared grant).
// `reviewer` and `debugger` declare themselves read-only in prose in their
// own agents/*.md but are NOT in this set — nothing currently verifies their
// contract at Stop time. That gap is intentional to surface, not to silently
// close (see integration note).
// ---------------------------------------------------------------------------
const RUNTIME_TOOL_VERIFIED_ROLES = new Set([
  'haiku-scout', 'orchestray-housekeeper', 'project-intent',
]);

/**
 * Roles whose agents/*.md frontmatter `tools:` line grants Write but who are
 * on axis 1 (git-destructive blocked) and NOT on axis 2 (write-path
 * restricted) — i.e. they can write to any path in the working tree with no
 * allowlist, despite being treated as "read-only" for git purposes.
 * Derived by hand from agents/*.md frontmatter as of this release; not
 * auto-computed (this module does not scan the filesystem, matching the
 * existing role-schemas.js convention of hardcoded role tables).
 *
 * This is a GAP LIST, not a policy. Nothing in this module or its consumers
 * enforces anything from this set — it exists so the reconciliation gap is
 * named in code instead of only in prose. See handoff issues for the
 * sign-off-required recommendation.
 */
const GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES = new Set([
  'researcher', 'ux-critic', 'platform-oracle',
  // NOTE: project-intent is also git-blocked-but-write-allowlist-absent, but
  // its frontmatter tools: line grants Read only (no Write), so axis 3
  // already prevents it from writing anywhere. Deliberately excluded from
  // this set — it is not an unrestricted-write role in practice.
]);

/**
 * Returns the reconciled axis membership for a single role.
 *
 * @param {string} role
 * @returns {{
 *   gitDestructiveBlocked: boolean,
 *   writePathRestricted: boolean,
 *   runtimeToolVerified: boolean,
 *   writeUnrestrictedGap: boolean
 * }}
 */
function getRoleAxes(role) {
  const r = String(role || '');
  return {
    gitDestructiveBlocked: GIT_DESTRUCTIVE_BLOCKED_ROLES.has(r),
    writePathRestricted: WRITE_PATH_RESTRICTED_ROLES.has(r),
    runtimeToolVerified: RUNTIME_TOOL_VERIFIED_ROLES.has(r),
    writeUnrestrictedGap: GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES.has(r),
  };
}

/**
 * True if `role` is on at least one read-only-style axis. Convenience for
 * callers that want a single "is this role special at all" check without
 * caring which axis. Prefer getRoleAxes() for anything that branches on
 * WHICH axis — collapsing to a boolean here is exactly the merge this
 * module's header explains is wrong for gating decisions.
 *
 * @param {string} role
 * @returns {boolean}
 */
function isReadOnlyOnAnyAxis(role) {
  const axes = getRoleAxes(role);
  return axes.gitDestructiveBlocked || axes.writePathRestricted || axes.runtimeToolVerified;
}

module.exports = {
  GIT_DESTRUCTIVE_BLOCKED_ROLES,
  WRITE_PATH_RESTRICTED_ROLES,
  RUNTIME_TOOL_VERIFIED_ROLES,
  GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES,
  getRoleAxes,
  isReadOnlyOnAnyAxis,
};
