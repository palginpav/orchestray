#!/usr/bin/env node
'use strict';

/**
 * Co-change Oracle tests (v2.3.18 W5b, Proposal 3).
 *
 * Covers the two halves separately because they ship at different enforcement
 * levels on purpose:
 *
 *   - graph build / `coupling()` / holdout promotion — `bin/_lib/cochange-graph.js`
 *   - companion gate blocking at conf >= 0.8 with holdout — `bin/validate-companion-files.js`
 *   - seam gate staying ADVISORY — `bin/validate-task-contracts.js`
 *
 * The holdout tests are the load-bearing ones: filter 1 (sibling-sweep
 * suppression) measurably underdelivered, and holdout validation is what keeps
 * `agents/*.md` sweep pairs out of the blocking set.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const cp   = require('node:child_process');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const graphLib = require('../bin/_lib/cochange-graph');
const gate     = require('../bin/validate-companion-files');
const contracts = require('../bin/validate-task-contracts');

/** Commit record helper. `commits[0]` is newest. */
const c = (msg, files) => ({ msg, files });

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Graph build
// ---------------------------------------------------------------------------

describe('cochange-graph: mining', () => {
  test('directional confidence is P(b | a), not symmetric', () => {
    // a appears 4x, always with b. b appears 6x, only 4 of them with a.
    const commits = [
      c('x', ['a.js', 'b.js']), c('x', ['a.js', 'b.js']),
      c('x', ['a.js', 'b.js']), c('x', ['a.js', 'b.js']),
      c('x', ['b.js', 'z.js']), c('x', ['b.js', 'y.js']),
    ];
    const rules = graphLib.rulesFrom(graphLib.tally(commits), 0.6);
    const aToB = rules.get('a.js').find(r => r.companion === 'b.js');
    assert.equal(aToB.conf, 1, 'a always drags b along');
    const bToA = (rules.get('b.js') || []).find(r => r.companion === 'a.js');
    assert.ok(bToA.conf < 1, 'b often changes without a');
    assert.equal(bToA.support, 6);
  });

  test('release: sweeps and >15-file commits are excluded', () => {
    const wide = Array.from({ length: 20 }, (_, i) => 'f' + i + '.js');
    const commits = [
      c('release: v9.9.9', ['a.js', 'b.js']), c('release: v9.9.8', ['a.js', 'b.js']),
      c('release: v9.9.7', ['a.js', 'b.js']), c('release: v9.9.6', ['a.js', 'b.js']),
      c('big refactor', wide), c('big refactor', wide),
      c('big refactor', wide), c('big refactor', wide),
    ];
    const { solo, pair } = graphLib.tally(commits);
    assert.equal(solo.size, 0, 'nothing counted');
    assert.equal(pair.size, 0);
  });

  test('support floor rejects thin evidence', () => {
    const commits = [c('x', ['a.js', 'b.js']), c('x', ['a.js', 'b.js'])];
    const rules = graphLib.rulesFrom(graphLib.tally(commits), 0.6);
    assert.equal(rules.size, 0, 'support 2 < MIN_SUPPORT 4');
  });

  test('filter 1 drops pairs seen ONLY inside a sibling sweep', () => {
    // Three sibling .md files always move together — that is a sweep, not coupling.
    const sweep = ['agents/a.md', 'agents/b.md', 'agents/c.md'];
    const commits = [c('x', sweep), c('x', sweep), c('x', sweep), c('x', sweep)];
    const rules = graphLib.rulesFrom(graphLib.tally(commits), 0.6);
    assert.equal(rules.size, 0);
  });

  test('filter 1 keeps a pair that also occurs outside a sweep — this is why it underdelivers', () => {
    const sweep = ['agents/a.md', 'agents/b.md', 'agents/c.md'];
    const commits = [
      c('x', sweep), c('x', sweep), c('x', sweep),
      c('x', ['agents/a.md', 'agents/b.md']),   // small commit: filter 1 lets it through
    ];
    const rules = graphLib.rulesFrom(graphLib.tally(commits), 0.6);
    const kept = (rules.get('agents/a.md') || []).some(r => r.companion === 'agents/b.md');
    assert.ok(kept, 'cheap pre-filter only — holdout is the real defence');
  });
});

// ---------------------------------------------------------------------------
// Holdout promotion
// ---------------------------------------------------------------------------

describe('cochange-graph: holdout promotion', () => {
  test('a rule that recurs in recent history is promoted to block', () => {
    const commits = [];
    for (let i = 0; i < 12; i++) commits.push(c('x', ['idx.json', 'shadow.json']));
    const graph = graphLib.build('/nonexistent', { commits });
    const rule = graph.rules['idx.json'].find(r => r.companion === 'shadow.json');
    assert.equal(rule.enforcement, 'block');
    assert.equal(graph.block_count, 2, 'both directions promoted');
  });

  test('a stale convention that stopped recurring is demoted to advisory', () => {
    // Newest third: unrelated churn. Oldest two thirds: the old convention.
    const commits = [];
    for (let i = 0; i < 6; i++) commits.push(c('x', ['new-a.js', 'new-b.js']));
    for (let i = 0; i < 12; i++) commits.push(c('x', ['CLAUDE.md', 'README.md']));
    const graph = graphLib.build('/nonexistent', { commits });
    const rule = graph.rules['CLAUDE.md'].find(r => r.companion === 'README.md');
    assert.equal(rule.conf, 1, 'confidence is still perfect on the training window');
    assert.equal(rule.enforcement, 'advisory', 'but it did not hold on the holdout');
  });

  test('too little history promotes nothing', () => {
    const commits = [c('x', ['a.js', 'b.js']), c('x', ['a.js', 'b.js'])];
    const graph = graphLib.build('/nonexistent', { commits });
    assert.equal(graph.block_count, 0);
  });

  test('no git available yields an empty graph, not a throw', () => {
    const graph = graphLib.build(path.join(os.tmpdir(), 'definitely-not-a-repo-' + Date.now()));
    assert.deepEqual(graph.rules, {});
    assert.equal(graph.block_count, 0);
  });
});

// ---------------------------------------------------------------------------
// coupling() and glob expansion
// ---------------------------------------------------------------------------

describe('cochange-graph: coupling()', () => {
  const graph = {
    rules: {
      'bin/_lib/cost-helpers.js': [
        { companion: 'bin/collect-agent-metrics.js', conf: 1, support: 4, enforcement: 'block' },
      ],
      'bin/a.js': [{ companion: 'bin/unrelated.js', conf: 0.9, support: 5, enforcement: 'advisory' }],
    },
  };

  test('scores 0 when the set carries no obligations', () => {
    assert.equal(graphLib.coupling(['docs/x.md'], ['docs/y.md'], graph), 0);
  });

  test('scores high when one set owns the other set\'s companion', () => {
    const score = graphLib.coupling(
      ['bin/_lib/cost-helpers.js'], ['bin/collect-agent-metrics.js'], graph);
    assert.equal(score, 1);
  });

  test('scores 0 when the obligation points outside the other set', () => {
    assert.equal(graphLib.coupling(['bin/a.js'], ['bin/b.js'], graph), 0);
  });

  test('an empty graph makes every consumer a no-op', () => {
    assert.equal(graphLib.coupling(['a'], ['b'], graphLib.emptyGraph()), 0);
  });

  test('globs expand against paths the graph already knows', () => {
    const files = graphLib.expandOwnership(['bin/_lib/**'], graph);
    assert.deepEqual(files, ['bin/_lib/cost-helpers.js']);
    assert.deepEqual(graphLib.expandOwnership(['bin/*.js'], graph), ['bin/a.js']);
    assert.deepEqual(graphLib.expandOwnership(['bin/a.js'], graph), ['bin/a.js'],
      'a literal path needs no expansion');
  });
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

describe('cochange-graph: cache', () => {
  test('round-trips and rejects a wrong-shaped cache', () => {
    const dir = tmpRepo();
    assert.equal(graphLib.loadCache(dir), null, 'absent');
    graphLib.saveCache(dir, graphLib.build('/nonexistent', {
      commits: Array.from({ length: 12 }, () => c('x', ['a.js', 'b.js'])),
    }));
    assert.ok(graphLib.loadCache(dir).rules['a.js']);
    fs.writeFileSync(graphLib.cachePath(dir), '{"schema_version":99,"rules":{}}');
    assert.equal(graphLib.loadCache(dir), null, 'schema mismatch → rebuild');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('noBuild never mines', () => {
    const dir = tmpRepo();
    const g = graphLib.getGraph(dir, { noBuild: true });
    assert.deepEqual(g.rules, {});
    assert.equal(fs.existsSync(graphLib.cachePath(dir)), false, 'no cache written');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a cache with no head is stale', () => {
    assert.equal(graphLib.isStale(null, '/nonexistent'), true);
    assert.equal(graphLib.isStale({ head: null }, '/nonexistent'), true);
  });
});

// ---------------------------------------------------------------------------
// Companion gate
// ---------------------------------------------------------------------------

describe('validate-companion-files: gate', () => {
  const blockRule = {
    rules: {
      'idx.json': [
        { companion: 'shadow.json', conf: 1, support: 25, enforcement: 'block' },
        { companion: 'weak.md',     conf: 0.9, support: 25, enforcement: 'advisory' },
      ],
    },
    rule_count: 2,
  };
  const cfg = { min_conf: 0.8, min_support: 5 };

  test('missing block-enforcement companion is a blocking finding', () => {
    const { blocking, advisory } = gate.findMissing(['idx.json'], blockRule, cfg);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].companion, 'shadow.json');
    assert.equal(advisory.length, 1, 'the non-holdout rule reports but never blocks');
    assert.equal(advisory[0].companion, 'weak.md');
  });

  test('companion present in the diff clears the finding', () => {
    const { blocking } = gate.findMissing(['idx.json', 'shadow.json'], blockRule, cfg);
    assert.equal(blocking.length, 0);
  });

  test('conf below the configured floor is advisory even when holdout-validated', () => {
    const graph = {
      rules: { 'a.js': [{ companion: 'b.js', conf: 0.7, support: 25, enforcement: 'block' }] },
    };
    const { blocking, advisory } = gate.findMissing(['a.js'], graph, cfg);
    assert.equal(blocking.length, 0, '0.7 < min_conf 0.8');
    assert.equal(advisory.length, 1);
  });

  test('support below the configured floor is advisory', () => {
    const graph = {
      rules: { 'a.js': [{ companion: 'b.js', conf: 1, support: 4, enforcement: 'block' }] },
    };
    assert.equal(gate.findMissing(['a.js'], graph, cfg).blocking.length, 0);
  });

  test('a stated assumption naming the companion waives the finding', () => {
    const event = {
      subagent_type: 'developer',
      output: 'done\n## Structured Result\n```json\n' + JSON.stringify({
        status: 'complete', summary: 's', files_changed: [{ path: 'idx.json', description: 'd' }],
        files_read: [], issues: [],
        assumptions: ['shadow.json is regenerated by the release step, not here'],
      }) + '\n```',
    };
    const res = gate.evaluateSpawn(event, '/nonexistent', cfg,
      { graph: blockRule, changed: ['idx.json'] });
    assert.equal(res.blocking.length, 0);
    assert.equal(res.waived.length, 1);
  });

  test('an unrelated assumption does not waive', () => {
    const event = {
      subagent_type: 'developer',
      output: '## Structured Result\n```json\n' + JSON.stringify({
        status: 'complete', summary: 's', files_changed: [{ path: 'idx.json', description: 'd' }],
        files_read: [], issues: [],
        assumptions: ['assumed Node 20'],
      }) + '\n```',
    };
    const res = gate.evaluateSpawn(event, '/nonexistent', cfg,
      { graph: blockRule, changed: ['idx.json'] });
    assert.equal(res.blocking.length, 1);
    assert.equal(res.waived.length, 0);
  });

  test('an empty or sweep-wide diff is a no-op', () => {
    const empty = gate.evaluateSpawn({}, '/nonexistent', cfg, { graph: blockRule, changed: [] });
    assert.equal(empty.blocking.length, 0);
    const wide = Array.from({ length: 400 }, (_, i) => 'f' + i + '.js').concat('idx.json');
    const swept = gate.evaluateSpawn({}, '/nonexistent', cfg, { graph: blockRule, changed: wide });
    assert.equal(swept.blocking.length, 0, 'per-file obligations mean nothing across 400 files');
  });

  test('changedFiles fails open outside a git repo', () => {
    assert.deepEqual(gate.changedFiles(path.join(os.tmpdir(), 'nope-' + Date.now())), []);
  });
});

// ---------------------------------------------------------------------------
// Attribution — a SubagentStop fires against a repo-wide worktree, so "what
// changed" and "who changed it" are different questions. Reproduced in review:
// a reviewer that wrote nothing exited 2 over a pre-existing edit.
// ---------------------------------------------------------------------------

describe('validate-companion-files: the spawn answers only for its own writes', () => {
  const blockRule = {
    rules: { 'idx.json': [{ companion: 'shadow.json', conf: 1, support: 25, enforcement: 'block' }] },
    rule_count: 1,
  };
  const cfg = { min_conf: 0.8, min_support: 5 };

  const spawn = (role, filesChanged) => ({
    subagent_type: role,
    output: '## Structured Result\n```json\n' + JSON.stringify({
      status: 'complete', summary: 's',
      files_changed: filesChanged, files_read: ['x'], issues: [], assumptions: [],
    }) + '\n```',
  });

  test('a read-only role is skipped, however dirty the worktree is', () => {
    const res = gate.evaluateSpawn(spawn('reviewer', []), '/nonexistent', cfg,
      { graph: blockRule, changed: ['idx.json'] });
    assert.equal(res.blocking.length, 0, 'a reviewer cannot update a companion — gate-role-write-paths forbids it');
    assert.equal(res.skipped, 'read_only_role');
    assert.ok(gate.READ_ONLY_ROLES.has('reviewer'));
  });

  test('a developer is charged for the file it wrote', () => {
    const res = gate.evaluateSpawn(spawn('developer', [{ path: 'idx.json', description: 'd' }]),
      '/nonexistent', cfg, { graph: blockRule, changed: ['idx.json'] });
    assert.equal(res.blocking.length, 1);
    assert.equal(res.blocking[0].companion, 'shadow.json');
  });

  test('a developer is NOT charged for someone else\'s uncommitted edit', () => {
    const res = gate.evaluateSpawn(spawn('developer', [{ path: 'other.js', description: 'd' }]),
      '/nonexistent', cfg, { graph: blockRule, changed: ['idx.json', 'other.js'] });
    assert.equal(res.blocking.length, 0, 'idx.json belongs to whoever wrote it');
    assert.equal(res.changed, 1, 'only the attributed file is counted');
  });

  test('a companion updated by a sibling spawn still clears the obligation', () => {
    const res = gate.evaluateSpawn(spawn('developer', [{ path: 'idx.json', description: 'd' }]),
      '/nonexistent', cfg, { graph: blockRule, changed: ['idx.json', 'shadow.json'] });
    assert.equal(res.blocking.length, 0, 'presence is judged against the whole tree, not the owned subset');
  });

  // W6e: this used to assert the spawn was skipped outright. That let the
  // self-report gate the gate — a write-capable role could dirty the tree,
  // report `files_changed: []`, and never be evaluated, in a file whose premise
  // is that the tree is the witness. Attribution now decides what may *block*,
  // not whether the gate runs.
  test('an empty or absent files_changed still gets evaluated, advisory-only', () => {
    const none = gate.evaluateSpawn(spawn('developer', []), '/nonexistent', cfg,
      { graph: blockRule, changed: ['idx.json'] });
    assert.equal(none.blocking.length, 0, 'unattributed changes may be a sibling\'s — never blocking');
    assert.equal(none.skipped, 'none_attributed_evaluated');
    assert.equal(none.advisory.length, 1, 'but the finding is still recorded');
    assert.equal(none.advisory[0].companion, 'shadow.json');

    const absent = gate.evaluateSpawn({ subagent_type: 'developer' }, '/nonexistent', cfg,
      { graph: blockRule, changed: ['idx.json'] });
    assert.equal(absent.blocking.length, 0);
    assert.equal(absent.skipped, 'unattributed_evaluated');
    assert.equal(absent.advisory.length, 1);
  });

  test('a read-only role reporting nothing is still skipped outright', () => {
    // The other half of W6e/W-03: closing the self-report bypass must not
    // re-wedge the roles E4 exempted. A reviewer cannot update a companion.
    for (const role of ['reviewer', 'security-engineer', 'ux-critic', 'platform-oracle',
      'project-intent', 'researcher', 'debugger']) {
      const res = gate.evaluateSpawn({ subagent_type: role }, '/nonexistent', cfg,
        { graph: blockRule, changed: ['idx.json'] });
      assert.equal(res.skipped, 'read_only_role', role + ' must not be evaluated');
      assert.equal(res.advisory.length, 0, role + ' must not even be reported on');
    }
  });

  test('a write-capable role cannot switch the gate off by reporting nothing', () => {
    for (const role of ['developer', 'refactorer', 'tester', 'documenter', 'architect', 'pm']) {
      const res = gate.evaluateSpawn({ subagent_type: role }, '/nonexistent', cfg,
        { graph: blockRule, changed: ['idx.json'] });
      assert.notEqual(res.skipped, 'unattributed', role + ' skipped the gate via its own report');
      assert.equal(res.advisory.length, 1, role + ' must still be evaluated against the tree');
    }
  });

  test('reported paths normalise: absolute, ./-prefixed, bare strings, objects', () => {
    assert.equal(gate.normalizeReportedPath('./bin/x.js', '/repo'), 'bin/x.js');
    assert.equal(gate.normalizeReportedPath('/repo/bin/x.js', '/repo'), 'bin/x.js');
    assert.equal(gate.normalizeReportedPath({ path: 'bin/x.js' }, '/repo'), 'bin/x.js');
    assert.equal(gate.normalizeReportedPath('/elsewhere/x.js', '/repo'), null, 'outside the repo is not attributable');
    assert.equal(gate.normalizeReportedPath('', '/repo'), null);
    assert.equal(gate.normalizeReportedPath(null, '/repo'), null);
    assert.deepEqual(
      gate.ownedChangedFiles(spawn('developer', ['./idx.json']), ['idx.json', 'other.js'], '/repo'),
      ['idx.json'],
    );
  });

  test('the ramp counts each finding separately', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-ramp-'));
    try {
      const key = gate.rampKey('developer', { file: 'idx.json', companion: 'shadow.json' });
      assert.equal(key, 'developer|idx.json->shadow.json');
      const other = gate.rampKey('developer', { file: 'a.js', companion: 'b.js' });
      assert.deepEqual(gate.bumpWarnCounts(dir, 'orch-1', [key, other]), { [key]: 1, [other]: 1 });
      assert.deepEqual(gate.bumpWarnCounts(dir, 'orch-1', [key]), { [key]: 2 },
        'a second miss of the same rule advances only that rule');
      assert.deepEqual(
        JSON.parse(fs.readFileSync(gate.counterFilePath(dir, 'orch-1'), 'utf8')),
        { [key]: 2, [other]: 1 },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('validate-companion-files: config and ramp', () => {
  test('defaults are block/advisory at 0.8/5 with a 3-spawn ramp', () => {
    const cfg = gate.loadConfig(path.join(os.tmpdir(), 'nope-' + Date.now()));
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.companion_gate, 'block');
    assert.equal(cfg.seam_gate, 'advisory');
    assert.equal(cfg.min_conf, 0.8);
    assert.equal(cfg.min_support, 5);
    assert.equal(cfg.ramp, 3);
  });

  test('config can degrade the gate to telemetry without disabling it', () => {
    const dir = tmpRepo();
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ cochange_oracle: { companion_gate: 'advisory', min_conf: 0.95 } }));
    const cfg = gate.loadConfig(dir);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.companion_gate, 'advisory');
    assert.equal(cfg.min_conf, 0.95);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('env overrides the ramp threshold', () => {
    const prev = process.env.ORCHESTRAY_COCHANGE_RAMP_THRESHOLD;
    process.env.ORCHESTRAY_COCHANGE_RAMP_THRESHOLD = '0';
    try {
      assert.equal(gate.rampThreshold({ ramp: 3 }), 0);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_COCHANGE_RAMP_THRESHOLD;
      else process.env.ORCHESTRAY_COCHANGE_RAMP_THRESHOLD = prev;
    }
  });

  test('the block message names both remedies', () => {
    const msg = gate.failureMessage([
      { file: 'idx.json', companion: 'shadow.json', conf: 1, support: 25 },
    ]);
    assert.match(msg, /shadow\.json/);
    assert.match(msg, /assumptions/);
    assert.match(msg, /ORCHESTRAY_COCHANGE_DISABLED=1/);
  });
});

// ---------------------------------------------------------------------------
// Seam gate — advisory only
// ---------------------------------------------------------------------------

describe('cochange seam gate: advisory only', () => {
  const graph = {
    rules: {
      'bin/_lib/cost-helpers.js': [
        { companion: 'bin/collect-agent-metrics.js', conf: 1, support: 4, enforcement: 'block' },
      ],
    },
    rule_count: 1,
  };

  test('a coupled task pair produces a finding', () => {
    const findings = graphLib.seamFindings([
      { id: 'W1', write_allowed: ['bin/_lib/**'] },
      { id: 'W2', write_allowed: ['bin/collect-agent-metrics.js'] },
    ], graph, 0.5);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].coupling, 1);
    assert.deepEqual(findings[0].shared,
      ['bin/_lib/cost-helpers.js -> bin/collect-agent-metrics.js']);
  });

  test('an uncoupled pair produces nothing', () => {
    const findings = graphLib.seamFindings([
      { id: 'W1', write_allowed: ['docs/**'] },
      { id: 'W2', write_allowed: ['tests/**'] },
    ], graph, 0.5);
    assert.equal(findings.length, 0);
  });

  test('seamFindings returns findings, never an enforcement verdict', () => {
    const findings = graphLib.seamFindings([
      { id: 'W1', write_allowed: ['bin/_lib/cost-helpers.js'] },
      { id: 'W2', write_allowed: ['bin/collect-agent-metrics.js'] },
    ], graph, 0.5);
    for (const f of findings) {
      assert.equal('enforcement' in f, false);
      assert.equal('block' in f, false);
    }
  });

  test('the seam advisory never throws and never exits', () => {
    const dir = tmpRepo();
    // No graph cache, no task files — every branch must fail open silently.
    assert.doesNotThrow(() => contracts.seamAdvisory(dir, 'W1', 'orch-1', {
      file_ownership: { write_allowed: ['bin/**'] },
    }));
    assert.doesNotThrow(() => contracts.seamAdvisory(dir, 'W1', 'orch-1', {}));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('seam_gate: "off" is honoured, and "block" is NOT promoted to a block', () => {
    const dir = tmpRepo();
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ cochange_oracle: { seam_gate: 'off' } }));
    assert.equal(contracts.loadCochangeConfig(dir).seam_gate, 'off');
    // Even asked to block, the code path only ever writes stderr + an event.
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bin', 'validate-task-contracts.js'), 'utf8');
    const seam = src.slice(src.indexOf('function seamAdvisory'));
    const body = seam.slice(0, seam.indexOf('\nfunction loadCochangeConfig'));
    assert.equal(/process\.exit\(\s*2\s*\)/.test(body), false, 'seam gate must never exit 2');
    assert.match(body, /enforcement:\s*'advisory'/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sibling task ownership is read from the tasks dir and skips self', () => {
    const dir = tmpRepo();
    const tasks = path.join(dir, '.orchestray', 'state', 'tasks');
    fs.mkdirSync(tasks, { recursive: true });
    const yaml = (id) => 'id: ' + id + '\ncontracts:\n  file_ownership:\n' +
      '    write_allowed:\n      - "bin/' + id + '.js"\n';
    fs.writeFileSync(path.join(tasks, 'W1.yaml'), yaml('W1'));
    fs.writeFileSync(path.join(tasks, 'W2.yaml'), yaml('W2'));
    const peers = contracts.siblingTaskOwnership(dir, 'W1');
    assert.deepEqual(peers.map(p => p.id), ['W2']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// W7a — what the gate *says* when it fires. Every finding below was invisible
// to the unit tests above, which stop at `evaluateSpawn` and never look at the
// event or the exit contract.
// ---------------------------------------------------------------------------

describe('validate-companion-files: the gate\'s own output contract', () => {
  const GATE = path.join(__dirname, '..', 'bin', 'validate-companion-files.js');
  const ORCH = 'orch-w7a-companion';

  /**
   * A repo the gate can actually read: git-initialised so `changedFiles` sees
   * untracked files (no commit needed — `ls-files --others` covers them), with
   * a hand-written graph cache so `getGraph({noBuild:true})` has an opinion.
   */
  function e2eRepo(rules) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-e2e-'));
    fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
    cp.execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, 'idx.json'), '{}\n');
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: ORCH }), 'utf8',
    );
    graphLib.saveCache(dir, {
      schema_version: graphLib.SCHEMA_VERSION,
      head: 'deadbeef', head_count: 1,
      rules, rule_count: Object.keys(rules).length,
    });
    return dir;
  }

  const payload = (dir, filesChanged) => ({
    hook_event_name: 'SubagentStop',
    subagent_type: 'developer',
    cwd: dir,
    output: '## Structured Result\n```json\n' + JSON.stringify({
      status: 'complete', summary: 's',
      files_changed: filesChanged, files_read: ['x'], issues: [], assumptions: [],
    }) + '\n```',
  });

  const run = (dir, body, extraEnv) => {
    const r = cp.spawnSync(process.execPath, [GATE], {
      input: JSON.stringify(body), cwd: dir, encoding: 'utf8', timeout: 20000,
      env: Object.assign({}, process.env, extraEnv || {}),
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  const events = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (_e) { return []; }
  };

  const BLOCK_RULE = {
    'idx.json': [{ companion: 'shadow.json', conf: 1, support: 25, enforcement: 'block' }],
  };
  const ADVISORY_RULE = {
    'idx.json': [{ companion: 'weak.md', conf: 0.9, support: 25, enforcement: 'advisory' }],
  };

  test('a blocked spawn reports ramp_state "blocked", the value every other gate uses', () => {
    // 'block' was this gate's alone. Analytics grouped on 'blocked' — the value
    // claim-evidence and the context-size-hint gates emit — dropped every
    // companion block on the floor without anyone noticing.
    const dir = e2eRepo(BLOCK_RULE);
    const { status } = run(dir, payload(dir, [{ path: 'idx.json', description: 'd' }]),
      { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2);
    const ev = events(dir).filter((e) => e.type === 'companion_files_blocked');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].ramp_state, 'blocked');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('blocking emits a machine-readable reason on stdout, not just prose on stderr', () => {
    const dir = e2eRepo(BLOCK_RULE);
    const { status, stdout, stderr } = run(dir, payload(dir, [{ path: 'idx.json', description: 'd' }]),
      { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '0' });
    assert.equal(status, 2);
    assert.match(stderr, /BLOCKED/, 'the human message is still there');
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.continue, false);
    assert.equal(parsed.reason, 'companion_files_blocked:idx.json->shadow.json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('advisory findings are labelled advisory, not "ok"', () => {
    // An unattributed spawn is always evaluated advisory-only, so this is the
    // common case — and it was reporting the same event type as a clean diff.
    const dir = e2eRepo(ADVISORY_RULE);
    const { status } = run(dir, payload(dir, [{ path: 'idx.json', description: 'd' }]));
    assert.equal(status, 0, 'advisory rules never block');
    const evs = events(dir);
    assert.equal(evs.filter((e) => e.type === 'companion_files_ok').length, 0,
      '"ok" must mean clean');
    const adv = evs.filter((e) => e.type === 'companion_files_advisory');
    assert.equal(adv.length, 1);
    assert.equal(adv[0].advisory_count, 1);
    assert.deepEqual(adv[0].advisory.map((a) => a.companion), ['weak.md']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a genuinely clean run still emits companion_files_ok', () => {
    const dir = e2eRepo(BLOCK_RULE);
    fs.writeFileSync(path.join(dir, 'shadow.json'), '{}\n');   // companion present
    const { status } = run(dir, payload(dir, [{ path: 'idx.json', description: 'd' }]));
    assert.equal(status, 0);
    const evs = events(dir);
    assert.equal(evs.filter((e) => e.type === 'companion_files_ok').length, 1);
    assert.equal(evs.filter((e) => e.type === 'companion_files_advisory').length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Schema conformance — declared is not the same as valid
  //
  // The four types were declared from the start, so the "is it declared?" test
  // below passed while three of them failed shape validation on EVERY emission.
  // audit-event-writer degrades a shape violation to emit-with-warning, so the
  // gate still looked like it worked: exit codes right, payload present, and
  // two extra surrogate rows (`schema_shape_violation`,
  // `schema_shadow_validation_block`) per emission that nobody was counting.
  //
  // Cause was the schema doc, not the emitter: `extractFields` reads the JSON
  // example line by line, so a nested object expanded across lines inside
  // `missing[]` / `advisory[]` registered its inner keys as top-level required
  // fields. These tests fail if anyone re-expands them (v2.3.18 W8 C-2).
  // -------------------------------------------------------------------------

  /** Give the temp repo the real schema so the child validates for real. */
  function linkSchema(dir) {
    const rel = path.join('agents', 'pm-reference', 'event-schemas.md');
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.symlinkSync(path.join(__dirname, '..', rel), path.join(dir, rel));
  }

  const SURROGATES = ['schema_shape_violation', 'schema_shadow_validation_block'];

  const satisfyCompanion = (dir) => fs.writeFileSync(path.join(dir, 'shadow.json'), '{}\n');

  for (const [name, rules, env, expected, setup] of [
    ['companion_files_blocked',  BLOCK_RULE,    { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '0' }, 2],
    ['companion_file_missing',   BLOCK_RULE,    { ORCHESTRAY_COCHANGE_RAMP_THRESHOLD: '9' }, 0],
    ['companion_files_advisory', ADVISORY_RULE, {},                                          0],
    ['companion_files_ok',       BLOCK_RULE,    {},                                          0, satisfyCompanion],
  ]) {
    test(name + ' passes schema validation — exactly one row, no surrogates', () => {
      const dir = e2eRepo(rules);
      linkSchema(dir);
      if (setup) setup(dir);
      const { status } = run(dir, payload(dir, [{ path: 'idx.json', description: 'd' }]), env);
      assert.equal(status, expected);

      const evs = events(dir);
      const surrogate = evs.filter((e) => SURROGATES.includes(e.type));
      assert.deepEqual(
        surrogate.map((e) => e.blocked_event_type || e.event_type), [],
        name + ' failed shadow validation — check the JSON example in event-schemas.md'
      );
      assert.equal(evs.filter((e) => e.type === name).length, 1, 'exactly one row per emission');
      assert.equal(evs.length, 1, 'no extra rows: ' + evs.map((e) => e.type).join(', '));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  test('every event type the gate emits is declared in event-schemas.md', () => {
    const src = fs.readFileSync(GATE, 'utf8');
    const declared = new Set(Object.keys(
      require('../agents/pm-reference/event-schemas.shadow.json')));
    const emitted = [...src.matchAll(/type:\s*'(companion_[a-z_]+)'/g)].map((m) => m[1]);
    assert.ok(emitted.includes('companion_files_advisory'), 'the new type is wired');
    for (const t of emitted) assert.ok(declared.has(t), t + ' is emitted but has no schema');
  });
});
