#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59 convention): CLI utility. Also required as a
// library by bin/session-feature-gate.js (SessionStart hook) so the flip
// condition is evaluated — and acted on — every session without a human
// needing to run this by hand.
'use strict';

/**
 * check-ack-fields-readiness.js — mechanical evaluator + auto-flip for the
 * `pattern_evidence.enforce_ack_fields` grace gate documented in
 * bin/validate-task-completion.js (patternAckFieldsEnforced docstring,
 * ~line 747). That comment used to ask a human to eyeball a shell one-liner
 * and flip the config by hand; this script IS that one-liner, run
 * automatically, so the condition is measured and acted on the moment the
 * data supports it instead of waiting on someone to remember.
 *
 * Condition (mirrors the validate-task-completion.js docstring verbatim —
 * do not let these drift; if the threshold changes, change both):
 *   Event:     pattern_ack_captured, in .orchestray/audit/events.jsonl only
 *              (the live log — NOT .orchestray/history/**, which holds
 *              ~3.4x-inflated archived copies).
 *   Metric:    share of the most recent 50 such events (or all available,
 *              if fewer than 50) with ack_source === "structured_fields".
 *   Threshold: ready when >= 50 events exist AND share >= 0.95.
 *
 * Usage:
 *   node bin/check-ack-fields-readiness.js [--cwd path] [--json]
 *
 * Exit codes:
 *   0 = ready (condition met)
 *   1 = not ready (below threshold, or fewer than 50 events)
 *   2 = usage/internal error
 *
 * Auto-flip (maybeAutoFlip, called from bin/session-feature-gate.js on every
 * SessionStart): when the condition is met, sets
 * `pattern_evidence.enforce_ack_fields: true` in .orchestray/config.json,
 * emits a one-time stderr banner, writes a sentinel so the banner (and the
 * flip itself) never re-fire, and records a `pattern_ack_fields_autoflip`
 * audit event. Fail-open throughout — a flip that can't be persisted this
 * session is retried next session (no sentinel is written on partial
 * failure).
 *
 * Kill switches (either one disables the AUTO-FLIP only — the readiness
 * evaluation above still runs and still reports; only the mutating side
 * effect is suppressed):
 *   - process.env.ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED === '1'
 *   - config.pattern_evidence.ack_fields_autoflip_enabled === false
 * Manually forcing the gate itself on/off (independent of readiness) is
 * still `ORCHESTRAY_T15_PATTERN_ACK_FIELDS_ENFORCED=1|0` — unchanged, see
 * bin/validate-task-completion.js.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }             = require('./_lib/resolve-project-cwd');
const { writeEvent }                 = require('./_lib/audit-event-writer');
const { atomicWriteFile, _withAdvisoryLock } = require('./_lib/atomic-append');

const REQUIRED_WINDOW = 50;
const REQUIRED_SHARE  = 0.95;
const EVENTS_REL      = path.join('.orchestray', 'audit', 'events.jsonl');
const SCAN_BYTES      = 5 * 1024 * 1024; // bound the read, mirrors verify-fix-coverage.js tailRead
const SENTINEL_REL    = path.join('.orchestray', 'state', '.ack-fields-autoflip-done');

// ---------------------------------------------------------------------------
// Bounded log read
// ---------------------------------------------------------------------------

function tailRead(filePath, maxBytes) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    const readBytes = Math.min(stat.size, maxBytes);
    const offset = stat.size - readBytes;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(readBytes);
      const bytesRead = fs.readSync(fd, buf, 0, readBytes, offset);
      return buf.slice(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_e) {
    return '';
  }
}

/**
 * Walk the tail content backwards, collecting up to `limit` most-recent
 * pattern_ack_captured events. Stops as soon as `limit` is reached — cheap
 * even on a very large log, since we never scan more than SCAN_BYTES and we
 * stop early once the window is full.
 */
function collectRecentAckEvents(cwd, limit) {
  const content = tailRead(path.join(cwd, EVENTS_REL), SCAN_BYTES);
  if (!content) return [];
  const lines = content.split('\n');
  const collected = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let evt;
    try { evt = JSON.parse(line); } catch (_e) { continue; }
    if (!evt || typeof evt !== 'object') continue;
    if (evt.type !== 'pattern_ack_captured') continue;
    collected.push(evt);
  }
  return collected; // newest-first
}

/**
 * Evaluate the documented condition against the live log.
 * @param {string} cwd
 * @returns {{ready: boolean, total: number, required: number, structured: number, share: number, percent: number}}
 */
function evaluate(cwd) {
  const events = collectRecentAckEvents(cwd, REQUIRED_WINDOW);
  const total = events.length;
  const structured = events.filter((e) => e.ack_source === 'structured_fields').length;
  const share = total > 0 ? structured / total : 0;
  const ready = total >= REQUIRED_WINDOW && share >= REQUIRED_SHARE;
  return {
    ready,
    total,
    required: REQUIRED_WINDOW,
    structured,
    share,
    percent: Math.round(share * 1000) / 10, // one decimal place
  };
}

// ---------------------------------------------------------------------------
// Config helpers (mirrors bin/session-feature-gate.js)
// ---------------------------------------------------------------------------

function readConfig(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_e) {
    return {};
  }
}

function writeConfig(cwd, config) {
  const cfgPath = path.join(cwd, '.orchestray', 'config.json');
  try {
    const outcome = _withAdvisoryLock(cfgPath + '.lock', () => {
      atomicWriteFile(cfgPath, JSON.stringify(config, null, 2) + '\n');
    });
    if (outcome && outcome.skipped) return false;
    return true;
  } catch (_e) {
    return false;
  }
}

function isAlreadyEnforced(config) {
  return !!(config && config.pattern_evidence && config.pattern_evidence.enforce_ack_fields === true);
}

function isAutoFlipDisabled(config) {
  if (process.env.ORCHESTRAY_T15_ACK_FIELDS_AUTOFLIP_DISABLED === '1') return true;
  return !!(config && config.pattern_evidence && config.pattern_evidence.ack_fields_autoflip_enabled === false);
}

function sentinelPresent(cwd) {
  return fs.existsSync(path.join(cwd, SENTINEL_REL));
}

function writeSentinel(cwd) {
  try {
    const p = path.join(cwd, SENTINEL_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, new Date().toISOString() + '\n', 'utf8');
  } catch (_e) { /* fail-open — worst case the flip re-evaluates next session */ }
}

function bannerLines(measured) {
  return [
    '[orchestray] pattern_evidence.enforce_ack_fields flipped from false to true.',
    `[orchestray]   Readiness condition met: ${measured.structured}/${measured.total} of the last ` +
      `${measured.required} pattern_ack_captured events carried ack_source=structured_fields ` +
      `(${measured.percent}% >= 95% required).`,
    '[orchestray]   patterns_used/patterns_rejected are now REQUIRED (not just shape-checked) on',
    '[orchestray]   HARD_TIER agent spawns — see bin/validate-task-completion.js.',
    '[orchestray]   To revert: set ORCHESTRAY_T15_PATTERN_ACK_FIELDS_ENFORCED=0, or',
    '[orchestray]   pattern_evidence.enforce_ack_fields: false in .orchestray/config.json.',
  ];
}

/**
 * Perform the flip: mutate config, banner, sentinel, audit event. Only
 * called once the sentinel has been confirmed absent by the caller.
 * Returns true iff the config write actually landed (sentinel is only
 * written on success, so a failed flip is retried next session).
 */
function performFlip(cwd, measured) {
  const config = readConfig(cwd);
  config.pattern_evidence = Object.assign({}, config.pattern_evidence, { enforce_ack_fields: true });

  if (!writeConfig(cwd, config)) return false; // lock contention — retry next session, no sentinel

  for (const line of bannerLines(measured)) process.stderr.write(line + '\n');

  try {
    writeEvent({
      version:         1,
      type:            'pattern_ack_fields_autoflip',
      previous_value:  false,
      new_value:       true,
      measured_share:  measured.share,
      measured_count:  measured.total,
      required_share:  REQUIRED_SHARE,
      required_count:  REQUIRED_WINDOW,
      reason:          'ack_fields_readiness_condition_met',
    }, { cwd });
  } catch (_e) { /* best-effort, never blocks the flip */ }

  writeSentinel(cwd);
  return true;
}

/**
 * Orchestrates the full auto-flip decision. Called once per session from
 * bin/session-feature-gate.js. Never throws.
 *
 * @returns {{flipped: boolean, reason: string, evaluation?: object}}
 */
function maybeAutoFlip(cwd) {
  try {
    const config = readConfig(cwd);
    if (isAlreadyEnforced(config)) return { flipped: false, reason: 'already_enforced' };
    if (sentinelPresent(cwd))      return { flipped: false, reason: 'sentinel_present' };
    if (isAutoFlipDisabled(config)) return { flipped: false, reason: 'kill_switch' };

    const measured = evaluate(cwd);
    if (!measured.ready) return { flipped: false, reason: 'not_ready', evaluation: measured };

    const flipped = performFlip(cwd, measured);
    return { flipped, reason: flipped ? 'condition_met' : 'lock_contention', evaluation: measured };
  } catch (_e) {
    return { flipped: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Progress line — cheap, used by session-feature-gate.js and the CLI alike.
// ---------------------------------------------------------------------------

function formatProgressLine(measured) {
  if (measured.ready) {
    return `ack-fields readiness: ready (${measured.structured}/${measured.total} structured_fields, ` +
      `${measured.percent}% >= 95%)`;
  }
  if (measured.total < measured.required) {
    return `ack-fields readiness: ${measured.total}/${measured.required} pattern_ack_captured events, ` +
      `${measured.percent}% structured_fields so far — not yet evaluable`;
  }
  return `ack-fields readiness: not ready (${measured.structured}/${measured.total} structured_fields, ` +
    `${measured.percent}% < 95% required)`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let cwd = process.cwd();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd' && argv[i + 1]) {
      cwd = path.resolve(argv[i + 1]);
      i++;
    } else if (argv[i] === '--json') {
      json = true;
    }
  }
  return { cwd, json };
}

function main(argv) {
  try {
    const { cwd: cwdArg, json } = parseArgs(argv);
    const cwd = resolveSafeCwd(cwdArg);
    const measured = evaluate(cwd);

    if (json) {
      process.stdout.write(JSON.stringify(measured) + '\n');
    } else {
      process.stdout.write(formatProgressLine(measured) + '\n');
    }
    return measured.ready ? 0 : 1;
  } catch (_e) {
    process.stdout.write(JSON.stringify({ error: 'internal_error' }) + '\n');
    return 2;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  REQUIRED_WINDOW,
  REQUIRED_SHARE,
  SENTINEL_REL,
  evaluate,
  maybeAutoFlip,
  formatProgressLine,
  // Exposed for tests:
  _internal: {
    collectRecentAckEvents,
    performFlip,
    isAlreadyEnforced,
    isAutoFlipDisabled,
    sentinelPresent,
    bannerLines,
  },
};
