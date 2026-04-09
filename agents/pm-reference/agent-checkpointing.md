<!-- PM Reference: Loaded by Section Loading Protocol when resuming interrupted orchestration -->

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
`enable_checkpoints`, see checkpoints.md).

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
