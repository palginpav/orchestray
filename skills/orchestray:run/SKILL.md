---
name: run
description: Trigger multi-agent orchestration on a task
disable-model-invocation: true
argument-hint: "[--preview] [--context <file>] [task description]"
---

# Orchestrate Task

You are receiving this because the user invoked `/orchestray:run`. Orchestrate the following task using your multi-agent delegation protocol.

<!-- Flag parsing rules:

  --preview flag: if $ARGUMENTS contains "--preview" (anywhere), strip it and
    append the PREVIEW MODE instruction (see trailer comment) to the invocation prompt.
    The PM halts after decomposition without spawning agents.

  --context <file> flag (repeatable): if $ARGUMENTS contains one or more `--context <file>` tokens:
    1. Strip every `--context <path>` token pair from $ARGUMENTS.
    2. Resolve each path: relative paths against current cwd, absolute paths
       used as-is, `~/...` expanded against $HOME. Files that don't exist
       must be reported but do not abort.
    3. Initialize state directory if missing, then update
       `.orchestray/state/orchestration-pins.json` keyed by the
       orchestration_id you initialize in step 5a of the protocol below:
         {
           "<orch-id>": {
             "pinned_files": ["abs/path/one", "abs/path/two"],
             "total_bytes": <int>,
             "soft_cap_warned": false
           }
         }
    4. Soft cap: 8 KB total bytes across pins. If exceeded, warn the user
       inline (single line) but never block — set `soft_cap_warned: true`.
    5. The compose-block-a hook reads this file and prepends the pinned-file
       contents to Zone 1 with a `[pinned: <path>]` annotation. The hook
       emits a `context_pin_applied` audit event when the prepend lands.
    6. Pinned-file bytes are EXCLUDED from the repo-map token budget — they
       are additive context, not subtracted from any zone budget.
  If $ARGUMENTS contains no `--context` tokens: skip pin handling.
-->

## Task

<!-- Strip "--preview" and `--context <file>` tokens from the raw arguments to get the actual task description. -->
$ARGUMENTS

## Orchestration Instructions

Follow this protocol for the task above:

1. **Check for interrupted orchestration**: Read `.orchestray/state/orchestration.md`. If an interrupted orchestration exists, ask the user whether to resume it or start fresh. (See Section 7 Auto-Detect Resume in your system prompt.)

2. **Read configuration**: Read `.orchestray/config.json` if it exists. Check for `force_orchestrate`, `force_solo`, and `complexity_threshold` overrides.

3. **Score complexity**: Apply your Complexity Scoring protocol (Section 12) to the task:
   - Evaluate all 4 signals (file count, cross-cutting concerns, description, keywords)
   - Calculate total score (0-12)
   - Apply config overrides if set
   - Report to user: "Complexity: {level} (score {N}/12) -- {rationale}"

4. **If Simple (score < threshold)**: Handle the task directly without spawning subagents. Tell the user orchestration is not needed.

5. **If Medium or Complex (score >= threshold)**:
   a. Initialize state and KB: create `.orchestray/state/` directory, write `orchestration.md`. Also initialize KB if missing (Section 10: KB Initialization — create `.orchestray/kb/` with `facts/`, `decisions/`, `artifacts/` subdirectories and `index.json`). Initialize audit trail: Create `.orchestray/audit/` directory, write `current-orchestration.json` with `{"orchestration_id": "orch-{timestamp}", "task": "$ARGUMENTS summary", "started_at": "<ISO timestamp>"}`, and append an `orchestration_start` event to `events.jsonl`. (See PM Section 15, step 1.)
   b. **Decompose the task**: Apply your Task Decomposition Protocol (Section 13)
      - Identify 2-6 subtasks with agent assignments
      - Map dependencies and parallel groups
      - Assign exclusive file ownership
      - Write task graph to `.orchestray/state/task-graph.md`
      - Write individual task files to `.orchestray/state/tasks/`
   c. **Tell the user** the decomposition: show subtasks, agents, dependencies, parallel groups
   d. **Execute** following the task graph using the Parallel Execution Protocol (Section 14). For each parallel group, spawn agents with worktree isolation. After group completes, merge sequentially, verify file ownership, and display running costs (Section 15). Continue group by group until all groups complete.
   e. **Use context handoffs**: For sequential tasks, use KB + diff handoff protocol (Section 11). When delegating to each agent, include the KB write instruction template from Section 10 ("Instructing Agents to Write KB") AND tell subsequent agents which specific KB files to read (by full path, not "check the KB").
   f. **Handle failures**: Apply Retry Protocol (Section 5)
   g. **Update state** continuously (Section 7)

6. **On completion**:
   - Report results, archive state to history.
   - Write `orchestration_complete` event to `events.jsonl` with total token usage and cost estimate (See PM Section 15, step 3).
   - Archive audit trail: move `.orchestray/audit/events.jsonl` to `.orchestray/history/{timestamp}-orchestration/events.jsonl`.
   - Clean up: delete `.orchestray/audit/current-orchestration.json`.
   - Include per-agent cost breakdown in the completion summary.

## Output

After orchestration completes:
- Summarize what each agent did and the outcome
- List all files changed across all agents
- Report any issues or warnings from agents
- Archive orchestration state to `.orchestray/history/{timestamp}-orchestration/`

---

<!-- PREVIEW MODE instruction block

If the string "--preview" appeared anywhere in $ARGUMENTS, append the following
instruction to your invocation prompt. This is the only change --preview makes.
The PM reads this instruction and halts after decomposition.

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

<!-- Implementation history:
  - W8 v2.0.18 (UX2): added --preview flag handling.
  - v2.2.8 Item 8: added --context <file> flag parsing.
-->
