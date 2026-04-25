<!-- PM Reference: Verify phase slice — loaded when current_phase ∈
     {verify, review}. Re-planning, disagreement detection, and the verify-fix
     loop. -->

# Phase: Verify

This slice covers the post-implementation review path: re-planning when an
agent reports a structural problem, classifying disagreements vs. real bugs,
and the multi-round verify-fix loop with regression prevention.

Cross-phase pointers (validated by `bin/_tools/phase-split-validate-refs.js`):

- The shared infrastructure (state, KB, handoff) is in `(see phase-contract.md §"7. State Persistence Protocol")`, `(see phase-contract.md §"10. Knowledge Base Protocol")`, and `(see phase-contract.md §"11. Context Handoff Protocol")`.
- Re-plan step 4 generates a new task graph using the rules in `(see phase-decomp.md §"13. Task Decomposition Protocol")` — this is the **W5 F-02 cross-phase flow dogfood traversal** target.
- Re-plan re-uses contract generation from `(see phase-decomp.md §"13.X: Contract Generation")`.
- Verify-fix design rejection routes back to re-planning here, then loops back to `(see phase-execute.md §"14. Parallel Execution Protocol")`.
- After successful verify-fix, correction patterns are extracted in `(see phase-close.md §"30. Correction Memory Protocol")`.

---

## 16. Adaptive Re-Planning Protocol

When agents report structural problems -- not implementation bugs -- the PM can
restructure the entire task graph mid-execution, including revisiting completed work.
This implements dynamic workflow adjustment (ROLE-05).

### When to Re-Plan

After pm.md §4 processes each agent result, evaluate these signals. If ANY of
the following are present, a re-plan may be warranted:

1. **Approach invalidation:** Agent reports the chosen approach is fundamentally flawed.
   The design won't work, the library doesn't support the needed feature, the constraint
   was misunderstood.

2. **Scope expansion:** Agent discovers the task is significantly larger than estimated.
   What was a 2-file change is actually a 10-file refactor. New subsystems are involved
   that weren't in the original assessment.

3. **Dependency discovery:** Agent found a dependency not captured in the original graph.
   Task B actually needs Task C to complete first, but C doesn't exist yet.

4. **Completed work invalidation:** New information means already-completed work is wrong.
   The architect designed for REST but the requirement is actually GraphQL. Previous
   implementation must be revisited. Per D-02, there is no completed-work lock-in.

5. **Reviewer design rejection:** Reviewer identifies a design flaw -- not an
   implementation bug. The approach itself is wrong, not just the code. Implementation
   bugs (missing null check, wrong return type, test failure) route to the verify-fix
   loop in §18 below, NOT to re-planning.

If NONE of these signals are present, proceed with the current graph. No re-plan needed.
The vast majority of agent results will NOT trigger re-planning.

### Re-Plan Execution

When a re-plan trigger is confirmed:

1. **Read current task graph** from `.orchestray/state/task-graph.md`. This is the
   baseline for restructuring.

2. **Read all completed task results** from `.orchestray/state/tasks/*.md`. Understand
   what work has been done and what each agent produced.

3. **Evaluate which completed work is still valid** given the new information. Per D-02,
   the PM can revisit completed work -- there is no lock-in. Mark any tasks whose
   output is invalidated by the new information.

4. **Generate a new task graph** by re-running
   `(see phase-decomp.md §"13. Task Decomposition Protocol")` with updated context
   including the new information. Section 13's "Re-Planning Entry Point" subsection
   (also in `phase-decomp.md`) provides the additional context available during
   re-planning. The new graph must conform to the **task-numbering convention**
   defined in `(see phase-decomp.md §"Task Graph Format")` — re-plan does NOT
   change the convention; it produces a new graph that follows the same shape.

5. **Log re-plan event** to audit trail `.orchestray/audit/events.jsonl`:

   ```bash
   ox events append --type=replan --task-id=<task-N> --extra='{"reason":"<one-line reason>","invalidated_count":<N>}'
   ```

   > See `agents/pm-reference/event-schemas.md` §"Section 42: Replan Event" for the
   > canonical schema and required fields. `--extra` must not contain `orchestration_id`,
   > `event`, `ts`, or `type` keys (reserved; `ox` injects them automatically).

6. **Register re-plan decision in KB** at `.orchestray/kb/decisions/replan-{timestamp}.md`
   with the reason and a summary of what changed. This ensures future orchestrations
   can learn from re-plan history.

7. **Update `.orchestray/state/orchestration.md`** with incremented `replan_count` field.
   If this is the first re-plan, add `replan_count: 1` to the YAML frontmatter.

8. **Update state files** for any invalidated tasks: set status to `invalidated` with
   a `invalidation_reason` field explaining why the work is no longer valid.

### Anti-Thrashing Safeguard

Re-planning is expensive -- it discards work and restructures the graph. Unbounded
re-planning can thrash indefinitely. To prevent this:

1. **Track re-plan count** per orchestration in `orchestration.md` frontmatter
   (`replan_count` field).

2. **Read `replan_budget`** from `.orchestray/config.json`. Default is 3 if not set.
   Valid range: 1-10 (validated by the config skill).

3. **Before executing a re-plan**, check: `replan_count >= replan_budget`?

4. **If budget reached**, do NOT re-plan. Instead, escalate to the user:
   ```
   Re-planning budget reached ({N}/{budget}).

   Current situation: [summary of what's happening -- what triggered re-plan,
   what the current state of the task graph is, what work has completed]

   Options:
   1. Increase re-plan budget and continue (I'll try a different approach)
   2. Provide guidance on how to proceed
   3. Abort this orchestration
   ```

5. **Wait for user response** before proceeding. The user decides whether to increase
   the budget, provide direction, or abort.

### Distinguishing Re-Plan from Verify-Fix

Not every problem requires re-planning. Use this decision tree:

| Signal | Route To | Why |
|--------|----------|-----|
| Implementation bug (reviewer found code errors: missing null check, wrong return type, test failure) | §18 below (Verify-Fix Loop) | The approach is correct; the code just has bugs. Fix the code, don't restructure the graph. |
| Design flaw (the approach itself is wrong, not just the code) | §16 here (Re-Plan) | The task graph is based on a flawed design. Restructuring is needed. |
| Scope change (task is bigger or different than expected) | §16 here (Re-Plan) | The original decomposition doesn't cover the actual scope. New tasks are needed. |
| Agent failure (crash, timeout, no useful output) | pm.md §5 (Retry) | Try once more with enhanced context. If retry also fails, THEN evaluate for re-plan. |
| Dependency missing (need something not in the graph) | §16 here (Re-Plan) | The graph is incomplete. Add the missing task and re-order dependencies. |

**Key principle:** Re-planning is for structural problems with the task graph. Verify-fix
is for implementation problems with the code. Retries are for transient agent failures.
Routing correctly prevents wasting the re-plan budget on problems that don't need
graph restructuring.

---

## 18.D: Disagreement Detection

**When to run:** After receiving reviewer findings and BEFORE entering the verify-fix
loop (§18 below). This step classifies "warning" severity findings as either normal
warnings (proceed as usual) or design disagreements (route to surfacing protocol).

**Prerequisite:** `surface_disagreements` config is `true`. If `false`, skip this
section entirely and proceed to §18 as normal.

### Classification Steps

1. **Filter to warning-severity findings:** From the reviewer's structured result, select
   all issues where `severity: "warning"`. Error-severity issues always route to
   §18 verify-fix. Info-severity issues are always informational.

2. **Apply detection criteria** to each warning finding. A finding is a disagreement
   when ALL four conditions are met:
   - Severity is "warning" (already filtered in step 1)
   - Description contains trade-off language: "consider", "alternatively", "trade-off",
     "could also", "one approach vs another", "might prefer", "another option"
   - Finding is about a design CHOICE, not correctness (no compilation error, no security
     vulnerability, no broken test, no missing null check)
   - Finding references a valid alternative approach

3. **Check for matching design-preference pattern:** Before surfacing, glob
   `.orchestray/patterns/design-preference-*.md` and check if any existing preference
   matches this disagreement's context. If a matching preference exists with
   confidence >= 0.8 (requiring at least 3 reaffirmations from the initial 0.6)
   and `deprecated` is not true:
   - Apply the preference automatically (no user prompt needed).
   - Log `disagreement_surfaced` event with `user_decision: "auto_preference"` and
     `preference_name: "{name}"`.
   - Auto-applied preferences must be logged in the orchestration summary.
   - Increase the matched preference's confidence by +0.1 (cap 1.0).
   - Skip surfacing for this finding.

4. **Route disagreements to surfacing protocol:**
   - Read `agents/pm-reference/disagreement-protocol.md` for the surfacing format and
     user response handling.
   - Present each disagreement to the user using the structured format from that file.
   - Log `disagreement_surfaced` event per the schema in event-schemas.md.

5. **Route non-disagreement warnings normally:** Warnings that do not meet all four
   criteria proceed through the normal flow (reported in the summary but not triggering
   verify-fix or surfacing).

**When in doubt, do NOT classify as disagreement.** False negatives (routing a
disagreement through verify-fix) waste some tokens but cause no harm. False positives
(skipping a real issue) miss necessary fixes.

---

## 18. Verify-Fix Loop Protocol

This section replaces the old Section 5 (Retry Protocol). The old Section 5 allowed
one blind retry. §18 implements structured multi-round quality loops where
reviewer feedback is extracted, formatted, and fed to the developer for targeted fixes
with regression prevention.

### When to Enter Verify-Fix Loop

The verify-fix loop is triggered when:

- Reviewer returns `status: "failure"` with `issues` containing `severity: "error"` items.
- Only **error-severity issues** trigger the loop. Warnings and info items do NOT.
- The failure is an **implementation bug**, NOT a design flaw. Design flaws route to
  §16 above (re-planning), not verify-fix.
- **Warning findings classified as disagreements** by §18.D above are excluded from
  this loop -- they route to the disagreement surfacing protocol instead.

If the reviewer returns `status: "failure"` but all issues are warning or info severity,
proceed normally -- the implementation is acceptable with noted improvements.

### Loop Mechanics

For each round of the verify-fix loop:

**a. Extract fix instructions from reviewer:**

Parse the reviewer's structured result (pm.md §4 format). Filter the `issues` array
to `severity: "error"` only. Each issue's `description` field contains a file path,
line reference, and suggested fix (per reviewer protocol Section 4). These become the
fix instructions for the developer.

**b. Build developer fix prompt:**

Include ALL of the following in the developer's delegation prompt:

1. **Original task context** (abbreviated): task title, key files, constraints. Do NOT
   re-send the full original prompt -- just enough for the developer to understand scope.

2. **Specific issues to fix**: the error-severity issues from the reviewer, verbatim.
   Do not paraphrase or summarize -- the reviewer's exact descriptions contain file paths
   and line references the developer needs.

3. **Files that need changes**: extracted from the issue descriptions.

4. **Cumulative fix history**: ALL issues fixed in previous rounds, with the explicit
   instruction: "These issues were fixed in previous rounds and MUST remain fixed. Do
   not regress them." This is the primary anti-regression mechanism.

5. **Attempt counter**: "This is attempt {N} of {verify_fix_max_rounds}" where
   `verify_fix_max_rounds` comes from `.orchestray/config.json` (default 3 per D-05).

6. **Scope restriction**: "Fix ONLY the listed issues. Do not refactor, add features,
   or make unrelated changes."

**c. Spawn developer** with the fix prompt.

**d. Spawn reviewer** to re-validate the developer's fixes.

**e. Evaluate reviewer result:**

- If `status: "success"` (no error-severity issues): **EXIT loop**, proceed normally
  with the orchestration flow.
- If errors remain AND round < `verify_fix_max_rounds`: **CONTINUE loop** (go to step a
  with the new reviewer result).
- If errors remain AND round >= `verify_fix_max_rounds`: **ESCALATE** to the user
  (see User Escalation below).
- If the developer reports the fix is impossible or requires a design change: **TRIGGER
  re-plan** (§16 above). The verify-fix loop cannot resolve design problems.

**f. State tracking:**

Update `.orchestray/state/tasks/{task}.md` with a verify_fix block in the YAML
frontmatter:

```yaml
verify_fix:
  rounds_completed: {N}
  max_rounds: {max}
  round_history:
    - round: 1
      reviewer_issues: {count}
      developer_fixed: {count}
      remaining: {count}
  status: in_progress | resolved | escalated | design_rejected
```

**g. Audit logging:**

For each round, append events to `.orchestray/audit/events.jsonl` using `ox events append`:

- **Round start:**
  ```bash
  ox events append --type=verify_fix_start --task-id=<task-N> --extra='{"round":1,"error_count":3}'
  ```

- **Round pass (loop exits successfully):**
  ```bash
  ox events append --type=verify_fix_pass --task-id=<task-N> --extra='{"round":2,"rounds_total":2}'
  ```

- **Round fail (cap reached):**
  ```bash
  ox events append --type=verify_fix_fail --task-id=<task-N> --extra='{"round":3,"remaining_errors":2}'
  ```

### User Escalation

When `verify_fix_max_rounds` is reached and errors remain (per D-06):

```
Verify-fix loop reached maximum rounds ({N}/{max}).

Remaining issues:
- {list of unresolved error-severity issues from last reviewer pass, verbatim}

Options:
1. Accept current implementation with known issues (I'll document the warnings)
2. Provide guidance for another attempt (describe what to try differently)
```

Log the escalation event:
```bash
ox events append --type=escalation --task-id=<task-N> --extra='{"reason":"verify_fix_cap","remaining_errors":2}'
```

- If user chooses **option 1**: set `verify_fix.status` to `"escalated"` in the task
  state file. Proceed with the orchestration, documenting known issues in the final report.
- If user chooses **option 2**: reset the round counter with the user's guidance as
  additional context in the developer prompt. Continue the loop from round 1, but include
  ALL previous fix history (from before the reset) in the cumulative fix history.

### Regression Prevention

The cumulative fix history included in each developer prompt is the primary
anti-regression mechanism. Every round's developer prompt includes ALL previously
fixed issues with the instruction "MUST remain fixed."

**Oscillation detection:** If round N has the same number of or more errors than
round N-1, this may indicate an oscillation pattern (fixing one issue reintroduces
another). When detected:

1. Log a warning to the audit trail:
   ```bash
   ox events append --type=verify_fix_oscillation --task-id=<task-N> --extra='{"round":2,"errors_current":3,"errors_previous":2}'
   ```

2. Consider escalating early (before reaching the cap) if the error count is trending
   upward across multiple rounds. Two consecutive rounds with non-decreasing errors
   is a strong signal that the developer cannot converge without human guidance.

### Integration with §16 (Re-Plan)

If during a verify-fix loop the developer reports that the fix requires a design change
(not just a code change), the verify-fix loop exits with `status: "design_rejected"` and
control passes to §16 above (Adaptive Re-Planning Protocol). The structural failure
in verify-fix becomes a re-plan trigger signal (Signal 5: Reviewer design rejection).

### Integration with §30 (Correction Extraction)

After successful fix (reviewer passes after developer correction), extract correction
pattern per `(see phase-close.md §"30. Correction Memory Protocol")`.

---
