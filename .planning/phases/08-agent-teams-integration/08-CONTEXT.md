# Phase 8: Agent Teams Integration - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Feature-flagged dual-mode execution — Agent Teams for 3+ parallel tasks needing inter-agent communication, subagents otherwise. Hook handlers for TaskCreated, TaskCompleted, TeammateIdle events. Audit trail continuity in teams mode. Does NOT include replacing subagents entirely (teams complement, not replace) or nested teams.

</domain>

<decisions>
## Implementation Decisions

### Teams vs Subagents Decision Logic
- **D-01:** Teams when 3+ parallel tasks need coordination — PM uses Agent Teams only when there are 3+ parallel subtasks AND they need inter-agent communication (e.g., architect and developer iterating on shared interface). Subagents for sequential workflows, single-domain tasks, cost-sensitive operations, and fewer than 3 parallel tasks. Per TEAM-02.
- **D-02:** Brief transparency — PM announces mode choice in one line: "Using Agent Teams for this orchestration (3 parallel tasks with shared interface)" or "Using subagents (sequential workflow)". No detailed reasoning.

### Hook Handlers & Quality Gates
- **D-03:** TaskCompleted validates output format + basic quality — check that task output matches expected format (has result, not empty). Block (exit 2) on malformed output. Deeper quality is the reviewer agent's job. Per TEAM-03.
- **D-04:** TeammateIdle reassigns to remaining tasks — check if unassigned tasks remain. If yes, redirect idle teammate to next available task. If no tasks left, let teammate stop. Maximizes utilization.
- **D-05:** Both hook sets active, mode determines which fires — existing SubagentStart/Stop hooks fire for subagent mode. New TaskCreated/TaskCompleted/TeammateIdle hooks fire for team mode. Both configured in hooks.json. PM's execution mode determines which path is active.

### Feature Flag & Config
- **D-06:** Config setting + env var — `enable_agent_teams` in `.orchestray/config.json` (default `false`). When enabled, also sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var in `settings.json`. Two-layer: config controls PM decision, env var enables Claude Code's teams API. Per TEAM-01.
- **D-07:** Silent fallback to subagents — if teams enabled in config but API unavailable (older Claude Code version), PM silently falls back to subagent mode. No error, no degraded experience. User may not notice the difference.

### Audit Trail Continuity
- **D-08:** Map to equivalent events — TaskCreated → agent_start equivalent, TaskCompleted → agent_stop equivalent, TeammateIdle → new `teammate_idle` event type. Same events.jsonl format with a `mode: "teams"` field to distinguish from subagent events. Per TEAM-03.
- **D-09:** Same token tracking, aggregate by team — `collect-agent-metrics.js` handles team events the same way as subagent events (tokens per teammate). Report aggregates by team orchestration. Model routing from Section 19 applies to the team lead.

### Claude's Discretion
- Exact inter-agent communication patterns (how teammates share findings)
- Team lead selection strategy (which agent becomes lead)
- How to handle teammate failures mid-team (retry vs. escalate to PM)
- Task assignment strategy within teams (lead assigns vs. teammates self-select)
- How team mode interacts with verify-fix loops (Section 18)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Code to Extend
- `agents/pm.md` — Section 3 (Agent Spawning), Section 19 (Model Routing), Section 17 (Dynamic Agent Spawning) — team mode extends spawning
- `hooks/hooks.json` — Current hook configuration (UserPromptSubmit, SubagentStart, SubagentStop)
- `bin/audit-event.js` — SubagentStart hook handler pattern
- `bin/collect-agent-metrics.js` — SubagentStop handler, token tracking, cost estimation
- `skills/orchestray:config/SKILL.md` — Config management (adding enable_agent_teams setting)
- `settings.json` — Plugin settings (adding env var)

### Research
- `.planning/research/STACK.md` — Agent Teams design, hook events, limitations, feature flag approach
- `.planning/research/FEATURES.md` — Competitor analysis
- `.planning/research/PITFALLS.md` — Known risks, experimental API concerns

### Project
- `.planning/PROJECT.md` — v2.0 milestone goals
- `.planning/REQUIREMENTS.md` — TEAM-01, TEAM-02, TEAM-03

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `bin/audit-event.js` — Hook handler pattern for SubagentStart events, same pattern for TaskCreated
- `bin/collect-agent-metrics.js` — Token tracking pattern, extend for team events
- `hooks/hooks.json` — Established hook configuration format, add new event types
- PM Section 3 (Agent Spawning) — existing spawn logic, team mode adds alternative path
- `skills/orchestray:config/SKILL.md` — established pattern for adding config settings

### Established Patterns
- Hook handlers read JSON from stdin, process, output JSON to stdout
- Config settings with validation and defaults in config skill
- PM sections with numbered integration points and cross-references
- Feature flags as config settings with boolean type

### Integration Points
- PM Section 3 → new subsection for team mode spawning
- `hooks/hooks.json` → add TaskCreated, TaskCompleted, TeammateIdle events
- New scripts: `bin/validate-task-completion.js`, `bin/reassign-idle-teammate.js`
- `bin/collect-agent-metrics.js` → extend to handle team events
- `skills/orchestray:config/SKILL.md` → add `enable_agent_teams` setting
- `settings.json` → add `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (conditional)
- `skills/orchestray:report/SKILL.md` → add team mode section when team events exist

</code_context>

<specifics>
## Specific Ideas

- The PM should check `enable_agent_teams` config before even considering team mode — if disabled, skip all team logic
- Research notes that `skills` and `mcpServers` from subagent definitions are NOT applied to teammates — this is a key limitation to document in the PM's team protocol
- No session resumption with in-process teammates — PM should warn about this limitation
- One team per session — PM cannot run multiple team orchestrations concurrently
- Team lead is fixed for the team's lifetime — PM cannot rotate leads

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-agent-teams-integration*
*Context gathered: 2026-04-07*
