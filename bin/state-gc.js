#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

// 2018-W5-UX4b
/**
 * Garbage-collect leaked orchestration state directories.
 *
 * A directory is "leaked" when ALL of the following are true:
 *   1. It lives under `.orchestray/history/` and its name matches `orch-*`.
 *   2. It contains an `events.jsonl` file.
 *   3. That file does NOT contain an `orchestration_complete` event.
 *   4. The latest `timestamp` (or `ts` fallback) in that file is older than
 *      `--keep-days` days ago.
 *
 * Invoked by `skills/orchestray:state/SKILL.md` (gc subcommand).
 *
 * Usage:
 *   node bin/state-gc.js [--dry-run] [--keep-days=<N>] [--mode=archive|discard] [projectDir]
 *
 *   projectDir     - Absolute path to the project root (default: process.cwd()).
 *                    Must be the last positional argument or omitted.
 *   --dry-run      - List leaked dirs without mutating (default when --mode is absent).
 *   --keep-days=N  - Dirs with latest event newer than N days are active (default: 7).
 *   --mode=archive - Rename <dir> to <dir>-abandoned/ (idempotent). Default mutating mode.
 *   --mode=discard - rm -rf <dir>. Requires explicit flag; emits state_gc_discarded audit event.
 *
 * Emits a `state_gc_run` audit event to `.orchestray/audit/events.jsonl` after each run.
 *
 * Exit codes:
 *   0 — always (fail-open).
 *
 * Design contract: 2018-UX4b (W5).
 */

const fs = require('node:fs');
const path = require('node:path');

const { normalizeEvent } = require('./read-event');
const { writeEvent } = require('./_lib/audit-event-writer');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

let dryRunFlag = false;
let keepDays = 7;
let mode = null; // null = dry-run default
let projectDir = null;

for (const arg of args) {
  if (arg === '--dry-run') {
    dryRunFlag = true;
  } else if (arg.startsWith('--keep-days=')) {
    const n = Number(arg.slice('--keep-days='.length));
    if (!isNaN(n) && n >= 0) keepDays = n;
  } else if (arg === '--mode=archive') {
    mode = 'archive';
  } else if (arg === '--mode=discard') {
    mode = 'discard';
  } else if (!arg.startsWith('--')) {
    // First non-flag positional arg is the project dir
    if (projectDir === null) {
      projectDir = arg;
    }
  }
}

if (projectDir === null) projectDir = process.cwd();

// Effective dry-run: explicit --dry-run OR no --mode flag supplied.
const isDryRun = dryRunFlag || mode === null;
// Effective mode for mutating runs:
const effectiveMode = mode || 'archive';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse an `events.jsonl` file and return:
 *   { hasComplete: boolean, latestTimestamp: Date|null }
 *
 * Normalizes: uses `timestamp` field first, falls back to `ts` per the
 * history_scan normaliser pattern (W1 symmetry).
 */
function parseEventsJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return { hasComplete: false, latestTimestamp: null };
  }

  let hasComplete = false;
  let latestMs = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rawObj;
    try {
      rawObj = JSON.parse(trimmed);
    } catch (_e) {
      continue;
    }
    if (!rawObj || typeof rawObj !== 'object') continue;

    // R-EVENT-NAMING (v2.1.13): legacy `event`/`ts` → canonical `type`/`timestamp`.
    const obj = normalizeEvent(rawObj);

    if (obj.type === 'orchestration_complete') {
      hasComplete = true;
    }

    if (typeof obj.timestamp === 'string' && obj.timestamp) {
      const ms = Date.parse(obj.timestamp);
      if (!isNaN(ms) && (latestMs === null || ms > latestMs)) {
        latestMs = ms;
      }
    }
  }

  return {
    hasComplete,
    latestTimestamp: latestMs !== null ? new Date(latestMs) : null,
  };
}

/**
 * Return true if the directory (already confirmed to be an orch-* dir with
 * an events.jsonl) is "leaked":
 *   - No orchestration_complete event
 *   - Latest timestamp is older than keepDays days ago (or no timestamp at all)
 */
function isLeaked(eventsPath, keepDaysMs) {
  const { hasComplete, latestTimestamp } = parseEventsJsonl(eventsPath);
  if (hasComplete) return false;
  if (latestTimestamp === null) {
    // No timestamp at all — treat as leaked (age unknown, conservative).
    return true;
  }
  return (Date.now() - latestTimestamp.getTime()) > keepDaysMs;
}

/**
 * Append an audit event via the central gateway. Best-effort; fail-open.
 */
function appendAuditEvent(obj) {
  try {
    writeEvent(obj, { cwd: projectDir });
  } catch (_e) {
    // Fail-open: audit event loss is acceptable over blocking gc.
  }
}

// ---------------------------------------------------------------------------
// Core scan
// ---------------------------------------------------------------------------

const keepDaysMs = keepDays * 24 * 60 * 60 * 1000;
const historyDir = path.join(projectDir, '.orchestray', 'history');
const auditEventsPath = path.join(projectDir, '.orchestray', 'audit', 'events.jsonl');

let archived = 0;
let discarded = 0;
let skippedActive = 0;
const leakedDirs = [];

if (fs.existsSync(historyDir)) {
  let entries;
  try {
    entries = fs.readdirSync(historyDir, { withFileTypes: true });
  } catch (err) {
    process.stderr.write('[orchestray] state-gc: readdir failed: ' + (err && err.message) + '\n');
    entries = [];
  }

  // Only consider orch-* directories
  const orchDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('orch-'))
    .map((e) => e.name)
    .sort();

  for (const dirName of orchDirs) {
    const dirPath = path.join(historyDir, dirName);
    const eventsPath = path.join(dirPath, 'events.jsonl');

    // Must have an events.jsonl to be scannable
    if (!fs.existsSync(eventsPath)) {
      // No events.jsonl — cannot determine state; skip conservatively.
      skippedActive++;
      continue;
    }

    if (!isLeaked(eventsPath, keepDaysMs)) {
      skippedActive++;
      continue;
    }

    leakedDirs.push({ dirName, dirPath });
  }
}

// ---------------------------------------------------------------------------
// Dry-run output
// ---------------------------------------------------------------------------

if (isDryRun) {
  if (leakedDirs.length === 0) {
    process.stdout.write('[dry-run] no leaked dirs found (keep-days=' + keepDays + ')\n');
  } else {
    process.stdout.write('[dry-run] the following dirs would be gc\'d:\n');
    for (const { dirName } of leakedDirs) {
      process.stdout.write('  ' + dirName + '\n');
    }
  }
  process.stdout.write('archived 0 dirs, discarded 0 dirs, skipped ' + skippedActive + ' active\n');

  appendAuditEvent({
    timestamp: new Date().toISOString(),
    type: 'state_gc_run',
    mode: effectiveMode,
    dry_run: true,
    keep_days: keepDays,
    archived: 0,
    discarded: 0,
    skipped_active: skippedActive,
  });

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Mutating run
// ---------------------------------------------------------------------------

for (const { dirName, dirPath } of leakedDirs) {
  if (effectiveMode === 'archive') {
    // Idempotent: already suffixed dirs stay as-is.
    if (dirName.endsWith('-abandoned')) {
      // Already archived on a previous run — count as archived (idempotent).
      archived++;
      continue;
    }
    const destPath = dirPath + '-abandoned';
    if (fs.existsSync(destPath)) {
      // Destination already exists — skip (idempotent).
      archived++;
      continue;
    }
    try {
      fs.renameSync(dirPath, destPath);
      archived++;
    } catch (err) {
      process.stderr.write('[orchestray] state-gc: archive failed for ' + dirName + ': ' + (err && err.message) + '\n');
    }
  } else if (effectiveMode === 'discard') {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      discarded++;
      // Emit per-directory discard event
      appendAuditEvent({
        timestamp: new Date().toISOString(),
        type: 'state_gc_discarded',
        dir: dirName,
      });
    } catch (err) {
      process.stderr.write('[orchestray] state-gc: discard failed for ' + dirName + ': ' + (err && err.message) + '\n');
    }
  }
}

// ---------------------------------------------------------------------------
// Summary output + summary audit event
// ---------------------------------------------------------------------------

process.stdout.write(
  'archived ' + archived + ' dirs, discarded ' + discarded + ' dirs, skipped ' + skippedActive + ' active\n'
);

appendAuditEvent({
  timestamp: new Date().toISOString(),
  type: 'state_gc_run',
  mode: effectiveMode,
  dry_run: false,
  keep_days: keepDays,
  archived,
  discarded,
  skipped_active: skippedActive,
});

process.exit(0);
