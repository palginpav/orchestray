'use strict';

/**
 * verify-fix-coverage.js — verify-fix coverage probe (v2.2.8 Item 2).
 *
 * Scans events.jsonl for a given orchestration_id and computes:
 *   - tasks_total:           distinct developer/refactorer agent_start events
 *   - tasks_with_verify_fix: how many of those had a matching verify_fix_start
 *   - ratio:                 tasks_with_verify_fix / tasks_total (0 when divisor is 0)
 *   - alert:                 "n/a_single_task" | "zero_coverage" | "below_threshold" | "ok"
 *
 * Returns the `verify_fix_coverage_report` event payload. Caller emits via
 * audit-event-writer.
 *
 * Bounded read: tail-scans last `scanBytes` bytes (default 5MB).
 * Fail-safe: all I/O wrapped in try/catch. Returns zero-count payload on error.
 */

const fs   = require('fs');
const path = require('path');

const DEFAULT_SCAN_BYTES = 5 * 1024 * 1024;

const DEVELOPER_AGENT_TYPES = new Set(['developer', 'refactorer']);

/**
 * Tail-read up to `maxBytes` from a file, returning the content as a string.
 * Returns '' on any I/O error.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {{ content: string, truncated: boolean }}
 */
function tailRead(filePath, maxBytes) {
  try {
    if (!fs.existsSync(filePath)) return { content: '', truncated: false };
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const readBytes = Math.min(fileSize, maxBytes);
    const offset = fileSize - readBytes;
    const fd = fs.openSync(filePath, 'r');
    let content;
    try {
      const buf = Buffer.alloc(readBytes);
      const bytesRead = fs.readSync(fd, buf, 0, readBytes, offset);
      content = buf.slice(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    return { content, truncated: offset > 0 };
  } catch (_e) {
    return { content: '', truncated: false };
  }
}

/**
 * Parse the tail-read content into an array of event objects belonging to
 * the given orchestration_id. Skips malformed lines silently.
 *
 * @param {string} content
 * @param {string} orchestrationId
 * @returns {object[]}
 */
function parseEvents(content, orchestrationId) {
  const events = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt && evt.orchestration_id === orchestrationId) {
        events.push(evt);
      }
    } catch (_e) { /* skip */ }
  }
  return events;
}

/**
 * Run the verify-fix coverage probe for an orchestration.
 *
 * @param {object} params
 * @param {string}  params.orchestrationId — the orchestration to probe
 * @param {string}  params.eventsPath      — absolute path to events.jsonl
 * @param {number}  [params.scanBytes]     — max bytes to scan (default 5MB)
 * @returns {object} verify_fix_coverage_report event payload
 */
function runVerifyFixCoverageProbe({ orchestrationId, eventsPath, scanBytes }) {
  const nowTs = new Date().toISOString();
  const effectiveScanBytes = (typeof scanBytes === 'number' && scanBytes > 0)
    ? scanBytes
    : DEFAULT_SCAN_BYTES;

  const zeroPayload = {
    type:                    'verify_fix_coverage_report',
    version:                 1,
    schema_version:          1,
    timestamp:               nowTs,
    orchestration_id:        orchestrationId || 'unknown',
    tasks_total:             0,
    tasks_with_verify_fix:   0,
    ratio:                   0,
    alert:                   'n/a_single_task',
    distinct_agents:         [],
  };

  try {
    if (!orchestrationId || !eventsPath) return zeroPayload;

    const { content } = tailRead(eventsPath, effectiveScanBytes);
    const events = parseEvents(content, orchestrationId);

    // Collect distinct developer/refactorer agent_start events.
    // A single task = one agent_start; we deduplicate by task_id when present,
    // falling back to the spawn sequence.
    const agentStarts = events.filter(e => {
      const kind = e.type || e.event_type;
      return kind === 'agent_start' && DEVELOPER_AGENT_TYPES.has(e.agent_type);
    });

    // Collect verify_fix_start events for the same orchestration.
    const verifyFixStarts = events.filter(e => {
      const kind = e.type || e.event_type;
      return kind === 'verify_fix_start';
    });

    // Task identity: prefer task_id, fall back to spawn_key, then index.
    const taskIds = new Set();
    const agentTypeSeen = new Set();
    for (const e of agentStarts) {
      const id = e.task_id || e.spawn_key || String(agentStarts.indexOf(e));
      taskIds.add(id);
      if (e.agent_type) agentTypeSeen.add(e.agent_type);
    }

    const verifyTaskIds = new Set();
    for (const e of verifyFixStarts) {
      const id = e.task_id || e.spawn_key || null;
      if (id) verifyTaskIds.add(id);
    }

    const tasksTotal = taskIds.size;
    // Count tasks that have a verify_fix_start with a matching task identity.
    // If no task_ids/spawn_keys available in verify events, count any verify_fix_start.
    let tasksWithVerifyFix;
    if (verifyTaskIds.size > 0 && taskIds.size > 0) {
      let overlap = 0;
      for (const id of taskIds) {
        if (verifyTaskIds.has(id)) overlap++;
      }
      tasksWithVerifyFix = overlap;
    } else {
      // No correlation possible — fall back to min(verifyFixStarts.length, tasksTotal).
      tasksWithVerifyFix = Math.min(verifyFixStarts.length, tasksTotal);
    }

    const ratio = tasksTotal > 0
      ? Math.round((tasksWithVerifyFix / tasksTotal) * 1000) / 1000
      : 0;

    let alert;
    if (tasksTotal < 2) {
      alert = 'n/a_single_task';
    } else if (ratio === 0) {
      alert = 'zero_coverage';
    } else if (ratio < 0.5) {
      alert = 'below_threshold';
    } else {
      alert = 'ok';
    }

    return {
      type:                  'verify_fix_coverage_report',
      version:               1,
      schema_version:        1,
      timestamp:             nowTs,
      orchestration_id:      orchestrationId,
      tasks_total:           tasksTotal,
      tasks_with_verify_fix: tasksWithVerifyFix,
      ratio,
      alert,
      distinct_agents:       Array.from(agentTypeSeen).sort(),
    };
  } catch (_e) {
    return zeroPayload;
  }
}

module.exports = { runVerifyFixCoverageProbe };
