#!/usr/bin/env node
'use strict';

/**
 * PreToolUse:Agent hook — enforces model routing during orchestrations.
 *
 * Blocks any Agent() call that omits the `model` parameter or uses
 * model="inherit" while an orchestration is active. Fails open on all
 * unexpected errors so a broken hook never blocks legitimate work.
 *
 * 2.0.12 additions:
 *   - Explicit dispatch allowlist replaces the `toolName !== 'Agent'` fast-exit.
 *     Known agent-dispatch names: {Agent, Explore, Task}.
 *     Known skip names: {Bash, Read, Edit, Glob, Grep, Write, NotebookEdit,
 *       WebFetch, WebSearch, TodoWrite}. Unknown names are handled by
 *     `mcp_enforcement.unknown_tool_policy` (default: "block").
 *   - `global_kill_switch` short-circuits before ANY 2.0.12 check. Routing.jsonl
 *     (2.0.11) validation still runs on known dispatch names.
 *   - MCP checkpoint pre-decomposition gate: after routing.jsonl validation,
 *     verifies that the PM called the required pre-decomposition MCP tools
 *     (pattern_find, kb_search, history_find_similar_tasks) for this
 *     orchestration_id before the first Agent() spawn.
 *
 * Input:  JSON on stdin (Claude Code PreToolUse hook payload)
 * Output: exit 0 (allow) or exit 2 (block) with stderr message
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { getRoutingFilePath, findRoutingEntry } = require('./_lib/routing-lookup');
const { loadMcpEnforcement, loadRoutingGateConfig, loadAntiPatternGateConfig, loadPatternDecayConfig } = require('./_lib/config-schema');
const {
  REQUIRED_PRE_DECOMPOSITION_TOOLS,
  REQUIRED_POST_DECOMPOSITION_TOOLS,
  getCheckpointFilePath,
  findCheckpointsForOrchestration,
  missingRequiredToolsFromRows,
} = require('./_lib/mcp-checkpoint');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

const VALID_TIERS = ['haiku', 'sonnet', 'opus'];

function isValidModel(model) {
  const m = model.toLowerCase();
  return VALID_TIERS.some(tier => m.includes(tier));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] hook stdin exceeded ' + MAX_INPUT_BYTES + ' bytes; aborting\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);

    // Explicit dispatch allowlist. 2.0.12 closes the Explore/Task bypass by routing
    // known agent-dispatch tool names through this gate. Anything else is either a
    // known non-agent built-in (Bash, Read, Edit, Glob, Grep, Write — skip) or an
    // unknown name (fail-closed by default per unknown_tool_policy; user can
    // override in .orchestray/config.json).
    const toolName = event.tool_name || (event.tool_input && event.tool_input.tool) || '';

    const AGENT_DISPATCH_ALLOWLIST = new Set(['Agent', 'Explore', 'Task']);
    const SKIP_ALLOWLIST = new Set([
      'Bash', 'Read', 'Edit', 'Glob', 'Grep', 'Write',
      'NotebookEdit', 'WebFetch', 'WebSearch', 'TodoWrite',
    ]);

    if (SKIP_ALLOWLIST.has(toolName)) {
      process.exit(0);
    }

    // Not a known agent-dispatch OR skip tool — defer decision to unknown_tool_policy
    // AFTER config is loaded (see below).
    const isKnownDispatch = AGENT_DISPATCH_ALLOWLIST.has(toolName);

    const cwd = resolveSafeCwd(event.cwd);
    const mcpEnforcement = loadMcpEnforcement(cwd);

    // Global kill switch — short-circuits before ANY 2.0.12 check. Routing.jsonl
    // (2.0.11) validation still runs on known dispatches. D5 property.
    if (mcpEnforcement.global_kill_switch === true && isKnownDispatch) {
      // In kill-switch mode, we still enforce 2.0.11 model-validity checks on
      // known dispatches but skip the new 2.0.12 MCP-checkpoint gate entirely.
      // Fall through to the existing routing.jsonl validation below.
    } else if (mcpEnforcement.global_kill_switch === true) {
      // Kill switch on AND unknown tool — just exit 0 (degraded to 2.0.11 behavior).
      process.exit(0);
    } else {
      // Unknown-tool policy (only when NOT in kill-switch mode)
      if (!isKnownDispatch) {
        const policy = mcpEnforcement.unknown_tool_policy || 'block';
        if (policy === 'allow') {
          process.exit(0);
        }
        if (policy === 'warn') {
          process.stderr.write(
            "[orchestray] unknown tool name '" + toolName + "' in PreToolUse — " +
            "allowing per unknown_tool_policy=warn. Add to AGENT_DISPATCH_ALLOWLIST " +
            "or SKIP_ALLOWLIST in bin/gate-agent-spawn.js to silence.\n"
          );
          process.exit(0);
        }
        // policy === 'block' (default per Q1)
        process.stderr.write(
          "[orchestray] unknown tool name '" + toolName + "' in PreToolUse — " +
          "blocking per unknown_tool_policy=block. If this is a legitimate Claude Code " +
          "built-in, add it to AGENT_DISPATCH_ALLOWLIST (to gate it) or SKIP_ALLOWLIST " +
          "(to skip gating) in bin/gate-agent-spawn.js. Emergency override: set " +
          "mcp_enforcement.unknown_tool_policy to 'warn' in .orchestray/config.json.\n"
        );
        process.exit(2);
      }
    }

    // From here on: toolName is a known agent-dispatch name (Agent, Explore, or Task),
    // or kill-switch mode is active. Proceed with 2.0.11 routing.jsonl validation.

    const orchFile = getCurrentOrchestrationFile(cwd);

    // Not in an orchestration — no gating, allow freely
    if (!fs.existsSync(orchFile)) {
      process.exit(0);
    }

    // Inside an orchestration — enforce model parameter
    const toolInput = event.tool_input || {};
    const model = toolInput.model;

    if (model === undefined || model === null || model === '') {
      process.stderr.write(
        "[orchestray] Agent() call missing required 'model' parameter. " +
        "Per Section 19, every orchestration spawn must route to haiku/sonnet/opus. " +
        "Re-spawn with model set explicitly.\n"
      );
      process.exit(2);
    }

    if (model === 'inherit') {
      process.stderr.write(
        "[orchestray] Agent() model=\"inherit\" is forbidden during orchestrations. " +
        "Route to haiku/sonnet/opus per Section 19.\n"
      );
      process.exit(2);
    }

    if (!isValidModel(model)) {
      process.stderr.write(
        "[orchestray] Agent() model=\"" + model + "\" is not a recognized routing tier. " +
        "Must contain haiku, sonnet, or opus (full model IDs accepted, e.g. claude-sonnet-4-6). " +
        "Route to haiku/sonnet/opus per Section 19.\n"
      );
      process.exit(2);
    }

    // routing.jsonl validation — check spawn against stored routing decisions
    const routingFile = getRoutingFilePath(cwd);
    if (fs.existsSync(routingFile)) {
      try {
        const agentType = toolInput.subagent_type || '';
        const descRaw = toolInput.description || (toolInput.prompt && toolInput.prompt.substring(0, 80)) || '';
        // W4: task_id-based match (more forgiving than description match).
        // The PM may embed task_id in toolInput.task_id. If present, try to match on
        // (orchestration_id, task_id, agent_type) first — this is immune to description drift.
        // If task_id is unavailable from the spawn context, fall back to (agent_type, description).
        //
        // W4b (v2.0.15 preflight): Claude Code's Agent() wire format currently drops
        // unknown toolInput fields, so toolInput.task_id is almost always null in
        // practice. To make W4 actually activate, extract a task_id from the leading
        // token of the description when it matches our convention `TASK-ID <rest>`
        // (e.g., "DEV-1 ...", "A1 ...", "T3 ..."). This mirrors how the PM writes
        // task_id in routing.jsonl.
        let spawnTaskId = toolInput.task_id || null;
        if (!spawnTaskId && typeof descRaw === 'string') {
          const m = descRaw.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\s/);
          if (m) spawnTaskId = m[1];
        }

        let entry = null;
        let matchedViaTaskId = false;

        if (spawnTaskId) {
          // Primary match: (task_id, agent_type) — description drift does not cause a miss.
          const { readRoutingEntries } = require('./_lib/routing-lookup');
          const allEntries = readRoutingEntries(cwd);
          const allTaskMatches = allEntries.filter(e =>
            e && e.task_id === spawnTaskId && e.agent_type === agentType
          );

          // v2.0.21: scope task_id matches to the current orchestration first.
          // Without this, task_ids like "W2" / "W3" collide across orchestrations
          // and the gate matches a stale prior-orchestration entry, falsely flagging
          // model drift. Fall back to global matches only if the current
          // orchestration has no matching entry.
          let currentOrchId = null;
          try {
            const orchFile = path.join(cwd, '.orchestray', 'audit', 'current-orchestration.json');
            currentOrchId = JSON.parse(fs.readFileSync(orchFile, 'utf8')).orchestration_id || null;
          } catch (_e) { /* no active orch file — global fallback */ }

          const sameOrchMatches = currentOrchId
            ? allTaskMatches.filter(e => e.orchestration_id === currentOrchId)
            : [];
          const taskIdMatches = sameOrchMatches.length > 0 ? sameOrchMatches : allTaskMatches;

          if (taskIdMatches.length > 0) {
            // Take the most recent match (latest timestamp), mirroring findRoutingEntry behaviour.
            taskIdMatches.sort((a, b) => {
              const ta = a.timestamp || '';
              const tb = b.timestamp || '';
              if (tb > ta) return 1;
              if (tb < ta) return -1;
              return 0;
            });
            entry = taskIdMatches[0];
            matchedViaTaskId = true;
            // Warn if description drifted so operators can see the mismatch without hard-blocking.
            const storedDesc = (entry.description || '').trim();
            const lookupDesc = descRaw.substring(0, 80).trim();
            if (storedDesc && lookupDesc && storedDesc !== lookupDesc &&
                !storedDesc.startsWith(lookupDesc + ' ') &&
                !lookupDesc.startsWith(storedDesc + ' ')) {
              process.stderr.write(
                '[orchestray] routing match fell back to task_id key — description drift detected ' +
                '(task_id=' + spawnTaskId + ', agent=' + agentType + '). ' +
                'Stored desc: ' + JSON.stringify(storedDesc) + ', ' +
                'spawn desc: ' + JSON.stringify(lookupDesc) + '. ' +
                'Update routing.jsonl description to match the actual Agent() call to silence.\n'
              );
            }
          }
        }

        if (!entry) {
          // Fallback: (agent_type, description) match — existing behaviour.
          // If task_id was present but produced no match, this fallback still runs.
          if (spawnTaskId) {
            process.stderr.write(
              '[orchestray] routing match fell back to description key (task_id=' + spawnTaskId +
              ' found no match for agent=' + agentType + '). ' +
              'Ensure routing.jsonl entry has matching task_id + agent_type.\n'
            );
          }
          entry = findRoutingEntry(cwd, agentType, descRaw);
        }

        if (entry === null) {
          // D7 (v2.0.16): auto-seed on first miss — turns hard-fail into soft-warn + self-heal.
          // When routing_gate.auto_seed_on_miss=true (default), emit a stderr warning and
          // synthesize a routing entry in routing.jsonl. The PM should write a proper entry
          // per Section 19 BEFORE spawning; this is a DX safety net for the first-miss case.
          // When auto_seed_on_miss=false, restore the prior hard-fail behaviour (exit 2).
          try {
            const routingGateConfig = loadRoutingGateConfig(cwd);
            if (routingGateConfig.auto_seed_on_miss === false) {
              const descPreview = descRaw.substring(0, 80);
              process.stderr.write(
                '[orchestray] no routing entry found for this spawn (agent=' + agentType +
                ', task_id=' + (spawnTaskId || 'null') + ', desc=' + JSON.stringify(descPreview) + '). ' +
                'Per Section 19, the PM must write a routing decision to ' +
                '.orchestray/state/routing.jsonl before spawning. ' +
                'Set routing_gate.auto_seed_on_miss=true to auto-seed instead of hard-blocking.\n'
              );
              process.exit(2);
            }

            // auto_seed_on_miss=true (default): warn + synthesize entry + allow.
            const descPreview = descRaw.substring(0, 80);
            process.stderr.write(
              '[orchestray] routing gate: no entry found for (agent=' + agentType +
              ', task_id=' + (spawnTaskId || 'null') + ', description=' + JSON.stringify(descPreview) + ')' +
              ' — auto-seeding from Agent call; PM should write the entry per Section 19 BEFORE the spawn.\n'
            );

            // Try to read orchestration_id for the synthetic entry.
            let synthOrchId = 'unknown';
            try {
              const orchFileContent = fs.readFileSync(orchFile, 'utf8');
              const parsedOrch = JSON.parse(orchFileContent);
              if (parsedOrch && parsedOrch.orchestration_id) synthOrchId = parsedOrch.orchestration_id;
            } catch (_orchReadErr) {
              // Fall through with 'unknown'
            }

            // Synthesize the routing entry.
            const synthEntry = {
              ts: new Date().toISOString(),
              orchestration_id: synthOrchId,
              task_id: spawnTaskId || null,
              agent_type: agentType,
              // Use model from Agent call if available, else 'inherit' as placeholder.
              model: (model && VALID_TIERS.find(tier => model.toLowerCase().includes(tier))) || 'inherit',
              effort: 'medium',
              description: descPreview,
              rationale: 'auto-seeded on first-spawn miss — PM should replace with explicit routing decision',
            };

            atomicAppendJsonl(routingFile, synthEntry);
            // Allow the spawn — entry is now in routing.jsonl for subsequent validation.
            // Fall through (do not exit here) so the rest of the gate continues.
            // The model mismatch check below will compare against synthEntry.model.
            // Since synthEntry.model uses the spawn's own model tier, this won't block.
            entry = synthEntry;
          } catch (_autoSeedErr) {
            // Fail-open: if auto-seed itself throws (e.g., permission denied on
            // routing.jsonl), warn to stderr and allow the spawn. The audit event
            // is emitted here so operators can diagnose the write failure without
            // needing to grep hook logs.
            process.stderr.write(
              '[orchestray] routing_gate auto-seed write failed: ' +
              (_autoSeedErr && _autoSeedErr.message) +
              '; allowing spawn but routing.jsonl not updated\n'
            );
            // Set entry to a sentinel that will pass the model-mismatch check.
            entry = { model: VALID_TIERS.find(tier => model.toLowerCase().includes(tier)) || 'sonnet' };
          }
        }

        // Normalize the tool_input model to a tier name for comparison.
        // Note: D7 auto-seeded entries trivially pass this check because
        // synthEntry.model is derived from the spawn's own model tier.
        // The check exists to catch stale routing entries from previous sessions
        // where the operator changed the agent's model after decomposition.
        const modelNormalized = VALID_TIERS.find(tier => model.toLowerCase().includes(tier));
        if (modelNormalized !== entry.model) {
          process.stderr.write(
            '[orchestray] model routing mismatch: routing.jsonl says ' + entry.model +
            ' for task ' + (entry.task_id || '(unknown)') +
            (matchedViaTaskId ? ' (matched via task_id)' : '') +
            ' but Agent() was called with model=' + model + '. ' +
            'The PM must pass the model recorded at decomposition time. ' +
            'Re-read routing.jsonl.\n'
          );
          process.exit(2);
        }

        // Entry matches and model is correct — allow the spawn
      } catch (_routingErr) {
        // Fail-open: corrupted file, permission denied, or any unexpected error
        process.stderr.write(
          '[orchestray] gate-agent-spawn: routing.jsonl validation error (' +
          (_routingErr && _routingErr.message) + '); failing open\n'
        );
        // Fall through to allow
      }
    }
    // If routing.jsonl does not exist — pre-decomposition or non-orchestration spawn
    // The existing model-validity checks above have already run, so allow.

    // 2.0.12: MCP checkpoint pre-decomposition gate (only when kill switch is off).
    // Verifies that the PM called the required MCP retrieval tools
    // (pattern_find, kb_search, history_find_similar_tasks) before the first
    // orchestration Agent() spawn. Per-tool enforcement can be toggled off via
    // mcp_enforcement.<tool>: "prompt"|"off" in .orchestray/config.json.
    if (mcpEnforcement.global_kill_switch !== true) {
      try {
        const orchId = (() => {
          try {
            const orchFileContent = fs.readFileSync(orchFile, 'utf8');
            const parsed = JSON.parse(orchFileContent);
            return parsed && parsed.orchestration_id;
          } catch (_e) {
            return null;
          }
        })();

        if (orchId) {
          const checkpointPath = getCheckpointFilePath(cwd);
          const fileExists = fs.existsSync(checkpointPath);

          if (!fileExists) {
            // File absent — upgrade window or pre-decomposition. Fail-open per D6 step 1.
            // Fall through to allow.
          } else {
            // File exists — check if we have any rows for this orchestration.
            const rowsForThisOrch = findCheckpointsForOrchestration(cwd, orchId);

            if (rowsForThisOrch.length === 0) {
              // Zero rows for this orch — cross-orchestration fail-open per D6 step 3
              // bullet 2 and T4 Review Finding C3. Fall through to allow.
            } else {
              // Rows exist — compute required tools that are missing, filtered
              // by per-tool config (only tools set to "hook" are enforced).
              const enforcedTools = REQUIRED_PRE_DECOMPOSITION_TOOLS.filter(
                tool => mcpEnforcement[tool] === 'hook'
              );

              if (enforcedTools.length > 0) {
                // BUG-C-2.0.13: Explicitly pass phaseFilter=null. Phase is an audit/analytics
                // field, not an enforcement field. Filtering by phase would gate-lock any
                // orchestration where BUG-B (pre-fix) poisoned the phase derivation. Even
                // after BUG-B is fixed, phase-strictness at the gate is defense-in-depth
                // we cannot afford — the gate's job is "did the PM call the tool", not
                // "did the PM call it at the right phase label". Do NOT revert without
                // reading CHANGELOG.md §2.0.13 BUG-B / BUG-D.
                const missing = missingRequiredToolsFromRows(rowsForThisOrch, enforcedTools, null);

                if (missing.length > 0) {
                  // BUG-D-2.0.13: produce a phase-aware diagnostic if rows are present but
                  // would have been filtered out under a strict phase check. This avoids
                  // the "missing MCP checkpoint" misleading message when the real issue is
                  // phase mismatch. Pre-fix BUG-B installations could hit this path on
                  // upgrade; the automatic migration sweep (W11) should clear it, but the
                  // diagnostic path remains as a belt-and-braces safety net.
                  //
                  // Check whether a strict pre-decomposition filter would have seen the
                  // same tools as missing. If the null-filter finds absences but the
                  // strict filter would not have found any rows at all, the rows are truly
                  // absent (true absence). If the strict filter finds MORE missing tools
                  // than the null filter, that indicates phase-mismatch rows exist that
                  // the null filter already passes — which means the strict filter is
                  // overly restrictive (BUG-D scenario — unreachable post-BUG-B-fix but
                  // kept as safety net).
                  const missingStrict = missingRequiredToolsFromRows(rowsForThisOrch, enforcedTools, 'pre-decomposition');
                  const phaseMismatchTools = enforcedTools.filter(
                    t => missingStrict.includes(t) && !missing.includes(t)
                  );

                  if (phaseMismatchTools.length > 0) {
                    // Phase-mismatch path: rows exist but recorded as wrong phase.
                    // This is the BUG-D diagnostic — should be unreachable post-BUG-B
                    // fix, but emitted as safety net if phase derivation breaks again.
                    process.stderr.write(
                      "[orchestray] mcp checkpoint gate: phase mismatch — tools called but " +
                      "recorded as 'post-decomposition' instead of 'pre-decomposition' for: " +
                      phaseMismatchTools.join(', ') + " in orchestration " + orchId + ". " +
                      "Check mcp-checkpoint.jsonl phase field values. If BUG-B (2.0.13) is " +
                      "suspected (upgraded from pre-2.0.13), see upgrade notes and run the " +
                      "W11 migration sweep. Emergency rollback: set " +
                      "mcp_enforcement.global_kill_switch=true.\n"
                    );
                  } else {
                    // True absence path: tools were genuinely not called.
                    process.stderr.write(
                      "[orchestray] mcp checkpoint gate: missing MCP checkpoint for " +
                      missing.join(', ') + " in orchestration " + orchId + ". " +
                      "Per Section 22b, the PM must call " + missing.join(', ') +
                      " before the first Agent() spawn. Re-run §22b for the missing " +
                      "tool(s) — see tier1-orchestration.md §22b.R for the re-entry " +
                      "protocol — then retry this spawn. To disable enforcement for a " +
                      "specific tool, set mcp_enforcement.<tool> to 'prompt' in " +
                      ".orchestray/config.json. Emergency rollback: set " +
                      "mcp_enforcement.global_kill_switch=true.\n"
                    );
                  }

                  // 2013-W3-mcp_checkpoint_missing: emit machine-readable audit event
                  // before blocking. Reuses `missing` and `phaseMismatchTools` computed
                  // by W1's BUG-D diagnostic block above — do NOT re-derive. Fail-open:
                  // if the write fails, log a warning but always proceed to exit(2).
                  try {
                    const eventsPath = require('path').join(cwd, '.orchestray', 'audit', 'events.jsonl');
                    atomicAppendJsonl(eventsPath, {
                      timestamp: new Date().toISOString(),
                      type: 'mcp_checkpoint_missing',
                      orchestration_id: orchId,
                      missing_tools: missing,
                      phase_mismatch: phaseMismatchTools.length > 0,
                      source: 'hook',
                    });
                  } catch (_emitErr) {
                    process.stderr.write(
                      '[orchestray] gate-agent-spawn: failed to emit mcp_checkpoint_missing event (' +
                      (_emitErr && _emitErr.message) + '); continuing to block\n'
                    );
                  }

                  process.exit(2);
                }
                // All enforced tools present — allow.
              }
            }
          }
        }
      } catch (mcpErr) {
        // Fail-open: any unexpected error in the checkpoint gate matches the
        // routing.jsonl validation discipline (fail-open on corruption/error).
        process.stderr.write(
          '[orchestray] gate-agent-spawn: mcp checkpoint validation error (' +
          (mcpErr && mcpErr.message) + '); failing open\n'
        );
        // Fall through to allow.
      }
    }

    // §22c Stage B (v2.0.16): second-spawn post-decomposition gate.
    // After the first Agent() spawn (i.e., routing.jsonl exists for this orch),
    // check whether the PM called pattern_record_application OR pattern_record_skip_reason.
    // Enforcement mode: 'hook-warn' = stderr warn + allow; 'hook-strict' = block (exit 2).
    // Kill switch short-circuit retained. First-spawn carve-out: if routing.jsonl is absent,
    // this is the pre-decomposition window — skip this gate entirely.
    if (mcpEnforcement.global_kill_switch !== true) {
      try {
        const praEnforcement = mcpEnforcement.pattern_record_application;
        // Only enforce when mode is 'hook-warn' or 'hook-strict'. 'hook', 'prompt', 'allow' skip.
        if (praEnforcement === 'hook-warn' || praEnforcement === 'hook-strict') {
          // First-spawn carve-out: routing.jsonl must exist for this to be a second-or-later spawn.
          if (fs.existsSync(routingFile)) {
            try {
              const orchId = (() => {
                try {
                  const orchFileContent = fs.readFileSync(orchFile, 'utf8');
                  const parsedOrch = JSON.parse(orchFileContent);
                  return parsedOrch && parsedOrch.orchestration_id;
                } catch (_e) {
                  return null;
                }
              })();

              if (orchId) {
                const checkpointPath = getCheckpointFilePath(cwd);
                const rowsForThisOrch = fs.existsSync(checkpointPath)
                  ? findCheckpointsForOrchestration(cwd, orchId)
                  : [];

                // Check for EITHER pattern_record_application OR pattern_record_skip_reason.
                // Either satisfies the post-decomposition protocol.
                const postDecompTools = ['pattern_record_application', 'pattern_record_skip_reason'];
                const hasPostDecompRecord = rowsForThisOrch.some(
                  row => row && postDecompTools.includes(row.tool)
                );

                if (!hasPostDecompRecord) {
                  // Also check events.jsonl for pattern_record_skip_reason events
                  // (the skip-reason tool writes to events.jsonl, not just checkpoint).
                  let hasEventsRecord = false;
                  try {
                    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
                    if (fs.existsSync(eventsPath)) {
                      // F08: cap events.jsonl read at 2 MB to prevent blocking on huge files.
                      const MAX_EVENTS_READ = 2 * 1024 * 1024;
                      let eventsRaw;
                      try {
                        const evStat = fs.statSync(eventsPath);
                        if (evStat.size > MAX_EVENTS_READ) {
                          process.stderr.write(
                            '[orchestray] gate-agent-spawn: events.jsonl exceeds 2 MB (' +
                            evStat.size + ' bytes); reading tail only for §22c Stage B check\n'
                          );
                          const evFd = fs.openSync(eventsPath, 'r');
                          try {
                            const evBuf = Buffer.alloc(MAX_EVENTS_READ);
                            const evBytesRead = fs.readSync(evFd, evBuf, 0, MAX_EVENTS_READ, evStat.size - MAX_EVENTS_READ);
                            eventsRaw = evBuf.slice(0, evBytesRead).toString('utf8');
                            const firstNl = eventsRaw.indexOf('\n');
                            if (firstNl !== -1) eventsRaw = eventsRaw.slice(firstNl + 1);
                          } finally {
                            fs.closeSync(evFd);
                          }
                        } else {
                          eventsRaw = fs.readFileSync(eventsPath, 'utf8');
                        }
                      } catch (_evReadErr) {
                        // Fail-open: if we can't read events, don't block.
                        hasEventsRecord = true;
                        eventsRaw = null;
                      }
                      if (eventsRaw !== null) {
                        for (const rawLine of eventsRaw.split('\n')) {
                          const line = rawLine.trim();
                          if (!line) continue;
                          let ev;
                          try { ev = JSON.parse(line); } catch (_e) { continue; }
                          if (!ev || typeof ev !== 'object') continue;
                          if (ev.orchestration_id !== orchId) continue;
                          if (ev.type === 'pattern_record_skip_reason' ||
                              ev.type === 'mcp_tool_call' && ev.tool === 'pattern_record_skip_reason') {
                            hasEventsRecord = true;
                            break;
                          }
                        }
                      } // end if (eventsRaw !== null)
                    } // end if (fs.existsSync(eventsPath))
                  } catch (_evErr) {
                    // Fail-open: if we can't read events, don't block.
                    hasEventsRecord = true;
                  }

                  if (!hasEventsRecord) {
                    if (praEnforcement === 'hook-strict') {
                      // Emit machine-readable audit event before blocking.
                      try {
                        const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
                        atomicAppendJsonl(eventsPath, {
                          timestamp: new Date().toISOString(),
                          type: 'mcp_checkpoint_missing',
                          orchestration_id: orchId,
                          missing_tools: ['pattern_record_application'],
                          phase: 'post-decomposition',
                          phase_mismatch: false,
                          source: 'hook',
                        });
                      } catch (_emitErr) {
                        process.stderr.write(
                          '[orchestray] gate-agent-spawn: failed to emit post-decomp mcp_checkpoint_missing event (' +
                          (_emitErr && _emitErr.message) + '); continuing to block\n'
                        );
                      }
                      const hookStrictMsg =
                        '[orchestray] §22c hook-strict: second Agent() spawn blocked — no ' +
                        'pattern_record_application or pattern_record_skip_reason record found ' +
                        'for orchestration ' + orchId + ' in post-decomposition window. ' +
                        'Per §22b, call mcp__orchestray__pattern_record_application (or ' +
                        'mcp__orchestray__pattern_record_skip_reason) before the next spawn. ' +
                        'Emergency override: set mcp_enforcement.global_kill_switch=true or ' +
                        'mcp_enforcement.pattern_record_application to "allow".';
                      process.stderr.write(hookStrictMsg + '\n');
                      // F14: emit structured hookSpecificOutput JSON on stdout so Claude Code
                      // can surface a machine-readable denial reason (mirrors context-shield.js).
                      process.stdout.write(JSON.stringify({
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: hookStrictMsg,
                        },
                      }));
                      process.exit(2);
                    } else {
                      // hook-warn: stderr warn + allow
                      process.stderr.write(
                        '[orchestray] §22c hook-warn: second Agent() spawn — no ' +
                        'pattern_record_application or pattern_record_skip_reason record found ' +
                        'for orchestration ' + orchId + '. Per §22b, call ' +
                        'mcp__orchestray__pattern_record_application (or ' +
                        'mcp__orchestray__pattern_record_skip_reason) to complete the protocol. ' +
                        'To upgrade to blocking enforcement, set ' +
                        'mcp_enforcement.pattern_record_application to "hook-strict".\n'
                      );
                      // Fall through to allow (exit 0 below)
                    }
                  }
                }
              }
            } catch (_postDecompErr) {
              // Fail-open: unexpected errors in post-decomp gate must not block.
              process.stderr.write(
                '[orchestray] gate-agent-spawn: post-decomp gate error (' +
                (_postDecompErr && _postDecompErr.message) + '); failing open\n'
              );
            }
          }
          // If routing.jsonl is absent: pre-decomposition window — skip this gate.
        }
      } catch (_praErr) {
        // Fail-open: fail-safe on any config/gate error.
        process.stderr.write(
          '[orchestray] gate-agent-spawn: §22c gate error (' +
          (_praErr && _praErr.message) + '); failing open\n'
        );
      }
    }

    // W12 (v2.0.18): Anti-pattern pre-spawn advisory gate.
    // Matches the pending Agent() spawn against anti-pattern patterns in
    // .orchestray/patterns/anti-pattern-*.md. When a strong-signal match is
    // found (decayed_confidence >= threshold), injects an advisory into the
    // spawned agent's context via additionalContext (OQ-TB-1 choice).
    //
    // Contract:
    //   - ALWAYS exit 0 regardless of match/no-match. Never blocks a spawn.
    //   - At most 1 advisory per spawn (cap enforced by config.max_advisories_per_spawn).
    //   - Suppressed when skip_category:contextual-mismatch in recent events for same pattern.
    //   - Kill-flag: anti_pattern_gate.enabled=false short-circuits before scan.
    //   - Fail-open: any internal error logs to stderr and allows the spawn.
    try {
      const antiPatternResult = runAntiPatternAdvisoryGate(cwd, toolInput, orchFile);
      if (antiPatternResult && antiPatternResult.additionalContext) {
        // Emit advisory via additionalContext — reaches the spawned agent transparently.
        process.stdout.write(JSON.stringify({ additionalContext: antiPatternResult.additionalContext }));
        // Emit audit event (non-blocking — fail-open on write error).
        try {
          const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
          atomicAppendJsonl(eventsPath, {
            timestamp: new Date().toISOString(),
            type: 'anti_pattern_advisory_shown',
            orchestration_id: antiPatternResult.orchestration_id,
            pattern_name: antiPatternResult.pattern_name,
            agent_type: antiPatternResult.agent_type,
            matched_trigger: antiPatternResult.matched_trigger,
            decayed_confidence: antiPatternResult.decayed_confidence,
          });
        } catch (_evErr) {
          process.stderr.write(
            '[orchestray] gate-agent-spawn: failed to emit anti_pattern_advisory_shown event (' +
            (_evErr && _evErr.message) + '); allowing spawn\n'
          );
        }
      }
    } catch (_apErr) {
      // Fail-open: anti-pattern gate must never block a legitimate spawn.
      process.stderr.write(
        '[orchestray] gate-agent-spawn: anti-pattern advisory gate error (' +
        (_apErr && _apErr.message) + '); failing open\n'
      );
    }

    // Valid model + routing entry + MCP checkpoints — allow the spawn.
    process.exit(0);

  } catch (_e) {
    // Fail open: malformed JSON, missing stdin, or any other unexpected error
    process.stderr.write('[orchestray] gate-agent-spawn: unexpected error (' + (_e && _e.message) + '); failing open\n');
    process.exit(0);
  }
});

// ---------------------------------------------------------------------------
// W12: Anti-pattern pre-spawn advisory gate implementation
// ---------------------------------------------------------------------------

/**
 * Parse YAML-style frontmatter from a markdown file.
 * Returns null if no valid frontmatter block is found.
 * Handles the subset of YAML used in pattern files:
 *   scalar strings, numbers, ISO dates, and YAML sequence arrays.
 *
 * @param {string} content - Raw file content.
 * @returns {object|null}
 */
function parsePatternFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const block = match[1];
  const fm = {};
  let i = 0;
  const lines = block.split(/\r?\n/);
  while (i < lines.length) {
    const line = lines[i];
    // Key: value (scalar)
    const scalarMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (scalarMatch) {
      const key = scalarMatch[1];
      const rawVal = scalarMatch[2].trim();
      // Peek ahead — if the next line(s) are array items (start with "  -"), collect them.
      const arrayItems = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        arrayItems.push(lines[j].replace(/^\s+-\s+/, '').trim());
        j++;
      }
      if (arrayItems.length > 0) {
        fm[key] = arrayItems;
        i = j;
        continue;
      }
      // Scalar: attempt numeric, boolean, null coercion.
      if (rawVal === 'null' || rawVal === '') {
        fm[key] = null;
      } else if (rawVal === 'true') {
        fm[key] = true;
      } else if (rawVal === 'false') {
        fm[key] = false;
      } else if (!isNaN(Number(rawVal)) && rawVal !== '') {
        fm[key] = Number(rawVal);
      } else {
        fm[key] = rawVal;
      }
    }
    i++;
  }
  return fm;
}

/**
 * Read the last N events from events.jsonl filtered to a specific orchestration.
 * Returns an empty array on any error (fail-open).
 *
 * @param {string} cwd
 * @param {string} orchId
 * @param {number} limit - Maximum number of events to scan (from the tail).
 * @returns {object[]}
 */
function readRecentOrchEvents(cwd, orchId, limit) {
  try {
    const eventsPath = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return [];
    const MAX_READ = 512 * 1024; // 512 KB tail scan — well within latency budget
    const stat = fs.statSync(eventsPath);
    let raw;
    if (stat.size > MAX_READ) {
      const fd = fs.openSync(eventsPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_READ);
        const bytesRead = fs.readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ);
        raw = buf.slice(0, bytesRead).toString('utf8');
        // Drop the first (likely partial) line.
        const firstNl = raw.indexOf('\n');
        if (firstNl !== -1) raw = raw.slice(firstNl + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(eventsPath, 'utf8');
    }
    const events = [];
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch (_) { continue; }
      if (!ev || typeof ev !== 'object') continue;
      if (ev.orchestration_id !== orchId) continue;
      events.push(ev);
    }
    // Return the last `limit` events for this orchestration.
    return events.slice(-limit);
  } catch (_) {
    return [];
  }
}

/**
 * Check whether a pattern has been suppressed by a contextual-mismatch skip
 * in the last 10 events for this orchestration.
 *
 * @param {string} cwd
 * @param {string} orchId
 * @param {string} patternName
 * @returns {boolean} true if suppressed
 */
function isPatternSkipEnrichedMismatch(cwd, orchId, patternName) {
  const recentEvents = readRecentOrchEvents(cwd, orchId, 10);
  return recentEvents.some(ev =>
    ev.type === 'pattern_skip_enriched' &&
    ev.pattern_name === patternName &&
    ev.skip_category === 'contextual-mismatch'
  );
}

/**
 * Compute decayed_confidence using the same formula as W9's pattern_find.js.
 * Re-implemented inline (not imported) because pattern_find.js is in the MCP
 * server subtree and not exported for gate-agent-spawn consumption.
 *
 * Formula: decayed_confidence = confidence * 0.5 ^ (age_days / half_life)
 *
 * @param {number} confidence
 * @param {object} fm - Parsed frontmatter.
 * @param {string} filepath - For mtime fallback.
 * @param {object} decayConfig - { default_half_life_days, category_overrides }
 * @returns {number}
 */
function computeDecayedConfidence(confidence, fm, filepath, decayConfig) {
  const nowMs = Date.now();
  let refMs = null;

  if (fm.last_applied && typeof fm.last_applied === 'string' && fm.last_applied !== 'null') {
    const parsed = Date.parse(fm.last_applied);
    if (!isNaN(parsed)) refMs = parsed;
  }

  if (refMs === null) {
    try {
      refMs = fs.statSync(filepath).mtimeMs;
    } catch (_) {
      refMs = nowMs; // 0 days old → no decay
    }
  }

  const ageDays = Math.max(0, Math.floor((nowMs - refMs) / 86400000));

  // Resolve half-life: per-pattern → category override → global default.
  let halfLife = decayConfig.default_half_life_days;
  const category = fm.category;
  if (
    decayConfig.category_overrides &&
    typeof decayConfig.category_overrides === 'object' &&
    category && category in decayConfig.category_overrides
  ) {
    const cv = decayConfig.category_overrides[category];
    if (Number.isInteger(cv) && cv >= 1) halfLife = cv;
  }
  if (Number.isInteger(fm.decay_half_life_days) && fm.decay_half_life_days >= 1) {
    halfLife = fm.decay_half_life_days;
  }

  return Math.round(confidence * Math.pow(0.5, ageDays / halfLife) * 1000) / 1000;
}

/**
 * Check whether a spawn description matches any trigger in a trigger_actions array.
 * Returns the first matching trigger string, or null if no match.
 *
 * Matching is case-insensitive substring match. Each trigger in the array is a
 * plain substring (no regex). This is Option A from the DESIGN spec.
 *
 * @param {string} description - The Agent() spawn description.
 * @param {string[]} triggerActions - Array of trigger substrings from frontmatter.
 * @returns {string|null} First matching trigger, or null.
 */
function matchTriggerActions(description, triggerActions) {
  if (!Array.isArray(triggerActions) || triggerActions.length === 0) return null;
  const descLower = description.toLowerCase();
  for (const trigger of triggerActions) {
    if (typeof trigger === 'string' && trigger.length > 0) {
      if (descLower.includes(trigger.toLowerCase())) {
        return trigger;
      }
    }
  }
  return null;
}

/**
 * Run the anti-pattern advisory gate for a pending Agent() spawn.
 *
 * Returns an object with `additionalContext` and audit metadata if an advisory
 * should be shown, or null if no advisory is appropriate.
 *
 * Contract: NEVER throws. Any internal error returns null (fail-open).
 *
 * @param {string} cwd
 * @param {object} toolInput - Parsed tool_input from the hook payload.
 * @param {string} orchFile - Path to current-orchestration.json.
 * @returns {{ additionalContext: string, orchestration_id: string, pattern_name: string,
 *             agent_type: string, matched_trigger: string, decayed_confidence: number }|null}
 */
function runAntiPatternAdvisoryGate(cwd, toolInput, orchFile) {
  // Load gate config — fail-open if absent/malformed.
  const gateConfig = loadAntiPatternGateConfig(cwd);

  // Kill flag: skip entire scan.
  if (!gateConfig.enabled) return null;

  const patternsDir = path.join(cwd, '.orchestray', 'patterns');
  if (!fs.existsSync(patternsDir)) return null;

  // Read anti-pattern files.
  let patternFiles;
  try {
    patternFiles = fs.readdirSync(patternsDir).filter(f => f.startsWith('anti-pattern-') && f.endsWith('.md'));
  } catch (_) {
    return null;
  }
  if (patternFiles.length === 0) return null;

  // Extract spawn context.
  const agentType = toolInput.subagent_type || '';
  const description = toolInput.description || (toolInput.prompt && toolInput.prompt.substring(0, 500)) || '';
  if (!description) return null;

  // Read orchestration_id for skip-enriched filter.
  let orchId = null;
  try {
    if (fs.existsSync(orchFile)) {
      const orchContent = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      orchId = (orchContent && orchContent.orchestration_id) || null;
    }
  } catch (_) { /* fail-open */ }

  const decayConfig = loadPatternDecayConfig(cwd);
  const threshold = typeof gateConfig.min_decayed_confidence === 'number'
    ? gateConfig.min_decayed_confidence
    : 0.65;

  // Score all matching anti-patterns.
  const candidates = [];
  for (const filename of patternFiles) {
    const filepath = path.join(patternsDir, filename);
    let content;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch (_) {
      process.stderr.write('[orchestray] gate-agent-spawn: could not read anti-pattern file ' + filename + '\n');
      continue;
    }

    let fm;
    try {
      fm = parsePatternFrontmatter(content);
    } catch (_) {
      process.stderr.write('[orchestray] gate-agent-spawn: failed to parse frontmatter in ' + filename + '\n');
      continue;
    }
    if (!fm) continue;

    // Option A: require trigger_actions field.
    const triggerActions = fm.trigger_actions;
    if (!Array.isArray(triggerActions) || triggerActions.length === 0) {
      // Anti-pattern has no trigger_actions — skip (safe fallback, not an error).
      continue;
    }

    // Require confidence field; skip if missing or invalid (malformed pattern guard).
    const rawConfidence = fm.confidence;
    if (typeof rawConfidence !== 'number' || isNaN(rawConfidence)) {
      process.stderr.write('[orchestray] gate-agent-spawn: anti-pattern ' + filename + ' has no numeric confidence field; skipping\n');
      continue;
    }

    // Check trigger match.
    const matchedTrigger = matchTriggerActions(description, triggerActions);
    if (!matchedTrigger) continue;

    // Compute decayed_confidence using W9's formula.
    const decayedConfidence = computeDecayedConfidence(rawConfidence, fm, filepath, decayConfig);

    // Threshold filter.
    if (decayedConfidence < threshold) continue;

    // Skip-enriched filter: suppress if contextual-mismatch was recorded for this pattern.
    const patternName = fm.name || filename.replace(/\.md$/, '');
    if (orchId && isPatternSkipEnrichedMismatch(cwd, orchId, patternName)) continue;

    // Compute specificity score: longer triggers are more specific (better match quality).
    const triggerSpecificity = matchedTrigger.length / 100; // normalize to ~0.0..1.0 range
    const score = decayedConfidence * (1 + triggerSpecificity);

    candidates.push({
      fm,
      patternName,
      matchedTrigger,
      decayedConfidence,
      score,
      content,
    });
  }

  if (candidates.length === 0) return null;

  // Cap at 1 advisory (per DESIGN §Risks + config). Take the highest-scoring match.
  const cap = Math.min(
    Number.isInteger(gateConfig.max_advisories_per_spawn) && gateConfig.max_advisories_per_spawn >= 1
      ? gateConfig.max_advisories_per_spawn
      : 1,
    1  // hard cap — never go above 1 regardless of config
  );
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, cap)[0];

  // Build advisory text.
  const approach = (top.fm.approach || top.fm.description || '').toString().trim();
  const advisory = [
    '[Anti-pattern advisory] The following anti-pattern applies to this task:',
    '',
    top.patternName + ': ' + (top.fm.description || '').toString().trim(),
    '',
    'Why it matched: trigger "' + top.matchedTrigger + '" matched in spawn description (decayed_confidence=' + top.decayedConfidence + ')',
    '',
    'Mitigation: ' + (approach || 'See pattern file for details.'),
  ].join('\n');

  return {
    additionalContext: advisory,
    orchestration_id: orchId || 'unknown',
    pattern_name: top.patternName,
    agent_type: agentType,
    matched_trigger: top.matchedTrigger,
    decayed_confidence: top.decayedConfidence,
  };
}
