'use strict';

/**
 * read-only-roles.js — canonical source of truth for "read-only role" state
 * across the enforcement surface (v2.3.32, W4 finding #2 reconciliation;
 * widened v2.3.31 W9 with operator sign-off — see below).
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
 * Bash; `tester`/`documenter` need write-path restriction and (as of W9)
 * git-destructive restriction, but neither is "read-only" — both legitimately
 * commit their own W-items; `haiku-scout` needs neither git nor write-path
 * logic because its frontmatter grants no Write/Edit/Bash at all — its axis
 * is "verify the tool grant was honored at Stop time." Each axis answers a
 * different question:
 *
 *   1. GIT_DESTRUCTIVE_BLOCKED  — "may it run the 5 destructive working-tree
 *                                  git verbs (stash/clean/checkout-files/
 *                                  restore/reset --hard), ever?" This is NOT
 *                                  a proxy for "read-only" — `git commit` and
 *                                  `git push` are untouched by this axis, so
 *                                  a role can be on it and still commit its
 *                                  own work (tester, documenter).
 *   2. WRITE_PATH_RESTRICTED    — "where on disk may it Write/Edit?"
 *   3. RUNTIME_TOOL_VERIFIED    — "did it, in fact, stay inside its
 *                                  frontmatter-declared read-only tool
 *                                  grant, checked at SubagentStop?" (zero
 *                                  writes expected)
 *   4. ALLOWLIST_VERIFIED       — "did every Write/Edit it made, in fact,
 *                                  land inside its axis-2 allowlist, checked
 *                                  at SubagentStop?" (writes expected, but
 *                                  scoped — distinct from axis 3, which
 *                                  expects zero writes)
 *
 * A role can be true on any subset of axes independently. This module does
 * NOT collapse them. It re-exports axis 2 from role-write-allowlists.js
 * (the existing single source for that axis) rather than hand-copying it,
 * so the two can never silently diverge again.
 *
 * v2.3.31 W9 — three widenings, operator-approved:
 *   - researcher/ux-critic/platform-oracle gained axis 2 (write-path
 *     restriction). Closes the GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES gap
 *     this module named but deliberately did not fix in the W6 delivery —
 *     the scope-lock on that task forbade widening any gate's blocking
 *     scope without explicit sign-off. The operator has now given it; the
 *     allowlists live in role-write-allowlists.js with per-role evidence
 *     comments, gated by ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED.
 *   - tester/documenter gained axis 1 (git-destructive block), gated by
 *     ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED. Both still commit and
 *     push freely — axis 1 never touches those verbs (see the axis-1
 *     description above).
 *   - reviewer/debugger gained axis 4 (allowlist verification), a NEW axis
 *     distinct from axis 3: both write real KB artifacts (so a zero-writes
 *     check would false-positive), but every write must land inside their
 *     existing axis-2 allowlist. Gated by
 *     ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED.
 */

const {
  RESTRICTED_ROLES: WRITE_PATH_RESTRICTED_ROLES,
  isWriteRestricted,
} = require('./role-write-allowlists');

// ---------------------------------------------------------------------------
// Axis 1 — destructive-git block (mirrors gate-developer-git.js READ_ONLY_ROLES
// verbatim as of this release; read from the live file, not the v2.3.31 audit
// doc, since the audit doc's own snapshot matches this list exactly here).
//
// v2.3.31 W9: tester and documenter added — see module header. Both were
// write-path-restricted (axis 2) but had no reason to run the 5 destructive
// working-tree git verbs; git commit/push remain unaffected for both.
// ---------------------------------------------------------------------------
const GIT_DESTRUCTIVE_BLOCKED_ROLES = new Set([
  'reviewer', 'debugger', 'researcher', 'ux-critic', 'platform-oracle', 'project-intent',
  'tester', 'documenter',
]);

/**
 * v2.3.31 W9 widening subset of GIT_DESTRUCTIVE_BLOCKED_ROLES, gated by its
 * own kill switch (narrower than ORCHESTRAY_GIT_GATE_DISABLED, which would
 * also revert the pre-W9 six roles).
 */
const V231_W9_GIT_DESTRUCTIVE_BLOCKED_ROLES = new Set(['tester', 'documenter']);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isTesterDocumenterGitBlockEnabled(env) {
  env = env || process.env;
  if (env.ORCHESTRAY_TESTER_DOCUMENTER_GIT_BLOCK_DISABLED === '1') return false;
  return true;
}

/**
 * True when `role` is currently subject to the destructive-git block,
 * accounting for the v2.3.31 W9 per-widening kill switch. Prefer this over a
 * raw `GIT_DESTRUCTIVE_BLOCKED_ROLES.has(role)` check at any gate call site.
 *
 * @param {string} role
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isGitDestructiveBlocked(role, env) {
  const r = String(role || '');
  if (!GIT_DESTRUCTIVE_BLOCKED_ROLES.has(r)) return false;
  if (V231_W9_GIT_DESTRUCTIVE_BLOCKED_ROLES.has(r) && !isTesterDocumenterGitBlockEnabled(env)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Axis 2 — write-path restriction. Re-exported, not copied: role-write-allowlists.js
// remains the single source of truth for which roles are gated and what their
// allowlist is. Live set today: reviewer, tester, documenter, release-manager,
// debugger, researcher, ux-critic, platform-oracle (last three added v2.3.31 W9).
// `isWriteRestricted` is also re-exported — it layers the W9 kill switch on
// top of Set membership and is what gate-role-write-paths.js should call.
// ---------------------------------------------------------------------------
// (WRITE_PATH_RESTRICTED_ROLES, isWriteRestricted imported above.)

// ---------------------------------------------------------------------------
// Axis 3 — runtime tool-grant verification at SubagentStop/TaskCompleted.
// Mirrors validate-task-completion.js READ_ONLY_AGENTS verbatim as of this
// release (haiku-scout, orchestray-housekeeper, project-intent — all three
// have a frontmatter `tools:` line that grants no Write/Edit/Bash/Glob/Grep,
// so this axis verifies the runtime call log matches that declared grant —
// i.e. it expects ZERO writes). `reviewer` and `debugger` are NOT on this
// axis — both legitimately write KB artifacts, so a zero-writes check would
// always fail for them. See axis 4 below, which is their equivalent.
// ---------------------------------------------------------------------------
const RUNTIME_TOOL_VERIFIED_ROLES = new Set([
  'haiku-scout', 'orchestray-housekeeper', 'project-intent',
]);

// ---------------------------------------------------------------------------
// Axis 4 — allowlist-scoped write verification at SubagentStop (v2.3.31 W9).
// Distinct check SHAPE from axis 3: axis 3 asserts zero writes; axis 4
// asserts every Write/Edit/MultiEdit target the agent actually invoked falls
// inside its axis-2 ROLE_WRITE_ALLOWLISTS entry. `reviewer` and `debugger`
// declare themselves read-only in prose but are gated in real time by
// gate-role-write-paths.js (PreToolUse) already — this is a Stop-time
// backstop, not the primary enforcement, so it stays cheap: it re-uses
// ROLE_WRITE_ALLOWLISTS rather than duplicating any path list.
// ---------------------------------------------------------------------------
const ALLOWLIST_VERIFIED_ROLES = new Set(['reviewer', 'debugger']);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isAllowlistVerifiedGateEnabled(env) {
  env = env || process.env;
  if (env.ORCHESTRAY_ALLOWLIST_VERIFIED_ROLES_DISABLED === '1') return false;
  return true;
}

/**
 * @param {string} role
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isAllowlistVerified(role, env) {
  const r = String(role || '');
  if (!ALLOWLIST_VERIFIED_ROLES.has(r)) return false;
  return isAllowlistVerifiedGateEnabled(env);
}

/**
 * Returns the reconciled axis membership for a single role.
 *
 * @param {string} role
 * @returns {{
 *   gitDestructiveBlocked: boolean,
 *   writePathRestricted: boolean,
 *   runtimeToolVerified: boolean,
 *   allowlistVerified: boolean
 * }}
 */
function getRoleAxes(role) {
  const r = String(role || '');
  return {
    gitDestructiveBlocked: GIT_DESTRUCTIVE_BLOCKED_ROLES.has(r),
    writePathRestricted: WRITE_PATH_RESTRICTED_ROLES.has(r),
    runtimeToolVerified: RUNTIME_TOOL_VERIFIED_ROLES.has(r),
    allowlistVerified: ALLOWLIST_VERIFIED_ROLES.has(r),
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
  return axes.gitDestructiveBlocked || axes.writePathRestricted ||
    axes.runtimeToolVerified || axes.allowlistVerified;
}

module.exports = {
  GIT_DESTRUCTIVE_BLOCKED_ROLES,
  WRITE_PATH_RESTRICTED_ROLES,
  RUNTIME_TOOL_VERIFIED_ROLES,
  ALLOWLIST_VERIFIED_ROLES,
  V231_W9_GIT_DESTRUCTIVE_BLOCKED_ROLES,
  isTesterDocumenterGitBlockEnabled,
  isGitDestructiveBlocked,
  isWriteRestricted,
  isAllowlistVerifiedGateEnabled,
  isAllowlistVerified,
  getRoleAxes,
  isReadOnlyOnAnyAxis,
};
