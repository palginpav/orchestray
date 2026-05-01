---
name: loop
description: Run a tight single-agent loop until a completion promise is met or limits hit
disable-model-invocation: true
argument-hint: "[--agent <type>] [--max-iterations <n>] [--completion-promise <string>] [--cost-cap-usd <n>] [--cancel] <prompt>"
---

# /orchestray:loop

Stop-hook-driven tight loop primitive. Spawns an agent repeatedly with the same prompt
until the agent's output contains the completion promise, OR max iterations are reached,
OR the cost cap is exceeded. Cheaper than verify-fix (no reviewer spawn) for tight tasks
like "iterate on tests until they pass."

## Args

- `--agent <type>` — agent type to spawn (default: `developer`)
- `--max-iterations <n>` — maximum loop iterations before forced stop (default: `10`)
- `--completion-promise <string>` — sentinel string the agent must include in its output
  to signal task completion (default: `TASK_COMPLETE`)
- `--cost-cap-usd <n>` — accumulated cost cap in USD; loop stops when exceeded (default: `0.50`)
- `<prompt>` — the task prompt passed to the agent on every iteration
- `--cancel` — cancel an active loop (clears state, emits `loop_completed(user_cancel)`)

## Behavior

1. Skill writes `.orchestray/state/loop.json` with the loop config:
   ```json
   {
     "enabled": true,
     "agent": "developer",
     "max_iterations": 10,
     "completion_promise": "TASK_COMPLETE",
     "cost_cap_usd": 0.50,
     "prompt": "<the prompt>",
     "iter_count": 0,
     "cost_so_far": 0,
     "started_at": "<ISO 8601>"
   }
   ```
2. PM spawns the first agent with the prompt.
3. On agent Stop: `bin/loop-continue.js` (SubagentStop hook) reads the loop state
   and examines the agent's output:
   - If output contains the completion promise → emit `loop_completed(reason: 'promise_met')`,
     clear state, allow agent to stop.
   - Else if `iter_count < max_iterations` AND `cost_so_far < cost_cap_usd`:
     increment `iter_count`, emit `loop_iteration`, write a re-spawn sentinel so the
     PM re-spawns the agent on the next turn.
   - Else → emit `loop_completed(reason: 'max_iterations' | 'cost_cap')`, clear state,
     allow agent to stop.

## Cancel

`/orchestray:loop --cancel` → clear `.orchestray/state/loop.json`,
emit `loop_completed(reason: 'user_cancel')`.

## Status Line

An active loop is shown in the status bar as `[loop N/max]`.

## Kill Switches

- `ORCHESTRAY_DISABLE_LOOP=1` environment variable — disables the loop hook entirely
  (pass-through on every Stop event).
- `loop.enabled: false` in `.orchestray/config.json` — same effect as above.

## Notes

- The hook is fail-open: any internal error allows the agent to stop normally.
- Per `feedback_default_on_shipping.md`: ships default-on (no-op when no loop state).
- The re-spawn sentinel (`.orchestray/state/loop-respawn.json`) is consumed by the
  PM on the next UserPromptSubmit and triggers a fresh agent spawn.
