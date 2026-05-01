#!/usr/bin/env node
'use strict';

/**
 * validate-archive.js — PostToolUse:Bash hook (v2.2.11 W2-3).
 *
 * Fires after the `orchestration_complete` event is detected in events.jsonl
 * (same trigger used by audit-on-orch-complete.js). Verifies that the 3
 * required archive files exist in `.orchestray/history/<orch_id>/`:
 *
 *   - events.jsonl
 *   - orchestration.md
 *   - task-graph.md
 *
 * Rationale: phase-close.md:127 — the archive checklist mandates these files
 * be copied, but no validator previously confirmed their presence.
 *
 * Behaviour:
 *   - Warn-only (exit 0). Never blocks.
 *   - Emits `archive_must_copy_missing` when any required file is absent.
 *   - Deduplicates: only checks once per orchestration_id (same mechanism as
 *     audit-on-orch-complete.js via the orch-complete-trigger.json state file).
 *   - Fail-open on any internal error.
 *   - Kill switch: ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED=1
 *
 * Hook ordering per scope-lock §3 Q-hook-ordering:
 *   audit-on-orch-complete.js → validate-archive.js → emit-event-activation-ratio.js
 *
 * Input:  Claude Code PostToolUse:Bash JSON payload on stdin
 * Output: { continue: true } always; exit 0 always
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent }                  = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION   = 1;
const REQUIRED_FILES   = ['events.jsonl', 'orchestration.md', 'task-graph.md'];
const TRIGGER_STATE_FILE = '.orchestray/state/orch-complete-trigger.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return true if the events.jsonl in the cwd has an unprocessed
 * `orchestration_complete` event — mirrors the approach in audit-on-orch-complete.js.
 *
 * Also returns the orchestration_id of the latest such event if found.
 *
 * @param {string} cwd
 * @returns {{ found: boolean, orchestration_id: string|null }}
 */
function findOrchestrationComplete(cwd) {
  try {
    const eventsPath = path.join(cwd, '.orchestray', 'state', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return { found: false, orchestration_id: null };

    const raw = fs.readFileSync(eventsPath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    let lastOrchId = null;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt && evt.type === 'orchestration_complete' && evt.orchestration_id) {
          lastOrchId = evt.orchestration_id;
        }
      } catch (_) { /* skip malformed */ }
    }
    return { found: lastOrchId !== null, orchestration_id: lastOrchId };
  } catch (_) {
    return { found: false, orchestration_id: null };
  }
}

/**
 * Read the last processed orchestration_id from the trigger state file.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function readLastTriggeredId(cwd) {
  try {
    const statePath = path.join(cwd, TRIGGER_STATE_FILE);
    if (!fs.existsSync(statePath)) return null;
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return (raw && raw.archive_validate_last_id) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Write the processed orchestration_id into the trigger state file.
 * Merges with existing state to avoid clobbering audit-on-orch-complete fields.
 *
 * @param {string} cwd
 * @param {string} orchId
 */
function writeLastTriggeredId(cwd, orchId) {
  try {
    const statePath = path.join(cwd, TRIGGER_STATE_FILE);
    let existing = {};
    if (fs.existsSync(statePath)) {
      try { existing = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
    }
    existing.archive_validate_last_id = orchId;
    fs.writeFileSync(statePath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (_) { /* fail-open */ }
}

/**
 * Check which required files are missing from the archive directory.
 *
 * @param {string} cwd
 * @param {string} orchId
 * @returns {string[]} array of missing file names
 */
function findMissingArchiveFiles(cwd, orchId) {
  const archiveDir = path.join(cwd, '.orchestray', 'history', orchId);
  const missing = [];
  for (const filename of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(archiveDir, filename))) {
      missing.push(filename);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    // Only activates on Bash tool calls.
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const toolName = event.tool_name || event.hook_event_matcher || '';
    if (toolName !== 'Bash') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    // Detect orchestration_complete event.
    const { found, orchestration_id: orchId } = findOrchestrationComplete(cwd);
    if (!found || !orchId) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Deduplicate: skip if already validated for this orchestration.
    const lastId = readLastTriggeredId(cwd);
    if (lastId === orchId) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    writeLastTriggeredId(cwd, orchId);

    // Check required archive files.
    const missing = findMissingArchiveFiles(cwd, orchId);
    if (missing.length > 0) {
      try {
        writeEvent({
          version:          SCHEMA_VERSION,
          schema_version:   SCHEMA_VERSION,
          type:             'archive_must_copy_missing',
          orchestration_id: orchId,
          missing_files:    missing,
        }, { cwd });
      } catch (_e) { /* fail-open */ }

      process.stderr.write(
        '[orchestray] validate-archive: WARN — orchestration ' + orchId + ' archive is incomplete. ' +
        'Missing in .orchestray/history/' + orchId + '/: ' + missing.join(', ') + '. ' +
        'Copy them from .orchestray/state/ to complete the archive. ' +
        'Kill switch: ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED=1\n'
      );
    } else {
      // Success path: all required files present.
      // Kill switch: ORCHESTRAY_ARCHIVE_VALIDATION_SUCCESS_EMIT_DISABLED=1
      if (process.env.ORCHESTRAY_ARCHIVE_VALIDATION_SUCCESS_EMIT_DISABLED !== '1') {
        try {
          writeEvent({
            version:          SCHEMA_VERSION,
            schema_version:   SCHEMA_VERSION,
            type:             'archive_must_copy_validation',
            orchestration_id: orchId,
            files_checked:    REQUIRED_FILES.length,
            result:           'success',
          }, { cwd });
        } catch (_e) { /* fail-open */ }
      }
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  findOrchestrationComplete,
  findMissingArchiveFiles,
  REQUIRED_FILES,
};

if (require.main === module) {
  main();
}
