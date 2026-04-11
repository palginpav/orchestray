#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/lib/rpc.js
 *
 * Covers: CODES constants, parseLine, isResponse, writeFrame,
 *         sendError, sendResult, logStderr.
 *
 * Stdout/stderr capture: swap process.stdout.write / process.stderr.write
 * in beforeEach, restore in afterEach. Node test runner does not provide
 * built-in stream capture.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  CODES,
  parseLine,
  isResponse,
  writeFrame,
  sendError,
  sendResult,
  logStderr,
} = require('../../../bin/mcp-server/lib/rpc.js');

// ---------------------------------------------------------------------------
// Capture helpers
// ---------------------------------------------------------------------------

function captureStdout() {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    restore() { process.stdout.write = original; },
    get output() { return chunks.join(''); },
  };
}

function captureStderr() {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    restore() { process.stderr.write = original; },
    get output() { return chunks.join(''); },
  };
}

// ---------------------------------------------------------------------------
// CODES
// ---------------------------------------------------------------------------

describe('CODES', () => {
  test('JSONRPC_PARSE_ERROR is -32700', () => {
    assert.equal(CODES.JSONRPC_PARSE_ERROR, -32700);
  });

  test('JSONRPC_INVALID_REQUEST is -32600', () => {
    assert.equal(CODES.JSONRPC_INVALID_REQUEST, -32600);
  });

  test('JSONRPC_METHOD_NOT_FOUND is -32601', () => {
    assert.equal(CODES.JSONRPC_METHOD_NOT_FOUND, -32601);
  });

  test('JSONRPC_INVALID_PARAMS is -32602', () => {
    assert.equal(CODES.JSONRPC_INVALID_PARAMS, -32602);
  });

  test('JSONRPC_INTERNAL_ERROR is -32603', () => {
    assert.equal(CODES.JSONRPC_INTERNAL_ERROR, -32603);
  });

  test('MCP_RESOURCE_NOT_FOUND is -32002', () => {
    assert.equal(CODES.MCP_RESOURCE_NOT_FOUND, -32002);
  });

  test('CODES object is frozen (immutable)', () => {
    assert.throws(() => { CODES.JSONRPC_PARSE_ERROR = 0; }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// parseLine
// ---------------------------------------------------------------------------

describe('parseLine', () => {
  let stderr;
  beforeEach(() => { stderr = captureStderr(); });
  afterEach(() => { if (stderr) { stderr.restore(); stderr = null; } });

  test('valid JSON object returns ok:true with parsed msg', () => {
    const result = parseLine('{"jsonrpc":"2.0","method":"ping","id":1}');
    assert.equal(result.ok, true);
    assert.equal(result.msg.method, 'ping');
    assert.equal(result.msg.id, 1);
  });

  test('invalid JSON returns ok:false with PARSE_ERROR code and message', () => {
    const result = parseLine('{bad json}');
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.JSONRPC_PARSE_ERROR);
    assert.equal(result.message, 'Parse error');
  });

  test('empty string returns ok:false with PARSE_ERROR (empty is invalid JSON)', () => {
    const result = parseLine('');
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.JSONRPC_PARSE_ERROR);
  });

  test('JSON number (not object) returns ok:false with INVALID_REQUEST', () => {
    const result = parseLine('42');
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.JSONRPC_INVALID_REQUEST);
    assert.equal(result.message, 'Invalid Request');
  });

  test('JSON null returns ok:false with INVALID_REQUEST', () => {
    const result = parseLine('null');
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.JSONRPC_INVALID_REQUEST);
  });

  test('JSON string returns ok:false with INVALID_REQUEST', () => {
    const result = parseLine('"hello"');
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.JSONRPC_INVALID_REQUEST);
  });

  test('JSON array returns ok:false with INVALID_REQUEST', () => {
    const result = parseLine('[1,2,3]');
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.JSONRPC_INVALID_REQUEST);
  });

  test('whitespace-padded valid JSON is trimmed and parsed correctly', () => {
    const result = parseLine('   {"method":"tools/list"}   ');
    assert.equal(result.ok, true);
    assert.equal(result.msg.method, 'tools/list');
  });

  test('valid JSON with unicode content is preserved', () => {
    const result = parseLine('{"text":"こんにちは 🌏"}');
    assert.equal(result.ok, true);
    assert.equal(result.msg.text, 'こんにちは 🌏');
  });

  test('very large valid JSON object (100KB) is parsed correctly', () => {
    const bigValue = 'x'.repeat(100_000);
    const result = parseLine(JSON.stringify({ key: bigValue }));
    assert.equal(result.ok, true);
    assert.equal(result.msg.key.length, 100_000);
  });
});

// ---------------------------------------------------------------------------
// isResponse
// ---------------------------------------------------------------------------

describe('isResponse', () => {
  test('returns true when result is present', () => {
    assert.equal(isResponse({ result: null }), true);
  });

  test('returns true when result is an object', () => {
    assert.equal(isResponse({ result: { tools: [] } }), true);
  });

  test('returns true when error is present', () => {
    assert.equal(isResponse({ error: { code: -32700, message: 'Parse error' } }), true);
  });

  test('returns true when both result and error are present', () => {
    assert.equal(isResponse({ result: {}, error: {} }), true);
  });

  test('returns falsy when neither result nor error is present', () => {
    assert.ok(!isResponse({ method: 'ping', id: 1 }));
  });

  test('returns falsy for null input', () => {
    assert.ok(!isResponse(null));
  });

  test('returns falsy for non-object input', () => {
    assert.ok(!isResponse(42));
  });
});

// ---------------------------------------------------------------------------
// writeFrame
// ---------------------------------------------------------------------------

describe('writeFrame', () => {
  let stdout;
  let stderr;
  beforeEach(() => { stdout = captureStdout(); stderr = captureStderr(); });
  afterEach(() => {
    if (stdout) { stdout.restore(); stdout = null; }
    if (stderr) { stderr.restore(); stderr = null; }
  });

  test('writes JSON-serialised object followed by a newline', () => {
    writeFrame({ jsonrpc: '2.0', id: 1, result: {} });
    assert.equal(stdout.output, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  });

  test('output ends with exactly one newline', () => {
    writeFrame({ a: 1 });
    assert.ok(stdout.output.endsWith('\n'));
    assert.equal(stdout.output.indexOf('\n'), stdout.output.length - 1);
  });

  test('handles objects containing unicode and embedded quotes', () => {
    writeFrame({ text: 'say "hello" 🌍' });
    const parsed = JSON.parse(stdout.output.trim());
    assert.equal(parsed.text, 'say "hello" 🌍');
  });

  test('handles objects containing embedded newline characters in string values', () => {
    writeFrame({ text: 'line1\nline2' });
    // The frame itself must be a single line (newline encoded as \n in JSON)
    const lines = stdout.output.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.text, 'line1\nline2');
  });

  test('does not throw on circular reference — logs to stderr instead', () => {
    const obj = {};
    obj.self = obj; // circular
    assert.doesNotThrow(() => writeFrame(obj));
    assert.ok(stdout.output === ''); // nothing written to stdout
    assert.ok(stderr.output.includes('[orchestray-mcp]'));
  });

  // Primitive-argument behavior: writeFrame does NOT validate that `obj` is a
  // plain JSON-RPC envelope. Passing a primitive yields a technically-valid
  // JSON line but a MALFORMED JSON-RPC frame on the wire. These tests lock in
  // current behavior so a future "safety" change that starts rejecting
  // primitives is a conscious decision, not a silent breakage. Frame-shape
  // validation is the caller's responsibility (server.js dispatch), not
  // writeFrame's.
  test('writeFrame(null) emits "null\\n" — caller is responsible for envelope shape', () => {
    assert.doesNotThrow(() => writeFrame(null));
    assert.equal(stdout.output, 'null\n');
    assert.equal(stderr.output, '');
  });

  test('writeFrame(42) emits "42\\n" — caller is responsible for envelope shape', () => {
    assert.doesNotThrow(() => writeFrame(42));
    assert.equal(stdout.output, '42\n');
    assert.equal(stderr.output, '');
  });
});

// ---------------------------------------------------------------------------
// sendError
// ---------------------------------------------------------------------------

describe('sendError', () => {
  let stdout;
  let stderr;
  beforeEach(() => { stdout = captureStdout(); stderr = captureStderr(); });
  afterEach(() => {
    if (stdout) { stdout.restore(); stdout = null; }
    if (stderr) { stderr.restore(); stderr = null; }
  });

  test('id=null produces JSON-RPC error envelope with id:null', () => {
    sendError(null, CODES.JSONRPC_PARSE_ERROR, 'Parse error');
    const frame = JSON.parse(stdout.output.trim());
    assert.equal(frame.jsonrpc, '2.0');
    assert.equal(frame.id, null);
    assert.equal(frame.error.code, -32700);
    assert.equal(frame.error.message, 'Parse error');
  });

  test('id=number is preserved in output', () => {
    sendError(7, CODES.JSONRPC_METHOD_NOT_FOUND, 'Method not found');
    const frame = JSON.parse(stdout.output.trim());
    assert.equal(frame.id, 7);
    assert.equal(frame.error.code, -32601);
  });

  test('id=string is preserved in output', () => {
    sendError('req-abc', CODES.JSONRPC_INVALID_PARAMS, 'Invalid params');
    const frame = JSON.parse(stdout.output.trim());
    assert.equal(frame.id, 'req-abc');
  });

  test('data field is omitted when not provided', () => {
    sendError(1, CODES.JSONRPC_INTERNAL_ERROR, 'Internal error');
    const frame = JSON.parse(stdout.output.trim());
    assert.ok(!('data' in frame.error));
  });

  test('data field is included when provided', () => {
    sendError(1, CODES.JSONRPC_INTERNAL_ERROR, 'Internal error', { detail: 'stack trace' });
    const frame = JSON.parse(stdout.output.trim());
    assert.equal(frame.error.data.detail, 'stack trace');
  });

  test('message with special characters is JSON-safe in output', () => {
    sendError(null, -32600, 'Bad "input" & more');
    const frame = JSON.parse(stdout.output.trim());
    assert.equal(frame.error.message, 'Bad "input" & more');
  });
});

// ---------------------------------------------------------------------------
// sendResult
// ---------------------------------------------------------------------------

describe('sendResult', () => {
  let stdout;
  let stderr;
  beforeEach(() => { stdout = captureStdout(); stderr = captureStderr(); });
  afterEach(() => {
    if (stdout) { stdout.restore(); stdout = null; }
    if (stderr) { stderr.restore(); stderr = null; }
  });

  test('result=null produces valid envelope', () => {
    sendResult(1, null);
    const frame = JSON.parse(stdout.output.trim());
    assert.equal(frame.jsonrpc, '2.0');
    assert.equal(frame.id, 1);
    assert.equal(frame.result, null);
  });

  test('result={} produces valid envelope', () => {
    sendResult(2, {});
    const frame = JSON.parse(stdout.output.trim());
    assert.deepEqual(frame.result, {});
  });

  test('result=array is preserved', () => {
    sendResult(3, [1, 2, 3]);
    const frame = JSON.parse(stdout.output.trim());
    assert.deepEqual(frame.result, [1, 2, 3]);
  });

  test('result with nested objects is preserved', () => {
    const nested = { tools: [{ name: 'kb_search', description: 'search' }] };
    sendResult(4, nested);
    const frame = JSON.parse(stdout.output.trim());
    assert.equal(frame.result.tools[0].name, 'kb_search');
  });
});

// ---------------------------------------------------------------------------
// logStderr
// ---------------------------------------------------------------------------

describe('logStderr', () => {
  let stderr;
  beforeEach(() => { stderr = captureStderr(); });
  afterEach(() => { stderr.restore(); });

  test('prefixes message with [orchestray-mcp] and appends newline', () => {
    logStderr('server started');
    assert.equal(stderr.output, '[orchestray-mcp] server started\n');
  });

  test('numeric argument is coerced to string via concatenation', () => {
    logStderr(42);
    assert.ok(stderr.output.includes('[orchestray-mcp] 42\n'));
  });

  test('object argument is coerced via toString() (produces [object Object])', () => {
    logStderr({ key: 'val' });
    assert.ok(stderr.output.startsWith('[orchestray-mcp] '));
    assert.ok(stderr.output.endsWith('\n'));
  });

  test('empty string produces just the prefix and newline', () => {
    logStderr('');
    assert.equal(stderr.output, '[orchestray-mcp] \n');
  });
});
