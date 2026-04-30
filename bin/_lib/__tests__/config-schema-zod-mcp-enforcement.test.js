#!/usr/bin/env node
'use strict';

/**
 * Tests for validateMcpEnforcement() after zod migration (v2.2.15 P1-11).
 *
 * Runner: node --test bin/_lib/__tests__/config-schema-zod-mcp-enforcement.test.js
 *
 * Covers:
 *   - Non-object inputs rejected
 *   - Valid full object passes
 *   - Invalid enum values rejected with "must be one of" message
 *   - Invalid unknown_tool_policy rejected
 *   - invalid global_kill_switch type rejected
 *   - kill_switch_reason cross-field rule (T1 H5)
 *   - Extra keys passthrough (no spurious errors)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateMcpEnforcement, DEFAULT_MCP_ENFORCEMENT } = require('../config-schema');

test('zod: non-object input rejected', () => {
  const r = validateMcpEnforcement(null);
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].includes('must be an object'));
});

test('zod: array input rejected', () => {
  const r = validateMcpEnforcement([]);
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].includes('must be an object'));
});

test('zod: default object passes', () => {
  const r = validateMcpEnforcement(Object.assign({}, DEFAULT_MCP_ENFORCEMENT));
  assert.equal(r.valid, true, JSON.stringify(r));
});

test('zod: empty object passes (all keys optional)', () => {
  const r = validateMcpEnforcement({});
  assert.equal(r.valid, true, JSON.stringify(r));
});

test('zod: valid per-tool value "hook" passes', () => {
  const r = validateMcpEnforcement({ pattern_find: 'hook' });
  assert.equal(r.valid, true, JSON.stringify(r));
});

test('zod: invalid per-tool value produces "must be one of" error', () => {
  const r = validateMcpEnforcement({ kb_search: 'deny' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /must be one of/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /kb_search/.test(e)), JSON.stringify(r.errors));
  assert.ok(r.errors.some((e) => /deny/.test(e)), JSON.stringify(r.errors));
});

test('zod: invalid unknown_tool_policy produces "must be one of" error', () => {
  const r = validateMcpEnforcement({ unknown_tool_policy: 'strict' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /unknown_tool_policy/.test(e) && /must be one of/.test(e)), JSON.stringify(r.errors));
});

test('zod: non-boolean global_kill_switch rejected', () => {
  const r = validateMcpEnforcement({ global_kill_switch: 'yes' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /global_kill_switch.*boolean/.test(e) || /boolean.*global_kill_switch/.test(e)), JSON.stringify(r.errors));
});

test('zod: kill_switch_reason required when global_kill_switch is true (T1 H5)', () => {
  const r = validateMcpEnforcement({ global_kill_switch: true });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /kill_switch_reason is required/.test(e)), JSON.stringify(r.errors));
});

test('zod: kill_switch_reason whitespace-only rejected (T1 H5)', () => {
  const r = validateMcpEnforcement({ global_kill_switch: true, kill_switch_reason: '   ' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /kill_switch_reason is required/.test(e)), JSON.stringify(r.errors));
});

test('zod: kill_switch_reason non-empty accepted (T1 H5)', () => {
  const r = validateMcpEnforcement({ global_kill_switch: true, kill_switch_reason: 'incident-2026' });
  assert.equal(r.valid, true, JSON.stringify(r));
});

test('zod: extra unknown keys pass through without error', () => {
  const r = validateMcpEnforcement({ _custom_key: 'whatever' });
  assert.equal(r.valid, true, JSON.stringify(r));
});

test('zod: multiple invalid values produce multiple errors', () => {
  const r = validateMcpEnforcement({ pattern_find: 'bad', kb_search: 'also_bad' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 2, 'expected >= 2 errors, got: ' + JSON.stringify(r.errors));
});
