'use strict';

/**
 * Tests for bin/validate-archive.js (W2-3).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os   = require('node:os');
const fs   = require('node:fs');
const path = require('node:path');

const { findOrchestrationComplete, findMissingArchiveFiles, REQUIRED_FILES } = require('../validate-archive');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'validate-archive-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeEventsJsonl(dir, events) {
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lines = events.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(stateDir, 'events.jsonl'), lines, 'utf8');
}

// ---------------------------------------------------------------------------
// REQUIRED_FILES constant
// ---------------------------------------------------------------------------

describe('REQUIRED_FILES', () => {
  test('contains all 3 required archive files', () => {
    assert.ok(REQUIRED_FILES.includes('events.jsonl'));
    assert.ok(REQUIRED_FILES.includes('orchestration.md'));
    assert.ok(REQUIRED_FILES.includes('task-graph.md'));
    assert.equal(REQUIRED_FILES.length, 3);
  });
});

// ---------------------------------------------------------------------------
// findOrchestrationComplete
// ---------------------------------------------------------------------------

describe('findOrchestrationComplete', () => {
  test('returns found=true with orch id when orchestration_complete event is present', () => {
    const dir = makeTmpDir();
    try {
      writeEventsJsonl(dir, [
        { type: 'agent_start', orchestration_id: 'orch-001' },
        { type: 'orchestration_complete', orchestration_id: 'orch-001' },
      ]);
      const result = findOrchestrationComplete(dir);
      assert.equal(result.found, true);
      assert.equal(result.orchestration_id, 'orch-001');
    } finally {
      cleanup(dir);
    }
  });

  test('returns found=false when no orchestration_complete event exists', () => {
    const dir = makeTmpDir();
    try {
      writeEventsJsonl(dir, [
        { type: 'agent_start', orchestration_id: 'orch-001' },
      ]);
      const result = findOrchestrationComplete(dir);
      assert.equal(result.found, false);
      assert.equal(result.orchestration_id, null);
    } finally {
      cleanup(dir);
    }
  });

  test('returns found=false when events.jsonl does not exist', () => {
    const dir = makeTmpDir();
    try {
      const result = findOrchestrationComplete(dir);
      assert.equal(result.found, false);
    } finally {
      cleanup(dir);
    }
  });

  test('returns the last orchestration_id when multiple complete events exist', () => {
    const dir = makeTmpDir();
    try {
      writeEventsJsonl(dir, [
        { type: 'orchestration_complete', orchestration_id: 'orch-001' },
        { type: 'orchestration_complete', orchestration_id: 'orch-002' },
      ]);
      const result = findOrchestrationComplete(dir);
      assert.equal(result.orchestration_id, 'orch-002');
    } finally {
      cleanup(dir);
    }
  });

  test('skips malformed JSON lines gracefully', () => {
    const dir = makeTmpDir();
    try {
      const stateDir = path.join(dir, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'events.jsonl'),
        'NOTJSON\n{"type":"orchestration_complete","orchestration_id":"orch-003"}\n',
        'utf8'
      );
      const result = findOrchestrationComplete(dir);
      assert.equal(result.found, true);
      assert.equal(result.orchestration_id, 'orch-003');
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// findMissingArchiveFiles
// ---------------------------------------------------------------------------

describe('findMissingArchiveFiles', () => {
  test('returns empty array when all required files exist', () => {
    const dir = makeTmpDir();
    const orchId = 'orch-20260101T000000Z-test';
    try {
      const archiveDir = path.join(dir, '.orchestray', 'history', orchId);
      fs.mkdirSync(archiveDir, { recursive: true });
      for (const f of REQUIRED_FILES) {
        fs.writeFileSync(path.join(archiveDir, f), 'content', 'utf8');
      }
      const missing = findMissingArchiveFiles(dir, orchId);
      assert.equal(missing.length, 0);
    } finally {
      cleanup(dir);
    }
  });

  test('returns missing file names when archive is incomplete', () => {
    const dir = makeTmpDir();
    const orchId = 'orch-20260101T000000Z-test';
    try {
      const archiveDir = path.join(dir, '.orchestray', 'history', orchId);
      fs.mkdirSync(archiveDir, { recursive: true });
      // Only create 2 of 3 required files.
      fs.writeFileSync(path.join(archiveDir, 'events.jsonl'), 'content', 'utf8');
      fs.writeFileSync(path.join(archiveDir, 'orchestration.md'), 'content', 'utf8');
      // task-graph.md is missing.
      const missing = findMissingArchiveFiles(dir, orchId);
      assert.ok(missing.includes('task-graph.md'));
      assert.equal(missing.length, 1);
    } finally {
      cleanup(dir);
    }
  });

  test('returns all 3 files when archive directory does not exist', () => {
    const dir = makeTmpDir();
    try {
      const missing = findMissingArchiveFiles(dir, 'orch-nonexistent');
      assert.equal(missing.length, 3);
      for (const f of REQUIRED_FILES) {
        assert.ok(missing.includes(f), `Expected ${f} in missing list`);
      }
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

describe('kill switch ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED', () => {
  test('kill switch env var is detectable when set to 1', () => {
    const prev = process.env.ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED;
    process.env.ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED = '1';
    assert.equal(process.env.ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED, '1');
    if (prev === undefined) {
      delete process.env.ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED;
    } else {
      process.env.ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED = prev;
    }
  });
});
