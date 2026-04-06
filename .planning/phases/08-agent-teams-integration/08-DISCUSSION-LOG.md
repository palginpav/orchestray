# Phase 8: Agent Teams Integration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.

**Date:** 2026-04-07
**Phase:** 08-Agent Teams Integration
**Areas discussed:** Teams vs subagents decision logic, Hook handlers & quality gates, Feature flag & config, Audit trail continuity

---

## Teams vs Subagents Decision Logic

| Option | Description | Selected |
|--------|-------------|----------|
| 3+ parallel tasks needing coordination | Teams when 3+ parallel subtasks AND inter-agent communication needed | ✓ |
| Always for parallel work | Use teams whenever 2+ tasks can run in parallel | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Brief mention | PM announces mode choice in one line | ✓ |
| Detailed reasoning | Full decision rationale | |
| Silent | PM picks without announcing | |

## Hook Handlers & Quality Gates

| Option | Description | Selected |
|--------|-------------|----------|
| Output format + basic quality | Check format, block on malformed output | ✓ |
| Full quality gate | Validate against acceptance criteria | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Reassign to remaining tasks | Redirect idle teammate to next available task | ✓ |
| Always let idle stop | Don't reassign | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Both active, mode determines | Existing hooks for subagents, new hooks for teams | ✓ |
| Unified hooks | Merge into shared scripts | |
| You decide | | |

## Feature Flag & Config

| Option | Description | Selected |
|--------|-------------|----------|
| Config setting + env var | enable_agent_teams + CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS | ✓ |
| Config setting only | Just config, user sets env var manually | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Silent fallback to subagents | Falls back without error or warning | ✓ |
| Warn and fallback | Warns then falls back | |
| You decide | | |

## Audit Trail Continuity

| Option | Description | Selected |
|--------|-------------|----------|
| Map to equivalent events | TaskCreated→agent_start, TaskCompleted→agent_stop, mode: "teams" field | ✓ |
| Separate event types | New event types: team_task_created, etc. | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Same token tracking, aggregate by team | Per-teammate tokens, report aggregates by team | ✓ |
| Team-level only | Total team cost without breakdown | |
| You decide | | |

## Deferred Ideas

None
