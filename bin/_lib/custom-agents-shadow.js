'use strict';

/**
 * custom-agents-shadow.js — identify Arena v0 stubs shadowed by a
 * versioned sibling so the spawn registry exposes only the validated
 * `*-arena-vN` agents by default.
 *
 * Workflow context:
 *   `arena-create` writes an initial draft `<slug>.md` (v0) which the
 *   user iterates on through sparring rounds. `arena-emit` produces
 *   `<slug>-arena-v<N>.md` once the agent passes validation. Both
 *   files validate as legitimate custom agents, but exposing the v0
 *   stub alongside the v1 final clutters the registry and makes
 *   `subagent_type` selection ambiguous. By default we hide the v0
 *   when a versioned sibling exists; the user can opt back in via
 *   `custom_agents.show_arena_v0_stubs: true` in config or
 *   `ORCHESTRAY_SHOW_ARENA_V0_STUBS=1` in env.
 */

const ARENA_VERSIONED_RE = /^(.+)-arena-v\d+$/;

/**
 * Split records into visible vs shadowed (v0 stubs that have a
 * versioned sibling).
 *
 * @param {Array<{name: string}>} records
 * @returns {{visible: Array<object>, hidden: Array<object>}}
 */
function filterShadowedArenaV0s(records) {
  const recs = Array.isArray(records) ? records : [];
  const versionedBases = new Set();
  for (const r of recs) {
    if (!r || typeof r.name !== 'string') continue;
    const m = ARENA_VERSIONED_RE.exec(r.name);
    if (m) versionedBases.add(m[1]);
  }
  const visible = [];
  const hidden  = [];
  for (const r of recs) {
    if (r && typeof r.name === 'string' && versionedBases.has(r.name)) {
      hidden.push(r);
    } else {
      visible.push(r);
    }
  }
  return { visible, hidden };
}

module.exports = { filterShadowedArenaV0s, ARENA_VERSIONED_RE };
