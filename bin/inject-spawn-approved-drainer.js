#!/usr/bin/env node
'use strict';

/**
 * inject-spawn-approved-drainer.js — UserPromptSubmit hook (v2.2.9 B-1.3).
 *
 * Closes the housekeeper E2E loop. Reads spawn-approved.jsonl on every PM
 * turn. When undrained housekeeper rows exist, prepends a hard-block
 * additionalContext prompt injection ordering the PM to call Agent() for
 * each one before responding.
 *
 * Scope: only `requested_agent === "orchestray-housekeeper"` rows are
 * drained. User-initiated approvals (other agent types) are left for the
 * PM to process manually — they need the user to see them.
 *
 * Kill switch: ORCHESTRAY_SPAWN_DRAINER_DISABLED=1
 *
 * After injection, marks each processed row as drained (adds `drained_at`
 * ISO8601) via atomic write.
 *
 * Emits `spawn_approved_drainer_injected` per row injected.
 *
 * Fail-open: any error → exit 0 with no injection.
 *
 * Input:  JSON UserPromptSubmit hook payload on stdin
 * Output: hookSpecificOutput.additionalContext when pending rows exist; else exit 0
 */

const fs   = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES }   = require('./_lib/constants');
const { resolveSafeCwd }    = require('./_lib/resolve-project-cwd');
const { writeEvent }        = require('./_lib/audit-event-writer');

const HOUSEKEEPER_AGENT = 'orchestray-housekeeper';
const APPROVED_REL      = path.join('.orchestray', 'state', 'spawn-approved.jsonl');

// Max chars for the injected prompt block (per acceptance contract).
const MAX_BLOCK_CHARS = 600;

// ---------------------------------------------------------------------------
// Kill-switch check
// ---------------------------------------------------------------------------
function isDisabled() {
  return process.env.ORCHESTRAY_SPAWN_DRAINER_DISABLED === '1';
}

// ---------------------------------------------------------------------------
// Read + parse spawn-approved.jsonl. Returns [] on any error.
// ---------------------------------------------------------------------------
function readApproved(projectRoot) {
  const filePath = path.join(projectRoot, APPROVED_REL);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const entries = [];
    for (const line of raw.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try { entries.push(JSON.parse(l)); } catch (_e) {}
    }
    return entries;
  } catch (_e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Atomic rewrite of spawn-approved.jsonl with updated entries.
// ---------------------------------------------------------------------------
function writeApproved(projectRoot, entries) {
  const filePath = path.join(projectRoot, APPROVED_REL);
  const tmp = filePath + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = entries.map(e => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (_e) {
    // Clean up tmp if rename failed.
    try { fs.unlinkSync(tmp); } catch (_e2) {}
  }
}

// ---------------------------------------------------------------------------
// Build the hard-block prompt injection for pending rows (≤600 chars).
// ---------------------------------------------------------------------------
function buildPromptBlock(pendingRows) {
  const lines = [
    '**[ORCHESTRAY SPAWN DRAINER]** Pending approved housekeeper spawns — call Agent() for each before responding:',
  ];
  for (const row of pendingRows) {
    // v2.2.9 P1-S1: escape worker-supplied fields via JSON.stringify to prevent
    // a forged second Agent() call via a quote/newline in `justification` or
    // `request_id`. JSON.stringify yields a properly-quoted JS string literal,
    // including the surrounding double-quotes, so we drop our own quotes.
    const rawDesc = (row.justification || 'housekeeper maintenance').slice(0, 80);
    const desc = JSON.stringify(rawDesc);
    const reqId = JSON.stringify(String(row.request_id || '?'));
    lines.push(
      '- Agent(subagent_type: "' + HOUSEKEEPER_AGENT + '", model: "haiku",' +
      ' description: ' + desc + ')'
      + ' [request_id: ' + reqId + ']'
    );
  }
  const block = lines.join('\n');
  // Truncate hard at MAX_BLOCK_CHARS to respect acceptance contract.
  return block.length <= MAX_BLOCK_CHARS ? block : block.slice(0, MAX_BLOCK_CHARS - 3) + '...';
}

// ---------------------------------------------------------------------------
// Emit audit event (fail-silently).
// ---------------------------------------------------------------------------
function emitDrainerInjected(projectRoot, row) {
  const requestedAt = row.requested_at || row.ts || null;
  const ageSeconds = requestedAt
    ? Math.round((Date.now() - new Date(requestedAt).getTime()) / 1000)
    : 0;
  try {
    writeEvent(
      {
        type: 'spawn_approved_drainer_injected',
        version: 1,
        schema_version: 1,
        request_id:      row.request_id     || null,
        requested_agent: row.requested_agent || HOUSEKEEPER_AGENT,
        age_seconds:     ageSeconds,
      },
      { cwd: projectRoot }
    );
  } catch (_e) {
    // Fail-open.
  }
}

// ---------------------------------------------------------------------------
// Main handler — exported for testability.
// ---------------------------------------------------------------------------
function handleUserPromptSubmit(event) {
  if (isDisabled()) {
    return { injected: false, reason: 'kill_switch' };
  }

  const cwd = resolveSafeCwd(event && event.cwd);

  // Read all approved rows.
  const entries = readApproved(cwd);

  // Filter: housekeeper-only, not yet drained.
  const pending = entries.filter(
    e => e &&
         !e.drained_at &&
         e.requested_agent === HOUSEKEEPER_AGENT
  );

  if (pending.length === 0) {
    return { injected: false, reason: 'no_pending' };
  }

  // Build prompt block.
  const block = buildPromptBlock(pending);

  // Mark rows drained (atomic write).
  const drainedAt = new Date().toISOString();
  const pendingIds = new Set(pending.map(r => r.request_id));
  const updated = entries.map(e => {
    if (e && !e.drained_at && pendingIds.has(e.request_id)) {
      return Object.assign({}, e, { drained_at: drainedAt });
    }
    return e;
  });
  writeApproved(cwd, updated);

  // Emit one event per drained row.
  for (const row of pending) {
    emitDrainerInjected(cwd, row);
  }

  return { injected: true, block, count: pending.length };
}

// ---------------------------------------------------------------------------
// Stdin reader + stdout emission (hook entrypoint).
// ---------------------------------------------------------------------------

// Export for tests (must come BEFORE the stdin listener so requiring this
// module from a test does not register a stdin reader that hangs the suite).
module.exports = { handleUserPromptSubmit, buildPromptBlock, readApproved, writeApproved };

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => { process.exit(0); });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    try {
      let event = {};
      if (input.trim()) {
        try { event = JSON.parse(input); } catch (_e) {}
      }

      const result = handleUserPromptSubmit(event);

      if (result.injected) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'UserPromptSubmit',
              additionalContext: result.block,
            },
          }) + '\n',
          () => process.exit(0)
        );
      } else {
        process.exit(0);
      }
    } catch (_e) {
      // Fail-open on any unhandled error.
      process.exit(0);
    }
  });
}
