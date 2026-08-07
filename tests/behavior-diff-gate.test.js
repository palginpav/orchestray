#!/usr/bin/env node
'use strict';

/**
 * Behavior Diff Gate tests (v2.3.18 W5b, Proposal 2).
 *
 * Three of these encode findings the §2.4 prototype run produced by actually
 * running the harness, and they are the ones worth guarding:
 *
 *   1. Shape hashing must collapse path/prose differences but NOT real
 *      behavioral branches.
 *   2. A fixture is `{stdin, state}`. A bare payload is rejected, because in a
 *      fresh sandbox our fail-open hooks reduce every observation to `{0,[],''}`.
 *   3. All-trivial observations are reported as `uncovered: true`, never as
 *      `deltas: []` — otherwise BDG reports green while testing nothing.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const shape = require('../bin/_lib/fixture-shape');
const bdg   = require('../bin/_tools/behavior-diff');
const hookStdin = require('../bin/_lib/hook-stdin');

const TRIVIAL = { code: 0, events: [], stderr_class: '' };

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

/** Write a fixture file for `script` into a repo root. */
function writeFixture(root, script, name, fixture) {
  const dir = path.join(root, '.orchestray', 'fixtures', script);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(fixture), 'utf8');
}

const fixture = (stdin, state) => ({ stdin: stdin || {}, state: state || {} });

/** A script must exist on both sides, else the missing baseline is itself the delta. */
function touchScript(root, rel) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "'use strict';\n", 'utf8');
}

// ---------------------------------------------------------------------------
// Shape hashing
// ---------------------------------------------------------------------------

describe('fixture-shape: shapeHash', () => {
  test('path and prose differences collapse to one hash', () => {
    const a = { transcript_path: '/a/b/c.jsonl', summary: 'did the thing' };
    const b = { transcript_path: '/x/y/z/w.jsonl', summary: 'did a completely other thing' };
    assert.equal(shape.shapeHash(a), shape.shapeHash(b));
  });

  test('a control-flow key\'s VALUE does not collapse', () => {
    const a = { subagent_type: 'tester', transcript_path: '/a/b' };
    const b = { subagent_type: 'developer', transcript_path: '/a/b' };
    assert.notEqual(shape.shapeHash(a), shape.shapeHash(b));
  });

  test('a missing key is a different shape', () => {
    assert.notEqual(
      shape.shapeHash({ a: 'x', b: 'y' }),
      shape.shapeHash({ a: 'x' }));
  });

  test('type changes and empty-vs-present differ', () => {
    assert.notEqual(shape.shapeHash({ a: 'x' }), shape.shapeHash({ a: 1 }));
    assert.notEqual(shape.shapeHash({ a: '' }), shape.shapeHash({ a: 'x' }));
    assert.notEqual(shape.shapeHash({ a: [] }), shape.shapeHash({ a: ['x'] }));
  });

  test('a cyclic payload hashes rather than throws', () => {
    const cyclic = { a: 1 };
    cyclic.self = cyclic;
    assert.match(shape.shapeHash(cyclic), /^[0-9a-f]{12}$/);
  });
});

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

describe('fixture-shape: observations', () => {
  test('stderr is compared by class — wording churn is not behavior change', () => {
    const a = shape.stderrClass('[orchestray] gate: BLOCKED — "bin/foo.js" is missing');
    const b = shape.stderrClass('[orchestray] gate: BLOCKED — "bin/bar.js" is missing');
    assert.equal(a, b);
    assert.equal(shape.stderrClass(''), '');
  });

  test('a genuinely different message is a different class', () => {
    assert.notEqual(
      shape.stderrClass('gate: BLOCKED'),
      shape.stderrClass('gate: WARN'));
  });

  test('events compare as a sorted set', () => {
    assert.ok(shape.observationEquals(
      { code: 0, events: ['b', 'a'], stderr: '' },
      { code: 0, events: ['a', 'b'], stderr: '' }));
    assert.equal(shape.observationEquals(
      { code: 0, events: ['a'], stderr: '' },
      { code: 0, events: ['a', 'b'], stderr: '' }), false);
  });

  test('exit code changes are behavior changes', () => {
    assert.equal(shape.observationEquals(
      { code: 0, events: [], stderr: '' },
      { code: 2, events: [], stderr: '' }), false);
  });

  test('isTrivialObservation identifies the fail-open fingerprint', () => {
    assert.equal(shape.isTrivialObservation(TRIVIAL), true);
    assert.equal(shape.isTrivialObservation(null), true);
    assert.equal(shape.isTrivialObservation({ code: 2, events: [], stderr_class: '' }), false);
    assert.equal(shape.isTrivialObservation({ code: 0, events: ['x'], stderr_class: '' }), false);
    assert.equal(shape.isTrivialObservation({ code: 0, events: [], stderr_class: 'boom' }), false);
  });
});

// ---------------------------------------------------------------------------
// The {stdin, state} requirement
// ---------------------------------------------------------------------------

describe('BDG: a fixture is {stdin, state}, not stdin', () => {
  test('isFixture accepts only the two-part shape', () => {
    assert.equal(shape.isFixture({ stdin: {}, state: {} }), true);
    assert.equal(shape.isFixture({ hook_event_name: 'SubagentStop' }), false,
      'a bare payload is not a fixture');
    assert.equal(shape.isFixture({ stdin: {} }), false, 'state is mandatory');
    assert.equal(shape.isFixture({ state: {} }), false);
    assert.equal(shape.isFixture(null), false);
    assert.equal(shape.isFixture([{ stdin: {}, state: {} }]), false);
  });

  test('bare-payload fixtures are counted invalid, never replayed', () => {
    const root = tmpRepo();
    writeFixture(root, 'demo', 'a.json', { hook_event_name: 'SubagentStop' });  // legacy shape
    writeFixture(root, 'demo', 'b.json', fixture({ hook_event_name: 'SubagentStop' }));
    fs.writeFileSync(
      path.join(root, '.orchestray', 'fixtures', 'demo', 'c.json'), 'not json', 'utf8');

    const loaded = bdg.loadFixtures(root, 'bin/demo.js');
    assert.equal(loaded.fixtures.length, 1);
    assert.equal(loaded.invalid, 2);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('state is materialised into the sandbox so the replay exercises real branches', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-state-'));
    fs.mkdirSync(path.join(sandbox, '.orchestray', 'state'), { recursive: true });
    bdg.materialiseState(sandbox, {
      'orchestration.md': '# orch\nstatus: in_progress\n',
      'current-orchestration.json': { orchestration_id: 'orch-x' },
    });
    const dir = path.join(sandbox, '.orchestray', 'state');
    assert.match(fs.readFileSync(path.join(dir, 'orchestration.md'), 'utf8'), /in_progress/);
    assert.match(fs.readFileSync(path.join(dir, 'current-orchestration.json'), 'utf8'), /orch-x/);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test('a traversing state key cannot escape the sandbox', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-esc-'));
    fs.mkdirSync(path.join(sandbox, '.orchestray', 'state'), { recursive: true });
    bdg.materialiseState(sandbox, { '../../../pwned.txt': 'x', '..': 'y' });
    assert.equal(fs.existsSync(path.join(sandbox, '..', '..', '..', 'pwned.txt')), false);
    assert.deepEqual(fs.readdirSync(path.join(sandbox, '.orchestray', 'state')), ['pwned.txt']);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// uncovered vs deltas — the false-negative guard
// ---------------------------------------------------------------------------

describe('BDG: uncovered is reported as uncovered, never as an empty delta', () => {
  const stubObserve = (obs) => () => Object.assign({}, obs, { events: [...obs.events] });

  test('all-trivial observations on both sides → uncovered, not deltas: []', () => {
    const root = tmpRepo();
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    writeFixture(root, 'demo', 'b.json', fixture({ x: 2 }));
    const res = bdg.diffScript('bin/demo.js', root, root, { observe: stubObserve(TRIVIAL) });
    assert.equal(res.uncovered, true);
    assert.equal(res.reason, 'all_observations_trivial');
    assert.deepEqual(res.deltas, []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an empty corpus is uncovered with reason no_fixtures', () => {
    const root = tmpRepo();
    const res = bdg.diffScript('bin/demo.js', root, root, { observe: stubObserve(TRIVIAL) });
    assert.equal(res.uncovered, true);
    assert.equal(res.reason, 'no_fixtures');
    assert.equal(res.fixtures, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a corpus of only malformed fixtures is uncovered with reason fixtures_invalid', () => {
    const root = tmpRepo();
    writeFixture(root, 'demo', 'a.json', { hook_event_name: 'X' });
    const res = bdg.diffScript('bin/demo.js', root, root, { observe: stubObserve(TRIVIAL) });
    assert.equal(res.uncovered, true);
    assert.equal(res.reason, 'fixtures_invalid');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a non-trivial observation marks the script covered', () => {
    const root = tmpRepo();
    touchScript(root, 'bin/demo.js');
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    const res = bdg.diffScript('bin/demo.js', root, root, {
      observe: stubObserve({ code: 0, events: ['demo_ok'], stderr_class: '' }),
    });
    assert.equal(res.uncovered, false);
    assert.equal(res.reason, null);
    assert.deepEqual(res.deltas, []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a real behavior delta is reported with both observations', () => {
    const root = tmpRepo();
    touchScript(root, 'bin/demo.js');
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    let call = 0;
    const res = bdg.diffScript('bin/demo.js', root, root, {
      observe: () => (++call === 1
        ? { code: 0, events: ['demo_ok'], stderr_class: '' }
        : { code: 2, events: ['demo_blocked'], stderr_class: 'gate: BLOCKED' }),
    });
    assert.equal(res.uncovered, false);
    assert.equal(res.deltas.length, 1);
    assert.equal(res.deltas[0].before.code, 0);
    assert.equal(res.deltas[0].after.code, 2);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Coverage probe
// ---------------------------------------------------------------------------

describe('BDG: doctor coverage probe', () => {
  test('reports covered/total and names the uncovered scripts', () => {
    const root = tmpRepo();
    writeFixture(root, 'alpha', 'a.json', fixture({ x: 1 }));
    writeFixture(root, 'alpha', 'b.json', fixture({ x: 2 }));
    writeFixture(root, 'beta',  'a.json', { bare: true });   // invalid → uncovered
    const cov = bdg.coverage(root);
    assert.equal(cov.scripts_with_fixtures, 2);
    assert.equal(cov.covered_scripts, 1);
    assert.equal(cov.ratio, 0.5);
    assert.equal(cov.total_fixtures, 2);
    assert.equal(cov.invalid_fixtures, 1);
    assert.deepEqual(cov.uncovered, ['beta']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an empty corpus reports 0/0 with ratio 0 rather than dividing by zero', () => {
    const root = tmpRepo();
    const cov = bdg.coverage(root);
    assert.equal(cov.scripts_with_fixtures, 0);
    assert.equal(cov.ratio, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('deep mode demotes a script whose fixtures all fail open', () => {
    const root = tmpRepo();
    writeFixture(root, 'alpha', 'a.json', fixture({ x: 1 }));
    const cov = bdg.coverage(root, { deep: true, observe: () => TRIVIAL });
    assert.equal(cov.covered_scripts, 0, 'fixtures exist but exercise nothing');
    assert.deepEqual(cov.uncovered, ['alpha']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Observation of a real script
// ---------------------------------------------------------------------------

describe('BDG: observe() runs real scripts', () => {
  test('captures exit code, stderr class and emitted events', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-script-'));
    const script = path.join(dir, 'demo.js');
    fs.writeFileSync(script, [
      "'use strict';",
      "const fs = require('fs'), path = require('path');",
      "let raw = ''; try { raw = fs.readFileSync(0, 'utf8'); } catch (e) {}",
      'const ev = raw ? JSON.parse(raw) : {};',
      "const stateFile = path.join(process.cwd(), '.orchestray', 'state', 'flag.txt');",
      "const armed = fs.existsSync(stateFile);",
      "fs.appendFileSync(path.join(process.cwd(), '.orchestray', 'audit', 'events.jsonl'),",
      "  JSON.stringify({ type: armed ? 'demo_armed' : 'demo_idle' }) + '\\n');",
      "if (armed && ev.trip) { process.stderr.write('demo: BLOCKED on \"' + ev.trip + '\"\\n'); process.exit(2); }",
      'process.exit(0);',
    ].join('\n'), 'utf8');

    const idle = bdg.observe(script, fixture({ trip: 'x' }, {}));
    assert.equal(idle.code, 0);
    assert.deepEqual(idle.events, ['demo_idle']);
    assert.equal(shape.isTrivialObservation(idle), false);

    const armed = bdg.observe(script, fixture({ trip: 'x' }, { 'flag.txt': '1' }));
    assert.equal(armed.code, 2, 'state is what unlocks the real decision surface');
    assert.deepEqual(armed.events, ['demo_armed']);
    assert.equal(armed.stderr_class, 'demo: BLOCKED on');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a crashing script observes as a code, not a thrown harness error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-crash-'));
    const script = path.join(dir, 'boom.js');
    fs.writeFileSync(script, "throw new Error('boom');\n", 'utf8');
    const obs = bdg.observe(script, fixture());
    assert.notEqual(obs.code, 0);
    assert.equal(shape.isTrivialObservation(obs), false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing script does not throw', () => {
    const obs = bdg.observe(path.join(os.tmpdir(), 'nope-' + Date.now() + '.js'), fixture());
    assert.ok(Number.isFinite(obs.code));
  });
});

// ---------------------------------------------------------------------------
// Config, kill switches, CLI
// ---------------------------------------------------------------------------

describe('BDG: config and kill switches', () => {
  test('defaults are enabled/harvest/block with a 40-fixture cap', () => {
    const cfg = bdg.loadConfig(path.join(os.tmpdir(), 'nope-' + Date.now()));
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.harvest, true);
    assert.equal(cfg.block, true);
    assert.equal(cfg.max_fixtures_per_script, 40);
    assert.equal(cfg.ramp, 3);
  });

  test('harvest and block are separable — the corpus builds before the gate arms', () => {
    const root = tmpRepo();
    fs.writeFileSync(path.join(root, '.orchestray', 'config.json'),
      JSON.stringify({ behavior_diff_gate: { harvest: true, block: false } }));
    const cfg = bdg.loadConfig(root);
    assert.equal(cfg.harvest, true);
    assert.equal(cfg.block, false);
    assert.equal(cfg.enabled, true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('env kill switch and config disable both bypass', () => {
    const prev = process.env.ORCHESTRAY_BEHAVIOR_DIFF_DISABLED;
    process.env.ORCHESTRAY_BEHAVIOR_DIFF_DISABLED = '1';
    try {
      assert.equal(bdg.isDisabled({ enabled: true }), true);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_BEHAVIOR_DIFF_DISABLED;
      else process.env.ORCHESTRAY_BEHAVIOR_DIFF_DISABLED = prev;
    }
    assert.equal(bdg.isDisabled({ enabled: false }), true);
    assert.equal(bdg.isDisabled({ enabled: true }), false);
  });

  test('CLI args parse', () => {
    const a = bdg.parseArgs(['--base', 'abc123', '--json', '--only', 'bin/foo.js']);
    assert.equal(a.base, 'abc123');
    assert.equal(a.json, true);
    assert.deepEqual(a.only, ['bin/foo.js']);
    const b = bdg.parseArgs(['--base=HEAD~2', '--only=bin/bar.js', '--coverage', '--deep']);
    assert.equal(b.base, 'HEAD~2');
    assert.deepEqual(b.only, ['bin/bar.js']);
    assert.equal(b.coverage, true);
    assert.equal(b.deep, true);
    assert.equal(bdg.parseArgs([]).base, 'HEAD');
  });

  test('run() with no changed scripts reports cleanly and never blocks', () => {
    const root = tmpRepo();
    const report = bdg.run({ cwd: root, only: [], base: 'HEAD', config: bdg.loadConfig(root) });
    assert.equal(report.delta_count, 0);
    assert.equal(report.blocked, false);
    assert.equal(report.scripts.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an unusable baseline fails open instead of throwing', () => {
    const root = tmpRepo();
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    const report = bdg.run({
      cwd: root, base: 'does-not-exist', only: ['bin/demo.js'], config: bdg.loadConfig(root),
    });
    assert.equal(report.error, 'baseline_worktree_failed');
    assert.equal(report.blocked, false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('block: false degrades a real delta to telemetry', () => {
    const root = tmpRepo();
    touchScript(root, 'bin/demo.js');
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    let call = 0;
    const cfg = Object.assign(bdg.loadConfig(root), { block: false });
    const report = bdg.run({
      cwd: root, base: 'HEAD', only: ['bin/demo.js'], config: cfg, baselineRoot: root,
      observe: () => (++call === 1
        ? { code: 0, events: ['a'], stderr_class: '' }
        : { code: 1, events: ['b'], stderr_class: '' }),
    });
    assert.equal(report.delta_count, 1);
    assert.equal(report.blocked, false, 'telemetry only');
    assert.match(bdg.renderText(report), /telemetry only/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the text report never calls an uncovered script "no change"', () => {
    const text = bdg.renderText({
      base: 'HEAD', delta_count: 0, blocked: false,
      coverage: { covered_scripts: 0, scripts_with_fixtures: 1, total_fixtures: 0, invalid_fixtures: 0 },
      scripts: [{ script: 'bin/demo.js', fixtures: 0, deltas: [], uncovered: true, reason: 'no_fixtures' }],
    });
    assert.match(text, /UNCOVERED/);
    assert.match(text, /nothing was exercised/);
    assert.equal(/\[SAME\]/.test(text), false);
  });
});

// ---------------------------------------------------------------------------
// Harvest arming
// ---------------------------------------------------------------------------

describe('BDG: harvest arming', () => {
  const { harvestEnabled, harvestConfigured, _resetHarvestCfg } = hookStdin._internal;

  test('harvest stays off under test regardless of env', () => {
    const prev = process.env.ORCHESTRAY_FIXTURE_HARVEST;
    process.env.ORCHESTRAY_FIXTURE_HARVEST = '1';
    try {
      assert.equal(harvestEnabled(), false, 'synthetic shapes must not pollute the corpus');
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_FIXTURE_HARVEST;
      else process.env.ORCHESTRAY_FIXTURE_HARVEST = prev;
    }
  });

  test('config gates the harvest, defaulting on', () => {
    const root = tmpRepo();
    _resetHarvestCfg();
    assert.equal(harvestConfigured(root), true, 'no config → armed');

    fs.writeFileSync(path.join(root, '.orchestray', 'config.json'),
      JSON.stringify({ behavior_diff_gate: { harvest: false } }));
    _resetHarvestCfg();
    assert.equal(harvestConfigured(root), false);

    fs.writeFileSync(path.join(root, '.orchestray', 'config.json'),
      JSON.stringify({ behavior_diff_gate: { enabled: false } }));
    _resetHarvestCfg();
    assert.equal(harvestConfigured(root), false, 'disabling the gate stops collection too');

    fs.writeFileSync(path.join(root, '.orchestray', 'config.json'), 'not json');
    _resetHarvestCfg();
    assert.equal(harvestConfigured(root), true, 'fail-open');

    _resetHarvestCfg();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Behavior-Change declarations (v2.3.19 W3 fix)
//
// The gate advertised `Behavior-Change: <script> <reason>` as the escape
// hatch for an intentional delta, but nothing parsed it — every intentional
// change was permanently blocked. These tests cover the parser and its
// wiring into run()/renderText().
// ---------------------------------------------------------------------------

describe('BDG: Behavior-Change declarations', () => {
  test('a well-formed trailer parses into script -> [reason]', () => {
    const body = 'release notes\n\nBehavior-Change: bin/foo.js fixture abc goes 2->0: it is fine\n';
    const { declared, malformed } = bdg.parseDeclarations(body);
    assert.deepEqual(declared.get('bin/foo.js'), ['fixture abc goes 2->0: it is fine']);
    assert.deepEqual(malformed, []);
  });

  test('a reason-less declaration is rejected, not silently accepted', () => {
    const { declared, malformed } = bdg.parseDeclarations('Behavior-Change: bin/foo.js\n');
    assert.equal(declared.has('bin/foo.js'), false);
    assert.equal(malformed.length, 1);
    assert.match(malformed[0], /bin\/foo\.js/);
  });

  test('a declaration with only trailing whitespace after the path is still reason-less', () => {
    const { declared, malformed } = bdg.parseDeclarations('Behavior-Change: bin/foo.js   \n');
    assert.equal(declared.has('bin/foo.js'), false);
    assert.equal(malformed.length, 1);
  });

  test('multiple lines and repeated scripts across commits all accumulate', () => {
    const body = [
      'Behavior-Change: bin/a.js first reason',
      'Behavior-Change: bin/b.js second reason',
      'Behavior-Change: bin/a.js third reason too',
    ].join('\n');
    const { declared } = bdg.parseDeclarations(body);
    assert.deepEqual(declared.get('bin/a.js'), ['first reason', 'third reason too']);
    assert.deepEqual(declared.get('bin/b.js'), ['second reason']);
  });

  test('matching is by exact repo-relative path — a bare basename does not alias it', () => {
    const { declared } = bdg.parseDeclarations('Behavior-Change: gate-agent-spawn.js some reason\n');
    assert.equal(declared.has('bin/gate-agent-spawn.js'), false, 'no accidental basename aliasing');
    assert.equal(declared.has('gate-agent-spawn.js'), true, 'parses exactly as written');
  });

  test('a declared delta is excluded from delta_count/blocked and marked on its script entry', () => {
    const root = tmpRepo();
    touchScript(root, 'bin/demo.js');
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    let call = 0;
    const declarations = { declared: new Map([['bin/demo.js', ['intentional change']]]), malformed: [] };
    const report = bdg.run({
      cwd: root, base: 'HEAD', only: ['bin/demo.js'], baselineRoot: root, declarations,
      config: bdg.loadConfig(root),
      observe: () => (++call === 1
        ? { code: 0, events: ['a'], stderr_class: '' }
        : { code: 1, events: ['b'], stderr_class: '' }),
    });
    assert.equal(report.scripts[0].declared, true);
    assert.equal(report.scripts[0].declared_reason, 'intentional change');
    assert.equal(report.delta_count, 0, 'a declared delta must not count as unexplained');
    assert.equal(report.declared_delta_count, 1);
    assert.equal(report.blocked, false);
    assert.match(bdg.renderText(report), /\[DECLARED\]/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Proves the guard is load-bearing: pass an empty declarations map for the
  // exact same delta and confirm it still blocks. Disabling the `declared`
  // check in behavior-diff.js (e.g. commenting out the `result.declared = ...`
  // assignment) makes this fail, because `delta_count`/`blocked` would then
  // be computed identically regardless of what `declarations` contains.
  test('an undeclared delta still blocks', () => {
    const root = tmpRepo();
    touchScript(root, 'bin/demo.js');
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    let call = 0;
    const report = bdg.run({
      cwd: root, base: 'HEAD', only: ['bin/demo.js'], baselineRoot: root,
      declarations: { declared: new Map(), malformed: [] },
      config: bdg.loadConfig(root),
      observe: () => (++call === 1
        ? { code: 0, events: ['a'], stderr_class: '' }
        : { code: 1, events: ['b'], stderr_class: '' }),
    });
    assert.equal(report.scripts[0].declared, false);
    assert.equal(report.delta_count, 1);
    assert.equal(report.blocked, true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a declaration naming a script with no delta is surfaced, not silently dropped', () => {
    const root = tmpRepo();
    touchScript(root, 'bin/demo.js');
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    const declarations = { declared: new Map([['bin/nope.js', ['typo path']]]), malformed: [] };
    const report = bdg.run({
      cwd: root, base: 'HEAD', only: ['bin/demo.js'], baselineRoot: root, declarations,
      config: bdg.loadConfig(root),
      observe: () => ({ code: 0, events: ['a'], stderr_class: '' }),   // no delta at all
    });
    assert.deepEqual(report.unmatched_declarations, ['bin/nope.js']);
    assert.match(bdg.renderText(report), /bin\/nope\.js/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a malformed trailer is surfaced in renderText as a warning', () => {
    const root = tmpRepo();
    touchScript(root, 'bin/demo.js');
    writeFixture(root, 'demo', 'a.json', fixture({ x: 1 }));
    let call = 0;
    const declarations = { declared: new Map(), malformed: ['Behavior-Change: bin/demo.js'] };
    const report = bdg.run({
      cwd: root, base: 'HEAD', only: ['bin/demo.js'], baselineRoot: root, declarations,
      config: bdg.loadConfig(root),
      observe: () => (++call === 1
        ? { code: 0, events: ['a'], stderr_class: '' }
        : { code: 1, events: ['b'], stderr_class: '' }),
    });
    assert.equal(report.blocked, true, 'a malformed trailer must not declare anything');
    assert.match(bdg.renderText(report), /\[WARN\].*malformed/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loadDeclarations reads real Behavior-Change trailers from base..HEAD', () => {
    const GIT_ENV = {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'bdg-test', GIT_AUTHOR_EMAIL: 'bdg-test@test',
      GIT_COMMITTER_NAME: 'bdg-test', GIT_COMMITTER_EMAIL: 'bdg-test@test',
    };
    const { execFileSync } = require('node:child_process');
    const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, GIT_ENV) });

    const root = tmpRepo();
    git(root, ['init', '-q']);
    fs.writeFileSync(path.join(root, 'f.txt'), '1', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base commit']);
    const baseSha = git(root, ['rev-parse', 'HEAD']).trim();

    fs.writeFileSync(path.join(root, 'f.txt'), '2', 'utf8');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'declare it\n\nBehavior-Change: bin/foo.js it changed on purpose']);

    const { declared, malformed } = bdg.loadDeclarations(root, baseSha);
    assert.deepEqual(declared.get('bin/foo.js'), ['it changed on purpose']);
    assert.deepEqual(malformed, []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('loadDeclarations fails open when the range is unusable (no git repo)', () => {
    const root = tmpRepo();
    const { declared, malformed } = bdg.loadDeclarations(root, 'HEAD');
    assert.equal(declared.size, 0);
    assert.deepEqual(malformed, []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Baseline worktree — node_modules symlink (v2.3.19 W3 fix)
//
// `git worktree add` never carries gitignored `node_modules/`. Any script
// that transitively requires an npm package crashed to load on the baseline
// side and reported a delta on EVERY fixture — not because it changed, but
// because the harness's own baseline couldn't boot. That is a 100%
// false-positive rate for every real script with a dependency; a synthetic
// zero-dependency probe (as used elsewhere in this file and in the E1
// regression suite) never exercises the failure.
// ---------------------------------------------------------------------------

describe('BDG: baseline worktree can load npm dependencies', () => {
  const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'bdg-test', GIT_AUTHOR_EMAIL: 'bdg-test@test',
    GIT_COMMITTER_NAME: 'bdg-test', GIT_COMMITTER_EMAIL: 'bdg-test@test',
  };
  const { execFileSync } = require('node:child_process');
  function git(cwd, args) {
    execFileSync('git', args, { cwd, encoding: 'utf8', env: Object.assign({}, process.env, GIT_ENV) });
  }

  test('linkNodeModules symlinks the real install into the worktree', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-nm-repo-'));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-nm-wt-'));
    fs.mkdirSync(path.join(repoRoot, 'node_modules', 'fake-pkg'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'node_modules', 'fake-pkg', 'index.js'),
      'module.exports = 42;\n', 'utf8');

    bdg.linkNodeModules(repoRoot, worktree);

    const linked = path.join(worktree, 'node_modules', 'fake-pkg', 'index.js');
    assert.ok(fs.existsSync(linked));
    assert.equal(require(linked), 42);
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  test('a missing repo node_modules is a no-op, not a throw', () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-nm-none-'));
    assert.doesNotThrow(() => bdg.linkNodeModules(path.join(os.tmpdir(), 'nope-' + Date.now()), worktree));
    assert.equal(fs.existsSync(path.join(worktree, 'node_modules')), false);
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  test('a script requiring an npm dependency reports no delta when unchanged', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdg-nm-e2e-'));
    fs.mkdirSync(path.join(root, 'node_modules', 'fake-pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'fake-pkg', 'index.js'),
      'module.exports = { greet: () => "hi" };\n', 'utf8');

    const scriptSrc = [
      "'use strict';",
      'const { greet } = require("fake-pkg");',
      'const fs = require("fs"), path = require("path");',
      'fs.mkdirSync(path.join(process.cwd(), ".orchestray", "audit"), { recursive: true });',
      'fs.appendFileSync(path.join(process.cwd(), ".orchestray", "audit", "events.jsonl"),',
      '  JSON.stringify({ type: "nm_probe_" + greet() }) + "\\n");',
      'process.exit(0);',
      '',
    ].join('\n');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'nm-probe.js'), scriptSrc, 'utf8');
    writeFixture(root, 'nm-probe', 'a.json', fixture({ x: 1 }));

    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);

    const report = bdg.run({ cwd: root, base: 'HEAD', only: ['bin/nm-probe.js'], config: bdg.loadConfig(root) });
    assert.equal(report.error, undefined, 'must not fail to build the baseline worktree');
    const s = report.scripts[0];
    assert.equal(s.uncovered, false, 'the probe emits a real event — must not report uncovered');
    assert.deepEqual(s.deltas, [], JSON.stringify(s.deltas));
    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Design constraint: no static JS analysis anywhere (§4.3, 20/20 false positives)
// ---------------------------------------------------------------------------

describe('BDG: behavior is observed, never parsed', () => {
  test('the harness does not regex JavaScript source', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'bin', '_tools', 'behavior-diff.js'), 'utf8');
    for (const forbidden of [/require\s*\\\(/, /module\\\.exports/, /\bexport\s/]) {
      assert.equal(forbidden.test(src), false,
        'static analysis of JS was measured at 20/20 false positives — do not reintroduce it');
    }
    assert.equal(/readFileSync\([^)]*scriptPath/.test(src), false,
      'scripts are executed, never read as text');
  });
});
