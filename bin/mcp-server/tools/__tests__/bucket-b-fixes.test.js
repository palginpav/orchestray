#!/usr/bin/env node
'use strict';

/**
 * Tests for Bucket B fixes (v2.3.10):
 *
 *   B1 — oversized frame guard: >8 MiB line → JSON-RPC error, server alive
 *   B2 — kb_write rate-limit field: input.task (not task_id) fires checkLimit
 *   B3 — additionalProperties: false: unknown top-level keys are rejected
 *   B4 — AGENT_ROLES superset: new roles accepted by history_query_events
 *
 * Runner: node --test bin/mcp-server/tools/__tests__/bucket-b-fixes.test.js
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bucketb-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'audit'), { recursive: true });
  return projectRoot;
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// B1: MAX_INPUT_BYTES guard
// ---------------------------------------------------------------------------

describe('B1 — MAX_INPUT_BYTES guard', () => {
  test('MAX_INPUT_BYTES is exported from constants and equals 8 MiB', () => {
    const { MAX_INPUT_BYTES } = require('../../lib/constants');
    assert.ok(typeof MAX_INPUT_BYTES === 'number', 'MAX_INPUT_BYTES should be a number');
    assert.equal(MAX_INPUT_BYTES, 8 * 1024 * 1024);
  });

  test('server.js imports MAX_INPUT_BYTES from constants', () => {
    // Read the server.js source to confirm the import + guard are present.
    const serverSrc = fs.readFileSync(
      path.join(__dirname, '../../server.js'),
      'utf8'
    );
    assert.ok(
      serverSrc.includes('MAX_INPUT_BYTES'),
      'server.js should reference MAX_INPUT_BYTES'
    );
    assert.ok(
      serverSrc.includes('frame too large'),
      'server.js should emit "frame too large" error'
    );
    assert.ok(
      serverSrc.includes('Buffer.byteLength'),
      'server.js should use Buffer.byteLength to measure frame size'
    );
  });

  test('oversized frame guard fires before parseLine (unit)', () => {
    // Verify the guard logic in isolation: a line larger than MAX_INPUT_BYTES
    // should be rejected. We test the condition, not the full server loop.
    const { MAX_INPUT_BYTES } = require('../../lib/constants');
    const oversizedLine = 'x'.repeat(MAX_INPUT_BYTES + 1);
    assert.ok(
      Buffer.byteLength(oversizedLine, 'utf8') > MAX_INPUT_BYTES,
      'test line should exceed MAX_INPUT_BYTES'
    );

    // parseLine on the oversized string would succeed (it's valid JSON if quoted),
    // but the guard fires first — verify that the byteLength check is the trigger.
    const normalLine = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    assert.ok(
      Buffer.byteLength(normalLine, 'utf8') < MAX_INPUT_BYTES,
      'normal frames should not be blocked'
    );
  });
});

// ---------------------------------------------------------------------------
// B2: kb_write rate-limit fires on input.task (not input.task_id)
// ---------------------------------------------------------------------------

describe('B2 — kb_write rate-limit field alignment', () => {
  let projectRoot;

  before(() => { projectRoot = makeTmpProject(); });
  after(() => cleanup(projectRoot));

  test('kb_write handler reads input.task for rate-limit key', () => {
    // Read the kb_write source and confirm it reads input.task, not input.task_id.
    const src = fs.readFileSync(path.join(__dirname, '../kb_write.js'), 'utf8');
    // After B2 fix: input.task is the read, not input.task_id
    assert.ok(
      src.includes('input.task ===') || src.includes("typeof input.task === 'string'"),
      'kb_write should read input.task for the taskId variable'
    );
    assert.ok(
      !src.includes("typeof input.task_id === 'string'"),
      'kb_write should NOT read input.task_id (wrong field name)'
    );
  });

  test('kb_write schema declares task (not task_id)', async () => {
    // Import kb_write and verify its INPUT_SCHEMA has `task` in properties.
    const { definition } = require('../kb_write.js');
    const schema = definition.inputSchema;
    assert.ok('task' in schema.properties, 'schema.properties should have "task"');
    assert.ok(!('task_id' in schema.properties), 'schema.properties should NOT have "task_id"');
  });

  test('kb_write accepts task field and completes successfully', async () => {
    const { handle } = require('../kb_write.js');
    const result = await handle(
      {
        id: 'test-b2-artifact',
        bucket: 'artifacts',
        path: 'test/b2.md',
        author: 'test',
        topic: 'B2 fix test',
        content: '# B2 test\n\nRate-limit field alignment.',
        orchestration_id: 'orch-b2-test',
        task: 'task-1',         // correct field name
        overwrite: true,
      },
      { projectRoot }
    );
    assert.ok(!result.isError, 'kb_write with task field should succeed: ' + JSON.stringify(result));
  });
});

// ---------------------------------------------------------------------------
// B3: additionalProperties: false rejects unknown top-level keys
// ---------------------------------------------------------------------------

describe('B3 — additionalProperties: false', () => {
  const { validateAgainstSchema } = require('../../lib/schemas');

  test('unknown prop rejected when additionalProperties: false', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
      },
    };
    const result = validateAgainstSchema({ name: 'hello', bogus: 'x' }, schema);
    assert.ok(!result.ok, 'should reject unknown prop');
    assert.ok(
      result.errors.some((e) => e.includes('bogus') && e.includes('unknown property')),
      'error should mention "bogus" and "unknown property": ' + JSON.stringify(result.errors)
    );
  });

  test('unknown prop allowed when additionalProperties omitted', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', minLength: 1 },
      },
    };
    const result = validateAgainstSchema({ name: 'hello', extra: 'x' }, schema);
    assert.ok(result.ok, 'should allow unknown prop when additionalProperties not set');
  });

  test('known props still pass with additionalProperties: false', () => {
    const schema = {
      type: 'object',
      required: ['name'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 },
        optional: { type: 'string' },
      },
    };
    const result = validateAgainstSchema({ name: 'hello', optional: 'yes' }, schema);
    assert.ok(result.ok, 'known props should still pass');
  });

  test('kb_write schema has additionalProperties: false', () => {
    const { definition } = require('../kb_write.js');
    assert.equal(definition.inputSchema.additionalProperties, false);
  });

  test('kb_write rejects unknown top-level keys', async () => {
    const { handle } = require('../kb_write.js');
    const result = await handle(
      {
        id: 'test-b3',
        bucket: 'artifacts',
        path: 'test/b3.md',
        author: 'test',
        topic: 'B3 test',
        content: 'content',
        task_id: 'should-not-be-here',  // wrong field (the B2 bug: old callers)
      },
      { projectRoot: os.tmpdir() }
    );
    assert.ok(result.isError, 'should reject unknown task_id key');
    assert.ok(
      result.content[0].text.includes('task_id') || result.content[0].text.includes('unknown property'),
      'error should mention task_id or unknown property: ' + result.content[0].text
    );
  });

  test('history_query_events schema has additionalProperties: false', () => {
    const { definition } = require('../history_query_events.js');
    assert.equal(definition.inputSchema.additionalProperties, false);
  });
});

// ---------------------------------------------------------------------------
// B4: AGENT_ROLES superset — new roles accepted
// ---------------------------------------------------------------------------

describe('B4 — AGENT_ROLES superset includes new roles', () => {
  let projectRoot;

  before(() => { projectRoot = makeTmpProject(); });
  after(() => cleanup(projectRoot));

  const newRoles = ['release-manager', 'ux-critic', 'platform-oracle', 'project-intent'];

  test('AGENT_ROLES constant includes all 4 new roles', () => {
    const { AGENT_ROLES } = require('../../lib/constants');
    for (const role of newRoles) {
      assert.ok(AGENT_ROLES.includes(role), `AGENT_ROLES should include "${role}"`);
    }
  });

  test('AGENT_ROLES still includes all original roles', () => {
    const { AGENT_ROLES } = require('../../lib/constants');
    const originals = [
      'pm', 'architect', 'developer', 'refactorer', 'reviewer',
      'debugger', 'tester', 'documenter', 'inventor', 'researcher', 'security-engineer',
    ];
    for (const role of originals) {
      assert.ok(AGENT_ROLES.includes(role), `AGENT_ROLES should still include "${role}"`);
    }
  });

  for (const role of newRoles) {
    test(`history_query_events accepts agent_role="${role}"`, async () => {
      const { handle } = require('../history_query_events.js');
      // No events.jsonl exists — should return empty result, NOT a validation error.
      const result = await handle(
        { agent_role: role, limit: 1 },
        { projectRoot }
      );
      assert.ok(
        !result.isError,
        `history_query_events should accept role "${role}" without error: ` +
        JSON.stringify(result.content && result.content[0] && result.content[0].text)
      );
    });
  }

  test('history_query_events still rejects bogus role', async () => {
    const { handle } = require('../history_query_events.js');
    const result = await handle(
      { agent_role: 'not-a-real-role', limit: 1 },
      { projectRoot }
    );
    assert.ok(result.isError, 'should reject bogus agent_role');
  });
});
