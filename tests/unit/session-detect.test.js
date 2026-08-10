#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/session-detect.js
 *
 * Covers:
 *   A. file exists, first lines lack timestamps → returns the first
 *      timestamped line's time, NOT mtime (v2.3.24 content-based fix)
 *   B. file missing  → returns null
 *   C. malformed sessionId (non-string, empty, bad chars) → returns null
 *   D. path traversal attempt in sessionId  → returns null safely
 *   E. relative projectDir → returns null
 *   F. empty projectDir   → returns null
 *   G. encodeCwd helper   → correct encoding of absolute paths
 *   H. no timestamped line anywhere in the transcript → returns null
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
// Helpers: build fake transcript trees and return the encoded project dir.
// ---------------------------------------------------------------------------

/** A transcript with no timestamped line at all (only session-start preamble). */
function makeUntimestampedTranscript(sessionId, projectDir) {
  const encoded = encodeCwd(projectDir);
  const transcriptDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  const transcriptFile = path.join(transcriptDir, sessionId + '.jsonl');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const lines = [
    { type: 'last-prompt', leafUuid: 'x', sessionId },
    { type: 'agent-setting', agentSetting: 'pm', sessionId },
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'default', sessionId },
  ];
  fs.writeFileSync(transcriptFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return { transcriptFile, transcriptDir };
}

/**
 * A realistic transcript: untimestamped preamble lines (mirroring real
 * Claude Code output — last-prompt, agent-setting, mode, permission-mode)
 * followed by a line carrying `timestamp`. mtime is set far AFTER
 * timestampMs to prove detection reads content, not mtime — the exact
 * v2.3.24 regression.
 */
function makeRealisticTranscript(sessionId, projectDir, timestampMs) {
  const encoded = encodeCwd(projectDir);
  const transcriptDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  const transcriptFile = path.join(transcriptDir, sessionId + '.jsonl');
  fs.mkdirSync(transcriptDir, { recursive: true });
  const lines = [
    { type: 'last-prompt', leafUuid: 'x', sessionId },
    { type: 'agent-setting', agentSetting: 'pm', sessionId },
    { type: 'mode', mode: 'normal', sessionId },
    { type: 'permission-mode', permissionMode: 'default', sessionId },
    { type: 'attachment', timestamp: new Date(timestampMs).toISOString(), sessionId },
  ];
  fs.writeFileSync(transcriptFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  const farFutureSec = (timestampMs + 6 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(transcriptFile, farFutureSec, farFutureSec);
  return { transcriptFile, transcriptDir };
}

// ---------------------------------------------------------------------------
// A. File exists, first lines lack timestamps — returns the first
//    timestamped line's time, not mtime (v2.3.24)
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — file exists, content-based detection', () => {
  test('returns the first timestamped line\'s time when preamble lines lack timestamps', () => {
    const sessionId  = 'aabbccdd-1122-3344-5566-7788aabbccdd';
    // Use a unique temp project dir so tests don't interfere with each other.
    const projectDir = '/home/palgin/orchestray-test-session-detect-a';
    // True session start: 45 minutes ago. mtime (set by the helper) is 6h
    // AFTER this — if detection fell back to mtime, the assertion below fails.
    const trueStartMs = Date.now() - 45 * 60 * 1000;

    const { transcriptFile, transcriptDir } = makeRealisticTranscript(sessionId, projectDir, trueStartMs);
    try {
      const result = detectSessionStartMs(sessionId, projectDir);
      assert.ok(typeof result === 'number', 'result should be a number');
      assert.strictEqual(result, trueStartMs, 'result should equal the embedded timestamp exactly');

      // Sanity: prove mtime really was set far away from the true start, so
      // an mtime-based implementation would have failed this test.
      const stat = fs.statSync(transcriptFile);
      assert.ok(Math.abs(stat.mtimeMs - result) > 5 * 60 * 1000, 'mtime must differ from the detected value by more than 5 minutes');
    } finally {
      try { fs.rmSync(transcriptDir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ---------------------------------------------------------------------------
// H. No timestamped line anywhere in the transcript — returns null
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — no timestamped line anywhere', () => {
  test('returns null when every line lacks a timestamp field', () => {
    const sessionId  = 'aabbccdd-2233-4455-6677-8899aabbccee';
    const projectDir = '/home/palgin/orchestray-test-session-detect-h';

    const { transcriptDir } = makeUntimestampedTranscript(sessionId, projectDir);
    try {
      const result = detectSessionStartMs(sessionId, projectDir);
      assert.strictEqual(result, null);
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
