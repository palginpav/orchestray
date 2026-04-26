<!-- PM Reference: Loaded by Section Loading Protocol when agent_teams.enabled is true AND CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 -->

# Agent Teams Decision Protocol (v2.1.16 R-AT-FLAG)

## Status

**Experimental, default-OFF in v2.1.16.** Agent Teams remain experimental in
Claude Code as of 2026-04-25. The criteria below are gates the PM applies
**before** considering team mode. If any gate fails, fall back to subagents.

## Activation requirements (BOTH must be true)

1. `agent_teams.enabled: true` in `.orchestray/config.json`
2. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in the environment (or in
   `settings.json` `env` block)

If either is missing, the PM MUST use subagents and MUST NOT mention "team mode"
to the user. The deprecated top-level `enable_agent_teams: true` key is still
honored for one release as a fallback for `agent_teams.enabled` and emits a
one-time stderr deprecation warning naming the new key.

## When to use teams (ALL three required)

A task qualifies for Agent Teams **only** when all three conditions hold:

1. **Parallel breadth.** ≥ 3 independent parallel tasks where teammates need
   inter-agent **messaging during execution** (not just at handoff).
2. **Cross-layer ownership.** A cross-layer change where teammates own
   different layers (e.g., frontend / backend / tests) and must agree on
   shared interfaces before either side can land.
3. **Research divergence.** A research-divergent investigation with competing
   hypotheses, where teammates challenge each other's findings to surface the
   strongest conclusion.

If any one condition fails, use subagents. There is no "two-of-three" path.

## When NOT to use teams (anti-conditions)

Even when the activation gate passes, AVOID team mode for:

- **Sequential workflows** (architect → developer → reviewer). Subagents are
  cheaper and the messaging channel is wasted.
- **Focused single-domain tasks.** One layer, one specialist; no coordination
  overhead worth paying.
- **Cost-sensitive operations.** Teams are token-NEGATIVE: each teammate pays
  full per-message context tokens, which compounds across the team. The win is
  wall-clock latency, not cost. If the user asked for the cheapest path, use
  subagents.

## Why the narrow scope

Cognition Labs' "Don't Build Multi-Agents" critique
(https://cognition.ai/blog/dont-build-multi-agents) documents that
multi-agent systems pay the context-sharing tax (every teammate carries
team-wide context) without a corresponding accuracy lift on the median task.
The narrow gate above isolates the cases where the latency/parallelism win
genuinely outweighs the token cost — namely cross-layer interface negotiation,
adversarial research, and ≥ 3-way independent fan-out.

## Feature contract

The contract for `TaskCreated`, `TaskCompleted`, and `TeammateIdle` hooks
(plus the experimental flag, lead semantics, and known limitations) is
documented at https://code.claude.com/docs/en/agent-teams. The Orchestray
hooks `bin/validate-task-completion.js` (TaskCompleted, T15 quality gate)
and `bin/reassign-idle-teammate.js` (TeammateIdle, prevents idle-teammate
stop-with-pending-work) wire into that contract. `skills` and `mcpServers`
from subagent definitions are NOT applied to teammates; teammates inherit
project-level CLAUDE.md and project/user MCP servers only. There is one team
per session, no nested teams, no session resumption with in-process teammates.

## Failure mode

If the PM enters team mode despite a failed gate (e.g., `agent_teams.enabled`
is true but the env var is missing), Claude Code's team API will silently
no-op — teammates will not spawn — and the orchestration will appear to hang.
The dual-gate enforcement above prevents this class of failure. When in doubt,
fall back to subagents.

## See also

- `agents/pm-reference/agent-teams.md` — full protocol (loaded only after
  this decision doc has confirmed the gate is open).
- `bin/reassign-idle-teammate.js` — TeammateIdle handler that exits 2 to
  redirect idle teammates when pending tasks remain in `task-graph.md`.
- `bin/validate-task-completion.js` — TaskCompleted T15 quality gate.
