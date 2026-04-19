'use strict';

/**
 * Per-(orchestration_id, task_id, tool_name) call counter.
 *
 * Backed by an append-only JSONL ledger at
 * .orchestray/state/mcp-tool-counts.jsonl.
 *
 * Each record:
 *   { ts, orchestration_id, task_id, tool_name }
 *
 * Public API:
 *
 *   checkLimit(params, projectRoot, config)
 *     Read-only pre-check. Returns { exceeded, count, maxAllowed }.
 *     Does NOT write to the ledger.
 *
 *   recordSuccess(params, projectRoot, config)
 *     Called AFTER a successful handler outcome. Appends the count row.
 *
 *   bumpAndCheck(params, projectRoot, config)  [DEPRECATED]
 *     Calls checkLimit + recordSuccess together (single-call path).
 *     Kept for simple handlers that don't need the split. New callers
 *     should use checkLimit / recordSuccess explicitly.
 *
 * Fail-open / fail-closed contract (F02 fix):
 *   - When maxAllowed is null (informational query), ledger oversize -> fail-open
 *     (return exceeded: false, count: 0) so informational paths are not blocked.
 *   - When maxAllowed is set (enforcement mode), ledger oversize -> fail-CLOSED
 *     (return exceeded: true, reason: 'ledger-oversize') so a padded ledger
 *     cannot bypass rate-limiting.
 *
 * Ledger rotation (F02 bundled):
 *   When appendRecord detects the ledger has crossed MAX_COUNTS_READ during
 *   a write, it best-effort rotates the file to
 *   mcp-tool-counts.jsonl.archived-<timestamp> and starts a fresh file.
 *   Any rotation error falls back to appending to the original file.
 *
 * F06 fix: counter increments on successful outcome (recordSuccess), not on
 * attempt (checkLimit), so timeouts and validation failures don't consume quota.
 *
 * Per v2016-release-plan.md §W6.
 */

const fs = require('node:fs');
const path = require('node:path');

const COUNTS_FILE = '.orchestray/state/mcp-tool-counts.jsonl';

// Maximum bytes to read from the counts ledger before switching strategy.
const MAX_COUNTS_READ = 1 * 1024 * 1024; // 1 MB

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

// Lazy-required to avoid circular-dependency risks at module load time.
let _loadMcpServerConfig = null;
function _getLoader() {
  if (!_loadMcpServerConfig) {
    _loadMcpServerConfig = require('../../_lib/config-schema').loadMcpServerConfig;
  }
  return _loadMcpServerConfig;
}

/**
 * Read the max_per_task value for a given tool from the loaded server config.
 *
 * Preferred shape: config is a raw server config object that contains a
 * `_max_per_task_validated` key (set by callers that pre-loaded via
 * loadMcpServerConfig).  Falls back to reading config.mcp_server.max_per_task
 * directly for callers that pass a raw config object (backwards compat).
 *
 * Returns null (unlimited) when the key is absent or malformed.
 *
 * @param {object|null} config     - The loaded server config (or null)
 * @param {string}      toolName   - The tool name to look up
 * @param {string}      [cwd]      - Project root; if supplied, uses loadMcpServerConfig
 *                                   for the validated shape instead of raw config.
 * @returns {number|null}
 */
function readMaxPerTask(config, toolName, cwd) {
  try {
    // Path 1: caller supplies cwd → use the validated loader (preferred).
    if (cwd && typeof cwd === 'string') {
      try {
        const loader = _getLoader();
        const validated = loader(cwd);
        const v = validated[toolName];
        if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
        return null;
      } catch (_) {
        // Fall through to direct-read path on any loader error.
      }
    }

    // Path 2: direct-read fallback for callers passing a raw config object.
    if (!config || !config.mcp_server) return null;
    const mpt = config.mcp_server.max_per_task;
    if (!mpt || typeof mpt !== 'object' || Array.isArray(mpt)) return null;
    const v = mpt[toolName];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
    return null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

/**
 * Read all count records from the ledger.
 *
 * When maxAllowed is non-null (enforcement mode) and the ledger is oversize,
 * returns { oversize: true } so the caller can fail closed.
 * When maxAllowed is null (informational) and the ledger is oversize, returns
 * [] so the caller can fail open.
 *
 * On any other filesystem error, returns [] (fail-open).
 *
 * @param {string}      ledgerPath  - Absolute path to mcp-tool-counts.jsonl
 * @param {number|null} maxAllowed  - Enforcement limit, or null for info-only
 * @returns {object[] | { oversize: true }}
 */
function readLedger(ledgerPath, maxAllowed) {
  let raw;
  try {
    const stat = fs.statSync(ledgerPath);
    if (stat.size > MAX_COUNTS_READ) {
      if (maxAllowed !== null && maxAllowed !== undefined) {
        // Enforcement mode: fail closed — a padded ledger must not bypass limits.
        process.stderr.write(
          '[orchestray-mcp] tool-counts: ledger exceeds ' + MAX_COUNTS_READ +
          ' bytes — rate-limit enforcement failing closed. ' +
          'Run GC to rotate the ledger and restore normal operation.\n'
        );
        return { oversize: true };
      }
      // Informational mode: fail open.
      return [];
    }
    raw = fs.readFileSync(ledgerPath, 'utf8');
  } catch (_e) {
    return [];
  }

  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        records.push(obj);
      }
    } catch (_e) {
      // Malformed line — skip silently
    }
  }
  return records;
}

/**
 * Attempt best-effort rotation of the ledger file when it has crossed
 * MAX_COUNTS_READ. Moves the existing file to
 * <ledgerPath>.archived-<timestamp> and creates a fresh empty file.
 *
 * If rotation fails for any reason, falls back silently so the caller
 * can continue with a normal append. Never throws.
 *
 * @param {string} ledgerPath
 */
function _attemptRotation(ledgerPath) {
  try {
    const ts = Date.now();
    const archivePath = ledgerPath + '.archived-' + ts;
    fs.renameSync(ledgerPath, archivePath);
    // Fresh file will be created on the next appendFileSync call.
  } catch (_e) {
    // Rotation failed — silently continue with append to original.
  }
}

/**
 * Append a single count record to the ledger. Creates the parent directory
 * if absent. When the ledger crosses MAX_COUNTS_READ during this append,
 * best-effort rotates the file first, then appends to the new file.
 * Fail-open: swallows all errors.
 *
 * @param {string} ledgerPath - Absolute path to mcp-tool-counts.jsonl
 * @param {object} record
 */
function appendRecord(ledgerPath, record) {
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

    // Check size before appending; if already oversize, rotate first.
    try {
      const stat = fs.statSync(ledgerPath);
      if (stat.size > MAX_COUNTS_READ) {
        _attemptRotation(ledgerPath);
      }
    } catch (_e) {
      // File may not exist yet — that's fine.
    }

    fs.appendFileSync(ledgerPath, JSON.stringify(record) + '\n', 'utf8');
  } catch (_e) {
    // Fail-open: swallow write error
  }
}

/**
 * Count how many times (orchestration_id, task_id, tool_name) appears in the
 * ledger records.
 *
 * @param {object[]} records
 * @param {string} orchestrationId
 * @param {string} taskId
 * @param {string} toolName
 * @returns {number}
 */
function countCalls(records, orchestrationId, taskId, toolName) {
  let n = 0;
  for (const r of records) {
    if (
      r.orchestration_id === orchestrationId &&
      r.task_id === taskId &&
      r.tool_name === toolName
    ) {
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Public API — split: checkLimit / recordSuccess
// ---------------------------------------------------------------------------

/**
 * Read-only pre-check: does NOT write to the ledger.
 *
 * Returns the current count and whether the limit has been reached.
 * Callers should invoke this before running the handler, and only call
 * recordSuccess when the handler completes successfully.
 *
 * @param {object} params
 *   @param {string} params.orchestration_id
 *   @param {string} params.task_id
 *   @param {string} params.tool_name
 * @param {string}      projectRoot  - Absolute path to project root
 * @param {object|null} config       - The loaded server config (or null)
 * @returns {{ exceeded: boolean, count: number|string, maxAllowed: number|null, reason?: string }}
 */
function checkLimit(params, projectRoot, config) {
  const { orchestration_id: orchId, task_id: taskId, tool_name: toolName } = params;

  // Validate required params — fail-open on bad input
  if (
    typeof orchId !== 'string' || orchId.length === 0 ||
    typeof taskId !== 'string' || taskId.length === 0 ||
    typeof toolName !== 'string' || toolName.length === 0
  ) {
    return { exceeded: false, count: 0, maxAllowed: null };
  }

  const maxAllowed = readMaxPerTask(config, toolName);

  // When max is null (unlimited), skip ledger I/O entirely.
  if (maxAllowed === null) {
    return { exceeded: false, count: 0, maxAllowed: null };
  }

  const ledgerPath = path.join(projectRoot, COUNTS_FILE);

  // Read ledger (enforcement mode — fails closed on oversize).
  const records = readLedger(ledgerPath, maxAllowed);
  if (records && records.oversize === true) {
    return { exceeded: true, count: 'unknown', maxAllowed, reason: 'ledger-oversize' };
  }

  const count = countCalls(records, orchId, taskId, toolName);

  if (count >= maxAllowed) {
    return { exceeded: true, count, maxAllowed };
  }

  return { exceeded: false, count, maxAllowed };
}

/**
 * Called AFTER a successful handler outcome. Appends the count row to the
 * ledger. Does NOT check the limit.
 *
 * @param {object} params
 *   @param {string} params.orchestration_id
 *   @param {string} params.task_id
 *   @param {string} params.tool_name
 * @param {string}      projectRoot  - Absolute path to project root
 * @param {object|null} config       - The loaded server config (or null)
 * @returns {void}
 */
function recordSuccess(params, projectRoot, config) {
  const { orchestration_id: orchId, task_id: taskId, tool_name: toolName } = params;

  // Validate required params — silently skip on bad input
  if (
    typeof orchId !== 'string' || orchId.length === 0 ||
    typeof taskId !== 'string' || taskId.length === 0 ||
    typeof toolName !== 'string' || toolName.length === 0
  ) {
    return;
  }

  const maxAllowed = readMaxPerTask(config, toolName);

  // When max is null (unlimited), skip ledger I/O entirely.
  if (maxAllowed === null) {
    return;
  }

  const ledgerPath = path.join(projectRoot, COUNTS_FILE);

  const record = {
    ts: new Date().toISOString(),
    orchestration_id: orchId,
    task_id: taskId,
    tool_name: toolName,
  };
  appendRecord(ledgerPath, record);
}

// ---------------------------------------------------------------------------
// Deprecated: bumpAndCheck (single-call path for simple handlers)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use checkLimit() + recordSuccess() instead.
 *
 * Combines checkLimit and recordSuccess in one call: checks the limit first,
 * and if not exceeded, appends the count record.
 *
 * Kept as a convenience for simple handlers that don't need the split API.
 * New callers should use checkLimit/recordSuccess directly so the counter
 * only increments on successful outcomes.
 *
 * @param {object} params
 *   @param {string} params.orchestration_id
 *   @param {string} params.task_id
 *   @param {string} params.tool_name
 * @param {string}      projectRoot  - Absolute path to project root
 * @param {object|null} config       - The loaded server config (or null)
 * @returns {{ exceeded: boolean, count?: number|string, max?: number, reason?: string }}
 */
function bumpAndCheck(params, projectRoot, config) {
  const limitResult = checkLimit(params, projectRoot, config);
  if (limitResult.exceeded) {
    return {
      exceeded: true,
      count: limitResult.count,
      max: limitResult.maxAllowed,
      reason: limitResult.reason,
    };
  }

  // Not exceeded: record the call.
  recordSuccess(params, projectRoot, config);

  return { exceeded: false };
}

module.exports = {
  checkLimit,
  recordSuccess,
  bumpAndCheck,
  // Exported for testing
  readMaxPerTask,
  readLedger,
  countCalls,
  COUNTS_FILE,
  MAX_COUNTS_READ,
};
