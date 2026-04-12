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
 * Non-blocking: any errors are swallowed and the compaction is allowed to proceed.
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { clearSessionCache } = require('./_lib/shield-session-cache');

const MAX_INPUT_BYTES = 1024 * 1024; // 1 MB cap — guards against runaway payloads OOMing the hook (T14 audit I14)

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
