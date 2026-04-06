# Orchestray

## What This Is

A Claude Code plugin that automatically detects complex tasks and orchestrates multiple specialized AI agents to handle them. It assigns roles (architect, developer, reviewer, PM, etc.), coordinates their work adaptively, and produces fully audited output — all without the user needing to manually configure or trigger anything.

## Core Value

Maximize task execution efficiency by automatically decomposing work across specialized agents while preserving and reusing context, so developers get better results faster than single-agent Claude Code usage.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Heuristic-based complexity detection that decides when to orchestrate vs. let Claude handle solo
- [ ] Adaptive PM agent that decomposes tasks, assigns work, and adjusts workflow dynamically
- [ ] Core predefined agent roles (architect, lead developer, code reviewer, PM) with clear skill boundaries
- [ ] Dynamic agent spawning for task-specific roles beyond the core set
- [ ] Shared knowledge base that agents read/write to avoid duplicate work
- [ ] Explicit context handoffs between agents (pipeline-style when sequential)
- [ ] Smart parallelization — PM agent decides what runs concurrently vs. sequentially
- [ ] Full session state persistence — resume orchestration across Claude Code sessions
- [ ] Full audit output: committed code, decision log, review notes, architecture docs, cost report
- [ ] Seamless Claude Code integration (hooks, skills, MCP server, or best-fit approach)

### Out of Scope

- Team/multi-user workflows — this is for individual developers
- GUI or web dashboard — operates within Claude Code CLI
- Non-Claude AI model support — built for Claude Code's agent infrastructure
- Cloud/hosted orchestration — runs locally alongside Claude Code

## Context

- Claude Code supports hooks (shell commands on events), custom skills (slash commands), MCP servers, and the Agent tool for spawning subagents
- The plugin needs to intercept or augment Claude Code's normal flow to inject orchestration when complexity warrants it
- Context efficiency is a primary concern — agents should share knowledge rather than each building understanding from scratch
- The "accountant" metaphor from the description suggests tracking token usage and cost across agent runs as part of the audit trail

## Constraints

- **Platform**: Must work as a Claude Code plugin — cannot modify Claude Code internals
- **Integration**: Limited to Claude Code's extension points (hooks, skills, MCP, CLAUDE.md)
- **Context**: Must be context-efficient — the whole point is saving tokens, not burning more
- **Persistence**: State must survive session restarts using file-based storage

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Hybrid agent roles (core + dynamic) | Predefined roles ensure quality for common tasks; dynamic spawning handles novel ones | — Pending |
| Heuristic complexity detection | Avoids user configuration overhead; makes orchestration feel automatic | — Pending |
| Adaptive coordination over fixed pipelines | Tasks vary too much for rigid workflows; PM agent flexibility handles edge cases | — Pending |
| Full audit trail output | Developers need visibility into what agents decided and why, plus cost tracking | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-06 after initialization*
