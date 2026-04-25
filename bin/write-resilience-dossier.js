#!/usr/bin/env node
'use strict';

/**
 * Stop / SubagentStop hook — write the resilience dossier.
 *
 * Reads `.orchestray/state/orchestration.md`, `task-graph.md`, tasks/, MCP
 * checkpoints and a tail of `audit/events.jsonl`, then atomically writes
 * `.orchestray/state/resilience-dossier.json`. This is the snapshot the PM
 * re-hydrates from after auto-compaction (see W3 design §A1 / §B).
 *
 * Also exposes `writeDossierSnapshot(cwd)` so `pre-compact-archive.js` can
 * call it as a belt-and-suspenders pass before the context window is replaced
 * by a summary.
 *
 * Contract:
 *   - Never throws (fail-open). Any error → journal + exit 0.
 *   - Respects `ORCHESTRAY_RESILIENCE_DISABLED=1` kill switch.
 *   - Respects `resilience.enabled` and `resilience.kill_switch` config keys.
 *   - Emits `dossier_written` (or `dossier_write_failed`) audit event.
 *
 * Design: v217-compaction-resilience-design.md §A1, §B3, §E1.
 */

const fs = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { writeEvent } = require('./_lib/audit-event-writer');
const { recordDegradation } = require('./_lib/degraded-journal');
const { loadResilienceConfig } = require('./_lib/config-schema');
const { readFileBounded } = require('./_lib/file-read-bounded');

const {
  buildDossier,
  serializeDossier,
  atomicWriteDossier,
  MAX_BYTES,
} = require('./_lib/resilience-dossier-schema');

// ---------------------------------------------------------------------------
// Public helper — called by pre-compact-archive.js
// ---------------------------------------------------------------------------

/**
 * Read disk state, build a dossier, and write it atomically. Never throws.
 *
 * Returns `{ written: boolean, reason?: string, size_bytes?: number }`.
 *
 * @param {string} cwd - Project root (absolute).
 * @param {object} [opts]
 * @param {string} [opts.trigger] - For audit event: 'stop'|'subagent_stop'|'pre_compact'
 * @returns {{ written: boolean, reason?: string, size_bytes?: number,
 *              truncation_flags?: string[], orchestration_id?: string|null }}
 */
function writeDossierSnapshot(cwd, opts) {
  const trigger = (opts && opts.trigger) || 'unknown';
  try {
    // Kill switch: env var takes precedence over config.
    if (process.env.ORCHESTRAY_RESILIENCE_DISABLED === '1') {
      return { written: false, reason: 'env_kill_switch' };
    }

    const cfg = loadResilienceConfig(cwd);
    if (!cfg.enabled || cfg.kill_switch) {
      return { written: false, reason: 'config_disabled' };
    }

    const orchestrayDir = path.join(cwd, '.orchestray');
    if (!_dirExists(orchestrayDir)) {
      return { written: false, reason: 'no_orchestray_dir' };
    }

    const stateDir = path.join(orchestrayDir, 'state');
    const auditDir = path.join(orchestrayDir, 'audit');

    // If there is no active orchestration marker AND no orchestration.md, skip.
    const orchPath = path.join(stateDir, 'orchestration.md');
    const markerPath = getCurrentOrchestrationFile(cwd);
    if (!_fileExists(orchPath) && !_fileExists(markerPath)) {
      return { written: false, reason: 'no_active_orchestration' };
    }

    // --- Gather sources ---
    const sources = {
      orchestration: _readOrchestrationFrontmatter(orchPath),
      task_ids: _readTaskIds(path.join(stateDir, 'tasks')),
      cost: _readCost(markerPath, cwd),
      events_tail: _readEventsTail(path.join(auditDir, 'events.jsonl'), 50),
      mcp_checkpoints: _readMcpCheckpoints(path.join(stateDir, 'mcp-checkpoint.jsonl'), cwd),
      routing_tail: _readRoutingTail(path.join(stateDir, 'routing.jsonl'), 20, cwd),
      last_compact_detected_at: _readLastCompactAt(path.join(stateDir, 'compact-signal.lock')),
      ingested_counter: 0, // injector maintains; writer leaves at 0 here
      planning_inputs: null, // scraped opportunistically below
      drift_invariants: _readDriftInvariants(path.join(stateDir, 'drift-invariants.jsonl'), cwd),
    };

    // Orchestration marker may carry orchestration_id when orchestration.md lacks it.
    if (!sources.orchestration.id) {
      try {
        // SEC-04 / LOW-R2-01: belt-and-suspenders guard; use bounded fd-based read.
        const MAX_MARKER_BYTES = 256 * 1024;
        const mRes = readFileBounded(markerPath, MAX_MARKER_BYTES);
        if (mRes.ok) {
          const m = JSON.parse(mRes.content);
          if (m && typeof m.orchestration_id === 'string') {
            sources.orchestration.id = m.orchestration_id;
          }
        } else if (mRes.reason === 'file_too_large') {
          recordDegradation({ kind: 'file_too_large', severity: 'warn', projectRoot: cwd,
            detail: { file: markerPath, size_hint: mRes.size_hint, cap_bytes: MAX_MARKER_BYTES } });
        } else {
          recordDegradation({ kind: 'file_read_failed', severity: 'warn', projectRoot: cwd,
            detail: { file: markerPath, err: mRes.err } });
        }
      } catch (_e) { /* swallow JSON.parse errors */ }
    }

    // --- Build + serialize ---
    // Pass cwd so buildDossier can journal dossier_field_sanitised on any dropped fields.
    const dossier = buildDossier(sources, cwd);
    const { serialized, size_bytes, truncation_flags, dropped } = serializeDossier(dossier);
    if (size_bytes > MAX_BYTES) {
      recordDegradation({
        kind: 'dossier_oversize_truncated',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          size_bytes,
          dropped: (dropped || []).slice(0, 5).join(','),
          dedup_key: 'dossier_oversize_truncated|' + (sources.orchestration.id || 'unknown'),
        },
      });
    }

    // --- Atomic write ---
    const dossierPath = path.join(stateDir, 'resilience-dossier.json');
    const writeResult = atomicWriteDossier(dossierPath, serialized);
    if (!writeResult.ok) {
      const errCode = (writeResult.err && writeResult.err.code) || writeResult.reason || 'unknown';
      recordDegradation({
        kind: 'dossier_write_failed',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          err_code: errCode,
          size_attempted: size_bytes,
          trigger,
          dedup_key: 'dossier_write_failed|' + (sources.orchestration.id || 'unknown') + '|' + errCode,
        },
      });
      return { written: false, reason: 'write_failed' };
    }

    // --- Audit event ---
    _emitAuditEvent(auditDir, {
      type: 'dossier_written',
      orchestration_id: sources.orchestration.id || null,
      size_bytes,
      phase: dossier.phase,
      status: dossier.status,
      pending_count: dossier.pending_task_ids.length,
      completed_count: dossier.completed_task_ids.length,
      truncation_flags,
      trigger,
    });

    return {
      written: true,
      size_bytes,
      truncation_flags,
      orchestration_id: sources.orchestration.id || null,
    };
  } catch (err) {
    // Top-level safety net — should not be reachable.
    try {
      recordDegradation({
        kind: 'dossier_write_failed',
        severity: 'warn',
        projectRoot: cwd,
        detail: {
          err_code: (err && err.code) || 'throw',
          err_msg: String(err && err.message || err).slice(0, 80),
          trigger,
          dedup_key: 'dossier_write_failed|' + trigger + '|' + ((err && err.code) || 'throw'),
        },
      });
    } catch (_e) { /* swallow */ }
    return { written: false, reason: 'exception' };
  }
}

// ---------------------------------------------------------------------------
// Source readers — all fail-soft (return empty/null on any error)
// ---------------------------------------------------------------------------

function _readOrchestrationFrontmatter(orchPath) {
  const out = {
    id: null,
    phase: null,
    current_phase: null,
    status: null,
    complexity_score: 0,
    delegation_pattern: null,
    current_group_id: null,
    replan_count: 0,
    compact_trigger: null,
  };
  try {
    const raw = fs.readFileSync(orchPath, 'utf8');
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return out;
    const fm = match[1];
    for (const line of fm.split(/\r?\n/)) {
      const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
      if (!mm) continue;
      const key = mm[1];
      let val = mm[2].trim();
      // Strip surrounding quotes
      if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
        val = val.slice(1, -1);
      }
      if (key === 'id') out.id = val || null;
      else if (key === 'current_phase' || key === 'phase') {
        out.phase = val;
        out.current_phase = val;
      }
      else if (key === 'status') out.status = val;
      else if (key === 'complexity_score') {
        const n = parseInt(val, 10);
        if (Number.isInteger(n)) out.complexity_score = n;
      }
      else if (key === 'delegation_pattern') out.delegation_pattern = val;
      else if (key === 'current_group_id') out.current_group_id = val;
      else if (key === 'replan_count') {
        const n = parseInt(val, 10);
        if (Number.isInteger(n)) out.replan_count = n;
      }
      else if (key === 'compact_trigger') out.compact_trigger = val;
    }
  } catch (_e) { /* swallow */ }
  return out;
}

function _readTaskIds(tasksDir) {
  const out = { pending: [], completed: [], failed: [] };
  try {
    if (!_dirExists(tasksDir)) return out;
    const entries = fs.readdirSync(tasksDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      const parent = entry.parentPath || entry.path;
      const full = path.join(parent, entry.name);
      let raw;
      try { raw = fs.readFileSync(full, 'utf8'); } catch (_e) { continue; }
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fm) continue;
      let id = null;
      let status = null;
      for (const line of fm[1].split(/\r?\n/)) {
        const mm = line.match(/^([a-z_]+):\s*(.*)$/i);
        if (!mm) continue;
        const key = mm[1];
        let val = mm[2].trim();
        if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
          val = val.slice(1, -1);
        }
        if (key === 'id' || key === 'task_id') id = val || null;
        if (key === 'status') status = val;
      }
      if (!id) {
        // Derive id from filename: "01-slug.md" → "01"
        const m2 = entry.name.match(/^([^.]+)\.md$/);
        if (m2) id = m2[1];
      }
      if (!id) continue;
      if (status === 'completed' || status === 'success') out.completed.push(id);
      else if (status === 'failed' || status === 'failure') out.failed.push(id);
      else if (status === 'in_progress' || status === 'pending' || !status) out.pending.push(id);
    }
  } catch (_e) { /* swallow */ }
  return out;
}

function _readCost(markerPath, cwd) {
  const out = { so_far_usd: null, budget_usd: null };
  // SEC-04 / LOW-R2-01: bounded fd-based read eliminates stat→read TOCTOU.
  const MAX_COST_BYTES = 256 * 1024;
  try {
    const readResult = readFileBounded(markerPath, MAX_COST_BYTES);
    if (!readResult.ok) {
      if (readResult.reason === 'file_too_large') {
        recordDegradation({ kind: 'file_too_large', severity: 'warn', projectRoot: cwd,
          detail: { file: markerPath, size_hint: readResult.size_hint, cap_bytes: MAX_COST_BYTES } });
      } else {
        recordDegradation({ kind: 'file_read_failed', severity: 'warn', projectRoot: cwd,
          detail: { file: markerPath, err: readResult.err } });
      }
      return out;
    }
    const raw = readResult.content;
    const m = JSON.parse(raw);
    if (m && typeof m.cost_so_far_usd === 'number') out.so_far_usd = m.cost_so_far_usd;
    if (m && typeof m.cost_budget_usd === 'number') out.budget_usd = m.cost_budget_usd;
  } catch (_e) { /* swallow */ }
  return out;
}

function _readEventsTail(eventsPath, n) {
  try {
    if (!_fileExists(eventsPath)) return [];
    // Tail read — last 128 KB is plenty for n=50 events.
    const st = fs.statSync(eventsPath);
    const MAX = 128 * 1024;
    let raw;
    if (st.size > MAX) {
      const fd = fs.openSync(eventsPath, 'r');
      try {
        const buf = Buffer.alloc(MAX);
        fs.readSync(fd, buf, 0, MAX, st.size - MAX);
        raw = buf.toString('utf8');
      } finally { fs.closeSync(fd); }
    } else {
      raw = fs.readFileSync(eventsPath, 'utf8');
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try { out.unshift(JSON.parse(lines[i])); } catch (_e) { continue; }
    }
    return out;
  } catch (_e) { return []; }
}

function _readMcpCheckpoints(cpPath, cwd) {
  // SEC-04 / LOW-R2-01: bounded fd-based read eliminates stat→read TOCTOU.
  const MAX_MCP_BYTES = 256 * 1024;
  try {
    if (!_fileExists(cpPath)) return [];
    const readResult = readFileBounded(cpPath, MAX_MCP_BYTES);
    if (!readResult.ok) {
      if (readResult.reason === 'file_too_large') {
        recordDegradation({ kind: 'file_too_large', severity: 'warn', projectRoot: cwd,
          detail: { file: cpPath, size_hint: readResult.size_hint, cap_bytes: MAX_MCP_BYTES } });
      } else {
        recordDegradation({ kind: 'file_read_failed', severity: 'warn', projectRoot: cwd,
          detail: { file: cpPath, err: readResult.err } });
      }
      return [];
    }
    const raw = readResult.content;
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_e) { continue; }
    }
    // Only keep outstanding (no consumed_at), tail-biased.
    const outstanding = out.filter((r) => r && !r.consumed_at);
    return outstanding.slice(-20);
  } catch (_e) { return []; }
}

function _readRoutingTail(routingPath, n, cwd) {
  // SEC-04 / LOW-R2-01: bounded fd-based read eliminates stat→read TOCTOU.
  const MAX_ROUTING_BYTES = 4 * 1024 * 1024;
  try {
    if (!_fileExists(routingPath)) return [];
    const readResult = readFileBounded(routingPath, MAX_ROUTING_BYTES);
    if (!readResult.ok) {
      if (readResult.reason === 'file_too_large') {
        recordDegradation({ kind: 'file_too_large', severity: 'warn', projectRoot: cwd,
          detail: { file: routingPath, size_hint: readResult.size_hint, cap_bytes: MAX_ROUTING_BYTES } });
      } else {
        recordDegradation({ kind: 'file_read_failed', severity: 'warn', projectRoot: cwd,
          detail: { file: routingPath, err: readResult.err } });
      }
      return [];
    }
    const raw = readResult.content;
    const lines = raw.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = Math.max(0, lines.length - n); i < lines.length; i++) {
      try { out.push(JSON.parse(lines[i])); } catch (_e) { continue; }
    }
    return out;
  } catch (_e) { return []; }
}

function _readLastCompactAt(lockPath) {
  try {
    if (!_fileExists(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const m = JSON.parse(raw);
    if (m && typeof m.at === 'string') return m.at;
  } catch (_e) { /* swallow */ }
  return null;
}

function _readDriftInvariants(driftPath, cwd) {
  // SEC-04 / LOW-R2-01: bounded fd-based read eliminates stat→read TOCTOU.
  const MAX_DRIFT_BYTES = 256 * 1024;
  try {
    if (!_fileExists(driftPath)) return [];
    const readResult = readFileBounded(driftPath, MAX_DRIFT_BYTES);
    if (!readResult.ok) {
      if (readResult.reason === 'file_too_large') {
        recordDegradation({ kind: 'file_too_large', severity: 'warn', projectRoot: cwd,
          detail: { file: driftPath, size_hint: readResult.size_hint, cap_bytes: MAX_DRIFT_BYTES } });
      } else {
        recordDegradation({ kind: 'file_read_failed', severity: 'warn', projectRoot: cwd,
          detail: { file: driftPath, err: readResult.err } });
      }
      return [];
    }
    const raw = readResult.content;
    const lines = raw.split('\n').filter((l) => l.trim());
    const out = [];
    for (let i = Math.max(0, lines.length - 5); i < lines.length; i++) {
      try {
        const row = JSON.parse(lines[i]);
        if (row && typeof row.invariant === 'string') out.push(row.invariant);
      } catch (_e) { continue; }
    }
    return out;
  } catch (_e) { return []; }
}

function _emitAuditEvent(auditDir, payload) {
  try {
    if (!_dirExists(auditDir)) return;
    const evt = Object.assign({ timestamp: new Date().toISOString() }, payload);
    // auditDir is `<cwd>/.orchestray/audit`; derive cwd two levels up so the
    // gateway resolves the same target file.
    const cwd = path.resolve(auditDir, '..', '..');
    writeEvent(evt, { cwd });
  } catch (_e) { /* swallow */ }
}

function _fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch (_e) { return false; }
}
function _dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_e) { return false; }
}

// ---------------------------------------------------------------------------
// Hook entry point (Stop / SubagentStop)
// ---------------------------------------------------------------------------

function _isHookInvocation() {
  // Stdin is piped when invoked by Claude Code hook infrastructure.
  // In library mode (pre-compact-archive import), module.parent is set.
  return require.main === module;
}

if (_isHookInvocation()) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_e) {}
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      try {
        process.stderr.write('[orchestray] write-resilience-dossier: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
        process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      } catch (_e) {}
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try { event = JSON.parse(input || '{}'); } catch (_e) { event = {}; }
    const cwd = resolveSafeCwd(event.cwd);
    const hookName = event.hook_event_name || '';
    const trigger = hookName === 'SubagentStop' ? 'subagent_stop'
      : hookName === 'Stop' ? 'stop'
      : hookName === 'PreCompact' ? 'pre_compact'
      : 'unknown';
    writeDossierSnapshot(cwd, { trigger });
    try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_e) {}
    process.exit(0);
  });
}

module.exports = {
  writeDossierSnapshot,
  // Exported for unit tests.
  _readOrchestrationFrontmatter,
  _readTaskIds,
  _readCost,
  _readEventsTail,
};
