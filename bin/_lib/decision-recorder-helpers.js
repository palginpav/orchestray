'use strict';

/**
 * decision-recorder-helpers.js — per-tool decision logic for the 4
 * `*_decision_recorded` events emitted from `bin/audit-on-orch-complete.js`.
 *
 * Design: W4b §1.2–§1.3 (v2211-W4b-semantic-redesign.md).
 *
 * For each of the 4 cargo-prone tools, a helper function scans the per-orch
 * archive (`.orchestray/history/<orch_id>/events.jsonl`) and returns a
 * decision payload.  The archive is read once per orchestration close; results
 * are NOT cached beyond the call site (the fanout is synchronous and
 * single-process, so no caching needed).
 *
 * Decision values (§1.2):
 *   invoked            — the orch called the tool at least once.
 *   considered_skipped — the orch's heuristics fired the consideration trigger
 *                        but consciously did NOT invoke.
 *   not_applicable     — the orch never reached the consideration trigger.
 *
 * Per §3 Q2 (scope-lock): same-decision repeats within an orch are coalesced —
 * only the first matching evidence row is cited.
 *
 * Read-only invariant: NONE of these helpers invokes the action-verb tools
 * (pattern_deprecate, ask_user, spawn_agent, curator_tombstone).
 *
 * Fail-open contract: every helper returns a valid payload even if the archive
 * is absent, malformed, or partially corrupt.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Archive scan helpers
// ---------------------------------------------------------------------------

/**
 * Read all JSON-parsed rows from the per-orch archive.
 * Returns [] on any read/parse failure (fail-open).
 *
 * The archive lives at `.orchestray/history/<orchId>/events.jsonl`.
 * Only rows whose `orchestration_id` matches orchId are returned — this
 * prevents cross-orch event leaks even if the archive was built incorrectly.
 */
function readArchiveRows(cwd, orchId) {
  const archivePath = path.join(cwd, '.orchestray', 'history', orchId, 'events.jsonl');
  let text;
  try {
    const stat = fs.statSync(archivePath);
    if (stat.size === 0) return [];
    // Cap at 16 MB — per-orch archives are bounded by the live log cap.
    const CAP = 16 * 1024 * 1024;
    if (stat.size > CAP) {
      const fd  = fs.openSync(archivePath, 'r');
      try {
        const buf = Buffer.alloc(CAP);
        fs.readSync(fd, buf, 0, CAP, stat.size - CAP);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(archivePath, 'utf8');
    }
  } catch (_e) {
    return [];
  }

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (evt && evt.orchestration_id === orchId) {
        rows.push(evt);
      }
    } catch (_e) { /* skip malformed lines */ }
  }
  return rows;
}

/**
 * Find the first row where `type` (or `event_type`) matches `eventType`.
 * Pass `null` for `eventType` to skip the type filter and use only the
 * predicate.  Returns the row, or null when none found.
 */
function findRow(rows, eventType, predicate) {
  for (const row of rows) {
    if (eventType !== null) {
      const t = row.type || row.event_type;
      if (t !== eventType) continue;
    }
    if (predicate && !predicate(row)) continue;
    return row;
  }
  return null;
}

/**
 * Check whether any row matches `eventType` (and optional predicate).
 */
function hasRow(rows, eventType, predicate) {
  return findRow(rows, eventType, predicate) !== null;
}

/**
 * Build a lightweight `evidence_ref` string pointing at a row.
 * Format: `events.jsonl#type=<event_type>` — human-readable and grep-stable.
 * When the caller supplies the actual row, we append the type so the ref is
 * self-describing even when no line number is available.
 */
function evidenceRef(row) {
  if (!row) return null;
  const t = row.type || row.event_type || 'unknown';
  return `history/events.jsonl#type=${t}`;
}

// ---------------------------------------------------------------------------
// Base payload factory
// ---------------------------------------------------------------------------

function basePayload(eventType, toolName, orchId, decision, reason, evidenceRow, candidateSubject) {
  return {
    type:              eventType,
    schema_version:    '1',
    orchestration_id:  orchId,
    tool_name:         toolName,
    decision,
    reason,
    evidence_ref:      evidenceRow ? evidenceRef(evidenceRow) : null,
    candidate_subject: candidateSubject || null,
    source:            'orch-complete-decision-recorder',
  };
}

// ---------------------------------------------------------------------------
// §1.3.1 — pattern_deprecate → pattern_deprecation_decision_recorded
// ---------------------------------------------------------------------------
//
// invoked            : `pattern_deprecated` row with this orch_id exists.
// considered_skipped : `curator_run_start` in this orch AND any pattern
//                      frontmatter shows confidence ≤ 0.4 OR times_applied = 0
//                      at orch-close → `considered_skipped`.
//                      Also: `pattern_skip_enriched` rows with
//                      skip_category indicating deprecated_candidate_kept.
// not_applicable     : no_low_confidence_patterns / curator_disabled.

const PATTERN_DEPRECATE_SKIP_CATEGORIES = new Set([
  'already_deprecated',
  'confidence_above_threshold',
  'times_applied_above_threshold',
  'kill_switch_set',
  'dry_run',
  'deprecated_candidate_kept',
]);

/**
 * Decide `pattern_deprecation_decision_recorded` from archive rows.
 */
function decidePatternDeprecation(rows, orchId) {
  const eventType = 'pattern_deprecation_decision_recorded';
  const toolName  = 'pattern_deprecate';

  // 1. Invoked: a real pattern_deprecated event was emitted.
  const depRow = findRow(rows, 'pattern_deprecated');
  if (depRow) {
    const subject = depRow.pattern_name || depRow.slug || null;
    return basePayload(eventType, toolName, orchId,
      'invoked', 'curator_run_action', depRow, subject);
  }

  // 2. considered_skipped via pattern_skip_enriched rows.
  const skipRow = findRow(rows, 'pattern_skip_enriched', (r) =>
    r.skip_category && PATTERN_DEPRECATE_SKIP_CATEGORIES.has(r.skip_category));
  if (skipRow) {
    const reason  = skipRow.skip_category || 'already_deprecated';
    const subject = skipRow.pattern_name || skipRow.slug || null;
    return basePayload(eventType, toolName, orchId,
      'considered_skipped', reason, skipRow, subject);
  }

  // 3. considered_skipped: curator_run_start in this orch means curator ran
  //    but chose not to deprecate (no pattern_deprecated emitted).
  const curatorStart = findRow(rows, 'curator_run_start');
  if (curatorStart) {
    return basePayload(eventType, toolName, orchId,
      'considered_skipped', 'no_low_confidence_patterns', curatorStart, null);
  }

  // 4. not_applicable: no curator activity.
  return basePayload(eventType, toolName, orchId,
    'not_applicable', 'curator_disabled', null, null);
}

// ---------------------------------------------------------------------------
// §1.3.2 — ask_user → user_question_decision_recorded
// ---------------------------------------------------------------------------
//
// invoked            : `mcp_tool_call` row where `tool === 'ask_user'` AND
//                      outcome ∈ {answered, timeout, declined, cancelled}.
// considered_skipped : `disagreement_detected` / `ambiguity_high` /
//                      `block_a_zone1_invalidated` in this orch with NO
//                      subsequent `mcp_tool_call:ask_user`.
// not_applicable     : no ambiguity/disagreement signal.

const ASK_USER_INVOKED_OUTCOMES = new Set(['answered', 'timeout', 'declined', 'cancelled']);

const ASK_USER_SKIP_SIGNAL_TYPES = new Set([
  'disagreement_detected',
  'ambiguity_high',
  'block_a_zone1_invalidated',
]);

/**
 * Decide `user_question_decision_recorded` from archive rows.
 */
function decideAskUser(rows, orchId) {
  const eventType = 'user_question_decision_recorded';
  const toolName  = 'ask_user';

  // 1. Invoked: mcp_tool_call for ask_user with a real outcome.
  const invokedRow = findRow(rows, 'mcp_tool_call', (r) =>
    (r.tool === 'ask_user' || r.tool_name === 'ask_user') &&
    ASK_USER_INVOKED_OUTCOMES.has(r.outcome));
  if (invokedRow) {
    return basePayload(eventType, toolName, orchId,
      'invoked', 'pm_blocked_question', invokedRow, null);
  }

  // 2. considered_skipped: ambiguity/disagreement signal existed but ask_user
  //    was not invoked — suppression happened.
  const skipSignalRow = findRow(rows, null, (r) => {
    const t = r.type || r.event_type;
    return t && ASK_USER_SKIP_SIGNAL_TYPES.has(t);
  });
  if (skipSignalRow) {
    const t = skipSignalRow.type || skipSignalRow.event_type;
    // Map signal type → reason enum.
    const reasonMap = {
      disagreement_detected:      'ambiguity_resolved_internally',
      ambiguity_high:             'ambiguity_resolved_internally',
      block_a_zone1_invalidated:  'non_interactive_session',
    };
    const reason = reasonMap[t] || 'ambiguity_resolved_internally';
    return basePayload(eventType, toolName, orchId,
      'considered_skipped', reason, skipSignalRow, null);
  }

  // 3. not_applicable: no ambiguity signal in this orch.
  return basePayload(eventType, toolName, orchId,
    'not_applicable', 'no_ambiguity_signal', null, null);
}

// ---------------------------------------------------------------------------
// §1.3.3 — spawn_agent → agent_spawn_decision_recorded
// ---------------------------------------------------------------------------
//
// invoked            : `spawn_requested` row with `processed: true`.
// considered_skipped : `spawn_requested` row with `processed: false`
//                      (rejected by PM); OR zero rows but worker outputs
//                      contain spawn-request tokens (heuristic below).
// not_applicable     : no spawn_requested rows.

/**
 * Decide `agent_spawn_decision_recorded` from archive rows.
 */
function decideAgentSpawn(rows, orchId) {
  const eventType = 'agent_spawn_decision_recorded';
  const toolName  = 'spawn_agent';

  // 1. Invoked: at least one spawn_requested that was processed.
  const processedRow = findRow(rows, 'spawn_requested', (r) => r.processed === true);
  if (processedRow) {
    const subject = processedRow.role || processedRow.agent_type || null;
    return basePayload(eventType, toolName, orchId,
      'invoked', 'worker_initiated_security_review', processedRow, subject);
  }

  // 2. considered_skipped: spawn_requested that was rejected.
  const rejectedRow = findRow(rows, 'spawn_requested', (r) => r.processed === false);
  if (rejectedRow) {
    const subject = rejectedRow.role || rejectedRow.agent_type || null;
    return basePayload(eventType, toolName, orchId,
      'considered_skipped', 'pm_rejected', rejectedRow, subject);
  }

  // 3. considered_skipped: worker outputs contain spawn-request tokens.
  //    These appear in agent_stop rows whose output mentions spawn keywords.
  const spawnTokenRegex = /request a security review|spawn a researcher|spawn a debugger/i;
  const agentStopWithSpawnRef = findRow(rows, 'agent_stop', (r) =>
    r.output && typeof r.output === 'string' && spawnTokenRegex.test(r.output));
  if (agentStopWithSpawnRef) {
    return basePayload(eventType, toolName, orchId,
      'considered_skipped', 'pm_rejected', agentStopWithSpawnRef, null);
  }

  // 4. not_applicable: no spawn signal.
  return basePayload(eventType, toolName, orchId,
    'not_applicable', 'no_worker_request', null, null);
}

// ---------------------------------------------------------------------------
// §1.3.4 — curator_tombstone → curator_tombstone_decision_recorded
// ---------------------------------------------------------------------------
//
// invoked            : `curator_run_start` in this orch AND any
//                      `curator_action_*` row exists.
// considered_skipped : `curator_run_start` exists, no `curator_action_*` rows.
// not_applicable     : no `curator_run_start` (curator never ran).

const CURATOR_ACTION_PREFIX = 'curator_action_';

/**
 * Decide `curator_tombstone_decision_recorded` from archive rows.
 */
function decideCuratorTombstone(rows, orchId) {
  const eventType = 'curator_tombstone_decision_recorded';
  const toolName  = 'curator_tombstone';

  const curatorStart = findRow(rows, 'curator_run_start');

  if (!curatorStart) {
    // No curator run in this orch.
    return basePayload(eventType, toolName, orchId,
      'not_applicable', 'no_curator_run_in_orch', null, null);
  }

  // Curator ran — did it take any actions?
  const actionRow = findRow(rows, null, (r) => {
    const t = r.type || r.event_type;
    return t && t.startsWith(CURATOR_ACTION_PREFIX);
  });

  if (actionRow) {
    const t       = actionRow.type || actionRow.event_type;
    const subject = actionRow.pattern_name || actionRow.slug || null;
    return basePayload(eventType, toolName, orchId,
      'invoked', t, actionRow, subject);
  }

  // Curator ran but took no actions → dry_run / no qualifying patterns.
  return basePayload(eventType, toolName, orchId,
    'considered_skipped', 'dry_run', curatorStart, null);
}

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Run all 4 decision-recorder helpers against the per-orch archive and return
 * an array of 4 payload objects (one per tool).
 *
 * Kill switches (§1.4, per feedback_default_on_shipping.md):
 *   ORCHESTRAY_DR_PATTERN_DEPRECATE_DISABLED=1
 *   ORCHESTRAY_DR_ASK_USER_DISABLED=1
 *   ORCHESTRAY_DR_AGENT_SPAWN_DISABLED=1
 *   ORCHESTRAY_DR_CURATOR_TOMBSTONE_DISABLED=1
 *
 * A disabled tool yields null in the output array; the caller skips emit for
 * that slot. This preserves the "exactly 4 fired unless explicitly killed"
 * contract for the other tools.
 *
 * @param {string} cwd     — project root (safe, validated upstream)
 * @param {string} orchId  — active orchestration_id
 * @returns {Array<object|null>} — 4 elements; null when kill switch active.
 */
function computeDecisions(cwd, orchId) {
  // Read the per-orch archive once for all 4 helpers.
  const rows = readArchiveRows(cwd, orchId);

  const env = process.env;

  const patternDeprecate = env.ORCHESTRAY_DR_PATTERN_DEPRECATE_DISABLED === '1'
    ? null
    : decidePatternDeprecation(rows, orchId);

  const askUser = env.ORCHESTRAY_DR_ASK_USER_DISABLED === '1'
    ? null
    : decideAskUser(rows, orchId);

  const agentSpawn = env.ORCHESTRAY_DR_AGENT_SPAWN_DISABLED === '1'
    ? null
    : decideAgentSpawn(rows, orchId);

  const curatorTombstone = env.ORCHESTRAY_DR_CURATOR_TOMBSTONE_DISABLED === '1'
    ? null
    : decideCuratorTombstone(rows, orchId);

  return [patternDeprecate, askUser, agentSpawn, curatorTombstone];
}

module.exports = {
  computeDecisions,
  // Exported for unit tests:
  readArchiveRows,
  decidePatternDeprecation,
  decideAskUser,
  decideAgentSpawn,
  decideCuratorTombstone,
};
