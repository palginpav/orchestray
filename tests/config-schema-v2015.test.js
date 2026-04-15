'use strict';

// Coverage for v2.0.15 config-schema additions:
//   - W5 AC: `hook-warn` and `hook-strict` accepted in VALID_PER_TOOL_VALUES
//   - T1 H5: `kill_switch_reason` required (non-empty string) when
//            `global_kill_switch` is true

const test = require('node:test');
const assert = require('node:assert');

const {
  validateMcpEnforcement,
} = require('../bin/_lib/config-schema');

test('W5 AC: hook-warn is a valid per-tool enforcement value', () => {
  const result = validateMcpEnforcement({ pattern_record_application: 'hook-warn' });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('W5 AC: hook-strict is a valid per-tool enforcement value', () => {
  const result = validateMcpEnforcement({ pattern_record_application: 'hook-strict' });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('W5 AC: unknown per-tool enforcement value is still rejected', () => {
  const result = validateMcpEnforcement({ pattern_record_application: 'block' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /must be one of/.test(e)));
});

test('T1 H5: global_kill_switch=true without kill_switch_reason is rejected', () => {
  const result = validateMcpEnforcement({ global_kill_switch: true });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => /kill_switch_reason is required/.test(e)),
    'expected a kill_switch_reason error; got: ' + JSON.stringify(result.errors)
  );
});

test('T1 H5: global_kill_switch=true with empty-string reason is rejected', () => {
  const result = validateMcpEnforcement({
    global_kill_switch: true,
    kill_switch_reason: '   ',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /kill_switch_reason is required/.test(e)));
});

test('T1 H5: global_kill_switch=true with non-empty reason is accepted', () => {
  const result = validateMcpEnforcement({
    global_kill_switch: true,
    kill_switch_reason: 'incident-2026-04-14',
  });
  assert.equal(result.valid, true, JSON.stringify(result));
});

test('T1 H5: global_kill_switch=false does not require kill_switch_reason', () => {
  const result = validateMcpEnforcement({ global_kill_switch: false });
  assert.equal(result.valid, true, JSON.stringify(result));
});
