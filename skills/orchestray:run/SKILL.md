---
name: run
description: Trigger multi-agent orchestration on a task
disable-model-invocation: true
argument-hint: "[--preview] [task description]"
---

# Orchestrate Task

You are receiving this because the user invoked `/orchestray:run`. v2.2.3 P4 A3 introduced the **`pm-router`** Haiku entry-point gateway: trivial single-file tasks finish at Haiku rates, complex tasks escalate to the Opus PM unchanged.

<!-- W8 v2.0.18: --preview flag handling (UX2)
  If $ARGUMENTS contains the token "--preview" (anywhere in the string):
    1. Strip "--preview" from $ARGUMENTS to obtain the clean task description.
    2. The effective invocation prompt is the task description below PLUS the
       PREVIEW MODE instruction appended at the end of this file.
  If "--preview" is NOT present: proceed normally with the standard protocol.
-->

## Task

<!-- Strip "--preview" from the raw arguments to get the actual task description. -->
$ARGUMENTS

## Routing Instructions

1. **Read configuration**: Read `.orchestray/config.json` if it exists. Check `pm_router.enabled` (default `true`) and the env var `ORCHESTRAY_DISABLE_PM_ROUTER`.

2. **Default-on path — invoke `pm-router`**: when `pm_router.enabled` is `true` (or absent) AND `ORCHESTRAY_DISABLE_PM_ROUTER` is unset, spawn:

   ```
   Agent(
     subagent_type="pm-router",
     model="haiku",
     effort="low",
     description="Route /orchestray:run task (haiku/low)",
     prompt=$ARGUMENTS
   )
   ```

   The router decides one of three terminal states:
   - **`solo`** — handles the task itself at Haiku rates and returns its Structured Result.
   - **`escalate`** — spawns `Agent(subagent_type="pm", model="opus", ...)` with the user task verbatim and forwards the orchestrator's output back.
   - **`decline`** — refuses with a one-line redirect (e.g., control-flow keywords like `stop`, `abort`).

   Return the router's output verbatim to the user.

3. **Bypass path — invoke `pm` directly**: when `pm_router.enabled === false` OR `ORCHESTRAY_DISABLE_PM_ROUTER=1`, the router gate (`bin/gate-agent-spawn.js`) blocks any router spawn. In that case, spawn the orchestrator PM directly:

   ```
   Agent(
     subagent_type="pm",
     model="opus",
     effort="high",
     description="Orchestrate /orchestray:run task (opus/high)",
     prompt=$ARGUMENTS
   )
   ```

4. **Other slash commands stay unchanged.** `/orchestray:resume`, `/orchestray:redo`, `/orchestray:issue`, `/orchestray:review-pr`, `/orchestray:feature`, `/orchestray:learn`, `/orchestray:learn-doc` continue to invoke `pm` directly. Only `/orchestray:run` goes through the router.

## Output

Return the spawned agent's output verbatim. The router emits its own audit events (`pm_router_decision`, `pm_router_complete`, `pm_router_solo_complete`); the orchestrator PM continues to emit `orchestration_start` / `orchestration_complete` on the escalation path.

---

<!-- W8 v2.0.18: PREVIEW MODE instruction block (UX2)

If the string "--preview" appeared anywhere in $ARGUMENTS, append the following
instruction to your invocation prompt. The router detects --preview and ALWAYS
escalates (preview rendering remains in pm.md), so this block is forwarded
verbatim through the router to the orchestrator.

PREVIEW MODE — perform decomposition and complexity scoring only. Do the following:
1. Score the task complexity (Section 12).
2. Decompose the task into W-items (Section 13): identify agents, sizes, dependencies,
   and parallel groups.
3. Print the W-item table in this format:
   | W | Title | Agent | Model/Effort | Size | Est. Cost | Depends on |
   | -- | ----- | ----- | ------------ | ---- | --------- | ---------- |
   (Cost estimates are approximate; actual usage will vary.)
   Use the cost formula from §6.T of tier1-orchestration.md:
     base_cost(XS)=$0.25, S=$0.45, M=$0.70, L=$1.20, XL=$2.50
     multiplier: haiku/low=0.35, sonnet/medium=1.0, opus/high=2.2
   Per-item estimate = base_cost × multiplier.
4. Do NOT write any state files. Do NOT write orchestration.md, task-graph.md,
   tasks/, or any audit file.
5. Do NOT spawn any subagents.
6. Stop after displaying the preview table and print:
   "Preview only. Re-issue `/orchestray:run <task>` (without --preview) to execute."
-->
