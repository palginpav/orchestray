#!/usr/bin/env node
'use strict';

/**
 * v2211-w4-1-blockz-synth.test.js — W4-1 synthetic Block-Z event coverage.
 *
 * Exercises three dark Block-Z events via subprocess invocations of
 * compose-block-a.js and direct calls to its exported helpers:
 *
 *   1. `block_z_emit`           — fires when handle() builds Block-Z successfully.
 *   2. `block_z_sentinel_retripped` — fires when violations file has a recent
 *      entry and the inline retrip block runs inside handle().
 *   3. `block_z_drift_unresolved`  — fires when recovery.count reaches 3+ within
 *      the 1-hour window (inline path in handle()).
 *
 * Each test uses an isolated tmpDir so there is no state pollution between runs.
 *
 * Runner: node --test bin/__tests__/v2211-w4-1-blockz-synth.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT     = path.resolve(__dirname, '..', '..');
const COMPOSE_SCRIPT = path.join(REPO_ROOT, 'bin', 'compose-block-a.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal repo skeleton in a tmp directory that lets Block-Z build. */
function makeMinimalRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2211-blkz-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),         { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),         { recursive: true });
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'),       { recursive: true });
  // Minimal stubs for the 4 Block-Z component files.
  fs.writeFileSync(path.join(dir, 'agents', 'pm.md'),                                           '# PM stub\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'),                                                  '# CLAUDE stub\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'handoff-contract.md'),             '# handoff stub\n');
  fs.writeFileSync(path.join(dir, 'agents', 'pm-reference', 'phase-contract.md'),               '# phase stub\n');
  return dir;
}

/** Read events.jsonl in the tmp repo's audit directory. */
function readEvents(dir) {
  const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_e) { return null; } })
    .filter(Boolean);
}

/**
 * Spawn compose-block-a.js as a child process with a synthetic
 * UserPromptSubmit payload for the given cwd.
 */
function runCompose(dir, extraEnv) {
  const payload = JSON.stringify({ cwd: dir });
  const env = Object.assign({}, process.env, {
    // Bypass double-fire guard so repeated calls within same test work.
    ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD: '1',
    // Bypass session dedup on sentinel-probe (prevent stale lock interference).
    ORCHESTRAY_SENTINEL_DEDUP_DISABLED: '1',
    // Use the tmp dir as the project root.
    ORCHESTRAY_CWD: dir,
  }, extraEnv || {});

  return spawnSync('node', [COMPOSE_SCRIPT], {
    input: payload,
    cwd:   REPO_ROOT,
    env,
    encoding: 'utf8',
    timeout:  15_000,
  });
}

/**
 * Write a violation entry to block-a-zone-violations.jsonl.
 * `tsOffsetMs` = how many ms ago the violation was recorded (default: 5 s ago).
 */
function writeViolation(dir, tsOffsetMs) {
  // The inline retrip path in handle() reads the `timestamp` field (not `ts`).
  // Using `timestamp` here ensures both the inline path and checkAndHandleBlockZRetriп
  // (which accepts both `ts` and `timestamp`) can detect the violation.
  const timestamp = new Date(Date.now() - (tsOffsetMs || 5_000)).toISOString();
  const entry = JSON.stringify({
    timestamp,
    actual_hash:   'aabbcc001122',
    expected_hash: 'ddeeff334455',
  });
  const file = path.join(dir, '.orchestray', 'state', 'block-a-zone-violations.jsonl');
  fs.appendFileSync(file, entry + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2211 W4-1 — Block-Z synthetic event coverage', () => {

  // -------------------------------------------------------------------------
  // Test 1: block_z_emit fires when compose-block-a builds Block-Z successfully.
  // -------------------------------------------------------------------------
  test('block_z_emit fires when compose-block-a processes a UserPromptSubmit', () => {
    const dir = makeMinimalRepo();
    try {
      const r = runCompose(dir);

      // compose-block-a always exits 0 (fail-open design).
      assert.equal(r.status, 0,
        'compose-block-a must exit 0 (fail-open). stderr=' + r.stderr);

      const events  = readEvents(dir);
      const emitted = events.filter(e => e.type === 'block_z_emit');
      assert.ok(emitted.length >= 1,
        'Expected at least one block_z_emit event. ' +
        'Got event types: ' + JSON.stringify(events.map(e => e.type)));

      const ev = emitted[0];
      assert.ok(typeof ev.block_z_hash === 'string' && ev.block_z_hash.length === 64,
        'block_z_hash must be a 64-char hex string; got: ' + JSON.stringify(ev.block_z_hash));
      assert.ok(typeof ev.byte_length === 'number' && ev.byte_length > 0,
        'byte_length must be a positive number; got: ' + JSON.stringify(ev.byte_length));
      assert.ok(typeof ev.prefix_token_estimate === 'number',
        'prefix_token_estimate must be a number');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 2: block_z_sentinel_retripped fires when handle() encounters a recent
  // violation entry in block-a-zone-violations.jsonl (inline retrip path).
  // -------------------------------------------------------------------------
  test('block_z_sentinel_retripped fires when handle() sees a recent violations entry', () => {
    const dir = makeMinimalRepo();
    try {
      // Plant a violation that is only 5 seconds old (well within 60-second window).
      writeViolation(dir, 5_000);

      const r = runCompose(dir);
      assert.equal(r.status, 0,
        'compose-block-a must exit 0 even on retrip. stderr=' + r.stderr);

      const events    = readEvents(dir);
      const retripped = events.filter(e => e.type === 'block_z_sentinel_retripped');
      assert.ok(retripped.length >= 1,
        'Expected at least one block_z_sentinel_retripped event. ' +
        'Got event types: ' + JSON.stringify(events.map(e => e.type)));

      const ev = retripped[0];
      assert.ok(typeof ev.recovery_attempts === 'number' && ev.recovery_attempts >= 1,
        'recovery_attempts must be >= 1; got: ' + JSON.stringify(ev.recovery_attempts));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: block_z_drift_unresolved fires when recovery.count reaches >= 3
  // within the 1-hour window (inline path inside handle()).
  // -------------------------------------------------------------------------
  test('block_z_drift_unresolved fires after 3 retrips within the 1-hour window', () => {
    const dir = makeMinimalRepo();
    try {
      // Pre-seed recovery state to count=2 so the next handle() call triggers
      // the escalation threshold (count becomes 3).
      const recoveryPath = path.join(dir, '.orchestray', 'state', 'block-z-recovery.json');
      fs.writeFileSync(recoveryPath, JSON.stringify({
        count:             2,
        first_attempt_ts:  Date.now() - 10_000, // 10 s ago — well within 1 h
        distinct_hashes:   ['hash-a', 'hash-b'],
      }), 'utf8');

      // Plant a recent violation so the inline retrip block activates.
      writeViolation(dir, 5_000);

      const r = runCompose(dir);
      assert.equal(r.status, 0,
        'compose-block-a must exit 0 (fail-open). stderr=' + r.stderr);

      const events     = readEvents(dir);
      const unresolved = events.filter(e => e.type === 'block_z_drift_unresolved');
      assert.ok(unresolved.length >= 1,
        'Expected at least one block_z_drift_unresolved event after count reaches 3. ' +
        'Got event types: ' + JSON.stringify(events.map(e => e.type)));

      const ev = unresolved[0];
      assert.ok(typeof ev.recovery_attempts === 'number' && ev.recovery_attempts >= 3,
        'recovery_attempts must be >= 3; got: ' + JSON.stringify(ev.recovery_attempts));
      assert.ok(Array.isArray(ev.distinct_hashes_seen),
        'distinct_hashes_seen must be an array');

      // Permanent sentinel must be written when drift_unresolved fires.
      const permPath = path.join(dir, '.orchestray', 'state', '.block-a-zone-caching-disabled-permanent');
      assert.ok(fs.existsSync(permPath),
        'permanent sentinel must be created alongside block_z_drift_unresolved');
      const perm = JSON.parse(fs.readFileSync(permPath, 'utf8'));
      assert.equal(perm.quarantined, true,
        'permanent sentinel must have quarantined:true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});
