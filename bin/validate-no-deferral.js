#!/usr/bin/env node
'use strict';

/**
 * validate-no-deferral.js — SubagentStop hook.
 *
 * v2.1.9 Bundle B1 / Intervention I-13b (release-phase no-deferral gate).
 *
 * Activates ONLY during release-phase orchestrations. Scans the agent's last
 * stdout / transcript tail for forbidden deferral phrases. Exit 2 (block) on
 * match; exit 0 otherwise.
 *
 * Release-phase detection:
 *   1. .orchestray/state/orchestration.md frontmatter contains `phase: release`
 *      or `task_flags: [ ..., "release" ]`, OR
 *   2. The current task description (from orchestration state) contains
 *      "release" (case-insensitive) OR a version-bump pattern (e.g. "v2.1.9").
 *
 * Forbidden phrases (case-insensitive match on first 100 KB of output):
 *   - "deferred to"
 *   - "will fix in"
 *   - "out of scope (deferrable)"
 *   - "punt"
 *   - "for now"
 *   - "TODO for later"
 *
 * "punt" and "for now" are the noisiest — we only trigger when they appear
 * in a release-tagged orch AND are adjacent to a ship / release / next / v2.
 * cue within 40 chars, to keep the false-positive rate low.
 *
 * Contract:
 *   - never block outside release phase
 *   - never block on internal error (fail-open with degraded-journal)
 *   - emit `no_deferral_block` audit event on match with the exact phrase + context
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');

// Outputs bigger than this are sliced down from the tail to keep the hook fast.
const MAX_SCAN_BYTES = 100 * 1024; // 100 KB

/**
 * Deferral phrases. Order matters for matching priority (more specific first).
 *
 * `strict: true` phrases match outright in release context.
 * `strict: false` phrases require a nearby release-cue within CONTEXT_WINDOW chars.
 */
const DEFERRAL_PATTERNS = [
  { phrase: 'deferred to',                      strict: true },
  { phrase: 'will fix in',                      strict: true },
  { phrase: 'out of scope (deferrable)',        strict: true },
  { phrase: 'out of scope \u2014 deferrable',   strict: true }, // em-dash variant
  { phrase: 'TODO for later',                   strict: true },
  { phrase: 'punt',                             strict: false },
  { phrase: 'for now',                          strict: false },
];

const RELEASE_CUES = /(release|ship|next\s+(release|version|v\d)|v\d+\.\d+\.\d+)/i;
const CONTEXT_WINDOW = 40;

/**
 * Determine whether the current orchestration is in release phase.
 *
 * @param {string} cwd
 * @param {object} event   Raw hook payload (may contain task_flags).
 * @returns {boolean}
 */
function isReleasePhase(cwd, event) {
  // Explicit flag on the hook payload (PM passes task_flags when spawning
  // release-manager).
  if (event && Array.isArray(event.task_flags) && event.task_flags.includes('release')) {
    return true;
  }
  if (event && typeof event.task_description === 'string' && /release/i.test(event.task_description)) {
    return true;
  }

  try {
    const orchPath = path.join(cwd, '.orchestray', 'state', 'orchestration.md');
    const content = fs.readFileSync(orchPath, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      if (/^\s*phase\s*:\s*['"]?release['"]?\s*$/mi.test(fm)) return true;
      if (/task_flags\s*:\s*\[[^\]]*['"]release['"]/mi.test(fm)) return true;
      // Version-bump pattern in the task title or topic line.
      if (/^\s*(title|topic|task)\s*:.*\bv?\d+\.\d+\.\d+\b/mi.test(fm)) return true;
      if (/^\s*(title|topic|task)\s*:.*\brelease\b/mi.test(fm)) return true;
    }
  } catch (_) {
    // No orchestration file or unreadable — not a release by default.
  }
  return false;
}

/**
 * Return the stdout-like text from the hook payload: either `output`, the
 * last 100 KB of the `transcript_path` file, or the raw `prompt` field.
 *
 * @param {object} event
 * @returns {string}
 */
function collectOutput(event) {
  if (!event) return '';
  if (typeof event.output === 'string' && event.output.length > 0) {
    return event.output.slice(-MAX_SCAN_BYTES);
  }
  if (typeof event.result === 'string' && event.result.length > 0) {
    return event.result.slice(-MAX_SCAN_BYTES);
  }
  if (typeof event.transcript_path === 'string' && event.transcript_path.length > 0) {
    try {
      const stat = fs.statSync(event.transcript_path);
      const size = stat.size;
      if (size <= MAX_SCAN_BYTES) {
        return fs.readFileSync(event.transcript_path, 'utf8');
      }
      const fd = fs.openSync(event.transcript_path, 'r');
      try {
        const buf = Buffer.alloc(MAX_SCAN_BYTES);
        const read = fs.readSync(fd, buf, 0, MAX_SCAN_BYTES, size - MAX_SCAN_BYTES);
        return buf.slice(0, read).toString('utf8');
      } finally {
        try { fs.closeSync(fd); } catch (_) { /* ignore */ }
      }
    } catch (_) {
      return '';
    }
  }
  return '';
}

/**
 * Search output for any DEFERRAL_PATTERNS phrase.
 *
 * @param {string} output
 * @returns {{ matched: boolean, phrase?: string, context?: string, strict?: boolean }}
 */
function findDeferral(output) {
  if (typeof output !== 'string' || output.length === 0) {
    return { matched: false };
  }
  const lower = output.toLowerCase();
  for (const pat of DEFERRAL_PATTERNS) {
    const idx = lower.indexOf(pat.phrase.toLowerCase());
    if (idx === -1) continue;

    const start = Math.max(0, idx - CONTEXT_WINDOW);
    const end = Math.min(output.length, idx + pat.phrase.length + CONTEXT_WINDOW);
    const context = output.slice(start, end).replace(/\s+/g, ' ').slice(0, 200);

    if (pat.strict) {
      return { matched: true, phrase: pat.phrase, context, strict: true };
    }
    // Non-strict: require a release-cue in the context window.
    if (RELEASE_CUES.test(context)) {
      return { matched: true, phrase: pat.phrase, context, strict: false };
    }
  }
  return { matched: false };
}

function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), record);
  } catch (err) {
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'validate-no-deferral', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) { /* last resort */ }
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[orchestray] validate-no-deferral: stdin exceeded cap; fail-open\n');
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    let cwd;
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
      cwd = resolveSafeCwd(event.cwd);
    } catch (err) {
      // Malformed payload — fail-open.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    try {
      if (!isReleasePhase(cwd, event)) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const output = collectOutput(event);
      const match = findDeferral(output);
      if (!match.matched) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: 'no_deferral_block',
        hook: 'validate-no-deferral',
        phrase: match.phrase,
        context: match.context,
        strict: !!match.strict,
        session_id: event.session_id || null,
      });

      process.stderr.write(
        'Release-phase agent output rejected: contains deferral language ' +
        '("' + match.phrase + '"). All findings must be addressed in the current release.\n' +
        'Context: ' + match.context + '\n'
      );
      process.stdout.write(JSON.stringify({ continue: false, reason: 'release-phase deferral language' }));
      process.exit(2);
    } catch (err) {
      // Fail-open on any unexpected error.
      try {
        recordDegradation({
          kind: 'unknown_kind',
          severity: 'warn',
          projectRoot: cwd || process.cwd(),
          detail: { hook: 'validate-no-deferral', err: String(err && err.message || err).slice(0, 80) },
        });
      } catch (_) { /* last resort */ }
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
}

module.exports = {
  DEFERRAL_PATTERNS,
  isReleasePhase,
  findDeferral,
  collectOutput,
  MAX_SCAN_BYTES,
};

if (require.main === module) {
  main();
}
