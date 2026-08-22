'use strict';

/**
 * team-lead-roles.js — canonical source of truth for "team lead role" state
 * (v2.3.31 W8A).
 *
 * BACKGROUND: gate-developer-git.js's `wt_destructive_git` pattern carries
 * `alsoBlockWhenMainCheckout: true`, which extends the destructive-git block
 * (stash/clean/checkout-files/restore/reset) to ALL roles — including the PM
 * — whenever the target repo is the shared main checkout. The PM is already
 * exempted from every role-based rule (see the `role === 'pm'` branch in
 * gate-developer-git.js) but that branch deliberately falls through to the
 * main-checkout check, so the PM alone was still blocked from these 5 verbs
 * in the one place it most needs them (recovering/managing the shared tree
 * as the operator's proxy).
 *
 * This module names that distinction as its own axis — "team lead" — rather
 * than folding it into READ_ONLY_ROLES/GIT_DESTRUCTIVE_BLOCKED_ROLES (see the
 * sibling module `bin/_lib/read-only-roles.js` for the established pattern of
 * keeping genuinely distinct axes separate rather than merging them).
 *
 * A team-lead role acts as an operator proxy, not a sandboxed worker: it is
 * trusted to run any command, including destructive git in the shared main
 * checkout, because it IS the orchestrator directing the other roles this
 * file gates. Today the only team-lead role is `pm`.
 *
 * Kill switch: ORCHESTRAY_TEAM_LEAD_GIT_EXEMPTION_DISABLED=1 — disables the
 * exemption entirely; team-lead roles then fall back to today's behaviour
 * (blocked in the shared main checkout, same as any other role subject to
 * `alsoBlockWhenMainCheckout`).
 */

/**
 * Roles that act as operator proxy rather than sandboxed worker.
 * @type {Set<string>}
 */
const TEAM_LEAD_ROLES = new Set(['pm']);

/**
 * Normalises `role` (trim + lowercase, tolerant of null/undefined/non-string)
 * and returns whether it is a team-lead role.
 *
 * @param {string|null|undefined} role
 * @returns {boolean}
 */
function isTeamLead(role) {
  if (typeof role !== 'string') return false;
  const normalized = role.trim().toLowerCase();
  if (!normalized) return false;
  return TEAM_LEAD_ROLES.has(normalized);
}

/**
 * Returns whether the team-lead git exemption is enabled.
 *
 * Precedence (highest first):
 *   1. env ORCHESTRAY_TEAM_LEAD_GIT_EXEMPTION_DISABLED=1 -> disabled (false)
 *   2. config.team_lead.git_exemption_enabled === false  -> disabled (false)
 *   3. default -> enabled (true) — new functionality ships default-on per
 *      project policy (feedback_default_on_shipping.md).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {object} [config]
 * @returns {boolean}
 */
function isTeamLeadExemptionEnabled(env, config) {
  // Local MUST stay named `env`: kill-switch-parity.js detects reads via an
  // `env.NAME` shape, so renaming it hides the switch from the fence.
  env = env || {};
  if (env.ORCHESTRAY_TEAM_LEAD_GIT_EXEMPTION_DISABLED === '1') return false;
  if (config && typeof config === 'object' &&
      config.team_lead && typeof config.team_lead === 'object' &&
      config.team_lead.git_exemption_enabled === false) {
    return false;
  }
  return true;
}

module.exports = {
  TEAM_LEAD_ROLES,
  isTeamLead,
  isTeamLeadExemptionEnabled,
};
