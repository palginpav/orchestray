<!-- PM Reference: Loaded by Section Loading Protocol when enable_checkpoints is true OR confirm_before_execute is true OR resuming interrupted orchestration -->

## 27. Mid-Orchestration User Checkpoints

After each parallel group completes, optionally pause for user review and control.

### When Checkpoints Activate
- Config `enable_checkpoints` is `true`, OR
- Config `confirm_before_execute` is `true` (checkpoints are implied)
- Auto-triggered orchestrations (via complexity-precheck hook): always auto-continue, never checkpoint

### Checkpoint Protocol
After completing a parallel group and before starting the next group:

1. Display group results summary:
   ```
   Group <N> complete (<agent count> agents)
     - <agent> (<model>): <one-line result summary>
     - <agent> (<model>): <one-line result summary>
     Cost so far: ~$<running total>
   ```

2. Present options to the user:
   ```
   Next: Group <N+1> (<agent list with models>)
   
   [continue] proceed to next group
   [modify] adjust the remaining plan
   [review <agent>] show full output from a specific agent
   [abort] stop orchestration and archive state
   ```

3. Handle response:
   - **continue**: proceed to next group normally
   - **modify**: enter structured plan editing (Section 28 below) for the remaining groups. Update task graph and state files.
   - **review <agent>**: display the full result from the named agent, then re-present the checkpoint options
   - **abort**: write `orchestration_aborted` event to audit trail with reason "user requested abort at checkpoint". Archive state to history. Report what was completed and what was skipped.
   - **Any other input**: echo it back and ask "Did you mean to modify the plan with this request, or did you mean continue/review/abort?"

### Checkpoint at Final Group
After the LAST group completes, show results but do NOT present checkpoint options -- proceed directly to orchestration completion (Section 7 archival, in tier1-orchestration.md).

---

## 28. Structured Plan Editing

During `confirm_before_execute` preview OR at a checkpoint "modify" request, support structured edits to the task graph.

### Preview Display Format
```
## Orchestration Plan (score: <N>/12, archetype: <template>)

| # | Task | Agent | Model | Group | Est. Cost |
|---|------|-------|-------|-------|-----------|
| 1 | <description> | <agent> | <model> | 1 | ~$<est> |
| 2 | <description> | <agent> | <model> | 1 | ~$<est> |
| 3 | <description> | <agent> | <model> | 2 | ~$<est> |

Total estimated cost: ~$<total>

Commands: remove <n>, model <n> <opus|sonnet|haiku>, add <agent> after <n>, swap <n> <m>, yes, abort
```

### Supported Commands
- `remove <n>` -- Remove task n from the plan. Validate that no other task depends on it; if so, warn and ask for confirmation.
- `model <n> <opus|sonnet|haiku>` -- Change the model assignment for task n. Update the estimated cost.
- `add <agent> after <n>` -- Insert a new task using the specified agent type after task n. Prompt for a one-line task description. Place in the same group as task n, or the next group if dependencies require it.
- `swap <n> <m>` -- Swap the execution order of tasks n and m. Validate dependency constraints.
- `yes` -- Accept the current plan and begin execution.
- `abort` -- Cancel orchestration entirely.

### After Each Edit
- Re-validate dependency graph (no circular dependencies, no orphaned dependencies)
- Update task numbering
- Re-display the updated plan table
- Continue accepting commands until user types `yes` or `abort`

### Constraints
- Cannot add more than 6 total tasks (Section 13 limit, in tier1-orchestration.md)
- Cannot remove all tasks
- Agent types must be valid: pm, architect, developer, refactorer, inventor, reviewer, debugger, tester, documenter, security-engineer, release-manager, ux-critic, platform-oracle, or a registered specialist name

---

## 32. Fine-Grained Agent Checkpointing

Track individual agent completion for reliable resume after interruptions.

### Checkpoint Protocol
After EACH agent completes successfully during orchestration:
1. Write or update `.orchestray/state/checkpoints.json`:
   ```json
   {
     "orchestration_id": "<id>",
     "checkpoints": [
       {
         "task_id": "task-1",
         "agent": "architect",
         "group": 1,
         "status": "completed",
         "files_changed": ["docs/design.md"],
         "result_summary": "<one-line summary>",
         "timestamp": "<ISO>"
       }
     ],
     "last_checkpoint": "<ISO timestamp>"
   }
   ```
2. Each new checkpoint APPENDS to the `checkpoints` array -- never overwrite previous entries
3. Update the checkpoint's `status` field:
   - `completed` -- agent finished successfully
   - `running` -- agent currently executing (written at spawn time)
   - `failed` -- agent failed and retry exhausted

### Resume Protocol (extends Section 7 Auto-Detect Resume, in tier1-orchestration.md)
Agent checkpointing is always active during orchestration (no config guard needed -- it is
distinct from Section 27's user-facing interactive checkpoints which are controlled by
`enable_checkpoints`, see above).

When resuming an interrupted orchestration:
1. Read `.orchestray/state/checkpoints.json`. If the file exists but cannot be parsed (corrupted JSON from interrupted write), fall back to Section 7's task-file-based resume (in tier1-orchestration.md) and log the corruption.
2. For each checkpoint:
   - `completed`: Skip this task -- its work is already in the codebase
   - `running`: Treat as interrupted -- re-run this task from scratch
   - `failed`: Re-attempt unless retry budget exhausted
3. Check codebase freshness: compare `last_checkpoint` timestamp to `git log -1 --format=%ci`
   - If new commits exist after last checkpoint: warn user that codebase has changed since interruption
   - Ask: "Codebase has changed since last checkpoint. Continue with current state, or re-decompose?"
4. Resume execution from the first non-completed group
5. Log `orchestration_resumed` event with `skipped_tasks` count

### Integration with Section 14 (in tier1-orchestration.md)
At the START of each agent spawn in the parallel execution protocol (Section 14):
- Write a `running` checkpoint for that task
At the END of each agent (after result processing in Section 4):
- Update checkpoint to `completed` with files_changed and result_summary

### Cleanup
On orchestration completion (Section 7, step 6 archive, in tier1-orchestration.md):
- Include `checkpoints.json` in the history archive
- Delete `.orchestray/state/checkpoints.json`
