#!/usr/bin/env node
'use strict';

/**
 * v2212-w2b-rename-stage2-deprecation.test.js — W2b v2.2.12
 *
 * Asserts the deprecation-warn surface for pre-rename event types:
 *   1. Emit staging_write_failed → stderr contains deprecation warn once.
 *   2. Emit staging_write_failed again → stderr NOT printed a second time (rate-limit).
 *   3. Emit task_validation_failed → stderr fires (per-type, not global).
 *   4. ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED=1 → no stderr at all.
 *   5. Triple-write still works: original + attempt + result all written.
 */

const { test, describe, before, beforeEach, after, afterEach } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2b-test-'));
  // minimal .orchestray layout so writer can resolve eventsPath
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  return dir;
}

/**
 * Capture process.stderr writes during fn() execution.
 * Returns the string of everything written to stderr.
 */
function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return original(chunk, ...rest);
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

// ---------------------------------------------------------------------------
// Load writer fresh per describe block by clearing require cache
// ---------------------------------------------------------------------------

function freshWriter() {
  // Clear module cache so each describe block gets a fresh module-level Set.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('audit-event-writer')) delete require.cache[key];
  }
  return require('../_lib/audit-event-writer');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W2b deprecation warn — staging_write_failed', () => {
  let writer;
  let tmpDir;
  const eventOpts = () => ({ cwd: tmpDir });

  beforeEach(() => {
    writer  = freshWriter();
    tmpDir  = makeTmpDir();
    writer._testHooks.resetDeprecatedNamesWarned();
    delete process.env.ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED;
  });

  test('first emit prints deprecation warn to stderr', () => {
    const stderr = captureStderr(() => {
      writer.writeEventWithAliases({ type: 'staging_write_failed', version: 1 }, eventOpts());
    });
    assert.ok(
      stderr.includes('[orchestray] event type "staging_write_failed" is deprecated since v2.2.12'),
      'expected deprecation warn in stderr, got: ' + JSON.stringify(stderr)
    );
    assert.ok(
      stderr.includes('staging_write_attempt'),
      'expected attempt alias name in warn message'
    );
    assert.ok(
      stderr.includes('staging_write_result'),
      'expected result alias name in warn message'
    );
  });

  test('second emit does NOT print a second warn (rate-limit)', () => {
    // First emit — should print
    captureStderr(() => {
      writer.writeEventWithAliases({ type: 'staging_write_failed', version: 1 }, eventOpts());
    });

    // Second emit — should be silent
    const stderr2 = captureStderr(() => {
      writer.writeEventWithAliases({ type: 'staging_write_failed', version: 1 }, eventOpts());
    });
    assert.strictEqual(
      stderr2.includes('deprecated since v2.2.12'),
      false,
      'second emit must not repeat the warn'
    );
  });
});

describe('W2b deprecation warn — task_validation_failed (per-type, not global)', () => {
  let writer;
  let tmpDir;
  const eventOpts = () => ({ cwd: tmpDir });

  beforeEach(() => {
    writer = freshWriter();
    tmpDir = makeTmpDir();
    writer._testHooks.resetDeprecatedNamesWarned();
    delete process.env.ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED;
  });

  test('task_validation_failed triggers its own warn after staging_write_failed already fired', () => {
    // Exhaust staging_write_failed warn
    captureStderr(() => {
      writer.writeEventWithAliases({ type: 'staging_write_failed', version: 1 }, eventOpts());
    });

    // task_validation_failed should still fire (different type)
    const stderr = captureStderr(() => {
      writer.writeEventWithAliases({ type: 'task_validation_failed', version: 1 }, eventOpts());
    });
    assert.ok(
      stderr.includes('[orchestray] event type "task_validation_failed" is deprecated since v2.2.12'),
      'expected task_validation_failed warn, got: ' + JSON.stringify(stderr)
    );
    assert.ok(stderr.includes('task_validation_attempt'), 'expected attempt alias in warn');
    assert.ok(stderr.includes('task_validation_result'), 'expected result alias in warn');
  });
});

describe('W2b kill switch — ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED=1', () => {
  let writer;
  let tmpDir;
  const eventOpts = () => ({ cwd: tmpDir });

  beforeEach(() => {
    writer = freshWriter();
    tmpDir = makeTmpDir();
    writer._testHooks.resetDeprecatedNamesWarned();
    process.env.ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED = '1';
  });

  afterEach(() => {
    delete process.env.ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED;
  });

  test('no stderr when kill switch set', () => {
    const stderr = captureStderr(() => {
      writer.writeEventWithAliases({ type: 'staging_write_failed', version: 1 }, eventOpts());
    });
    assert.strictEqual(
      stderr.includes('deprecated'),
      false,
      'kill switch must suppress all deprecation warns'
    );
  });
});

describe('W2b triple-write still works', () => {
  let writer;
  let tmpDir;

  beforeEach(() => {
    writer = freshWriter();
    tmpDir = makeTmpDir();
    writer._testHooks.resetDeprecatedNamesWarned();
    delete process.env.ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED;
    delete process.env.ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED;
  });

  test('staging_write_failed write produces original + attempt + result lines', () => {
    // Determine events.jsonl path (use same resolution logic as writer)
    const eventsDir = path.join(tmpDir, '.orchestray', 'history');
    const eventsPath = path.join(eventsDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '', 'utf8'); // pre-create so writer can append

    captureStderr(() => {
      writer.writeEventWithAliases(
        { type: 'staging_write_failed', version: 1 },
        { cwd: tmpDir, eventsPath }
      );
    });

    const lines = fs.readFileSync(eventsPath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => JSON.parse(l));

    const types = lines.map(l => l.type);
    assert.ok(types.includes('staging_write_failed'), 'original must be present: ' + JSON.stringify(types));
    assert.ok(types.includes('staging_write_attempt'), 'attempt alias must be present: ' + JSON.stringify(types));
    assert.ok(types.includes('staging_write_result'), 'result alias must be present: ' + JSON.stringify(types));
  });
});
