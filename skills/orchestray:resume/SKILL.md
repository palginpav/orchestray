---
name: resume
description: Resume an interrupted orchestration
disable-model-invocation: true
argument-hint: 
---

# Resume Orchestration

The user wants to resume an interrupted orchestration. Follow this protocol to check
for interrupted work, display a summary, and either resume or archive.

## Resume Protocol

1. **Check for interrupted work**: Read `.orchestray/state/orchestration.md`.
   - If the file exists and its frontmatter `status` is `in_progress` or `interrupted`:
     proceed to step 2.
   - If the file does not exist: Report "No interrupted orchestration found. Use
     `/orchestray:run [task]` to start a new orchestration."
   - If the file exists but `status` is `completed`: Report "Last orchestration completed
     successfully. Use `/orchestray:run [task]` for a new task."

2. **Build resume summary**: Read all files in `.orchestray/state/tasks/` directory.
   Parse each task file's YAML frontmatter to extract `id`, `title`, `status`,
   `assigned_to`, `depends_on`, `completed_at`. Read `.orchestray/state/orchestration.md`
   frontmatter for the original `task` description, `started_at`, `total_tasks`, and
   `completed_tasks`. Optionally read `.orchestray/state/agents/` to get agent run
   details for completed tasks.

3. **Display resume summary** in this format:

   ```
   ## Interrupted Orchestration

   **Task:** {task from orchestration.md}
   **Started:** {started_at from orchestration.md}
   **Progress:** {completed_tasks}/{total_tasks} tasks

   ### Completed
   - [x] {task title} ({assigned_to}) -- {brief result from task file body}
   - [x] {task title} ({assigned_to}) -- {brief result}

   ### Remaining
   - [ ] {task title} ({assigned_to}) -- depends on: {deps or "none"}
   - [ ] {task title} ({assigned_to}) -- depends on: {deps or "none"}

   Resume this orchestration? (yes/no)
   ```

4. **On "yes"**: Continue from the next incomplete task following the task dependency
   graph. Identify the next task whose `status` is `pending` and whose `depends_on`
   tasks are all `completed`. Use the PM's delegation strategy to spawn the appropriate
   agent for that task. Continue the orchestration flow as normal (spawning agents,
   collecting results, updating state files per the State Persistence Protocol).

5. **On "no"**: Archive the state directory to `.orchestray/history/{timestamp}-orchestration/`
   where `{timestamp}` is the current ISO timestamp (e.g., `20260407T100000`). Move the
   entire `.orchestray/state/` directory contents to the archive location. Report:
   "Orchestration archived. Use `/orchestray:run [task]` to start fresh."
