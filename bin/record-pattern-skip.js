#!/usr/bin/env node
'use strict';

/**
 * PreCompact hook — advisory emitter for pattern_record_skipped events.
 *
 * Fires at pre-compaction (session-approaching-end) and emits a single
 * `pattern_record_skipped` advisory event to .orchestray/audit/events.jsonl
 * when all three conditions hold for the current orchestration:
 *
 *   1. An orchestration is active (current-orchestration.json exists and is
 *      parseable with a valid orchestration_id).
 *   2. mcp-checkpoint.jsonl contains at least one row with tool:"pattern_find"
 *      AND result_count >= 1 for this orchestration_id (pattern_find returned
 *      results, making pattern_record_application meaningful).
 *   3. mcp-checkpoint.jsonl contains zero rows with tool:"pattern_record_application"
 *      for this orchestration_id (the PM never recorded which pattern shaped
 *      decomposition).
 *
 * Hook event wired: PreCompact (fallback — not Stop)
 *
 * Architecture note (for T10 reviewer pass):
 *   DESIGN §D2 step 7 assumed this check could fire on SubagentStop and that
 *   "the stopping subagent is the orchestration PM." That assumption is wrong:
 *   the Orchestray PM is the main session agent (set as default via settings.json),
 *   NOT a spawned child. SubagentStop fires only for spawned children (developer,
 *   architect, reviewer, etc.) — it never fires for the main session. The bare
 *   `Stop` hook event (which fires at main-session termination) was investigated
 *   but is NOT a recognised event name in Claude Code's hook system as of v2.0.11;
 *   it does not appear in hooks.json of any Orchestray worktree or in the
 *   hooks reference citations in CLAUDE.md. PreCompact fires reliably at
 *   auto-compaction (i.e., near session end) and is already used in this project
 *   (pre-compact-archive.js), making it the correct fallback trigger here.
 *
 * Idempotency: if a pattern_record_skipped event already exists in events.jsonl
 * for this orchestration_id, no second event is emitted. PreCompact may fire
 * more than once in a session (repeated compactions), so this guard is important.
 *
 * Fail-open discipline: every error path exits 0. No blocking. No non-zero
 * exits under any circumstances.
 *
 * Input:  JSON on stdin (Claude Code PreCompact hook payload)
 * Output: JSON on stdout ({ continue: true }), always
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonlIfAbsent } = require('./_lib/atomic-append');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const {
  findCheckpointsForOrchestration,
  REQUIRED_POST_DECOMPOSITION_TOOLS,
} = require('./_lib/mcp-checkpoint');
const { loadMcpEnforcement } = require('./_lib/config-schema');

const MAX_INPUT_BYTES = 1024 * 1024; // 1 MB cap — mirrors gate-agent-spawn.js:28

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] record-pattern-skip: stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    // Parse stdin — malformed JSON means no cwd context; fail open.
    let event;
    try {
      event = JSON.parse(input);
    } catch (_e) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const cwd = resolveSafeCwd(event.cwd);

    // --- Config check: pattern_record_application advisory gate ---
    // If the user has set pattern_record_application to anything other than "hook",
    // suppress advisory emission entirely (fail-open on config read errors).
    try {
      const mcpEnforcement = loadMcpEnforcement(cwd);
      if (mcpEnforcement.pattern_record_application !== 'hook') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
      }
    } catch (_e) {
      // Config read failed — default to enforced (current behaviour).
    }

    // --- Condition 1: active orchestration ---
    const orchFile = getCurrentOrchestrationFile(cwd);
    let orchId;
    try {
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      orchId = orchData && orchData.orchestration_id;
    } catch (_e) {
      // File missing or malformed — not inside an orchestration; nothing to emit.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    if (!orchId) {
      // orchestration_id absent — fail open.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // --- Condition 2 & 3: analyse mcp-checkpoint rows for this orchestration ---
    const checkpoints = findCheckpointsForOrchestration(cwd, orchId);

    // Condition 2: at least one pattern_find row with result_count >= 1
    const patternFindRows = checkpoints.filter(r => r && r.tool === 'pattern_find');
    const patternFindWithResults = patternFindRows.filter(
      r => typeof r.result_count === 'number' && r.result_count >= 1
    );
    if (patternFindWithResults.length === 0) {
      // pattern_find never returned results — advisory is not applicable.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Condition 3: zero pattern_record_application rows
    // Use REQUIRED_POST_DECOMPOSITION_TOOLS to avoid duplicating the literal.
    const recordApplicationRows = checkpoints.filter(
      r => r && r.tool === REQUIRED_POST_DECOMPOSITION_TOOLS[0]
    );
    if (recordApplicationRows.length > 0) {
      // PM did call pattern_record_application — no skip event needed.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // --- All three conditions met — build advisory event ---
    // Sum result_count across all pattern_find rows (null counts as 0).
    const patternFindResultCountTotal = patternFindRows.reduce(
      (sum, r) => sum + (typeof r.result_count === 'number' ? r.result_count : 0),
      0
    );

    const advisory = {
      timestamp: new Date().toISOString(),
      type: 'pattern_record_skipped',
      orchestration_id: orchId,
      pattern_find_result_count_total: patternFindResultCountTotal,
      reason: 'pattern_find returned results but pattern_record_application was never called',
    };

    // --- Atomic idempotency + emit (B1) ---
    // atomicAppendJsonlIfAbsent acquires the lock, reads the file inside it,
    // checks for an existing pattern_record_skipped row for this orchId, and
    // only appends if absent — eliminating the check-then-act race (A1 W1).
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    const eventsFile = path.join(auditDir, 'events.jsonl');
    try {
      fs.mkdirSync(auditDir, { recursive: true });
      try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort hardening */ }
      atomicAppendJsonlIfAbsent(
        eventsFile,
        advisory,
        (ev) => ev && ev.type === 'pattern_record_skipped' && ev.orchestration_id === orchId
      );
      // Return value false means already present — no second event. Either way exit 0.
    } catch (_writeErr) {
      process.stderr.write(
        '[orchestray] record-pattern-skip: audit write failed (' +
        (_writeErr && _writeErr.message) + '); failing open\n'
      );
      // Fail open — advisory emission failure must not block the session.
    }

  } catch (_e) {
    // Catch-all: unexpected error — fail open.
    process.stderr.write('[orchestray] record-pattern-skip: unexpected error (' + (_e && _e.message) + '); failing open\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
