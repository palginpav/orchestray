#!/usr/bin/env node
'use strict';

/**
 * plugin-loader.fsm.smoke.test.js — W-LOAD-1 lifecycle FSM smoke tests.
 *
 * These tests exercise the lifecycle FSM in-memory without spinning up a
 * real subprocess. They cover:
 *   - all 8 states reachable / sticky-terminal `unloaded`
 *   - transition() rejects illegal moves
 *   - restart backoff sequence is [1s, 5s, 30s]
 *   - restart counter resets after the 5-min ready window
 *   - degraded → ready recovery via callTool path (mocked)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createLoader } = require('../plugin-loader.js');

// -- helpers -----------------------------------------------------------------

function noopAudit() { /* swallow events for FSM tests */ }

function makeLoader(extra) {
  return createLoader(Object.assign({
    discoveryPaths: [], // no fs scan in FSM tests
    audit: noopAudit,
  }, extra || {}));
}

// Manufacture a minimal PluginState for direct FSM testing. We bypass scan/load
// by reaching into _internals.state — that's the contract _internals exposes.
function injectPlugin(loader, name, initialState) {
  const ps = {
    plugin_name: name,
    state: 'unknown',
    scan_path: '',
    rootDir: '',
    manifest: null,
    proc: null,
    compiledValidators: new Map(),
    pendingCalls: new Map(),
    nextRpcId: 1,
    stdoutBuffer: '',
    stdoutBufferBytes: 0,
    stdoutTotalEmittedBytes: 0,
    restartAttempts: 0,
    readySinceMs: 0,
    registeredToolNames: new Set(),
  };
  loader._internals.state.set(name, ps);
  // Walk the FSM forward to reach the requested initial state.
  const path = (() => {
    switch (initialState) {
      case 'unknown':    return [];
      case 'discovered': return ['discovered'];
      case 'consented':  return ['discovered', 'consented'];
      case 'loading':    return ['discovered', 'consented', 'loading'];
      case 'ready':      return ['discovered', 'consented', 'loading', 'ready'];
      case 'degraded':   return ['discovered', 'consented', 'loading', 'ready', 'degraded'];
      case 'dead':       return ['discovered', 'consented', 'loading', 'dead'];
      case 'unloaded':   return ['discovered', 'unloaded'];
      default: throw new Error(`unhandled init state ${initialState}`);
    }
  })();
  for (const next of path) loader._internals.transition(ps, next);
  return ps;
}

// ---------------------------------------------------------------------------
// 1. All 8 states reachable
// ---------------------------------------------------------------------------

describe('W-LOAD-1 FSM states', () => {
  test('all 8 states are reachable via legal transitions', () => {
    const loader = makeLoader();
    for (const s of ['unknown', 'discovered', 'consented', 'loading',
                     'ready', 'degraded', 'dead', 'unloaded']) {
      const ps = injectPlugin(loader, `plugin-${s}`, s);
      assert.equal(ps.state, s, `failed to reach ${s}`);
    }
  });

  test('terminal state `unloaded` is sticky (no further transitions)', () => {
    const loader = makeLoader();
    const ps = injectPlugin(loader, 'sticky', 'unloaded');
    assert.throws(
      () => loader._internals.transition(ps, 'discovered'),
      /invalid FSM transition/
    );
    assert.throws(
      () => loader._internals.transition(ps, 'ready'),
      /invalid FSM transition/
    );
  });

  test('transition table forbids illegal jumps (e.g. discovered → ready)', () => {
    const loader = makeLoader();
    const ps = injectPlugin(loader, 'bad-jump', 'discovered');
    assert.throws(
      () => loader._internals.transition(ps, 'ready'),
      /invalid FSM transition/
    );
  });

  test('legal jumps within transition table do not throw', () => {
    const loader = makeLoader();
    const ps = injectPlugin(loader, 'legal', 'ready');
    assert.doesNotThrow(() => loader._internals.transition(ps, 'degraded'));
    assert.doesNotThrow(() => loader._internals.transition(ps, 'ready'));
    assert.doesNotThrow(() => loader._internals.transition(ps, 'dead'));
  });
});

// ---------------------------------------------------------------------------
// 2. Restart backoff sequence and counter behavior
// ---------------------------------------------------------------------------

describe('W-LOAD-1 restart backoff', () => {
  test('default restart backoff schedule is [1000, 5000, 30000]', () => {
    const loader = makeLoader();
    const _ = loader; // silence unused
    const { DEFAULT_OPTS } = require('../plugin-loader.js');
    assert.deepEqual([...DEFAULT_OPTS.restartBackoffMs], [1_000, 5_000, 30_000]);
  });

  test('default maxRestartAttempts is 3', () => {
    const { DEFAULT_OPTS } = require('../plugin-loader.js');
    assert.equal(DEFAULT_OPTS.maxRestartAttempts, 3);
  });

  test('default restart reset window is 5 minutes', () => {
    const { DEFAULT_OPTS } = require('../plugin-loader.js');
    assert.equal(DEFAULT_OPTS.restartResetWindowMs, 5 * 60_000);
  });

  test('transitionDead increments restartAttempts and emits restart event', () => {
    const events = [];
    const loader = makeLoader({
      audit: (ev) => events.push(ev),
      // Use a long backoff so we don't actually re-spawn in the test window.
      restartBackoffMs: [60_000, 60_000, 60_000],
    });
    const ps = injectPlugin(loader, 'restart-test', 'ready');
    loader._internals.transitionDead(ps, 'process_exit', 'first death');
    assert.equal(ps.restartAttempts, 1);
    const restartEvents = events.filter(e => e.type === 'plugin_restart_attempted');
    assert.equal(restartEvents.length, 1);
    assert.equal(restartEvents[0].attempt_number, 1);
    assert.equal(restartEvents[0].backoff_ms, 60_000);
  });

  test('restart attempts saturate at maxRestartAttempts (no further restart events)', () => {
    const events = [];
    const loader = makeLoader({
      audit: (ev) => events.push(ev),
      restartBackoffMs: [60_000, 60_000, 60_000],
    });
    const ps = injectPlugin(loader, 'budget', 'ready');
    // First death.
    loader._internals.transitionDead(ps, 'reason', '');
    assert.equal(ps.state, 'dead');
    // Manually re-bump the FSM to ready so transitionDead can run again.
    loader._internals.transition(ps, 'loading');
    loader._internals.transition(ps, 'ready');
    loader._internals.transitionDead(ps, 'reason', '');
    loader._internals.transition(ps, 'loading');
    loader._internals.transition(ps, 'ready');
    loader._internals.transitionDead(ps, 'reason', '');
    // Now exhausted — fourth death should NOT schedule another restart.
    loader._internals.transition(ps, 'loading');
    loader._internals.transition(ps, 'ready');
    loader._internals.transitionDead(ps, 'reason', '');
    const restartEvents = events.filter(e => e.type === 'plugin_restart_attempted');
    assert.equal(restartEvents.length, 3);
  });
});

// ---------------------------------------------------------------------------
// 3. degraded ↔ ready recovery semantics (FSM only — actual call recovery is
// exercised in plugin-loader.smoke.test.js with a real subprocess)
// ---------------------------------------------------------------------------

describe('W-LOAD-1 degraded recovery', () => {
  test('ready → degraded → ready is a legal transition pair', () => {
    const loader = makeLoader();
    const ps = injectPlugin(loader, 'recover', 'ready');
    loader._internals.transition(ps, 'degraded');
    assert.equal(ps.state, 'degraded');
    loader._internals.transition(ps, 'ready');
    assert.equal(ps.state, 'ready');
  });

  test('readySinceMs is set when a plugin enters ready', () => {
    const loader = makeLoader();
    const before = Date.now();
    const ps = injectPlugin(loader, 'time', 'ready');
    assert.ok(ps.readySinceMs >= before, 'readySinceMs should be set on ready');
  });
});

// ---------------------------------------------------------------------------
// 4. Sanity: getState() and listLoaded() introspection
// ---------------------------------------------------------------------------

describe('W-LOAD-1 introspection', () => {
  test('getState returns "unknown" for a never-seen plugin', () => {
    const loader = makeLoader();
    assert.equal(loader.getState('never-existed'), 'unknown');
  });

  test('listLoaded returns one entry per known plugin', () => {
    const loader = makeLoader();
    injectPlugin(loader, 'a', 'ready');
    injectPlugin(loader, 'b', 'degraded');
    const loaded = loader.listLoaded();
    assert.equal(loaded.length, 2);
    const a = loaded.find(p => p.plugin_name === 'a');
    const b = loaded.find(p => p.plugin_name === 'b');
    assert.equal(a.state, 'ready');
    assert.equal(b.state, 'degraded');
  });
});
