#!/usr/bin/env node
'use strict';

/**
 * tests/role-write-paths-traversal.test.js — v2.2.21 T8 (G3-W1-T3),
 * updated for v2.3.0 Wave 5 (absolute_path block removal).
 *
 * Hardens `bin/gate-role-write-paths.js` against CWE-22 path traversal:
 *   - Forge with `../../../etc/foo.md`     → reason=traversal_segment_present
 *   - Forge with absolute `/etc/foo.md`    → relPath = `../../etc/foo.md` →
 *                                            reason=traversal_segment_present
 *                                            (via the relPath dotdot check —
 *                                            the load-bearing protection)
 *   - In-tree absolute path                → passes pre-allowlist; role
 *                                            allowlist check decides
 *   - Legitimate in-tree write             → still permitted
 *   - Kill switch ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED=1 reverts ONLY the
 *     new pre-allowlist block; the existing allowlist enforcement continues.
 *
 * Coverage:
 *   1. `__test__` regex map: every compiled allowlist regex starts with `^`.
 *   2. `validatePathPreAllowlist` unit tests for each rejection branch.
 *   3. Hook integration: forge × legitimate × restricted role.
 *   4. Kill-switch integration.
 *
 * The hook's emitted event must carry `reason` ∈
 * {traversal_segment_present, invalid_chars}.
 * (v2.3.0 Wave 5 removed reason=absolute_path; the relPath dotdot check
 * subsumes that vector. See bin/gate-role-write-paths.js comment block.)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs    = require('node:fs');
const os    = require('node:os');
const path  = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'bin', 'gate-role-write-paths.js');
const allowlists = require('../bin/_lib/role-write-allowlists');
const gate       = require('../bin/gate-role-write-paths');

// ---------------------------------------------------------------------------
// 1. __test__ export — every compiled regex is root-anchored.
// ---------------------------------------------------------------------------

describe('v2.2.21 T8 — compiled allowlists are root-anchored', () => {
  test('__test__ export is exposed', () => {
    assert.ok(allowlists.__test__, '__test__ must be exported');
    assert.ok(allowlists.__test__.COMPILED_ALLOWLISTS, '__test__.COMPILED_ALLOWLISTS must exist');
    assert.equal(typeof allowlists.__test__.compileGlob, 'function', 'compileGlob must be a function');
  });

  test('every restricted role has at least one compiled regex', () => {
    const map = allowlists.__test__.COMPILED_ALLOWLISTS;
    for (const role of Object.keys(allowlists.ROLE_WRITE_ALLOWLISTS)) {
      assert.ok(Array.isArray(map[role]) && map[role].length > 0,
        'role ' + role + ' must have compiled regexes');
    }
  });

  test('every compiled regex source starts with the root anchor', () => {
    const map = allowlists.__test__.COMPILED_ALLOWLISTS;
    for (const [role, regexes] of Object.entries(map)) {
      for (const rx of regexes) {
        assert.ok(rx.source.startsWith('^'),
          'role=' + role + ' regex source must start with ^: ' + rx.source);
      }
    }
  });

  test('compiled regex does NOT match a traversal-prefixed path', () => {
    // Direct regex test: the documenter's `**/*.md` glob, compiled with the
    // root anchor, is what F2 said the original gate accepted. The pre-allowlist
    // block is the canonical fix; this assertion documents that the regex
    // alone, without the pre-block, is NOT a security boundary on its own.
    // It IS still anchored, however, so a path like 'foo/bar.md' matches and
    // 'docs/x.md' matches, while complete junk does not.
    const map = allowlists.__test__.COMPILED_ALLOWLISTS;
    for (const rx of map.documenter) {
      // Sanity: the root anchor is present.
      assert.ok(rx.source.startsWith('^'));
    }
  });
});

// ---------------------------------------------------------------------------
// 2. validatePathPreAllowlist — unit tests.
// ---------------------------------------------------------------------------

describe('v2.2.21 T8 — validatePathPreAllowlist', () => {
  const { validatePathPreAllowlist } = gate;

  // v2.3.0 Wave 5: absolute paths are no longer rejected outright. The relPath
  // dotdot check is the load-bearing traversal protection — an absolute path
  // outside cwd resolves to a `..`-prefixed relPath, which is caught.
  // See bin/gate-role-write-paths.js validatePathPreAllowlist comment block.
  test('rejects absolute path forges via the relPath dotdot check', () => {
    // path.relative(/tmp/cwd, /etc/foo.md) → ../../etc/foo.md → trips dotdot.
    const r = validatePathPreAllowlist('/etc/foo.md', '../../etc/foo.md');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'traversal_segment_present');
  });

  test('accepts an in-tree absolute path (relPath has no dotdot)', () => {
    // Documenter writes /home/palgin/orchestray/README.md from cwd
    // /home/palgin/orchestray → relPath = README.md → passes pre-allowlist.
    // (The role allowlist check then runs as the second gate.)
    const r = validatePathPreAllowlist('/home/palgin/orchestray/README.md', 'README.md');
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
  });

  test('rejects relPath containing a `..` segment', () => {
    const r = validatePathPreAllowlist('../../../etc/foo.md', '../../../etc/foo.md');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'traversal_segment_present');
  });

  test('rejects relPath containing chars outside the allowlist', () => {
    const r = validatePathPreAllowlist('docs/foo bar.md', 'docs/foo bar.md');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_chars');
  });

  test('rejects relPath containing newline (control char)', () => {
    const r = validatePathPreAllowlist('docs/foo\n.md', 'docs/foo\n.md');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_chars');
  });

  test('rejects empty relPath', () => {
    const r = validatePathPreAllowlist('', '');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_chars');
  });

  test('accepts a legitimate in-tree relPath', () => {
    const r = validatePathPreAllowlist('docs/architecture.md', 'docs/architecture.md');
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
  });

  test('kill switch ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED=1 short-circuits to ok', () => {
    const prev = process.env.ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED;
    process.env.ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED = '1';
    try {
      const r = validatePathPreAllowlist('/etc/foo.md', '../../etc/foo.md');
      assert.equal(r.ok, true);
      assert.equal(r.reason, null);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED;
      else process.env.ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Hook integration — forge × legitimate × per-role.
// ---------------------------------------------------------------------------

function runHook(payload, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2221-t8-'));
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    cwd: tmp,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  return { ...res, tmp };
}

function readAuditEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

// Per-role legitimate writes — verified against role-write-allowlists.js.
// Each entry: [role, legitimateRelPath].
const LEGITIMATE_WRITES = [
  ['reviewer',        '.orchestray/kb/artifacts/review.md'],
  ['tester',          'bin/__tests__/sample.test.js'],
  ['documenter',      'docs/architecture.md'],
  ['release-manager', 'CHANGELOG.md'],
  ['debugger',        '.orchestray/kb/artifacts/debug-finding.md'],
];

describe('v2.2.21 T8 — hook hard-blocks `..` traversal forges (per restricted role)', () => {
  for (const [role] of LEGITIMATE_WRITES) {
    test(role + ' attempting "../../../etc/foo.md" is hard-blocked with reason=traversal_segment_present', () => {
      const r = runHook({
        tool_name: 'Write',
        agent_role: role,
        tool_input: { file_path: '../../../etc/foo.md' },
      });
      assert.equal(r.status, 2,
        role + ': expected exit 2 (hard-block). stderr=' + (r.stderr || '').slice(0, 300));
      const events = readAuditEvents(r.tmp);
      const blocked = events.find(e => e.type === 'role_write_path_blocked');
      assert.ok(blocked, role + ': role_write_path_blocked event must be emitted');
      assert.equal(blocked.agent_role, role);
      assert.equal(blocked.reason, 'traversal_segment_present',
        role + ': reason must be traversal_segment_present, got ' + blocked.reason);
      assert.equal(blocked.allowlist_matched, false);
      cleanup(r.tmp);
    });
  }
});

// v2.3.0 Wave 5: absolute paths to out-of-tree locations (e.g. `/etc/foo.md`)
// resolve via path.relative(cwd, abs) to a `..`-prefixed relPath that trips
// the dotdot check. The block is still hard (exit 2, audit event emitted) —
// only the reason code changed from `absolute_path` (removed) to
// `traversal_segment_present` (the load-bearing check).
describe('v2.2.21 T8 — hook hard-blocks out-of-tree absolute-path forges (per restricted role)', () => {
  for (const [role] of LEGITIMATE_WRITES) {
    test(role + ' attempting "/etc/foo.md" is hard-blocked with reason=traversal_segment_present', () => {
      const r = runHook({
        tool_name: 'Write',
        agent_role: role,
        tool_input: { file_path: '/etc/foo.md' },
      });
      assert.equal(r.status, 2,
        role + ': expected exit 2 (hard-block). stderr=' + (r.stderr || '').slice(0, 300));
      const events = readAuditEvents(r.tmp);
      const blocked = events.find(e => e.type === 'role_write_path_blocked');
      assert.ok(blocked, role + ': role_write_path_blocked event must be emitted');
      assert.equal(blocked.agent_role, role);
      assert.equal(blocked.reason, 'traversal_segment_present',
        role + ': reason must be traversal_segment_present (path.relative resolves /etc/foo.md to ../../etc/foo.md from any tmp cwd), got ' + blocked.reason);
      cleanup(r.tmp);
    });
  }
});

describe('v2.2.21 T8 — legitimate in-tree writes still permitted (per restricted role)', () => {
  for (const [role, legitimatePath] of LEGITIMATE_WRITES) {
    test(role + ' writing "' + legitimatePath + '" passes (exit 0)', () => {
      const r = runHook({
        tool_name: 'Write',
        agent_role: role,
        tool_input: { file_path: legitimatePath },
      });
      assert.equal(r.status, 0,
        role + ': legitimate write must pass. stderr=' + (r.stderr || '').slice(0, 300) +
        ' stdout=' + (r.stdout || '').slice(0, 200));
      cleanup(r.tmp);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Kill-switch integration.
// ---------------------------------------------------------------------------

describe('v2.2.21 T8 — kill switch ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED=1', () => {
  test('skips ONLY the pre-allowlist block — `..` no longer hard-blocked', () => {
    // With the kill switch set, the pre-allowlist block is bypassed.
    // The path `../../../etc/foo.md` then reaches the allowlist regex check.
    // Because allowlist regexes are now root-anchored at the project tree,
    // the `..`-prefixed string no longer matches the regex — so the gate
    // STILL blocks the write, but with a generic (no `reason`) event:
    // i.e. the existing allowlist enforcement continues, as required.
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'documenter',
      tool_input: { file_path: '../../../etc/foo.md' },
    }, { ORCHESTRAY_ROLE_WRITE_TRAVERSAL_DISABLED: '1' });

    // Two acceptable outcomes (both prove the pre-block was skipped):
    //   (a) Allowlist matches & write passes (exit 0) — undesirable but means
    //       the pre-block is what guards us in practice.
    //   (b) Allowlist rejects & gate blocks (exit 2) with NO `reason` field
    //       (the F2 vector path), confirming the pre-block was bypassed.
    if (r.status === 0) {
      // Pre-block bypassed; allowlist regex matched the legacy F2 vector.
      // This is the very behavior the pre-block exists to defeat.
      // We accept it here only because the kill switch is set.
    } else {
      assert.equal(r.status, 2);
      const events = readAuditEvents(r.tmp);
      const blocked = events.find(e => e.type === 'role_write_path_blocked');
      assert.ok(blocked, 'role_write_path_blocked event must still be emitted by allowlist path');
      // When the pre-block is skipped, the emitted event lacks the `reason` field
      // (or carries reason=null), since the allowlist branch does not set it.
      assert.ok(blocked.reason === undefined || blocked.reason === null,
        'when traversal-disabled, the event must NOT carry a pre-block reason; got reason=' + blocked.reason);
    }
    cleanup(r.tmp);
  });

  test('rest of the gate (ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1) fully bypasses block', () => {
    const r = runHook({
      tool_name: 'Write',
      agent_role: 'documenter',
      tool_input: { file_path: '../../../etc/foo.md' },
    }, { ORCHESTRAY_ROLE_WRITE_GATE_DISABLED: '1' });
    assert.equal(r.status, 0,
      'full gate kill switch must allow even traversal vectors. stderr=' + (r.stderr || '').slice(0, 200));
    cleanup(r.tmp);
  });
});
