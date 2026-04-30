#!/usr/bin/env node
'use strict';

/**
 * validate-tester-runs-tests.js — SubagentStop hook (v2.2.15 P1-06).
 *
 * When a tester agent's Structured Result claims `tests_passing: true`, verify
 * that the spawn's audit window contains at least one Bash event matching a
 * known test runner (npm test, node --test, jest, vitest, pytest). Exit 2 if
 * no such evidence is found.
 *
 * Telemetry-first ramp (default 3 spawns warn, then exit 2). Counter file:
 *   .orchestray/state/tester-runs-tests-warn-count-<orch-id>.txt
 *
 * Kill switch: ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED=1
 *
 * Events emitted:
 *   tester_runs_tests_gate_warn    — ramp window still open, exit 0
 *   tester_runs_tests_gate_blocked — ramp exhausted, exit 2
 *
 * Contract:
 *   - exit 0 when tests_passing is absent/false, or evidence found.
 *   - exit 0 within ramp window (emit warn event).
 *   - exit 2 when ramp exhausted and no test-runner evidence.
 *   - fail-open on any internal error.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }  = require('./_lib/resolve-project-cwd');
const { writeEvent }      = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

const SCHEMA_VERSION = 1;
const DEFAULT_RAMP_THRESHOLD = 3;

// Regex matching known test-runner invocations in Bash tool calls.
const TEST_RUNNER_RE = /\bnpm\s+test\b|\bnode\s+--test\b|\bjest\b|\bvitest\b|\bpytest\b/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOrchId(cwd) {
  try {
    const f = getCurrentOrchestrationFile(cwd);
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    return parsed.orchestration_id || parsed.id || null;
  } catch (_e) { return null; }
}

function counterFilePath(cwd, orchId) {
  return path.join(cwd, '.orchestray', 'state', `tester-runs-tests-warn-count-${orchId}.txt`);
}

function bumpWarnCount(cwd, orchId, threshold) {
  const filePath = counterFilePath(cwd, orchId);
  let count = 0;
  try {
    const n = parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
    if (Number.isFinite(n) && n >= 0) count = n;
  } catch (_e) { /* fresh counter */ }
  count += 1;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, String(count) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (_e) { /* best-effort */ }
  return { count, threshold };
}

function emitGateEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    writeEvent(record, { cwd });
  } catch (_e) { /* fail-open */ }
}

/**
 * Extract `tests_passing` field from a Structured Result in the agent output.
 */
function extractTestsPassing(event) {
  // Direct structured_result object
  const sr = event.structured_result;
  if (sr && typeof sr === 'object') {
    return !!sr.tests_passing;
  }
  // Try text extraction
  const raw = [event.result, event.output, event.agent_output]
    .find(v => typeof v === 'string' && v.length > 0);
  if (!raw) return false;

  const tail = raw.slice(-65536);
  const re = /##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i;
  const m = tail.match(re);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      return !!parsed.tests_passing;
    } catch (_) { /* fall through */ }
  }
  return false;
}

/**
 * Scan the audit events.jsonl for evidence of a test-runner Bash call.
 * We scan the entire file — the spawn window heuristic is: any Bash tool call
 * with a test-runner command in the session that produced this SubagentStop.
 */
function hasTestRunnerEvidence(cwd) {
  try {
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return false;
    const raw = fs.readFileSync(eventsPath, 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());
    // Read from the end — most recent events first for efficiency
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 500); i--) {
      try {
        const evt = JSON.parse(lines[i]);
        // Look for Bash tool calls or bash_command events containing test runners
        const cmd = evt.command || evt.bash_command || evt.tool_input_command ||
          (evt.tool_input && evt.tool_input.command) || '';
        if (typeof cmd === 'string' && TEST_RUNNER_RE.test(cmd)) return true;
        // Also match on event type directly
        if (evt.type === 'bash_executed' && typeof evt.command === 'string') {
          if (TEST_RUNNER_RE.test(evt.command)) return true;
        }
      } catch (_) { /* skip malformed */ }
    }
    return false;
  } catch (_e) { return false; }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Kill switch: full bypass
  if (process.env.ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only activate on SubagentStop for tester role
    const hookEvent = event.hook_event_name || '';
    if (hookEvent !== 'SubagentStop') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }
    const role = (
      event.subagent_type || event.agent_type || event.agent_role ||
      (event.tool_input && event.tool_input.subagent_type) || ''
    ).toLowerCase().trim();
    if (role !== 'tester') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    let cwd;
    try { cwd = resolveSafeCwd(event.cwd); } catch (_) { cwd = process.cwd(); }

    // Only fire when tests_passing: true is claimed
    if (!extractTestsPassing(event)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Check for test-runner evidence
    if (hasTestRunnerEvidence(cwd)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // No evidence — apply ramp
    const orchId = resolveOrchId(cwd);
    const threshold = (() => {
      const n = parseInt(process.env.ORCHESTRAY_TESTER_RUNS_TESTS_RAMP_THRESHOLD, 10);
      return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RAMP_THRESHOLD;
    })();

    if (!orchId) {
      // No orchestration context — warn only
      emitGateEvent(cwd, {
        version:        SCHEMA_VERSION,
        schema_version: SCHEMA_VERSION,
        type:           'tester_runs_tests_gate_warn',
        agent_role:     role,
        ramp_count:     null,
        ramp_threshold: threshold,
        ramp_state:     'no_orchestration',
        orchestration_id: null,
      });
      process.stderr.write(
        '[orchestray] validate-tester-runs-tests: WARN — tester claims tests_passing:true ' +
        'but no test-runner Bash evidence found. No orchestration context (cannot ramp). ' +
        'Kill switch: ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const { count } = bumpWarnCount(cwd, orchId, threshold);

    if (count <= threshold) {
      // Within ramp window — warn only
      emitGateEvent(cwd, {
        version:          SCHEMA_VERSION,
        schema_version:   SCHEMA_VERSION,
        type:             'tester_runs_tests_gate_warn',
        agent_role:       role,
        ramp_count:       count,
        ramp_threshold:   threshold,
        ramp_state:       'warn',
        orchestration_id: orchId,
      });
      process.stderr.write(
        '[orchestray] validate-tester-runs-tests: WARN (' + count + '/' + threshold + ') — ' +
        'tester claims tests_passing:true but no test-runner Bash evidence found. ' +
        'Will block after ramp exhausted. Kill switch: ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED=1\n'
      );
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Ramp exhausted — block
    emitGateEvent(cwd, {
      version:          SCHEMA_VERSION,
      schema_version:   SCHEMA_VERSION,
      type:             'tester_runs_tests_gate_blocked',
      agent_role:       role,
      ramp_count:       count,
      ramp_threshold:   threshold,
      ramp_state:       'blocked',
      orchestration_id: orchId,
    });
    process.stderr.write(
      '[orchestray] validate-tester-runs-tests: BLOCKED — tester claims tests_passing:true ' +
      'but no test-runner Bash evidence (npm test|node --test|jest|vitest|pytest) found in ' +
      'the audit window. Run tests before reporting tests_passing:true. ' +
      'Kill switch: ORCHESTRAY_TESTER_RUNS_TESTS_GATE_DISABLED=1\n'
    );
    process.stdout.write(JSON.stringify({
      continue: false,
      reason: 'tester_runs_tests_gate_blocked:no_test_runner_evidence',
    }));
    process.exit(2);
  });
}

module.exports = {
  extractTestsPassing,
  hasTestRunnerEvidence,
  TEST_RUNNER_RE,
};

if (require.main === module) {
  main();
}
