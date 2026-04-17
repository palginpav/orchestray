#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/session-detect.js
 *
 * Covers:
 *   A. file exists   → returns mtimeMs (a positive number)
 *   B. file missing  → returns null
 *   C. malformed sessionId (non-string, empty, bad chars) → returns null
 *   D. path traversal attempt in sessionId  → returns null safely
 *   E. relative projectDir → returns null
 *   F. empty projectDir   → returns null
 *   G. encodeCwd helper   → correct encoding of absolute paths
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const {
  detectSessionStartMs,
  encodeCwd,
} = require('../../bin/_lib/session-detect.js');

// ---------------------------------------------------------------------------
// Helper: build a fake transcript tree and return the encoded project dir.
// ---------------------------------------------------------------------------
function makeFakeTranscript(sessionId, projectDir) {
  const encoded = encodeCwd(projectDir);
  const transcriptDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  const transcriptFile = path.join(transcriptDir, sessionId + '.jsonl');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(transcriptFile, '{"type":"ping"}\n', 'utf8');
  return { transcriptFile, transcriptDir };
}

// ---------------------------------------------------------------------------
// A. File exists — detectSessionStartMs returns a positive number (mtimeMs)
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — file exists', () => {
  test('returns mtimeMs when transcript JSONL is present', () => {
    const sessionId  = 'aabbccdd-1122-3344-5566-7788aabbccdd';
    // Use a unique temp project dir so tests don't interfere with each other.
    const projectDir = '/home/palgin/orchestray-test-session-detect-a';

    const { transcriptFile, transcriptDir } = makeFakeTranscript(sessionId, projectDir);
    try {
      const result = detectSessionStartMs(sessionId, projectDir);
      assert.ok(typeof result === 'number', 'result should be a number');
      assert.ok(result > 0, 'result should be a positive mtime');
      // Sanity: should be close to the actual mtime of the file we just wrote.
      const stat = fs.statSync(transcriptFile);
      assert.strictEqual(result, stat.mtimeMs);
    } finally {
      try { fs.rmSync(transcriptDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ---------------------------------------------------------------------------
// B. File missing — detectSessionStartMs returns null
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — file missing', () => {
  test('returns null when transcript JSONL does not exist', () => {
    const sessionId  = 'deadbeef-dead-beef-dead-beefdeadbeef';
    // Use a project dir whose encoded transcript directory does not exist.
    const projectDir = '/home/palgin/orchestray-test-session-detect-b-nonexistent';

    const result = detectSessionStartMs(sessionId, projectDir);
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// C. Malformed sessionId — always null, never throws
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — malformed sessionId', () => {
  const projectDir = '/home/palgin/orchestray';

  test('null sessionId → null', () => {
    assert.strictEqual(detectSessionStartMs(null, projectDir), null);
  });

  test('undefined sessionId → null', () => {
    assert.strictEqual(detectSessionStartMs(undefined, projectDir), null);
  });

  test('numeric sessionId → null', () => {
    assert.strictEqual(detectSessionStartMs(42, projectDir), null);
  });

  test('empty string sessionId → null', () => {
    assert.strictEqual(detectSessionStartMs('', projectDir), null);
  });

  test('sessionId with space → null', () => {
    assert.strictEqual(detectSessionStartMs('aabb ccdd', projectDir), null);
  });

  test('sessionId with uppercase letters beyond hex → null', () => {
    // 'G' is not a hex character but SESSION_ID_RE uses /i flag for [0-9a-f],
    // so 'G' should fail the regex.
    assert.strictEqual(detectSessionStartMs('GGGGGGGG-GGGG-GGGG-GGGG-GGGGGGGGGGGG', projectDir), null);
  });
});

// ---------------------------------------------------------------------------
// D. Path traversal in sessionId — returns null safely, no fs access
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — path traversal in sessionId', () => {
  const projectDir = '/home/palgin/orchestray';

  test('../etc/passwd traversal attempt → null', () => {
    assert.strictEqual(detectSessionStartMs('../etc/passwd', projectDir), null);
  });

  test('sessionId with slash → null', () => {
    assert.strictEqual(detectSessionStartMs('aabb/ccdd', projectDir), null);
  });

  test('sessionId with backslash → null', () => {
    assert.strictEqual(detectSessionStartMs('aabb\\ccdd', projectDir), null);
  });
});

// ---------------------------------------------------------------------------
// E. Relative projectDir → null (rejected before any fs call)
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — invalid projectDir', () => {
  const validSession = 'aabbccdd-1122-3344-5566-7788aabbccdd';

  test('relative projectDir → null', () => {
    assert.strictEqual(detectSessionStartMs(validSession, 'relative/path'), null);
  });

  test('empty projectDir → null', () => {
    assert.strictEqual(detectSessionStartMs(validSession, ''), null);
  });

  test('null projectDir → null', () => {
    assert.strictEqual(detectSessionStartMs(validSession, null), null);
  });
});

// ---------------------------------------------------------------------------
// F–G. encodeCwd helper
// ---------------------------------------------------------------------------
describe('encodeCwd', () => {
  test('encodes root-level directory', () => {
    assert.strictEqual(encodeCwd('/home'), '-home');
  });

  test('encodes nested path', () => {
    assert.strictEqual(encodeCwd('/home/palgin/orchestray'), '-home-palgin-orchestray');
  });

  test('encodes single root slash', () => {
    assert.strictEqual(encodeCwd('/'), '-');
  });

  test('matches Claude Code transcript directory naming (known real path)', () => {
    // Empirically verified: Claude Code uses this encoding for the project path.
    assert.strictEqual(
      encodeCwd('/home/palgin/orchestray'),
      '-home-palgin-orchestray'
    );
  });
});
