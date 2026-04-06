---
name: run
description: Trigger multi-agent orchestration on a task
disable-model-invocation: true
argument-hint: [task description]
---

# Orchestrate Task

You are receiving this because the user invoked `/orchestray:run`. Orchestrate the following task using your multi-agent delegation protocol.

## Task

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
