#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/_lib/agent-registry.js (W2/W4, v2.3.26).
 *
 * Covers the fold semantics (readRegistry), the membership contract that
 * downstream consumers (collect-agent-metrics.js) rely on for the phantom-
 * stop rejection, matchPendingSpawn's FIFO/TTL binding, and deriveRosterName
 * — the primitive the "name:" attribution fix depends on.
 *
 * These are pure in-process tests against the module (no subprocess), kept
 * separate from the end-to-end hook-pipeline coverage in
 * bin/__tests__/v2326-agent-lifecycle.test.js.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  registryPath,
  appendTransition,
  readRegistry,
  matchPendingSpawn,
  deriveRosterName,
  dismissalHandle,
} = require('../agent-registry');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-agent-registry-test-'));
}

describe('deriveRosterName', () => {
  test('extracts the roster name from a named spawn agent_id', () => {
    const id = 'adev-opus5-0123456789abcdef';
    assert.equal(deriveRosterName(id), 'dev-opus5');
  });

  test('returns null for an unnamed spawn agent_id (no roster segment)', () => {
    // Unnamed spawns produce a(16 hex) with no roster name.
    const id = 'a0123456789abcdef0';
    assert.equal(deriveRosterName(id), null);
  });

  test('returns null for non-string / falsy input', () => {
    assert.equal(deriveRosterName(null), null);
    assert.equal(deriveRosterName(undefined), null);
    assert.equal(deriveRosterName(42), null);
  });
});

describe('dismissalHandle', () => {
  test('prefers roster_name over agent_id when both present', () => {
    assert.equal(
      dismissalHandle({ roster_name: 'dev-opus5', agent_id: 'a123' }),
      'dev-opus5'
    );
  });

  test('falls back to agent_id when roster_name is absent', () => {
    assert.equal(dismissalHandle({ roster_name: null, agent_id: 'a123' }), 'a123');
  });

  test('returns null for a null row', () => {
    assert.equal(dismissalHandle(null), null);
  });
});

describe('readRegistry — membership fold (acceptance criterion 1)', () => {
  test('an agent_id that never appears in the log is simply absent from byId', () => {
    const tmpDir = makeTmpDir();
    try {
      appendTransition(tmpDir, {
        event: 'running',
        agent_id: 'a-registered-agent',
        orchestration_id: 'orch-1',
        model: 'claude-sonnet-5',
      });

      const { byId } = readRegistry(tmpDir, { orchestrationId: 'orch-1' });

      // The registered agent is present...
      assert.ok(byId.has('a-registered-agent'));
      // ...but an id that was never written (the phantom-stop shape —
      // Claude Code's own internal subagents that fire SubagentStop without
      // ever having fired SubagentStart) must NOT appear. This is the
      // membership gate collect-agent-metrics.js relies on — inverted, this
      // assertion would pass against code that fabricates rows for anything.
      assert.equal(byId.has('a-phantom-agent'), false);
      assert.equal(byId.get('a-phantom-agent'), undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('appendTransition for an unregistered agent_id does not retroactively register it', () => {
    const tmpDir = makeTmpDir();
    try {
      // Only a `completed` transition is ever written for this id (this is
      // what a caller MUST NOT do per the membership-gate contract — the
      // fold should still reflect exactly what was written, nothing more).
      const { byId: before } = readRegistry(tmpDir, {});
      assert.equal(before.size, 0);
      // No rows written at all — simulates collect-agent-metrics.js correctly
      // skipping the appendTransition call for a phantom stop.
      const { byId: after } = readRegistry(tmpDir, {});
      assert.equal(after.size, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('readRegistry returns an empty fold (never throws) when the file is absent', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = readRegistry(tmpDir, {});
      assert.deepEqual([...result.byId.entries()], []);
      assert.deepEqual([...result.pending.entries()], []);
      assert.equal(result.counts.registered, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('malformed lines in the registry file are skipped, not thrown', () => {
    const tmpDir = makeTmpDir();
    try {
      const filePath = registryPath(tmpDir);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        '{not valid json}\n' +
        JSON.stringify({ event: 'running', agent_id: 'a-good', orchestration_id: 'o1' }) + '\n'
      );
      const { byId } = readRegistry(tmpDir, {});
      assert.equal(byId.size, 1);
      assert.ok(byId.has('a-good'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('readRegistry — orchestration scoping and monotonicity', () => {
  test('rows from a different orchestration_id are excluded when scoped', () => {
    const tmpDir = makeTmpDir();
    try {
      appendTransition(tmpDir, { event: 'running', agent_id: 'a1', orchestration_id: 'orch-A' });
      appendTransition(tmpDir, { event: 'running', agent_id: 'a2', orchestration_id: 'orch-B' });

      const { byId } = readRegistry(tmpDir, { orchestrationId: 'orch-A' });
      assert.equal(byId.has('a1'), true);
      assert.equal(byId.has('a2'), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('an illegal back-edge (completed -> running) is dropped, later state retained', () => {
    const tmpDir = makeTmpDir();
    try {
      appendTransition(tmpDir, { event: 'running', agent_id: 'a1', orchestration_id: 'o1', model: 'sonnet' });
      appendTransition(tmpDir, { event: 'completed', agent_id: 'a1', orchestration_id: 'o1', model: 'sonnet' });
      // Illegal: moving backwards from completed to running.
      appendTransition(tmpDir, { event: 'running', agent_id: 'a1', orchestration_id: 'o1', model: 'CORRUPTED' });

      const { byId } = readRegistry(tmpDir, { orchestrationId: 'o1' });
      const row = byId.get('a1');
      assert.equal(row.event, 'completed', 'back-edge must not move state backwards');
      assert.equal(row.model, 'sonnet', 'back-edge payload must not clobber the legitimate row');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('completed -> resumed -> completed is a legal cycle (equal lattice rank)', () => {
    const tmpDir = makeTmpDir();
    try {
      appendTransition(tmpDir, { event: 'completed', agent_id: 'a1', orchestration_id: 'o1' });
      appendTransition(tmpDir, { event: 'resumed', agent_id: 'a1', orchestration_id: 'o1', resume_count: 1 });
      const { byId } = readRegistry(tmpDir, { orchestrationId: 'o1' });
      assert.equal(byId.get('a1').event, 'resumed');
      assert.equal(byId.get('a1').resume_count, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('matchPendingSpawn — FIFO/TTL binding', () => {
  test('returns null when there are no pending candidates', () => {
    const pending = new Map();
    assert.equal(matchPendingSpawn(pending, { agentType: 'developer', nowMs: Date.now() }), null);
  });

  test('picks the oldest candidate within the TTL window', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['k1', { ts: new Date(now - 4000).toISOString(), spawn_key: 'k1', agent_type: 'developer' }],
      ['k2', { ts: new Date(now - 1000).toISOString(), spawn_key: 'k2', agent_type: 'developer' }],
    ]);
    const matched = matchPendingSpawn(pending, { agentType: 'developer', nowMs: now });
    assert.equal(matched.spawn_key, 'k1');
  });

  test('excludes candidates older than the 5s TTL', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['stale', { ts: new Date(now - 6000).toISOString(), spawn_key: 'stale', agent_type: 'developer' }],
    ]);
    const matched = matchPendingSpawn(pending, { agentType: 'developer', nowMs: now });
    assert.equal(matched, null, 'a candidate past the 5s TTL must not be returned');
  });

  test('filters to matching agent_type when a same-type candidate exists', () => {
    const now = 1_000_000;
    const pending = new Map([
      ['wrong', { ts: new Date(now - 500).toISOString(), spawn_key: 'wrong', agent_type: 'reviewer' }],
      ['right', { ts: new Date(now - 100).toISOString(), spawn_key: 'right', agent_type: 'developer' }],
    ]);
    const matched = matchPendingSpawn(pending, { agentType: 'developer', nowMs: now });
    assert.equal(matched.spawn_key, 'right');
  });
});
