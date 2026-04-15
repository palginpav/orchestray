#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook — prefix-drift detection for agents/pm.md Block A.
 *
 * Reads agents/pm.md up to the ORCHESTRAY_BLOCK_A_END sentinel, SHA-256 hashes
 * the slice (truncated to hex16), and compares against the stored hash in
 * .orchestray/state/.block-a-hash. On mismatch, emits a `prefix_drift` event
 * to .orchestray/audit/events.jsonl with old_hash, new_hash, timestamp, and
 * orchestration_id (if active).
 *
 * CRITICAL: additionalContext is NEVER emitted — this hook is diagnostic only
 * and must not mutate the prefix it guards (design §5.2 R3).
 *
 * Design spec: v2017-design.md §5 / §9 G2 T10.
 * Honest framing: caller-side cache_control is ignored by Claude Code (OQ-1
 * result). This hook is prefix-stability hygiene, NOT a cost-saving mechanism.
 *
 * Fail-open contract: any error → stderr log → exit 0 with empty {}.
 * Guard: respects `v2017_experiments.prompt_caching === 'on'` via isExperimentActive.
 *        If flag is off, hook does nothing (empty {}, no hash ops).
 *
 * Performance target: ≤ 3 ms on happy path (design §5.2).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd }          = require('./_lib/resolve-project-cwd');
const { loadV2017ExperimentsConfig, isExperimentActive } = require('./_lib/config-schema');
const { atomicAppendJsonl }       = require('./_lib/atomic-append');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }         = require('./_lib/constants');

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sentinel comment that marks the end of Block A in agents/pm.md. */
const BLOCK_A_SENTINEL = '<!-- ORCHESTRAY_BLOCK_A_END -->';

/** Path to the persisted Block A hash, relative to project root. */
const BLOCK_A_HASH_FILE = path.join('.orchestray', 'state', '.block-a-hash');

/** Empty output returned on both happy and drift paths — hook is diagnostic only. */
const EMPTY_OUTPUT = JSON.stringify({}) + '\n';

// ── Self-test ─────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 of `text`, return the first 16 hex chars.
 * @param {string} text
 * @returns {string} 16-char hex string
 */
function hashHex16(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Extract the Block A prefix from pm.md content.
 * Returns the content up to (and including) the sentinel line.
 * If the sentinel is absent, returns null (no-op / not-yet-migrated).
 *
 * @param {string} content - Full contents of agents/pm.md.
 * @returns {string|null}
 */
function extractBlockA(content) {
  const idx = content.indexOf(BLOCK_A_SENTINEL);
  if (idx === -1) return null;
  // Include the sentinel itself so any sentinel-line change is caught.
  return content.slice(0, idx + BLOCK_A_SENTINEL.length);
}

/**
 * Read the stored block-a hash from disk (best-effort).
 * @param {string} hashFilePath - Absolute path to .block-a-hash.
 * @returns {string|null} Stored hex16 hash, or null if absent/unreadable.
 */
function readStoredHash(hashFilePath) {
  try {
    return fs.readFileSync(hashFilePath, 'utf8').trim() || null;
  } catch (_e) {
    return null;
  }
}

/**
 * Persist the new hash atomically (write to tmp then rename).
 * @param {string} hashFilePath
 * @param {string} hex16
 */
function writeHash(hashFilePath, hex16) {
  fs.mkdirSync(path.dirname(hashFilePath), { recursive: true });
  const tmp = hashFilePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, hex16 + '\n', 'utf8');
  fs.renameSync(tmp, hashFilePath);
}

/**
 * Resolve orchestration_id from current-orchestration.json (best-effort).
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return data.orchestration_id || null;
  } catch (_e) {
    return null;
  }
}

// ── Self-test implementation ──────────────────────────────────────────────────
function runSelfTest() {
  // Verify hashHex16 produces consistent 16-char hex output.
  const h1 = hashHex16('hello world');
  const h2 = hashHex16('hello world');
  const h3 = hashHex16('different');
  if (h1.length !== 16) throw new Error('hashHex16: expected 16 chars, got ' + h1.length);
  if (h1 !== h2)        throw new Error('hashHex16: same input produced different hashes');
  if (h1 === h3)        throw new Error('hashHex16: different input produced same hash');

  // Verify sentinel extraction.
  const withSentinel    = 'line1\nline2\n' + BLOCK_A_SENTINEL + '\nblock-b content';
  const withoutSentinel = 'line1\nline2\nno sentinel here';
  const extracted = extractBlockA(withSentinel);
  if (extracted === null) throw new Error('extractBlockA: should find sentinel');
  if (!extracted.endsWith(BLOCK_A_SENTINEL)) throw new Error('extractBlockA: prefix should end with sentinel');
  if (extracted.includes('block-b content')) throw new Error('extractBlockA: should not include post-sentinel content');
  if (extractBlockA(withoutSentinel) !== null) throw new Error('extractBlockA: should return null when no sentinel');

  process.stdout.write('[cache-prefix-lock] self-test PASS\n');
}

// ── Main hook ─────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(EMPTY_OUTPUT);
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] cache-prefix-lock: stdin exceeded limit; aborting\n');
    process.stdout.write(EMPTY_OUTPUT);
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    const cwd   = resolveSafeCwd(event.cwd);

    // Guard: experiment flag must be 'on' to enable hash operations.
    const expCfg = loadV2017ExperimentsConfig(cwd);
    // isExperimentActive expects { v2017_experiments: <block> }
    if (!isExperimentActive({ v2017_experiments: expCfg }, 'prompt_caching')) {
      process.stdout.write(EMPTY_OUTPUT);
      process.exit(0);
    }

    // Read agents/pm.md.
    const pmPath = path.join(cwd, 'agents', 'pm.md');
    let pmContent;
    try {
      pmContent = fs.readFileSync(pmPath, 'utf8');
    } catch (_e) {
      // File missing or unreadable — no-op, fail-open.
      process.stdout.write(EMPTY_OUTPUT);
      process.exit(0);
    }

    // Extract Block A prefix.
    const blockA = extractBlockA(pmContent);
    if (blockA === null) {
      // Sentinel not present yet (T9 hasn't run) — happy path, no-op.
      process.stdout.write(EMPTY_OUTPUT);
      process.exit(0);
    }

    const newHash = hashHex16(blockA);
    const hashFilePath = path.join(cwd, BLOCK_A_HASH_FILE);
    const oldHash = readStoredHash(hashFilePath);

    if (oldHash === null) {
      // First run — seed the hash and exit silently.
      writeHash(hashFilePath, newHash);
      process.stdout.write(EMPTY_OUTPUT);
      process.exit(0);
    }

    if (oldHash === newHash) {
      // Happy path — prefix is stable, ≤ 3 ms target met.
      process.stdout.write(EMPTY_OUTPUT);
      process.exit(0);
    }

    // Drift detected — update stored hash and emit audit event.
    // Do NOT emit additionalContext — diagnostic only (design §5.2 R3).
    try { writeHash(hashFilePath, newHash); } catch (_e) { /* fail-open on write */ }

    const orchestrationId = resolveOrchestrationId(cwd);
    const driftEvent = {
      event_type:        'prefix_drift',
      schema_version:    1,
      timestamp:         new Date().toISOString(),
      old_hash:          oldHash,
      new_hash:          newHash,
      orchestration_id:  orchestrationId,
    };

    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    try {
      atomicAppendJsonl(eventsPath, driftEvent);
    } catch (_e) {
      process.stderr.write('[orchestray] cache-prefix-lock: failed to write drift event: ' + String(_e) + '\n');
    }

    process.stderr.write(
      '[orchestray] cache-prefix-lock: Block A prefix drift detected. ' +
      'old=' + oldHash + ' new=' + newHash + '\n'
    );

  } catch (err) {
    // Fail-open: never block UserPromptSubmit on hook error.
    process.stderr.write('[orchestray] cache-prefix-lock: error (fail-open): ' + String(err) + '\n');
  }

  // Both happy path and drift path emit empty {} — no additionalContext.
  process.stdout.write(EMPTY_OUTPUT);
  process.exit(0);
});
