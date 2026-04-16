'use strict';

/**
 * Tests for bin/_lib/context-telemetry-cache.js
 *
 * Coverage group 2: Multi-subagent aggregation
 *   - readCache returns skeleton when file missing
 *   - resetCache writes fresh skeleton
 *   - updateCache adds active_subagents rows (simulates spawn+start)
 *   - updateCache removes row when Stop event processed (active→completed transition)
 *   - Two concurrent subagents both appear in active_subagents
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  readCache,
  updateCache,
  resetCache,
  _skeleton,
} = require('../../bin/_lib/context-telemetry-cache');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cache-test-'));
  return dir;
}

function teardown(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ── _skeleton ─────────────────────────────────────────────────────────────────

describe('_skeleton', () => {
  test('returns a valid skeleton object with the given sessionId', () => {
    const s = _skeleton('sess-abc');
    assert.equal(s.session_id, 'sess-abc');
    assert.equal(s.schema_version, 1);
    assert.ok(Array.isArray(s.active_subagents));
    assert.equal(s.active_subagents.length, 0);
    assert.ok(s.session);
    assert.equal(s.session.tokens.input, 0);
  });

  test('sets session_id to null when no sessionId provided', () => {
    const s = _skeleton(null);
    assert.equal(s.session_id, null);
  });
});

// ── readCache ─────────────────────────────────────────────────────────────────

describe('readCache', () => {
  test('returns skeleton when cache file does not exist', () => {
    const dir = makeTmpProject();
    try {
      const cache = readCache(dir);
      assert.equal(cache.schema_version, 1);
      assert.ok(Array.isArray(cache.active_subagents));
    } finally {
      teardown(dir);
    }
  });

  test('returns skeleton when cache file contains invalid JSON', () => {
    const dir = makeTmpProject();
    try {
      fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.orchestray', 'state', 'context-telemetry.json'), 'NOTJSON', 'utf8');
      const cache = readCache(dir);
      assert.equal(cache.schema_version, 1);
    } finally {
      teardown(dir);
    }
  });

  test('returns skeleton when cache has wrong schema_version', () => {
    const dir = makeTmpProject();
    try {
      fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.orchestray', 'state', 'context-telemetry.json'),
        JSON.stringify({ schema_version: 99, active_subagents: [] }),
        'utf8'
      );
      const cache = readCache(dir);
      assert.equal(cache.schema_version, 1);
    } finally {
      teardown(dir);
    }
  });

  test('returns the stored cache when file is valid', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'sess-xyz');
      const cache = readCache(dir);
      assert.equal(cache.session_id, 'sess-xyz');
      assert.equal(cache.schema_version, 1);
    } finally {
      teardown(dir);
    }
  });
});

// ── resetCache ────────────────────────────────────────────────────────────────

describe('resetCache', () => {
  test('writes a fresh skeleton to disk with the given sessionId', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'new-session-1');
      const cache = readCache(dir);
      assert.equal(cache.session_id, 'new-session-1');
      assert.equal(cache.active_subagents.length, 0);
    } finally {
      teardown(dir);
    }
  });

  test('clears any previous active_subagents on reset', () => {
    const dir = makeTmpProject();
    try {
      // Write a cache with a subagent
      updateCache(dir, (c) => {
        c.active_subagents.push({ agent_id: 'ag-1', agent_type: 'developer' });
        return c;
      });
      // Now reset
      resetCache(dir, 'fresh-session');
      const cache = readCache(dir);
      assert.equal(cache.active_subagents.length, 0);
    } finally {
      teardown(dir);
    }
  });
});

// ── updateCache — subagent aggregation ────────────────────────────────────────

describe('updateCache — subagent aggregation', () => {
  test('adds a subagent row to active_subagents', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'sess-1');
      updateCache(dir, (cache) => {
        cache.active_subagents.push({
          agent_id: 'ag-aaa',
          agent_type: 'developer',
          model: 'claude-sonnet-4-6',
          effort: 'medium',
          tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total_prompt: 0 },
          context_window: 200000,
          started_at: new Date().toISOString(),
        });
        return cache;
      });
      const cache = readCache(dir);
      assert.equal(cache.active_subagents.length, 1);
      assert.equal(cache.active_subagents[0].agent_id, 'ag-aaa');
    } finally {
      teardown(dir);
    }
  });

  test('two concurrent subagents both appear in active_subagents', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'sess-concurrent');
      // Spawn first subagent
      updateCache(dir, (cache) => {
        cache.active_subagents.push({ agent_id: 'ag-001', agent_type: 'developer', model: 'claude-sonnet-4-6' });
        return cache;
      });
      // Spawn second subagent concurrently (sequential calls simulate two hooks)
      updateCache(dir, (cache) => {
        cache.active_subagents.push({ agent_id: 'ag-002', agent_type: 'reviewer', model: 'claude-haiku-4-5' });
        return cache;
      });
      const cache = readCache(dir);
      assert.equal(cache.active_subagents.length, 2);
      const ids = cache.active_subagents.map((a) => a.agent_id);
      assert.ok(ids.includes('ag-001'));
      assert.ok(ids.includes('ag-002'));
    } finally {
      teardown(dir);
    }
  });

  test('removes a subagent from active_subagents on Stop event (active→completed transition)', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'sess-stop');
      updateCache(dir, (cache) => {
        cache.active_subagents.push({ agent_id: 'ag-stop-me', agent_type: 'architect' });
        return cache;
      });
      // Simulate Stop: remove the subagent
      updateCache(dir, (cache) => {
        cache.active_subagents = cache.active_subagents.filter((a) => a.agent_id !== 'ag-stop-me');
        return cache;
      });
      const cache = readCache(dir);
      assert.equal(cache.active_subagents.length, 0);
    } finally {
      teardown(dir);
    }
  });

  test('Stop on one subagent leaves other subagent active', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'sess-partial-stop');
      updateCache(dir, (cache) => {
        cache.active_subagents.push({ agent_id: 'ag-keep', agent_type: 'developer' });
        cache.active_subagents.push({ agent_id: 'ag-remove', agent_type: 'reviewer' });
        return cache;
      });
      updateCache(dir, (cache) => {
        cache.active_subagents = cache.active_subagents.filter((a) => a.agent_id !== 'ag-remove');
        return cache;
      });
      const cache = readCache(dir);
      assert.equal(cache.active_subagents.length, 1);
      assert.equal(cache.active_subagents[0].agent_id, 'ag-keep');
    } finally {
      teardown(dir);
    }
  });

  test('updateCache is fail-open when updaterFn throws', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'sess-failopen');
      // This should not throw
      updateCache(dir, () => { throw new Error('updater exploded'); });
      // Cache should still be readable
      const cache = readCache(dir);
      assert.equal(cache.schema_version, 1);
    } finally {
      teardown(dir);
    }
  });

  test('updateCache is fail-open when updaterFn returns null', () => {
    const dir = makeTmpProject();
    try {
      resetCache(dir, 'sess-null-return');
      updateCache(dir, () => null);
      const cache = readCache(dir);
      assert.equal(cache.schema_version, 1);
    } finally {
      teardown(dir);
    }
  });
});
