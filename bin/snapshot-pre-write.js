#!/usr/bin/env node
'use strict';

/**
 * snapshot-pre-write.js — PreToolUse:Write|Edit|MultiEdit snapshot hook (v2.2.8 Item 7).
 *
 * Before any agent write, copies the current file contents to
 * `.orchestray/snapshots/<orchestration_id>/<spawn_id>/<sanitized-path>.snapshot`
 * so users can roll back to the pre-write state with `/orchestray:rollback`.
 *
 * Design:
 *   - Fail-open: ANY I/O error → log stderr, return allow. Never blocks writes.
 *   - Bounded: 50 MB cap per orchestration dir. On overflow → evict oldest by mtime.
 *   - Kill-switch: `snapshots.enabled === false` in config.json  OR
 *                  `ORCHESTRAY_DISABLE_SNAPSHOTS=1` env var → skip.
 *   - Emits `snapshot_captured` event on success.
 *   - Always outputs permissionDecision: allow.
 *
 * Spawn ID: `event.session_id` from hook payload; falls back to process.pid.
 * Agent type: `event.agent_type` if present (set by delegation delta injector).
 *
 * Path sanitization: replace `/` with `__`, strip leading separators, max 200 chars.
 *
 * v2.2.8 — workspace snapshot mechanism.
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { resolveSafeCwd }   = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }  = require('./_lib/constants');
const { writeEvent }       = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum total bytes in a per-orchestration snapshot dir before eviction. */
const SNAPSHOT_CAP_BYTES = 50 * 1024 * 1024; // 50 MB

/** Maximum chars in a sanitized file-path component. */
const MAX_SANITIZED_PATH_CHARS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the allow permission response.
 * @returns {string}
 */
function allowResponse() {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    },
  });
}

/**
 * Sanitize an absolute file path to a safe filename.
 * Strips leading slashes, replaces path separators with `__`, caps to 200 chars.
 *
 * @param {string} absPath
 * @returns {string}
 */
function sanitizePath(absPath) {
  let s = absPath.replace(/^[/\\]+/, '');
  s = s.replace(/[/\\]/g, '__');
  if (s.length > MAX_SANITIZED_PATH_CHARS) {
    s = s.slice(s.length - MAX_SANITIZED_PATH_CHARS);
  }
  return s;
}

/**
 * Load snapshot config from .orchestray/config.json.
 * Returns { enabled: true } by default (fail-open default-on).
 *
 * @param {string} projectRoot
 * @returns {{ enabled: boolean, preserve_on_stop: boolean }}
 */
function loadSnapshotConfig(projectRoot) {
  const defaults = { enabled: true, preserve_on_stop: false };
  try {
    const cfgPath = path.join(projectRoot, '.orchestray', 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;
    const block = parsed.snapshots;
    if (!block || typeof block !== 'object') return defaults;
    return Object.assign({}, defaults, block);
  } catch (_e) {
    return defaults;
  }
}

/**
 * Read the active orchestration_id from current-orchestration.json.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function resolveOrchestrationId(projectRoot) {
  try {
    const orchFile = getCurrentOrchestrationFile(projectRoot);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    if (orchData && orchData.orchestration_id) return orchData.orchestration_id;
  } catch (_e) { /* fail-open */ }
  return 'unknown';
}

/**
 * Compute total size (bytes) of all files directly under a directory (non-recursive).
 * Used to check the snapshot sub-dir only (one level deep entries).
 *
 * @param {string} dir
 * @returns {number}
 */
function dirSizeBytes(dir) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(path.join(dir, e.name));
        total += st.size;
      } catch (_e) { /* skip */ }
    }
  } catch (_e) { /* dir may not exist */ }
  return total;
}

/**
 * Evict oldest snapshot files from a spawn snapshot directory until total is under cap.
 * Only evicts from the single spawn-level dir (flat structure: all files are .snapshot).
 *
 * @param {string} orchestrationSnapshotsDir — the per-orchestration dir (all spawns under it)
 */
function evictOldestSnapshots(orchestrationSnapshotsDir) {
  try {
    // Collect all .snapshot files across all spawn subdirs
    const allFiles = [];
    let spawnDirs;
    try {
      spawnDirs = fs.readdirSync(orchestrationSnapshotsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(orchestrationSnapshotsDir, e.name));
    } catch (_e) { return; }

    for (const spawnDir of spawnDirs) {
      try {
        const entries = fs.readdirSync(spawnDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          const fp = path.join(spawnDir, e.name);
          try {
            const st = fs.statSync(fp);
            allFiles.push({ fp, mtime: st.mtimeMs, size: st.size });
          } catch (_e) { /* skip */ }
        }
      } catch (_e) { /* skip */ }
    }

    // Sort oldest first
    allFiles.sort((a, b) => a.mtime - b.mtime);

    // Compute current total
    let total = allFiles.reduce((s, f) => s + f.size, 0);

    // Evict until under cap
    for (const f of allFiles) {
      if (total <= SNAPSHOT_CAP_BYTES) break;
      try {
        fs.unlinkSync(f.fp);
        total -= f.size;
      } catch (_e) { /* skip */ }
    }
  } catch (_e) { /* fail-open */ }
}

/**
 * Snapshot a single file path.
 *
 * @param {string} projectRoot
 * @param {string} orchId
 * @param {string} spawnId
 * @param {string} agentType
 * @param {string} filePath — absolute path of the file being written
 */
function snapshotFile(projectRoot, orchId, spawnId, agentType, filePath) {
  // Only snapshot existing files
  if (!fs.existsSync(filePath)) return;

  const orchSnapshotsDir = path.join(
    projectRoot, '.orchestray', 'snapshots', orchId
  );
  const spawnDir = path.join(orchSnapshotsDir, spawnId);

  try {
    fs.mkdirSync(spawnDir, { recursive: true });
  } catch (err) {
    process.stderr.write('[snapshot-pre-write] mkdirSync failed: ' + (err.message || String(err)) + '\n');
    return;
  }

  const sanitized = sanitizePath(filePath) + '.snapshot';
  const destPath = path.join(spawnDir, sanitized);

  // Read source
  let contents;
  try {
    contents = fs.readFileSync(filePath);
  } catch (err) {
    process.stderr.write('[snapshot-pre-write] readFile failed: ' + (err.message || String(err)) + '\n');
    return;
  }

  // Write snapshot
  try {
    fs.writeFileSync(destPath, contents);
  } catch (err) {
    process.stderr.write('[snapshot-pre-write] writeFile failed: ' + (err.message || String(err)) + '\n');
    return;
  }

  const bytes = contents.length;

  // Check cap and evict if needed
  try {
    const orchDirSize = (() => {
      let total = 0;
      const spawnDirs = fs.readdirSync(orchSnapshotsDir, { withFileTypes: true })
        .filter(e => e.isDirectory());
      for (const sd of spawnDirs) {
        total += dirSizeBytes(path.join(orchSnapshotsDir, sd.name));
      }
      return total;
    })();
    if (orchDirSize > SNAPSHOT_CAP_BYTES) {
      evictOldestSnapshots(orchSnapshotsDir);
    }
  } catch (_e) { /* fail-open */ }

  // Emit snapshot_captured event
  try {
    writeEvent({
      type: 'snapshot_captured',
      version: 1,
      schema_version: 1,
      orchestration_id: orchId,
      spawn_id: spawnId,
      agent_type: agentType,
      path: filePath,
      bytes,
    });
  } catch (err) {
    process.stderr.write('[snapshot-pre-write] writeEvent failed: ' + (err.message || String(err)) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Main hook handler
// ---------------------------------------------------------------------------

/**
 * Process the PreToolUse hook payload and snapshot affected files.
 *
 * @param {object} hookPayload
 */
function handle(hookPayload) {
  try {
    const projectRoot = resolveSafeCwd(hookPayload && hookPayload.cwd);

    // Kill-switch checks
    if (process.env.ORCHESTRAY_DISABLE_SNAPSHOTS === '1') {
      process.stdout.write(allowResponse() + '\n');
      process.exit(0);
      return;
    }

    const cfg = loadSnapshotConfig(projectRoot);
    if (cfg.enabled === false) {
      process.stdout.write(allowResponse() + '\n');
      process.exit(0);
      return;
    }

    const orchId   = resolveOrchestrationId(projectRoot);
    const spawnId  = (hookPayload && hookPayload.session_id) || ('pid-' + process.pid);
    const agentType = (hookPayload && hookPayload.agent_type) || 'unknown';

    const toolName  = (hookPayload && hookPayload.tool_name)  || '';
    const toolInput = (hookPayload && hookPayload.tool_input) || {};

    // Collect target file paths
    const targetPaths = [];

    if (toolName === 'MultiEdit') {
      // tool_input.edits = [{file_path, ...}, ...]
      if (Array.isArray(toolInput.edits)) {
        for (const edit of toolInput.edits) {
          if (edit && typeof edit.file_path === 'string' && edit.file_path) {
            targetPaths.push(path.resolve(edit.file_path));
          }
        }
      }
    } else {
      // Write or Edit: tool_input.file_path
      if (typeof toolInput.file_path === 'string' && toolInput.file_path) {
        targetPaths.push(path.resolve(toolInput.file_path));
      }
    }

    for (const fp of targetPaths) {
      try {
        snapshotFile(projectRoot, orchId, spawnId, agentType, fp);
      } catch (err) {
        // Fail-open per spec: log and continue
        process.stderr.write('[snapshot-pre-write] snapshotFile error for ' + fp + ': ' + (err.message || String(err)) + '\n');
      }
    }
  } catch (err) {
    // Fail-open: unexpected error
    process.stderr.write('[snapshot-pre-write] unexpected error: ' + (err.message || String(err)) + '\n');
  }

  process.stdout.write(allowResponse() + '\n');
  process.exit(0);
}

module.exports = { sanitizePath, snapshotFile, evictOldestSnapshots, loadSnapshotConfig };

// ---------------------------------------------------------------------------
// Entrypoint — only when invoked as a CLI script, not when imported by tests.
// Without this gate, requiring this module attaches stdin handlers that wait
// forever on stdin.end and the test process never exits.
// ---------------------------------------------------------------------------

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(allowResponse() + '\n');
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[snapshot-pre-write] stdin exceeded limit; allowing\n');
      process.stdout.write(allowResponse() + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      handle(JSON.parse(input || '{}'));
    } catch (_e) {
      process.stdout.write(allowResponse() + '\n');
      process.exit(0);
    }
  });
}
