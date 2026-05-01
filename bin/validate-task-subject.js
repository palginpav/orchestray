#!/usr/bin/env node
'use strict';

/**
 * validate-task-subject.js — PreToolUse hook (matcher: "Agent").
 *
 * v2.1.9 Bundle B1 / Intervention I-01.
 *
 * Purpose: enforce that every PM Agent() spawn includes a meaningful
 * `description` or `task_subject` field. Missing subject is the root cause of
 * the teammate_idle cascade observed in the last 3 orchestrations (18+
 * cascade events per run).
 *
 * Contract:
 *   - fail-open on any internal error (stdin read failure, parse failure)
 *   - exit 2 ONLY when the spawn is demonstrably missing a subject
 *   - emit `task_subject_missing` audit event on block
 *   - never touch built-in Claude Code subagents (Explore) — only PM Agent() spawns
 *
 * Payload expectations (from Claude Code PreToolUse):
 *   {
 *     hook_event_name: "PreToolUse",
 *     tool_name: "Agent"|"Task"|"Explore",
 *     tool_input: {
 *       subagent_type?: string,
 *       description?: string,
 *       prompt?: string,
 *       ...
 *     },
 *     cwd?: string,
 *     session_id?: string,
 *   }
 *
 * A valid payload has at least ONE of:
 *   - tool_input.description (≥ 5 chars, not just whitespace)
 *   - tool_input.prompt contains a `task_subject:` line with a value
 *   - tool_input.subject / tool_input.task_subject is present and non-empty
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { recordDegradation } = require('./_lib/degraded-journal');

// Minimum description length to count as "meaningful" (rejects empty strings,
// single words like "fix", etc).
const MIN_DESCRIPTION_LENGTH = 5;

/**
 * Detect a `task_subject:` marker inside the prompt body. Accepts:
 *   task_subject: foo
 *   **task_subject**: foo
 *   Task subject: foo
 * Case-insensitive, first 2 KB only (enough context for a header block).
 *
 * @param {string} promptBody
 * @returns {string|null}  the captured subject value, or null if absent/empty
 */
function extractTaskSubjectFromPrompt(promptBody) {
  if (typeof promptBody !== 'string' || promptBody.length === 0) return null;
  const head = promptBody.slice(0, 2048);
  // Accept: task_subject:, task-subject:, Task subject:, **task_subject**:
  const m = head.match(/(?:^|\n)[*\s_`-]{0,6}task[-_ ]?subject[*\s_`-]{0,6}\s*:\s*([^\n\r]+)/i);
  if (!m) return null;
  const val = (m[1] || '').trim().replace(/^[*`"' ]+|[*`"' ]+$/g, '');
  return val.length > 0 ? val : null;
}

/**
 * Determine whether an Agent() spawn carries a meaningful subject/description.
 *
 * @param {object} toolInput  — the tool_input sub-object from the hook payload.
 * @returns {{ valid: boolean, reason: string, foundSubject?: string }}
 */
function evaluateSpawn(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') {
    return { valid: false, reason: 'tool_input missing or non-object' };
  }

  // Explicit subject fields win first.
  const explicit = [
    toolInput.task_subject,
    toolInput.subject,
  ].find(v => typeof v === 'string' && v.trim().length > 0);
  if (explicit) {
    return { valid: true, reason: 'explicit task_subject field', foundSubject: explicit.trim() };
  }

  // Description field — must be a non-trivial string.
  if (typeof toolInput.description === 'string') {
    const desc = toolInput.description.trim();
    if (desc.length >= MIN_DESCRIPTION_LENGTH) {
      return { valid: true, reason: 'description field', foundSubject: desc };
    }
  }

  // Fall back to scanning the prompt body for a `task_subject:` marker.
  const bodySubject = extractTaskSubjectFromPrompt(toolInput.prompt);
  if (bodySubject) {
    return { valid: true, reason: 'prompt task_subject marker', foundSubject: bodySubject };
  }

  return { valid: false, reason: 'no description, task_subject, or prompt marker found' };
}

/**
 * Identify spawns that are subject to validation. Built-in agent tools (Explore)
 * and non-subagent Agent() calls lacking a subagent_type should pass through.
 * Only PM Agent() spawns that target a concrete subagent_type go through the gate.
 *
 * @param {object} event
 * @returns {boolean}
 */
function shouldValidate(event) {
  if (!event) return false;
  const toolName = event.tool_name || event.hook_event_matcher || '';
  if (toolName !== 'Agent') return false;

  const toolInput = event.tool_input;
  if (!toolInput || typeof toolInput !== 'object') return false;

  // Only gate when an explicit subagent_type is present — otherwise this is the
  // builtin agent dispatcher and not a PM orchestration spawn.
  const subagent = toolInput.subagent_type;
  if (typeof subagent !== 'string' || subagent.length === 0) return false;

  return true;
}

/**
 * Write a structured audit event to .orchestray/audit/events.jsonl.
 * Fail-open: any error is swallowed; caller continues.
 *
 * @param {string} cwd
 * @param {object} record
 */
function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (err) {
    try {
      recordDegradation({
        kind: 'unknown_kind',
        severity: 'warn',
        projectRoot: cwd,
        detail: { hook: 'validate-task-subject', err: String(err && err.message || err).slice(0, 80) },
      });
    } catch (_) { /* truly last-resort */ }
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
      process.stderr.write('[orchestray] validate-task-subject: stdin exceeded cap; fail-open\n');
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (err) {
      // Malformed payload — fail-open per contract.
      process.stderr.write('[orchestray] validate-task-subject: JSON parse failed (fail-open): ' + err.message + '\n');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    if (!shouldValidate(event)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_) {
      cwd = process.cwd();
    }

    const evaluation = evaluateSpawn(event.tool_input);
    if (evaluation.valid) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Block: missing task_subject.
    const auditRecord = {
      timestamp: new Date().toISOString(),
      type: 'task_subject_missing',
      hook: 'validate-task-subject',
      subagent_type: (event.tool_input && event.tool_input.subagent_type) || null,
      reason: evaluation.reason,
      session_id: event.session_id || null,
      payload_keys: event.tool_input ? Object.keys(event.tool_input).sort() : [],
    };
    emitAuditEvent(cwd, auditRecord);

    process.stderr.write(
      'Agent spawn rejected: task_subject is required. Provide either:\n' +
      '  - a `description` field (≥ ' + MIN_DESCRIPTION_LENGTH + ' chars) on the Agent() call, or\n' +
      '  - a `task_subject:` line in the prompt body (see agents/pm.md §3.X).\n'
    );
    // Exit 2 signals "block" to Claude Code's PreToolUse gate.
    process.stdout.write(JSON.stringify({ continue: false, reason: 'task_subject missing' }));
    process.exit(2);
  });
}

module.exports = {
  evaluateSpawn,
  extractTaskSubjectFromPrompt,
  shouldValidate,
  MIN_DESCRIPTION_LENGTH,
};

if (require.main === module) {
  main();
}
