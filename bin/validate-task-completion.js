#!/usr/bin/env node
'use strict';

/**
 * validate-task-completion.js — TaskCompleted hook.
 *
 * v2.1.9 Bundle B1 / Intervention I-12 (pre-done checklist T15).
 *
 * Two responsibilities:
 *
 * 1. LEGACY (Agent Teams): block TaskCompleted events missing `task_id` or
 *    `task_subject`. Preserved from v2.0.x for team-mode orchestrations.
 *
 * 2. NEW (T15 pre-done): if the payload includes a `structured_result`
 *    (Structured Result block from the agent's response) AND the spawning
 *    agent role is known, validate the required sections.
 *
 *    Hard-tier agents (exit 2 on violation):
 *      developer, architect, reviewer, refactorer, tester, release-manager, documenter
 *
 *    Warn-tier agents (exit 0 + warn event on violation):
 *      researcher, debugger, inventor, security-engineer, ux-critic, platform-oracle
 *
 *    Required sections in Structured Result:
 *      - status         (one of success | partial | failure)
 *      - summary        (non-empty string)
 *      - files_changed  (array, may be empty)
 *      - files_read     (array, may be empty)
 *      - issues         (array, may be empty)
 *
 * Contract:
 *   - Always emit a JSON continuation payload.
 *   - Fail-open on any unexpected error (block only on the specific rule).
 */

const fs = require('fs');
const path = require('path');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');

// v2.1.9 I-12 agent tiers (§5 I-12 tier table).
const HARD_TIER = new Set([
  'developer',
  'architect',
  'reviewer',
  'refactorer',
  'tester',
  'release-manager',
  'documenter',
]);
const WARN_TIER = new Set([
  'researcher',
  'debugger',
  'inventor',
  'security-engineer',
  'ux-critic',
  'platform-oracle',
]);

const REQUIRED_SECTIONS = ['status', 'summary', 'files_changed', 'files_read', 'issues'];

/**
 * Try several strategies to extract a Structured Result JSON object from the
 * hook payload. Returns null if none is present/parseable.
 *
 * @param {object} event
 * @returns {object|null}
 */
function extractStructuredResult(event) {
  if (!event) return null;

  // Direct object on payload.
  if (event.structured_result && typeof event.structured_result === 'object') {
    return event.structured_result;
  }

  // Flat object on agent_output_json / result (some variants).
  const direct = event.agent_output_json || event.result_json;
  if (direct && typeof direct === 'object') return direct;

  // Try to find the ```json block under "## Structured Result" in the raw text.
  const raw = [event.result, event.output, event.agent_output]
    .find(v => typeof v === 'string' && v.length > 0);
  if (typeof raw !== 'string' || raw.length === 0) return null;

  // Restrict scan to the last 64 KB of the output.
  const tail = raw.slice(-65536);
  const re = /##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i;
  const m = tail.match(re);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch (_) {
      // fall through to next strategy
    }
  }

  // Last resort: bare `{"status":...}` JSON block at end of output.
  const braceIdx = tail.lastIndexOf('{"status"');
  if (braceIdx !== -1) {
    const candidate = tail.slice(braceIdx);
    // Find the last balanced closing brace.
    let depth = 0;
    let endIdx = -1;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx !== -1) {
      try {
        return JSON.parse(candidate.slice(0, endIdx + 1));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

/**
 * Validate a Structured Result against the T15 checklist.
 *
 * @param {object} result
 * @returns {{ valid: boolean, missing: string[] }}
 */
function validateStructuredResult(result) {
  if (!result || typeof result !== 'object') {
    return { valid: false, missing: REQUIRED_SECTIONS.slice() };
  }
  const missing = [];
  for (const key of REQUIRED_SECTIONS) {
    if (!(key in result)) {
      missing.push(key);
      continue;
    }
    const val = result[key];
    if (key === 'summary') {
      if (typeof val !== 'string' || val.trim().length === 0) missing.push(key);
    } else if (key === 'status') {
      if (typeof val !== 'string' || val.trim().length === 0) missing.push(key);
    } else {
      // files_changed / files_read / issues must be arrays (empty allowed).
      if (!Array.isArray(val)) missing.push(key);
    }
  }
  return { valid: missing.length === 0, missing };
}

/**
 * Identify the agent role from the hook payload. Checks multiple keys because
 * Claude Code's TaskCompleted schema has varied across versions.
 *
 * @param {object} event
 * @returns {string|null}
 */
function identifyAgentRole(event) {
  if (!event) return null;
  // NOTE: teammate_name is deliberately excluded — in Agent-Teams mode it is
  // an operator-chosen label, not a subagent role, and conflating the two
  // causes the T15 gate to fire on well-formed team TaskCompleted events.
  const candidates = [
    event.subagent_type,
    event.agent_type,
    event.agent_role,
    event.role,
    event.agent && event.agent.type,
    event.tool_input && event.tool_input.subagent_type,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c.toLowerCase();
    }
  }
  return null;
}

function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return orchData.orchestration_id || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), record);
  } catch (err) {
    // DEF-10 semantics: stderr MUST report audit-write failures so operators
    // can distinguish "rejected cleanly" from "rejected but audit trail
    // broken". Also journal the degradation for offline analysis.
    process.stderr.write('[orchestray] validate-task-completion: audit write failed: ' + err.message + '\n');
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'validate-task-completion', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) { /* last-resort */ }
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stderr.write('[orchestray] validate-task-completion: stdin exceeded cap; fail-open\n');
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    // Empty stdin: fail-open (historical behavior — some hook runners send
    // no payload in smoke tests). Invalid JSON: same.
    if (input.length === 0) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    let event = {};
    try {
      event = JSON.parse(input);
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // If wired to a non-TaskCompleted event, pass through.
    if (event.hook_event_name && event.hook_event_name !== 'TaskCompleted') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); }
    catch (_) { cwd = process.cwd(); }

    // ── Legacy Agent Teams gate (v2.0.x preserved).
    //
    // Historical behavior: TaskCompleted events that look like Agent-Teams
    // events but lack `task_id` or `task_subject` are rejected with exit 2
    // because those fields are mandatory for team-mode task accounting. The
    // v2.1.9 T15 checklist is additive, not replacement.
    //
    // An event is classified as an Agent-Teams event when ANY of these
    // signals fire:
    //   - a team-flavored key is present (task_id, task_subject,
    //     teammate_name, team_name, task_description)
    //   - the payload explicitly sets hook_event_name to TaskCompleted AND
    //     does NOT carry a subagent_type/output that identifies it as a
    //     v2.1.9 T15 single-agent completion event (the new path).
    //
    // Non-team payloads (subagent_type + output, typical of direct
    // SubagentStop replays used in T15 tests) fall through to the T15 block.
    const teamFlavoredKeys = ['task_id', 'task_subject', 'teammate_name', 'team_name', 'task_description'];
    const hasTeamKeys = teamFlavoredKeys.some(k => k in event);
    const hasT15Signals = !!(event.subagent_type || event.agent_type || event.agent_role ||
      event.structured_result || typeof event.output === 'string');
    // Default to the legacy team-event gate whenever we lack clear T15
    // signals. This preserves "TaskCompleted requires task_id + task_subject"
    // contract for any payload shape callers have relied on since v2.0.x.
    const looksLikeTeamEvent = hasTeamKeys || !hasT15Signals;

    if (looksLikeTeamEvent && (!event.task_id || !event.task_subject)) {
      const reason = !event.task_id && !event.task_subject
        ? 'missing task_id and task_subject'
        : (!event.task_id ? 'missing task_id' : 'missing task_subject');
      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: 'task_validation_failed',
        hook: 'validate-task-completion',
        orchestration_id: resolveOrchestrationId(cwd),
        reason,
        payload_keys: Object.keys(event).sort(),
      });
      process.stderr.write(
        'Task completion rejected: ' + reason + '. ' +
        'Ensure task has proper identification before marking complete.\n'
      );
      process.exit(2);
    }

    // ── v2.1.9 T15 pre-done checklist (I-12).
    const agentRole = identifyAgentRole(event);
    const structuredResult = extractStructuredResult(event);

    if (agentRole && (HARD_TIER.has(agentRole) || WARN_TIER.has(agentRole))) {
      const check = validateStructuredResult(structuredResult);
      if (!check.valid) {
        const isHard = HARD_TIER.has(agentRole);
        const auditRecord = {
          timestamp: new Date().toISOString(),
          type: isHard ? 'pre_done_checklist_failed' : 'task_completion_warn',
          hook: 'validate-task-completion',
          orchestration_id: resolveOrchestrationId(cwd),
          agent_role: agentRole,
          tier: isHard ? 'hard' : 'warn',
          missing_sections: check.missing,
          session_id: event.session_id || null,
        };
        emitAuditEvent(cwd, auditRecord);

        if (isHard) {
          process.stderr.write(
            'Pre-done checklist failed for ' + agentRole + ': Structured Result is missing ' +
            'required section(s): ' + check.missing.join(', ') + '.\n' +
            'See agents/pm-reference/agent-common-protocol.md for the schema.\n'
          );
          process.stdout.write(JSON.stringify({ continue: false, reason: 'pre_done_checklist_failed:' + agentRole }));
          process.exit(2);
        } else {
          process.stderr.write(
            '[orchestray] validate-task-completion: WARN — ' + agentRole +
            ' Structured Result missing: ' + check.missing.join(', ') + ' (warn-tier, not blocking).\n'
          );
        }
      }
    }

    // ── Write the standard team-mode TaskCompleted audit row (preserved).
    if (event.task_id || event.task_subject || event.teammate_name) {
      emitAuditEvent(cwd, {
        timestamp: new Date().toISOString(),
        type: 'task_completed',
        mode: 'teams',
        orchestration_id: resolveOrchestrationId(cwd),
        task_id: event.task_id || null,
        task_subject: event.task_subject || null,
        task_description: event.task_description || null,
        teammate_name: event.teammate_name || null,
        team_name: event.team_name || null,
        session_id: event.session_id || null,
      });
    }

    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  extractStructuredResult,
  validateStructuredResult,
  identifyAgentRole,
  HARD_TIER,
  WARN_TIER,
  REQUIRED_SECTIONS,
};

if (require.main === module) {
  main();
}
