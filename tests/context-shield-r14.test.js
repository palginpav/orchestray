#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/context-shield.js (W4 — R14 Read dedup rule)
 *
 * Strategy:
 *   - Drive context-shield.js via spawnSync with a JSON payload on stdin,
 *     mirroring the gate-agent-spawn.test.js harness pattern.
 *   - Test the shield-session-cache.js module directly for cache semantics.
 *   - Each test gets an isolated tmpdir with a fresh .orchestray/state/ directory.
 *
 * Acceptance criteria covered:
 *   AC1  — first read is allowed through
 *   AC1b — second identical read is denied
 *   AC2  — same path, different offset is allowed
 *   AC3  — same path after mtime bump is allowed
 *   AC4  — cache is cleared after PreCompact (simulated)
 *   AC5  — shield.r14_dedup_reads.enabled: false short-circuits to allow
 *   AC6  — fail-open: malformed JSON on stdin exits 0 with allow
 *   AC7  — hooks.json contains 'context-shield' (grep check)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SHIELD_SCRIPT = path.resolve(__dirname, '../bin/context-shield.js');
const PRE_COMPACT_SCRIPT = path.resolve(__dirname, '../bin/pre-compact-archive.js');
const HOOKS_JSON = path.resolve(__dirname, '../hooks/hooks.json');

const { lookupCache, recordRead, clearSessionCache, cacheFilePath } = require('../bin/_lib/shield-session-cache');

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

/**
 * Create a fresh isolated tmpdir with an .orchestray/state/ directory.
 * Optionally seed a config.json.
 */
function makeDir({ config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-shield-test-'));
  cleanup.push(dir);

  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  if (config !== null) {
    const orchestrayDir = path.join(dir, '.orchestray');
    fs.writeFileSync(path.join(orchestrayDir, 'config.json'), JSON.stringify(config));
  }

  return dir;
}

/**
 * Create a temp file in the given dir with the given content.
 * Returns the absolute path.
 */
function makeFile(dir, name, content = 'hello world\n') {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * Run context-shield.js with the given event payload on stdin.
 * Returns { stdout, stderr, status }.
 */
function runShield(payload) {
  const result = spawnSync(process.execPath, [SHIELD_SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Parse the hookSpecificOutput from the shield's stdout.
 */
function parseDecision(stdout) {
  try {
    const obj = JSON.parse(stdout);
    return obj.hookSpecificOutput || {};
  } catch (_e) {
    return {};
  }
}

/**
 * Build a minimal Read hook payload.
 */
function readPayload(dir, filePath, opts = {}) {
  return {
    tool_name: 'Read',
    cwd: dir,
    session_id: opts.sessionId || 'test-session-001',
    turn_number: opts.turn || 1,
    tool_input: Object.assign({ file_path: filePath }, opts.toolInput || {}),
  };
}

// ---------------------------------------------------------------------------
// AC7: hooks.json registration check (fast, no tmpdir needed)
// ---------------------------------------------------------------------------

describe('AC7 — hooks.json registration', () => {
  test('hooks.json contains a PreToolUse Read entry for context-shield.js', () => {
    const raw = fs.readFileSync(HOOKS_JSON, 'utf8');
    assert.ok(
      raw.includes('context-shield'),
      'hooks.json must reference context-shield (grep invariant)'
    );
    const parsed = JSON.parse(raw);
    const preToolUseEntries = parsed.hooks && parsed.hooks.PreToolUse;
    assert.ok(Array.isArray(preToolUseEntries), 'PreToolUse must be an array');
    const hasReadEntry = preToolUseEntries.some(entry => {
      const matcher = entry.matcher || '';
      const hooks = entry.hooks || [];
      return matcher === 'Read' && hooks.some(h => String(h.command || '').includes('context-shield'));
    });
    assert.ok(hasReadEntry, 'hooks.json must have a PreToolUse:Read entry pointing at context-shield.js');
  });
});

// ---------------------------------------------------------------------------
// AC1 — First read is always allowed through
// ---------------------------------------------------------------------------

describe('AC1 — first read is allowed', () => {
  test('first Read call returns permissionDecision: allow', () => {
    const dir = makeDir();
    const filePath = makeFile(dir, 'test.md', '# Hello\n');
    const payload = readPayload(dir, filePath);
    const { status, stdout } = runShield(payload);
    assert.equal(status, 0);
    const decision = parseDecision(stdout);
    assert.equal(decision.permissionDecision, 'allow', 'first read must be allowed');
  });
});

// ---------------------------------------------------------------------------
// AC1b — Second identical read is denied
// ---------------------------------------------------------------------------

describe('AC1b — second identical read is denied (R14 cache hit)', () => {
  test('second Read of the same file with same mtime returns deny', () => {
    const dir = makeDir();
    const filePath = makeFile(dir, 'example.md', '# Content\n');
    const sessionId = 'test-session-r14-dedup';
    const payload = readPayload(dir, filePath, { sessionId, turn: 1 });

    // First read — must be allowed.
    const first = runShield(payload);
    assert.equal(first.status, 0);
    const firstDecision = parseDecision(first.stdout);
    assert.equal(firstDecision.permissionDecision, 'allow', 'first read must be allowed');

    // Second read of same file, same mtime — must be denied.
    const second = runShield(Object.assign({}, payload, { turn_number: 2 }));
    assert.equal(second.status, 0);
    const secondDecision = parseDecision(second.stdout);
    assert.equal(secondDecision.permissionDecision, 'deny', 'second identical read must be denied');
    assert.ok(
      secondDecision.permissionDecisionReason &&
        secondDecision.permissionDecisionReason.includes('already read at turn'),
      'deny reason must reference turn number'
    );
  });
});

// ---------------------------------------------------------------------------
// AC2 — Same path but different offset is allowed
// ---------------------------------------------------------------------------

describe('AC2 — explicit offset/limit bypasses dedup', () => {
  test('Read with explicit offset is always allowed', () => {
    const dir = makeDir();
    const filePath = makeFile(dir, 'big.md', 'line1\nline2\nline3\n');
    const sessionId = 'test-session-offset';

    // First full read.
    const first = runShield(readPayload(dir, filePath, { sessionId, turn: 1 }));
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow');

    // Second read with explicit offset — must be allowed even after cache is warm.
    const second = runShield(readPayload(dir, filePath, {
      sessionId,
      turn: 2,
      toolInput: { offset: 5, file_path: filePath },
    }));
    assert.equal(second.status, 0);
    assert.equal(
      parseDecision(second.stdout).permissionDecision,
      'allow',
      'sliced read with offset must always be allowed'
    );
  });

  test('Read with explicit limit is always allowed', () => {
    const dir = makeDir();
    const filePath = makeFile(dir, 'limited.md', 'aaa\nbbb\nccc\n');
    const sessionId = 'test-session-limit';

    // First full read.
    runShield(readPayload(dir, filePath, { sessionId, turn: 1 }));

    // Second read with explicit limit — must be allowed.
    const second = runShield(readPayload(dir, filePath, {
      sessionId,
      turn: 2,
      toolInput: { limit: 10, file_path: filePath },
    }));
    assert.equal(parseDecision(second.stdout).permissionDecision, 'allow',
      'sliced read with limit must always be allowed');
  });
});

// ---------------------------------------------------------------------------
// AC3 — Same path after mtime bump is allowed
// ---------------------------------------------------------------------------

describe('AC3 — mtime change invalidates cache', () => {
  test('Read after file modification is allowed (mtime changed)', () => {
    const dir = makeDir();
    const filePath = makeFile(dir, 'changing.md', 'original content\n');
    const sessionId = 'test-session-mtime';

    // First read — populate cache.
    const first = runShield(readPayload(dir, filePath, { sessionId, turn: 1 }));
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow');

    // Modify the file. Use a small sleep to ensure mtime changes on systems
    // with 1-second mtime granularity — write new content with utimes bump.
    const newContent = 'modified content\n';
    fs.writeFileSync(filePath, newContent);
    // Bump mtime by 2 seconds to guarantee change is visible.
    const now = new Date();
    const future = new Date(now.getTime() + 2000);
    fs.utimesSync(filePath, future, future);

    // Second read after mtime bump — must be allowed.
    const second = runShield(readPayload(dir, filePath, { sessionId, turn: 2 }));
    assert.equal(second.status, 0);
    assert.equal(
      parseDecision(second.stdout).permissionDecision,
      'allow',
      'read after file modification must be allowed (cache invalidated by mtime change)'
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — Cache cleared after PreCompact (simulated)
// ---------------------------------------------------------------------------

describe('AC4 — cache is cleared on PreCompact', () => {
  test('clearSessionCache removes the session cache file', () => {
    const dir = makeDir();
    const sessionId = 'test-session-compact';
    const filePath = makeFile(dir, 'prec.md', '# Pre-compact test\n');

    // Warm the cache via the shield.
    const first = runShield(readPayload(dir, filePath, { sessionId, turn: 1 }));
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow');

    // Verify cache file exists.
    const cf = cacheFilePath(dir, sessionId);
    assert.ok(fs.existsSync(cf), 'cache file should exist after first read');

    // Simulate PreCompact: clear the cache.
    clearSessionCache(dir, sessionId);

    // Cache file should be gone.
    assert.ok(!fs.existsSync(cf), 'cache file should be deleted after clearSessionCache');

    // After cache is cleared, the next read should be allowed (cache miss).
    const second = runShield(readPayload(dir, filePath, { sessionId, turn: 2 }));
    assert.equal(
      parseDecision(second.stdout).permissionDecision,
      'allow',
      'read after cache clear must be allowed (fresh session cache)'
    );
  });

  test('pre-compact-archive.js clears the session cache via clearSessionCache', () => {
    const dir = makeDir();
    const sessionId = 'test-session-precompact-hook';
    const filePath = makeFile(dir, 'arc.md', '# Archive test\n');

    // Warm the cache.
    const first = runShield(readPayload(dir, filePath, { sessionId, turn: 1 }));
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow');

    const cf = cacheFilePath(dir, sessionId);
    assert.ok(fs.existsSync(cf), 'cache file should exist');

    // Run pre-compact-archive.js to simulate a PreCompact event.
    // Need .orchestray/audit/ to exist so the script doesn't exit early.
    const auditDir = path.join(dir, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    const result = spawnSync(process.execPath, [PRE_COMPACT_SCRIPT], {
      input: JSON.stringify({ cwd: dir, session_id: sessionId, trigger: 'manual' }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0, 'pre-compact-archive.js must exit 0');

    // Cache file should now be gone.
    assert.ok(!fs.existsSync(cf), 'cache file should be deleted by pre-compact-archive.js');
  });
});

// ---------------------------------------------------------------------------
// AC5 — shield.r14_dedup_reads.enabled: false short-circuits to allow
// ---------------------------------------------------------------------------

describe('AC5 — config flag disables R14', () => {
  test('r14_dedup_reads.enabled: false allows all reads including second read', () => {
    const dir = makeDir({
      config: { shield: { r14_dedup_reads: { enabled: false } } },
    });
    const filePath = makeFile(dir, 'flag-off.md', '# Flag test\n');
    const sessionId = 'test-session-flagoff';

    // First read.
    const first = runShield(readPayload(dir, filePath, { sessionId, turn: 1 }));
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow');

    // Second read — flag is false, so no cache is checked; must be allowed.
    const second = runShield(readPayload(dir, filePath, { sessionId, turn: 2 }));
    assert.equal(second.status, 0);
    assert.equal(
      parseDecision(second.stdout).permissionDecision,
      'allow',
      'second read must be allowed when r14 is disabled'
    );
  });
});

// ---------------------------------------------------------------------------
// AC6 — Fail-open: hook bugs never block legitimate Reads
// ---------------------------------------------------------------------------

describe('AC6 — fail-open behavior', () => {
  test('malformed JSON on stdin exits 0 with allow decision', () => {
    const result = spawnSync(process.execPath, [SHIELD_SCRIPT], {
      input: 'not valid json {{{',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    const decision = parseDecision(result.stdout);
    assert.equal(decision.permissionDecision, 'allow', 'malformed stdin must fail open');
  });

  test('empty stdin exits 0 with allow decision', () => {
    const result = spawnSync(process.execPath, [SHIELD_SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 0);
    const decision = parseDecision(result.stdout);
    assert.equal(decision.permissionDecision, 'allow', 'empty stdin must fail open');
  });

  test('non-Read tool_name exits 0 with allow (hook skips non-Read tools)', () => {
    const dir = makeDir();
    const result = runShield({
      tool_name: 'Edit',
      cwd: dir,
      session_id: 'test-session-skip',
      tool_input: { file_path: '/some/path.md' },
    });
    assert.equal(result.status, 0);
    assert.equal(
      parseDecision(result.stdout).permissionDecision,
      'allow',
      'non-Read tool must always be allowed'
    );
  });

  test('missing tool_input exits 0 with allow decision (fail-open)', () => {
    const dir = makeDir();
    const result = runShield({
      tool_name: 'Read',
      cwd: dir,
      session_id: 'test-session-noinput',
    });
    assert.equal(result.status, 0);
    assert.equal(parseDecision(result.stdout).permissionDecision, 'allow');
  });

  test('tool_input present but no file_path key exits 0 with allow decision (R14 empty-path sub-branch)', () => {
    // Exercises the sub-branch in R14 where tool_input is present but the
    // file_path key is absent (distinct from missing tool_input entirely).
    // R14 returns allow immediately when file_path is absent or empty.
    const dir = makeDir();
    const result = runShield({
      tool_name: 'Read',
      cwd: dir,
      session_id: 'test-session-no-filepath-key',
      tool_input: { limit: 10 },
    });
    assert.equal(result.status, 0);
    assert.equal(
      parseDecision(result.stdout).permissionDecision,
      'allow',
      'Read with tool_input present but no file_path key must be allowed through'
    );
  });

  test('unreadable cache dir does not block the Read (fail-open)', () => {
    // Use a tmpdir where we don't create .orchestray/state/ — the cache
    // write will fail gracefully, but the Read must still be allowed.
    const dir = os.tmpdir(); // Use os.tmpdir() directly — no .orchestray in parent
    const filePath = makeFile(
      fs.mkdtempSync(path.join(os.tmpdir(), 'orch-shield-failopen-')),
      'x.md',
      'content\n'
    );
    cleanup.push(path.dirname(filePath));
    const result = runShield({
      tool_name: 'Read',
      cwd: dir,
      session_id: 'test-fail-open-session',
      tool_input: { file_path: filePath },
    });
    assert.equal(result.status, 0);
    assert.equal(parseDecision(result.stdout).permissionDecision, 'allow');
  });
});

// ---------------------------------------------------------------------------
// Cross-session isolation
// ---------------------------------------------------------------------------

describe('cross-session isolation', () => {
  test('dedup does not fire across different session_ids', () => {
    const dir = makeDir();
    const filePath = makeFile(dir, 'shared.md', '# Shared\n');

    // Read with session A.
    const sessionA = runShield(readPayload(dir, filePath, { sessionId: 'session-A', turn: 1 }));
    assert.equal(parseDecision(sessionA.stdout).permissionDecision, 'allow');

    // Read with session B — different session, should be a cache miss → allow.
    const sessionB = runShield(readPayload(dir, filePath, { sessionId: 'session-B', turn: 1 }));
    assert.equal(
      parseDecision(sessionB.stdout).permissionDecision,
      'allow',
      'different session_id must not share cache entries'
    );
  });
});

// ---------------------------------------------------------------------------
// shield-session-cache module unit tests
// ---------------------------------------------------------------------------

describe('shield-session-cache unit tests', () => {
  test('buildCacheKey encodes path+offset+limit as tab-separated triple', () => {
    const { buildCacheKey } = require('../bin/_lib/shield-session-cache');
    assert.equal(buildCacheKey('/a/b.md', 0, 50), '/a/b.md\t0\t50');
    assert.equal(buildCacheKey('/a/b.md', null, null), '/a/b.md\t0\t0');
    assert.equal(buildCacheKey('/a/b.md', undefined, undefined), '/a/b.md\t0\t0');
  });

  test('lookupCache returns hit:false when no cache exists', () => {
    const dir = makeDir();
    const { hit } = lookupCache(dir, 'no-cache-session', '/tmp/x.md', null, null, '2026-01-01T00:00:00.000Z');
    assert.equal(hit, false);
  });

  test('recordRead then lookupCache returns hit:true for same mtime', () => {
    const dir = makeDir();
    const sessionId = 'unit-test-session';
    const mtime = '2026-04-11T12:00:00.000Z';

    recordRead(dir, sessionId, '/tmp/test.md', null, null, mtime, 5);
    const { hit, turn } = lookupCache(dir, sessionId, '/tmp/test.md', null, null, mtime);
    assert.equal(hit, true);
    assert.equal(turn, 5);
  });

  test('lookupCache returns hit:false for different mtime (invalidation)', () => {
    const dir = makeDir();
    const sessionId = 'unit-test-mtime-inv';
    const mtime1 = '2026-04-11T12:00:00.000Z';
    const mtime2 = '2026-04-11T13:00:00.000Z';

    recordRead(dir, sessionId, '/tmp/mtcheck.md', null, null, mtime1, 1);
    const { hit } = lookupCache(dir, sessionId, '/tmp/mtcheck.md', null, null, mtime2);
    assert.equal(hit, false, 'different mtime must invalidate cache entry');
  });

  test('clearSessionCache removes the file', () => {
    const dir = makeDir();
    const sessionId = 'unit-clear-session';
    recordRead(dir, sessionId, '/tmp/clear.md', null, null, '2026-01-01T00:00:00.000Z', 1);
    const cf = cacheFilePath(dir, sessionId);
    assert.ok(fs.existsSync(cf));
    clearSessionCache(dir, sessionId);
    assert.ok(!fs.existsSync(cf));
  });
});

// ---------------------------------------------------------------------------
// T3 T4 — MAX_CACHE_ENTRIES pruning test
// ---------------------------------------------------------------------------

describe('shield-session-cache MAX_CACHE_ENTRIES pruning (T3 T4)', () => {
  test('inserting MAX_CACHE_ENTRIES+1 entries prunes cache to ~half size', () => {
    // The MAX_CACHE_ENTRIES constant is 5000. Inserting 5001 entries must trigger
    // the prune-oldest-half logic, shrinking the cache from 5000 to ~2500.
    // We use a smaller synthetic approach: directly verify the pruning branch via
    // sequential recordRead calls with staggered first_seen timestamps.
    //
    // Strategy: call recordRead 5001 times with unique paths. After the last call,
    // the cache file on disk should have significantly fewer than 5001 entries.
    // We accept a range of [2400, 2600] to tolerate any off-by-one in the pruning.
    const dir = makeDir();
    const sessionId = 'prune-test-session';
    const mtime = '2026-04-11T00:00:00.000Z';

    // 5001 unique paths — one more than MAX_CACHE_ENTRIES (5000)
    const OVER_CAP = 5001;
    for (let i = 0; i < OVER_CAP; i++) {
      recordRead(dir, sessionId, '/tmp/file-' + i + '.md', null, null, mtime, i);
    }

    // Read the resulting cache file and count entries.
    const cf = cacheFilePath(dir, sessionId);
    assert.ok(fs.existsSync(cf), 'cache file must exist after writes');
    const raw = fs.readFileSync(cf, 'utf8');
    const parsed = JSON.parse(raw);
    const entryCount = Object.keys(parsed).length;

    // After pruning, the cache must be significantly smaller than 5001.
    // The prune logic deletes Math.floor(keys.length / 2) entries when keys.length >= 5000.
    // Inserting entry #5001 triggers: 5000 entries → prune 2500 → 2500 remain → then the
    // new entry is added → 2501 entries. We allow [2400, 2600] for float rounding safety.
    assert.ok(
      entryCount >= 2400 && entryCount <= 2600,
      'after pruning, cache should have ~2500 entries, got ' + entryCount
    );
    assert.ok(entryCount < 5001, 'cache must NOT have grown to 5001+ entries (unbounded)');
  });

  test('cache prune preserves most-recent entries (newest survive)', () => {
    // Verify that the pruning discards old entries and the most recent entry
    // (added last, as the trigger) survives the prune.
    const dir = makeDir();
    const sessionId = 'prune-recent-session';
    const mtime = '2026-04-11T00:00:00.000Z';

    // Insert MAX_CACHE_ENTRIES entries with old first_seen timestamps.
    const OVER_CAP = 5001;
    for (let i = 0; i < OVER_CAP - 1; i++) {
      recordRead(dir, sessionId, '/tmp/old-' + i + '.md', null, null, mtime, i);
    }

    // The very last entry — this triggers the prune. Its path should survive.
    const lastPath = '/tmp/last-entry-survives.md';
    recordRead(dir, sessionId, lastPath, null, null, mtime, OVER_CAP);

    const cf = cacheFilePath(dir, sessionId);
    const raw = fs.readFileSync(cf, 'utf8');
    const parsed = JSON.parse(raw);

    // The last-inserted entry's key must be present (newest survives prune).
    const { buildCacheKey } = require('../bin/_lib/shield-session-cache');
    const lastKey = buildCacheKey(lastPath, null, null);
    assert.ok(lastKey in parsed, 'the most-recently added entry must survive the prune');
  });
});

// ---------------------------------------------------------------------------
// Shield R14 new behavior coverage (DEV-2 fixes)
// ---------------------------------------------------------------------------

describe('Shield R14 — W2 path normalization (relative vs absolute)', () => {
  test('relative and absolute path variants deduplicate identically', () => {
    // context-shield normalizes file_path via path.resolve(cwd, rawFilePath) before
    // building the cache key. A relative path and its absolute equivalent must
    // deduplicate against each other — otherwise two cache entries exist for the same file.
    const dir = makeDir();
    const filePath = makeFile(dir, 'dedup-norm.md', '# Normalization test\n');
    const sessionId = 'test-session-norm-001';

    // First read using the ABSOLUTE path.
    const firstPayload = readPayload(dir, filePath, { sessionId, turn: 1 });
    const first = runShield(firstPayload);
    assert.equal(first.status, 0);
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow',
      'first read (absolute path) must be allowed');

    // Second read using the RELATIVE path (relative to cwd).
    const relPath = path.relative(dir, filePath);
    const secondPayload = readPayload(dir, relPath, { sessionId, turn: 2 });
    const second = runShield(secondPayload);
    assert.equal(second.status, 0);
    // Must be DENIED because the absolute path was already read and the file is unchanged.
    assert.equal(
      parseDecision(second.stdout).permissionDecision,
      'deny',
      'second read via relative path must be denied (same file, already in cache via absolute path)'
    );
  });
});

describe('Shield R14 — W3 non-existent path returns allow', () => {
  test('second read of non-existent path returns allow (no mtime to deduplicate on)', () => {
    // If the file does not exist, fileStat is null → allow unconditionally.
    // A non-existent file has no mtime, so caching an empty mtime for it would
    // cause a false-deny on the second probe of the same nonexistent path.
    const dir = makeDir();
    const nonExistentPath = path.join(dir, 'does-not-exist.md');
    const sessionId = 'test-session-nonexist';

    // First read — file doesn't exist yet → allow (no mtime).
    const first = runShield(readPayload(dir, nonExistentPath, { sessionId, turn: 1 }));
    assert.equal(first.status, 0);
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow',
      'first read of non-existent file must be allowed');

    // Second read of the same non-existent path — must ALSO be allowed (W3 guard).
    const second = runShield(readPayload(dir, nonExistentPath, { sessionId, turn: 2 }));
    assert.equal(second.status, 0);
    assert.equal(
      parseDecision(second.stdout).permissionDecision,
      'allow',
      'second read of non-existent file must also be allowed (W3 missing-file guard)'
    );
  });
});

describe('Shield R14 — T2 F6 toolInput.pages bypass', () => {
  test('toolInput.pages set bypasses dedup (PDF page-range reads always allowed)', () => {
    // T2 F6: two reads of the same PDF file with toolInput.pages set must both be
    // allowed through even after the first read warms the cache.
    // Pages parameter is treated identically to offset/limit — sliced reads always allowed.
    const dir = makeDir();
    const pdfPath = makeFile(dir, 'report.pdf', '%PDF-1.4 fake pdf content\n');
    const sessionId = 'test-session-pages';

    // First read WITH pages parameter — must be allowed.
    const first = runShield(readPayload(dir, pdfPath, {
      sessionId,
      turn: 1,
      toolInput: { pages: '1-5', file_path: pdfPath },
    }));
    assert.equal(first.status, 0);
    assert.equal(parseDecision(first.stdout).permissionDecision, 'allow',
      'first read with pages must be allowed');

    // Second read WITH pages parameter — must ALSO be allowed (pages bypasses dedup).
    const second = runShield(readPayload(dir, pdfPath, {
      sessionId,
      turn: 2,
      toolInput: { pages: '1-5', file_path: pdfPath },
    }));
    assert.equal(second.status, 0);
    assert.equal(
      parseDecision(second.stdout).permissionDecision,
      'allow',
      'second read with pages parameter must be allowed (pages bypasses dedup)'
    );

    // Third read of same PDF WITHOUT pages — this is a full read.
    // If the cache was NOT poisoned by the pages reads, this is a first full read → allow.
    const third = runShield(readPayload(dir, pdfPath, { sessionId, turn: 3 }));
    assert.equal(third.status, 0);
    assert.equal(parseDecision(third.stdout).permissionDecision, 'allow',
      'first full read (no pages) after pages reads must be allowed');

    // Fourth read of same PDF WITHOUT pages — should now be denied (second full read).
    const fourth = runShield(readPayload(dir, pdfPath, { sessionId, turn: 4 }));
    assert.equal(fourth.status, 0);
    assert.equal(
      parseDecision(fourth.stdout).permissionDecision,
      'deny',
      'second full read (no pages) must be denied (cache hit from third read)'
    );
  });
});
