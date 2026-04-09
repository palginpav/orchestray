<!-- PM Reference: Loaded by Section Loading Protocol when enable_backpressure is true -->

# Cognitive Backpressure — Confidence Signaling Protocol

Agents write confidence signals at checkpoints during execution. The PM reads these
signals between groups and after each agent completes, reacting to low confidence by
injecting context, escalating models, or pausing execution. This closes the confidence
gap: agents no longer run to completion when they know they are stuck.

---

## Confidence Checkpoint Protocol

The following instructions are injected into every agent's delegation prompt when
`enable_backpressure` is true (see Section 3.Z in tier1-orchestration.md for injection
mechanics and delegation-templates.md for the exact template block).

### Checkpoint Triggers

Agents write a confidence signal at three points during execution:

1. **post-exploration** — After reading relevant files but BEFORE writing any code or design
2. **post-approach** — After deciding on an implementation approach but BEFORE committing to it
3. **mid-implementation** — Halfway through estimated work

Each checkpoint overwrites the previous one. Only the latest signal matters to the PM.

### Confidence File Format

Task IDs in file paths must be alphanumeric and hyphens only (matching `/^[a-zA-Z0-9-]+$/`).
Strip or replace any other characters before constructing the file path.

Agents write to: `.orchestray/state/confidence/task-{TASK_ID}.json`

```json
{
  "task_id": "{TASK_ID}",
  "checkpoint": "post-exploration | post-approach | mid-implementation",
  "confidence": 0.65,
  "risk_factors": ["unfamiliar dependency pattern", "no test coverage for module"],
  "estimated_remaining_turns": 12,
  "would_benefit_from": "architect guidance on module boundary | null"
}
```

Field notes:
- `confidence`: Float 0.0-1.0. Agents calibrate using the guide below.
- `risk_factors`: Specific concerns, not generic phrases. "Unfamiliar async pattern in
  auth module" is useful; "might be hard" is not.
- `estimated_remaining_turns`: Agent's estimate of how many more tool calls it needs.
- `would_benefit_from`: What additional context would help, or `null` if nothing specific.

### Confidence Calibration Guide

| Range | Meaning | Agent Guidance |
|-------|---------|----------------|
| 0.9+ | Very confident | Familiar pattern, clear path, no unknowns |
| 0.7 - 0.89 | Confident with manageable unknowns | Some uncertainty but workable risk |
| 0.5 - 0.69 | Uncertain | Multiple concerns, may need help |
| 0.3 - 0.49 | Low confidence | Significant blockers, approach may be wrong |
| < 0.3 | Very low | Should probably stop and get guidance |

Agents are instructed: "Be honest. Overconfidence wastes more tokens than admitting
uncertainty."

---

## PM Reaction Table

After reading a confidence signal, the PM reacts based on the confidence band:

| Confidence | PM Action |
|------------|-----------|
| >= 0.7 | **Proceed.** No intervention. Log the signal to audit trail. |
| 0.5 - 0.69 | **Monitor.** Log risk factors. If `would_benefit_from` specifies context available in KB (`.orchestray/kb/`), write it to a context file the agent can read at `.orchestray/state/confidence/context-task-{TASK_ID}.md`. |
| 0.3 - 0.49 | **Pause after completion.** Do NOT proceed to next group. Re-evaluate the task. Options: (1) re-route with enriched context from KB, (2) escalate model tier (Section 19.Z), (3) split task into smaller pieces. |
| < 0.3 | **Escalate to user.** Treat agent output as unreliable regardless of self-report. Report: "Agent reports very low confidence on task {id}. Reason: {risk_factors}. Should I try a different approach or escalate to Opus?" |

### Reaction Mechanics

**Context injection (0.5-0.69):**
1. Check `would_benefit_from` field for a specific request
2. Search `.orchestray/kb/index.json` for entries matching that request
3. If found, write the KB entry content to `.orchestray/state/confidence/context-task-{TASK_ID}.md`
4. The agent may read this file if it checks for additional context (not guaranteed)
5. Log the injection as an info-level note in the audit trail

**Pause-and-evaluate (0.3-0.49):**
1. Wait for the agent to complete (do not interrupt mid-execution)
2. Read the agent's final result AND the confidence signal
3. If final confidence < 0.4 AND agent self-reported "success": override status to "partial",
   log the discrepancy as a warning
4. Before spawning the next group, decide: retry with richer context, escalate model, or split

**User escalation (< 0.3):**
1. Wait for the agent to complete
2. Present the confidence data and risk factors to the user
3. Offer options: different approach, model escalation, manual intervention
4. Do NOT auto-proceed to the next group

---

## Confidence File Lifecycle

```
.orchestray/state/confidence/
  task-1.json     # Overwritten at each checkpoint (only latest matters)
  task-3.json
  context-task-3.md   # PM-injected context (optional, only for 0.5-0.69 band)
```

- **Created by:** Agents, during task execution
- **Read by:** PM, after agent completion and between groups
- **Overwritten:** At each checkpoint (post-exploration -> post-approach -> mid-implementation)
- **Cleaned up:** Archived with orchestration state at completion (Section 15 step 6)

### Graceful Handling

- **No confidence file:** Agent did not write a signal. Treat as "no signal" — proceed
  normally. Do NOT treat as an error. Some agents may not reach a checkpoint before
  completing (e.g., very fast tasks).
- **Malformed JSON:** Log a warning. Treat as "no signal". Do not fail the orchestration.
- **Confidence exactly 0.0 or 1.0:** Valid edge values. 0.0 triggers user escalation,
  1.0 triggers proceed. No special handling needed.

---

## Synergy with Introspection

When both `enable_backpressure` and `enable_introspection` are true, the PM includes
the confidence history (all checkpoint values from the confidence file) in the Haiku
distiller's input (Section 4.Y). This produces richer reasoning traces because the
distiller can correlate confidence drops with specific reasoning steps.

**Distiller prompt addition** (append to the distiller prompt from introspection.md):

```
The agent also wrote confidence signals during execution. Final confidence signal:
{contents of .orchestray/state/confidence/task-{TASK_ID}.json}

Include any confidence-relevant observations in the "Risky Decisions" or "Assumptions"
sections of your trace output.
```

---

## Rollback

Set `enable_backpressure: false` in `.orchestray/config.json`. Effects:
- Section 3.Z skips confidence checkpoint injection — agents execute without checkpoints
- Section 4.Z skips confidence file reading — PM does not react to signals
- Section 14.Z skips inter-group confidence checks — groups proceed normally
- Section 19.Z skips confidence-triggered escalation — routing uses standard logic
- Zero impact on other systems. No files are written or read.
