'use strict';

/**
 * cochange-graph.js — which files this repo's history says belong together
 * (v2.3.18 W5b, Co-change Oracle / Proposal 3).
 *
 * Two failure modes, one missing fact — *which files change together*:
 *
 *   - **Wrong Seam.** The PM splits a wave into parallel tasks whose
 *     `write_allowed` sets are historically coupled; the tasks then fight and
 *     the cost surfaces later as re-plans and verify-fix rounds.
 *   - **Orphaned Half-Change.** A developer edits file A and omits its
 *     near-obligatory companion B. Negative space is invisible to diff review
 *     by construction — the reviewer cannot see the file that isn't there.
 *
 * The graph is mined from `git log` alone: **zero LLM tokens**, and a wrong
 * rule self-corrects as history accumulates.
 *
 * ## Why two filters, and why the second one is the real one
 *
 * A naive miner ships `agents/documenter.md → agents/debugger.md` (conf 0.83)
 * as a rule. That is not an obligation, it is an agent-prompt sweep commit that
 * touched several sibling `.md` files at once. Design §3.2 measured both
 * filters over 492 commits:
 *
 *   1. **Sibling-sweep suppression** — drop a pair that *only* ever co-occurs
 *      in commits touching >= 3 files sharing its directory + extension.
 *      **This underdelivered.** All five `agents/*.md` sweep pairs survived it,
 *      because they also co-occur in small commits. It is a cheap pre-filter
 *      and nothing more.
 *   2. **Holdout validation** — train on the oldest 2/3 of commits, require the
 *      rule to hold again in the newest 1/3 before it may block. This is what
 *      demoted every one of those five pairs to advisory. It is the primary
 *      defence, and it is what stops a stale convention from blocking new work.
 *
 * The cost of that conservatism is honest: real obligations that simply did not
 * recur recently (`CLAUDE.md -> README.md`) also land as advisory. High
 * precision / low recall is the correct posture for something that exits 2.
 * Expect the blocking gate to fire rarely — 2 rules on today's history — with
 * recall growing as history accumulates.
 *
 * This module is pure apart from `git log` / `git rev-list` and the cache file.
 * Every path fails open: a missing or broken git returns an empty graph, and an
 * empty graph makes every consumer a no-op.
 */

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

/** Above this a commit is a sweep, not a change — it says nothing about coupling. */
const MAX_COMMIT_FILES = 15;

/** Commits scanned per build. ~1 s for 800 here. */
const DEFAULT_COMMIT_WINDOW = 800;

/** Minimum times `a` must appear before a rule keyed on it means anything. */
const MIN_SUPPORT = 4;

/** Confidence floor for a mined rule. Enforcement thresholds are config, not this. */
const MIN_CONF = 0.6;

/** Holdout is a *confirmation*, not a second training run — a looser bar is correct. */
const HOLDOUT_CONF = 0.5;

/** Rebuild once HEAD has moved further than this from the cached build point. */
const STALE_AFTER_COMMITS = 25;

/** Cap companions per file so one churn-heavy path cannot bloat the cache. */
const MAX_COMPANIONS_PER_FILE = 12;

const SCHEMA_VERSION = 1;

const CACHE_RELPATH = ['.orchestray', 'state', 'cochange-graph.json'];

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

function git(cwd, args, maxBuffer) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: maxBuffer || 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Parse `git log --name-only` into `{msg, files}` records, newest first.
 *
 * @param {string} cwd
 * @param {number} [n] — commit window.
 * @returns {{msg: string, files: string[]}[]} `[]` when git is unavailable.
 */
function readCommits(cwd, n) {
  let out;
  try {
    out = git(cwd, ['log', '-n' + (n || DEFAULT_COMMIT_WINDOW), '--name-only',
      '--no-merges', '--pretty=format:@%s'], 64 * 1024 * 1024);
  } catch (_e) {
    return [];
  }
  const commits = [];
  let cur = null;
  for (const line of String(out).split('\n')) {
    if (line.startsWith('@')) {
      if (cur) commits.push(cur);
      cur = { msg: line.slice(1), files: [] };
    } else if (line.trim() && cur) {
      cur.files.push(line.trim());
    }
  }
  if (cur) commits.push(cur);
  return commits;
}

/** Sibling bucket: same directory AND same extension. Drives filter 1. */
function sibling(f) {
  return path.dirname(f) + '|' + path.extname(f);
}

/** Release sweeps touch everything and mean nothing about coupling. */
function isSweepCommit(msg) {
  return /^\s*release:/i.test(String(msg || ''));
}

/**
 * Count solo appearances, directional co-occurrences, and whether a pair was
 * *only* ever seen inside a sibling sweep.
 *
 * @param {{msg: string, files: string[]}[]} commits
 * @returns {{solo: Map<string,number>, pair: Map<string,number>, sweepOnly: Map<string,boolean>}}
 */
function tally(commits) {
  const solo = new Map();
  const pair = new Map();
  const sweepOnly = new Map();

  for (const c of commits || []) {
    const raw = (c && c.files) || [];
    if (raw.length < 2 || raw.length > MAX_COMMIT_FILES) continue;
    if (isSweepCommit(c.msg)) continue;
    const files = [...new Set(raw)];

    // Per-commit sibling census — a pair is "swept" only when >= 3 files share its bucket.
    const sibCount = new Map();
    for (const f of files) sibCount.set(sibling(f), (sibCount.get(sibling(f)) || 0) + 1);

    for (const a of files) {
      solo.set(a, (solo.get(a) || 0) + 1);
      for (const b of files) {
        if (a === b) continue;
        const k = a + ' ' + b;
        pair.set(k, (pair.get(k) || 0) + 1);
        const isSweep = sibling(a) === sibling(b) && (sibCount.get(sibling(a)) || 0) >= 3;
        if (!sweepOnly.has(k)) sweepOnly.set(k, true);
        if (!isSweep) sweepOnly.set(k, false);   // seen outside a sweep → keep
      }
    }
  }
  return { solo, pair, sweepOnly };
}

/**
 * Directional rules: `P(b changed | a changed)`.
 *
 * @param {{solo: Map, pair: Map, sweepOnly: Map}} counts
 * @param {number} minConf
 * @param {number} [minSupport]
 * @returns {Map<string, {companion: string, conf: number, support: number}[]>}
 */
function rulesFrom(counts, minConf, minSupport) {
  const { solo, pair, sweepOnly } = counts;
  const floor = Number.isFinite(minSupport) ? minSupport : MIN_SUPPORT;
  const rules = new Map();
  for (const [k, count] of pair) {
    if (sweepOnly.get(k)) continue;                       // filter 1 (cheap pre-filter)
    const sp = k.indexOf(' ');
    const a = k.slice(0, sp);
    const b = k.slice(sp + 1);
    const support = solo.get(a) || 0;
    if (support < floor) continue;
    const conf = count / support;
    if (conf < minConf) continue;
    if (!rules.has(a)) rules.set(a, []);
    rules.get(a).push({ companion: b, conf: +conf.toFixed(3), support });
  }
  for (const [a, list] of rules) {
    list.sort((x, y) => (y.conf - x.conf) || (y.support - x.support) ||
      (x.companion < y.companion ? -1 : 1));
    if (list.length > MAX_COMPANIONS_PER_FILE) rules.set(a, list.slice(0, MAX_COMPANIONS_PER_FILE));
  }
  return rules;
}

/**
 * Build the graph with train/holdout promotion.
 *
 * `commits[0]` is newest. Train on the oldest 2/3; a rule may be marked
 * `enforcement: 'block'` only if it *also* holds on the newest 1/3.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {number} [opts.window] — commit window.
 * @param {{msg,files}[]} [opts.commits] — inject commits (tests).
 * @returns {{schema_version:number, built_at:string, head:?string, head_count:number,
 *            commits_scanned:number, rule_count:number, block_count:number, rules:object}}
 */
function build(cwd, opts) {
  const options = opts || {};
  const commits = options.commits || readCommits(cwd, options.window);
  const cut = Math.floor(commits.length / 3);
  const recent = commits.slice(0, cut);
  const older  = commits.slice(cut);

  const trained = rulesFrom(tally(older), MIN_CONF);
  const holdout = rulesFrom(tally(recent), HOLDOUT_CONF);

  const rules = {};
  let ruleCount = 0;
  let blockCount = 0;
  for (const [a, list] of trained) {
    const held = holdout.get(a) || [];
    rules[a] = list.map((r) => {
      const validated = held.some((h) => h.companion === r.companion);
      if (validated) blockCount++;
      ruleCount++;
      return Object.assign({}, r, { enforcement: validated ? 'block' : 'advisory' });
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    built_at: new Date().toISOString(),
    head: headSha(cwd),
    head_count: headCount(cwd),
    commits_scanned: commits.length,
    train_commits: older.length,
    holdout_commits: recent.length,
    rule_count: ruleCount,
    block_count: blockCount,
    rules,
  };
}

function headSha(cwd) {
  try { return git(cwd, ['rev-parse', 'HEAD']).trim() || null; } catch (_e) { return null; }
}

function headCount(cwd) {
  try {
    const n = parseInt(git(cwd, ['rev-list', '--count', 'HEAD']).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch (_e) { return 0; }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function cachePath(cwd) {
  return path.join(cwd, ...CACHE_RELPATH);
}

/** An empty graph — every consumer treats it as "no opinion". */
function emptyGraph() {
  return {
    schema_version: SCHEMA_VERSION,
    built_at: null,
    head: null,
    head_count: 0,
    commits_scanned: 0,
    rule_count: 0,
    block_count: 0,
    rules: {},
  };
}

/**
 * Read the cached graph. `null` when absent, unreadable, or the wrong shape.
 *
 * @param {string} cwd
 * @returns {?object}
 */
function loadCache(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(cwd), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.rules ||
        typeof parsed.rules !== 'object' || parsed.schema_version !== SCHEMA_VERSION) {
      return null;
    }
    return parsed;
  } catch (_e) { return null; }
}

/** Write the cache atomically. Best-effort — a failed write only costs a rebuild. */
function saveCache(cwd, graph) {
  try {
    const file = cachePath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(graph, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (_e) { return false; }
}

/**
 * True when the cache is missing, malformed, or HEAD has moved more than
 * `STALE_AFTER_COMMITS` since it was built.
 *
 * @param {?object} cached
 * @param {string} cwd
 * @returns {boolean}
 */
function isStale(cached, cwd) {
  if (!cached) return true;
  if (!cached.head) return true;
  const now = headCount(cwd);
  if (!now) return false;                       // no git → keep whatever we have
  if (cached.head === headSha(cwd)) return false;
  return Math.abs(now - (cached.head_count || 0)) > STALE_AFTER_COMMITS;
}

/**
 * Cached graph, rebuilt only when stale. Never throws.
 *
 * @param {string} cwd
 * @param {object} [opts]
 * @param {boolean} [opts.force] — rebuild regardless of staleness.
 * @param {boolean} [opts.noBuild] — return the cache or an empty graph; never mine.
 * @returns {object}
 */
function getGraph(cwd, opts) {
  const options = opts || {};
  let cached = null;
  try { cached = loadCache(cwd); } catch (_e) { cached = null; }
  if (options.noBuild) return cached || emptyGraph();
  let stale;
  try { stale = options.force || isStale(cached, cwd); } catch (_e) { stale = false; }
  if (!stale) return cached || emptyGraph();
  try {
    const fresh = build(cwd, options);
    saveCache(cwd, fresh);
    return fresh;
  } catch (_e) {
    return cached || emptyGraph();
  }
}

// ---------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------

/**
 * Companions of `file` that meet the enforcement bar.
 *
 * @param {object} graph
 * @param {string} file
 * @param {{minConf?: number, minSupport?: number, enforcement?: string}} [bar]
 * @returns {{companion: string, conf: number, support: number, enforcement: string}[]}
 */
function companionsOf(graph, file, bar) {
  const b = bar || {};
  const list = (graph && graph.rules && graph.rules[file]) || [];
  return list.filter((r) => {
    if (b.enforcement && r.enforcement !== b.enforcement) return false;
    if (Number.isFinite(b.minConf) && r.conf < b.minConf) return false;
    if (Number.isFinite(b.minSupport) && r.support < b.minSupport) return false;
    return true;
  });
}

/**
 * Glob → concrete path expansion against the paths the graph already knows.
 *
 * `write_allowed` entries are globs (`bin/_lib/**`); rule keys are concrete
 * paths. Matching against the graph's own key set avoids an fs walk entirely —
 * a path the history never saw cannot be coupled to anything.
 *
 * @param {string[]} globs
 * @param {object} graph
 * @returns {string[]}
 */
function expandOwnership(globs, graph) {
  const known = Object.keys((graph && graph.rules) || {});
  const out = new Set();
  for (const g of globs || []) {
    const spec = String(g || '').trim();
    if (!spec) continue;
    if (!/[*?[\]]/.test(spec)) { out.add(spec.replace(/^\.\//, '')); continue; }
    const re = globToRegExp(spec);
    for (const k of known) if (re.test(k)) out.add(k);
  }
  return [...out];
}

/** Minimal glob → RegExp. Supports `**`, `*`, `?`; everything else is literal. */
function globToRegExp(spec) {
  let src = '';
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '*') {
      if (spec[i + 1] === '*') { src += '.*'; i++; if (spec[i + 1] === '/') i++; }
      else src += '[^/]*';
    } else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + src + '$');
}

/**
 * Coupling between two write sets. 0..1 — the seam-gate primitive.
 *
 * Reads as "of the coupling obligations set A carries, what share point into
 * set B". 0 when A carries none, which is the common case and is why the seam
 * advisory is quiet by default.
 *
 * @param {string[]} setA
 * @param {string[]} setB
 * @param {object} graph
 * @returns {number}
 */
function coupling(setA, setB, graph) {
  const b = new Set(setB || []);
  let hits = 0;
  let tests = 0;
  for (const a of setA || []) {
    for (const r of ((graph && graph.rules && graph.rules[a]) || [])) {
      tests++;
      if (b.has(r.companion)) hits += r.conf;
    }
  }
  return tests === 0 ? 0 : +(hits / tests).toFixed(3);
}

/**
 * Seam check over a set of in-flight parallel tasks.
 *
 * **Advisory only, by design.** "Coupling predicts wave conflict" is a
 * hypothesis, not a finding (design §3.6, last row). The seam half stays
 * advisory until the correlation is measured over >= 10 orchestrations, so this
 * returns findings and never an enforcement verdict.
 *
 * @param {{id?: string, write_allowed?: string[]}[]} tasks
 * @param {object} graph
 * @param {number} [threshold]
 * @returns {{a: string, b: string, coupling: number, shared: string[]}[]}
 */
function seamFindings(tasks, graph, threshold) {
  const bar = Number.isFinite(threshold) ? threshold : 0.5;
  const list = (tasks || []).map((t, i) => ({
    id: (t && t.id) || 'task-' + (i + 1),
    files: expandOwnership((t && t.write_allowed) || [], graph),
  }));
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const score = Math.max(
        coupling(list[i].files, list[j].files, graph),
        coupling(list[j].files, list[i].files, graph)
      );
      if (score < bar) continue;
      const shared = [];
      for (const a of list[i].files) {
        for (const r of ((graph.rules && graph.rules[a]) || [])) {
          if (list[j].files.includes(r.companion)) shared.push(a + ' -> ' + r.companion);
        }
      }
      out.push({ a: list[i].id, b: list[j].id, coupling: score, shared: shared.slice(0, 5) });
    }
  }
  return out.sort((x, y) => y.coupling - x.coupling);
}

module.exports = {
  build,
  readCommits,
  tally,
  rulesFrom,
  coupling,
  companionsOf,
  expandOwnership,
  seamFindings,
  getGraph,
  loadCache,
  saveCache,
  isStale,
  cachePath,
  emptyGraph,
  headSha,
  headCount,
  // Constants consumers read rather than re-declare.
  MAX_COMMIT_FILES,
  MIN_SUPPORT,
  MIN_CONF,
  HOLDOUT_CONF,
  STALE_AFTER_COMMITS,
  SCHEMA_VERSION,
  _internal: { sibling, isSweepCommit, globToRegExp },
};
