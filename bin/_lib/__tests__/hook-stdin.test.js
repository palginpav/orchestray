#!/usr/bin/env node
'use strict';

/**
 * hook-stdin.test.js — the shared hook entry point (v2.3.18 W0).
 *
 * Covers:
 *   - readHookInput() as a drop-in for all three legacy stdin patterns
 *     (`process.stdin.on('data'/'end')`, `readFileSync(0)`, `/dev/stdin`).
 *   - Fail-open on malformed / empty / non-object stdin.
 *   - The D1 dual-install dedup guard: duplicate suppressed, distinct payloads
 *     both pass, same-caller repeats both pass, window expiry, kill switch.
 *   - Structure-preserving redaction and the dormant-by-default BDG harvest.
 *
 * Runner: node --test bin/_lib/__tests__/hook-stdin.test.js
 *
 * Isolation contract: every filesystem assertion runs inside an mkdtemp
 * sandbox; child processes are spawned with cwd pinned to that sandbox.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { execFileSync } = require('node:child_process');

const hookStdin = require('../hook-stdin.js');
const { readHookInput, readHookInputRaw } = hookStdin;
const {
  parsePayload,
  dedupKey,
  claim,
  claimDir,
  dedupDecision,
  redact,
  harvest,
  harvestEnabled,
  _resetCache,
  _seedCache,
  ENV_DISABLE_DEDUP,
  ENV_DEDUP_WINDOW,
  ENV_HARVEST,
} = hookStdin._internal;

const LIB_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A sandbox project root with a state dir for the harvest snapshot tests. */
function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-hook-stdin-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  return dir;
}

/**
 * Run a one-liner in a child process with `input` piped on stdin. `body` is
 * evaluated with `readHookInput` / `readHookInputRaw` in scope and must print
 * its own result. Returns { stdout, status }.
 */
function runChild(body, input, opts = {}) {
  const script = `
    const { readHookInput, readHookInputRaw } = require(${JSON.stringify(path.join(LIB_DIR, 'hook-stdin.js'))});
    ${body}
  `;
  const env = Object.assign({}, process.env, opts.env || {});
  // Child scripts run outside any install tree, so install-path priority is a no-op.
  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      input,
      cwd: opts.cwd || process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    return { stdout, status: 0 };
  } catch (e) {
    return { stdout: String(e.stdout || ''), status: typeof e.status === 'number' ? e.status : 99 };
  }
}

// ---------------------------------------------------------------------------

describe('hook-stdin: parsePayload (fail-open contract)', () => {
  test('parses a well-formed hook payload', () => {
    assert.deepEqual(parsePayload('{"session_id":"s1","cwd":"/x"}'), { session_id: 's1', cwd: '/x' });
  });

  test('malformed JSON yields an empty object, never throws', () => {
    assert.deepEqual(parsePayload('{"session_id": '), {});
    assert.deepEqual(parsePayload('not json at all'), {});
    assert.deepEqual(parsePayload('{{{'), {});
  });

  test('empty and whitespace-only stdin yield an empty object', () => {
    assert.deepEqual(parsePayload(''), {});
    assert.deepEqual(parsePayload('   \n\t '), {});
  });

  test('non-object JSON is rejected — every hook consumer expects an object', () => {
    assert.deepEqual(parsePayload('[1,2,3]'), {});
    assert.deepEqual(parsePayload('42'), {});
    assert.deepEqual(parsePayload('"a string"'), {});
    assert.deepEqual(parsePayload('null'), {});
  });

  test('non-string input yields an empty object', () => {
    assert.deepEqual(parsePayload(undefined), {});
    assert.deepEqual(parsePayload(null), {});
    assert.deepEqual(parsePayload(123), {});
  });
});

describe('hook-stdin: readHookInput is a drop-in for the three legacy patterns', () => {
  const payload = { session_id: 'drop-in', hook_event_name: 'PreToolUse', tool_name: 'Bash' };
  const raw = JSON.stringify(payload);

  test('pattern 1 — replaces process.stdin.on(data/end) accumulation', () => {
    const { stdout, status } = runChild(
      'process.stdout.write(JSON.stringify(readHookInput()));', raw);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), payload);
  });

  test('pattern 2 — replaces fs.readFileSync(0, "utf8")', () => {
    const { stdout, status } = runChild(
      'process.stdout.write(readHookInputRaw());', raw);
    assert.equal(status, 0);
    assert.equal(stdout, raw);
  });

  test('pattern 3 — replaces fs.readFileSync("/dev/stdin") (same bytes, same result)', () => {
    const { stdout, status } = runChild(
      'const r = readHookInputRaw(); process.stdout.write(String(JSON.parse(r).tool_name));', raw);
    assert.equal(status, 0);
    assert.equal(stdout, 'Bash');
  });

  test('multi-chunk stdin is fully drained', () => {
    const big = JSON.stringify({ session_id: 'big', blob: 'x'.repeat(200 * 1024) });
    const { stdout, status } = runChild(
      'process.stdout.write(String(readHookInput().blob.length));', big);
    assert.equal(status, 0);
    assert.equal(stdout, String(200 * 1024));
  });

  test('malformed stdin exits 0 with an empty payload — a hook must not wedge', () => {
    const { stdout, status } = runChild(
      'process.stdout.write(JSON.stringify(readHookInput()));', '{"broken":');
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), {});
  });

  test('empty stdin exits 0 with an empty payload', () => {
    const { stdout, status } = runChild(
      'process.stdout.write(JSON.stringify(readHookInput()));', '');
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), {});
  });

  test('the stdin read is memoized — fd 0 is only drained once', () => {
    const { stdout, status } = runChild(
      'readHookInput(); process.stdout.write(JSON.stringify(readHookInput()));', raw);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(stdout), payload);
  });
});

describe('hook-stdin: D1 dedup guard', () => {
  let sandbox;
  const GLOBAL_CALLER = '/home/u/.claude/orchestray/bin/some-hook.js';
  const LOCAL_CALLER  = '/home/u/proj/.claude/orchestray/bin/some-hook.js';

  beforeEach(() => { sandbox = mkSandbox(); });
  afterEach(() => {
    fs.rmSync(claimDir(sandbox), { recursive: true, force: true });
    fs.rmSync(sandbox, { recursive: true, force: true });
    delete process.env[ENV_DISABLE_DEDUP];
    delete process.env[ENV_DEDUP_WINDOW];
  });

  const raw = '{"session_id":"sess-1","tool_name":"Bash"}';
  const payload = JSON.parse(raw);
  const keyFor = (caller) => dedupKey(caller, raw, payload);

  test('the dedup key is (basename, session_id, payload-hash)', () => {
    // Same basename from two install paths -> identical key. That is the whole
    // point: the two racing installs must collide.
    assert.equal(keyFor(GLOBAL_CALLER), keyFor(LOCAL_CALLER));
    // Different session -> different key.
    const other = { session_id: 'sess-2' };
    assert.notEqual(
      dedupKey(GLOBAL_CALLER, JSON.stringify(other), other),
      keyFor(GLOBAL_CALLER));
    // Different script -> different key.
    assert.notEqual(dedupKey('/a/b/other-hook.js', raw, payload), keyFor(GLOBAL_CALLER));
  });

  test('same payload twice within the window from a sibling install → second suppressed', () => {
    const key = keyFor(GLOBAL_CALLER);
    const first = claim(sandbox, key, LOCAL_CALLER);
    assert.equal(first.fire, true);
    assert.equal(first.reason, 'claimed');

    const second = claim(sandbox, key, GLOBAL_CALLER);
    assert.equal(second.fire, false);
    assert.equal(second.reason, 'duplicate_install');
    assert.equal(second.firstCaller, LOCAL_CALLER);
  });

  test('different payloads → both pass', () => {
    const a = { session_id: 'sess-1', tool_name: 'Bash' };
    const b = { session_id: 'sess-1', tool_name: 'Read' };
    const ka = dedupKey(LOCAL_CALLER, JSON.stringify(a), a);
    const kb = dedupKey(GLOBAL_CALLER, JSON.stringify(b), b);
    assert.equal(claim(sandbox, ka, LOCAL_CALLER).fire, true);
    assert.equal(claim(sandbox, kb, GLOBAL_CALLER).fire, true);
  });

  test('same caller path repeating the payload → both pass (not a dual-install race)', () => {
    const key = keyFor(LOCAL_CALLER);
    assert.equal(claim(sandbox, key, LOCAL_CALLER).fire, true);
    const second = claim(sandbox, key, LOCAL_CALLER);
    assert.equal(second.fire, true);
    assert.equal(second.reason, 'same_caller_repeat');
  });

  test('window expiry → the later caller takes over the claim and fires', () => {
    process.env[ENV_DEDUP_WINDOW] = '1';
    const key = keyFor(GLOBAL_CALLER);
    assert.equal(claim(sandbox, key, LOCAL_CALLER).fire, true);
    // Backdate the claim well past the 1 ms window.
    const file = path.join(claimDir(sandbox), key + '.json');
    fs.writeFileSync(file, JSON.stringify({ ts_ms: Date.now() - 60000, caller_path: LOCAL_CALLER }));
    const second = claim(sandbox, key, GLOBAL_CALLER);
    assert.equal(second.fire, true);
    assert.equal(second.reason, 'window_expired');
  });

  test('a corrupt claim file fails open', () => {
    const key = keyFor(GLOBAL_CALLER);
    const dir = claimDir(sandbox);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, key + '.json'), 'not json');
    const decision = claim(sandbox, key, GLOBAL_CALLER);
    assert.equal(decision.fire, true);
    assert.equal(decision.reason, 'claim_unreadable');
  });

  test('kill switch disables both dedup layers', () => {
    process.env[ENV_DISABLE_DEDUP] = '1';
    const args = { callerPath: LOCAL_CALLER, cwd: sandbox, raw, payload };
    assert.equal(dedupDecision(args).reason, 'kill_switch');
    assert.equal(dedupDecision(Object.assign({}, args, { callerPath: GLOBAL_CALLER })).reason,
      'kill_switch');
  });

  test('an unwritable claim directory fails open (never kills the hook)', () => {
    // Plant a regular file where the claim directory belongs, so mkdirSync
    // fails with ENOTDIR.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-hs-blocked-'));
    const dir = claimDir(bare);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a directory');
    try {
      const decision = claim(bare, keyFor(LOCAL_CALLER), LOCAL_CALLER);
      assert.equal(decision.fire, true);
      assert.equal(decision.reason, 'claim_dir_unavailable');
    } finally {
      fs.rmSync(dir, { force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('dedup leaves no trace inside the project directory', () => {
    // Claim state lives in tmpdir: a hook firing in a git worktree must not
    // dirty it, and must not materialise .orchestray/ where none exists.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-hs-bare-'));
    try {
      assert.equal(claim(bare, keyFor(LOCAL_CALLER), LOCAL_CALLER).fire, true);
      assert.deepEqual(fs.readdirSync(bare), [], 'project directory must stay empty');
      assert.ok(!claimDir(bare).startsWith(bare), 'claims must not live under the project');
    } finally {
      fs.rmSync(claimDir(bare), { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  test('the legacy dual-install kill switch restores the v2.2.20 baseline', () => {
    const saved = process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED;
    process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED = '1';
    try {
      const args = { callerPath: LOCAL_CALLER, cwd: sandbox, raw, payload };
      assert.equal(dedupDecision(args).fire, true);
      assert.equal(
        dedupDecision(Object.assign({}, args, { callerPath: GLOBAL_CALLER })).reason,
        'legacy_kill_switch');
    } finally {
      if (saved === undefined) delete process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED;
      else process.env.ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED = saved;
    }
  });

  test('dedup applies with no per-script opt-in: two child hooks, second exits silently', () => {
    // Two distinct caller paths, identical payload, same sandbox cwd.
    const body = 'process.stdout.write("FIRED");';
    const write = (rel) => {
      const p = path.join(sandbox, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p,
        'const { readHookInput } = require(' + JSON.stringify(path.join(LIB_DIR, 'hook-stdin.js')) + ');\n' +
        'readHookInput();\n' + body + '\n');
      return p;
    };
    const a = write('installA/hook.js');
    const b = write('installB/hook.js');
    const env = Object.assign({}, process.env);
    delete env[ENV_DISABLE_DEDUP];

    const run = (script) => {
      try {
        return execFileSync(process.execPath, [script], {
          input: raw, cwd: sandbox, env, encoding: 'utf8', timeout: 15000,
        });
      } catch (e) { return String(e.stdout || ''); }
    };
    assert.equal(run(a), 'FIRED');
    assert.equal(run(b), '', 'sibling caller inside the window must be suppressed');
  });

  test('onDuplicate replaces the default process.exit(0)', () => {
    const key = keyFor(LOCAL_CALLER);
    claim(sandbox, key, LOCAL_CALLER);
    _resetCache();
    _seedCache(raw);
    let seen = null;
    const env = hookStdin.readHookEnvelope({
      callerPath: GLOBAL_CALLER,
      cwd: sandbox,
      onDuplicate: (d) => { seen = d; },
    });
    _resetCache();
    assert.equal(env.decision.fire, false);
    assert.ok(seen && seen.reason === 'duplicate_install');
  });
});

describe('hook-stdin: BDG harvest seam', () => {
  let sandbox;
  beforeEach(() => { sandbox = mkSandbox(); });
  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    delete process.env[ENV_HARVEST];
  });

  test('harvest is DORMANT by default — W5 arms it', () => {
    delete process.env[ENV_HARVEST];
    assert.equal(harvestEnabled(), false);
    // The entry point consults harvestEnabled(), so no fixtures are written.
    _resetCache();
    _seedCache('{"session_id":"s"}');
    hookStdin.readHookEnvelope({ callerPath: path.join(sandbox, 'some-hook.js'), cwd: sandbox });
    _resetCache();
    assert.equal(fs.existsSync(path.join(sandbox, '.orchestray', 'fixtures')), false);
  });

  test('harvest stays off under the test harness even when armed', () => {
    process.env[ENV_HARVEST] = '1';
    // ORCHESTRAY_TEST=1 is set by tests/helpers/setup.js.
    assert.equal(hookStdin.isTestContext(), true);
    assert.equal(harvestEnabled(), false);
  });

  test('harvest writes one fixture per shape when invoked directly', () => {
    harvest('some-hook', { session_id: 's', tool_name: 'Bash', cwd: '/a/b/c.js' }, sandbox);
    const dir = path.join(sandbox, '.orchestray', 'fixtures', 'some-hook');
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    const fixture = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
    // A fixture is {stdin, state}, not stdin — hooks are state-dependent.
    assert.ok('stdin' in fixture && 'state' in fixture);
    // Paths keep depth + extension; they do not leak the real path.
    assert.equal(fixture.stdin.cwd, '/d0/d1/f.js');
  });

  test('redact preserves structure while dropping content', () => {
    assert.equal(redact('/home/user/secret/file.txt'), '/d0/d1/d2/f.txt');
    assert.equal(redact('x'.repeat(100)), '<str:100>');
    assert.equal(redact('short'), 'short');
    assert.deepEqual(redact([1, 2, 3, 4, 5]), [1, 2, 3]);
    assert.deepEqual(redact({ a: { b: 'y'.repeat(80) } }), { a: { b: '<str:80>' } });
    assert.equal(redact(42), 42);
    assert.equal(redact(true), true);
    assert.equal(redact(null), null);
  });
});
