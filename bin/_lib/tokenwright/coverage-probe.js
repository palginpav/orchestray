'use strict';

/**
 * coverage-probe.js — Tokenwright spawn coverage probe (W4 event 4).
 *
 * Tail-scans `.orchestray/audit/events.jsonl` for events belonging to the
 * given orchestration_id window and computes coverage metrics:
 *   - How many agent_start events occurred?
 *   - How many had a matching prompt_compression event?
 *   - How many had a matching realized savings event?
 *
 * Returns the `tokenwright_spawn_coverage` event payload. Caller is responsible
 * for emitting the event via the audit-event-writer.
 *
 * Bounded read: scans only the last `scanBytes` bytes of events.jsonl (default 5MB)
 * to avoid excessive latency on large event logs. If the orchestration window spans
 * more data, `truncated: true` is added to the result.
 *
 * Fail-safe: all I/O wrapped in try/catch. Returns zero-count payload on error.
 */

const fs   = require('fs');
const path = require('path');

/** Maximum bytes to tail-scan from events.jsonl (default 5 MB). */
const DEFAULT_SCAN_BYTES = 5 * 1024 * 1024;

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
 * Run the coverage probe for an orchestration.
 *
 * @param {object} params
 * @param {string}  params.orchestrationId — the orchestration to probe
 * @param {string}  params.eventsPath      — absolute path to events.jsonl
 * @param {number}  [params.scanBytes]     — max bytes to scan (default 5MB)
 * @returns {object} tokenwright_spawn_coverage event payload
 */
function runCoverageProbe({ orchestrationId, eventsPath, scanBytes }) {
  const nowTs = new Date().toISOString();
  const effectiveScanBytes = (typeof scanBytes === 'number' && scanBytes > 0)
    ? scanBytes
    : DEFAULT_SCAN_BYTES;

  // Zero-value payload used as fallback
  const zeroPayload = {
    type:                        'tokenwright_spawn_coverage',
    event_type:                  'tokenwright_spawn_coverage',
    schema_version:              1,
    version:                     1,
    timestamp:                   nowTs,
    orchestration_id:            orchestrationId || 'unknown',
    agent_starts_total:          0,
    prompt_compression_emits:    0,
    realized_savings_emits:      0,
    realized_unknown_emits:      0,
    compression_skipped_emits:   0,
    coverage_compression_pct:    0,
    coverage_realized_pct:       0,
    missing_pairs:               [],
  };

  try {
    if (!orchestrationId || !eventsPath) return zeroPayload;

    const { content, truncated } = tailRead(eventsPath, effectiveScanBytes);
    const events = parseEvents(content, orchestrationId);

    // Build indexed maps for correlation
    // agent_start events: keyed by spawn_key (or agent_type + index as fallback)
    const agentStarts        = events.filter(e => e.type === 'agent_start' || e.event_type === 'agent_start');
    const compressionEvents  = events.filter(e => e.type === 'prompt_compression' || e.event_type === 'prompt_compression');
    const realizedEvents     = events.filter(e => e.type === 'tokenwright_realized_savings' || e.event_type === 'tokenwright_realized_savings');
    const realizedUnknown    = realizedEvents.filter(e => e.realized_status === 'unknown');
    const realizedMeasured   = realizedEvents.filter(e => e.realized_status !== 'unknown');
    const skippedEvents      = events.filter(e => e.type === 'compression_skipped' || e.event_type === 'compression_skipped');

    const agentStartsTotal       = agentStarts.length;
    const promptCompressionEmits = compressionEvents.length;
    const realizedSavingsEmits   = realizedMeasured.length;
    const realizedUnknownEmits   = realizedUnknown.length;
    const compressionSkippedEmits = skippedEvents.length;

    // coverage_compression_pct = 100 * prompt_compression_emits / agent_starts_total
    const coverageCompressionPct = agentStartsTotal > 0
      ? Math.round((promptCompressionEmits / agentStartsTotal) * 1000) / 10
      : 0;

    // coverage_realized_pct = 100 * (realized_savings + realized_unknown) / prompt_compression_emits
    const totalRealized = realizedSavingsEmits + realizedUnknownEmits;
    const coverageRealizedPct = promptCompressionEmits > 0
      ? Math.round((totalRealized / promptCompressionEmits) * 1000) / 10
      : 0;

    // Build spawn_key → events maps for missing_pairs detection
    // Use spawn_key where available, fall back to agent_type
    const compressionBySpawnKey = new Map();
    for (const ce of compressionEvents) {
      const key = ce.spawn_key || ce.agent_type || 'unknown';
      compressionBySpawnKey.set(key, ce);
    }

    const realizedBySpawnKey = new Map();
    for (const re of realizedEvents) {
      const key = re.spawn_key || re.agent_type || 'unknown';
      realizedBySpawnKey.set(key, re);
    }

    const missingPairs = [];
    for (const start of agentStarts) {
      const key = start.spawn_key || start.agent_type || 'unknown';
      const hasCompression = compressionBySpawnKey.has(key);
      const hasRealized    = realizedBySpawnKey.has(key);

      if (!hasCompression) {
        missingPairs.push({
          agent_type:    start.agent_type || 'unknown',
          spawn_key:     start.spawn_key  || key,
          missing_event: 'prompt_compression',
        });
      } else if (!hasRealized) {
        missingPairs.push({
          agent_type:    start.agent_type || 'unknown',
          spawn_key:     start.spawn_key  || key,
          missing_event: 'tokenwright_realized_savings',
        });
      }
    }

    const payload = {
      type:                        'tokenwright_spawn_coverage',
      event_type:                  'tokenwright_spawn_coverage',
      schema_version:              1,
      version:                     1,
      timestamp:                   nowTs,
      orchestration_id:            orchestrationId,
      agent_starts_total:          agentStartsTotal,
      prompt_compression_emits:    promptCompressionEmits,
      realized_savings_emits:      realizedSavingsEmits,
      realized_unknown_emits:      realizedUnknownEmits,
      compression_skipped_emits:   compressionSkippedEmits,
      coverage_compression_pct:    coverageCompressionPct,
      coverage_realized_pct:       coverageRealizedPct,
      missing_pairs:               missingPairs,
    };

    if (truncated) payload.truncated = true;

    return payload;
  } catch (_e) {
    return zeroPayload;
  }
}

module.exports = { runCoverageProbe };
