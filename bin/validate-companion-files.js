#!/usr/bin/env node
'use strict';

/**
 * validate-companion-files.js — SubagentStop hook (v2.3.18, Co-change Oracle).
 *
 * A reviewer reads the diff that exists and cannot see the file that isn't
 * there. Negative space is invisible to diff review by construction. This gate
 * supplies it: for every file the spawn actually touched, it asks the repo's own
 * history whether a companion file is near-obligatory, and blocks when a
 * holdout-validated obligation was left half-done.
 *
 * Reads `git diff --name-only` rather than trusting the agent's self-reported
 * `files_changed` for *what changed*: the tree is the witness, the report is
 * testimony. (`bin/validate-reviewer-git-diff.js` establishes this pattern.)
 * `files_changed` is still consulted for *attribution* — SubagentStop fires
 * against a repo-wide worktree, so without it a spawn inherits every
 * uncommitted edit in the tree, including ones made before it started.
 * Attribution decides what may *block*, not whether the gate runs at all: a
 * write-capable role that reports nothing against a dirty tree is still
 * evaluated, advisory-only, so the self-report cannot switch the gate off.
 * Read-only roles are skipped outright (see READ_ONLY_ROLES).
 *
 * **Blocks only on `enforcement: 'block'` rules** — mined on the oldest 2/3 of
 * history AND re-confirmed on the newest 1/3. Advisory rules are reported and
 * never block. Expect this to fire rarely (2 qualifying rules on today's
 * history) with recall growing as history accumulates: high precision / low
 * recall is the correct posture for something that exits 2.
 *
 * Escape hatch: name the companion in the Structured Result's `assumptions`.
 * An exception that is stated is not a failure; an exception that is silent is.
 *
 * Kill switches:
 *   ORCHESTRAY_COCHANGE_DISABLED=1                — full bypass
 *   config cochange_oracle.enabled=false          — full bypass
 *   config cochange_oracle.companion_gate='advisory' — telemetry only
 *   ORCHESTRAY_COCHANGE_RAMP_THRESHOLD=N          — override the ramp
 *
 * Ramp counters: .orchestray/state/companion-warn-count-<orch-id>.json
 *   — one counter per `role|file->companion`, not one per orchestration.
 *
 * Events emitted:
 *   companion_files_ok       — nothing missing (or nothing changed)
 *   companion_files_advisory — nothing blocking, but advisory rules matched
 *   companion_file_missing   — missing companions, ramp open or advisory
 *   companion_files_blocked  — missing companions, ramp exhausted, exit 2
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { readHookInputRaw }  = require('./_lib/hook-stdin');
const { extractStructuredResult } = require('./_lib/claim-rules');
const { getGraph, companionsOf }  = require('./_lib/cochange-graph');

const SCHEMA_VERSION = 1;
const DEFAULT_RAMP_THRESHOLD = 3;
const DEFAULT_MIN_CONF = 0.8;
const DEFAULT_MIN_SUPPORT = 5;

/** Cap the findings carried into the event and the message. */
const MAX_REPORTED = 10;

/** A diff this wide is a sweep; per-file obligations stop meaning anything. */
const MAX_CHANGED_FILES = 200;

/**
 * Roles that cannot write source files at all (`bin/gate-role-write-paths.js`
 * enforces it). The gate's only remedy is "update the companion" or "state the
 * exception" — the first is forbidden to these roles, and a read-only agent
 * being told to justify someone else's half-finished change is noise. They are
 * skipped outright.
 */
const READ_ONLY_ROLES = new Set([
  'reviewer', 'security-engineer', 'ux-critic', 'platform-oracle',
  'project-intent', 'researcher', 'debugger',
]);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Load the `cochange_oracle` config section. Fail-open to defaults.
 *
 * @param {string} cwd
 * @returns {{enabled:boolean, companion_gate:string, seam_gate:string,
 *            min_conf:number, min_support:number, ramp:number}}
 */
function loadConfig(cwd) {
  const defaults = {
    enabled: true,
    companion_gate: 'block',
    seam_gate: 'advisory',
    min_conf: DEFAULT_MIN_CONF,
    min_support: DEFAULT_MIN_SUPPORT,
    ramp: DEFAULT_RAMP_THRESHOLD,
  };
  let section;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    section = parsed && parsed.cochange_oracle;
  } catch (_e) { return defaults; }
  if (!section || typeof section !== 'object') return defaults;
  return {
    enabled: typeof section.enabled === 'boolean' ? section.enabled : defaults.enabled,
    companion_gate: typeof section.companion_gate === 'string'
      ? section.companion_gate : defaults.companion_gate,
    seam_gate: typeof section.seam_gate === 'string' ? section.seam_gate : defaults.seam_gate,
    min_conf: Number.isFinite(section.min_conf) ? section.min_conf : defaults.min_conf,
    min_support: Number.isFinite(section.min_support) ? section.min_support : defaults.min_support,
    ramp: Number.isFinite(section.ramp) && section.ramp >= 0 ? section.ramp : defaults.ramp,
  };
}

function rampThreshold(cfg) {
  const n = parseInt(process.env.ORCHESTRAY_COCHANGE_RAMP_THRESHOLD, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return cfg.ramp;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Files modified in the working tree relative to HEAD, plus untracked files.
 * Untracked matter: a companion that was never created is exactly the miss this
 * gate exists to catch, and its absence is only visible against the index.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function changedFiles(cwd) {
  const out = new Set();
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (_e) { return ''; }
  };
  for (const line of run(['diff', '--name-only', 'HEAD']).split('\n')) {
    const f = line.trim();
    if (f) out.add(f);
  }
  for (const line of run(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const f = line.trim();
    if (f) out.add(f);
  }
  return [...out];
}

/**
 * Normalise a self-reported path to a repo-relative POSIX path.
 *
 * `files_changed` entries are `{path, description}` objects per the handoff
 * contract, but bare strings appear in the wild; absolute paths do too.
 *
 * @param {string|{path:string}} entry
 * @param {string} cwd
 * @returns {string|null}
 */
function normalizeReportedPath(entry, cwd) {
  const raw = typeof entry === 'string'
    ? entry
    : (entry && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : '');
  if (!raw) return null;
  let p = raw.trim().replace(/\\/g, '/');
  if (!p) return null;
  if (path.isAbsolute(raw)) {
    const rel = path.relative(cwd, raw).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return null;
    p = rel;
  }
  return p.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * The subset of the dirty worktree this spawn actually claims to have written.
 *
 * `git diff` remains the witness that a file changed — self-report alone is
 * still not trusted — but attribution needs the report: a SubagentStop fires
 * against the whole repo, so without this intersection every spawn inherits
 * every uncommitted edit anyone made, including edits that predate it.
 *
 * @param {object} event
 * @param {string[]} changed  paths from `git diff` / `ls-files --others`
 * @param {string} cwd
 * @returns {string[]|null}  null = the spawn reported nothing to attribute
 */
function ownedChangedFiles(event, changed, cwd) {
  const sr = extractStructuredResult(event);
  if (!sr || !Array.isArray(sr.files_changed)) return null;

  const reported = new Set();
  for (const entry of sr.files_changed) {
    const p = normalizeReportedPath(entry, cwd);
    if (p) reported.add(p);
  }
  if (reported.size === 0) return [];
  return changed.filter(f => reported.has(String(f).replace(/^\.\//, '')));
}

/**
 * Missing companions across the changed set.
 *
 * `present` defaults to `changed`, and is passed separately when the source set
 * is narrowed to one spawn's own writes: a companion updated by a sibling
 * spawn still clears the obligation, even though this spawn did not write it.
 *
 * @param {string[]} changed
 * @param {object} graph
 * @param {{min_conf:number, min_support:number}} cfg
 * @param {string[]} [present]
 * @returns {{blocking: object[], advisory: object[]}}
 */
function findMissing(changed, graph, cfg, present) {
  const changedSet = new Set(present || changed);
  const blocking = [];
  const advisory = [];
  const seen = new Set();
  for (const f of changed) {
    for (const r of companionsOf(graph, f)) {
      if (changedSet.has(r.companion)) continue;
      const key = f + ' -> ' + r.companion;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = {
        file: f, companion: r.companion, conf: r.conf,
        support: r.support, enforcement: r.enforcement,
      };
      const qualifies = r.enforcement === 'block' &&
        r.conf >= cfg.min_conf && r.support >= cfg.min_support;
      (qualifies ? blocking : advisory).push(row);
    }
  }
  return { blocking, advisory };
}

/**
 * Companions the agent explicitly accounted for in its `assumptions`.
 * A stated exception is a decision; a silent one is a miss.
 *
 * @param {object} event
 * @returns {string[]} lowercased assumption text lines
 */
function statedExceptions(event) {
  const sr = extractStructuredResult(event);
  const lines = [];
  if (sr && Array.isArray(sr.assumptions)) {
    for (const a of sr.assumptions) if (typeof a === 'string') lines.push(a.toLowerCase());
  }
  return lines;
}

/** True when some assumption line names this companion path. */
function isWaived(row, exceptionLines) {
  if (exceptionLines.length === 0) return false;
  const full = String(row.companion).toLowerCase();
  const base = path.basename(full);
  return exceptionLines.some((l) => l.includes(full) || (base.length > 3 && l.includes(base)));
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function resolveOrchId(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(getCurrentOrchestrationFile(cwd), 'utf8'));
    return parsed.orchestration_id || parsed.id || null;
  } catch (_e) { return null; }
}

function safeSlug(id) {
  return String(id || 'no-orch').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

function counterFilePath(cwd, orchId) {
  return path.join(cwd, '.orchestray', 'state', 'companion-warn-count-' + safeSlug(orchId) + '.json');
}

/** Ramp bucket for a finding: one budget per role per co-change rule. */
function rampKey(role, row) {
  return (role || 'unknown') + '|' + row.file + '->' + row.companion;
}

/**
 * Bump one ramp counter per key and return the new counts.
 *
 * Keyed per rule rather than per orchestration: a single shared counter meant
 * three findings of any kind exhausted the budget for every later spawn, so the
 * first occurrence of a brand-new obligation hard-blocked with no warning.
 *
 * @param {string} cwd
 * @param {string} orchId
 * @param {string[]} keys
 * @returns {Object<string, number>}
 */
function bumpWarnCounts(cwd, orchId, keys) {
  const filePath = counterFilePath(cwd, orchId);
  let counts = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) counts = parsed;
  } catch (_e) { /* fresh counter */ }

  const out = {};
  for (const key of keys) {
    const prev = Number.isFinite(counts[key]) && counts[key] >= 0 ? counts[key] : 0;
    counts[key] = prev + 1;
    out[key] = counts[key];
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(counts) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (_e) { /* best-effort */ }
  return out;
}

function emitGateEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate one spawn. Pure apart from `git diff` and the graph cache read.
 *
 * @param {object} event
 * @param {string} cwd
 * @param {object} cfg
 * @param {object} [injected] — `{graph, changed, owned}` for tests.
 * @returns {{changed:number, blocking:object[], advisory:object[], waived:object[],
 *            rules:number, skipped:(string|null)}}
 */
function evaluateSpawn(event, cwd, cfg, injected) {
  const inj = injected || {};
  const nothing = (skipped, n) => ({
    changed: n || 0, blocking: [], advisory: [], waived: [], rules: 0, skipped,
  });

  const role = String((event && (event.subagent_type || event.agent_type || event.agent_role)) || '')
    .toLowerCase().trim();
  if (READ_ONLY_ROLES.has(role)) return nothing('read_only_role');

  const changed = inj.changed || changedFiles(cwd);
  if (changed.length === 0) return nothing('no_changes', 0);
  if (changed.length > MAX_CHANGED_FILES) return nothing('sweep', changed.length);

  // Attribution: the worktree is repo-wide and a SubagentStop says nothing
  // about who dirtied it. Only the files this spawn reported writing are its
  // obligations; presence of a companion is still judged against the whole tree.
  const owned = inj.owned !== undefined ? inj.owned : ownedChangedFiles(event, changed, cwd);
  const attributed = owned !== null && owned.length > 0;

  // noBuild: SubagentStop is a hot path — a stale graph is better than a git log walk.
  const graph = inj.graph || getGraph(cwd, { noBuild: true });
  const { blocking, advisory } = findMissing(attributed ? owned : changed, graph, cfg, changed);

  // An unattributed spawn is still evaluated. Returning early here meant a
  // write-capable role could dirty the tree, report `files_changed: []`, and
  // skip the gate outright — the self-report gating the gate, in a file whose
  // whole premise is that the tree is the witness. Read-only roles already
  // returned above, so everything reaching this point can write.
  //
  // Advisory, never blocking: without attribution the changes may belong to a
  // sibling spawn, and charging this agent for those is the false positive the
  // attribution step was added to stop. Telemetry is the floor, not silence.
  if (!attributed) {
    return {
      changed: changed.length,
      blocking: [],
      advisory: advisory.concat(blocking),
      waived: [],
      rules: graph && graph.rule_count ? graph.rule_count : 0,
      skipped: owned === null ? 'unattributed_evaluated' : 'none_attributed_evaluated',
    };
  }

  const exceptions = statedExceptions(event);
  const waived = [];
  const enforced = [];
  for (const row of blocking) {
    if (isWaived(row, exceptions)) waived.push(row);
    else enforced.push(row);
  }
  return {
    changed: owned.length,
    blocking: enforced,
    advisory,
    waived,
    rules: graph && graph.rule_count ? graph.rule_count : 0,
    skipped: null,
  };
}

function failureMessage(rows) {
  const lines = rows.slice(0, MAX_REPORTED).map((m) => (
    '  ' + m.file + '\n' +
    '     -> also expected: ' + m.companion +
    '  (conf ' + m.conf + ', ' + m.support + ' commits)'
  ));
  return (
    '[orchestray] validate-companion-files: BLOCKED — companion files not updated.\n' +
    'In this repo\'s history these change together:\n\n' +
    lines.join('\n') + '\n\n' +
    'Update them, or state in your Structured Result `assumptions` why this change\n' +
    'is an exception — naming the companion path is enough.\n' +
    'Kill switch: ORCHESTRAY_COCHANGE_DISABLED=1\n'
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function allow() {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
}

/**
 * `--build-cache` mode: mine the graph when stale, then exit 0 without reading
 * stdin. Wired on SessionStart so the SubagentStop hot path only ever reads a
 * cache it did not have to build.
 *
 * @returns {number} exit code (always 0 — mining never blocks a session)
 */
function buildCacheMode() {
  if (process.env.ORCHESTRAY_COCHANGE_DISABLED === '1') return 0;
  let cwd;
  try { cwd = resolveSafeCwd(process.env.CLAUDE_PROJECT_DIR); } catch (_e) { cwd = process.cwd(); }
  try {
    const cfg = loadConfig(cwd);
    if (!cfg.enabled) return 0;
    const graph = getGraph(cwd, { force: process.argv.includes('--force') });
    emitGateEvent(cwd, {
      type: 'cochange_graph_built',
      version: SCHEMA_VERSION,
      schema_version: SCHEMA_VERSION,
      rule_count: graph.rule_count || 0,
      block_count: graph.block_count || 0,
      commits_scanned: graph.commits_scanned || 0,
    });
  } catch (_e) { /* fail-open */ }
  return 0;
}

function main() {
  if (process.argv.includes('--build-cache')) {
    process.exit(buildCacheMode());
  }
  if (process.env.ORCHESTRAY_COCHANGE_DISABLED === '1') allow();

  const input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) allow();

  setImmediate(() => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_e) { allow(); return; }

    if ((event.hook_event_name || '') !== 'SubagentStop') allow();

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

    const cfg = loadConfig(cwd);
    if (!cfg.enabled || cfg.companion_gate === 'off') allow();

    const result = evaluateSpawn(event, cwd, cfg);
    const orchId = resolveOrchId(cwd);

    const base = {
      version:          SCHEMA_VERSION,
      schema_version:   SCHEMA_VERSION,
      agent_role:       String(event.subagent_type || event.agent_type || event.agent_role || 'unknown').toLowerCase(),
      changed_count:    result.changed,
      missing_count:    result.blocking.length,
      advisory_count:   result.advisory.length,
      waived_count:     result.waived.length,
      rule_count:       result.rules,
      missing:          result.blocking.slice(0, MAX_REPORTED),
      orchestration_id: orchId,
    };

    if (result.blocking.length === 0) {
      // "ok" means clean. An unattributed spawn always lands here, so labelling
      // a run that *did* surface advisory findings "ok" hid every one of them
      // behind the same event type as a spotless diff.
      if (result.advisory.length > 0) {
        emitGateEvent(cwd, Object.assign({ type: 'companion_files_advisory' }, base, {
          advisory: result.advisory.slice(0, MAX_REPORTED),
        }));
      } else {
        emitGateEvent(cwd, Object.assign({ type: 'companion_files_ok' }, base));
      }
      allow();
      return;
    }

    const threshold = rampThreshold(cfg);
    const role = base.agent_role;
    // Each finding draws on its own `role|rule` budget — a first-ever miss is
    // never blocked by warnings some earlier spawn spent on a different rule.
    const counts = orchId
      ? bumpWarnCounts(cwd, orchId, result.blocking.map((m) => rampKey(role, m)))
      : null;
    const countFor = (m) => (counts === null ? null : counts[rampKey(role, m)]);
    const exhausted = result.blocking.filter((m) => countFor(m) !== null && countFor(m) > threshold);
    const maxCount = counts === null
      ? null
      : result.blocking.reduce((acc, m) => Math.max(acc, countFor(m) || 0), 0);
    const blocks = cfg.companion_gate === 'block';

    if (!blocks || exhausted.length === 0) {
      emitGateEvent(cwd, Object.assign({
        type:           'companion_file_missing',
        ramp_count:     maxCount,
        ramp_threshold: threshold,
        ramp_state:     !blocks ? 'telemetry_only' : (counts === null ? 'no_orchestration' : 'warn'),
      }, base));
      process.stderr.write(
        '[orchestray] validate-companion-files: WARN' +
        (maxCount === null ? '' : ' (' + maxCount + '/' + threshold + ')') +
        ' — ' + result.blocking.length + ' companion file(s) not updated: ' +
        result.blocking.slice(0, 3).map((m) => m.companion).join(', ') + '. ' +
        'Kill switch: ORCHESTRAY_COCHANGE_DISABLED=1\n'
      );
      allow();
      return;
    }

    emitGateEvent(cwd, Object.assign({
      type:           'companion_files_blocked',
      ramp_count:     maxCount,
      ramp_threshold: threshold,
      // 'blocked', not 'block' — the other four ramp gates emit 'blocked', and
      // analytics grouping on that value silently dropped every companion block.
      ramp_state:     'blocked',
    }, base, { missing_count: exhausted.length, missing: exhausted.slice(0, MAX_REPORTED) }));
    process.stderr.write(failureMessage(exhausted));
    // A machine-readable reason alongside the human one, as every other
    // blocking gate emits — exiting 2 with an empty stdout leaves the caller
    // nothing to branch on.
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'companion_files_blocked:' +
        exhausted.slice(0, MAX_REPORTED).map((m) => m.file + '->' + m.companion).join(','),
    }));
    process.exit(2);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  buildCacheMode,
  changedFiles,
  ownedChangedFiles,
  normalizeReportedPath,
  findMissing,
  evaluateSpawn,
  statedExceptions,
  isWaived,
  loadConfig,
  rampThreshold,
  rampKey,
  bumpWarnCounts,
  counterFilePath,
  failureMessage,
  READ_ONLY_ROLES,
  SCHEMA_VERSION,
};
