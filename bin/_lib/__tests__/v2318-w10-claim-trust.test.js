#!/usr/bin/env node
'use strict';

/**
 * v2318-w10-claim-trust.test.js — the claim file is a blackout primitive
 * unless its integrity is proven (v2.3.18 W10).
 *
 * W9 deleted the install-topology layer, leaving the atomic claim file as the
 * SOLE dedup mechanism. That made `caller_path` — read out of a file in a
 * world-writable directory at a fully derivable path — the only input in
 * `hook-stdin.js` that can return `fire: false`.
 *
 * The path is derivable because both of its ingredients are public: the uid
 * segment, and `sha256(cwd)` for a cwd anyone who can see the process knows.
 * So on any shared host an attacker can pre-create the claim, put a fabricated
 * `caller_path` in it, and refresh `ts_ms` on a timer. Every genuine hook then
 * reads a "different caller inside the window" and suppresses itself. That is
 * the exact silence class W9 removed Layer 1 to close, reintroduced through the
 * filesystem instead of through inference.
 *
 * These tests are written adversarially: each one plants the attack and asserts
 * the hook FIRES. Every one of them is silent against pre-W10 sources.
 *
 * The load-bearing property, stated once: **suppression requires positive proof
 * that the claim is ours. Any doubt fires.** A duplicate is visible; a blackout
 * is not.
 *
 * Runner: node --require ./tests/helpers/setup.js --test \
 *           bin/_lib/__tests__/v2318-w10-claim-trust.test.js
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const hookStdin = require('../hook-stdin.js');
const {
  claim,
  claimDir,
  dedupKey,
  claimFileTrusted,
  verifyClaimDir,
  ENV_DEDUP_WINDOW,
} = hookStdin._internal;

const RAW     = '{"session_id":"w10","tool_name":"Bash"}';
const PAYLOAD = JSON.parse(RAW);

const VICTIM_CALLER   = '/home/u/.claude/orchestray/bin/some-hook.js';
const SIBLING_CALLER  = '/home/u/proj/.claude/orchestray/bin/some-hook.js';
const FABRICATED_CALLER = '/home/attacker/.claude/orchestray/bin/some-hook.js';

const KEY = dedupKey(VICTIM_CALLER, RAW, PAYLOAD);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A fresh project root. Only its PATH matters — `claimDir` hashes it and never
 * touches it — but a real directory keeps the fixture honest.
 */
function mkProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w10-'));
}

/** The claim file an attacker who knows the project path can compute. */
function claimPath(project, key) {
  return path.join(claimDir(project), (key || KEY) + '.json');
}

/** A claim record that looks like a live sibling install holding the key. */
function fabricatedRecord(caller) {
  return JSON.stringify({
    ts_ms: Date.now(),
    caller_path: caller || FABRICATED_CALLER,
    pid: 4242,
  });
}

function modeOf(p) {
  return fs.lstatSync(p).mode & 0o777;
}

/**
 * Run `fn` with `fs.lstatSync` reporting a foreign uid for `targets`.
 *
 * An unprivileged test cannot chown a file, so this is the only way to reach
 * the foreign-owner branch. Everything else about the file stays real, and the
 * dir/file distinction the module makes is preserved: only the listed paths
 * report someone else's uid.
 */
function withForeignOwner(targets, fn) {
  const real = fs.lstatSync;
  const want = targets.map(String);
  fs.lstatSync = function patchedLstat(p, opts) {
    const st = real.call(fs, p, opts);
    if (st && want.includes(String(p))) {
      return Object.create(st, { uid: { value: st.uid + 1, enumerable: true } });
    }
    return st;
  };
  try { return fn(); } finally { fs.lstatSync = real; }
}

/** Run `fn` on a platform shape with no `process.getuid` (win32). */
function withoutGetuid(fn) {
  const saved = process.getuid;
  delete process.getuid;
  try { return fn(); } finally { process.getuid = saved; }
}

// ---------------------------------------------------------------------------

describe('W10: a planted claim cannot silence a hook', () => {
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    try { fs.rmSync(claimDir(project), { recursive: true, force: true }); } catch (_e) { /* */ }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_e) { /* */ }
    delete process.env[ENV_DEDUP_WINDOW];
  });

  test('THE REPRO: a symlinked claim pointing at attacker content → the hook FIRES', () => {
    // The full attack, unprivileged and end-to-end realistic. os.tmpdir() is
    // world-writable, so anyone can create this symlink; the claim's content
    // then lives in a file the attacker owns and can refresh forever.
    //
    // Pre-W10: open(..., 'wx') fails EEXIST on the link, readFileSync FOLLOWS
    // it, the fabricated caller_path differs from ours → fire:false. Silence,
    // indefinitely, for every hook in the process tree.
    const attackerFile = path.join(project, 'attacker-controlled.json');
    fs.writeFileSync(attackerFile, fabricatedRecord());

    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.symlinkSync(attackerFile, file);

    const decision = claim(project, KEY, VICTIM_CALLER);

    assert.equal(decision.fire, true, 'BLACKOUT: a planted symlink suppressed the hook');
    assert.equal(decision.reason, 'claim_untrusted');
    assert.notEqual(decision.reason, 'duplicate_install');
  });

  test('the symlinked claim is not WRITTEN through either — the target is untouched', () => {
    // The second half of the same defect: `writeFileSync` on the re-claim paths
    // followed the link and truncated whatever it pointed at. `wx` gives
    // O_EXCL, not O_NOFOLLOW, and no intermediate component was protected.
    const attackerFile = path.join(project, 'attacker-controlled.json');
    const original = fabricatedRecord();
    fs.writeFileSync(attackerFile, original);

    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.symlinkSync(attackerFile, file);

    assert.equal(claim(project, KEY, VICTIM_CALLER).fire, true);

    assert.equal(
      fs.readFileSync(attackerFile, 'utf8'), original,
      'the symlink target must not be written through');
    assert.equal(
      fs.lstatSync(file).isSymbolicLink(), false,
      'the planted link must be destroyed, not followed');
    assert.equal(modeOf(file), 0o600, 'the replacement claim is created 0o600');
  });

  test('a symlink pointing OUTSIDE tmpdir cannot be created through, either', () => {
    // The destructive variant: point the claim at a file the victim owns and
    // let the hook truncate it. Nothing may be created or written at the
    // target — the takeover unlinks the link and creates a fresh regular file.
    const victimFile = path.join(project, 'important-state.json');
    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.symlinkSync(victimFile, file);           // dangling on purpose

    assert.equal(claim(project, KEY, VICTIM_CALLER).fire, true);

    assert.equal(fs.existsSync(victimFile), false,
      'a dangling symlink must not be created through');
    assert.equal(fs.lstatSync(file).isFile(), true);
  });

  test('a world-writable claim file with a fabricated caller → the hook FIRES', () => {
    // No symlink needed: if the claim itself is writable by others, the
    // attacker rewrites its bytes in place and owns the suppression decision.
    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, fabricatedRecord());
    fs.chmodSync(file, 0o666);

    const decision = claim(project, KEY, VICTIM_CALLER);

    assert.equal(decision.fire, true, 'BLACKOUT: an attacker-writable claim suppressed the hook');
    assert.equal(decision.reason, 'claim_untrusted');
    assert.equal(modeOf(file), 0o600, 'the untrusted claim is replaced, not left in place');
  });

  test('a group-writable claim file is untrusted too', () => {
    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, fabricatedRecord());
    fs.chmodSync(file, 0o620);

    assert.equal(claim(project, KEY, VICTIM_CALLER).reason, 'claim_untrusted');
  });

  test('a foreign-owned claim file → the hook FIRES', () => {
    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, fabricatedRecord(), { mode: 0o600 });

    const decision = withForeignOwner([file], () => claim(project, KEY, VICTIM_CALLER));

    assert.equal(decision.fire, true, 'BLACKOUT: a foreign-owned claim suppressed the hook');
    assert.equal(decision.reason, 'claim_untrusted');
  });

  test('a claim that is a directory, a fifo or anything but a regular file → FIRES', () => {
    const file = claimPath(project);
    fs.mkdirSync(file, { recursive: true, mode: 0o700 });   // claim path is a dir

    const decision = claim(project, KEY, VICTIM_CALLER);
    assert.equal(decision.fire, true);
    assert.notEqual(decision.reason, 'duplicate_install');
  });

  test('claimFileTrusted rejects every tampered shape and accepts our own claim', () => {
    const dir = claimDir(project);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const ours = path.join(dir, 'ours.json');
    fs.writeFileSync(ours, '{}', { mode: 0o600 });
    assert.equal(claimFileTrusted(ours), true);

    const missing = path.join(dir, 'missing.json');
    assert.equal(claimFileTrusted(missing), false);

    const link = path.join(dir, 'link.json');
    fs.symlinkSync(ours, link);
    assert.equal(claimFileTrusted(link), false, 'a symlink is never trusted');

    const lax = path.join(dir, 'lax.json');
    fs.writeFileSync(lax, '{}');
    fs.chmodSync(lax, 0o646);
    assert.equal(claimFileTrusted(lax), false, 'other-writable is never trusted');

    assert.equal(withForeignOwner([ours], () => claimFileTrusted(ours)), false);
  });
});

describe('W10: the claim directory is verified, not assumed', () => {
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    try { fs.rmSync(claimDir(project), { recursive: true, force: true }); } catch (_e) { /* */ }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_e) { /* */ }
  });

  test('claim() creates its directory 0o700 and its claim 0o600', () => {
    assert.equal(claim(project, KEY, VICTIM_CALLER).reason, 'claimed');
    assert.equal(modeOf(claimDir(project)), 0o700);
    assert.equal(modeOf(claimPath(project)), 0o600);
  });

  test('a pre-planted world-writable leaf directory → FIRES, and is tightened', () => {
    // `mkdirSync(..., { recursive: true, mode: 0o700 })` applies the mode only
    // to directories it actually creates. A pre-planted 0o777 leaf survives it
    // untouched, and write access to the leaf is exactly what planting a claim
    // requires — so this must never be assumed away.
    const dir = claimDir(project);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o777);
    fs.writeFileSync(path.join(dir, KEY + '.json'), fabricatedRecord(), { mode: 0o600 });

    const decision = claim(project, KEY, VICTIM_CALLER);

    assert.equal(decision.fire, true, 'BLACKOUT: a world-writable claim dir suppressed the hook');
    assert.equal(decision.reason, 'claim_dir_untrusted');
    assert.equal(modeOf(dir), 0o700, 'the directory is repaired as well as rejected');
  });

  test('a group-writable leaf directory → FIRES', () => {
    const dir = claimDir(project);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o770);
    assert.equal(claim(project, KEY, VICTIM_CALLER).reason, 'claim_dir_untrusted');
  });

  test('a symlinked leaf directory → FIRES (mkdir -p would have followed it)', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w10-evil-'));
    const dir = claimDir(project);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, dir);
    try {
      const decision = claim(project, KEY, VICTIM_CALLER);
      assert.equal(decision.fire, true);
      assert.equal(decision.reason, 'claim_dir_untrusted');
    } finally {
      fs.rmSync(dir, { force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('a symlinked PARENT directory → FIRES', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-w10-evilp-'));
    const dir    = claimDir(project);
    const parent = path.dirname(dir);
    // The real parent is shared with every other claim on this machine, so
    // stage the swap on a private copy of the layout instead of moving it.
    const staged = path.join(elsewhere, path.basename(parent));
    fs.symlinkSync(os.tmpdir(), staged);
    try {
      assert.equal(
        verifyClaimDir(path.join(staged, path.basename(dir))).reason,
        'claim_dir_untrusted');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('foreign-owned directories → FIRES', () => {
    const dir = claimDir(project);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const decision = withForeignOwner(
      [dir, path.dirname(dir)],
      () => claim(project, KEY, VICTIM_CALLER));

    assert.equal(decision.fire, true, 'BLACKOUT: a foreign-owned claim dir suppressed the hook');
    assert.equal(decision.reason, 'claim_dir_untrusted');
  });

  test('a lax PARENT is repaired in place and does not cost a fire', () => {
    // The parent is shared across every project on the machine. Planting a
    // claim needs write access to the LEAF, not to the parent — write access
    // here only lets an attacker remove the leaf, which costs a duplicate, and
    // any leaf they put back is foreign-owned and rejected. Rejecting instead
    // of repairing would fire once per project on every machine upgrading from
    // a release that created the parent with the default mode.
    const dir    = claimDir(project);
    const parent = path.dirname(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const savedParentMode = modeOf(parent);
    fs.chmodSync(parent, 0o777);
    try {
      assert.equal(claim(project, KEY, VICTIM_CALLER).reason, 'claimed');
      assert.equal(modeOf(parent), 0o700, 'the shared parent is tightened on the way through');
      const second = claim(project, KEY, SIBLING_CALLER);
      assert.equal(second.fire, false, 'dedup still works once the parent is repaired');
      assert.equal(second.reason, 'duplicate_install');
    } finally {
      try { fs.chmodSync(parent, savedParentMode); } catch (_e) { /* */ }
    }
  });
});

describe('W10: zero fires stay impossible, one fire stays guaranteed', () => {
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    try { fs.rmSync(claimDir(project), { recursive: true, force: true }); } catch (_e) { /* */ }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_e) { /* */ }
    delete process.env[ENV_DEDUP_WINDOW];
  });

  // Every tamper shape an unprivileged attacker can stage, swept in one place.
  // The assertion is uniform because the rule is uniform: doubt fires.
  const TAMPERS = [
    ['symlinked claim', (dir, file) => {
      const target = path.join(dir, 'attacker.json');
      fs.writeFileSync(target, fabricatedRecord());
      fs.symlinkSync(target, file);
    }],
    ['dangling symlinked claim', (dir, file) => {
      fs.symlinkSync(path.join(dir, 'nowhere.json'), file);
    }],
    ['world-writable claim', (dir, file) => {
      fs.writeFileSync(file, fabricatedRecord());
      fs.chmodSync(file, 0o666);
    }],
    ['claim replaced by a directory', (dir, file) => { fs.mkdirSync(file); }],
    ['truncated claim', (dir, file) => { fs.writeFileSync(file, '', { mode: 0o600 }); }],
    ['claim holding a JSON scalar', (dir, file) => {
      fs.writeFileSync(file, '"not-a-record"', { mode: 0o600 });
    }],
    ['claim with a far-future ts_ms', (dir, file) => {
      fs.writeFileSync(file, JSON.stringify({
        ts_ms: Date.now() + 86400000, caller_path: FABRICATED_CALLER,
      }), { mode: 0o600 });
    }],
    ['world-writable claim directory', (dir, file) => {
      fs.writeFileSync(file, fabricatedRecord(), { mode: 0o600 });
      fs.chmodSync(dir, 0o777);
    }],
  ];

  for (const [name, plant] of TAMPERS) {
    test('tamper: ' + name + ' → fire', () => {
      const dir  = claimDir(project);
      const file = path.join(dir, KEY + '.json');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      plant(dir, file);

      const decision = claim(project, KEY, VICTIM_CALLER);
      assert.equal(decision.fire, true, 'BLACKOUT via ' + name);
      assert.notEqual(decision.reason, 'duplicate_install');
    });
  }

  test('regression: the legitimate dedup contract is unchanged', () => {
    // One emit for a duplicate payload from a sibling install...
    const first = claim(project, KEY, VICTIM_CALLER);
    assert.equal(first.fire, true);
    assert.equal(first.reason, 'claimed');

    const second = claim(project, KEY, SIBLING_CALLER);
    assert.equal(second.fire, false, 'the sibling install must still be suppressed');
    assert.equal(second.reason, 'duplicate_install');
    assert.equal(second.firstCaller, VICTIM_CALLER);

    // ...two for genuinely distinct payloads...
    const otherRaw = '{"session_id":"w10","tool_name":"Read"}';
    const otherKey = dedupKey(VICTIM_CALLER, otherRaw, JSON.parse(otherRaw));
    assert.equal(claim(project, otherKey, SIBLING_CALLER).fire, true);

    // ...and a same-caller repeat is never a dual-install race.
    assert.equal(claim(project, KEY, VICTIM_CALLER).reason, 'same_caller_repeat');
  });

  test('regression: an expired window is taken over without following a symlink', () => {
    process.env[ENV_DEDUP_WINDOW] = '1';
    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({
      ts_ms: Date.now() - 60000, caller_path: SIBLING_CALLER,
    }), { mode: 0o600 });

    const decision = claim(project, KEY, VICTIM_CALLER);
    assert.equal(decision.fire, true);
    assert.equal(decision.reason, 'window_expired');
    assert.equal(modeOf(file), 0o600, 'the takeover re-creates the claim, it does not truncate');
    assert.equal(
      JSON.parse(fs.readFileSync(file, 'utf8')).caller_path, VICTIM_CALLER,
      'the takeover must land');
  });

  test('regression: a corrupt claim is taken over and fires', () => {
    const file = claimPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, 'not json', { mode: 0o600 });

    const decision = claim(project, KEY, VICTIM_CALLER);
    assert.equal(decision.fire, true);
    assert.equal(decision.reason, 'claim_unreadable');
    assert.equal(
      JSON.parse(fs.readFileSync(file, 'utf8')).caller_path, VICTIM_CALLER);
  });
});

describe('W10: platforms without process.getuid degrade, they do not throw', () => {
  let project;

  beforeEach(() => { project = mkProject(); });
  afterEach(() => {
    withoutGetuid(() => {
      try { fs.rmSync(path.dirname(claimDir(project)), { recursive: true, force: true }); }
      catch (_e) { /* */ }
    });
    try { fs.rmSync(claimDir(project), { recursive: true, force: true }); } catch (_e) { /* */ }
    try { fs.rmSync(project, { recursive: true, force: true }); } catch (_e) { /* */ }
  });

  test('the dedup contract still holds with no uid available', () => {
    withoutGetuid(() => {
      assert.equal(claimDir(project).includes('orchestray-hook-dedup-u'), true,
        'the uid path segment degrades to a literal, it does not throw');
      assert.equal(claim(project, KEY, VICTIM_CALLER).reason, 'claimed');
      const second = claim(project, KEY, SIBLING_CALLER);
      assert.equal(second.fire, false);
      assert.equal(second.reason, 'duplicate_install');
    });
  });

  test('the symlink check survives the loss of ownership checks', () => {
    // Ownership and mode bits are meaningless on win32, but link identity is
    // not — so the one check that still means something must still run. The
    // residual exposure (a same-uid tamper we cannot distinguish there) is
    // documented in the module header.
    withoutGetuid(() => {
      const file = claimPath(project);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const target = path.join(project, 'attacker.json');
      fs.writeFileSync(target, fabricatedRecord());
      fs.symlinkSync(target, file);

      const decision = claim(project, KEY, VICTIM_CALLER);
      assert.equal(decision.fire, true);
      assert.equal(decision.reason, 'claim_untrusted');
      assert.equal(fs.readFileSync(target, 'utf8').includes('attacker'), true);
    });
  });
});
