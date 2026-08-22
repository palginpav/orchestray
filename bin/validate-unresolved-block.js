#!/usr/bin/env node
'use strict';

/**
 * validate-unresolved-block.js — SubagentStop AND Stop hook.
 *
 * v2.3.31 W1 (amended) — closes the "block, then nothing" defect measured in
 * `.orchestray/kb/artifacts/v2331-w1-blocked-call-visibility.md`: an agent
 * announces an action, a PreToolUse gate blocks it with exit(2), and the
 * agent's turn simply ends. No retry, no acknowledgement — the announced
 * action never happened and nothing marked the difference.
 *
 * Detection (diagnostic §1, verified against real transcripts):
 *   - `is_error: true` PLUS `toolDenialKind: "permission-rule"` on the
 *     `user`-role transcript entry carrying the `tool_result`. This pair is
 *     Claude Code's general "policy denied this call" marker, not specific
 *     to Orchestray, so we additionally scope to our own 28 blocking gates
 *     by matching the echoed stderr text:
 *       "PreToolUse:<Tool> hook error: [node "<path>/bin/<script>.js"]"
 *
 * Resolution (diagnostic §3 "Resolution signals", items 1-3):
 *   - resolved-by-retry: any subsequent `tool_use` after the block, before
 *     any human-authored turn.
 *   - resolved-by-acknowledgement: an assistant `text` block referencing the
 *     block ("blocked" / "could not" / "unable to verify" / ...) after the
 *     block, before any human-authored turn.
 *   - A human-authored turn is identified by `origin.kind === "human"` on
 *     the transcript entry (verified against the real "status?" re-prompt in
 *     this session's own PM transcript — the block entry itself carries no
 *     `origin` field at all). Scanning for resolution STOPS at the first
 *     human turn: whatever the agent does after a human re-prompted is not
 *     evidence the block was self-resolved. This is the amendment's
 *     non-negotiable: "a human re-prompt is NOT resolution."
 *
 * Loop safety (two independent, redundant guards — see "Loop safety" below):
 *   1. Mechanical: never exit(2) when the incoming payload's own
 *      `stop_hook_active` is already true — that flag means THIS Stop event
 *      is itself the result of a prior forced continuation, so blocking
 *      again risks a hang the runtime may or may not break for us.
 *   2. Durable: a small per-block state file
 *      (`.orchestray/state/unresolved-block-nudges.json`) records which
 *      block ids have already been prompted. A block id already marked
 *      `prompted: true` is never re-prompted, defensively, even if
 *      `stop_hook_active` is ever absent/misreported.
 *   In both guard paths, an unresolved block that survives its one nudge is
 *   recorded durably via an audit event and the stop is allowed to proceed —
 *   "one nudge, then get out of the way."
 *
 * Contract:
 *   - Always emit a JSON continuation payload.
 *   - Fail-open on any unexpected error (unreadable transcript, malformed
 *     JSON, missing fields) — a guard that wedges Stop on its own bug is
 *     worse than the defect it exists to catch.
 *
 * Kill switch: ORCHESTRAY_UNRESOLVED_BLOCK_GATE_DISABLED=1 (env) or
 * `unresolved_block_gate.enabled: false` in .orchestray/config.json.
 * Default: ON (new functionality ships default-on per project convention).
 */

const fs = require('fs');
const path = require('path');
const { writeEvent } = require('./_lib/audit-event-writer');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');
const { validateTranscriptPath } = require('./_lib/path-containment');
const { readHookInputRaw } = require('./_lib/hook-stdin');

const ENV_DISABLED = 'ORCHESTRAY_UNRESOLVED_BLOCK_GATE_DISABLED';
const CONFIG_KEY_HINT = 'unresolved_block_gate.enabled';

// Only read the tail of the transcript — these files can grow to hundreds of
// MB over a long session. The block we care about is, by construction, near
// the end (it is either the last relevant entry, or resolved shortly after).
const MAX_TAIL_BYTES = 512 * 1024;

// Safety valve independent of the human-turn cutoff: never walk more than
// this many transcript entries past the block looking for resolution.
const MAX_ENTRIES_AFTER_BLOCK = 60;

// Diagnostic §1: the general Claude Code "policy denied this call" marker.
// We scope it to Orchestray's own gates by also matching the echoed script
// path, so a duplicate-Read dedup or another built-in denial never counts.
const GATE_BLOCK_RE = /PreToolUse:\S+ hook error: \[node "[^"]*[\\/]bin[\\/][^"]+\.js"\]/;
const GATE_SCRIPT_RE = /\[node "([^"]*[\\/]bin[\\/]([^"\\/]+\.js))"\]/;
const GATE_TOOL_RE = /PreToolUse:(\S+) hook error:/;

// Diagnostic §3 signal 3 — the concrete detector it names verbatim.
const ACK_RE = /\b(blocked|could not|unable to (?:verify|run|execute)|hook (?:blocked|prevented))\b/i;

const STATE_FILE = path.join('.orchestray', 'state', 'unresolved-block-nudges.json');
const MAX_STATE_ENTRIES = 300;

/**
 * @param {object} item - A tool_result content item.
 * @returns {string}
 */
function extractResultText(item) {
  if (!item) return '';
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

/**
 * Tail-read a transcript file and parse it into an ordered array of parsed
 * JSONL entries. Unparseable lines (including a possibly-truncated first
 * line from the tail seek) are dropped rather than failing the whole scan.
 *
 * @param {string} transcriptPath - Already containment-checked absolute path.
 * @returns {Array<object>}
 */
function readTranscriptEntries(transcriptPath) {
  let raw;
  const stat = fs.statSync(transcriptPath);
  if (stat.size <= MAX_TAIL_BYTES) {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } else {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(MAX_TAIL_BYTES);
      const read = fs.readSync(fd, buf, 0, MAX_TAIL_BYTES, stat.size - MAX_TAIL_BYTES);
      raw = buf.slice(0, read).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  }
  const lines = raw.split('\n');
  // The tail seek likely landed mid-line; the first fragment is unreliable.
  if (stat.size > MAX_TAIL_BYTES) lines.shift();
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (_e) {
      // Skip malformed/truncated lines — never fail the scan on one bad line.
    }
  }
  return entries;
}

/**
 * Find every Orchestray-gate blocked-call record in the entry list, in
 * transcript order.
 *
 * @param {Array<object>} entries
 * @returns {Array<{index:number, toolUseId:string|null, text:string, tool:string|null, script:string|null}>}
 */
function findBlocks(entries) {
  const blocks = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== 'user' || e.toolDenialKind !== 'permission-rule') continue;
    const msg = e.message;
    if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const item of msg.content) {
      if (!item || item.type !== 'tool_result' || item.is_error !== true) continue;
      const text = extractResultText(item);
      if (!GATE_BLOCK_RE.test(text)) continue;
      const toolMatch = text.match(GATE_TOOL_RE);
      const scriptMatch = text.match(GATE_SCRIPT_RE);
      blocks.push({
        index: i,
        toolUseId: item.tool_use_id || null,
        text: text.slice(0, 400),
        tool: toolMatch ? toolMatch[1] : null,
        script: scriptMatch ? scriptMatch[2] : null,
      });
    }
  }
  return blocks;
}

/**
 * @param {object} e - A parsed transcript entry.
 * @returns {boolean}
 */
function isHumanTurn(e) {
  return !!(e && e.type === 'user' && e.origin && e.origin.kind === 'human');
}

/**
 * Scan forward from a block, looking for resolved-by-retry or
 * resolved-by-acknowledgement (diagnostic §3, signals 2 and 3). Scanning
 * stops at the first human-authored turn — per the amendment, whatever
 * happens after a human re-prompt is not evidence of self-resolution.
 *
 * @param {Array<object>} entries
 * @param {number} blockIndex
 * @returns {{resolved:boolean, type?:'retry'|'acknowledgement', at?:number}}
 */
function classifyResolution(entries, blockIndex) {
  const upper = Math.min(entries.length, blockIndex + 1 + MAX_ENTRIES_AFTER_BLOCK);
  for (let i = blockIndex + 1; i < upper; i++) {
    const e = entries[i];
    if (!e) continue;
    if (isHumanTurn(e)) break; // do not credit anything after a human re-prompt
    if (e.type !== 'assistant') continue;
    const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
    for (const item of content) {
      if (!item) continue;
      if (item.type === 'tool_use') return { resolved: true, type: 'retry', at: i };
      if (item.type === 'text' && typeof item.text === 'string' && ACK_RE.test(item.text)) {
        return { resolved: true, type: 'acknowledgement', at: i };
      }
    }
  }
  return { resolved: false };
}

/**
 * @param {string} cwd
 * @returns {boolean}
 */
function gateDisabled(cwd) {
  if (process.env[ENV_DISABLED] === '1') return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    if (cfg && cfg.unresolved_block_gate && cfg.unresolved_block_gate.enabled === false) return true;
  } catch (_e) { /* missing/malformed config — default stays on */ }
  return false;
}

function loadState(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_e) { /* absent/malformed — start fresh */ }
  return {};
}

function saveState(cwd, state) {
  try {
    const entries = Object.entries(state);
    // Bound growth: keep the most-recently-touched entries only.
    let trimmed = state;
    if (entries.length > MAX_STATE_ENTRIES) {
      entries.sort((a, b) => (a[1].prompted_at || '').localeCompare(b[1].prompted_at || ''));
      trimmed = Object.fromEntries(entries.slice(entries.length - MAX_STATE_ENTRIES));
    }
    const full = path.join(cwd, STATE_FILE);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(trimmed), 'utf8');
  } catch (_e) {
    // State persistence is best-effort — the stop_hook_active guard below
    // is the mechanical backstop if this write fails.
  }
}

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return orchData.orchestration_id || 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (err) {
    process.stderr.write('[orchestray] validate-unresolved-block: audit write failed: ' + err.message + '\n');
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'validate-unresolved-block', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_e) { /* last-resort */ }
  }
}

function main() {
  const input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] validate-unresolved-block: stdin exceeded cap; fail-open\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
  setImmediate(() => {
    let cwd = process.cwd();
    try {
      if (input.length === 0) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }
      let event;
      try {
        event = JSON.parse(input);
      } catch (_e) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      if (event.session_id === 'test-session') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const hookEvent = event.hook_event_name || null;
      if (hookEvent !== 'SubagentStop' && hookEvent !== 'Stop') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

      if (gateDisabled(cwd)) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const transcriptPathRaw = event.transcript_path || event.agent_transcript_path || null;
      const transcriptPath = transcriptPathRaw
        ? validateTranscriptPath(transcriptPathRaw, cwd, (eventType, reason) =>
            emitAuditEvent(cwd, {
              timestamp: new Date().toISOString(),
              type: eventType,
              hook: 'validate-unresolved-block',
              reason,
              raw_path: String(transcriptPathRaw).slice(0, 200),
            }))
        : '';
      if (!transcriptPath) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      let entries;
      try {
        entries = readTranscriptEntries(transcriptPath);
      } catch (_e) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      const blocks = findBlocks(entries);
      if (blocks.length === 0) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }
      const block = blocks[blocks.length - 1];
      const resolution = classifyResolution(entries, block.index);

      const blockId = [
        event.session_id || 'nosession',
        event.agent_id || event.agent_type || 'noagent',
        block.toolUseId || String(block.index),
      ].join('|');

      const baseRecord = {
        timestamp: new Date().toISOString(),
        hook: 'validate-unresolved-block',
        orchestration_id: resolveOrchestrationId(cwd),
        hook_event: hookEvent,
        session_id: event.session_id || null,
        agent_id: event.agent_id || null,
        agent_type: event.agent_type || null,
        gate_tool: block.tool,
        gate_script: block.script,
        block_id: blockId,
      };

      if (resolution.resolved) {
        emitAuditEvent(cwd, Object.assign({}, baseRecord, {
          type: 'unresolved_block_resolved',
          resolution_type: resolution.type,
        }));
        // Clear any pending nudge state for this block — it self-resolved.
        const state = loadState(cwd);
        if (state[blockId]) {
          delete state[blockId];
          saveState(cwd, state);
        }
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      // Unresolved. Guard 1 (mechanical): never re-block a Stop event that is
      // itself the result of a prior forced continuation.
      if (event.stop_hook_active === true) {
        emitAuditEvent(cwd, Object.assign({}, baseRecord, {
          type: 'unresolved_block_final',
          reason: 'stop_hook_active_no_resolution',
        }));
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      // Guard 2 (durable, defensive): never re-prompt a block id we have
      // already nudged, even if stop_hook_active was somehow absent.
      const state = loadState(cwd);
      if (state[blockId] && state[blockId].prompted) {
        emitAuditEvent(cwd, Object.assign({}, baseRecord, {
          type: 'unresolved_block_final',
          reason: 'already_prompted',
        }));
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }

      state[blockId] = { prompted: true, prompted_at: new Date().toISOString() };
      saveState(cwd, state);

      emitAuditEvent(cwd, Object.assign({}, baseRecord, { type: 'unresolved_block_nudge' }));

      const message =
        'Unresolved blocked call: a PreToolUse hook (' + (block.script || 'unknown gate') +
        ') blocked "' + (block.tool || 'a tool call') + '" and the turn ended with no retry and no ' +
        'acknowledgement. Before finishing, either retry the action, try an alternative approach, or ' +
        'state plainly that it could not be done and why — any of these is acceptable, but silence is not. ' +
        'This nudge fires once per block. Kill switch: ' + ENV_DISABLED + '=1 (or ' + CONFIG_KEY_HINT + '=false).\n';
      process.stderr.write('[orchestray] validate-unresolved-block: ' + message);
      process.stdout.write(JSON.stringify({ continue: false, reason: message.trim() }));
      process.exit(2);
    } catch (err) {
      try {
        recordDegradation({
          kind: 'unknown_kind',
          severity: 'warn',
          projectRoot: cwd,
          detail: { hook: 'validate-unresolved-block', err: String(err && err.message || err).slice(0, 80) },
        });
      } catch (_e) { /* last resort */ }
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
}

module.exports = {
  GATE_BLOCK_RE,
  ACK_RE,
  extractResultText,
  readTranscriptEntries,
  findBlocks,
  isHumanTurn,
  classifyResolution,
  gateDisabled,
  loadState,
  saveState,
  STATE_FILE,
};

if (require.main === module) {
  main();
}
