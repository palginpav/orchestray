#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * watch-events.js — Live-tail poller for .orchestray/audit/events.jsonl
 *
 * Polls the active events.jsonl file every 2 seconds (hard-coded per OQ-TA-3)
 * and prints new lines as human-readable progress summaries.
 *
 * Usage:
 *   node bin/watch-events.js [events-file-path] [--interval=<ms>]
 *
 * Arguments:
 *   events-file-path   Path to events.jsonl to tail. If omitted, uses
 *                      .orchestray/audit/events.jsonl relative to cwd.
 *                      Falls back to the most recent history entry when the
 *                      live file is absent.
 *   --interval=<ms>    Override poll interval in ms (test use only; operators
 *                      must not use this — OQ-TA-3 locks at 2000 ms in production).
 *
 * Exit conditions:
 *   - Encounters an orchestration_complete event (exits 0)
 *   - Events file disappears after being found (exits 0 — orchestration archived)
 *   - SIGINT / SIGTERM (exits 0 — Ctrl-C)
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 2000;
const MAX_HISTORY_DIRS = 50; // How many history dirs to scan when falling back

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let filePath = null;
  let intervalMs = DEFAULT_INTERVAL_MS;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--interval=')) {
      const val = parseInt(arg.split('=')[1], 10);
      if (!isNaN(val) && val > 0) {
        intervalMs = val;
      }
    } else if (!arg.startsWith('--')) {
      filePath = arg;
    }
  }

  return { filePath, intervalMs };
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the events.jsonl path to watch.
 * Returns null if no file can be found anywhere.
 */
function resolveEventsFile(explicitPath) {
  if (explicitPath) {
    return path.resolve(explicitPath);
  }

  const cwd = process.cwd();
  const livePath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (fs.existsSync(livePath)) {
    return livePath;
  }

  // Fall back to most recent history entry
  const historyDir = path.join(cwd, '.orchestray', 'history');
  if (!fs.existsSync(historyDir)) {
    return null;
  }

  try {
    const entries = fs.readdirSync(historyDir)
      .filter(e => e.startsWith('orch-'))
      .map(e => {
        const fullPath = path.join(historyDir, e, 'events.jsonl');
        if (!fs.existsSync(fullPath)) return null;
        try {
          const stat = fs.statSync(fullPath);
          return { path: fullPath, mtime: stat.mtimeMs };
        } catch (_e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_HISTORY_DIRS);

    if (entries.length > 0) {
      return entries[0].path;
    }
  } catch (_e) {
    // Ignore errors during history scan
  }

  return null;
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

/**
 * Format a single event object into a human-readable one-line string.
 * Returns null if the event should be suppressed (e.g., routing error rows).
 */
function formatEvent(ev) {
  const type = ev.type || ev.event;
  const ts = formatTime(new Date());

  switch (type) {
    case 'orchestration_start': {
      const id = ev.orchestration_id || ev.id || '?';
      const task = ev.task || ev.task_description || '(no task)';
      // Truncate long tasks for readability
      const shortTask = task.length > 80 ? task.slice(0, 77) + '...' : task;
      return `${ts}  orchestration_start  id=${id}  task="${shortTask}"`;
    }

    case 'agent_start': {
      const agentType = ev.agent_type || '?';
      const wId = ev.w_id || ev.wave_id || null;
      const wPart = wId ? `  w=${wId}` : '';
      return `${ts}  agent_start  agent=${agentType}${wPart}`;
    }

    case 'agent_stop': {
      const agentType = ev.agent_type || '?';
      const wId = ev.w_id || ev.wave_id || null;
      const wPart = wId ? `  w=${wId}` : '';
      const turns = ev.turns_used != null ? `  turns=${ev.turns_used}` : '';
      const cost = ev.estimated_cost_usd != null
        ? `  cost=$${Number(ev.estimated_cost_usd).toFixed(4)}`
        : '';
      return `${ts}  agent_stop   agent=${agentType}${wPart}${turns}${cost}`;
    }

    case 'routing_outcome': {
      // Suppress result:error rows — they are hook-source noise per spec
      if (ev.result === 'error') {
        return null;
      }
      const agentType = ev.agent_type || '?';
      const model = ev.model_assigned || ev.model || '?';
      const tokensIn = ev.input_tokens != null ? `  in=${ev.input_tokens}` : '';
      const tokensOut = ev.output_tokens != null ? `  out=${ev.output_tokens}` : '';
      return `${ts}  routing      agent=${agentType}  model=${model}${tokensIn}${tokensOut}`;
    }

    case 'wave_complete': {
      const wId = ev.w_id || ev.wave_id || '?';
      const testsDelta = ev.tests_delta != null ? `  tests_delta=${ev.tests_delta}` : '';
      return `${ts}  wave_complete  w=${wId}${testsDelta}`;
    }

    case 'w_item_complete': {
      const wId = ev.w_id || ev.wave_id || ev.item_id || '?';
      const testsDelta = ev.tests_delta != null ? `  tests_delta=${ev.tests_delta}` : '';
      return `${ts}  w_item_complete  w=${wId}${testsDelta}`;
    }

    case 'orchestration_complete': {
      const verdict = ev.status || ev.verdict || '?';
      const cost = ev.total_cost_usd != null
        ? `  total_cost=$${Number(ev.total_cost_usd).toFixed(4)}`
        : '';
      return `${ts}  orchestration_complete  verdict=${verdict}${cost}`;
    }

    default: {
      // Unknown event types: show type + compact JSON (omit timestamp field to reduce noise)
      const compact = JSON.stringify(ev);
      const trimmed = compact.length > 120 ? compact.slice(0, 117) + '...' : compact;
      return `${ts}  ${type || 'unknown'}  ${trimmed}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

/**
 * State maintained across poll ticks.
 */
const state = {
  fileOffset: 0,       // Byte offset — how far we have read into the file
  fileFound: false,    // Have we seen the file at least once?
  done: false,         // Set to true when we should exit cleanly
};

function poll(eventsFile) {
  if (state.done) return;

  if (!fs.existsSync(eventsFile)) {
    if (state.fileFound) {
      // File existed before and now it is gone — orchestration was archived
      console.log(`${formatTime(new Date())}  [watch] events file removed — orchestration archived, exiting`);
      state.done = true;
      process.exit(0);
    }
    // File has never been seen — keep waiting silently
    return;
  }

  state.fileFound = true;

  let fileSize;
  try {
    fileSize = fs.statSync(eventsFile).size;
  } catch (_e) {
    return; // Race condition — file disappeared; next tick will catch it
  }

  if (fileSize <= state.fileOffset) {
    // No new bytes; nothing to do
    return;
  }

  // Read only new bytes since last poll
  let newBytes;
  try {
    const fd = fs.openSync(eventsFile, 'r');
    const bufLen = fileSize - state.fileOffset;
    const buf = Buffer.allocUnsafe(bufLen);
    const bytesRead = fs.readSync(fd, buf, 0, bufLen, state.fileOffset);
    fs.closeSync(fd);
    newBytes = buf.slice(0, bytesRead).toString('utf8');
  } catch (_e) {
    return; // Race — file gone or unreadable; try next tick
  }

  state.fileOffset += Buffer.byteLength(newBytes, 'utf8');

  // Process lines — a line may be incomplete if the writer paused mid-write;
  // hold back the trailing partial line until the next tick.
  const lines = newBytes.split('\n');

  // If the chunk doesn't end with a newline, the last "line" is incomplete —
  // rewind the offset so we re-read it next tick.
  if (!newBytes.endsWith('\n') && lines.length > 0) {
    const partial = lines.pop();
    state.fileOffset -= Buffer.byteLength(partial, 'utf8');
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch (_e) {
      // Malformed line — print raw with a warning prefix
      console.log(`${formatTime(new Date())}  [parse error]  ${trimmed}`);
      continue;
    }

    const formatted = formatEvent(ev);
    if (formatted !== null) {
      console.log(formatted);
    }

    // Exit condition: orchestration_complete
    const type = ev.type || ev.event;
    if (type === 'orchestration_complete') {
      state.done = true;
      process.exit(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const { filePath: explicitPath, intervalMs } = parseArgs(process.argv);

  // When an explicit path is given, fail fast if it does not exist.
  // When no path is given, we auto-discover and wait if nothing exists yet.
  if (explicitPath && !fs.existsSync(path.resolve(explicitPath))) {
    console.error(`[watch] file not found: ${explicitPath}`);
    process.exit(1);
  }

  const eventsFile = resolveEventsFile(explicitPath);

  if (!eventsFile && !explicitPath) {
    // No file yet; we will keep polling until one appears or user Ctrl-Cs
    console.log(`${formatTime(new Date())}  [watch] waiting for .orchestray/audit/events.jsonl ...`);
  }

  const target = eventsFile || path.resolve(process.cwd(), '.orchestray', 'audit', 'events.jsonl');

  // Graceful exit on Ctrl-C / SIGTERM
  process.on('SIGINT', () => {
    console.log(`\n${formatTime(new Date())}  [watch] interrupted — exiting`);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    process.exit(0);
  });

  // Initial poll, then interval
  poll(target);

  const timer = setInterval(() => {
    poll(target);
    if (state.done) {
      clearInterval(timer);
    }
  }, intervalMs);

  // Keep the process alive
  timer.unref(); // Allow test harnesses to end without explicit clearInterval
  // But we DO want to stay alive during normal operation — re-ref immediately
  timer.ref();
}

main();
