#!/usr/bin/env node
'use strict';

/**
 * UserPromptSubmit hook — remind the PM of required model parameter before
 * the first Agent() spawn in each orchestration session.
 *
 * Fires before every user-prompt turn. Emits an additionalContext hint
 * exactly once per orchestration: after routing has been written but before
 * any spawn has been accepted. Fails open on all errors — never blocks the user.
 *
 * Decision logic (5 conditions, all must be true):
 *   1. .orchestray/audit/current-orchestration.json exists with a valid orchestration_id.
 *   2. .orchestray/state/routing.jsonl has at least one entry for this orchestration_id.
 *   3. No spawn-accepted sentinel exists: .orchestray/state/spawn-accepted/{orchestration_id}
 *   4. The event is not a compaction/resume SessionStart reinject (source field check).
 *   5. The model-reminder sentinel does not exist: .orchestray/state/model-reminder-shown/{orchestration_id}
 *
 * On match: emits hookSpecificOutput.additionalContext JSON on stdout and writes
 * the model-reminder-shown sentinel so the reminder only fires once per orch.
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: exit 0 always; hookSpecificOutput JSON on stdout when reminder fires
 */

const fs = require('fs');
const path = require('path');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { getRoutingFilePath, readRoutingEntries } = require('./_lib/routing-lookup');

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
    const event = JSON.parse(input);
    handleUserPromptSubmit(event);
  } catch (_e) {
    // Fail-open: malformed stdin — exit 0 with no output
    process.exit(0);
  }
});

function handleUserPromptSubmit(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Condition 4: skip compaction/resume reinjections
    const source = event && event.source;
    if (source === 'compact' || source === 'resume') {
      process.exit(0);
    }

    // Condition 1: active orchestration must exist
    const orchFile = getCurrentOrchestrationFile(cwd);
    if (!fs.existsSync(orchFile)) {
      process.exit(0);
    }

    let orchData;
    try {
      orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    } catch (_e) {
      process.exit(0);
    }

    const orchestrationId = orchData && orchData.orchestration_id;
    if (!orchestrationId || typeof orchestrationId !== 'string') {
      process.exit(0);
    }

    // Condition 2: routing.jsonl must have at least one entry for this orchestration_id
    const routingFile = getRoutingFilePath(cwd);
    if (!fs.existsSync(routingFile)) {
      process.exit(0);
    }

    let entries;
    try {
      entries = readRoutingEntries(cwd);
    } catch (_e) {
      process.exit(0);
    }

    const orchEntries = entries.filter(e => e && e.orchestration_id === orchestrationId);
    if (orchEntries.length === 0) {
      process.exit(0);
    }

    // Condition 3: no spawn-accepted sentinel for this orchestration
    const spawnAcceptedDir = path.join(cwd, '.orchestray', 'state', 'spawn-accepted');
    const spawnAcceptedPath = path.join(spawnAcceptedDir, orchestrationId);
    if (fs.existsSync(spawnAcceptedPath)) {
      process.exit(0);
    }

    // Condition 5: model-reminder sentinel must not exist
    const reminderShownDir = path.join(cwd, '.orchestray', 'state', 'model-reminder-shown');
    const reminderShownPath = path.join(reminderShownDir, orchestrationId);
    if (fs.existsSync(reminderShownPath)) {
      process.exit(0);
    }

    // All 5 conditions met — pick the first routing entry to build the example
    // Sort by timestamp ascending to get the "first" pending entry
    const sortedEntries = orchEntries.slice().sort((a, b) => {
      const ta = a.timestamp || '';
      const tb = b.timestamp || '';
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });

    const firstEntry = sortedEntries[0];
    const agentType = firstEntry.agent_type || 'developer';
    const model = firstEntry.model || 'sonnet';
    const maxTurns = firstEntry.maxTurns || firstEntry.max_turns || 30;
    const taskId = firstEntry.task_id || 'TASK-1';

    // Fix 4.3: emit stdout FIRST, then write sentinel — crash between the two
    // means user still saw the reminder; worst case we re-emit on next prompt (harmless).
    // Fix 4.1: orchestrationId already carries the "orch-" prefix from disk — do not re-prepend it.
    const additionalContext =
      '[orchestray] First spawn of ' + orchestrationId + ' is pending. ' +
      'Every Agent() call MUST pass model="haiku"|"sonnet"|"opus" — see routing.jsonl ' +
      'for the assigned model per task. Example for the next spawn: ' +
      'Agent(subagent_type="' + agentType + '", model="' + model + '", maxTurns=' + maxTurns + ', ' +
      'description="' + taskId + ' ...", prompt="...")';

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: additionalContext,
      },
    }));

    // R-DXT (AC-02): emit the model auto-resolve nudge to stderr so operators
    // know about the fallback chain. Character-exact template per spec.
    process.stderr.write(
      '[orchestray] remind-model-before-spawn: If model is omitted, gate-agent-spawn will auto-resolve from routing.jsonl → agent frontmatter → default sonnet (emits model_auto_resolved warn event). Set model explicitly for audit clarity.\n'
    );

    // Write the model-reminder-shown sentinel AFTER emitting output (Fix 4.3)
    try {
      fs.mkdirSync(reminderShownDir, { recursive: true });
      fs.writeFileSync(reminderShownPath, '', { flag: 'wx' });
    } catch (_e) {
      // wx throws EEXIST if file already exists (race) — reminder already went out, that's fine.
      // Other write errors: sentinel not written but reminder was emitted; accept risk of
      // redundant re-emit rather than silent miss.
    }
    process.exit(0);
  } catch (_e) {
    // Fail-open: any unexpected error — exit 0 with no output, no stderr spam
    process.exit(0);
  }
}
