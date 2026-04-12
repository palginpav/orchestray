#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/tools/pattern_record_skip_reason.js
 *
 * Per 2014-scope-proposal.md §W1 AC4.
 *
 * Contract under test:
 *   module exports: { definition, handle, SKIP_REASONS }
 *
 *   async handle(input, context)
 *     -> { isError, content, structuredContent? }
 *
 * Behavior:
 *   - Returns a success result with orchestration_id, reason, and recorded:true.
 *   - Validates the four-value reason enum.
 *   - Rejects reason:"other" without a note field.
 *   - Rejects missing orchestration_id.
 *   - Includes optional note in the success result when provided.
 *
 * AC4 sub-cases:
 *   (a) input validation of each enum branch
 *   (b) reason:"other" without note is rejected
 *   (c) missing orchestration_id is rejected
 *   (d) the tool appears in the fresh-install enable map with default true
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  handle,
  definition,
  SKIP_REASONS,
} = require('../../../bin/mcp-server/tools/pattern_record_skip_reason.js');

function makeContext(overrides = {}) {
  return {
    config: {},
    logger: () => {},
    ...overrides,
  };
}

function validInput(overrides = {}) {
  return {
    orchestration_id: 'orch-1744197600',
    reason: 'all-irrelevant',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// definition
// ---------------------------------------------------------------------------

describe('pattern_record_skip_reason definition', () => {

  test('exports a tool definition with name "pattern_record_skip_reason"', () => {
    assert.equal(definition.name, 'pattern_record_skip_reason');
    assert.ok(definition.description.length > 10, 'description must be a non-trivial string');
    assert.ok(definition.inputSchema, 'must have an inputSchema');
  });

  test('definition inputSchema requires orchestration_id and reason', () => {
    assert.ok(Array.isArray(definition.inputSchema.required));
    assert.ok(definition.inputSchema.required.includes('orchestration_id'));
    assert.ok(definition.inputSchema.required.includes('reason'));
  });

  test('definition inputSchema reason property is an enum with the four values', () => {
    const reasonProp = definition.inputSchema.properties.reason;
    assert.ok(reasonProp, 'reason property must exist in inputSchema');
    assert.ok(Array.isArray(reasonProp.enum), 'reason must have an enum');
    assert.deepEqual(
      [...reasonProp.enum].sort(),
      ['all-irrelevant', 'all-low-confidence', 'all-stale', 'other'].sort()
    );
  });

});

// ---------------------------------------------------------------------------
// SKIP_REASONS export
// ---------------------------------------------------------------------------

describe('SKIP_REASONS export', () => {

  test('exports the four-value reason array', () => {
    assert.ok(Array.isArray(SKIP_REASONS));
    assert.equal(SKIP_REASONS.length, 4);
    assert.ok(SKIP_REASONS.includes('all-irrelevant'));
    assert.ok(SKIP_REASONS.includes('all-low-confidence'));
    assert.ok(SKIP_REASONS.includes('all-stale'));
    assert.ok(SKIP_REASONS.includes('other'));
  });

});

// ---------------------------------------------------------------------------
// AC4(a): input validation of each enum branch
// ---------------------------------------------------------------------------

describe('AC4(a) — input validation of each enum branch', () => {

  test('accepts reason: all-irrelevant', async () => {
    const result = await handle(validInput({ reason: 'all-irrelevant' }), makeContext());
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.reason, 'all-irrelevant');
  });

  test('accepts reason: all-low-confidence', async () => {
    const result = await handle(validInput({ reason: 'all-low-confidence' }), makeContext());
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.reason, 'all-low-confidence');
  });

  test('accepts reason: all-stale', async () => {
    const result = await handle(validInput({ reason: 'all-stale' }), makeContext());
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.reason, 'all-stale');
  });

  test('accepts reason: other when note is provided', async () => {
    const result = await handle(
      validInput({ reason: 'other', note: 'patterns were for a different language' }),
      makeContext()
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.reason, 'other');
    assert.equal(body.note, 'patterns were for a different language');
  });

  test('rejects reason not in enum', async () => {
    const result = await handle(validInput({ reason: 'not-a-real-reason' }), makeContext());
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.length > 0, 'error message must be non-empty');
  });

  test('rejects empty reason string', async () => {
    const result = await handle(validInput({ reason: '' }), makeContext());
    assert.equal(result.isError, true);
  });

});

// ---------------------------------------------------------------------------
// AC4(b): reason: other without note is rejected
// ---------------------------------------------------------------------------

describe('AC4(b) — reason:"other" without note is rejected', () => {

  test('rejects reason:other with no note field at all', async () => {
    const result = await handle(validInput({ reason: 'other' }), makeContext());
    assert.equal(result.isError, true);
    assert.ok(
      result.content[0].text.toLowerCase().includes('note') ||
      result.content[0].text.toLowerCase().includes('required'),
      'error should mention note or required'
    );
  });

  test('rejects reason:other with empty note string', async () => {
    const result = await handle(validInput({ reason: 'other', note: '' }), makeContext());
    assert.equal(result.isError, true);
  });

  test('rejects reason:other with whitespace-only note', async () => {
    const result = await handle(validInput({ reason: 'other', note: '   ' }), makeContext());
    assert.equal(result.isError, true);
  });

  test('accepts reason:other with substantive note', async () => {
    const result = await handle(
      validInput({ reason: 'other', note: 'No matching pattern for cross-language refactor' }),
      makeContext()
    );
    assert.equal(result.isError, false);
  });

});

// ---------------------------------------------------------------------------
// AC4(c): missing orchestration_id is rejected
// ---------------------------------------------------------------------------

describe('AC4(c) — missing orchestration_id is rejected', () => {

  test('rejects input with no orchestration_id', async () => {
    const result = await handle({ reason: 'all-irrelevant' }, makeContext());
    assert.equal(result.isError, true);
  });

  test('rejects input with empty orchestration_id', async () => {
    const result = await handle(
      { orchestration_id: '', reason: 'all-irrelevant' },
      makeContext()
    );
    assert.equal(result.isError, true);
  });

  test('rejects input with orchestration_id exceeding maxLength', async () => {
    const longId = 'x'.repeat(65);
    const result = await handle(
      { orchestration_id: longId, reason: 'all-irrelevant' },
      makeContext()
    );
    assert.equal(result.isError, true);
  });

});

// ---------------------------------------------------------------------------
// AC4(d): tool appears in the fresh-install enable map with default true
// ---------------------------------------------------------------------------

describe('AC4(d) — fresh-install enable map includes pattern_record_skip_reason: true', () => {

  test('bin/install.js FRESH_INSTALL_MCP_TOOLS_ENABLED includes pattern_record_skip_reason: true', () => {
    const installSrc = fs.readFileSync(
      path.resolve(__dirname, '../../../bin/install.js'),
      'utf8'
    );
    assert.ok(
      installSrc.includes('FRESH_INSTALL_MCP_TOOLS_ENABLED'),
      'install.js must export/declare FRESH_INSTALL_MCP_TOOLS_ENABLED constant'
    );
    assert.ok(
      installSrc.includes('pattern_record_skip_reason'),
      'install.js FRESH_INSTALL_MCP_TOOLS_ENABLED must include pattern_record_skip_reason'
    );
    // Check the key maps to true
    const match = installSrc.match(/pattern_record_skip_reason\s*:\s*(true|false)/);
    assert.ok(match, 'pattern_record_skip_reason must have an explicit boolean value in install.js');
    assert.equal(match[1], 'true', 'pattern_record_skip_reason must default to true');
  });

  test('.orchestray/config.json mcp_server.tools includes pattern_record_skip_reason: true', () => {
    const configPath = path.resolve(__dirname, '../../../.orchestray/config.json');
    assert.ok(fs.existsSync(configPath), '.orchestray/config.json must exist');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(config.mcp_server, 'config must have mcp_server block');
    assert.ok(config.mcp_server.tools, 'config.mcp_server must have tools block');
    assert.equal(
      config.mcp_server.tools.pattern_record_skip_reason,
      true,
      'pattern_record_skip_reason must be true in mcp_server.tools'
    );
  });

});

// ---------------------------------------------------------------------------
// Success shape
// ---------------------------------------------------------------------------

describe('pattern_record_skip_reason success shape', () => {

  test('returns recorded:true with orchestration_id and reason on success', async () => {
    const result = await handle(
      validInput({ reason: 'all-stale' }),
      makeContext()
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.orchestration_id, 'orch-1744197600');
    assert.equal(body.reason, 'all-stale');
    assert.equal(body.recorded, true);
  });

  test('structuredContent matches text content', async () => {
    const result = await handle(validInput(), makeContext());
    assert.equal(result.isError, false);
    const fromText = JSON.parse(result.content[0].text);
    assert.deepEqual(result.structuredContent, fromText);
  });

  test('optional note is included in success result when provided', async () => {
    const note = 'all returned patterns were created from outdated 2.0.11 orchestrations';
    const result = await handle(
      validInput({ reason: 'all-stale', note }),
      makeContext()
    );
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.note, note);
  });

  test('note is absent from success result when not provided', async () => {
    const result = await handle(validInput({ reason: 'all-low-confidence' }), makeContext());
    assert.equal(result.isError, false);
    const body = JSON.parse(result.content[0].text);
    assert.ok(!('note' in body), 'note should not appear in result when not provided');
  });

});

// ---------------------------------------------------------------------------
// Note asymmetry: whitespace-only note is allowed for non-"other" reasons
// ---------------------------------------------------------------------------

describe('note asymmetry — whitespace note allowed for non-other reasons', () => {

  test('accepts reason:all-stale with whitespace-only note (asymmetry: note is optional for non-other)', async () => {
    // When reason is not "other", the note field is optional and its content is
    // not validated — a whitespace-only note is intentionally allowed. This
    // documents the asymmetry: only reason:"other" enforces note must be non-empty.
    const result = await handle(
      validInput({ reason: 'all-stale', note: '   ' }),
      makeContext()
    );
    assert.equal(result.isError, false, 'whitespace note must be accepted for non-other reason');
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.reason, 'all-stale');
    assert.equal(body.note, '   ');
  });

});
