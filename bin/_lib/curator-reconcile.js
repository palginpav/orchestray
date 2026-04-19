'use strict';

/**
 * curator-reconcile.js — Post-run consistency checker for curator tombstones.
 *
 * Background
 * ----------
 * Pre-W1: the curator wrote a tombstone BEFORE the file operation. A truncated
 * agent turn left a phantom-success tombstone — the audit claimed success but
 * the file system was still in the pre-action state.
 * W1 (Option A) inverts the order: action first, tombstone second. This module
 * (Option B) is the catch-all reconciliation pass for runs where even the
 * reordered protocol was interrupted.
 *
 * This module is the Option B safety net: scan tombstones from the most-recent
 * run (or a specific run_id) and verify each one against the actual file system.
 *
 * For each tombstone:
 *   - promote:   shared-tier file must exist and have matching content.
 *   - merge:     merged output file must exist; input slugs must be absent (or
 *                marked deprecated). Cannot safely auto-repair without the
 *                merged content — flag for user review.
 *   - deprecate: local pattern file must have `deprecated: true` in frontmatter.
 *                Cannot safely auto-repair (re-deprecating requires the MCP tool
 *                for audit events) — flag for user review.
 *   - unshare:   shared-tier file must be absent. If still present, auto-remove.
 *
 * Repair policy (deterministic, safe-to-retry; v2.1.6)
 * -----------------------------------------------------
 *   promote   → flag only (F-03/v2.1.6): auto-repair is disabled. Recovery via
 *               /orchestray:learn share <slug>.
 *   merge     → flag only: synthesising a merge body requires LLM reasoning.
 *   deprecate → flag only: needs MCP tool to emit the right audit events.
 *   unshare   → auto-repair when schema_version ≥ 2; flag only when
 *               schema_version < 2 (W2-04 gate). Recovery via
 *               /orchestray:learn unshare <slug>.
 *
 * Usage
 * -----
 *   const { reconcile } = require('./curator-reconcile');
 *   const report = reconcile({ projectRoot, runId });
 *   // report: { ok, repaired, flagged, errors }
 *
 * Called by skills/orchestray:learn/SKILL.md curate block after the curator
 * agent returns. Also exported for unit tests.
 *
 * Does NOT modify tombstone rows — reconciliation is additive and idempotent.
 *
 * Option A + B (W1):
 *   Option A is documented in agents/curator.md §5 (action first, tombstone
 *   second). This module is Option B — a deterministic repair pass for cases
 *   where even the reordered protocol is truncated before the tombstone write.
 */

const fs   = require('node:fs');
const path = require('node:path');

const {
  listTombstones,
  _internal: { readJsonl, activePath, getCuratorDir },
} = require('./curator-tombstone.js');

const { getSharedPatternsDir } = require('../mcp-server/lib/paths.js');
const { recordDegradation } = require('./degraded-journal');
const { atomicAppendJsonl } = require('./atomic-append');

// ---------------------------------------------------------------------------
// Audit event emitters for promote/unshare flagged paths (F-03/F-10 + W2-04 fix)
// ---------------------------------------------------------------------------

/**
 * Emit a curator_reconcile_promote_flagged event (fail-open).
 *
 * @param {string}  projectRoot
 * @param {string}  tombstoneId
 * @param {'auto_repair_disabled'|'schema_version_pre_v216'} reason
 * @param {string}  [slug]
 */
function _emitPromoteFlagged(projectRoot, tombstoneId, reason, slug) {
  try {
    const auditDir = path.join(projectRoot, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), {
      timestamp: new Date().toISOString(),
      type: 'curator_reconcile_promote_flagged',
      schema_version: 1,
      tombstone_id: tombstoneId || 'unknown',
      reason,
      recovery_command: '/orchestray:learn share ' + (slug || '<slug>'),
    });
  } catch (_e) {
    // Fail-open.
  }
}

/**
 * Emit a curator_reconcile_unshare_flagged event (fail-open).
 * W1b (W2-04): mirrors _emitPromoteFlagged for the unshare path.
 *
 * @param {string} projectRoot
 * @param {string} tombstoneId
 * @param {'schema_version_pre_v216'} reason
 * @param {string} [slug]
 */
function _emitUnshareFlagged(projectRoot, tombstoneId, reason, slug) {
  try {
    const auditDir = path.join(projectRoot, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), {
      timestamp: new Date().toISOString(),
      type: 'curator_reconcile_unshare_flagged',
      schema_version: 1,
      tombstone_id: tombstoneId || 'unknown',
      reason,
      recovery_command: '/orchestray:learn unshare ' + (slug || '<slug>'),
    });
  } catch (_e) {
    // Fail-open.
  }
}

// ---------------------------------------------------------------------------
// File content helpers
// ---------------------------------------------------------------------------

/**
 * Read a file and return its content, or null if it does not exist.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function _readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Write content to filePath atomically (tmp + rename).
 * Parent directories are created if missing.
 *
 * @param {string} filePath
 * @param {string} content
 */
function _writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.reconcile.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Delete filePath if it exists (best-effort).
 *
 * @param {string} filePath
 */
function _unlinkSafe(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_) {
    // If already absent, that is the desired state — not an error.
  }
}

// ---------------------------------------------------------------------------
// Deprecation check helper
// ---------------------------------------------------------------------------

/**
 * Return true if the file at filePath has `deprecated: true` in its YAML
 * frontmatter. Uses a minimal regex parser — enough for the single boolean
 * field check, without pulling in a YAML library.
 *
 * @param {string} content
 * @returns {boolean}
 */
function _isDeprecated(content) {
  // Match the frontmatter block (between --- delimiters).
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fmMatch) return false;
  const fm = fmMatch[1];
  return /^\s*deprecated\s*:\s*true\s*$/m.test(fm);
}

// ---------------------------------------------------------------------------
// Per-action verifier
// ---------------------------------------------------------------------------

/**
 * Verify one tombstone row against the actual filesystem state.
 *
 * Returns an object:
 *   { status: 'ok' | 'mismatch' | 'repaired' | 'flagged' | 'skipped', detail, tombstone }
 *
 * @param {object}       tombstone       - A tombstone row from tombstones.jsonl.
 * @param {object}       opts
 * @param {string}       opts.projectRoot
 * @param {string|null}  opts.sharedDir   - Shared patterns dir (may be null).
 * @returns {{ status: string, detail: string, tombstone: object }}
 */
function _verifyOne(tombstone, opts) {
  const { projectRoot, sharedDir } = opts;

  // Skip rows that have already been rolled back — their state is intentionally
  // different from what the tombstone recorded.
  if (tombstone.rolled_back_at) {
    return { status: 'skipped', detail: 'already rolled back', tombstone };
  }

  const action = tombstone.action;

  // -------------------------------------------------------------------------
  // promote: shared-tier file must exist with matching content.
  // -------------------------------------------------------------------------
  if (action === 'promote') {
    if (!sharedDir) {
      // Federation is not configured in this environment.  Cannot verify.
      return { status: 'skipped', detail: 'shared dir not configured — cannot verify promote', tombstone };
    }

    const slug = tombstone.inputs && tombstone.inputs[0] && tombstone.inputs[0].slug;
    if (!slug) {
      return { status: 'flagged', detail: 'tombstone missing slug in inputs[0]', tombstone };
    }

    const destPath = path.join(sharedDir, slug + '.md');
    const existing = _readFileSafe(destPath);

    if (existing !== null) {
      // File exists — promote already succeeded (or was repaired previously).
      return { status: 'ok', detail: 'shared-tier file exists', tombstone };
    }

    // File is absent — this is the phantom-success case.
    // -----------------------------------------------------------------------
    // v2.1.6 schema_version gate (F-03/F-10 fix — PROMOTE ONLY):
    // Promote tombstones without schema_version or with schema_version < 2 are
    // never auto-repaired — flag them for human review.
    // The gate applies only to the absent-file (potential auto-repair) path,
    // not to the file-present (ok) or skipped paths.
    // New tombstones written by v2.1.6 carry schema_version: 2.
    // -----------------------------------------------------------------------
    const schemaVersion = tombstone.schema_version == null ? 0 : Number(tombstone.schema_version);
    const tombstoneId = tombstone.run_id || tombstone.id || 'unknown';
    if (isNaN(schemaVersion) || schemaVersion < 2) {
      _emitPromoteFlagged(projectRoot, tombstoneId, 'schema_version_pre_v216', slug);
      return {
        status: 'flagged',
        detail: 'schema_version_pre_v216 — manual review required (tombstone predates v2.1.6 validation)',
        tombstone,
      };
    }

    // F-03 fix: promote auto-repair is now flag-only regardless of schema_version.
    // No _writeAtomic call here. Manual recovery required.
    _emitPromoteFlagged(projectRoot, tombstoneId, 'auto_repair_disabled', slug);
    return {
      status: 'flagged',
      detail:
        'promote mismatch: shared-tier file absent; auto-repair disabled for promote — ' +
        'manual recovery required (re-run /orchestray:learn share ' + slug + ')',
      tombstone,
    };
  }

  // -------------------------------------------------------------------------
  // unshare: shared-tier file must be absent.
  // -------------------------------------------------------------------------
  if (action === 'unshare') {
    if (!sharedDir) {
      return { status: 'skipped', detail: 'shared dir not configured — cannot verify unshare', tombstone };
    }

    const slug = tombstone.inputs && tombstone.inputs[0] && tombstone.inputs[0].slug;
    if (!slug) {
      return { status: 'flagged', detail: 'tombstone missing slug in inputs[0]', tombstone };
    }

    // -----------------------------------------------------------------------
    // v2.1.6 schema_version gate for unshare (W2-04 fix):
    // Unshare tombstones without schema_version or with schema_version < 2 are
    // never auto-deleted — a forged/resurrected pre-v2.1.6 tombstone would
    // otherwise force deletion of any shared-tier slug it names (DoS-adjacent).
    // Flag for human review instead.
    // -----------------------------------------------------------------------
    const unshareSchemaVersion = tombstone.schema_version == null ? 0 : Number(tombstone.schema_version);
    const tombstoneId = tombstone.run_id || tombstone.id || 'unknown';
    if (isNaN(unshareSchemaVersion) || unshareSchemaVersion < 2) {
      _emitUnshareFlagged(projectRoot, tombstoneId, 'schema_version_pre_v216', slug);
      return {
        status: 'flagged',
        detail: 'schema_version_pre_v216 — unshare auto-delete refused for pre-v2.1.6 tombstone; manual review required',
        tombstone,
      };
    }

    const destPath = path.join(sharedDir, slug + '.md');
    if (!fs.existsSync(destPath)) {
      return { status: 'ok', detail: 'shared-tier file already absent', tombstone };
    }

    // File still present — auto-repair by deleting.
    try {
      _unlinkSafe(destPath);
    } catch (err) {
      return {
        status: 'flagged',
        detail: 'unshare mismatch: auto-repair delete failed: ' + (err && err.message),
        tombstone,
      };
    }

    return {
      status: 'repaired',
      detail: 'unshare mismatch: shared-tier file was still present; deleted ' + destPath,
      tombstone,
    };
  }

  // -------------------------------------------------------------------------
  // merge: output file must exist.
  // Cannot auto-repair — merged body requires LLM reasoning.
  // -------------------------------------------------------------------------
  if (action === 'merge') {
    const outputPath = tombstone.output && tombstone.output.path;
    if (!outputPath) {
      return { status: 'flagged', detail: 'merge tombstone missing output.path', tombstone };
    }

    const absOutputPath = path.isAbsolute(outputPath)
      ? outputPath
      : path.resolve(projectRoot, outputPath);

    if (fs.existsSync(absOutputPath)) {
      return { status: 'ok', detail: 'merged output file exists', tombstone };
    }

    return {
      status: 'flagged',
      detail:
        'merge mismatch: merged output file absent at ' + absOutputPath + '. ' +
        'Manual recovery required — re-run /orchestray:learn curate --only merge ' +
        'or restore inputs manually from tombstone content_snapshot.',
      tombstone,
    };
  }

  // -------------------------------------------------------------------------
  // deprecate: local pattern must have deprecated: true in frontmatter.
  // Cannot auto-repair — deprecation requires the MCP tool for audit events.
  // -------------------------------------------------------------------------
  if (action === 'deprecate') {
    const inputPath = tombstone.inputs && tombstone.inputs[0] && tombstone.inputs[0].path;
    if (!inputPath) {
      return { status: 'flagged', detail: 'deprecate tombstone missing inputs[0].path', tombstone };
    }

    const absPath = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(projectRoot, inputPath);

    const content = _readFileSafe(absPath);

    if (content === null) {
      // File is gone — this is acceptable for a deprecate that was followed by
      // a merge or cleanup.  Treat as consistent.
      return { status: 'ok', detail: 'deprecated pattern file absent (already cleaned up)', tombstone };
    }

    if (_isDeprecated(content)) {
      return { status: 'ok', detail: 'deprecated: true in frontmatter', tombstone };
    }

    return {
      status: 'flagged',
      detail:
        'deprecate mismatch: file exists but deprecated: true not set in frontmatter at ' +
        absPath + '. ' +
        'Manual recovery: run /orchestray:learn curate --only deprecate ' +
        'or call mcp__orchestray__pattern_deprecate directly.',
      tombstone,
    };
  }

  // Unknown action — skip silently.
  return { status: 'skipped', detail: 'unknown action type: ' + action, tombstone };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile tombstones from the most-recent curator run (or a specific run_id)
 * against the actual filesystem.
 *
 * Tombstones that are already rolled back are skipped.
 *
 * @param {object}          opts
 * @param {string}          [opts.projectRoot]  - Defaults to process.cwd().
 * @param {string}          [opts.runId]        - If set, reconcile only that run.
 *                                                If omitted, reconciles the most-recent run.
 * @param {string|null}     [opts.sharedDir]    - Shared patterns dir. When omitted,
 *                                                resolved automatically via getSharedPatternsDir()
 *                                                (reads federation config + ORCHESTRAY_TEST_SHARED_DIR).
 *                                                Pass null explicitly to disable shared-tier checks.
 * @returns {{
 *   ok:        boolean,
 *   runId:     string|null,
 *   checked:   number,
 *   repaired:  Array<{ detail: string, tombstone: object }>,
 *   flagged:   Array<{ detail: string, tombstone: object }>,
 *   skipped:   number,
 *   errors:    string[],
 * }}
 */
function reconcile(opts) {
  const projectRoot = (opts && opts.projectRoot) || process.cwd();
  const runIdFilter = (opts && opts.runId) || null;

  // Resolve sharedDir: explicit option > federation config (includes ORCHESTRAY_TEST_SHARED_DIR) > null.
  const sharedDir = (opts && opts.sharedDir !== undefined)
    ? opts.sharedDir
    : getSharedPatternsDir();

  const result = {
    ok:       true,
    runId:    null,
    checked:  0,
    repaired: [],
    flagged:  [],
    skipped:  0,
    errors:   [],
  };

  // Load tombstones.
  let tombstoneData;
  try {
    tombstoneData = listTombstones({ projectRoot, include_archive: true });
  } catch (err) {
    result.ok = false;
    result.errors.push('Failed to load tombstones: ' + (err && err.message));
    return result;
  }

  const { rows, run_ids } = tombstoneData;

  if (!rows || rows.length === 0) {
    // Nothing to reconcile.
    return result;
  }

  // Determine which run to check.
  let targetRunId = runIdFilter;
  if (!targetRunId) {
    // Most-recent run: highest run_id lexicographically.
    if (run_ids && run_ids.length > 0) {
      targetRunId = run_ids.reduce((a, b) => (a > b ? a : b));
    }
  }

  if (!targetRunId) {
    return result;
  }

  result.runId = targetRunId;

  // Filter rows to target run, excluding already-rolled-back rows.
  const targetRows = rows.filter(r => r.orch_id === targetRunId);

  for (const row of targetRows) {
    result.checked++;
    let check;
    try {
      check = _verifyOne(row, { projectRoot, sharedDir });
    } catch (err) {
      result.errors.push(
        'Unexpected error verifying action_id=' + (row.action_id || '?') +
        ': ' + (err && err.message)
      );
      result.ok = false;
      continue;
    }

    if (check.status === 'repaired') {
      result.repaired.push({ detail: check.detail, tombstone: row });
    } else if (check.status === 'flagged') {
      result.flagged.push({ detail: check.detail, tombstone: row });
      result.ok = false;
    } else if (check.status === 'skipped') {
      result.skipped++;
    }
    // 'ok' results are counted in checked but not added to separate arrays.
  }

  if (result.flagged.length > 0) {
    recordDegradation({
      kind: 'curator_reconcile_flagged',
      severity: 'warn',
      projectRoot,
      detail: {
        run_id: result.runId,
        flagged_count: result.flagged.length,
        sample: result.flagged[0] && result.flagged[0].detail
          ? String(result.flagged[0].detail).slice(0, 200)
          : null,
        dedup_key: 'curator_reconcile_flagged|' + (result.runId || 'null'),
      },
    });
  }

  return result;
}

module.exports = { reconcile, _internal: { _verifyOne, _isDeprecated } };
