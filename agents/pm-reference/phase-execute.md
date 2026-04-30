<!-- PM Reference: Execution phase slice — loaded when current_phase ∈
     {execute, execution, implementation}. Spawning protocols: parallel
     execution, dynamic agents, model routing, correction-pattern application
     at delegation time. -->

# Phase: Execution

This slice covers everything from "first `Agent()` spawn" through "all groups
merged": parallel execution, dynamic agent spawning, model routing, and
delegation-time correction-pattern injection.

Cross-phase pointers (validated by `bin/_tools/phase-split-validate-refs.js`):

- The shared infrastructure (state, KB, handoff) is in `(see phase-contract.md §"7. State Persistence Protocol")`, `(see phase-contract.md §"10. Knowledge Base Protocol")`, and `(see phase-contract.md §"11. Context Handoff Protocol")`.
- Pre-conditions and contracts come from `(see phase-decomp.md §"13.X: Contract Generation")`.
- Reviewer error-severity returns route to `(see phase-verify.md §"18. Verify-Fix Loop Protocol")`.
- Re-plan triggers route to `(see phase-verify.md §"16. Adaptive Re-Planning Protocol")`.
- Cost-init/aggregation that spans the orchestration is in `(see phase-close.md §"15. Cost Tracking — Detailed Audit Protocols")`.

---

## 14. Parallel Execution Protocol

When task decomposition (`(see phase-decomp.md §"13. Task Decomposition Protocol")`)
identifies parallel groups -- multiple tasks in the same group with no
inter-dependencies -- use this protocol to execute them concurrently with
worktree isolation.

### When to Use

Use this protocol when the task graph from
`(see phase-decomp.md §"13. Task Decomposition Protocol")` contains a parallel
group with 2+ tasks. If a group has only one task, execute it directly using
pm.md §2 delegation patterns. Single-task groups do not need worktree isolation.

### Spawning Parallel Agents

**Step 0 (MANDATORY): Write routing.jsonl rows before ANY Agent() call.**

Before calling `Agent()` for any task in the group (or any sequential task), you MUST
write a routing row for each task to `.orchestray/state/routing.jsonl`. The
`PreToolUse:Agent` hook (`bin/gate-agent-spawn.js`) will hard-block the spawn if no
matching row exists — there is no retry path except writing the row first.

Use `ox routing add` to append each row:

```bash
ox routing add <task-N> <role> <tier> <effort> <score> --desc="<first-80-chars>"
# Example: ox routing add task-1 developer sonnet medium 7 --desc="implement auth endpoint"
```

- `task_id` must be the same value you will pass as `toolInput.task_id` on the `Agent()` call.
  The gate uses `(task_id, agent_type)` as the primary match key (W4 — immune to description drift).
  If you omit `task_id`, the gate falls back to `(agent_type, description)` with a warning.
- Write ALL rows for the group BEFORE the first `Agent()` call in that group.
- For dynamic/re-plan spawns not in the original decomposition, run `ox routing add` with a
  new task-id before calling `Agent()`.
- `ox routing add` is idempotent: re-running with the same `(task_id, agent_type, model)` triple is a safe no-op.

For each task in a parallel group:

1. **Spawn the assigned agent** with the task description (per pm.md §3 delegation rules).
   Every `Agent()` call **MUST include `model: 'haiku'|'sonnet'|'opus'`** — the gate
   will hard-block the spawn without it. Example:
   ```
   Agent(subagent_type="developer", model="sonnet", maxTurns=20,
         description="Fix auth (sonnet/medium)", prompt="...")
   ```
   Write-capable agents (architect, developer, refactorer, tester, security-engineer, inventor)
   now declare `isolation: worktree` in their frontmatter; read-only agents do not. You still
   MUST NOT pass a conflicting `isolation:` override on an individual spawn. If a spawn goes to a
   write-capable agent without worktree isolation (e.g. a custom specialist that omits the
   frontmatter), `bin/warn-isolation-omitted.js` emits an `isolation_omitted_warn` event.
   Write a `running` checkpoint for this task per `agents/pm-reference/checkpoints.md` §32.
   After the agent completes and results are processed (pm.md §4), update the checkpoint
   to `completed`.

2. **Dual isolation layers:**
   - **Layer 1 (file ownership):** Already assigned in
     `(see phase-decomp.md §"13. Task Decomposition Protocol")` decomposition. Each task
     has exclusive "Files (write)" ownership. This prevents logical conflicts.
   - **Layer 2 (worktree isolation):** When `isolation: "worktree"` is passed, each agent's
     changes are on a separate git branch in a separate worktree. This prevents physical
     file conflicts even if an agent accidentally touches files outside its ownership.

3. **Worktree branch naming:** Each agent's worktree branch follows this pattern:
   `orchestray/<orch-id>/task-<N>` (e.g., `orchestray/orch-1712345678/task-3`).
   The `<orch-id>` comes from the orchestration metadata in `.orchestray/state/orchestration.md`.

4. **Spawn all agents in the group**, then wait for all to complete. Group-boundary
   discipline is mechanically enforced by `bin/gate-agent-spawn.js` (v2.2.9 B-5.3) —
   any spawn whose target task lives in a strictly-later group is rejected with
   `group_boundary_violation`. See agents/pm-reference/event-schemas.md for the event
   shape and `ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED=1` for the kill switch.

5. **Post-spawn branch verification (MANDATORY when using worktree isolation):** After each
   agent completes, read its Structured Result `branch` field.
   - If `branch == "master"`: isolation failed silently. Treat the commit as having landed on
     master and plan merges accordingly. Do NOT assume the worktree was used.
   - If `branch` starts with `worktree-agent-` or `orchestray/`: isolation succeeded; proceed
     with the merge protocol.

**Known worktree failure modes (field-confirmed):**

- **Stale base ref:** The harness creates worktrees from a cached ref (likely session-start
  HEAD), not live local HEAD. If several W-items have landed on master since the session
  began, a new worktree will be missing those commits. Mitigation: include `git log -1 HEAD`
  output in the agent's task prompt so the agent can verify its starting point and run
  `git reset --hard <expected-sha>` if it finds itself on a stale tip.
- **Silent fallback to master:** If an agent returns `branch: "master"` when
  `isolation: "worktree"` was specified, do NOT trust the isolation. The agent either ran
  on master from the start (PM omitted the param or harness rejected it) or self-recovered
  onto master. Either way, treat the commit as a master commit and plan subsequent merges
  accordingly rather than assuming a clean worktree branch exists.

### 14.X: Pre-Condition Validation

Before spawning each agent in a parallel group (or sequential task), validate the
task's pre-conditions. Pre-conditions are generated during
`(see phase-decomp.md §"13.X: Contract Generation")` and written to the task
file's `## Pre-Conditions` section.

**Skip condition:** If `contract_strictness` is `"none"`, skip pre-condition validation.
Root tasks (Group 1, no dependencies) have no pre-conditions -- skip this step for them.

**Validation protocol:**

1. **Read pre-conditions**: Open `.orchestray/state/tasks/{NN}-{slug}.md` and read the
   `## Pre-Conditions` section. If the section is empty or missing, proceed to spawn.

2. **Run each check**: Use the same check methods as post-condition validation
   (Section 4.X in pm.md): Glob for `file_exists`, Grep for `file_contains`, etc.

3. **Act on results:**
   - **All pass**: Proceed to spawn the agent normally.
   - **Any fail**: Do NOT spawn the agent. This means a dependency was not met --
     a prior task either failed or did not produce the expected output.
     - Check the dependency task's status in `.orchestray/state/tasks/`.
     - If the dependency task succeeded but its output is missing, this indicates a
       contract gap -- the dependency's post-conditions were too loose. Log a warning
       and attempt to spawn anyway (the agent may still succeed).
     - If the dependency task failed or was skipped, mark this task as
       `status: skipped` with `skip_reason: "pre-condition failed: {check details}"`.

4. **Log results**: Write a `contract_check` event to `.orchestray/audit/events.jsonl`
   with phase `"pre"` and the check results (see event-schemas.md).

### Sequential Merge After Completion

After ALL agents in the parallel group have completed, merge their changes one at a time
in task order (Task 1 before Task 2, etc.). Sequential merge prevents compound conflicts.

For each completed agent's worktree (in task order):

1. **Review the diff:** Run `git diff main...<worktree-branch>` to see what the agent changed.

2. **Verify file ownership:** Check that changes are ONLY in files assigned to that task
   (from the task graph "Files (write)" field in `.orchestray/state/task-graph.md`).

3. **If ownership violated:** Log the violation to `.orchestray/audit/events.jsonl` as a
   `file_ownership_violation` event with these JSON fields:
   - `timestamp`: ISO 8601 timestamp
   - `type`: `"file_ownership_violation"`
   - `orchestration_id`: current orchestration ID
   - `task_id`: the violating task's ID
   - `agent_type`: the agent type (architect, developer, reviewer)
   - `file`: the file that was modified outside ownership
   - `assigned_files`: array of files that were assigned to this task

   Continue with the merge but warn the user about the violation.

4. **Merge:** Run `git merge <worktree-branch>` into the current branch.

5. **If merge conflict:** Attempt automatic resolution. If unresolvable, keep the
   first-merged version (the version already on the current branch) and log the conflict
   details to `.orchestray/audit/events.jsonl`. If the conflict renders the task's work
   unusable, re-run that task sequentially after the merge phase completes.

6. **Clean up:** Run `git worktree remove <path>` after successful merge. This removes
   the worktree directory and its association. The branch can be deleted with
   `git branch -d <worktree-branch>` after merge.

After all worktrees are merged:
- Run tests/lint if applicable to verify the combined changes work together.
- Update state: mark the parallel group as complete in `.orchestray/state/task-graph.md`.

### Waiting Behavior

Show incremental progress per the pm.md §8 Communication Protocol:
- Before group: announce all agents and tasks
- After each agent: `[done] {agent} -- {one-line result} (~${cost}, {turns} turns)`
- After group: running total and next group preview
Do NOT spawn additional work or process new user prompts during the parallel wait.

### Error Handling

- **Agent fails:** Log to audit, continue waiting for group. Offer retry/skip/abort after group finishes.
- **Merge fails:** Keep first-merged version, re-execute conflicting task sequentially if critical.
- **Worktree cleanup fails:** Log but do not block. Clean up with `git worktree prune`.

### Integration with Task Graph Execution Flow

After `(see phase-decomp.md §"13. Task Decomposition Protocol")` produces the task graph,
execution proceeds group by group:

1. **Group 1 (roots):** Execute all tasks in the group via this parallel protocol.
2. **Collect results:** Merge all worktrees, update state, perform context handoffs
   (`(see phase-contract.md §"11. Context Handoff Protocol")`) to prepare context for
   the next group's agents.
2.5. **Checkpoint (if active):** If checkpoints are enabled (`agents/pm-reference/checkpoints.md` §27),
   present checkpoint to user before proceeding to next group. Wait for user response.
3. **Group 2:** Execute via this parallel protocol, using context from Group 1 results.
4. **Continue** until all groups complete.
5. **Final validation:** After the last group merges, run any applicable tests or
   validation to confirm the combined changes work together.
6. **Complete audit trail:** Write orchestration_complete event and archive audit data
   (see `(see phase-close.md §"15. Cost Tracking — Detailed Audit Protocols")` step 3).

### 14.Y: Mid-task Ambiguity Handling via `ask_user`

When you write delegation prompts for specialists, include this verbatim:
"If you hit an ambiguity only the user can resolve (two valid interpretations,
missing context, confirmation before a destructive action), call
`mcp__orchestray__ask_user` with a ≤5-field form before returning
`status: partial`. Budget: at most 2 questions per task. A `cancelled: true`
or `timedOut: true` result means fall back to `status: partial`."

### 14.Z: Inter-Group Confidence Check

When `enable_backpressure` is true, perform a confidence check between group transitions
(after step 2 "Collect results" and before step 3 "Group 2"). This prevents low-confidence
work from cascading into downstream groups.

**Protocol:**

1. **Read all confidence files** for tasks completed in the just-finished group:
   Glob `.orchestray/state/confidence/task-{ID}.json` for each task ID in the group.

2. **Evaluate each signal** against the PM reaction table (`agents/pm-reference/cognitive-backpressure.md`).

3. **If ANY confidence < 0.4 in the completed group:**
   - **PAUSE** before spawning the next group.
   - Log: "Inter-group confidence check: task-{id} reported confidence {value}. Pausing
     before Group {N+1}."
   - Evaluate options per the reaction table:
     a. **Re-route**: Re-execute the low-confidence task with enriched context from KB
        and/or higher model tier (see §19.Z below).
     b. **Split**: Break the downstream tasks that depend on the low-confidence result
        into smaller pieces to reduce risk propagation.
     c. **Accept and continue**: If the PM judges the low confidence is in an area that
        does not affect downstream tasks, proceed with a logged justification.
   - If multiple tasks have low confidence, address each before proceeding.

4. **If all confidences >= 0.4:** Proceed to the next group normally.

5. **If no confidence files exist** for any task in the group: Proceed normally. Absence
   of signal is not a blocker.

6. **Display** confidence summary between groups:
   ```
   Group 1 complete (3/3 tasks). Confidence: task-1: 0.85, task-2: 0.72, task-3: 0.91
   Proceeding to Group 2...
   ```
   ```
   Group 1 complete (3/3 tasks). Confidence: task-1: 0.85, task-2: 0.38 [LOW], task-3: 0.91
   Pausing: task-2 confidence below threshold. Evaluating before Group 2...
   ```

**Integration with checkpoints (`agents/pm-reference/checkpoints.md` §27):** If both
`enable_checkpoints` and `enable_backpressure` are true, the confidence check runs
BEFORE the user checkpoint (step 2.5). Low confidence may resolve the checkpoint
automatically (PM re-routes before asking the user).

---

## 17. Dynamic Agent Spawning Protocol

When task decomposition (`(see phase-decomp.md §"13. Task Decomposition Protocol")`) or
re-planning (`(see phase-verify.md §"16. Adaptive Re-Planning Protocol")`) identifies
a subtask that requires domain expertise not covered by the core agents (architect,
developer, refactorer, inventor, reviewer, debugger, tester, documenter, security-engineer,
release-manager, ux-critic, platform-oracle), the PM can spawn an ephemeral
specialist agent. Dynamic agents are created on demand and removed after completion.

### When to Spawn Dynamic Agents

Consider spawning a dynamic agent when ALL of these apply:

1. **The subtask requires domain expertise not covered by any of the 13 core agents.**
   The core roster (architect, developer, refactorer, inventor, reviewer, debugger,
   tester, documenter, security-engineer, release-manager, ux-critic, platform-oracle,
   pm) covers most software engineering work. Dynamic agents fill the residual
   slivers. Concrete examples that genuinely fit no core agent:
   - **MCP tool author for a new tool category** — needs MCP-specific patterns
     (handler shape, schema validation, elicitation flow) beyond developer's general
     code-writing scope
   - **DSL or grammar specialist** — for projects defining a custom config language
     or query syntax; needs parser-design patterns beyond architect's design scope
   - **Framework-specific migration agent** — e.g. Rails 7→8 with framework-specific
     deprecation map; debugger investigates bugs but doesn't own migration playbooks
   - **Compliance auditor for a specific regulation** — e.g. HIPAA, PCI-DSS, GDPR
     line-item check; security-engineer handles general security but not regulatory
     line-by-line conformance
   - **Domain-specific validator** — e.g. FHIR healthcare bundle validator, financial
     statement reconciler; each needs domain knowledge no generalist carries

   If you're tempted to spawn a dynamic agent for "performance engineer", "data
   engineer", "release manager", or "auditor" — STOP. Use architect's perf-budget
   mode (performance), architect with a migration-design template (data), the new
   `release-manager` core agent (release), or fix reviewer's chunking (audit) instead.

2. **The subtask has unique tool restrictions** different from the core agents, OR
   benefits from a highly focused system prompt that would be diluted if added to a
   core agent's instructions.

3. **The core agents genuinely cannot handle the task well.** Most tasks fit one of
   the 13 cores. Per research: the 3-5 agent sweet spot per orchestration means
   dynamic agents add overhead and should be RARE — expect <1 per release cycle in
   a healthy repo.

There is no hard cap on dynamic agents (per D-03). The PM decides based on task needs,
and the token budget provides the natural limit. However, per Anti-Pattern #10
(pm.md §9), never spawn dynamic agents for tasks the core agents can handle.

When you DO spawn one and it succeeds, evaluate it against the save criteria in
`agents/pm-reference/specialist-protocol.md` §"Save Decision Criteria" and persist
to the registry if it qualifies. Otherwise the dynamic-agent surface never
accumulates and every novel task reinvents the same agent.

### Agent Definition Generation

The PM writes a temporary agent definition file to the `agents/` directory. The file
must follow Claude Code's standard agent `.md` format (YAML frontmatter + markdown body).

**Frontmatter template:**

```yaml
---
name: {task-specific-name}
description: {one-line description of specialization}
tools: {appropriate tool subset -- see tool access patterns below}
model: {routed_model_from_section_19}  # Set by §19 Model Routing Protocol below. Do NOT use 'inherit' during orchestrations.
maxTurns: 30
color: cyan
---
```

**Markdown body (100-200 lines MAX):** The system prompt MUST include:

- Task-specific instructions and domain knowledge
- The project's standard output format (pm.md §6 JSON+markdown result structure)
- KB protocol instruction (`(see phase-contract.md §"10. Knowledge Base Protocol")`)
- Explicit scope boundaries (what to do and what NOT to do)

Keeping the prompt under 200 lines prevents scope creep and context bloat. A focused
specialist performs better than a generalist with a sprawling prompt.

### Tool Access Patterns

Choose the minimal tool set that enables the task (per D-04):

- **Read-only specialists** (analysis, audit, profiling): `Read, Glob, Grep, Bash`
- **Write specialists** (implementation, migration, documentation): `Read, Glob, Grep, Bash, Write, Edit`

Grant write tools only when the specialist needs to modify files. Analysis and audit
agents should never have Write or Edit access.

### Lifecycle

Dynamic agents follow a persistent-aware lifecycle. Before creating a new agent from
scratch, the PM checks the specialist registry for reusable matches. Successful agents
may be saved for future reuse instead of being discarded.

0. **Check specialist registry** (Section 21): Before creating a new dynamic agent,
   check the specialist registry per Section 21. Orchestray discovers specialists from
   two tiers: shipped templates at `<plugin-root>/specialists/` (installed with every
   Orchestray release) and project-local overrides at `.orchestray/specialists/`
   (gitignored, per-project). Project-local entries replace shipped ones with the same
   name. If a matching specialist is found, copy it to `agents/`, apply model routing
   from §19 below (override the `model:` field in frontmatter), and skip to step 2.

1. **PM creates agent definition file** at `agents/{name}.md` before spawning.
   (Only executed if no matching specialist was found in step 0.)

2. **PM spawns the agent** using `Agent("{name}")`. Claude Code resolves the name to
   the file in `agents/`. The PM frontmatter lists `tools: Agent(architect, developer,
   reviewer)` which documents the core agents, but Claude Code's Agent() tool resolves
   any agent name to a matching `.md` file in the `agents/` directory. The PM is NOT
   restricted to only the listed names.

3. **Agent executes** and returns a structured result per pm.md §6.

4. **PM processes the result** per pm.md §4 (Agent Result Handling).

5. **Save-or-delete decision:**
   - If `status: success` AND agent was newly created (not from registry): evaluate
     for save per Section 20. After save evaluation, delete `agents/{name}.md`.
   - If agent was reused from registry: increment `times_used` and update `last_used`
     in `registry.json`. Check promotion threshold per Section 20. Delete
     `agents/{name}.md` copy.
   - If `status: failure`: delete `agents/{name}.md` without saving. Never save
     failed agents.

6. **No PM action required.** `bin/audit-event.js` auto-emits the
   `dynamic_agent_spawn` event from the `SubagentStart` payload. The PM
   does not write this event manually. See `event-schemas.md` §"Dynamic
   Agent Spawn Event" for the exact field set.

7. **Log `dynamic_agent_cleanup` event** after deletion.

   > See `agents/pm-reference/event-schemas.md` §"Section 43: Dynamic Agent Cleanup Event"
   > for the canonical schema.
   > Do not duplicate or override these fields.

**Name validation:** Dynamic agent names MUST match `^[a-zA-Z0-9_-]+$`. Reject any
name containing path separators (`/`), traversal sequences (`..`), dots, or other
non-alphanumeric characters. If the derived name fails this check, sanitize by
replacing invalid characters with `-` and re-validating. Additionally, names
collide with reserved core agent identifiers — see `specialist-protocol.md`
§"Save Decision Criteria" step 1.5 for the canonical 13-name reserved-name
blocklist (kept in sync with `bin/mcp-server/tools/specialist_save.js`
`RESERVED_AGENT_NAMES`).

---

## 19. Model Routing — Detailed Scoring and Logging

This section contains the detailed routing outcome logging and integration points.
For the routing decision summary, effort assignment, and transparency rules, see
Section 19 in the main pm.md.

### Routing Outcome Logging

`routing_outcome` events are now auto-emitted by the PostToolUse:Agent hook at `bin/emit-routing-outcome.js` immediately after each successful Agent() spawn — the PM no longer needs to write them manually. However, if the hook detects missing fields (e.g., agent_type is null because the tool_input lacked subagent_type), the PM should still emit a supplemental routing_outcome event with the missing data filled in.

> Read `agents/pm-reference/event-schemas.md` for the exact JSON format if a supplemental event is needed.

### Integration Points

> **GATE ENFORCEMENT REMINDER:** Every `Agent()` call must pass `model: 'haiku'|'sonnet'|'opus'`
> explicitly — including the FIRST spawn of the orchestration. `bin/gate-agent-spawn.js`
> hard-blocks any spawn missing this parameter (exit 2). Omitting `model` even once wastes
> a full spawn attempt. Always set model before calling Agent():
> ```
> Agent(subagent_type="developer", model="sonnet", maxTurns=20, description="Fix auth (sonnet/medium)", prompt="...")
> ```

- **pm.md §12 output feeds §19 here**: After scoring, before
  `(see phase-decomp.md §"13. Task Decomposition Protocol")`, determine model per subtask.
- **pm.md §3 spawning uses §19 output**: When spawning any agent (core or dynamic),
  set `model: {routed_model}` in the agent invocation. For core agents, pass the model
  parameter. For dynamic agents (§17 above), write `model: {routed_model}` and
  `effort: {routed_effort}` in the frontmatter instead of `model: inherit`.
- **pm.md §4 result handling triggers routing outcome logging**: After parsing agent
  result, append the routing_outcome event.
- **`(see phase-verify.md §"18. Verify-Fix Loop Protocol")` triggers escalation**:
  On reviewer rejection, check if model escalation should happen before entering fix loop.

### 19.Z: Confidence-Triggered Escalation

When `enable_backpressure` is true and a confidence signal indicates low confidence,
the PM may escalate the model tier for re-execution instead of accepting a low-quality
result.

**Trigger:** Confidence < 0.4 on a completed task (detected in pm.md §4.Z or §14.Z above).

**Escalation protocol:**

1. **Check current model tier:** Read the `routing_outcome` event for this task to
   determine the model used (haiku, sonnet, opus).

2. **Determine escalation target:**
   - Haiku -> Sonnet (1 tier up)
   - Sonnet -> Opus (1 tier up)
   - Opus -> no escalation available. Escalate to user instead.

3. **Re-execute the task** with the higher model tier. Preserve the original delegation
   prompt but add a context note: "Previous attempt completed with low confidence
   ({value}). Risk factors: {risk_factors}. Please address these concerns."

4. **Log escalation** in the `routing_outcome` event for the re-execution:
   - Set `result: "escalated"` on the original task's routing_outcome
   - Set `escalated_from: "{original_model}"` and `escalation_count: N` on the new event

5. **Track confidence patterns:** If a particular agent type or task archetype consistently
   produces low confidence at a given model tier, this is a signal for
   `(see phase-close.md §"22. Pattern Extraction & Application Protocol")` extraction.
   Log for future routing optimization.

**Cost awareness:** Escalation increases cost. The PM should only escalate when the
confidence signal indicates the result quality is genuinely insufficient, not for
marginal improvements. Confidence >= 0.4 does not trigger escalation.

### 19.R: routing_lookup — Debugging and Observability

`mcp__orchestray__routing_lookup` reads past routing decisions from `routing.jsonl`.
Call it when:
- Debugging a routing-gate miss (e.g., `gate-agent-spawn` blocked a spawn with "no routing record").
- Verifying that a previous spawn was recorded correctly (agent_type, model, task_id).
- Retrieving routing history for an orchestration before attempting a re-plan.

**Example invocation:**
```
mcp__orchestray__routing_lookup({ orchestration_id: "orch-...", task_id: "T1" })
```
Returns matching routing entries or an empty list if none found.

### 19.C: cost_budget_reserve — Pre-Reservation Before Parallel Spawns

`mcp__orchestray__cost_budget_reserve` reserves projected cost BEFORE spawning expensive
agents. The `gate-cost-budget.js` hook includes active reservations in its cap comparison,
so parallel spawns each see the others' reserved cost and avoid collective overruns.

Call it when spawning multiple agents in parallel that together might breach `max_cost_usd`
or `daily_cost_limit_usd`. Call BEFORE the Agent() invocations, not after.

**Example invocation:**
```
mcp__orchestray__cost_budget_reserve({
  orchestration_id: "orch-...", task_id: "T2",
  agent_type: "developer", model: "claude-sonnet-4-6", effort: "medium"
})
```
The default TTL is 30 minutes; operators can override via
`mcp_server.cost_budget_reserve.ttl_minutes` in config.json. Reservations expire
automatically — no manual cleanup needed.

---

## 30.application — Correction Memory Application (delegation-time)

Run during pm.md §3 (Agent Spawning), before delegating to a developer agent.
The full extraction protocol that produces correction-pattern files lives in
`(see phase-close.md §"30. Correction Memory Protocol")`.

1. Glob `.orchestray/patterns/correction-*.md` and `.orchestray/team-patterns/correction-*.md`
2. For each correction pattern, check if it matches the current task:
   - File patterns match any files in the subtask's file ownership list
   - OR task type matches the current archetype
3. If matches found (max 3, prioritize by confidence then recency):
   - Append to delegation prompt:
     ```
     ## Known Pitfall: <correction name>
     <Correct Approach section content>
     ```
4. Log `pattern_applied` event to audit trail: `{"type": "pattern_applied", "pattern": "<name>", "agent": "<agent_type>", "confidence": "<level>"}`
5. Also check user-correction patterns per §34f below. Combined cap: max 5 total
   correction warnings (verify-fix + user-correction), prioritized by confidence then recency.

---

## 34f. User Correction Application During Delegation

Extends pm.md §3 step 7 (correction patterns). After checking §30.application above:

1. Glob `.orchestray/patterns/user-correction-*.md` and `.orchestray/team-patterns/user-correction-*.md`
2. Match against subtask: file_patterns vs files_owned, task_types vs archetype, description similarity
3. Max 3 matches (prioritize confidence, then recency)
4. Append to delegation prompt:

       ## Known Pitfall (User Correction): {name}
       {Correct Approach content}

5. Log `pattern_applied` event with category `user-correction`

Combined cap with §30.application: max 5 total correction warnings per delegation
(3 verify-fix + 3 user-correction, take top 5 by confidence). The full user-correction
extraction protocol lives in `(see phase-close.md §"34. User Correction Protocol")`.

---
