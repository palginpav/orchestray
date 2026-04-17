#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/cache-prefix-lock.js  (T13 — v2.0.17)
 *
 * Contracts under test:
 *  - prompt_caching flag 'off': no-op, no file writes, empty {} output
 *  - prompt_caching flag 'on', first run: seeds .block-a-hash, exits 0
 *  - flag on, stable prefix: hash matches stored → empty {} output, no drift event
 *  - flag on, drift detected: updates hash, emits prefix_drift event to events.jsonl
 *  - sentinel missing from pm.md: no-op silently
 *  - missing agents/pm.md: fail-open, exit 0
 *  - unwritable metrics dir: fail-open, exit 0
 *  - global_kill_switch true: hook no-ops
 *  - hash is SHA-256 hex16 (length 16, hex chars only)
 *  - --self-test exits 0
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/cache-prefix-lock.js');
const SENTINEL = '<!-- ORCHESTRAY_BLOCK_A_END -->';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-cpl-'));
}

/**
 * Run the hook script with a given event JSON piped to stdin.
 * @param {object} event  - Parsed event (will be JSON.stringify'd as stdin)
 * @param {object} [extraEnv]
 * @returns {{ stdout: string, stderr: string, status: number }}
 */
function run(event, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function runArgs(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input: '',
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/** Parse the hook's stdout as JSON, asserting valid JSON. */
function parseOutput(stdout) {
  return JSON.parse(stdout.trim());
}

/**
 * Write a minimal .orchestray/config.json enabling the prompt_caching flag.
 * @param {string} tmpDir
 * @param {object} [overrides]  - Merged into v2017_experiments
 */
function writeExperimentConfig(tmpDir, overrides = {}) {
  const orchDir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(orchDir, { recursive: true });
  const config = {
    v2017_experiments: {
      prompt_caching: 'on',
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(orchDir, 'config.json'), JSON.stringify(config), 'utf8');
}

/**
 * Write a fake agents/pm.md with a Block A sentinel.
 * @param {string} tmpDir
 * @param {string} [blockAContent]  - Content BEFORE the sentinel
 * @param {boolean} [includeSentinel]  - Whether to include the sentinel at all
 */
function writePmMd(tmpDir, blockAContent = 'block-a content here\n', includeSentinel = true) {
  const agentsDir = path.join(tmpDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const content = includeSentinel
    ? blockAContent + SENTINEL + '\n\nblock-b content here\n'
    : blockAContent;
  fs.writeFileSync(path.join(agentsDir, 'pm.md'), content, 'utf8');
}

/** Return the stored hash string (or null if absent). */
function readStoredHash(tmpDir) {
  const hashFile = path.join(tmpDir, '.orchestray', 'state', '.block-a-hash');
  try {
    return fs.readFileSync(hashFile, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

/** Return all drift events from events.jsonl, or []. */
function readDriftEvents(tmpDir) {
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  try {
    return fs.readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => JSON.parse(l))
      .filter(e => e.event_type === 'prefix_drift');
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// --self-test flag
// ---------------------------------------------------------------------------

describe('--self-test flag', () => {

  test('--self-test exits 0', () => {
    const { status, stdout } = runArgs(['--self-test']);
    assert.equal(status, 0, '--self-test must exit 0');
    assert.ok(stdout.includes('PASS'), '--self-test should print PASS');
  });

});

// ---------------------------------------------------------------------------
// Experiment flag 'off' (default)
// ---------------------------------------------------------------------------

describe('prompt_caching flag off', () => {

  test('exits 0 with empty {} when flag is explicitly off', () => {
    const tmpDir = makeTmpDir();
    try {
      writePmMd(tmpDir);
      // Explicitly write flag=off config (default changed to 'on' in v2.0.23).
      writeExperimentConfig(tmpDir, { prompt_caching: 'off' });
      const { status, stdout } = run({ cwd: tmpDir });
      assert.equal(status, 0);
      assert.deepEqual(parseOutput(stdout), {}, 'output must be empty {}');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not write .block-a-hash when flag is off', () => {
    const tmpDir = makeTmpDir();
    try {
      writePmMd(tmpDir);
      // Explicitly write flag=off config (default changed to 'on' in v2.0.23).
      writeExperimentConfig(tmpDir, { prompt_caching: 'off' });
      run({ cwd: tmpDir });
      assert.equal(readStoredHash(tmpDir), null, '.block-a-hash must not be created when flag is off');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not emit prefix_drift event when flag is off', () => {
    const tmpDir = makeTmpDir();
    try {
      writePmMd(tmpDir);
      // Explicitly write flag=off config (default changed to 'on' in v2.0.23).
      writeExperimentConfig(tmpDir, { prompt_caching: 'off' });
      // Pre-seed a stale hash so drift would be detected if the flag were on
      const stateDir = path.join(tmpDir, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, '.block-a-hash'), 'aaaaaaaabbbbbbbb\n', 'utf8');

      run({ cwd: tmpDir });
      assert.equal(readDriftEvents(tmpDir).length, 0, 'no drift event when flag is off');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// No config.json — default 'on' path (F-TEST-2, v2.0.23)
// ---------------------------------------------------------------------------

describe('prompt_caching flag on — no config.json (falls back to default "on")', () => {

  test('seeds .block-a-hash when no config.json is present (default is now "on")', () => {
    // F-TEST-2: With no .orchestray/config.json, loadV2017ExperimentsConfig returns
    // DEFAULT_V2017_EXPERIMENTS which has prompt_caching: 'on' since v2.0.23.
    // The hook must seed .block-a-hash on first run (not no-op).
    const tmpDir = makeTmpDir();
    try {
      writePmMd(tmpDir, 'some block-a content\n');
      // Intentionally skip writeExperimentConfig — no config.json written

      const { status } = run({ cwd: tmpDir });
      assert.equal(status, 0, 'hook must exit 0 when no config.json is present');

      const hash = readStoredHash(tmpDir);
      assert.ok(hash !== null,
        '.block-a-hash must be seeded when no config.json is present (default is "on")');
      assert.ok(/^[0-9a-f]{16}$/.test(hash),
        'seeded hash must be a 16-char lowercase hex string');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Experiment flag 'on' — first run (no existing hash)
// ---------------------------------------------------------------------------

describe('prompt_caching flag on — first run', () => {

  test('seeds .block-a-hash on first run and exits 0', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'stable content\n');

      const { status, stdout } = run({ cwd: tmpDir });
      assert.equal(status, 0);
      assert.deepEqual(parseOutput(stdout), {}, 'output must be empty {}');

      const hash = readStoredHash(tmpDir);
      assert.ok(hash !== null, '.block-a-hash must be written on first run');
      assert.equal(hash.length, 16, 'stored hash must be exactly 16 chars');
      assert.ok(/^[0-9a-f]{16}$/.test(hash), 'stored hash must be lowercase hex');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not emit drift event on first run', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'first run content\n');

      run({ cwd: tmpDir });
      assert.equal(readDriftEvents(tmpDir).length, 0, 'no drift event on first run (seeding only)');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Experiment flag 'on' — stable prefix
// ---------------------------------------------------------------------------

describe('prompt_caching flag on — stable prefix', () => {

  test('exits 0 with empty {} when hash matches stored', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'stable content\n');

      // First run seeds the hash
      run({ cwd: tmpDir });

      // Second run should see stable prefix
      const { status, stdout } = run({ cwd: tmpDir });
      assert.equal(status, 0);
      assert.deepEqual(parseOutput(stdout), {}, 'stable prefix must emit empty {}');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('does not emit drift event when prefix is stable', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'stable content\n');

      // Seed
      run({ cwd: tmpDir });
      // Stable check
      run({ cwd: tmpDir });

      assert.equal(readDriftEvents(tmpDir).length, 0, 'no drift event when prefix is stable');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Experiment flag 'on' — drift detected
// ---------------------------------------------------------------------------

describe('prompt_caching flag on — drift detected', () => {

  test('updates .block-a-hash when drift is detected', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'original content\n');

      // Seed hash for "original content"
      run({ cwd: tmpDir });
      const originalHash = readStoredHash(tmpDir);
      assert.ok(originalHash, 'seed must have written a hash');

      // Modify Block A
      writePmMd(tmpDir, 'MODIFIED content — this is different\n');

      run({ cwd: tmpDir });
      const updatedHash = readStoredHash(tmpDir);
      assert.ok(updatedHash !== null, 'updated hash must be written after drift');
      assert.notEqual(updatedHash, originalHash, 'updated hash must differ from original');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('emits prefix_drift event to events.jsonl on drift', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'original\n');
      run({ cwd: tmpDir });

      writePmMd(tmpDir, 'modified\n');
      run({ cwd: tmpDir });

      const events = readDriftEvents(tmpDir);
      assert.equal(events.length, 1, 'exactly one prefix_drift event must be emitted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('drift event has correct shape: event_type, old_hash, new_hash, timestamp, schema_version', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'original content\n');
      run({ cwd: tmpDir });
      const originalHash = readStoredHash(tmpDir);

      writePmMd(tmpDir, 'modified content\n');
      run({ cwd: tmpDir });

      const events = readDriftEvents(tmpDir);
      assert.equal(events.length, 1, 'one drift event expected');
      const ev = events[0];

      assert.equal(ev.event_type, 'prefix_drift', 'event_type must be prefix_drift');
      assert.equal(ev.schema_version, 1, 'schema_version must be 1');
      assert.equal(ev.old_hash, originalHash, 'old_hash must match previously stored hash');
      assert.ok(/^[0-9a-f]{16}$/.test(ev.new_hash), 'new_hash must be 16-char hex');
      assert.ok(typeof ev.timestamp === 'string', 'timestamp must be a string');
      assert.ok(!isNaN(Date.parse(ev.timestamp)), 'timestamp must be a valid ISO date');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('drift path still outputs empty {} — no additionalContext emitted', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'original\n');
      run({ cwd: tmpDir });

      writePmMd(tmpDir, 'modified\n');
      const { stdout, status } = run({ cwd: tmpDir });
      assert.equal(status, 0);
      const out = parseOutput(stdout);
      assert.deepEqual(out, {}, 'drift path must emit empty {} with no additionalContext');
      assert.ok(!('additionalContext' in out), 'additionalContext must NOT be present on drift path');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('drift event orchestration_id is null when no orchestration file present', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'a\n');
      run({ cwd: tmpDir });

      writePmMd(tmpDir, 'b\n');
      run({ cwd: tmpDir });

      const events = readDriftEvents(tmpDir);
      assert.equal(events.length, 1);
      assert.equal(events[0].orchestration_id, null, 'orchestration_id should be null when no orchestration file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Sentinel missing from pm.md
// ---------------------------------------------------------------------------

describe('sentinel missing from pm.md', () => {

  test('no-op silently when sentinel is absent: exits 0, empty {}, no hash written', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'no sentinel in this content\n', false /* no sentinel */);

      const { status, stdout } = run({ cwd: tmpDir });
      assert.equal(status, 0);
      assert.deepEqual(parseOutput(stdout), {});
      assert.equal(readStoredHash(tmpDir), null, '.block-a-hash must not be written when sentinel is absent');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Missing agents/pm.md — fail-open
// ---------------------------------------------------------------------------

describe('missing agents/pm.md — fail-open', () => {

  test('exits 0 with empty {} when agents/pm.md is missing', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      // Intentionally do NOT write agents/pm.md

      const { status, stdout } = run({ cwd: tmpDir });
      assert.equal(status, 0, 'must exit 0 on missing pm.md (fail-open)');
      assert.deepEqual(parseOutput(stdout), {});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Unwritable state dir — fail-open
// ---------------------------------------------------------------------------

describe('unwritable state dir — fail-open', () => {

  test('exits 0 when .orchestray/state is not writable', function () {
    // Skip on root — root bypasses filesystem permissions
    if (process.getuid && process.getuid() === 0) {
      this.skip('skipped: running as root, permission test is not meaningful');
      return;
    }

    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'content\n');

      // Create the state dir and make it read-only
      const stateDir = path.join(tmpDir, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.chmodSync(stateDir, 0o555);

      const { status, stdout } = run({ cwd: tmpDir });
      assert.equal(status, 0, 'must exit 0 even when state dir is unwritable (fail-open)');
      assert.deepEqual(parseOutput(stdout), {});
    } finally {
      // Restore permissions before cleanup
      const stateDir = path.join(tmpDir, '.orchestray', 'state');
      try { fs.chmodSync(stateDir, 0o755); } catch (_) {}
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// global_kill_switch
// ---------------------------------------------------------------------------

describe('global_kill_switch: true', () => {

  test('hook no-ops when global_kill_switch is true: no hash written, empty {} output', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir, { global_kill_switch: true });
      writePmMd(tmpDir, 'content\n');

      const { status, stdout } = run({ cwd: tmpDir });
      assert.equal(status, 0);
      assert.deepEqual(parseOutput(stdout), {});
      assert.equal(readStoredHash(tmpDir), null, '.block-a-hash must not be written when kill switch is on');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Hash format validation
// ---------------------------------------------------------------------------

describe('hash format', () => {

  test('stored hash is exactly 16 lowercase hex characters', () => {
    const tmpDir = makeTmpDir();
    try {
      writeExperimentConfig(tmpDir);
      writePmMd(tmpDir, 'some block A content here\n');

      run({ cwd: tmpDir });
      const hash = readStoredHash(tmpDir);
      assert.ok(hash !== null, 'hash file must exist after first run');
      assert.equal(hash.length, 16, 'hash must be exactly 16 characters');
      assert.ok(/^[0-9a-f]+$/.test(hash), 'hash must contain only lowercase hex characters');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('hash is deterministic: two runs with identical content produce identical hash', () => {
    const tmpDir1 = makeTmpDir();
    const tmpDir2 = makeTmpDir();
    try {
      const content = 'deterministic block content\n';

      writeExperimentConfig(tmpDir1);
      writePmMd(tmpDir1, content);
      run({ cwd: tmpDir1 });

      writeExperimentConfig(tmpDir2);
      writePmMd(tmpDir2, content);
      run({ cwd: tmpDir2 });

      const hash1 = readStoredHash(tmpDir1);
      const hash2 = readStoredHash(tmpDir2);
      assert.equal(hash1, hash2, 'identical pm.md content must produce identical hash');
    } finally {
      fs.rmSync(tmpDir1, { recursive: true, force: true });
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });

});
