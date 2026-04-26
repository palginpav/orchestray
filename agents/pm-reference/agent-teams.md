<!-- PM Reference: Loaded by Section Loading Protocol when agent_teams.enabled is true AND CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1; consult agent-teams-decision.md first -->

## 23. Agent Teams Protocol

**Prerequisite (v2.1.16 R-AT-FLAG dual gate):** Before loading or applying this
section, the PM MUST verify BOTH activation conditions:

1. `.orchestray/config.json` has `agent_teams.enabled === true`
   (with one-release fallback to legacy top-level `enable_agent_teams === true`,
   which emits a one-time deprecation warning naming the new key).
2. `process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === '1'` (set in shell or
   `settings.json` `env` block).

If EITHER condition is missing, skip this section entirely -- use subagents for
all execution. Do not announce a team-mode attempt to the user. The dual gate
prevents the "config flag set but env var missing" silent no-op failure mode
where teammates never spawn and the orchestration appears to hang.

For decision criteria (when team mode is appropriate even after the gate
passes), see `agents/pm-reference/agent-teams-decision.md`.

### When to Use Agent Teams (D-01)

Use Agent Teams ONLY when ALL three criteria are met (full criteria with
anti-conditions and rationale live in `agent-teams-decision.md`):

1. **Dual feature gate:** `agent_teams.enabled === true` in
   `.orchestray/config.json` AND `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
   in environment.
2. **Parallel threshold:** Task decomposition (Section 13, in tier1-orchestration.md) produced 3+ parallel subtasks
   in at least one parallel group
3. **Inter-agent communication need:** Subtasks require coordination beyond independent
   execution. At least one of:
   - Shared interfaces that multiple agents must agree on (e.g., API contract between
     frontend and backend teammates)
   - Competing hypotheses that benefit from cross-challenge (e.g., research tasks where
     teammates evaluate different approaches and debate findings)
   - Cross-layer changes where agents need to coordinate (e.g., frontend + backend +
     tests each owned by a different teammate, requiring interface alignment)

If ANY criterion is not met, use subagents (Sections 3, 14, in tier1-orchestration.md).

### Silent Fallback (D-07)

If teams are enabled in config but the Agent Teams API is unavailable (e.g., Claude Code
version older than v2.1.32, or `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var not set),
silently fall back to subagent mode. Do not emit an error or warning. The user should
experience no degradation -- subagent execution produces equivalent results, just without
inter-agent messaging.

### Mode Announcement (D-02)

Announce the execution mode choice in one line before starting execution:

- **Teams:** "Using Agent Teams for this orchestration (X parallel tasks with [reason])"
  - Example: "Using Agent Teams for this orchestration (4 parallel tasks with shared API interface)"
- **Subagents:** "Using subagents ([reason])"
  - Example: "Using subagents (sequential workflow)"
  - Example: "Using subagents (fewer than 3 parallel tasks)"
  - Example: "Using subagents (no inter-agent communication needed)"

### Team Execution Details

See the detailed procedures below for team creation steps, task assignment protocol,
teammate failure handling, verify-fix loop interaction, token/cost tracking, known
limitations, and audit trail integration.

---

# Agent Teams Protocol Reference

Detailed procedures for team creation, task assignment, failure handling, and audit trail
integration. For decision criteria (when to use teams, silent fallback, mode announcement),
see Section 23 above.

---

## Team Creation

The PM does NOT call a programmatic API to create teams. Instead, instruct Claude Code
in natural language to create an agent team. Claude Code's native team creation handles
the rest.

Steps:
1. **Define teammates:** For each parallel subtask group, assign a named teammate with a
   role matching an Orchestray agent type where appropriate (e.g., "developer-auth",
   "developer-api", "reviewer"). Use descriptive names that reflect the subtask domain.
2. **Instruct Claude Code:** "Create an agent team with N teammates to work on [task
   description]." Specify each teammate's name, role, and assigned subtask(s).
3. **Request coordination:** Ask teammates to coordinate on shared interfaces via
   messaging. Specify which interfaces need agreement before implementation proceeds.
4. **PM as team lead:** The PM session acts as the team lead. The PM creates the team,
   assigns tasks, and monitors progress. The lead is fixed for the team's lifetime.

---

## Task Assignment

The lead (PM) assigns tasks explicitly based on the decomposition plan from Section 13
(in tier1-orchestration.md).
Teammates do not self-claim tasks. This gives the PM control over task-agent mapping and
ensures model routing preferences from Section 19 are respected for the team lead.

Assignment protocol:
1. Map each subtask from the decomposition to a specific teammate by name.
2. Set task dependencies so that blocked tasks auto-unblock when predecessors complete.
3. For tasks requiring a specific model tier (per Section 19 routing), note this in the
   task description -- the lead's model routing applies to the lead session, but
   individual teammates operate at their session's model tier.

---

## Teammate Failure Handling

If a teammate fails mid-team:
1. **First:** Attempt to reassign the failed task to another idle teammate.
2. **If no idle teammates:** Escalate to the user with a status update explaining which
   task failed, which teammate was responsible, and what the failure was.
3. **Do NOT** automatically retry by spawning a new teammate -- session resumption
   limitations mean this could leave orphaned state.

---

## Verify-Fix Loop Interaction

Verify-fix loops (Section 18, in tier1-orchestration.md) operate at the task level, not the team level:
- When a teammate completes a task, the `TaskCompleted` hook validates output format
  (D-03).
- If the team includes a reviewer teammate, the lead can assign review tasks that create
  verify-fix cycles within the team.
- This preserves existing Section 18 logic while operating inside the team context.

---

## Token and Cost Tracking (D-09)

Token tracking for team mode uses the same `collect-agent-metrics.js` infrastructure as
subagent mode. Team events are logged with `mode: "teams"` in the audit trail
(`events.jsonl`). The cost report aggregates token usage by team orchestration, making
team cost visible alongside subagent cost in `/orchestray:report` output.

---

## Known Limitations

- **No session resumption with in-process teammates** -- on session resume, if team state
  exists from a prior session, inform the user that teams were lost and offer to
  re-spawn the team for incomplete tasks
- **One team per session** -- PM cannot run multiple team orchestrations concurrently
- **No nested teams** -- teammates cannot spawn their own teams
- **`skills` and `mcpServers` from subagent definitions are NOT applied to teammates** --
  teammates get project-level CLAUDE.md and project/user MCP servers only
- **Lead is fixed for the team's lifetime** -- PM cannot rotate leads mid-orchestration
- **Token usage scales with number of active teammates** -- teams use significantly more
  tokens than subagents; the 3+ parallel tasks + inter-agent communication gate prevents
  casual usage

---

## Audit Trail Integration (D-05, D-08)

When Agent Teams mode is active, hook handlers for `TaskCreated`, `TaskCompleted`, and
`TeammateIdle` events handle audit trail logging and quality gates (see `hooks.json`).
Team events map to equivalent audit event types with a `mode: "teams"` field:

| Team Hook Event | Audit Event Type | Equivalent |
|-----------------|------------------|------------|
| TaskCreated     | `task_created`   | Similar to `agent_start` |
| TaskCompleted   | `task_completed` | Similar to `agent_stop`  |
| TeammateIdle    | `teammate_idle`  | New event type           |

Subagent hooks (`SubagentStart`/`SubagentStop`) fire only in subagent mode. Both hook
sets are configured in `hooks.json`; the PM's execution mode determines which path is
active.
