#!/usr/bin/env node
'use strict';

/**
 * validate-task-contracts.js — PreToolUse:Agent + PostToolUse:Agent hook.
 *
 * v2.2.11 W3-1: Contracts block validator for task YAML files.
 *
 * Activates on Agent tool calls. For each spawned agent, looks up the
 * corresponding task YAML (via `tool_input.task_id`) and validates the
 * `contracts:` block if present.
 *
 * PreToolUse:Agent (phase: "pre"):
 *   - Loads and validates the contracts block syntax.
 *   - Runs precondition checks (file_exists, file_contains, file_size_*).
 *   - Emits `contract_check` event (existing schema) or `contract_check_skipped`
 *     (when no contracts block is present) or `contracts_parse_failed`
 *     (when the block is malformed).
 *   - Exit 0 always in v2.2.11 (soft-block-warn per W4b §2.4; v2.2.13 hard-fail).
 *
 * PostToolUse:Agent (phase: "post"):
 *   - Validates postconditions.
 *   - Checks file ownership by reading `files_changed` from the agent's
 *     structured result and comparing to `contracts.file_ownership.write_allowed`.
 *   - Emits `file_ownership_violation` for each disallowed write.
 *   - Exit 0 always in v2.2.11 (soft-block-warn; v2.2.13 hard-fail).
 *
 * Kill switch: ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED=1 suppresses all emits
 * and exits 0 on every path.
 *
 * Missing contracts block: emits `contract_check_skipped` once per task
 * (telemetry only in v2.2.11; becomes hard-fail in v2.2.13).
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }      = require('./_lib/resolve-project-cwd');
const { writeEvent }          = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }     = require('./_lib/constants');
const { recordDegradation }   = require('./_lib/degraded-journal');
const { peekOrchestrationId } = require('./_lib/peek-orchestration-id');
const { loadTaskYaml, matchGlob } = require('./_lib/load-task-yaml');

// ---------------------------------------------------------------------------
// Noise allow-list: paths excluded from ownership checks to prevent
// false-positives on auto-generated / telemetry files (W4b §2.3).
// ---------------------------------------------------------------------------
const OWNERSHIP_NOISE_PATHS = new Set([
  'package-lock.json',
  '.orchestray/audit/events.jsonl',
  '.orchestray/state/orchestration.md',
]);

// ---------------------------------------------------------------------------
// Condition check types supported in v2.2.11
// ---------------------------------------------------------------------------
const SUPPORTED_CHECK_TYPES = new Set([
  'file_exists',
  'file_contains',
  'file_size_min_bytes',
  'file_size_max_bytes',
  'diff_only_in',
  'file_exports',
  'command_exits_zero',
]);

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    // Kill switch
    if (process.env.ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED === '1') {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    // Only activate on Agent tool calls
    const toolName = event.tool_name || '';
    if (toolName !== 'Agent') {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    const hookEventName = event.hook_event_name || event.hook_name || '';
    const isPost = hookEventName === 'PostToolUse' || event.hook_type === 'PostToolUse';

    try {
      if (isPost) {
        runPost(event, cwd);
      } else {
        runPre(event, cwd);
      }
    } catch (err) {
      // Fail-open on unexpected errors
      try {
        recordDegradation({
          kind: 'unknown_kind',
          severity: 'warn',
          projectRoot: cwd,
          detail: {
            hook: 'validate-task-contracts',
            err: String(err && err.message || err).slice(0, 200),
          },
        });
      } catch (_) { /* last resort */ }
    }

    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Pre-phase: load task YAML + run precondition checks
// ---------------------------------------------------------------------------

function runPre(event, cwd) {
  const taskId = resolveTaskId(event);
  if (!taskId) return;

  const orchId = peekOrchestrationId(cwd);
  const taskFilePath = resolveTaskFilePath(cwd, taskId);

  if (!taskFilePath) {
    // No task YAML found — emit skip
    emitSkipped(cwd, taskId, orchId, 'no_task_yaml');
    return;
  }

  let parsed;
  try {
    parsed = loadTaskYaml(taskFilePath);
  } catch (err) {
    // File read error
    emitSkipped(cwd, taskId, orchId, 'task_yaml_read_error');
    return;
  }

  if (!parsed.contracts) {
    if (parsed.error) {
      // Contracts block is present but malformed
      emitParseFailed(cwd, taskId, orchId, taskFilePath, parsed.error);
    } else {
      // No contracts block
      emitSkipped(cwd, taskId, orchId, 'no_contracts_block');
    }
    return;
  }

  // Run precondition checks
  const contracts = parsed.contracts;
  const preconditions = contracts.preconditions || [];
  const outputs = contracts.outputs || [];

  // Auto-promote outputs to file_exists postconditions (checked at pre phase
  // only as baseline — the real check is at post phase)
  const checks = runChecks(cwd, preconditions, 'pre');

  emitContractCheck(cwd, taskId, orchId, 'pre', checks);
}

// ---------------------------------------------------------------------------
// Post-phase: run postcondition checks + file ownership validation
// ---------------------------------------------------------------------------

function runPost(event, cwd) {
  const taskId = resolveTaskId(event);
  if (!taskId) return;

  const orchId = peekOrchestrationId(cwd);
  const taskFilePath = resolveTaskFilePath(cwd, taskId);

  if (!taskFilePath) {
    emitSkipped(cwd, taskId, orchId, 'no_task_yaml');
    return;
  }

  let parsed;
  try {
    parsed = loadTaskYaml(taskFilePath);
  } catch (err) {
    emitSkipped(cwd, taskId, orchId, 'task_yaml_read_error');
    return;
  }

  if (!parsed.contracts) {
    if (parsed.error) {
      emitParseFailed(cwd, taskId, orchId, taskFilePath, parsed.error);
    } else {
      emitSkipped(cwd, taskId, orchId, 'no_contracts_block');
    }
    return;
  }

  const contracts = parsed.contracts;
  const postconditions = contracts.postconditions || [];
  const outputs = contracts.outputs || [];

  // Auto-promote outputs to file_exists postconditions
  const autoChecks = outputs.map(o => ({ type: 'file_exists', target: o }));
  const allPostconditions = autoChecks.concat(postconditions);

  const checks = runChecks(cwd, allPostconditions, 'post');
  emitContractCheck(cwd, taskId, orchId, 'post', checks);

  // File ownership validation
  const fileOwnership = contracts.file_ownership;
  if (fileOwnership) {
    const filesChanged = extractFilesChanged(event);
    validateFileOwnership(cwd, taskId, orchId, fileOwnership, filesChanged,
      event.tool_input && event.tool_input.subagent_type || null);
  }
}

// ---------------------------------------------------------------------------
// Check runners
// ---------------------------------------------------------------------------

/**
 * Run an array of condition check objects and return results.
 *
 * @param {string}   cwd
 * @param {object[]} conditions - Array of {type, target, ...} objects.
 * @param {string}   phase      - "pre" or "post" (for logging only).
 * @returns {object[]} Array of {type, target, result, detail} objects.
 */
function runChecks(cwd, conditions, phase) {
  const results = [];
  for (const condition of conditions) {
    if (!condition || typeof condition !== 'object') continue;
    const { type, target } = condition;
    if (!SUPPORTED_CHECK_TYPES.has(type)) {
      results.push({ type: type || 'unknown', target: target || '', result: 'pass', detail: 'unsupported check type — skipped' });
      continue;
    }
    const result = runSingleCheck(cwd, condition);
    results.push(result);
  }
  return results;
}

/**
 * Run a single condition check and return {type, target, result, detail}.
 */
function runSingleCheck(cwd, condition) {
  const { type, target } = condition;
  const base = { type, target: String(target || '') };

  try {
    switch (type) {
      case 'file_exists': {
        const abs = path.resolve(cwd, target);
        const exists = fs.existsSync(abs);
        return { ...base, result: exists ? 'pass' : 'fail', detail: exists ? 'file exists' : 'file not found: ' + target };
      }
      case 'file_contains': {
        const abs = path.resolve(cwd, target);
        if (!fs.existsSync(abs)) {
          return { ...base, result: 'fail', detail: 'file not found: ' + target };
        }
        const raw = fs.readFileSync(abs, 'utf8');
        const pattern = condition.pattern;
        if (!pattern) return { ...base, result: 'pass', detail: 'no pattern specified' };
        let re;
        try { re = new RegExp(pattern, 'm'); } catch (e) {
          return { ...base, result: 'fail', detail: 'invalid pattern: ' + String(e.message).slice(0, 80) };
        }
        const found = re.test(raw);
        return { ...base, result: found ? 'pass' : 'fail', detail: found ? 'pattern matched' : 'pattern not found in file' };
      }
      case 'file_size_min_bytes': {
        const abs = path.resolve(cwd, target);
        if (!fs.existsSync(abs)) {
          return { ...base, result: 'fail', detail: 'file not found: ' + target };
        }
        const stat = fs.statSync(abs);
        const min = Number(condition.min_bytes) || 0;
        const ok = stat.size >= min;
        return { ...base, result: ok ? 'pass' : 'fail', detail: 'size ' + stat.size + ' bytes' + (ok ? '' : ' (min: ' + min + ')') };
      }
      case 'file_size_max_bytes': {
        const abs = path.resolve(cwd, target);
        if (!fs.existsSync(abs)) {
          return { ...base, result: 'fail', detail: 'file not found: ' + target };
        }
        const stat = fs.statSync(abs);
        const max = Number(condition.max_bytes) || Infinity;
        const ok = stat.size <= max;
        return { ...base, result: ok ? 'pass' : 'fail', detail: 'size ' + stat.size + ' bytes' + (ok ? '' : ' (max: ' + max + ')') };
      }
      case 'diff_only_in':
      case 'file_exports':
      case 'command_exits_zero':
        // Not implemented in v2.2.11 — pass through (informative only)
        return { ...base, result: 'pass', detail: 'check type ' + type + ' not implemented in v2.2.11 — skipped' };
      default:
        return { ...base, result: 'pass', detail: 'unknown check type — skipped' };
    }
  } catch (err) {
    return { ...base, result: 'fail', detail: 'check error: ' + String(err && err.message || err).slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// File ownership validation
// ---------------------------------------------------------------------------

/**
 * Extract files_changed paths from the PostToolUse event's tool_response.
 *
 * The structured result JSON (if present in tool_response) contains
 * `files_changed: [{path, description}, ...]`. We parse it best-effort.
 *
 * @param {object} event
 * @returns {string[]} Array of file paths written by the agent.
 */
function extractFilesChanged(event) {
  try {
    const toolResponse = event.tool_response;
    if (!toolResponse) return [];

    let responseStr = typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse);

    // Extract the ## Structured Result JSON block from the response text
    const srMatch = /##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i.exec(responseStr);
    if (srMatch) {
      const srJson = JSON.parse(srMatch[1]);
      if (srJson && Array.isArray(srJson.files_changed)) {
        return srJson.files_changed.map(f => {
          if (typeof f === 'string') return f;
          if (f && typeof f.path === 'string') return f.path;
          return null;
        }).filter(Boolean);
      }
    }

    // Fallback: look for files_changed in a JSON payload
    if (typeof toolResponse === 'object' && Array.isArray(toolResponse.files_changed)) {
      return toolResponse.files_changed.map(f => {
        if (typeof f === 'string') return f;
        if (f && typeof f.path === 'string') return f.path;
        return null;
      }).filter(Boolean);
    }
  } catch (_) { /* fail-open */ }
  return [];
}

/**
 * Validate file ownership: each written file must be in write_allowed and
 * must not be in write_forbidden.
 *
 * Emits one `file_ownership_violation` event per violating file.
 */
function validateFileOwnership(cwd, taskId, orchId, fileOwnership, filesChanged, agentType) {
  if (!Array.isArray(filesChanged) || filesChanged.length === 0) return;

  const writeAllowed  = Array.isArray(fileOwnership.write_allowed)  ? fileOwnership.write_allowed  : [];
  const writeForbidden = Array.isArray(fileOwnership.write_forbidden) ? fileOwnership.write_forbidden : [];

  for (const filePath of filesChanged) {
    // Skip noise paths
    const rel = filePath.replace(/\\/g, '/');
    if (OWNERSHIP_NOISE_PATHS.has(rel)) continue;

    // Check forbidden first (belt-and-suspenders — forbidden wins even if also allowed)
    const isForbidden = writeForbidden.some(pat => matchGlob(pat, rel));
    if (isForbidden) {
      emitOwnershipViolation(cwd, taskId, orchId, rel, writeAllowed, agentType, 'matches_forbidden');
      continue;
    }

    // Check allowed
    const isAllowed = writeAllowed.some(pat => {
      // Exact path match or glob
      return matchGlob(pat, rel) || (pat === rel);
    });
    if (!isAllowed) {
      emitOwnershipViolation(cwd, taskId, orchId, rel, writeAllowed, agentType, 'outside_allowed');
    }
  }
}

// ---------------------------------------------------------------------------
// Event emitters
// ---------------------------------------------------------------------------

function emitSkipped(cwd, taskId, orchId, skipReason) {
  if (process.env.ORCHESTRAY_CONTRACTS_MISSING_WARN_DISABLED === '1') return;
  try {
    writeEvent({
      type:           'contract_check_skipped',
      version:        1,
      orchestration_id: orchId || 'unknown',
      task_id:        taskId,
      skip_reason:    skipReason,
      schema_version: 1,
    }, { cwd });
  } catch (err) {
    _degradationFallback(cwd, 'emit contract_check_skipped', err);
  }
}

function emitParseFailed(cwd, taskId, orchId, filePath, parseError) {
  try {
    writeEvent({
      type:           'contracts_parse_failed',
      version:        1,
      orchestration_id: orchId || 'unknown',
      task_id:        taskId,
      parse_error:    String(parseError).slice(0, 200),
      file_path:      filePath,
      schema_version: 1,
    }, { cwd });
  } catch (err) {
    _degradationFallback(cwd, 'emit contracts_parse_failed', err);
  }
}

function emitContractCheck(cwd, taskId, orchId, phase, checks) {
  const passed   = checks.filter(c => c.result === 'pass').length;
  const failed   = checks.filter(c => c.result === 'fail').length;
  const overall  = failed === 0 ? 'pass' : (passed === 0 ? 'fail' : 'partial_fail');

  try {
    writeEvent({
      type:             'contract_check',
      orchestration_id: orchId || 'unknown',
      task_id:          taskId,
      phase,
      checks,
      overall,
    }, { cwd });
  } catch (err) {
    _degradationFallback(cwd, 'emit contract_check', err);
  }

  // v2.2.11 soft-block-warn: log to stderr but do not exit 2
  if (overall !== 'pass') {
    const failedChecks = checks.filter(c => c.result === 'fail');
    process.stderr.write(
      '[orchestray] validate-task-contracts: ' + phase + '-phase check WARN' +
      ' for task ' + taskId + ' — ' + failedChecks.length + ' check(s) failed. ' +
      '(soft-warn in v2.2.11; will hard-fail in v2.2.13)\n'
    );
  }
}

function emitOwnershipViolation(cwd, taskId, orchId, filePath, assignedFiles, agentType, violationKind) {
  try {
    writeEvent({
      type:             'file_ownership_violation',
      version:          1,
      orchestration_id: orchId || 'unknown',
      task_id:          taskId,
      agent_type:       agentType || null,
      file_path:        filePath,
      assigned_files:   assignedFiles,
      violation_kind:   violationKind,
      schema_version:   1,
    }, { cwd });
  } catch (err) {
    _degradationFallback(cwd, 'emit file_ownership_violation', err);
  }

  // v2.2.11 soft-block-warn
  process.stderr.write(
    '[orchestray] validate-task-contracts: file_ownership_violation — task ' +
    taskId + ' wrote ' + filePath +
    ' (' + violationKind + '). (soft-warn in v2.2.11; will hard-fail in v2.2.13)\n'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the task_id from the hook event.
 * PreToolUse: tool_input.task_id or tool_input.prompt-derived hint.
 * PostToolUse: same location.
 */
function resolveTaskId(event) {
  const ti = event.tool_input;
  if (ti && typeof ti.task_id === 'string' && ti.task_id.length > 0) return ti.task_id;
  // Fallback: try prompt body for `task_id:` declaration
  if (ti && typeof ti.prompt === 'string') {
    const m = /\btask_id\s*:\s*([^\s\n]+)/.exec(ti.prompt);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Find a task YAML file by task_id in the standard locations.
 * Returns the absolute path or null if not found.
 */
function resolveTaskFilePath(cwd, taskId) {
  const candidates = [
    path.join(cwd, '.orchestray', 'state', 'tasks', taskId + '.yaml'),
    path.join(cwd, '.orchestray', 'state', 'tasks', taskId + '.yml'),
    path.join(cwd, '.orchestray', 'state', 'tasks', taskId + '.md'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function _degradationFallback(cwd, context, err) {
  try {
    recordDegradation({
      kind:        'unknown_kind',
      severity:    'warn',
      projectRoot: cwd,
      detail: {
        hook:    'validate-task-contracts',
        context,
        err:     String(err && err.message || err).slice(0, 120),
      },
    });
  } catch (_) { /* last resort */ }
}

// ---------------------------------------------------------------------------
// Exports (for unit testing)
// ---------------------------------------------------------------------------
module.exports = {
  resolveTaskId,
  resolveTaskFilePath,
  validateFileOwnership,
  extractFilesChanged,
  runChecks,
  runSingleCheck,
  emitSkipped,
  emitParseFailed,
  emitContractCheck,
  emitOwnershipViolation,
};

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
if (require.main === module) {
  main();
}
