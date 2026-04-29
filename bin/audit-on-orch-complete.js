#!/usr/bin/env node
'use strict';

/**
 * audit-on-orch-complete.js — PostToolUse hook that fires the 6 end-of-orch
 * audits exactly once per orchestration_complete event (v2.2.10 F1).
 *
 * Why this exists
 * ---------------
 * Prior to v2.2.10 the 6 audits ran on Stop (or SubagentStop), meaning they
 * fired once per session turn rather than once per orchestration boundary.
 * This made per-orchestration analytics unreliable: audits fired mid-orch
 * (before all agents finished), never fired when the session ended without a
 * Stop hook, and could fire multiple times if the PM stopped several times
 * in one session.
 *
 * F1 moves trigger authority to the `orchestration_complete` event, which the
 * PM emits exactly once per completed orchestration. This hook watches
 * events.jsonl on every PostToolUse:Bash call, detects an unprocessed
 * `orchestration_complete` row, and invokes the 6 audits synchronously in
 * the same process.
 *
 * Deduplication
 * -------------
 * A state file `.orchestray/state/orch-complete-trigger.json` tracks the last
 * `orchestration_id` for which audits were fired. Re-fires within the same
 * orchestration are silently skipped.
 *
 * Invoked audits (in order)
 * -------------------------
 *   1. bin/archive-orch-events.js
 *   2. bin/audit-housekeeper-orphan.js
 *   3. bin/audit-promised-events.js
 *   4. bin/scan-cite-labels.js
 *   5. bin/audit-pm-emit-coverage.js
 *   6. bin/audit-round-archive-hook.js
 *
 * Each audit is spawned as a separate child process with the same stdin
 * payload this hook received, so they see the correct cwd and tool context.
 *
 * Kill switch
 * -----------
 * `ORCHESTRAY_ORCH_BOUNDARY_TRIGGER_DISABLED=1` — exits 0 silently.
 * Per `feedback_default_on_shipping.md`, default-on.
 *
 * Fail-open contract
 * ------------------
 * Hooks must never block Claude Code. Every error path logs to stderr and
 * exits 0. Child process failures are logged but do not prevent the chain
 * from completing.
 */

const fs        = require('node:fs');
const path      = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveSafeCwd }              = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }             = require('./_lib/constants');
const { writeEvent }                  = require('./_lib/audit-event-writer');

const REPO_ROOT  = path.resolve(__dirname, '..');
const STATE_FILE = path.join('.orchestray', 'state', 'orch-complete-trigger.json');

// Kill switch for the MCP fanout (separate from the boundary trigger kill switch).
const FANOUT_DISABLED_ENV = 'ORCHESTRAY_ORCH_COMPLETE_MCP_FANOUT_DISABLED';

// The 6 audits to run, in dependency order (archive first so others can read it).
const AUDIT_SCRIPTS = [
  'archive-orch-events.js',
  'audit-housekeeper-orphan.js',
  'audit-promised-events.js',
  'scan-cite-labels.js',
  'audit-pm-emit-coverage.js',
  'audit-round-archive-hook.js',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCurrentOrchId(cwd) {
  try {
    const file = getCurrentOrchestrationFile(cwd);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && typeof data.orchestration_id === 'string' && data.orchestration_id.length > 0) {
      return data.orchestration_id;
    }
  } catch (_e) { /* fail-open */ }
  return null;
}

/**
 * Return true if events.jsonl contains an orchestration_complete row for orchId.
 */
function hasOrchComplete(eventsPath, orchId) {
  let text;
  try {
    const stat = fs.statSync(eventsPath);
    if (stat.size === 0) return false;
    // Cap read at 64 MB — scan tail if larger.
    const CAP = 64 * 1024 * 1024;
    if (stat.size > CAP) {
      const fd  = fs.openSync(eventsPath, 'r');
      try {
        const buf = Buffer.alloc(CAP);
        fs.readSync(fd, buf, 0, CAP, stat.size - CAP);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(eventsPath, 'utf8');
    }
  } catch (_e) {
    return false;
  }

  // Quick substring pre-filter.
  if (!text.includes('orchestration_complete') || !text.includes(orchId)) return false;

  for (const line of text.split('\n')) {
    if (!line || !line.includes('orchestration_complete') || !line.includes(orchId)) continue;
    try {
      const evt = JSON.parse(line);
      if (
        evt &&
        (evt.type === 'orchestration_complete' || evt.event_type === 'orchestration_complete') &&
        evt.orchestration_id === orchId
      ) {
        return true;
      }
    } catch (_e) { /* skip malformed */ }
  }
  return false;
}

/**
 * Read the last-fired orchestration_id from the state file.
 * Returns null when the file is absent or unparseable.
 */
function readLastFiredId(cwd) {
  try {
    const raw = fs.readFileSync(path.join(cwd, STATE_FILE), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.last_fired_orch_id === 'string') {
      return data.last_fired_orch_id;
    }
  } catch (_e) { /* absent or corrupt */ }
  return null;
}

/**
 * Persist the orchestration_id we just processed so subsequent PostToolUse
 * fires within the same orchestration are skipped.
 */
function writeLastFiredId(cwd, orchId) {
  try {
    const stateDir = path.join(cwd, '.orchestray', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, STATE_FILE),
      JSON.stringify({ last_fired_orch_id: orchId, fired_at: new Date().toISOString() }),
    );
  } catch (e) {
    process.stderr.write('[audit-on-orch-complete] state write failed: ' + e.message + '\n');
  }
}

/**
 * Spawn one audit script synchronously, passing the original hook payload on
 * stdin so the child sees the same cwd and context.
 */
function runAudit(scriptName, stdinPayload) {
  const scriptPath = path.join(REPO_ROOT, 'bin', scriptName);
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      input:   stdinPayload,
      timeout: 10000,
      encoding: 'utf8',
    });
    if (result.stderr && result.stderr.length > 0) {
      process.stderr.write(`[audit-on-orch-complete] ${scriptName} stderr: ${result.stderr}\n`);
    }
    if (result.error) {
      process.stderr.write(`[audit-on-orch-complete] ${scriptName} spawn error: ${result.error.message}\n`);
    }
  } catch (e) {
    process.stderr.write(`[audit-on-orch-complete] ${scriptName} uncaught: ${e.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// MCP fanout helpers
// ---------------------------------------------------------------------------

/**
 * Scan events.jsonl for `archetype_cache_advisory_served` rows belonging to
 * orchId where `pm_decision` indicates the PM actually used the advisory
 * (accepted or adapted — anything other than "overridden" or absent).
 *
 * Returns the first matching archetype_id string, or null when none found.
 */
function findAppliedArchetypeId(eventsPath, orchId) {
  let text;
  try {
    const stat = fs.statSync(eventsPath);
    if (stat.size === 0) return null;
    const CAP = 64 * 1024 * 1024;
    if (stat.size > CAP) {
      const fd = fs.openSync(eventsPath, 'r');
      try {
        const buf = Buffer.alloc(CAP);
        fs.readSync(fd, buf, 0, CAP, stat.size - CAP);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } else {
      text = fs.readFileSync(eventsPath, 'utf8');
    }
  } catch (_e) {
    return null;
  }

  if (!text.includes('archetype_cache_advisory_served') || !text.includes(orchId)) {
    return null;
  }

  for (const line of text.split('\n')) {
    if (!line || !line.includes('archetype_cache_advisory_served') || !line.includes(orchId)) continue;
    try {
      const evt = JSON.parse(line);
      if (
        evt &&
        (evt.type === 'archetype_cache_advisory_served' ||
          evt.event_type === 'archetype_cache_advisory_served') &&
        evt.orchestration_id === orchId
      ) {
        // pm_decision "overridden" means the advisory was not applied.
        const decision = evt.pm_decision;
        if (decision && decision !== 'overridden') {
          return evt.archetype_id || null;
        }
      }
    } catch (_e) { /* skip malformed */ }
  }
  return null;
}

/**
 * Invoke the 3 MCP tool handlers directly (server-side, no RPC).
 * Each successful/failed call emits 1 `mcp_tool_call` event tagged
 * `source: "orch-complete-fanout"`.
 *
 * Conditional: pattern_record_application fires only when archetypeId is non-null.
 *
 * Fail-open: a thrown handler error writes mcp_grounding_prefetch_failed and
 * continues with the remaining tools.
 */
async function runMcpFanout(cwd, orchId, eventsPath) {
  if (process.env[FANOUT_DISABLED_ENV] === '1') return;

  const toolContext = { projectRoot: cwd };

  // Determine whether the archetype advisory was applied in this orchestration.
  const archetypeId = findAppliedArchetypeId(eventsPath, orchId);

  // Build the list of (toolName, input) pairs to invoke.
  const calls = [
    {
      toolName: 'metrics_query',
      input:    { window: 'all', group_by: 'agent_kind', metric: 'count' },
    },
    {
      toolName: 'routing_lookup',
      input:    { orchestration_id: orchId },
    },
  ];

  if (archetypeId) {
    calls.push({
      toolName: 'pattern_record_application',
      input:    {
        slug:             archetypeId,
        orchestration_id: orchId,
        outcome:          'applied',
      },
    });
  }

  for (const { toolName, input } of calls) {
    const t0 = Date.now();
    let outcome = 'error';
    try {
      const modPath = path.join(__dirname, 'mcp-server', 'tools', toolName + '.js');
      const handler = require(modPath);
      const result  = await handler.handle(input, toolContext);
      outcome = (result && result.isError) ? 'error' : 'answered';
    } catch (err) {
      // Fail-open: log the failure event and continue with the next tool.
      try {
        writeEvent({
          type:   'mcp_grounding_prefetch_failed',
          tool:   toolName,
          source: 'orch-complete-fanout',
          error:  (err && err.message ? err.message : String(err)).slice(0, 200),
        }, { cwd });
      } catch (_e) { /* double-fail-open */ }
      outcome = 'error';
    }
    const duration_ms = Date.now() - t0;
    try {
      writeEvent({
        type:              'mcp_tool_call',
        tool:              toolName,
        duration_ms,
        outcome,
        form_fields_count: 0,
        source:            'orch-complete-fanout',
      }, { cwd });
    } catch (_e) { /* fail-open */ }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Always emit continue envelope immediately so a mid-stream failure still
// produces a valid hook response.
process.stdout.write(JSON.stringify({ continue: true }));

(async () => {
  try {
    if (process.env.ORCHESTRAY_ORCH_BOUNDARY_TRIGGER_DISABLED === '1') {
      process.exit(0);
    }

    // Read stdin payload (Claude Code PostToolUse JSON).
    const chunks = [];
    let total    = 0;
    for await (const chunk of process.stdin) {
      total += chunk.length;
      if (total > MAX_INPUT_BYTES) {
        process.stderr.write('[audit-on-orch-complete] stdin too large; skipping\n');
        process.exit(0);
      }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();

    let payload = {};
    if (raw) {
      try { payload = JSON.parse(raw); }
      catch (_e) { /* bad JSON — fall back to cwd-less payload */ }
    }

    const cwd      = resolveSafeCwd(payload && payload.cwd);
    const orchId   = readCurrentOrchId(cwd);
    if (!orchId) {
      process.exit(0);
    }

    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    if (!hasOrchComplete(eventsPath, orchId)) {
      process.exit(0);
    }

    // Deduplication: skip if we already fired for this orchestration.
    const lastFired = readLastFiredId(cwd);
    if (lastFired === orchId) {
      process.exit(0);
    }

    // Mark as fired before running audits so concurrent hook fires are idempotent.
    writeLastFiredId(cwd, orchId);

    // Run the 6 audits in order.
    const stdinPayload = raw || JSON.stringify({ cwd });
    for (const script of AUDIT_SCRIPTS) {
      runAudit(script, stdinPayload);
    }

    // Run the 3 MCP fanout calls after audits (fail-open).
    try {
      await runMcpFanout(cwd, orchId, eventsPath);
    } catch (e) {
      process.stderr.write('[audit-on-orch-complete] fanout uncaught: ' + (e && e.message) + '\n');
    }

    // Emit per-orch event_activation_ratio (N1, v2.2.10).
    try {
      const { run: emitActivationRatio } = require('./emit-event-activation-ratio');
      emitActivationRatio({ cwd, orchId });
    } catch (e) {
      process.stderr.write('[audit-on-orch-complete] activation-ratio uncaught: ' + (e && e.message) + '\n');
    }
  } catch (e) {
    process.stderr.write('[audit-on-orch-complete] uncaught: ' + (e && e.message) + '\n');
  }

  process.exit(0);
})();
