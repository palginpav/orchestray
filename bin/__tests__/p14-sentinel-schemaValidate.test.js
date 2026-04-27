#!/usr/bin/env node
'use strict';

/**
 * Tests for P1.4 sentinel probe: schemaValidate.
 *
 * Coverage:
 *   - happy: known event type validates → ok:true, valid:true
 *   - missing required field → ok:true, valid:false
 *   - unknown event type → ok:false, reason:unknown_event_type
 *   - non-object event → ok:false, reason:invalid_input
 *   - perf: < 50ms once schema is cached
 *
 * Note: validateEvent parses agents/pm-reference/event-schemas.md from
 * `process.cwd()`. To exercise the validator deterministically, the tests
 * stage a tmp project with a synthetic schema file that uses the level-3
 * lowercase-slug heading the parser supports.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const { schemaValidate } = require('../_lib/sentinel-probes');
const { clearCache } = require('../_lib/schema-emit-validator');

function mkTmpProjectWithSchema() {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'p14-sv-'));
  const refDir = pathMod.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(refDir, { recursive: true });
  const schema = [
    '### sample_event Event',
    '',
    '```json',
    '{',
    '  "type": "sample_event",',
    '  "version": 1,',
    '  "timestamp": "ISO 8601",',
    '  "orchestration_id": "orch-xxx",',
    '  "payload": "string"',
    '}',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(pathMod.join(refDir, 'event-schemas.md'), schema);
  return dir;
}

describe('sentinel-probes.schemaValidate', () => {
  test('valid event → ok:true, valid:true, errors empty', () => {
    const dir = mkTmpProjectWithSchema();
    const cwd = process.cwd();
    process.chdir(dir);
    clearCache();
    try {
      const r = schemaValidate({
        event: {
          type: 'sample_event',
          version: 1,
          timestamp: new Date().toISOString(),
          orchestration_id: 'orch-test',
          payload: 'hello',
        },
      });
      assert.equal(r.ok, true);
      assert.equal(r.valid, true);
      assert.deepEqual(r.errors, []);
      assert.equal(r.event_type, 'sample_event');
    } finally { process.chdir(cwd); clearCache(); }
  });

  test('missing required field → ok:true, valid:false, errors non-empty', () => {
    const dir = mkTmpProjectWithSchema();
    const cwd = process.cwd();
    process.chdir(dir);
    clearCache();
    try {
      const r = schemaValidate({
        event: { type: 'sample_event', version: 1 }, // missing timestamp/orch/payload
      });
      assert.equal(r.ok, true);
      assert.equal(r.valid, false);
      assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    } finally { process.chdir(cwd); clearCache(); }
  });

  test('unknown event type → ok:false, reason:unknown_event_type', () => {
    const dir = mkTmpProjectWithSchema();
    const cwd = process.cwd();
    process.chdir(dir);
    clearCache();
    try {
      const r = schemaValidate({
        event: { type: 'no_such_event_type_zzz', version: 1 },
      });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'unknown_event_type');
    } finally { process.chdir(cwd); clearCache(); }
  });

  test('non-object event → ok:false, reason:invalid_input', () => {
    const r = schemaValidate({ event: 'not-an-object' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'invalid_input');
  });

  test('perf: < 50ms per call once schema is cached', () => {
    const dir = mkTmpProjectWithSchema();
    const cwd = process.cwd();
    process.chdir(dir);
    clearCache();
    try {
      // Warm cache.
      schemaValidate({
        event: {
          type: 'sample_event', version: 1,
          timestamp: new Date().toISOString(),
          orchestration_id: 'orch-test', payload: 'x',
        },
      });
      const start = Date.now();
      const r = schemaValidate({
        event: {
          type: 'sample_event', version: 1,
          timestamp: new Date().toISOString(),
          orchestration_id: 'orch-test', payload: 'x',
        },
      });
      const elapsed = Date.now() - start;
      assert.equal(r.ok, true);
      assert.ok(elapsed < 50, 'expected < 50ms post-cache, got ' + elapsed + 'ms');
    } finally { process.chdir(cwd); clearCache(); }
  });
});
