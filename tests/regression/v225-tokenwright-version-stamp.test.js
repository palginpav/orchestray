'use strict';

// Regression test for design §6 R11: v2.2.2's audit-event-writer does NOT
// autofill the `version` field. Tokenwright's emit helpers MUST stamp
// `version: 1` explicitly on every event they write. If they don't, the
// schema validator rejects the event and the 3-strike circuit breaker
// disables validation entirely until a sentinel is cleared by hand.
//
// This test stubs the audit-event-writer to capture every call and
// asserts both `prompt_compression` and `tokenwright_realized_savings`
// land with `version: 1` (and `type` and `timestamp`).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

// Inject a stub for ../audit-event-writer that captures all writes.
function withStubbedWriter(fn) {
  const captured = [];
  const writerPath = path.resolve(__dirname, '..', '..', 'bin', '_lib', 'audit-event-writer.js');
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  const stub = {
    writeEvent(payload) { captured.push(payload); return { ok: true }; },
    writeAuditEvent(payload) { captured.push(payload); return { ok: true }; },
  };
  Module._resolveFilename = function (req, parent, ...rest) {
    if (req === '../audit-event-writer' || req === './audit-event-writer' ||
        req === writerPath || (typeof req === 'string' && req.endsWith('audit-event-writer.js'))) {
      return writerPath;
    }
    return origResolve.call(this, req, parent, ...rest);
  };
  Module._load = function (req, parent, ...rest) {
    const resolved = (() => {
      try { return Module._resolveFilename(req, parent); }
      catch { return req; }
    })();
    if (resolved === writerPath) return stub;
    return origLoad.call(this, req, parent, ...rest);
  };
  // Drop the cached emit module so it picks up the stubbed writer.
  delete require.cache[require.resolve('../../bin/_lib/tokenwright/emit')];
  try {
    return fn(captured);
  } finally {
    Module._resolveFilename = origResolve;
    Module._load = origLoad;
    delete require.cache[require.resolve('../../bin/_lib/tokenwright/emit')];
  }
}

test('tokenwright/emit stamps version:1 on prompt_compression', () => {
  withStubbedWriter(captured => {
    const { emitPromptCompression } = require('../../bin/_lib/tokenwright/emit');
    emitPromptCompression({
      orchestration_id: 'orch-test',
      task_id: null,
      agent_type: 'developer',
      technique_tag: 'safe-l1',
      input_bytes: 1000,
      output_bytes: 800,
      ratio: 0.8,
      input_token_estimate: 250,
      output_token_estimate: 200,
      dropped_sections: [],
      layer1_dedup_blocks_dropped: 0,
    });
    assert.equal(captured.length, 1, 'one event must be written');
    const ev = captured[0];
    assert.equal(ev.type, 'prompt_compression');
    assert.equal(ev.version, 1, 'version field MUST be 1 — v2.2.2 audit-writer does not autofill');
    assert.match(ev.timestamp || '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('tokenwright/emit stamps version:1 on tokenwright_realized_savings', () => {
  withStubbedWriter(captured => {
    const { emitTokenwrightRealizedSavings } = require('../../bin/_lib/tokenwright/emit');
    emitTokenwrightRealizedSavings({
      orchestration_id: 'orch-test',
      task_id: 't1',
      agent_type: 'developer',
      estimated_input_tokens_pre: 250,
      actual_input_tokens: 240,
      actual_savings_tokens: 10,
      quality_signal_status: 'success',
      estimation_error_pct: 4.17,
    });
    assert.equal(captured.length, 1);
    const ev = captured[0];
    assert.equal(ev.type, 'tokenwright_realized_savings');
    assert.equal(ev.version, 1);
    assert.match(ev.timestamp || '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('tokenwright/emit fail-safe — does not throw when writer rejects', () => {
  // Stub writer that throws — emit must swallow it (compression-time
  // failure must never break the underlying spawn).
  const captured = [];
  const writerPath = path.resolve(__dirname, '..', '..', 'bin', '_lib', 'audit-event-writer.js');
  const origLoad = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === '../audit-event-writer' || req === './audit-event-writer' ||
        (typeof req === 'string' && req.endsWith('audit-event-writer.js'))) {
      return {
        writeEvent() { throw new Error('writer offline'); },
        writeAuditEvent() { throw new Error('writer offline'); },
      };
    }
    return origLoad.call(this, req, parent, ...rest);
  };
  delete require.cache[require.resolve('../../bin/_lib/tokenwright/emit')];
  try {
    const { emitPromptCompression } = require('../../bin/_lib/tokenwright/emit');
    assert.doesNotThrow(() => {
      emitPromptCompression({
        orchestration_id: 'orch-test',
        agent_type: 'developer',
        technique_tag: 'safe-l1',
        input_bytes: 1, output_bytes: 1, ratio: 1.0,
        input_token_estimate: 0, output_token_estimate: 0,
      });
    });
  } finally {
    Module._load = origLoad;
    delete require.cache[require.resolve('../../bin/_lib/tokenwright/emit')];
  }
});
