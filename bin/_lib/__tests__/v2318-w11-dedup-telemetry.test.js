#!/usr/bin/env node
'use strict';

/**
 * v2318-w11-dedup-telemetry.test.js — dedup decisions reach the audit log
 * (v2.3.18 W11).
 *
 * Before W11 `hook-stdin.js` had no emission path at all. `dedupDecision`
 * returned a rich `reason` — `claimed`, `duplicate_install`, `claim_untrusted`,
 * `claim_dir_untrusted`, and nine more — and none of it reached events.jsonl.
 * Every suppression was a hook that did not run, with nothing anywhere saying
 * so, and the W10 tamper signals (which fire exactly when someone is planting
 * claim files) were invisible.
 *
 * The tests below hold three lines:
 *
 *   1. **The decision is untouchable.** Telemetry sits downstream of it. A
 *      throwing audit writer must not change `fire`, must not propagate, and
 *      must not make a suppression into a fire or vice versa. `fire` outcomes
 *      are asserted directly against the pre-W11 contract: concurrent
 *      dual-fire → exactly one, distinct payloads → two, zero impossible.
 *   2. **Test writes stay in the sandbox.** A test-context emit aimed at this
 *      package's own events.jsonl lands in the D7 per-process sandbox. That
 *      exact escape was a real defect earlier in this release (184 fixture rows
 *      in the live log), so it gets its own assertion rather than a comment.
 *   3. **The log cannot flood.** The ordinary outcomes are sampled; the
 *      suppression, tamper and error reasons are not. Both halves are asserted,
 *      as is the partition itself — a new reason added to the module without a
 *      volume decision fails the completeness test.
 *
 * Runner: node --require ./tests/helpers/setup.js --test \
 *           bin/_lib/__tests__/v2318-w11-dedup-telemetry.test.js
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const hookStdin   = require('../hook-stdin.js');
const auditWriter = require('../audit-event-writer.js');

const {
  claim,
  claimDir,
  dedupKey,
  dedupDecision,
  shouldEmitDedup,
  dedupSampleRate,
  redactCaller,
  DEDUP_EVENT_TYPE,
  ALWAYS_EMIT_REASONS,
  DEDUP_SAMPLE_RATE,
  ENV_DEDUP_SAMPLE,
  ENV_DEDUP_WINDOW,
  ENV_DISABLE_DEDUP,
  ENV_LEGACY_BYPASS,
} = hookStdin._internal;

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..', '..');

const RAW     = '{"session_id":"w11-sess","tool_name":"Bash"}';
const PAYLOAD = JSON.parse(RAW);

const GLOBAL_CALLER = '/home/u/.claude/orchestray/bin/some-hook.js';
const LOCAL_CALLER  = '/home/u/proj/.claude/orchestray/bin/some-hook.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w11-'));
}

/** Where a temp-cwd emit lands. The writer only redirects PACKAGE_ROOT's log. */
function eventsPathFor(project) {
  return path.join(project, '.orchestray', 'audit', 'events.jsonl');
}

/** Every row in a JSONL log, or [] when it was never created. */
function readRows(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_e) { return []; }
  return text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch (_e) { return null; }
  }).filter(Boolean);
}

function dedupRows(file) {
  return readRows(file).filter((r) => r && r.type === DEDUP_EVENT_TYPE);
}

/** Run a decision end to end, including the emit. */
function decideIn(project, callerPath, raw) {
  return dedupDecision({
    callerPath,
    cwd:     project,
    raw:     raw || RAW,
    payload: raw ? JSON.parse(raw) : PAYLOAD,
  });
}

/** Force the sampled path on (rate 1) or off (rate 0) for deterministic tests. */
function withSampleRate(rate, fn) {
  const saved = process.env[ENV_DEDUP_SAMPLE];
  process.env[ENV_DEDUP_SAMPLE] = String(rate);
  try { return fn(); } finally {
    if (saved === undefined) delete process.env[ENV_DEDUP_SAMPLE];
    else process.env[ENV_DEDUP_SAMPLE] = saved;
  }
}

/** Run `fn` with the audit writer's writeEvent replaced. */
function withWriteEvent(replacement, fn) {
  const real = auditWriter.writeEvent;
  auditWriter.writeEvent = replacement;
  try { return fn(); } finally { auditWriter.writeEvent = real; }
}

function cleanup(project) {
  try { fs.rmSync(claimDir(project), { recursive: true, force: true }); } catch (_e) { /* */ }
  try { fs.rmSync(project, { recursive: true, force: true }); } catch (_e) { /* */ }
}

// ---------------------------------------------------------------------------

describe('W11: the decision is untouchable by its own telemetry', () => {
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    cleanup(project);
    delete process.env[ENV_DEDUP_WINDOW];
    delete process.env[ENV_DEDUP_SAMPLE];
    delete process.env[ENV_DISABLE_DEDUP];
    delete process.env[ENV_LEGACY_BYPASS];
  });

  test('a throwing audit writer changes no fire outcome and does not propagate', () => {
    const boom = () => { throw new Error('audit writer is down'); };

    withWriteEvent(boom, () => {
      withSampleRate(1, () => {
        // The full pre-W11 contract, asserted while every emit is throwing.
        let first, second;
        assert.doesNotThrow(() => { first = decideIn(project, LOCAL_CALLER); });
        assert.doesNotThrow(() => { second = decideIn(project, GLOBAL_CALLER); });

        assert.equal(first.fire, true);
        assert.equal(first.reason, 'claimed');
        assert.equal(second.fire, false, 'suppression survives a broken writer');
        assert.equal(second.reason, 'duplicate_install');
        assert.equal(second.firstCaller, LOCAL_CALLER);
      });
    });
  });

  test('a writer that returns garbage cannot turn a suppression into a fire', () => {
    // Not just throwing: a writer that returns a truthy/falsy value, mutates
    // its argument, or exits early must all be equally inert.
    const meddler = (event) => { event.fire = true; event.reason = 'claimed'; return false; };
    withWriteEvent(meddler, () => {
      withSampleRate(1, () => {
        assert.equal(decideIn(project, LOCAL_CALLER).fire, true);
        const second = decideIn(project, GLOBAL_CALLER);
        assert.equal(second.fire, false);
        assert.equal(second.reason, 'duplicate_install');
      });
    });
  });

  test('fire outcomes are identical with telemetry on and off', () => {
    const outcomes = (rate) => {
      const p = mkProject();
      try {
        return withSampleRate(rate, () => [
          decideIn(p, LOCAL_CALLER),
          decideIn(p, GLOBAL_CALLER),                    // dual-install race
          decideIn(p, LOCAL_CALLER),                     // same caller repeat
          decideIn(p, LOCAL_CALLER, '{"session_id":"w11-sess","tool_name":"Read"}'),
        ].map((d) => d.fire + ':' + d.reason));
      } finally { cleanup(p); }
    };
    assert.deepEqual(outcomes(1), outcomes(0), 'sampling must not change decisions');
    assert.deepEqual(outcomes(0), [
      'true:claimed', 'false:duplicate_install', 'true:same_caller_repeat', 'true:claimed',
    ]);
  });

  test('dedup behaviour unchanged: dual-fire → 1, distinct payloads → 2, zero impossible', () => {
    withSampleRate(1, () => {
      // Concurrent dual-fire on one payload: exactly one survivor.
      const race = [decideIn(project, LOCAL_CALLER), decideIn(project, GLOBAL_CALLER)];
      assert.equal(race.filter((d) => d.fire).length, 1);

      // Distinct payloads: both fire.
      const other = '{"session_id":"w11-sess","tool_name":"Write"}';
      const distinct = [
        decideIn(project, LOCAL_CALLER, other),
        decideIn(project, GLOBAL_CALLER, '{"session_id":"w11-sess","tool_name":"Glob"}'),
      ];
      assert.equal(distinct.filter((d) => d.fire).length, 2);

      // Zero is impossible: `duplicate_install` is the only fire:false there is.
      const all = race.concat(distinct);
      for (const d of all) {
        if (!d.fire) assert.equal(d.reason, 'duplicate_install');
      }
    });
  });
});

describe('W11: tampering and errors are always visible', () => {
  // A suppression's own shape (reason/fire/script/delta/sampled) is covered in
  // the W12 describe below, alongside the volume-policy tests it now belongs
  // with — `duplicate_install` moved to the sampled set there.
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    cleanup(project);
    delete process.env[ENV_DEDUP_WINDOW];
    delete process.env[ENV_DEDUP_SAMPLE];
  });

  test('a planted symlink claim emits claim_untrusted naming what failed', () => {
    withSampleRate(0, () => {
      const key  = dedupKey(LOCAL_CALLER, RAW, PAYLOAD);
      const dir  = claimDir(project);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

      // The W10 attack: the claim is a symlink to attacker-owned content.
      const target = path.join(project, 'planted.json');
      fs.writeFileSync(target, JSON.stringify({
        ts_ms: Date.now(), caller_path: '/home/attacker/bin/some-hook.js',
      }));
      fs.symlinkSync(target, path.join(dir, key + '.json'));

      const decision = decideIn(project, LOCAL_CALLER);
      assert.equal(decision.fire, true, 'W10: any doubt fires');

      const rows = dedupRows(eventsPathFor(project));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, 'claim_untrusted');
      assert.equal(rows[0].fire, true);
      assert.equal(rows[0].untrusted_at, 'claim_file');
      assert.equal(rows[0].untrusted_why, 'symlink');
      assert.equal(rows[0].sampled, false);
    });
  });

  test('an untrusted claim directory emits claim_dir_untrusted with the level', () => {
    withSampleRate(0, () => {
      const dir = claimDir(project);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o777);                   // world-writable leaf: a planting surface

      const decision = decideIn(project, LOCAL_CALLER);
      assert.equal(decision.fire, true);

      const rows = dedupRows(eventsPathFor(project));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, 'claim_dir_untrusted');
      assert.equal(rows[0].untrusted_at, 'leaf');
      assert.equal(rows[0].untrusted_why, 'lax_mode');
    });
  });

  test('a corrupt claim emits claim_unreadable; an expired one emits window_expired', () => {
    withSampleRate(0, () => {
      const key = dedupKey(LOCAL_CALLER, RAW, PAYLOAD);
      const dir = claimDir(project);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, key + '.json'), 'not json', { mode: 0o600 });

      assert.equal(decideIn(project, LOCAL_CALLER).reason, 'claim_unreadable');

      // Backdate the (now valid) claim past the window.
      process.env[ENV_DEDUP_WINDOW] = '1';
      fs.writeFileSync(path.join(dir, key + '.json'), JSON.stringify({
        ts_ms: Date.now() - 60000, caller_path: GLOBAL_CALLER,
      }), { mode: 0o600 });
      assert.equal(decideIn(project, LOCAL_CALLER).reason, 'window_expired');

      const reasons = dedupRows(eventsPathFor(project)).map((r) => r.reason);
      assert.deepEqual(reasons, ['claim_unreadable', 'window_expired']);
    });
  });

  test('an unusable claim directory emits claim_dir_unavailable', () => {
    withSampleRate(0, () => {
      // A regular file where the claim directory belongs → mkdir fails ENOTDIR.
      const dir = claimDir(project);
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      fs.writeFileSync(dir, 'not a directory');
      try {
        assert.equal(decideIn(project, LOCAL_CALLER).fire, true);
        const rows = dedupRows(eventsPathFor(project));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].reason, 'claim_dir_unavailable');
      } finally {
        fs.rmSync(dir, { force: true });
      }
    });
  });

  test('an internal throw emits dedup_error and still fires', () => {
    withSampleRate(0, () => {
      // `dedup_error` is the outermost catch in `decide` — reachable only by
      // making key derivation itself throw. The stub disarms after one throw so
      // the audit writer that follows still works.
      const crypto = require('node:crypto');
      const realCreateHash = crypto.createHash;
      let armed = true;
      crypto.createHash = function patched(...args) {
        if (armed) { armed = false; throw new Error('key derivation is down'); }
        return realCreateHash.apply(crypto, args);
      };

      let decision;
      try {
        decision = decideIn(project, LOCAL_CALLER);
      } finally { crypto.createHash = realCreateHash; }

      assert.equal(decision.fire, true, 'fail-open is absolute');
      assert.equal(decision.reason, 'dedup_error');

      const rows = dedupRows(eventsPathFor(project));
      assert.equal(rows.length, 1, 'the error path is never silent');
      assert.equal(rows[0].reason, 'dedup_error');
      assert.equal(rows[0].fire, true);
      assert.ok(ALWAYS_EMIT_REASONS.has(rows[0].reason), 'dedup_error must always emit');
    });
  });
});

describe('W11: volume policy', () => {
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    cleanup(project);
    delete process.env[ENV_DEDUP_SAMPLE];
    delete process.env[ENV_DISABLE_DEDUP];
    delete process.env[ENV_LEGACY_BYPASS];
  });

  test('the ordinary case is silent at the sampled rate and marked when it lands', () => {
    // rate 0: `claimed` — the outcome of essentially every hook invocation —
    // writes nothing. This is what keeps events.jsonl from gaining a row per
    // tool call.
    withSampleRate(0, () => {
      for (let i = 0; i < 25; i++) {
        decideIn(project, LOCAL_CALLER, '{"session_id":"w11-sess","n":' + i + '}');
      }
      assert.deepEqual(dedupRows(eventsPathFor(project)), []);
    });

    // rate 1: the same decisions land, tagged `sampled: true` so rate math can
    // scale them back up.
    withSampleRate(1, () => {
      decideIn(project, LOCAL_CALLER, '{"session_id":"w11-sess","n":"x"}');
      const rows = dedupRows(eventsPathFor(project));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, 'claimed');
      assert.equal(rows[0].fire, true);
      assert.equal(rows[0].sampled, true);
    });
  });

  test('operator kill switches are sampled, not per-invocation rows', () => {
    // Set once, these reasons recur on EVERY hook invocation for the life of
    // the machine's configuration. "Once per process" is no control at all
    // here — each hook is its own short-lived process.
    // A fresh project per phase — rows accumulate in one log, so a shared one
    // would let an earlier phase's row satisfy a later phase's assertion.
    const phase = (env, rate, fn) => {
      const p = mkProject();
      process.env[env] = '1';
      try { withSampleRate(rate, () => fn(p)); } finally {
        delete process.env[env];
        cleanup(p);
      }
    };

    phase(ENV_DISABLE_DEDUP, 0, (p) => {
      for (let i = 0; i < 10; i++) assert.equal(decideIn(p, LOCAL_CALLER).reason, 'kill_switch');
      assert.deepEqual(dedupRows(eventsPathFor(p)), [], '10 invocations, 0 rows');
    });

    phase(ENV_DISABLE_DEDUP, 1, (p) => {
      assert.equal(decideIn(p, LOCAL_CALLER).reason, 'kill_switch');
      const rows = dedupRows(eventsPathFor(p));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sampled, true);
    });

    phase(ENV_LEGACY_BYPASS, 0, (p) => {
      assert.equal(decideIn(p, LOCAL_CALLER).reason, 'legacy_kill_switch');
      assert.deepEqual(dedupRows(eventsPathFor(p)), []);
    });
  });

  test('rate 0 never silences a tamper or error signal, but does sample the suppression', () => {
    withSampleRate(0, () => {
      assert.equal(shouldEmitDedup('claim_untrusted'), true);
      assert.equal(shouldEmitDedup('claim_dir_untrusted'), true);
      assert.equal(shouldEmitDedup('claimed'), false);
      assert.equal(shouldEmitDedup('same_caller_repeat'), false);
      // W12: duplicate_install joined the sampled set — it is the ordinary
      // outcome on the losing install of a dual-install pair, not an anomaly.
      assert.equal(shouldEmitDedup('duplicate_install'), false);
    });
  });

  test('every reason the module can produce has a volume decision', () => {
    // Mechanical completeness: a new reason added to hook-stdin.js without a
    // deliberate always-emit/sampled choice fails here rather than silently
    // joining the flooding half.
    const ALL_REASONS = [
      'claimed', 'duplicate_install', 'same_caller_repeat', 'window_expired',
      'claim_unreadable', 'claim_untrusted', 'claim_dir_untrusted',
      'claim_dir_unavailable', 'claim_error', 'window_disabled',
      'kill_switch', 'legacy_kill_switch', 'dedup_error',
    ];
    const src = fs.readFileSync(path.join(__dirname, '..', 'hook-stdin.js'), 'utf8');
    for (const reason of ALL_REASONS) {
      assert.ok(src.includes("'" + reason + "'"), 'reason ' + reason + ' still exists in the module');
    }
    // The two halves partition the reason space with nothing left over.
    // W12: duplicate_install joined the sampled half (see hook-stdin.js).
    const sampled = ALL_REASONS.filter((r) => !ALWAYS_EMIT_REASONS.has(r));
    assert.deepEqual(sampled.sort(), [
      'claimed', 'duplicate_install', 'kill_switch', 'legacy_kill_switch',
      'same_caller_repeat', 'window_disabled',
    ]);
    for (const r of ALWAYS_EMIT_REASONS) {
      assert.ok(ALL_REASONS.includes(r), 'always-emit reason ' + r + ' is not a real reason');
    }
  });

  test('the default rate is a sampling rate, and bad overrides fall back to it', () => {
    assert.ok(DEDUP_SAMPLE_RATE > 0 && DEDUP_SAMPLE_RATE <= 0.05,
      'default must sample, not flood');
    const cases = { 'abc': DEDUP_SAMPLE_RATE, '-1': DEDUP_SAMPLE_RATE,
      '2': DEDUP_SAMPLE_RATE, '0': 0, '1': 1, '0.5': 0.5 };
    for (const [raw, want] of Object.entries(cases)) {
      process.env[ENV_DEDUP_SAMPLE] = raw;
      assert.equal(dedupSampleRate(), want, 'rate override ' + JSON.stringify(raw));
    }
    delete process.env[ENV_DEDUP_SAMPLE];
  });

  test('sampled rows are off under the test harness, and the override still wins', () => {
    // Without this, every spawned-hook test that counts rows in its own
    // events.jsonl fails one run in a hundred on a row it never asked for.
    // Two such tests (collect-agent-metrics, validate-task-completion) caught
    // it. Same rule as `harvestEnabled`: synthetic runs produce no statistics
    // worth sampling.
    const savedTest = process.env.ORCHESTRAY_TEST;
    const savedNode = process.env.NODE_ENV;
    delete process.env[ENV_DEDUP_SAMPLE];
    try {
      process.env.ORCHESTRAY_TEST = '1';
      assert.equal(dedupSampleRate(), 0, 'no sampled rows under test');

      delete process.env.ORCHESTRAY_TEST;
      process.env.NODE_ENV = 'test';
      assert.equal(dedupSampleRate(), 0, 'NODE_ENV=test counts too');

      delete process.env.NODE_ENV;
      assert.equal(dedupSampleRate(), DEDUP_SAMPLE_RATE, 'production samples at the default');

      // The override beats the test default in both directions.
      process.env.ORCHESTRAY_TEST = '1';
      process.env[ENV_DEDUP_SAMPLE] = '1';
      assert.equal(dedupSampleRate(), 1);
    } finally {
      delete process.env[ENV_DEDUP_SAMPLE];
      if (savedTest === undefined) delete process.env.ORCHESTRAY_TEST;
      else process.env.ORCHESTRAY_TEST = savedTest;
      if (savedNode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNode;
    }
  });

  test('under test with no override: ordinary decisions AND suppressions stay silent by default', () => {
    // W12: duplicate_install is sampled now, same as claimed — a synthetic
    // dual-install run must not pollute the sandbox denominator either, for
    // the identical reason a synthetic single-install run already did not.
    delete process.env[ENV_DEDUP_SAMPLE];
    const p = mkProject();
    try {
      for (let i = 0; i < 50; i++) {
        decideIn(p, LOCAL_CALLER, '{"session_id":"w11-sess","n":' + i + '}');
      }
      assert.deepEqual(dedupRows(eventsPathFor(p)), [], '50 ordinary decisions, 0 rows');

      decideIn(p, LOCAL_CALLER);
      const suppressed = decideIn(p, GLOBAL_CALLER);
      assert.equal(suppressed.fire, false);
      assert.equal(suppressed.reason, 'duplicate_install');
      assert.deepEqual(dedupRows(eventsPathFor(p)), [],
        'the suppression is sampled away too under the same default');
    } finally { cleanup(p); }
  });
});

describe('W12: duplicate_install joined the sampled set', () => {
  // Through W11 this reason always emitted, reasoning it was rare because it
  // was the suppression itself. It is not rare — on a dual-install machine it
  // is the ordinary outcome on the losing install, 1:1 with hook traffic —
  // measured at ~10,000 rows/session, a third flooder in one release.
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    cleanup(project);
    delete process.env[ENV_DEDUP_SAMPLE];
    delete process.env[ENV_DEDUP_WINDOW];
  });

  test('a suppression carries the same shape as before, marked sampled when it lands', () => {
    withSampleRate(1, () => {          // force the sampled path to inspect the row's shape
      decideIn(project, LOCAL_CALLER);
      const decision = decideIn(project, GLOBAL_CALLER);
      assert.equal(decision.fire, false);

      const rows = dedupRows(eventsPathFor(project)).filter((r) => r.reason === 'duplicate_install');
      assert.equal(rows.length, 1, 'exactly the suppression row for this reason');
      const row = rows[0];
      assert.equal(row.reason, 'duplicate_install');
      assert.equal(row.fire, false);
      assert.equal(row.script, 'some-hook.js');
      assert.equal(row.sampled, true, 'W12: no longer always-emit');
      assert.equal(row.session_id, 'w11-sess');
      assert.equal(typeof row.delta_ms, 'number');
      assert.ok(row.first_caller, 'the losing race needs its counterparty');
    });
  });

  test('an operator debugging one suppression forces it with the sample-rate override', () => {
    withSampleRate(0, () => {
      decideIn(project, LOCAL_CALLER);
      const suppressed = decideIn(project, GLOBAL_CALLER);
      assert.equal(suppressed.fire, false);
      assert.deepEqual(dedupRows(eventsPathFor(project)), [], 'silent at the default rate');
    });
    withSampleRate(1, () => {
      decideIn(project, LOCAL_CALLER, '{"session_id":"w11-sess","n":"forced"}');
      const suppressed = decideIn(project, GLOBAL_CALLER, '{"session_id":"w11-sess","n":"forced"}');
      assert.equal(suppressed.fire, false);
      const rows = dedupRows(eventsPathFor(project)).filter((r) => r.reason === 'duplicate_install');
      assert.equal(rows.length, 1, 'ORCHESTRAY_HOOK_DEDUP_SAMPLE_RATE=1 answers exactly, on demand');
    });
  });

  test('duplicate_install and claimed are sampled at the identical rate', () => {
    // Their sampled counts must remain a valid estimator of the true
    // suppression ratio — that requires the SAME rate, not independent ones.
    withSampleRate(0, () => {
      assert.equal(shouldEmitDedup('claimed'), false);
      assert.equal(shouldEmitDedup('duplicate_install'), false);
    });
    withSampleRate(1, () => {
      assert.equal(shouldEmitDedup('claimed'), true);
      assert.equal(shouldEmitDedup('duplicate_install'), true);
    });
    // Structural guarantee behind the runtime behaviour above: exactly one
    // rate call governs every sampled reason, not a per-reason rate.
    const src = fs.readFileSync(path.join(__dirname, '..', 'hook-stdin.js'), 'utf8');
    const fnBody = src.slice(src.indexOf('function shouldEmitDedup'), src.indexOf('function redactCaller'));
    assert.equal((fnBody.match(/dedupSampleRate\(\)/g) || []).length, 1,
      'exactly one rate call governs every sampled reason');
  });

  test('dual-install traffic produces a row count bounded by the sample rate, not by tool-call volume', () => {
    // The regression this fix exists for: N tool-calls where the second
    // install always yields must NOT cost N rows. Pre-fix, duplicate_install
    // was unconditional and this assertion fails (verified by hand against
    // the pre-fix ALWAYS_EMIT_REASONS set — see W12 handoff notes).
    const N = 500;
    withSampleRate(DEDUP_SAMPLE_RATE, () => {   // the real production default, not forced
      for (let i = 0; i < N; i++) {
        const raw = '{"session_id":"w12-sess","n":' + i + '}';
        const winner = decideIn(project, LOCAL_CALLER, raw);
        const loser  = decideIn(project, GLOBAL_CALLER, raw);
        assert.equal(winner.fire, true);
        assert.equal(loser.fire, false);
        assert.equal(loser.reason, 'duplicate_install');
      }
    });

    const rows = dedupRows(eventsPathFor(project));
    // Expected rows at 1% over 2N decisions ~= 2N * 0.01 = 10 for N=500.
    // N/2 = 250 leaves two orders of magnitude of headroom for that
    // deterministically, while a pre-fix run (N unconditional rows alone)
    // clears N/2 easily and fails this bound.
    assert.ok(rows.length < N / 2,
      'row count ' + rows.length + ' must not scale with tool-call volume (N=' + N + ')');
  });
});

describe('W11: the log leaks no filesystem paths', () => {
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => { cleanup(project); delete process.env[ENV_DEDUP_SAMPLE]; });

  test('first_caller is a hashed projection, never the caller path', () => {
    const redacted = redactCaller(LOCAL_CALLER);
    assert.ok(!redacted.includes('/home/u'), 'no home directory');
    assert.ok(!redacted.includes('proj'), 'no directory names');
    assert.match(redacted, /^#[0-9a-f]{12}\/some-hook\.js$/);

    // It still distinguishes the two installs — that is the whole diagnostic
    // value, and a basename alone would not (the dedup key is built from the
    // basename, so both sides of a collision always share it).
    assert.notEqual(redactCaller(GLOBAL_CALLER), redactCaller(LOCAL_CALLER));
    assert.equal(redactCaller(LOCAL_CALLER), redactCaller(LOCAL_CALLER), 'stable across rows');
    assert.equal(redactCaller(''), null);
  });

  test('no emitted row contains an absolute path', () => {
    withSampleRate(1, () => {
      decideIn(project, LOCAL_CALLER);
      decideIn(project, GLOBAL_CALLER);                  // suppression, carries first_caller

      const rows = dedupRows(eventsPathFor(project));
      assert.ok(rows.length >= 2);
      for (const row of rows) {
        for (const [field, value] of Object.entries(row)) {
          if (typeof value !== 'string') continue;
          if (field === 'timestamp' || field === 'orchestration_id') continue;
          assert.ok(!/^\/|^[A-Za-z]:\\/.test(value),
            'field ' + field + ' looks like an absolute path: ' + value);
          assert.ok(!value.includes(os.homedir()),
            'field ' + field + ' leaks a home directory');
        }
      }
    });
  });

  test('a planted symlink target is never resolved into the log', () => {
    withSampleRate(0, () => {
      const key = dedupKey(LOCAL_CALLER, RAW, PAYLOAD);
      const dir = claimDir(project);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // A target whose path is the secret — a real attacker picks something
      // like another user's key file. It must not appear anywhere in the row.
      const secret = path.join(project, 'victim-secret-do-not-log.json');
      fs.writeFileSync(secret, '{}');
      fs.symlinkSync(secret, path.join(dir, key + '.json'));

      decideIn(project, LOCAL_CALLER);
      const rows = dedupRows(eventsPathFor(project));
      assert.equal(rows.length, 1);
      assert.ok(!JSON.stringify(rows[0]).includes('victim-secret'),
        'the symlink target is attacker-chosen and must never be logged');
    });
  });
});

describe('W11: test-context emits stay in the D7 sandbox', () => {
  // The sandbox log is shared by every test file in the run (setup.js pins it
  // to the runner's pid and children inherit it), so these assertions key on a
  // marker unique to this test rather than on row counts.
  const LIVE_LOG = path.join(PACKAGE_ROOT, '.orchestray', 'audit', 'events.jsonl');

  /** Emit one dedup row against the REAL project root, under a unique marker. */
  function probe(tag) {
    const marker = 'w11-' + tag + '-' + process.pid + '-' + Date.now();
    const raw = JSON.stringify({ session_id: marker, tool_name: 'Bash' });
    const caller = '/home/u/.claude/orchestray/bin/w11-' + tag + '-probe.js';
    const payload = JSON.parse(raw);
    let decision;
    try {
      withSampleRate(1, () => {
        decision = dedupDecision({ callerPath: caller, cwd: PACKAGE_ROOT, raw, payload });
      });
    } finally {
      // Never leave a claim behind for the real project — a stray one could
      // suppress a genuine hook for this repo within the window.
      try {
        fs.rmSync(path.join(claimDir(PACKAGE_ROOT), dedupKey(caller, raw, payload) + '.json'),
          { force: true });
      } catch (_e) { /* */ }
    }
    return { marker, decision, script: 'w11-' + tag + '-probe.js' };
  }

  test('an emit resolving to this package\'s own log lands in the sandbox instead', () => {
    const liveBefore = readRows(LIVE_LOG).length;
    const { marker, decision, script } = probe('d7');
    assert.equal(decision.fire, true);

    const liveAfter = readRows(LIVE_LOG);
    assert.equal(liveAfter.length, liveBefore,
      'the live project audit log must not grow under test');
    assert.equal(liveAfter.filter((r) => r.session_id === marker).length, 0,
      'the row must not be in the live log');
    assert.equal(liveAfter.filter((r) => r.type === DEDUP_EVENT_TYPE).length, 0,
      'no dedup row may ever appear in the live log from a test');

    const mine = dedupRows(auditWriter._testHooks.sandboxEventsPath())
      .filter((r) => r.session_id === marker);
    assert.equal(mine.length, 1, 'the row landed in the sandbox');
    assert.equal(mine[0].script, script);
  });

  test('the registered schema accepts the emitted shape', () => {
    // This emit validates against the REAL event-schemas.md (cwd is the
    // package root), so a missing required field or an undeclared optional
    // would surface as a validator surrogate rather than a clean row.
    const { marker } = probe('schema');
    const sandbox = readRows(auditWriter._testHooks.sandboxEventsPath());

    const ours = sandbox.filter((r) => r.type === DEDUP_EVENT_TYPE && r.session_id === marker);
    assert.equal(ours.length, 1, 'exactly one row, not a surrogate');
    assert.equal(ours[0].version, 1);
    assert.ok(ours[0].timestamp, 'timestamp autofilled');
    assert.ok('orchestration_id' in ours[0], 'orchestration_id autofilled');

    // No surrogate anywhere in the log may name our event type — this module
    // is its only emitter, so scanning the whole sandbox is exact.
    for (const row of sandbox) {
      if (row.type === 'schema_unknown_type_warn') {
        assert.notEqual(row.unknown_event_type, DEDUP_EVENT_TYPE,
          'the event type must be registered in event-schemas.md');
      }
      if (row.type === 'schema_shape_violation') {
        assert.notEqual(row.event_type, DEDUP_EVENT_TYPE, 'undeclared field in the schema');
      }
      if (row.type === 'schema_shadow_validation_block') {
        assert.notEqual(row.blocked_event_type, DEDUP_EVENT_TYPE, 'missing required field');
      }
    }
  });
});
