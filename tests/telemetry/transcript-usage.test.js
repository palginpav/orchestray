'use strict';

/**
 * Tests for bin/_lib/transcript-usage.js
 *
 * Coverage group 1: Transcript JSONL parsing
 *   - Well-formed transcript → correct token totals
 *   - Partial/truncated JSONL lines → graceful skip, no throw
 *   - Missing transcript file → returns null (no throw)
 *   - Both transcript envelope shapes (flat vs. nested message)
 *   - extractFirstAssistantModel: returns model from first assistant line
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  extractLastAssistantUsage,
  extractFirstAssistantModel,
} = require('../../bin/_lib/transcript-usage');

const FIXTURES = path.resolve(__dirname, 'fixtures');

// ── Helper ────────────────────────────────────────────────────────────────────

function writeTmp(content) {
  const tmpPath = path.join(os.tmpdir(), 'orch-test-transcript-' + process.pid + '-' + Date.now() + '.jsonl');
  fs.writeFileSync(tmpPath, content, 'utf8');
  return tmpPath;
}

// ── extractLastAssistantUsage ─────────────────────────────────────────────────

describe('extractLastAssistantUsage', () => {
  test('returns null for a missing file without throwing', () => {
    const result = extractLastAssistantUsage('/no/such/file/transcript.jsonl');
    assert.equal(result, null);
  });

  test('returns null for an empty file', () => {
    const tmp = writeTmp('');
    try {
      const result = extractLastAssistantUsage(tmp);
      assert.equal(result, null);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('returns correct token totals from a well-formed flat-shape transcript', () => {
    const result = extractLastAssistantUsage(path.join(FIXTURES, 'well-formed.jsonl'));
    assert.ok(result, 'should return a result');
    // Last assistant entry has input_tokens:200
    assert.equal(result.usage.input_tokens, 200);
    assert.equal(result.usage.output_tokens, 120);
    assert.equal(result.usage.cache_read_input_tokens, 50);
    assert.equal(result.usage.cache_creation_input_tokens, 0);
    assert.equal(result.model_used, 'claude-sonnet-4-6');
  });

  test('returns last assistant entry (not first) when multiple assistant lines exist', () => {
    const result = extractLastAssistantUsage(path.join(FIXTURES, 'well-formed.jsonl'));
    assert.ok(result);
    // First entry has input_tokens:150, last has input_tokens:200
    assert.equal(result.usage.input_tokens, 200, 'should return the LAST assistant entry');
  });

  test('parses nested message-envelope shape correctly', () => {
    const result = extractLastAssistantUsage(path.join(FIXTURES, 'envelope-shape.jsonl'));
    assert.ok(result, 'should parse nested envelope shape');
    assert.equal(result.usage.input_tokens, 300);
    assert.equal(result.usage.output_tokens, 100);
    assert.equal(result.usage.cache_creation_input_tokens, 10);
    assert.equal(result.model_used, 'claude-opus-4-6');
  });

  test('skips truncated final JSONL line and returns last valid entry without throwing', () => {
    const result = extractLastAssistantUsage(path.join(FIXTURES, 'truncated.jsonl'));
    // Truncated last line should be skipped; the valid assistant entry above it should be returned
    assert.ok(result, 'should return a result, not null');
    assert.equal(result.usage.input_tokens, 100);
    assert.equal(result.model_used, 'claude-haiku-4-5');
  });

  test('returns null when file has no assistant entries', () => {
    const content = '{"role":"user","content":"hello"}\n{"role":"user","content":"still user"}\n';
    const tmp = writeTmp(content);
    try {
      const result = extractLastAssistantUsage(tmp);
      assert.equal(result, null);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('returns null when assistant entries have no usage field', () => {
    const content = '{"role":"assistant","model":"claude-sonnet-4-6"}\n';
    const tmp = writeTmp(content);
    try {
      const result = extractLastAssistantUsage(tmp);
      assert.equal(result, null);
    } finally {
      fs.unlinkSync(tmp);
    }
  });

  test('coerces numeric fields to numbers and defaults missing fields to 0', () => {
    const content = JSON.stringify({
      role: 'assistant',
      usage: { input_tokens: '42', output_tokens: '10' },
      model: 'claude-sonnet-4-6',
    }) + '\n';
    const tmp = writeTmp(content);
    try {
      const result = extractLastAssistantUsage(tmp);
      assert.ok(result);
      assert.equal(result.usage.input_tokens, 42);
      assert.equal(result.usage.cache_read_input_tokens, 0);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});

// ── extractFirstAssistantModel ────────────────────────────────────────────────

describe('extractFirstAssistantModel', () => {
  test('returns null for a missing file without throwing', () => {
    const result = extractFirstAssistantModel('/no/such/file.jsonl');
    assert.equal(result, null);
  });

  test('returns model from first assistant line in flat shape', () => {
    const result = extractFirstAssistantModel(path.join(FIXTURES, 'well-formed.jsonl'));
    // First assistant line has model 'claude-sonnet-4-6'
    assert.equal(result, 'claude-sonnet-4-6');
  });

  test('returns model from first assistant line in nested envelope shape', () => {
    const result = extractFirstAssistantModel(path.join(FIXTURES, 'envelope-shape.jsonl'));
    assert.equal(result, 'claude-opus-4-6');
  });

  test('returns null when no assistant entry with model exists', () => {
    const content = '{"role":"user","content":"hi"}\n{"role":"assistant","usage":{"input_tokens":5,"output_tokens":3}}\n';
    const tmp = writeTmp(content);
    try {
      const result = extractFirstAssistantModel(tmp);
      assert.equal(result, null);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
});
