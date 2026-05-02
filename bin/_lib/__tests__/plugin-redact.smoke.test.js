'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { redactArgs, classifyArg } = require('../plugin-redact');

// ---------------------------------------------------------------------------
// 1. Sensitive fieldname
// ---------------------------------------------------------------------------
describe('sensitive fieldname', () => {
  it('api_key value is redacted to [REDACTED:fieldname]', () => {
    const result = redactArgs({ api_key: 'abc123' });
    assert.deepStrictEqual(result, { api_key: '[REDACTED:fieldname]' });
  });

  it('password field is redacted', () => {
    const result = redactArgs({ password: 'hunter2' });
    assert.deepStrictEqual(result, { password: '[REDACTED:fieldname]' });
  });

  it('token field is redacted', () => {
    const result = redactArgs({ token: 'tok_abc' });
    assert.deepStrictEqual(result, { token: '[REDACTED:fieldname]' });
  });
});

// ---------------------------------------------------------------------------
// 2. Sensitive path
// ---------------------------------------------------------------------------
describe('sensitive path', () => {
  it('~/.ssh/id_rsa path is redacted', () => {
    const result = redactArgs({ path: '/home/user/.ssh/id_rsa' });
    // 'path' is in safe-passthrough BUT the value contains id_rsa —
    // wait: 'path' IS in SAFE_PASSTHROUGH_KEYS so it passes through.
    // The spec says: {path: '/home/user/.ssh/id_rsa'} -> [REDACTED:path]
    // This implies sensitive-path rule fires even for 'path' key.
    // Re-reading spec: "Safe passthrough: values for keys named path
    // (when the value is a relative project-local path)".
    // /home/user/.ssh/id_rsa is NOT a relative project-local path, so
    // the safe-passthrough does NOT apply. We implement this by checking
    // path key: only bypass redaction when value is relative (no leading /).
    assert.deepStrictEqual(result, { path: '[REDACTED:path]' });
  });

  it('relative local path passes through', () => {
    const result = redactArgs({ path: 'src/index.js' });
    assert.deepStrictEqual(result, { path: 'src/index.js' });
  });

  it('.env file path is redacted', () => {
    const result = redactArgs({ file: '/project/.env' });
    assert.deepStrictEqual(result, { file: '[REDACTED:path]' });
  });
});

// ---------------------------------------------------------------------------
// 3. Secret pattern
// ---------------------------------------------------------------------------
describe('secret pattern', () => {
  it('JWT-like value is redacted', () => {
    // Construct a syntactically valid JWT-like string
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redactArgs({ jwt });
    assert.ok(
      result.jwt === '[REDACTED:secret]',
      `expected [REDACTED:secret], got: ${result.jwt}`
    );
  });

  it('GitHub PAT is redacted', () => {
    const result = redactArgs({ gh_token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' });
    assert.deepStrictEqual(result, { gh_token: '[REDACTED:secret]' });
  });

  it('AWS access key is redacted', () => {
    const result = redactArgs({ aws: 'AKIAIOSFODNN7EXAMPLE' });
    assert.deepStrictEqual(result, { aws: '[REDACTED:secret]' });
  });
});

// ---------------------------------------------------------------------------
// 4. Long string truncation
// ---------------------------------------------------------------------------
describe('long string', () => {
  it('500-char string is truncated with [TRUNCATED 500 chars]', () => {
    const result = redactArgs({ content: 'a'.repeat(500) });
    assert.ok(
      typeof result.content === 'string' && result.content.includes('[TRUNCATED 500 chars]'),
      `expected TRUNCATED marker, got: ${result.content}`
    );
  });

  it('string exactly at limit (200) passes through (non-hex chars)', () => {
    // Use 'z' (not a hex digit) to isolate length boundary from generic-hex rule
    const val = 'z'.repeat(200);
    const result = redactArgs({ content: val });
    assert.deepStrictEqual(result, { content: val });
  });

  it('string at 201 chars is truncated', () => {
    const val = 'c'.repeat(201);
    const result = redactArgs({ content: val });
    assert.ok(result.content.includes('[TRUNCATED 201 chars]'));
  });
});

// ---------------------------------------------------------------------------
// 5. Safe passthrough
// ---------------------------------------------------------------------------
describe('safe passthrough', () => {
  it('id key is not redacted', () => {
    const result = redactArgs({ id: 'task-1' });
    assert.deepStrictEqual(result, { id: 'task-1' });
  });

  it('orchestration_id passes through', () => {
    const result = redactArgs({ orchestration_id: 'orch-abc123def456' });
    assert.deepStrictEqual(result, { orchestration_id: 'orch-abc123def456' });
  });

  it('model passes through', () => {
    const result = redactArgs({ model: 'claude-sonnet-4-6' });
    assert.deepStrictEqual(result, { model: 'claude-sonnet-4-6' });
  });

  it('uuid passes through even if hex-like', () => {
    // 32-char hex would normally trigger generic-hex rule
    const uuid = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const result = redactArgs({ uuid });
    assert.deepStrictEqual(result, { uuid });
  });
});

// ---------------------------------------------------------------------------
// 6. Nested recursion
// ---------------------------------------------------------------------------
describe('recursion', () => {
  it('nested token field is redacted', () => {
    const result = redactArgs({ nested: { token: 'xyz' } });
    assert.deepStrictEqual(result, { nested: { token: '[REDACTED:fieldname]' } });
  });

  it('array elements are recursed', () => {
    const result = redactArgs([{ api_key: 'secret' }]);
    assert.deepStrictEqual(result, [{ api_key: '[REDACTED:fieldname]' }]);
  });

  it('non-string primitives pass through', () => {
    const result = redactArgs({ count: 42, flag: true, nothing: null });
    assert.deepStrictEqual(result, { count: 42, flag: true, nothing: null });
  });
});

// ---------------------------------------------------------------------------
// 7. Depth cap
// ---------------------------------------------------------------------------
describe('depth cap', () => {
  it('value at depth 7 is replaced with [REDACTED:depth-exceeded]', () => {
    // depth 0 = root object, depth 1 = a, ..., depth 7 = h's value
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'deep' } } } } } } } };
    const result = redactArgs(deep);
    // Navigate to depth-7 value
    assert.strictEqual(result.a.b.c.d.e.f.g, '[REDACTED:depth-exceeded]');
  });

  it('value at depth 6 is NOT depth-exceeded', () => {
    // a.b.c.d.e.f = depth 6 value
    const obj = { a: { b: { c: { d: { e: { f: 'ok' } } } } } };
    const result = redactArgs(obj);
    assert.strictEqual(result.a.b.c.d.e.f, 'ok');
  });
});

// ---------------------------------------------------------------------------
// classifyArg unit tests
// ---------------------------------------------------------------------------
describe('classifyArg', () => {
  it('id key → safe', () => {
    assert.strictEqual(classifyArg('id', 'anything'), 'safe');
  });

  it('password key → sensitive-fieldname', () => {
    assert.strictEqual(classifyArg('password', 'anything'), 'sensitive-fieldname');
  });

  it('.ssh path value → sensitive-path', () => {
    assert.strictEqual(classifyArg('file', '/home/user/.ssh/id_rsa'), 'sensitive-path');
  });

  it('JWT value → secret-pattern', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SomeSignatureHere123';
    assert.strictEqual(classifyArg('data', jwt), 'secret-pattern');
  });

  it('long string → long-string', () => {
    assert.strictEqual(classifyArg('msg', 'x'.repeat(201)), 'long-string');
  });
});

// ---------------------------------------------------------------------------
// Wave 1 closeout: regression tests for reviewer findings #5 and #6
// ---------------------------------------------------------------------------

describe('regression: SECURITY_SENSITIVE_PATHS over-redaction (W-SEC-14, finding #5)', () => {
  it('arbitrary prose containing "token" passes through (length-permitting)', () => {
    const result = redactArgs({ message: 'token validation failed' });
    // After dropping the SECURITY_SENSITIVE_PATHS spread, plain prose is no
    // longer flagged as a sensitive path. The fieldname rule does not fire
    // because "message" is not a sensitive fieldname.
    assert.deepStrictEqual(result, { message: 'token validation failed' });
  });

  it('arbitrary prose containing "permission" passes through', () => {
    const result = redactArgs({ message: 'permission denied for user' });
    assert.deepStrictEqual(result, { message: 'permission denied for user' });
  });

  it('arbitrary prose containing "key" passes through', () => {
    const result = redactArgs({ status: 'kindly press any key to continue' });
    assert.deepStrictEqual(result, { status: 'kindly press any key to continue' });
  });

  it('actual sensitive path STILL gets redacted (rule #2 unchanged)', () => {
    const result = redactArgs({ file: '/home/user/.ssh/id_rsa' });
    assert.deepStrictEqual(result, { file: '[REDACTED:path]' });
  });

  it('sensitive fieldname STILL fires (rule #1 unchanged)', () => {
    const result = redactArgs({ token: 'anything' });
    assert.deepStrictEqual(result, { token: '[REDACTED:fieldname]' });
  });
});

describe('regression: __proto__ key in args object (W-SEC-10, finding #6)', () => {
  it('__proto__ own-key from JSON.parse is stripped from redacted output', () => {
    // JSON.parse produces an own-key named "__proto__" rather than mutating the
    // real prototype. Without the Wave 1 closeout fix, redactArgs would copy
    // this poisonous key into the output via `out[k] = ...`.
    const raw = JSON.parse('{"foo":"bar","__proto__":{"isAdmin":true}}');
    const result = redactArgs(raw);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, '__proto__'),
      '__proto__ own-key must be stripped from redacted output');
    assert.strictEqual(result.foo, 'bar');
  });

  it('prototype and constructor own-keys are stripped', () => {
    const raw = JSON.parse('{"safe":"value","prototype":{"poison":1},"constructor":{"poison":2}}');
    const result = redactArgs(raw);
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'prototype'));
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'constructor'));
    assert.strictEqual(result.safe, 'value');
  });

  it('nested __proto__ in deeper objects is also stripped', () => {
    const raw = JSON.parse('{"level1":{"level2":{"__proto__":{"poison":1},"safe":"v"}}}');
    const result = redactArgs(raw);
    assert.ok(!Object.prototype.hasOwnProperty.call(result.level1.level2, '__proto__'),
      '__proto__ stripped at every nesting level');
    assert.strictEqual(result.level1.level2.safe, 'v');
  });
});
