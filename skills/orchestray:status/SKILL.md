---
name: status
description: Show current orchestration status
disable-model-invocation: true
argument-hint: 
---

# Orchestration Status

The user wants to see the current state of orchestration. Check the following and report:

## Status Check Protocol

1. **Check for active orchestration**: Read `.orchestray/current-task.json` if it exists.
   - If it exists: Report the task description, status, agents spawned, agents completed, and any pending work.
   - If it does not exist: Report "No active orchestration."

2. **Check state directory**: If `.orchestray/state/` directory exists, read
   `.orchestray/state/orchestration.md` for richer status details. This provides more
   information than `current-task.json` alone.
   - Read `orchestration.md` YAML frontmatter for: `id`, `task`, `status`,
     `complexity_score`, `complexity_level`, `delegation_pattern`, `current_phase`,
     `completed_tasks`, `total_tasks`.
   - Read all files in `.orchestray/state/tasks/` and parse their YAML frontmatter
     to build a per-task status table.
   - Read all files in `.orchestray/state/agents/` and parse their YAML frontmatter
     to show per-agent run status.

3. **Check for recent history**: List files in `.orchestray/history/` if the directory exists.
   - If history exists: Show the most recent 5 orchestrations with their task descriptions, timestamps, and final status (success/partial/failure).
   - If no history: Report "No orchestration history found."

4. **Format the output** as a clear status report:

```
## Orchestration Status

### Current
[Active task or "No active orchestration"]

### Current (Detailed)
**Orchestration:** {id}
**Complexity:** {complexity_level} (score: {complexity_score}/12)
**Pattern:** {delegation_pattern}
**Phase:** {current_phase}
**Progress:** {completed_tasks}/{total_tasks} tasks

| Task | Agent | Status | Files |
|------|-------|--------|-------|
| {title} | {assigned_to} | {status} | {files_owned} |

### Agent Runs
| Agent | Task | Status | Started | Completed |
|-------|------|--------|---------|-----------|
| {agent} | {task_id} | {status} | {started_at} | {completed_at} |

### Recent History
| # | Task | Status | Completed |
|---|------|--------|-----------|
| 1 | [task] | [status] | [timestamp] |
```

Note: The "Current (Detailed)" and "Agent Runs" sections are only shown when the
`.orchestray/state/` directory exists. Fall back to the basic "Current" section from
`current-task.json` if the state directory is not present.

5. If `.orchestray/` directory does not exist at all, report: "Orchestray has not been used yet in this project. Use `/orchestray:run [task]` to start your first orchestration."
