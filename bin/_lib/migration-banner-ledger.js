'use strict';

/**
 * migration-banner-ledger.js — v2.2.21 W2-T8 (F-02 fix).
 *
 * Single source of truth for post-upgrade migration banners. Replaces the
 * 13+ unconditional `process.stderr.write` calls in post-upgrade-sweep.js
 * with a version-keyed ledger + filter + collapse-summary dispatch.
 *
 * INVARIANTS:
 *   - Banners fire only when `prevVersion < introducedIn` (semver).
 *   - When more than 2 banners would fire, output is collapsed to a single
 *     summary line that names the count and points the user at
 *     `/orchestray:doctor migrations` for the full list.
 *   - When `--all` (env var ORCHESTRAY_MIGRATION_BANNERS_ALL=1, or option
 *     `all: true`) is set, the collapse is bypassed and every applicable
 *     banner fires verbatim.
 *
 * SEMVER COMPARATOR: lightweight 3-component "x.y.z" comparison. Orchestray
 * versions never carry pre-release suffixes; a 10-line comparator suffices
 * over taking on the npm `semver` dependency. Falsy / malformed prevVersion
 * is treated as "older than every banner" so a fresh install with no
 * previous version still gets banners (matches prior behavior).
 *
 * BANNER CONTENT POLICY: each ledger entry below preserves the EXACT text
 * of the corresponding pre-T8 stderr block (lines 165-273 + 330 of
 * post-upgrade-sweep.js as of v2.2.20). No information loss; only filtering
 * and collapse semantics are new. Future versions append entries here.
 */

/**
 * Compare two "x.y.z" version strings.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 if a<b, 0 if equal, 1 if a>b. Malformed inputs sort
 *                   as `0.0.0` so older-than-everything semantics apply.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

function parseVersion(v) {
  if (typeof v !== 'string') return [0, 0, 0];
  const m = v.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function semverLT(a, b) { return compareVersions(a, b) < 0; }

/**
 * The migration-banner ledger. Each entry MUST carry:
 *   - id           : stable slug, used by /orchestray:doctor migrations.
 *   - introducedIn : version string. Banner fires iff prevVersion < this.
 *   - summary      : one-line headline (used in summary collapse listing).
 *   - fullText     : verbatim stderr line (no leading newline; trailing \n
 *                    appended by dispatch). Preserved exactly as it was
 *                    written inline before T8 so banner regression tests
 *                    asserting on substrings continue to pass under --all.
 *   - killSwitch?  : optional env-var or config-key string for /doctor.
 *
 * The ledger is ordered by introducedIn ascending so /doctor output reads
 * chronologically. Dispatch order matches ledger order.
 */
const MIGRATION_BANNERS = [
  {
    id: 'v2.1.7-resilience-live',
    introducedIn: '2.1.7',
    summary: 'compaction-resilience dossier is LIVE by default',
    fullText:
      '[orchestray] v2.1.7: compaction-resilience dossier is LIVE by default. ' +
      'After auto-compact, the PM re-hydrates from .orchestray/state/resilience-dossier.json. ' +
      'Disable with ORCHESTRAY_RESILIENCE_DISABLED=1 or resilience.enabled:false in .orchestray/config.json.',
    killSwitch: 'ORCHESTRAY_RESILIENCE_DISABLED=1 OR resilience.enabled:false',
  },
  {
    id: 'v2.1.14-drift-sentinel-default-off',
    introducedIn: '2.1.14',
    summary: 'enable_drift_sentinel default flipped to false',
    fullText:
      '[orchestray] v2.1.14 migration: enable_drift_sentinel default is now false. ' +
      'If you rely on drift-sentinel output, add \'"enable_drift_sentinel": true\' to ' +
      '.orchestray/config.json before your next orchestration.',
    killSwitch: '"enable_drift_sentinel": true in .orchestray/config.json',
  },
  {
    id: 'v2.1.16-auto-document-default-off',
    introducedIn: '2.1.16',
    summary: 'auto_document default flipped to false',
    fullText:
      '[orchestray] v2.1.16 migration: auto_document default is now false. ' +
      'The documenter agent no longer auto-spawns after every orchestration — ' +
      'the reviewer\'s documentation pass already audits docs drift. ' +
      'To restore prior behavior, add \'"auto_document": true\' to ' +
      '.orchestray/config.json.',
    killSwitch: '"auto_document": true in .orchestray/config.json',
  },
  {
    id: 'v2.1.16-r-at-flag',
    introducedIn: '2.1.16',
    summary: 'enable_agent_teams renamed to agent_teams.enabled',
    fullText:
      '[orchestray] v2.1.16 migration (R-AT-FLAG): the top-level "enable_agent_teams" key ' +
      'is renamed to the "agent_teams": { "enabled": ... } block. The legacy key is honored ' +
      'for one release with a deprecation warning. Default flips to OFF in v2.1.16. ' +
      'To re-enable Agent Teams, set BOTH \'"agent_teams": {"enabled": true}\' in ' +
      '.orchestray/config.json AND CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in your environment, ' +
      'then read agents/pm-reference/agent-teams-decision.md before using team mode.',
    killSwitch: 'agent_teams.enabled:true + CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1',
  },
  {
    id: 'v2.2.0-block-z',
    introducedIn: '2.2.0',
    summary: 'Block-Z prefix is enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: Block-Z prefix is enabled by default ' +
      '(caching.block_z.enabled: true). To opt out for the current session, ' +
      'set ORCHESTRAY_DISABLE_BLOCK_Z=1. Permanent disable in .orchestray/config.json.',
    killSwitch: 'ORCHESTRAY_DISABLE_BLOCK_Z=1',
  },
  {
    id: 'v2.2.0-engineered-breakpoints',
    introducedIn: '2.2.0',
    summary: '4-slot cache-breakpoint manifest is enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: 4-slot cache-breakpoint manifest is enabled by ' +
      'default (caching.engineered_breakpoints.enabled: true; strict_invariant stays ' +
      'false in v2.2.0). Kill switch: ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS=1.',
    killSwitch: 'ORCHESTRAY_DISABLE_ENGINEERED_BREAKPOINTS=1',
  },
  {
    id: 'v2.2.0-haiku-routing',
    introducedIn: '2.2.0',
    summary: 'Haiku scout for PM I/O is enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: Haiku scout for PM I/O is enabled by default ' +
      '(haiku_routing.enabled: true, scout_min_bytes: 12288). Per-session opt-out: ' +
      'ORCHESTRAY_HAIKU_ROUTING_DISABLED=1. Permanent disable in .orchestray/config.json.',
    killSwitch: 'ORCHESTRAY_HAIKU_ROUTING_DISABLED=1',
  },
  {
    id: 'v2.2.0-housekeeper',
    introducedIn: '2.2.0',
    summary: 'orchestray-housekeeper Haiku subagent is enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: orchestray-housekeeper Haiku subagent is enabled ' +
      'by default (haiku_routing.housekeeper_enabled: true). Tools FROZEN at [Read, Glob]; ' +
      'drift detector quarantines on any baseline mismatch. Per-session opt-out: ' +
      'ORCHESTRAY_HOUSEKEEPER_DISABLED=1. Permanent disable in .orchestray/config.json.',
    killSwitch: 'ORCHESTRAY_HOUSEKEEPER_DISABLED=1',
  },
  {
    id: 'v2.2.0-output-shape',
    introducedIn: '2.2.0',
    summary: 'Output Shape Pipeline is enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: Output Shape Pipeline is enabled by default ' +
      '(output_shape.enabled: true; caveman_enabled, length_cap_enabled, structured_outputs_enabled all true). ' +
      'Caveman style + length caps apply to prose-heavy roles; structured outputs flip per ' +
      'output_shape.staged_flip_allowlist (default ["researcher","tester"] in v2.2.0). ' +
      'No env override; permanent disable per flag in .orchestray/config.json.',
    killSwitch: 'output_shape.*.enabled:false in .orchestray/config.json',
  },
  {
    id: 'v2.2.0-tier2-index',
    introducedIn: '2.2.0',
    summary: 'Tier-2 chunked schema index is enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: Tier-2 chunked schema index is enabled by default ' +
      '(pm_protocol.tier2_index.enabled: true). The PM uses mcp__orchestray__schema_get for ' +
      'event-schemas.md instead of full-file Reads. ' +
      'No env override; permanent disable: set pm_protocol.tier2_index.enabled: false in .orchestray/config.json.',
    killSwitch: 'pm_protocol.tier2_index.enabled: false',
  },
  {
    id: 'v2.2.0-event-schemas-full-load-blocked',
    introducedIn: '2.2.0',
    summary: 'legacy full-file Read of event-schemas.md is BLOCKED by default',
    fullText:
      '[orchestray] v2.2.0 migration: legacy full-file Read of event-schemas.md is BLOCKED by ' +
      'default (event_schemas.full_load_disabled: true). Reads emit ' +
      'event_schemas_full_load_blocked advisory and the PM is expected to use ' +
      'mcp__orchestray__schema_get for chunked lookup. ' +
      'To restore legacy full-file Read, set event_schemas.full_load_disabled: false ' +
      'in .orchestray/config.json. No env override.',
    killSwitch: 'event_schemas.full_load_disabled: false',
  },
  {
    id: 'v2.2.0-delegation-delta',
    introducedIn: '2.2.0',
    summary: 'delegation-delta spawn-context is enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: delegation-delta spawn-context is enabled by default ' +
      '(pm_protocol.delegation_delta.enabled: true). Subsequent spawns within the same ' +
      'orchestration receive only the delta against the prior delegation prompt. ' +
      'Per-session opt-out: ORCHESTRAY_DISABLE_DELEGATION_DELTA=1. ' +
      'Permanent disable: set pm_protocol.delegation_delta.enabled: false in .orchestray/config.json.',
    killSwitch: 'ORCHESTRAY_DISABLE_DELEGATION_DELTA=1 OR pm_protocol.delegation_delta.enabled: false',
  },
  {
    id: 'v2.2.0-audit-round-archive',
    introducedIn: '2.2.0',
    summary: 'multi-round audit digests are enabled by default',
    fullText:
      '[orchestray] v2.2.0 migration: multi-round audit digests are enabled by default ' +
      '(audit.round_archive.enabled: true). Each verify-fix round closure emits ' +
      'audit_round_closed/audit_round_archived telemetry and writes a per-orchestration digest. ' +
      'No env override; permanent disable: set audit.round_archive.enabled: false in .orchestray/config.json.',
    killSwitch: 'audit.round_archive.enabled: false',
  },
];

const COLLAPSE_THRESHOLD = 2;

/**
 * Return ledger entries whose introducedIn version is strictly greater than
 * prevVersion. If prevVersion is falsy or unparseable, every banner fires
 * (treats "no previous version known" as a deep-history upgrade).
 *
 * @param {string|null|undefined} prevVersion
 * @returns {Array} subset of MIGRATION_BANNERS in ledger order.
 */
function filterByPrevVersion(prevVersion) {
  if (!prevVersion) return MIGRATION_BANNERS.slice();
  return MIGRATION_BANNERS.filter(b => semverLT(prevVersion, b.introducedIn));
}

/**
 * Dispatch banners to a stderr-like writer. Caller injects the writer so
 * tests can capture output without spawning the real sweep binary.
 *
 * @param {object} opts
 * @param {string|null} opts.prevVersion    - upgrader's previous version.
 * @param {string}      opts.currentVersion - the version being upgraded TO.
 * @param {{write:(s:string)=>void}} opts.stderr
 * @param {boolean}     [opts.all]          - bypass collapse, fire every
 *                                            applicable banner verbatim.
 *                                            ORCHESTRAY_MIGRATION_BANNERS_ALL=1
 *                                            in env also enables this.
 * @returns {{fired_count:number, summary_only:boolean, ids:string[]}}
 */
function dispatch({ prevVersion, currentVersion, stderr, all }) {
  if (!stderr || typeof stderr.write !== 'function') {
    return { fired_count: 0, summary_only: false, ids: [] };
  }
  const allFlag = all === true || process.env.ORCHESTRAY_MIGRATION_BANNERS_ALL === '1';
  const fired = filterByPrevVersion(prevVersion);

  if (fired.length === 0) {
    return { fired_count: 0, summary_only: false, ids: [] };
  }

  if (!allFlag && fired.length > COLLAPSE_THRESHOLD) {
    const prevLabel = prevVersion ? 'v' + prevVersion : 'an earlier version';
    const currLabel = currentVersion ? 'v' + currentVersion : 'this version';
    stderr.write(
      '[orchestray] ' + fired.length + ' migration notices since ' + prevLabel +
      ' (now on ' + currLabel + '). View each: /orchestray:doctor migrations\n'
    );
    return {
      fired_count: 1,
      summary_only: true,
      ids: fired.map(b => b.id),
    };
  }

  for (const banner of fired) {
    stderr.write(banner.fullText + '\n');
  }
  return {
    fired_count: fired.length,
    summary_only: false,
    ids: fired.map(b => b.id),
  };
}

module.exports = {
  MIGRATION_BANNERS,
  COLLAPSE_THRESHOLD,
  compareVersions,
  semverLT,
  filterByPrevVersion,
  dispatch,
};
