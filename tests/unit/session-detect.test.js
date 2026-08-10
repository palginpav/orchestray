#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/session-detect.js
 *
 * v2.3.25: session-detect.js switched from transcript-content inference to
 * an explicit session-start marker written by the SessionStart hook. Covers:
 *
 *   A. writeSessionStartMarker + detectSessionStartMs round-trip
 *   B. detectSessionStartMs returns the marker's timestamp for a matching
 *      session_id
 *   C. no marker for this session_id → null (fallback policy)
 *   D. marker for a DIFFERENT session_id is not used → null
 *   E. malformed/corrupt marker file → null, never throws
 *   F. malformed sessionId (non-string, empty, bad chars) → null
 *   G. path traversal attempt in sessionId → null safely
 *   H. relative / empty / null projectDir → null
 *   I. writeSessionStartMarker fails open on invalid inputs (no-op, no throw)
 *   J. writeSessionStartMarker prunes entries older than the TTL
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const {
  detectSessionStartMs,
  writeSessionStartMarker,
} = require('../../bin/_lib/session-detect.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-session-detect-'));
}

function markerFilePath(projectDir) {
  return path.join(projectDir, '.orchestray', 'state', 'session-start-markers.json');
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// ---------------------------------------------------------------------------
// A–B. Round-trip: write then detect
// ---------------------------------------------------------------------------
describe('writeSessionStartMarker + detectSessionStartMs — round trip', () => {
  test('detectSessionStartMs returns the marker time for a matching session_id', () => {
    const dir = makeProjectDir();
    const sessionId = 'aabbccdd-1122-3344-5566-7788aabbccdd';
    try {
      const before = Date.now();
      writeSessionStartMarker(dir, sessionId);
      const after = Date.now();

      const result = detectSessionStartMs(sessionId, dir);
      assert.ok(typeof result === 'number', 'result should be a number');
      assert.ok(result >= before && result <= after, 'result should be within the write window');
    } finally {
      cleanupDir(dir);
    }
  });

  test('marker file is written under .orchestray/state/session-start-markers.json', () => {
    const dir = makeProjectDir();
    const sessionId = 'aabbccdd-1122-3344-5566-7788aabbccde';
    try {
      writeSessionStartMarker(dir, sessionId);
      assert.ok(fs.existsSync(markerFilePath(dir)), 'marker file should exist');
      const parsed = JSON.parse(fs.readFileSync(markerFilePath(dir), 'utf8'));
      assert.equal(parsed.schema_version, 1);
      assert.ok(parsed.sessions[sessionId], 'entry for the session should be present');
      assert.equal(typeof parsed.sessions[sessionId].started_at_ms, 'number');
      assert.equal(typeof parsed.sessions[sessionId].started_at, 'string');
    } finally {
      cleanupDir(dir);
    }
  });

  test('writing a second session preserves the first session\'s entry', () => {
    const dir = makeProjectDir();
    const sessionA = 'aaaaaaaa-1111-1111-1111-111111111111';
    const sessionB = 'bbbbbbbb-2222-2222-2222-222222222222';
    try {
      writeSessionStartMarker(dir, sessionA);
      const startA = detectSessionStartMs(sessionA, dir);
      writeSessionStartMarker(dir, sessionB);

      assert.equal(detectSessionStartMs(sessionA, dir), startA, 'session A entry should be unchanged');
      assert.ok(typeof detectSessionStartMs(sessionB, dir) === 'number', 'session B entry should exist');
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// C. No marker for this session — null (fallback policy)
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — no marker present', () => {
  test('returns null when the marker file does not exist at all', () => {
    const dir = makeProjectDir();
    const sessionId = 'deadbeef-dead-beef-dead-beefdeadbeef';
    try {
      const result = detectSessionStartMs(sessionId, dir);
      assert.strictEqual(result, null);
    } finally {
      cleanupDir(dir);
    }
  });

  test('returns null when the marker file exists but has no entry for this session_id', () => {
    const dir = makeProjectDir();
    const otherSession = 'aaaaaaaa-0000-0000-0000-000000000000';
    const missingSession = 'bbbbbbbb-0000-0000-0000-000000000000';
    try {
      writeSessionStartMarker(dir, otherSession);
      const result = detectSessionStartMs(missingSession, dir);
      assert.strictEqual(result, null);
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// D. Marker for a DIFFERENT session_id is not used
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — session isolation', () => {
  test('a marker written for session A is never returned for session B', () => {
    const dir = makeProjectDir();
    const sessionA = 'cccccccc-1111-1111-1111-111111111111';
    const sessionB = 'dddddddd-2222-2222-2222-222222222222';
    try {
      writeSessionStartMarker(dir, sessionA);
      assert.strictEqual(detectSessionStartMs(sessionB, dir), null);
      assert.ok(typeof detectSessionStartMs(sessionA, dir) === 'number');
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// E. Malformed/corrupt marker file — null, never throws
// ---------------------------------------------------------------------------
describe('detectSessionStartMs — corrupt marker file', () => {
  test('invalid JSON → null, no throw', () => {
    const dir = makeProjectDir();
    const sessionId = 'eeeeeeee-1111-1111-1111-111111111111';
    try {
      fs.mkdirSync(path.dirname(markerFilePath(dir)), { recursive: true });
      fs.writeFileSync(markerFilePath(dir), 'not valid json {{{', 'utf8');
      assert.doesNotThrow(() => detectSessionStartMs(sessionId, dir));
      assert.strictEqual(detectSessionStartMs(sessionId, dir), null);
    } finally {
      cleanupDir(dir);
    }
  });

  test('wrong schema_version → null', () => {
    const dir = makeProjectDir();
    const sessionId = 'eeeeeeee-2222-2222-2222-222222222222';
    try {
      fs.mkdirSync(path.dirname(markerFilePath(dir)), { recursive: true });
      fs.writeFileSync(markerFilePath(dir), JSON.stringify({
        schema_version: 999,
        sessions: { [sessionId]: { started_at_ms: Date.now() } },
      }), 'utf8');
      assert.strictEqual(detectSessionStartMs(sessionId, dir), null);
    } finally {
      cleanupDir(dir);
    }
  });

  test('entry with non-numeric started_at_ms → null', () => {
    const dir = makeProjectDir();
    const sessionId = 'eeeeeeee-3333-3333-3333-333333333333';
    try {
      fs.mkdirSync(path.dirname(markerFilePath(dir)), { recursive: true });
      fs.writeFileSync(markerFilePath(dir), JSON.stringify({
        schema_version: 1,
        sessions: { [sessionId]: { started_at_ms: 'not-a-number' } },
      }), 'utf8');
      assert.strictEqual(detectSessionStartMs(sessionId, dir), null);
    } finally {
      cleanupDir(dir);
    }
  });

  test('writeSessionStartMarker recovers from a corrupt file by starting fresh', () => {
    const dir = makeProjectDir();
    const sessionId = 'eeeeeeee-4444-4444-4444-444444444444';
    try {
      fs.mkdirSync(path.dirname(markerFilePath(dir)), { recursive: true });
      fs.writeFileSync(markerFilePath(dir), 'garbage', 'utf8');
      assert.doesNotThrow(() => writeSessionStartMarker(dir, sessionId));
      assert.ok(typeof detectSessionStartMs(sessionId, dir) === 'number');
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// F. Malformed sessionId — always null, never throws
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
// G. Path traversal in sessionId — returns null safely, no fs access
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
// H. Relative / empty / null projectDir → null (rejected before any fs call)
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
// I. writeSessionStartMarker fails open on invalid inputs
// ---------------------------------------------------------------------------
describe('writeSessionStartMarker — fails open on invalid inputs', () => {
  test('relative projectDir → no-op, no throw', () => {
    assert.doesNotThrow(() => writeSessionStartMarker('relative/path', 'aabbccdd-1122-3344-5566-7788aabbccdd'));
  });

  test('empty projectDir → no-op, no throw', () => {
    assert.doesNotThrow(() => writeSessionStartMarker('', 'aabbccdd-1122-3344-5566-7788aabbccdd'));
  });

  test('null projectDir → no-op, no throw', () => {
    assert.doesNotThrow(() => writeSessionStartMarker(null, 'aabbccdd-1122-3344-5566-7788aabbccdd'));
  });

  test('malformed sessionId → no-op, no throw, no file created', () => {
    const dir = makeProjectDir();
    try {
      writeSessionStartMarker(dir, '../etc/passwd');
      assert.ok(!fs.existsSync(markerFilePath(dir)), 'no marker file should be created for a rejected session_id');
    } finally {
      cleanupDir(dir);
    }
  });

  test('null sessionId → no-op, no throw', () => {
    const dir = makeProjectDir();
    try {
      assert.doesNotThrow(() => writeSessionStartMarker(dir, null));
      assert.ok(!fs.existsSync(markerFilePath(dir)));
    } finally {
      cleanupDir(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// J. writeSessionStartMarker prunes stale entries
// ---------------------------------------------------------------------------
describe('writeSessionStartMarker — pruning', () => {
  test('an entry older than the TTL is dropped on the next write', () => {
    const dir = makeProjectDir();
    const staleSession = 'ffffffff-1111-1111-1111-111111111111';
    const freshSession  = 'ffffffff-2222-2222-2222-222222222222';
    try {
      fs.mkdirSync(path.dirname(markerFilePath(dir)), { recursive: true });
      const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
      fs.writeFileSync(markerFilePath(dir), JSON.stringify({
        schema_version: 1,
        sessions: {
          [staleSession]: {
            started_at_ms: Date.now() - THIRTY_ONE_DAYS_MS,
            started_at: new Date(Date.now() - THIRTY_ONE_DAYS_MS).toISOString(),
          },
        },
      }), 'utf8');

      writeSessionStartMarker(dir, freshSession);

      const parsed = JSON.parse(fs.readFileSync(markerFilePath(dir), 'utf8'));
      assert.ok(!(staleSession in parsed.sessions), 'stale entry should have been pruned');
      assert.ok(freshSession in parsed.sessions, 'fresh entry should be present');
    } finally {
      cleanupDir(dir);
    }
  });

  test('an entry within the TTL survives the next write', () => {
    const dir = makeProjectDir();
    const recentSession = 'ffffffff-3333-3333-3333-333333333333';
    const freshSession   = 'ffffffff-4444-4444-4444-444444444444';
    try {
      writeSessionStartMarker(dir, recentSession);
      writeSessionStartMarker(dir, freshSession);

      assert.ok(typeof detectSessionStartMs(recentSession, dir) === 'number', 'recent entry should survive');
      assert.ok(typeof detectSessionStartMs(freshSession, dir) === 'number');
    } finally {
      cleanupDir(dir);
    }
  });
});
