#!/usr/bin/env node
'use strict';

/**
 * Unit tests — bin/mark-compact-signal.js
 *
 * Covers the SessionStart source-matcher branches and the K2 arbitration
 * requirement that `source:"clear"` is treated as a deliberate user reset
 * (no lock, no audit event).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshModule(relPath) {
  const p = require.resolve(relPath);
  delete require.cache[p];
  return require(relPath);
}

function mkProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-compact-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function readLock(dir) {
  const p = path.join(dir, '.orchestray', 'state', 'compact-signal.lock');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('handleSessionStart — source matchers', () => {
  test('source="compact" drops a lock and records compact_source', () => {
    const cwd = mkProject();
    const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
    const result = handleSessionStart({ cwd, source: 'compact', session_id: 's1' });
    assert.equal(result.dropped, true);
    const lock = readLock(cwd);
    assert.ok(lock);
    assert.equal(lock.source, 'compact');
    assert.equal(lock.ingested_count, 0);
    assert.ok(lock.max_injections >= 1);
  });

  test('source="resume" drops a lock', () => {
    const cwd = mkProject();
    const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
    const result = handleSessionStart({ cwd, source: 'resume' });
    assert.equal(result.dropped, true);
    assert.equal(readLock(cwd).source, 'resume');
  });

  test('K2: source="clear" is IGNORED (no lock dropped, no event emitted)', () => {
    const cwd = mkProject();
    const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
    const result = handleSessionStart({ cwd, source: 'clear' });
    assert.equal(result.dropped, false,
      'K2 violation: /clear must NOT drop a compact-signal.lock');
    assert.equal(result.source, 'clear');
    assert.equal(readLock(cwd), null,
      'K2 violation: compact-signal.lock must NOT exist after SessionStart(clear)');

    // No compaction_detected event should be written either.
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const evts = fs.readFileSync(eventsPath, 'utf8')
        .split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch (_e) { return {}; }
        });
      assert.ok(
        !evts.some((e) => e.type === 'compaction_detected'),
        'K2 violation: compaction_detected event emitted for /clear'
      );
    }
  });

  test('source="startup" is ignored', () => {
    const cwd = mkProject();
    const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
    const result = handleSessionStart({ cwd, source: 'startup' });
    assert.equal(result.dropped, false);
    assert.equal(readLock(cwd), null);
  });

  test('missing source is ignored', () => {
    const cwd = mkProject();
    const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
    const result = handleSessionStart({ cwd });
    assert.equal(result.dropped, false);
  });
});

describe('handleSessionStart — kill-switch', () => {
  test('env var disables lock drop', () => {
    const cwd = mkProject();
    const prior = process.env.ORCHESTRAY_RESILIENCE_DISABLED;
    process.env.ORCHESTRAY_RESILIENCE_DISABLED = '1';
    try {
      const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
      const result = handleSessionStart({ cwd, source: 'compact' });
      assert.equal(result.dropped, false);
      assert.equal(result.reason, 'env_kill_switch');
      assert.equal(readLock(cwd), null);
    } finally {
      if (prior === undefined) delete process.env.ORCHESTRAY_RESILIENCE_DISABLED;
      else process.env.ORCHESTRAY_RESILIENCE_DISABLED = prior;
    }
  });

  test('config.resilience.enabled:false disables lock drop', () => {
    const cwd = mkProject();
    fs.writeFileSync(
      path.join(cwd, '.orchestray', 'config.json'),
      JSON.stringify({ resilience: { enabled: false } })
    );
    const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
    const result = handleSessionStart({ cwd, source: 'compact' });
    assert.equal(result.dropped, false);
    assert.equal(readLock(cwd), null);
  });
});

describe('handleSessionStart — atomicity', () => {
  test('existing lock is overwritten atomically', () => {
    const cwd = mkProject();
    const lockPath = path.join(cwd, '.orchestray', 'state', 'compact-signal.lock');
    fs.writeFileSync(lockPath, '{"source":"stale"}');
    const { handleSessionStart } = freshModule('../../bin/mark-compact-signal');
    handleSessionStart({ cwd, source: 'compact' });
    const lock = readLock(cwd);
    assert.equal(lock.source, 'compact');
  });
});
