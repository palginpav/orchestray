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
    // v2.3.12 W14 (M2): narrowed from the over-broad '*.md' + '**/*.md' (which
    // matched agents/pm.md and CLAUDE.md — the enforcement substrate). Doc writes
    // scope to docs/**, the root README/CHANGELOG, and the KB artifacts dir
    // (legit findings output, same as reviewer/debugger). RESTRICTED_WRITE_DENYLIST
    // still blocks `agents/*.md` and CLAUDE.md for this role.
    'docs/**',
    'README*',
    'CHANGELOG*',
    '.orchestray/kb/artifacts/**.md',
    // WIP (2026-09-02): documenter could not reach agents/pm-reference/**, which is
    // where 48 of this repo's 49 reference documents live — `docs/` holds exactly one
    // file. A v2.3.35 doc sweep stalled on exactly this and had to be finished by the
    // PM. Added for PARITY, not as a new grant: developer, architect, refactorer and
    // inventor are absent from RESTRICTED_ROLES entirely, so gate-role-write-paths
    // already lets them write these files unchecked. The documenter was the only role
    // scoped to documentation and the only one that could not edit it.
    //
    // Top-level `agents/*.md` (the agent prompts) remain denied for this role via
    // RESTRICTED_WRITE_DENYLIST — that boundary is unchanged and still enforced.
    'agents/pm-reference/**.md',
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
  // v2.3.31 W9: three roles closed the "git-blocked but write-unrestricted" gap
  // named in bin/_lib/read-only-roles.js GIT_BLOCKED_BUT_WRITE_UNRESTRICTED_ROLES.
  // Each allowlist below is derived from the role's own agents/<role>.md
  // artifact-writing contract, not assumed:
  researcher: [
    // agents/researcher.md §4.1: "Write to `.orchestray/kb/artifacts/researcher-<slug>.md`"
    '.orchestray/kb/artifacts/**.md',
  ],
  'ux-critic': [
    // agents/ux-critic.md Step 6: "Write the Findings Artifact ... `.orchestray/kb/
    // artifacts/<orch-id>-ux-findings.md`"
    '.orchestray/kb/artifacts/**.md',
  ],
  'platform-oracle': [
    // agents/platform-oracle.md has no documented write target — its answer is
    // returned inline, and line 201 assigns platform prose to the documenter.
    // An empty (deny-all) allowlist would be the strictest reading, but it is
    // also the largest possible widening (unrestricted -> zero) and contradicts
    // the Write tool the role is still granted: any future write instruction
    // would fail closed with no signal at authoring time. Scoping it to the same
    // KB-artifacts path as its sibling read-tier roles bounds the blast radius
    // identically while staying consistent with the granted tool. Revisit if the
    // Write grant is ever removed from the frontmatter.
    '.orchestray/kb/artifacts/**.md',
  ],
};

/**
 * Roles that are subject to write gating.
 * Developer, architect, inventor, refactorer, researcher are NOT gated —
 * they legitimately need broad write access.
 */
const RESTRICTED_ROLES = new Set(Object.keys(ROLE_WRITE_ALLOWLISTS));

/**
 * v2.3.31 W9: researcher/ux-critic/platform-oracle are a WIDENING — they were
 * previously absent from RESTRICTED_ROLES entirely (unrestricted write access
 * despite being destructive-git-blocked). Per project policy every widening
 * ships with its own kill switch, checked separately from the pre-existing
 * ORCHESTRAY_ROLE_WRITE_GATE_DISABLED (which would also revert the five
 * pre-W9 roles — too broad for "restore just this widening").
 *
 * Kill switch: ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED=1 — restores the
 * pre-W9 behaviour (unrestricted write) for exactly these three roles; the
 * other five restricted roles are unaffected.
 */
const V231_W9_NEWLY_RESTRICTED_ROLES = new Set(['researcher', 'ux-critic', 'platform-oracle']);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isResearchTierWriteGateEnabled(env) {
  env = env || process.env;
  if (env.ORCHESTRAY_RESEARCH_TIER_WRITE_GATE_DISABLED === '1') return false;
  return true;
}

/**
 * True when `role` is currently subject to write-path gating, accounting for
 * the v2.3.31 W9 per-widening kill switch. Prefer this over a raw
 * `RESTRICTED_ROLES.has(role)` check at any gate call site.
 *
 * @param {string} role
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isWriteRestricted(role, env) {
  const r = String(role || '');
  if (!RESTRICTED_ROLES.has(r)) return false;
  if (V231_W9_NEWLY_RESTRICTED_ROLES.has(r) && !isResearchTierWriteGateEnabled(env)) return false;
  return true;
}

/**
 * v2.3.12 W14 (M2): hard write-denylist applied to ALL restricted roles BEFORE
 * the per-role allowlist. These are the "enforcement substrate" — files whose
 * contents shape other agents' behavior. A doc/test/review-tier role must never
 * rewrite them, even if a future allowlist edit would otherwise permit it.
 *
 * Scoped precisely:
 *   - `agents/*.md` matches the agent DEFINITION prompts (agents/pm.md,
 *     agents/developer.md, …) but NOT `agents/pm-reference/**` — so the
 *     release-manager keeps its legitimate event-schemas.md write.
 *   - `CLAUDE.md` is the project instruction substrate.
 *
 * Kill switch: ORCHESTRAY_ROLE_WRITE_SUBSTRATE_DENY_DISABLED=1.
 */
const RESTRICTED_WRITE_DENYLIST = [
  'agents/*.md',
  'CLAUDE.md',
];

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

// v2.3.12 W14 (M2): compiled substrate denylist (root-anchored, same semantics).
const COMPILED_DENYLIST = RESTRICTED_WRITE_DENYLIST.map(compileGlob);

/**
 * True when `relPath` targets the enforcement substrate and the deny kill switch
 * is not set. Checked by the gate BEFORE the per-role allowlist.
 *
 * @param {string} relPath - project-relative path
 * @returns {boolean}
 */
function isSubstrateDenied(relPath) {
  if (process.env.ORCHESTRAY_ROLE_WRITE_SUBSTRATE_DENY_DISABLED === '1') return false;
  const p = String(relPath || '');
  return COMPILED_DENYLIST.some(re => re.test(p));
}

module.exports = {
  ROLE_WRITE_ALLOWLISTS,
  RESTRICTED_ROLES,
  RESTRICTED_WRITE_DENYLIST,
  COMPILED_DENYLIST,
  isSubstrateDenied,
  compileGlob,
  COMPILED_ALLOWLISTS,
  V231_W9_NEWLY_RESTRICTED_ROLES,
  isResearchTierWriteGateEnabled,
  isWriteRestricted,
  // Test-only export: gives the unit test direct access to the compiled regex
  // map so it can assert root-anchoring without re-importing the gate's
  // private cache. Stable; documented in T8-W1-path-traversal-block.md.
  __test__: { COMPILED_ALLOWLISTS, compileGlob },
};
