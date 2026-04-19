#!/usr/bin/env node
'use strict';

/**
 * config-repair.js — Reinitializes a missing or corrupt auto_learning block
 * in .orchestray/config.json without touching other keys.
 *
 * Contract:
 *   - Reads .orchestray/config.json.
 *   - Validates the auto_learning block via loadAutoLearningConfig.
 *   - If the block is valid (loader does NOT fall back to all-off AND no malformed
 *     degraded-journal entry): emit config_repair_noop + exit 0.
 *   - If the block is missing OR malformed:
 *       1. Backup: .orchestray/config.json.bak-{UTC-timestamp-ms}
 *       2. Surgical mutation: parse → overwrite only auto_learning → re-stringify
 *          with the existing indentation style (2-space or 4-space detected).
 *       3. Atomic rewrite (tmp + rename).
 *       4. Emit config_repair_applied audit event.
 *   - --dry-run: report what would happen without writing any files.
 *
 * Safety invariants:
 *   - ALL non-auto_learning keys are preserved byte-for-byte (JSON structural equivalence).
 *   - Backup filenames include ms timestamp so concurrent calls never collide.
 *   - Atomic write via tmp + rename (POSIX: rename is atomic within same filesystem).
 *
 * CLI: node bin/_lib/config-repair.js [--project-root=PATH] [--dry-run]
 *
 * v2.1.6 — W10 /orchestray:config repair primitive.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { loadAutoLearningConfig, DEFAULT_AUTO_LEARNING } = require('./config-schema');
const { atomicAppendJsonl } = require('./atomic-append');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INDENT = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect indentation style from a JSON string.
 * Returns 2 or 4 (defaulting to 2 for unrecognised styles).
 *
 * @param {string} raw
 * @returns {number}
 */
function _detectIndent(raw) {
  // Look for the first line with leading spaces in an object/array.
  const m = raw.match(/\n( +)"/);
  if (!m) return DEFAULT_INDENT;
  const spaces = m[1].length;
  if (spaces === 4) return 4;
  return 2;
}

/**
 * Build the default auto_learning block (deep copy, not frozen).
 * @returns {object}
 */
function _buildDefaultAutoLearning() {
  return {
    global_kill_switch: DEFAULT_AUTO_LEARNING.global_kill_switch,
    extract_on_complete: {
      enabled: DEFAULT_AUTO_LEARNING.extract_on_complete.enabled,
      shadow_mode: DEFAULT_AUTO_LEARNING.extract_on_complete.shadow_mode,
      proposals_per_orchestration: DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_orchestration,
      proposals_per_24h: DEFAULT_AUTO_LEARNING.extract_on_complete.proposals_per_24h,
    },
    roi_aggregator: {
      enabled: DEFAULT_AUTO_LEARNING.roi_aggregator.enabled,
      min_days_between_runs: DEFAULT_AUTO_LEARNING.roi_aggregator.min_days_between_runs,
      lookback_days: DEFAULT_AUTO_LEARNING.roi_aggregator.lookback_days,
    },
    kb_refs_sweep: {
      enabled: DEFAULT_AUTO_LEARNING.kb_refs_sweep.enabled,
      min_days_between_runs: DEFAULT_AUTO_LEARNING.kb_refs_sweep.min_days_between_runs,
    },
    safety: {
      circuit_breaker: {
        max_extractions_per_24h: DEFAULT_AUTO_LEARNING.safety.circuit_breaker.max_extractions_per_24h,
        cooldown_minutes_on_trip: DEFAULT_AUTO_LEARNING.safety.circuit_breaker.cooldown_minutes_on_trip,
      },
    },
  };
}

/**
 * Determine whether the auto_learning block needs repair.
 *
 * Heuristic: call loadAutoLearningConfig and check if the result matches
 * all-off defaults. Since the loader returns all-off-defaults on both
 * "missing block" and "malformed block", we need to distinguish:
 *   - Block absent (fromFile === undefined): always needs repair.
 *   - Block present but malformed (loader emits degraded entry): needs repair.
 *   - Block present and valid: no repair needed.
 *
 * We detect "malformed" by catching degraded-journal emission: we temporarily
 * patch the journal to intercept the malformed signal, then restore it.
 * This is simpler and more reliable than duplicating loader logic.
 *
 * @param {string} projectRoot
 * @returns {{ needsRepair: boolean, reason: 'missing' | 'malformed' | 'valid' }}
 */
function _checkNeedsRepair(projectRoot) {
  const configPath = path.join(projectRoot, '.orchestray', 'config.json');

  // Can't read config at all → needs repair (or initial creation).
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (_e) {
    return { needsRepair: true, reason: 'missing' };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return { needsRepair: true, reason: 'malformed' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { needsRepair: true, reason: 'malformed' };
  }

  // Block absent → valid initial state, still repair to add the block.
  const fromFile = parsed.auto_learning;
  if (fromFile === undefined || fromFile === null) {
    return { needsRepair: true, reason: 'missing' };
  }

  // Block present but wrong type → malformed.
  if (typeof fromFile !== 'object' || Array.isArray(fromFile)) {
    return { needsRepair: true, reason: 'malformed' };
  }

  // Attempt to load via canonical loader; check if the block has any type error
  // by looking at what the loader returns. We detect malformed via a temporary
  // degraded-journal intercept: if the loader would emit a malformed entry, the
  // block needs repair.
  //
  // Safer approach: we know the loader returns all-off defaults AND records a
  // degraded entry for truly malformed blocks. We capture the degraded-journal
  // writes to detect this case.
  const { recordDegradation } = require('./degraded-journal');
  let malformedSignalled = false;
  const origRecordDegradation = recordDegradation;

  // We check for the malformed signal by sniffing the degraded journal file
  // before and after the load call. Any new entry with kind 'auto_learning_config_malformed'
  // in the file signals repair is needed.
  const degradedPath = path.join(projectRoot, '.orchestray', 'state', 'degraded.jsonl');
  let sizeBefore = 0;
  try {
    sizeBefore = fs.statSync(degradedPath).size;
  } catch (_e) { /* file may not exist */ }

  // Run the loader (may write degraded journal on malformed).
  loadAutoLearningConfig(projectRoot);

  let sizeAfter = 0;
  try {
    sizeAfter = fs.statSync(degradedPath).size;
  } catch (_e) { /* file may not exist */ }

  if (sizeAfter > sizeBefore) {
    // New degraded entries written → loader detected malformation.
    // Confirm it's an auto_learning_config_malformed entry.
    try {
      const tail = fs.readFileSync(degradedPath, 'utf8').split('\n').filter(Boolean);
      const recent = tail.slice(-(sizeAfter > sizeBefore ? 5 : 0));
      for (const line of recent) {
        try {
          const ev = JSON.parse(line);
          if (ev.kind === 'auto_learning_config_malformed') {
            malformedSignalled = true;
            break;
          }
        } catch (_) { /* skip */ }
      }
    } catch (_e) { /* fail-open */ }
  }

  if (malformedSignalled) {
    return { needsRepair: true, reason: 'malformed' };
  }

  return { needsRepair: false, reason: 'valid' };
}

/**
 * Emit an audit event. Fail-open.
 *
 * @param {string} projectRoot
 * @param {object} event
 */
function _emitAuditEvent(projectRoot, event) {
  try {
    const auditDir   = path.join(projectRoot, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    const eventsPath = path.join(auditDir, 'events.jsonl');
    atomicAppendJsonl(eventsPath, {
      timestamp: new Date().toISOString(),
      schema_version: 1,
      ...event,
    });
  } catch (_e) {
    // Audit failure is non-fatal.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Repair the auto_learning block in .orchestray/config.json.
 *
 * @param {string} projectRoot - Absolute path to project root.
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - If true, report what would happen without writing.
 * @returns {{
 *   repaired: boolean,
 *   path: string,
 *   backup: string | null,
 *   reason: 'missing' | 'malformed' | 'valid',
 *   dryRun?: boolean,
 * }}
 */
function repairAutoLearning(projectRoot, options) {
  const dryRun    = Boolean(options && options.dryRun);
  const configPath = path.join(projectRoot, '.orchestray', 'config.json');

  const { needsRepair, reason } = _checkNeedsRepair(projectRoot);

  if (!needsRepair) {
    _emitAuditEvent(projectRoot, {
      type:   'config_repair_noop',
      detail: { path: configPath, reason },
    });
    return { repaired: false, path: configPath, backup: null, reason };
  }

  if (dryRun) {
    return { repaired: false, path: configPath, backup: null, reason, dryRun: true };
  }

  // Read existing config (or start from {}).
  let existingParsed = {};
  let rawContent     = '{}';
  try {
    rawContent      = fs.readFileSync(configPath, 'utf8');
    existingParsed  = JSON.parse(rawContent);
    if (!existingParsed || typeof existingParsed !== 'object' || Array.isArray(existingParsed)) {
      existingParsed = {};
    }
  } catch (_e) {
    existingParsed = {};
    rawContent     = '{}';
  }

  const indent = _detectIndent(rawContent);

  // Surgical mutation: only overwrite auto_learning key.
  const newConfig = Object.assign({}, existingParsed, {
    auto_learning: _buildDefaultAutoLearning(),
  });

  const newContent = JSON.stringify(newConfig, null, indent) + '\n';

  // Backup existing file (use ms timestamp to avoid collisions).
  const backupPath = configPath + '.bak-' + Date.now();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Only backup if the file actually existed before.
    if (fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, backupPath);
    }
  } catch (err) {
    throw new Error('config-repair: could not create backup ' + backupPath + ': ' + String(err.message || err));
  }

  // Atomic rewrite (tmp + rename).
  const tmp = configPath + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(tmp, newContent, 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    throw new Error('config-repair: could not write config ' + configPath + ': ' + String(err.message || err));
  }

  _emitAuditEvent(projectRoot, {
    type:   'config_repair_applied',
    detail: { path: configPath, backup: backupPath, reason },
  });

  return { repaired: true, path: configPath, backup: backupPath, reason };
}

module.exports = { repairAutoLearning };

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  let projectRoot = process.cwd();
  let dryRun = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else {
      const m = /^--project-root=(.+)$/.exec(arg);
      if (m) projectRoot = path.resolve(m[1]);
    }
  }

  try {
    const result = repairAutoLearning(projectRoot, { dryRun });

    if (result.dryRun) {
      process.stdout.write(
        `[config-repair] DRY RUN — would ${result.reason === 'valid' ? 'no-op' : 'repair'} auto_learning block (reason: ${result.reason})\n`
      );
    } else if (result.repaired) {
      process.stdout.write(
        `[config-repair] Applied repair to ${result.path} (reason: ${result.reason}). Backup: ${result.backup}\n`
      );
    } else {
      process.stdout.write(
        `[config-repair] No repair needed — auto_learning block is valid.\n`
      );
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write('[config-repair] error: ' + String(err.message || err) + '\n');
    process.exit(1);
  }
}
