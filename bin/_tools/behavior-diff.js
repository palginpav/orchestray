#!/usr/bin/env node
'use strict';

/**
 * behavior-diff.js — the Behavior Diff Gate replay harness (v2.3.18 W5b,
 * Proposal 2).
 *
 * ## The failure mode
 *
 * A reviewer reads the diff and reasons about it. It never runs the changed
 * code against a single real input, so it catches "this looks wrong" and misses
 * "this returns 2 instead of 0 when `transcript_path` is absent" — which is the
 * failure that actually reaches the user. Orchestray's own history is that
 * shape end to end: `hook_double_fire_detected` (62), `state_file_corrupt`
 * (184), `transcript_path_containment_failed` (23). Every one is a hook
 * behaving differently than its author believed on an input shape they did not
 * consider.
 *
 * We are unusually exposed *and* unusually well suited to the fix: most of our
 * `bin/*.js` scripts are pure-ish functions of `stdin JSON` -> `(exit code,
 * stderr, emitted audit events)`. That is a golden-master test bed.
 *
 * ## How it works
 *
 *   1. `bin/_lib/hook-stdin.js` harvests real hook inputs, deduplicated by
 *      *shape* (`fixture-shape.js`) rather than value, so a corpus is tens of
 *      fixtures per script rather than thousands.
 *   2. This harness replays every changed script against its corpus on both the
 *      baseline commit (a throwaway `git worktree`) and the working tree.
 *   3. It diffs the observation `{code, events, stderr_class}` and reports.
 *
 * Zero model involvement, zero LLM tokens.
 *
 * ## Two findings from the §2.4 prototype run — both are load-bearing
 *
 *   1. **A fixture is `{stdin, state}`, not `stdin`.** Replaying a stdin-only
 *      fixture in a fresh sandbox made every hook fail open and every
 *      observation collapse to `{0, [], ''}` — including for an input that
 *      should have tripped the gate. `observe()` materialises `state` into the
 *      sandbox; a fixture without it is rejected.
 *   2. **`uncovered: true`, never `deltas: []`.** If every fixture for a script
 *      yields the trivial observation on *both* sides, the script was never
 *      exercised. Reporting that as "no deltas" makes BDG a false-negative
 *      machine that reports green while testing nothing. Corpus health
 *      (`covered_scripts / scripts_with_fixtures`) is a first-class metric,
 *      surfaced in `/orchestray:doctor`.
 *
 * There is deliberately **no static analysis of JavaScript anywhere** in this
 * file. Design §4.3 measured a regex-based approach at 20/20 false positives
 * across two iterations; behavior is observed by running the code, never by
 * reading it.
 *
 * ## CLI
 *
 *   node bin/_tools/behavior-diff.js [--base HEAD] [--json] [--only bin/foo.js]
 *   node bin/_tools/behavior-diff.js --coverage [--json]
 *
 *   exit 0 = no deltas (or gate not blocking) | 1 = deltas found | 2 = harness error
 *
 * Kill switches: `ORCHESTRAY_BEHAVIOR_DIFF_DISABLED=1`,
 * `behavior_diff_gate.enabled: false`, `behavior_diff_gate.block: false`
 * (telemetry only), `ORCHESTRAY_FIXTURE_HARVEST=0` (stop collecting).
 *
 * ## Declaring an intentional delta
 *
 * A commit body line `Behavior-Change: <script> <reason>` (script = the full
 * repo-relative path, e.g. `bin/foo.js`; reason mandatory) marks that
 * script's delta as declared for every commit in `base..HEAD`, excluding it
 * from `blocked`. See `parseDeclarations`/`loadDeclarations`.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  observationOf,
  isTrivialObservation,
  observationEquals,
  isFixture,
} = require('../_lib/fixture-shape');

const SCHEMA_VERSION = 1;

/** Per-fixture child-process budget. A wedged hook must not wedge the harness. */
const RUN_TIMEOUT_MS = 10000;

/** Fixtures replayed per script per side. Guards against a runaway corpus. */
const MAX_FIXTURES_PER_SCRIPT = 40;

/** Scripts replayed in one run when `--only` is not given. */
const MAX_SCRIPTS = 40;

const DEFAULT_RAMP_THRESHOLD = 3;

const FIXTURE_DIRNAME = ['.orchestray', 'fixtures'];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * `behavior_diff_gate` config. Fail-open to defaults.
 *
 * @param {string} cwd
 * @returns {{enabled:boolean, harvest:boolean, block:boolean,
 *            max_fixtures_per_script:number, ramp:number}}
 */
function loadConfig(cwd) {
  const defaults = {
    enabled: true,
    harvest: true,
    block: true,
    max_fixtures_per_script: MAX_FIXTURES_PER_SCRIPT,
    ramp: DEFAULT_RAMP_THRESHOLD,
  };
  let section;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    section = parsed && parsed.behavior_diff_gate;
  } catch (_e) { return defaults; }
  if (!section || typeof section !== 'object') return defaults;
  return {
    enabled: typeof section.enabled === 'boolean' ? section.enabled : defaults.enabled,
    harvest: typeof section.harvest === 'boolean' ? section.harvest : defaults.harvest,
    block: typeof section.block === 'boolean' ? section.block : defaults.block,
    max_fixtures_per_script: Number.isFinite(section.max_fixtures_per_script)
      ? section.max_fixtures_per_script : defaults.max_fixtures_per_script,
    ramp: Number.isFinite(section.ramp) && section.ramp >= 0 ? section.ramp : defaults.ramp,
  };
}

function isDisabled(cfg) {
  return process.env.ORCHESTRAY_BEHAVIOR_DIFF_DISABLED === '1' || !cfg.enabled;
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function fixtureDir(repoRoot, rel) {
  return path.join(repoRoot, ...FIXTURE_DIRNAME, path.basename(rel, '.js'));
}

/**
 * Load a script's fixtures. Malformed files and bare-payload fixtures (no
 * `state`) are skipped and counted, never replayed — see the §2.4 finding.
 *
 * @param {string} repoRoot
 * @param {string} rel
 * @param {number} [cap]
 * @returns {{fixtures: {name: string, fixture: object}[], invalid: number}}
 */
function loadFixtures(repoRoot, rel, cap) {
  const dir = fixtureDir(repoRoot, rel);
  const out = [];
  let invalid = 0;
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (_e) { return { fixtures: [], invalid: 0 }; }
  const limit = Number.isFinite(cap) ? cap : MAX_FIXTURES_PER_SCRIPT;
  for (const name of names.slice(0, limit)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch (_e) { invalid++; continue; }
    if (!isFixture(parsed)) { invalid++; continue; }
    out.push({ name, fixture: parsed });
  }
  return { fixtures: out, invalid };
}

/** Scripts that have a fixture directory with at least one file. */
function scriptsWithFixtures(repoRoot) {
  const root = path.join(repoRoot, ...FIXTURE_DIRNAME);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch (_e) { return out; }
  for (const name of names.sort()) {
    try {
      const dir = path.join(root, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (fs.readdirSync(dir).some((f) => f.endsWith('.json'))) out.push(name);
    } catch (_e) { /* skip */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

/**
 * Materialise a fixture's `state` snapshot into a sandbox.
 * Names are basenames only — a fixture must not be able to write outside.
 */
function materialiseState(sandbox, state) {
  const stateDir = path.join(sandbox, '.orchestray', 'state');
  for (const [name, content] of Object.entries(state || {})) {
    const base = path.basename(String(name));
    if (!base || base === '.' || base === '..') continue;
    try {
      fs.writeFileSync(path.join(stateDir, base),
        typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
    } catch (_e) { /* one unwritable entry must not abort the replay */ }
  }
}

/**
 * Run one script against one fixture in an isolated cwd.
 *
 * @param {string} scriptPath — absolute path to the script under observation.
 * @param {object} fixture — `{stdin, state}`.
 * @returns {{code:number, events:string[], stderr_class:string}}
 */
function observe(scriptPath, fixture) {
  let sandbox;
  try {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-'));
  } catch (_e) {
    return observationOf({ code: 99, stderr: 'sandbox_create_failed' });
  }
  try {
    fs.mkdirSync(path.join(sandbox, '.orchestray', 'state'), { recursive: true });
    fs.mkdirSync(path.join(sandbox, '.orchestray', 'audit'), { recursive: true });
    materialiseState(sandbox, fixture && fixture.state);

    let code = 0;
    let stderr = '';
    try {
      execFileSync(process.execPath, [scriptPath], {
        input: JSON.stringify((fixture && fixture.stdin) || {}),
        cwd: sandbox,
        timeout: RUN_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
          CLAUDE_PROJECT_DIR: sandbox,
          ORCHESTRAY_FIXTURE_HARVEST: '0',            // replays must not feed the corpus
          ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP: '1',   // dedup would suppress the 2nd side
        }),
      });
    } catch (e) {
      code = typeof e.status === 'number' ? e.status : 99;
      stderr = String((e && e.stderr) || '');
    }

    let events = [];
    try {
      events = fs.readFileSync(path.join(sandbox, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => { try { const p = JSON.parse(l); return p.type || p.event_type || '?'; } catch (_e) { return '?'; } });
    } catch (_e) { /* no events emitted */ }

    return observationOf({ code, events, stderr });
  } catch (_e) {
    return observationOf({ code: 99, stderr: 'observe_failed' });
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Replay one script on both sides.
 *
 * `uncovered` is the important field: it is true when the corpus is empty, when
 * every fixture was malformed, OR when every fixture produced the trivial
 * observation on both sides. In none of those cases did we learn anything, and
 * saying `deltas: []` would be a lie of omission.
 *
 * @param {string} rel — repo-relative script path, e.g. `bin/foo.js`.
 * @param {string} repoRoot
 * @param {string} baselineRoot
 * @param {object} [opts]
 * @returns {{script:string, fixtures:number, invalid:number, deltas:object[],
 *            uncovered:boolean, reason:?string}}
 */
function diffScript(rel, repoRoot, baselineRoot, opts) {
  const options = opts || {};
  const observeFn = options.observe || observe;
  const { fixtures, invalid } = loadFixtures(repoRoot, rel, options.maxFixtures);

  if (fixtures.length === 0) {
    return {
      script: rel, fixtures: 0, invalid, deltas: [], uncovered: true,
      reason: invalid > 0 ? 'fixtures_invalid' : 'no_fixtures',
    };
  }

  const basePath = path.join(baselineRoot, rel);
  const workPath = path.join(repoRoot, rel);
  const deltas = [];
  let exercised = false;

  for (const { name, fixture } of fixtures) {
    const before = fs.existsSync(basePath)
      ? observeFn(basePath, fixture)
      : observationOf({ code: 0, events: [], stderr: '' });
    const after = observeFn(workPath, fixture);
    if (!isTrivialObservation(before) || !isTrivialObservation(after)) exercised = true;
    if (!observationEquals(before, after)) deltas.push({ fixture: name, before, after });
  }

  if (!exercised) {
    // Every fixture fail-opened on both sides — the script was never exercised.
    return {
      script: rel, fixtures: fixtures.length, invalid, deltas: [],
      uncovered: true, reason: 'all_observations_trivial',
    };
  }
  return { script: rel, fixtures: fixtures.length, invalid, deltas, uncovered: false, reason: null };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Corpus health: `covered_scripts / scripts_with_fixtures`.
 *
 * Without this the fixture corpus rots silently and the gate degrades to noise
 * — a script whose fixtures all fail-open reports green forever. `covered`
 * counts scripts with at least one well-formed `{stdin, state}` fixture.
 *
 * Cheap by default (no replay); pass `deep: true` to actually run each script
 * and count only scripts that produce a non-trivial observation.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @returns {{scripts_with_fixtures:number, covered_scripts:number, ratio:number,
 *            total_fixtures:number, invalid_fixtures:number, uncovered:string[]}}
 */
function coverage(repoRoot, opts) {
  const options = opts || {};
  const names = scriptsWithFixtures(repoRoot);
  let covered = 0;
  let totalFixtures = 0;
  let invalidFixtures = 0;
  const uncovered = [];

  for (const name of names) {
    const rel = path.join('bin', name + '.js');
    const { fixtures, invalid } = loadFixtures(repoRoot, rel, options.maxFixtures);
    totalFixtures += fixtures.length;
    invalidFixtures += invalid;

    let ok = fixtures.length > 0;
    if (ok && options.deep) {
      const scriptPath = path.join(repoRoot, rel);
      const observeFn = options.observe || observe;
      ok = fixtures.some((f) => !isTrivialObservation(observeFn(scriptPath, f.fixture)));
    }
    if (ok) covered++;
    else uncovered.push(name);
  }

  return {
    scripts_with_fixtures: names.length,
    covered_scripts: covered,
    ratio: names.length === 0 ? 0 : +(covered / names.length).toFixed(3),
    total_fixtures: totalFixtures,
    invalid_fixtures: invalidFixtures,
    uncovered: uncovered.slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Baseline worktree
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------------------
// Behavior-Change declarations
// ---------------------------------------------------------------------------

/** One or more whitespace chars, used to split the trailer's script token from its reason. */
const WS_RE = /\s/;

/**
 * Parse `Behavior-Change: <script> <reason>` trailers out of commit body text.
 *
 * Matching is by the EXACT repo-relative script path (e.g. `bin/foo.js`), not
 * a bare basename — accepting a basename would let a declaration for
 * `bin/a/foo.js` silently also cover an unrelated `bin/b/foo.js`. The caller
 * (`run()`) matches `declared.get(delta.script)` verbatim.
 *
 * A trailer with no reason (or a reason that is only whitespace) is NOT a
 * valid declaration — it is collected in `malformed` so the caller can warn
 * rather than silently accept or silently drop it.
 *
 * @param {string} body — one or more commit bodies concatenated by `%B`.
 * @returns {{declared: Map<string, string[]>, malformed: string[]}}
 */
function parseDeclarations(body) {
  const declared = new Map();
  const malformed = [];
  for (const rawLine of String(body || '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('Behavior-Change:')) continue;
    const rest = line.slice('Behavior-Change:'.length).trim();
    const sp = rest.search(WS_RE);
    const script = sp === -1 ? rest : rest.slice(0, sp);
    const reason = sp === -1 ? '' : rest.slice(sp).trim();
    if (!script || !reason) { malformed.push(line); continue; }
    if (!declared.has(script)) declared.set(script, []);
    declared.get(script).push(reason);
  }
  return { declared, malformed };
}

/**
 * Behavior-Change declarations from commit bodies in `base..HEAD`. Fail-open:
 * an unusable range (no git, base not an ancestor, `base === HEAD` with no
 * commits between) yields no declarations rather than throwing — a harness
 * bug here must not be the reason a real delta goes unreported.
 *
 * @param {string} repoRoot
 * @param {string} base
 * @returns {{declared: Map<string, string[]>, malformed: string[]}}
 */
function loadDeclarations(repoRoot, base) {
  let body;
  try {
    body = git(repoRoot, ['log', base + '..HEAD', '--format=%B']);
  } catch (_e) {
    return { declared: new Map(), malformed: [] };
  }
  return parseDeclarations(body);
}

/** Declarations naming a script with no matching delta — a typo'd path or a delta that vanished. */
function markUnmatchedDeclarations(report, declarations) {
  for (const script of declarations.declared.keys()) {
    const s = report.scripts.find((x) => x.script === script);
    if (!s || s.deltas.length === 0) report.unmatched_declarations.push(script);
  }
}

/**
 * Changed `bin/*.js` scripts relative to `base`, including untracked.
 *
 * @param {string} repoRoot
 * @param {string} base
 * @returns {string[]}
 */
function changedScripts(repoRoot, base) {
  const out = new Set();
  const collect = (args) => {
    try {
      for (const line of git(repoRoot, args).split('\n')) {
        const f = line.trim();
        if (/^bin\/.*\.js$/.test(f) && !/\/(__tests__|_tests)\//.test(f)) out.add(f);
      }
    } catch (_e) { /* fail-open: an unavailable git yields no scripts, not a crash */ }
  };
  collect(['diff', '--name-only', base]);
  collect(['ls-files', '--others', '--exclude-standard']);
  return [...out].slice(0, MAX_SCRIPTS);
}

/**
 * `git worktree add` never carries gitignored `node_modules/` — every script
 * that transitively `require()`s an npm package (e.g. `zod` via
 * `_lib/config-schema.js`) would crash to load on the baseline side, faking a
 * behavior delta on EVERY fixture rather than reporting the real one. A
 * symlink is O(1) (no copy) and lets Node's normal upward node_modules walk
 * from the worktree find the real repo's install. Best-effort: if the repo
 * itself has no node_modules (never installed), both sides already fail
 * identically and this is a no-op, not a new failure mode.
 *
 * @param {string} repoRoot
 * @param {string} worktreeDir
 */
function linkNodeModules(repoRoot, worktreeDir) {
  const src = path.join(repoRoot, 'node_modules');
  const dest = path.join(worktreeDir, 'node_modules');
  try {
    if (fs.existsSync(src) && !fs.existsSync(dest)) fs.symlinkSync(src, dest, 'dir');
  } catch (_e) { /* best-effort — a missing symlink surfaces as a delta, not a crash */ }
}

/**
 * Detached worktree at `base`. Caller must call `cleanup()`.
 *
 * @param {string} repoRoot
 * @param {string} base
 * @returns {{root: string, cleanup: Function}}
 */
function createBaselineWorktree(repoRoot, base) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-base-'));
  git(repoRoot, ['worktree', 'add', '--detach', dir, base]);
  linkNodeModules(repoRoot, dir);
  return {
    root: dir,
    cleanup() {
      try { git(repoRoot, ['worktree', 'remove', '--force', dir]); } catch (_e) { /* best-effort */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
    },
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Full replay across the changed scripts. `delta_count` (and thus `blocked`)
 * excludes deltas covered by a `Behavior-Change:` trailer in `base..HEAD`;
 * those are counted separately in `declared_delta_count` and marked
 * `declared: true` on their `scripts[]` entry — see `parseDeclarations`.
 *
 * @param {object} [opts]
 * @returns {{schema_version:number, base:string, scripts:object[], delta_count:number,
 *            declared_delta_count:number, uncovered_count:number, coverage:object,
 *            blocked:boolean, unmatched_declarations:string[],
 *            malformed_declarations:string[], ramp:object}}
 */
function run(opts) {
  const options = opts || {};
  const repoRoot = options.cwd || process.cwd();
  const base = options.base || 'HEAD';
  const cfg = options.config || loadConfig(repoRoot);

  const only = options.only && options.only.length ? options.only : null;
  const scripts = only || changedScripts(repoRoot, base);
  const declarations = options.declarations || loadDeclarations(repoRoot, base);

  const report = {
    schema_version: SCHEMA_VERSION,
    base,
    generated_at: new Date().toISOString(),
    scripts: [],
    delta_count: 0,
    declared_delta_count: 0,
    uncovered_count: 0,
    coverage: coverage(repoRoot, { maxFixtures: cfg.max_fixtures_per_script }),
    blocked: false,
    unmatched_declarations: [],
    malformed_declarations: declarations.malformed,
    ramp: { threshold: rampThreshold(cfg), count: null, state: 'not_applicable' },
  };

  if (scripts.length === 0) {
    markUnmatchedDeclarations(report, declarations);
    return report;
  }

  let worktree = null;
  try {
    worktree = options.baselineRoot
      ? { root: options.baselineRoot, cleanup() {} }
      : createBaselineWorktree(repoRoot, base);
  } catch (_e) {
    // Fail-open: no baseline means nothing to compare against, not a failure.
    report.error = 'baseline_worktree_failed';
    return report;
  }

  try {
    for (const rel of scripts) {
      const result = diffScript(rel, repoRoot, worktree.root, {
        observe: options.observe,
        maxFixtures: cfg.max_fixtures_per_script,
      });
      const reasons = declarations.declared.get(rel);
      result.declared = !!(reasons && result.deltas.length > 0);
      result.declared_reason = result.declared ? reasons.join('; ') : null;
      report.scripts.push(result);
      if (result.declared) report.declared_delta_count += result.deltas.length;
      else report.delta_count += result.deltas.length;
      if (result.uncovered) report.uncovered_count++;
    }
  } finally {
    worktree.cleanup();
  }

  markUnmatchedDeclarations(report, declarations);
  report.blocked = cfg.block && report.delta_count > 0;
  return report;
}

function rampThreshold(cfg) {
  const n = parseInt(process.env.ORCHESTRAY_BEHAVIOR_DIFF_RAMP_THRESHOLD, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return cfg.ramp;
}

/**
 * Emit the falsifiability signals: `behavior_diff_unexpected` is the event that
 * must be non-zero and map to real bugs for BDG to be earning its keep, and
 * flat-zero-forever is the documented kill condition (the corpus lacks the
 * inputs that matter). Best-effort — telemetry never changes the verdict.
 *
 * @param {string} repoRoot
 * @param {object} report
 */
function emitRunEvent(repoRoot, report) {
  try {
    const { writeEvent } = require('../_lib/audit-event-writer');
    const cov = report.coverage || {};
    writeEvent({
      type: report.delta_count > 0 ? 'behavior_diff_unexpected' : 'behavior_diff_clean',
      version: SCHEMA_VERSION,
      schema_version: SCHEMA_VERSION,
      base: report.base,
      scripts_replayed: report.scripts.length,
      delta_count: report.delta_count,
      uncovered_count: report.uncovered_count,
      covered_scripts: cov.covered_scripts || 0,
      scripts_with_fixtures: cov.scripts_with_fixtures || 0,
      coverage_ratio: cov.ratio || 0,
      blocked: !!report.blocked,
      scripts: report.scripts.filter((s) => s.deltas.length > 0).map((s) => s.script).slice(0, 10),
    }, { cwd: repoRoot });
  } catch (_e) { /* fail-open */ }
}

/**
 * Persist the report for the reviewer injector to pick up. Best-effort.
 *
 * @param {string} repoRoot
 * @param {object} report
 */
function writeReport(repoRoot, report) {
  try {
    const file = path.join(repoRoot, '.orchestray', 'state', 'behavior-diff.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(report, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return file;
  } catch (_e) { return null; }
}

function renderText(report) {
  const lines = [];
  const cov = report.coverage;
  lines.push('Behavior Diff Gate — base ' + report.base);
  lines.push('  corpus: ' + cov.covered_scripts + '/' + cov.scripts_with_fixtures +
    ' scripts covered (' + cov.total_fixtures + ' fixtures' +
    (cov.invalid_fixtures ? ', ' + cov.invalid_fixtures + ' invalid' : '') + ')');
  if (report.error) lines.push('  harness: ' + report.error + ' (fail-open)');
  if (report.scripts.length === 0) lines.push('  no changed bin/*.js scripts to replay');
  for (const s of report.scripts) {
    if (s.uncovered) {
      lines.push('  [UNCOVERED] ' + s.script + ' — ' + s.reason +
        ' (NOT "no change": nothing was exercised)');
      continue;
    }
    if (s.deltas.length === 0) { lines.push('  [SAME]      ' + s.script + ' (' + s.fixtures + ' fixtures)'); continue; }
    if (s.declared) {
      lines.push('  [DECLARED]  ' + s.script + ' — ' + s.deltas.length + ' of ' + s.fixtures +
        ' fixtures differ — ' + s.declared_reason);
      continue;
    }
    lines.push('  [DELTA]     ' + s.script + ' — ' + s.deltas.length + ' of ' + s.fixtures + ' fixtures differ');
    for (const d of s.deltas.slice(0, 5)) {
      lines.push('      ' + d.fixture + ': code ' + d.before.code + '->' + d.after.code +
        ', events [' + d.before.events.join(',') + ']->[' + d.after.events.join(',') + ']' +
        (d.before.stderr_class !== d.after.stderr_class
          ? ', stderr "' + d.before.stderr_class + '"->"' + d.after.stderr_class + '"' : ''));
    }
  }
  for (const m of report.malformed_declarations || []) {
    lines.push('  [WARN]      malformed `Behavior-Change:` trailer (no reason given): ' + m);
  }
  for (const s of report.unmatched_declarations || []) {
    lines.push('  [WARN]      `Behavior-Change:` declared for ' + s + ' but no matching delta was found ' +
      '(typo\'d path, or the delta no longer exists?)');
  }
  const declaredNote = report.declared_delta_count ? ' (' + report.declared_delta_count + ' declared, excluded)' : '';
  lines.push(report.delta_count === 0
    ? '  result: no unexplained behavior deltas' + declaredNote
    : '  result: ' + report.delta_count + ' unexplained behavior delta(s)' + declaredNote +
      (report.blocked ? ' — declare intentional changes with a `Behavior-Change: <script> <reason>` line in the ' +
        'commit body (script must be the full repo-relative path, reason mandatory)'
                      : ' (telemetry only — behavior_diff_gate.block is false)'));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { base: 'HEAD', json: false, only: [], coverage: false, deep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--coverage') out.coverage = true;
    else if (a === '--deep') out.deep = true;
    else if (a === '--base') out.base = argv[++i] || 'HEAD';
    else if (a.startsWith('--base=')) out.base = a.slice(7);
    else if (a === '--only') out.only.push(argv[++i]);
    else if (a.startsWith('--only=')) out.only.push(a.slice(7));
  }
  out.only = out.only.filter(Boolean);
  return out;
}

function main(argv) {
  const args = parseArgs(argv || process.argv.slice(2));
  const repoRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = loadConfig(repoRoot);

  if (isDisabled(cfg)) {
    if (args.json) process.stdout.write(JSON.stringify({ disabled: true }) + '\n');
    else process.stdout.write('Behavior Diff Gate disabled (kill switch).\n');
    return 0;
  }

  if (args.coverage) {
    const cov = coverage(repoRoot, { deep: args.deep, maxFixtures: cfg.max_fixtures_per_script });
    if (args.json) process.stdout.write(JSON.stringify(cov) + '\n');
    else {
      process.stdout.write('BDG corpus: ' + cov.covered_scripts + '/' + cov.scripts_with_fixtures +
        ' scripts covered (ratio ' + cov.ratio + '), ' + cov.total_fixtures + ' fixtures\n');
    }
    return 0;
  }

  let report;
  try {
    report = run({ cwd: repoRoot, base: args.base, only: args.only, config: cfg });
  } catch (e) {
    process.stderr.write('[orchestray] behavior-diff: harness error — ' +
      String((e && e.message) || e).slice(0, 200) + '\n');
    return 2;   // fail-open callers ignore 2
  }

  writeReport(repoRoot, report);
  emitRunEvent(repoRoot, report);
  process.stdout.write((args.json ? JSON.stringify(report, null, 2) : renderText(report)) + '\n');
  return report.delta_count > 0 && cfg.block ? 1 : 0;
}

if (require.main === module) {
  let code = 2;
  try { code = main(); } catch (_e) { code = 2; }
  process.exit(code);
}

module.exports = {
  main,
  run,
  observe,
  diffScript,
  coverage,
  loadFixtures,
  scriptsWithFixtures,
  changedScripts,
  createBaselineWorktree,
  linkNodeModules,
  materialiseState,
  parseDeclarations,
  loadDeclarations,
  loadConfig,
  isDisabled,
  rampThreshold,
  parseArgs,
  renderText,
  writeReport,
  emitRunEvent,
  fixtureDir,
  SCHEMA_VERSION,
  MAX_FIXTURES_PER_SCRIPT,
};
