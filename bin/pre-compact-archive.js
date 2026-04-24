#!/usr/bin/env node
'use strict';

/**
 * PreCompact hook — archives the current orchestration transcript and state
 * BEFORE Claude Code auto-compacts the session context, so valuable orchestration
 * history isn't lost to summarization.
 *
 * Writes a snapshot to .orchestray/history/pre-compact-{timestamp}/ containing:
 *   - manifest.json: reason, trigger type (manual/auto), orchestration_id, timestamp
 *   - orchestration.md: copy of current .orchestray/state/orchestration.md (if exists)
 *   - events.jsonl: copy of current .orchestray/audit/events.jsonl (if exists)
 *   - current-orchestration.json: copy of current audit marker (if exists)
 *
 * Triggered by Claude Code's PreCompact hook event (manual /compact or auto-compact).
 *
 * v2.1.10 R3: Durability checkpoint — if the resilience dossier write fails AND an
 * orchestration is in-flight, exits 2 to block compaction (preserving in-flight state).
 * Behaviour is governed by:
 *   - ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1  env kill-switch  → never block (exit 0)
 *   - .orchestray/config.json resilience.block_on_write_failure: false  → never block
 *   - Phase detector is conservative: on any parse failure or unrecognised phase, exit 0.
 *     False negatives (not blocking when we should) are preferable to false positives
 *     (stuck compaction). W2 audit noted 3 prior ENOENT races on current-orchestration.json.
 *
 * New audit events emitted by this script (v2.1.10 R3 additions; catalogued in
 * agents/pm-reference/event-schemas.md §v2.1.10 by W4 / W7 release-manager):
 *   - resilience_block_triggered       — exit 2 issued; dossier write failed during active orch
 *   - resilience_block_suppressed_inactive — dossier write failed but orch is not active; exit 0
 *   - resilience_block_suppressed      — kill-switch or config flag active; forced exit 0
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { clearSessionCache } = require('./_lib/shield-session-cache');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');
    const cwd = resolveSafeCwd(event.cwd);
    const trigger = event.trigger || event.compact_trigger || 'unknown'; // "manual" | "auto" | "unknown"
    const customInstructions = event.custom_instructions || event.instructions || null;

    const orchestrayDir = path.join(cwd, '.orchestray');
    const stateDir = path.join(orchestrayDir, 'state');
    const auditDir = path.join(orchestrayDir, 'audit');
    const historyDir = path.join(orchestrayDir, 'history');

    // If .orchestray doesn't exist, there's nothing to archive. Skip gracefully.
    if (!fs.existsSync(orchestrayDir)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Resolve orchestration_id from the current marker (if an orchestration is active)
    let orchestrationId = null;
    try {
      const markerPath = getCurrentOrchestrationFile(cwd);
      if (fs.existsSync(markerPath)) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        orchestrationId = marker.orchestration_id || null;
      }
    } catch (_e) {
      // ignore — marker may be missing or malformed
    }

    // v2.1.7 Bundle D: belt-and-suspenders dossier write before compaction
    // consumes the context. writeDossierSnapshot returns {written, reason, ...}.
    // v2.1.10 R3: if the write fails during an active orchestration we may block
    // compaction (exit 2) to protect in-flight state — see _shouldBlockCompaction().
    let dossierWriteResult = { written: false, reason: 'not_attempted' };
    let dossierWriteFailed = false;
    try {
      const { writeDossierSnapshot } = require('./write-resilience-dossier');
      dossierWriteResult = writeDossierSnapshot(cwd, { trigger: 'pre_compact' });
      // Treat as failed only when writeDossierSnapshot explicitly reports a write
      // failure — NOT when it intentionally skipped (disabled/no active orch).
      dossierWriteFailed = !dossierWriteResult.written &&
        dossierWriteResult.reason !== 'env_kill_switch' &&
        dossierWriteResult.reason !== 'config_disabled' &&
        dossierWriteResult.reason !== 'no_orchestray_dir' &&
        dossierWriteResult.reason !== 'no_active_orchestration';
    } catch (_e) {
      // writeDossierSnapshot threw unexpectedly — treat as write failure.
      dossierWriteFailed = true;
    }

    // v2.1.10 R3: Evaluate whether to block compaction.
    // Conservative: any doubt about orchestration state → do NOT block.
    if (dossierWriteFailed) {
      const blockDecision = _shouldBlockCompaction(cwd, auditDir, orchestrationId);
      if (blockDecision.block) {
        // Emit resilience_block_triggered audit event (best-effort).
        _emitBlockEvent(auditDir, 'resilience_block_triggered', {
          orchestration_id: orchestrationId || blockDecision.orchestration_id || 'unknown',
          phase: blockDecision.phase || 'unknown',
          trigger,
          reason: 'dossier_write_failed_during_active_orchestration',
        });
        process.stderr.write(
          'Orchestray: refusing to compact — resilience dossier write failed during' +
          ' active orchestration ' + (orchestrationId || blockDecision.orchestration_id || '(unknown)') +
          '. Retry in a moment or run /orchestray:status and manually /compact after.\n'
        );
        process.stdout.write(JSON.stringify({ continue: false }));
        process.exit(2);
      } else if (blockDecision.suppressed_reason === 'kill_switch_or_config') {
        _emitBlockEvent(auditDir, 'resilience_block_suppressed', {
          orchestration_id: orchestrationId || 'unknown',
          trigger,
          reason: blockDecision.kill_switch_source || 'kill_switch_or_config',
        });
      } else if (blockDecision.suppressed_reason === 'inactive') {
        _emitBlockEvent(auditDir, 'resilience_block_suppressed_inactive', {
          orchestration_id: orchestrationId || 'unknown',
          trigger,
          phase: blockDecision.phase || 'unknown',
          reason: 'orchestration_not_active',
        });
      }
      // else: suppressed_reason === 'parse_failure' or other conservative path → no event
    }

    // Build snapshot directory name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshotName = `pre-compact-${timestamp}`;
    const snapshotDir = path.join(historyDir, snapshotName);
    fs.mkdirSync(snapshotDir, { recursive: true });

    // Write manifest
    const manifest = {
      type: 'pre_compact_archive',
      timestamp: new Date().toISOString(),
      trigger, // "manual" | "auto" | "unknown"
      orchestration_id: orchestrationId,
      custom_instructions: customInstructions,
      archived_files: [],
    };

    // Helper: copy a file if it exists, record in manifest
    const copyIfExists = (srcPath, destName) => {
      try {
        if (fs.existsSync(srcPath) && fs.statSync(srcPath).isFile()) {
          const destPath = path.join(snapshotDir, destName);
          fs.copyFileSync(srcPath, destPath);
          manifest.archived_files.push(destName);
        }
      } catch (_e) {
        // ignore individual copy failures — partial archive is better than none
      }
    };

    // Archive orchestration state
    copyIfExists(path.join(stateDir, 'orchestration.md'), 'orchestration.md');
    copyIfExists(path.join(stateDir, 'task-graph.md'), 'task-graph.md');

    // Archive audit trail
    copyIfExists(path.join(auditDir, 'events.jsonl'), 'events.jsonl');
    copyIfExists(path.join(auditDir, 'current-orchestration.json'), 'current-orchestration.json');

    // v2.1.7 Bundle D: archive the resilience dossier alongside the other state.
    // The writeDossierSnapshot() call above has just refreshed it, so the copy
    // reflects the pre-compaction posture even if Stop/SubagentStop haven't
    // fired in the interval since the last write.
    copyIfExists(path.join(stateDir, 'resilience-dossier.json'), 'resilience-dossier.json');

    // Archive task files directory if it exists. DEF-8: recurse into nested
    // subdirs (e.g. .orchestray/state/tasks/group-1/task-1.md) instead of
    // copying only the top-level files. Preserve relative paths under the
    // snapshot `tasks/` directory.
    try {
      const tasksDir = path.join(stateDir, 'tasks');
      if (fs.existsSync(tasksDir) && fs.statSync(tasksDir).isDirectory()) {
        const destTasksDir = path.join(snapshotDir, 'tasks');
        fs.mkdirSync(destTasksDir, { recursive: true });
        const entries = fs.readdirSync(tasksDir, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
          // Node populates `entry.parentPath` (20.12+) or `entry.path` (<20.12,
          // deprecated) with the containing directory when recursive:true is used.
          // Skip symlinks before the isFile() check: isFile() follows symlinks,
          // so a symlink in the tasks dir could copy sensitive file contents into
          // the snapshot. Skip non-files (directories are created on-demand below).
          if (entry.isSymbolicLink()) continue;
          if (!entry.isFile()) continue;
          const src = path.join(entry.parentPath || entry.path, entry.name);

          // Directory-symlink escape guard (T23 final audit). Node's
          // `readdirSync({ recursive: true })` follows symbolic directory
          // links and includes their contents in `entries`. The file-level
          // `isSymbolicLink()` check above does NOT catch those contents
          // because by then Node has already descended through the dir
          // symlink — the entries are classified by their target (a real
          // file somewhere outside the tasks tree). Guard with realpath
          // containment: if the resolved source path escapes `tasksDir`,
          // skip the copy. Best-effort — realpathSync throws on dangling
          // links, which is the correct outcome here (skip dangling).
          try {
            const realSrc = fs.realpathSync(src);
            const realTasks = fs.realpathSync(tasksDir);
            if (realSrc !== realTasks &&
                !realSrc.startsWith(realTasks + path.sep)) {
              continue; // escaped the tasks tree via a directory symlink
            }
          } catch (_e) { continue; /* dangling / unreadable — skip */ }

          const relFromTasks = path.relative(tasksDir, src);
          const dest = path.join(destTasksDir, relFromTasks);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          // Normalize separators to forward slashes in the manifest for
          // cross-platform stability of archived_files entries.
          manifest.archived_files.push('tasks/' + relFromTasks.split(path.sep).join('/'));
        }
      }
    } catch (_e) {
      // ignore
    }

    // Write the manifest
    fs.writeFileSync(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );

    // Append a pre_compact_archive event to the live audit log (if it exists)
    try {
      const eventsPath = path.join(auditDir, 'events.jsonl');
      if (fs.existsSync(auditDir)) {
        const evt = {
          timestamp: new Date().toISOString(),
          type: 'pre_compact_archive',
          orchestration_id: orchestrationId || 'none',
          trigger,
          snapshot_dir: path.relative(cwd, snapshotDir),
          archived_count: manifest.archived_files.length,
        };
        atomicAppendJsonl(eventsPath, evt);
      }
    } catch (_e) {
      // ignore — never fail the hook over audit logging
    }

    // Clear the R14 session cache so the next context window starts fresh.
    // The session_id comes from the same hook payload field used by context-shield.js.
    try {
      const sessionId = event.session_id || 'unknown';
      clearSessionCache(cwd, sessionId);
    } catch (_e) {
      // ignore — never fail the hook over cache cleanup
    }
  } catch (_e) {
    // Swallow all errors — never block compaction
  }

  // Always allow compaction to proceed
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});

// ---------------------------------------------------------------------------
// v2.1.10 R3 helpers — resilience block decision
// ---------------------------------------------------------------------------

/**
 * Active-orchestration phase values. Any phase not in this set (or not recognised)
 * is treated as "inactive" — we do NOT block. Conservative by design.
 *
 * The spec lists: decomposing, G1-executing … G5-executing, executing, reviewing,
 * verifying, plus any value that is not completed/aborted/null.
 * We enumerate the known-active values explicitly; anything else → not active.
 */
const ACTIVE_PHASES = new Set([
  'decomposing',
  'executing',
  'reviewing',
  'verifying',
  // grouped-execution phases (G1–G9 safety margin)
  'G1-executing', 'G2-executing', 'G3-executing', 'G4-executing', 'G5-executing',
  'G6-executing', 'G7-executing', 'G8-executing', 'G9-executing',
  // implementation-phase aliases observed in practice
  'implementation',
  'delegation',
  // any "in_progress" synonym
  'in_progress',
]);

/** Phases that definitively indicate no active orchestration. */
const INACTIVE_PHASES = new Set([
  'completed', 'complete', 'aborted', 'archived', 'failed',
]);

/**
 * Decide whether to block compaction.
 *
 * Returns one of:
 *   { block: true,  orchestration_id, phase }
 *   { block: false, suppressed_reason: 'kill_switch_or_config', kill_switch_source }
 *   { block: false, suppressed_reason: 'inactive', phase }
 *   { block: false, suppressed_reason: 'parse_failure' }
 *
 * Conservative rule: on any parse/read failure → suppressed_reason: 'parse_failure'.
 *
 * @param {string} cwd
 * @param {string} auditDir
 * @param {string|null} orchestrationId
 * @returns {{ block: boolean, suppressed_reason?: string, orchestration_id?: string|null,
 *             phase?: string|null, kill_switch_source?: string }}
 */
function _shouldBlockCompaction(cwd, auditDir, orchestrationId) {
  // Kill-switch check first — never block if overridden.
  if (process.env.ORCHESTRAY_RESILIENCE_BLOCK_DISABLED === '1') {
    return { block: false, suppressed_reason: 'kill_switch_or_config', kill_switch_source: 'env_ORCHESTRAY_RESILIENCE_BLOCK_DISABLED' };
  }

  // Config flag check (fail-open: if config is unreadable, proceed to phase check).
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed &&
          parsed.resilience &&
          parsed.resilience.block_on_write_failure === false) {
        return { block: false, suppressed_reason: 'kill_switch_or_config', kill_switch_source: 'config_resilience.block_on_write_failure_false' };
      }
    }
  } catch (_e) {
    // Config unreadable → conservative: proceed to phase check (don't block on config error).
  }

  // Phase detection from .orchestray/state/orchestration.md frontmatter.
  // Conservative: on any error → suppressed_reason: 'parse_failure' (do NOT block).
  const phase = _readOrchestrationPhase(cwd);
  if (phase === null) {
    // File missing or parse failure → do not block.
    return { block: false, suppressed_reason: 'parse_failure' };
  }

  if (INACTIVE_PHASES.has(phase)) {
    return { block: false, suppressed_reason: 'inactive', phase };
  }

  if (ACTIVE_PHASES.has(phase)) {
    return { block: true, orchestration_id: orchestrationId, phase };
  }

  // Unrecognised phase value → conservative, do NOT block.
  return { block: false, suppressed_reason: 'parse_failure', phase };
}

/**
 * Read the `phase` (or `current_phase`) frontmatter field from
 * `.orchestray/state/orchestration.md`.
 *
 * Returns the trimmed phase string, or `null` on any error (file missing,
 * parse failure, no frontmatter). Returning `null` signals "do not block".
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function _readOrchestrationPhase(cwd) {
  try {
    const orchPath = path.join(cwd, '.orchestray', 'state', 'orchestration.md');
    if (!fs.existsSync(orchPath)) return null;
    const raw = fs.readFileSync(orchPath, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const fm = match[1];
    for (const line of fm.split(/\r?\n/)) {
      // Match `phase:` or `current_phase:` (both observed in practice).
      const mm = line.match(/^(?:current_)?phase:\s*(.+)$/i);
      if (!mm) continue;
      let val = mm[1].trim();
      // Strip surrounding quotes.
      if (val.length >= 2 &&
          (val[0] === '"' || val[0] === "'") &&
          val[val.length - 1] === val[0]) {
        val = val.slice(1, -1);
      }
      if (val) return val;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * Append a resilience-block audit event to events.jsonl. Best-effort: never throws.
 *
 * @param {string} auditDir
 * @param {string} type   Event type name.
 * @param {object} payload Additional fields merged into the event.
 */
function _emitBlockEvent(auditDir, type, payload) {
  try {
    if (!fs.existsSync(auditDir)) {
      // Ensure the audit dir exists (first-run path).
      fs.mkdirSync(auditDir, { recursive: true });
    }
    const eventsPath = path.join(auditDir, 'events.jsonl');
    const evt = Object.assign(
      { timestamp: new Date().toISOString(), type },
      payload
    );
    atomicAppendJsonl(eventsPath, evt);
  } catch (_e) {
    // Never throw from audit emit.
  }
}
