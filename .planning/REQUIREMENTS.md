# Requirements: Orchestray v2.0

**Defined:** 2026-04-07
**Core Value:** Maximize task execution efficiency by automatically decomposing work across specialized agents while preserving and reusing context

## v1 Requirements (Validated)

### Integration
- [x] **INTG-01**: Plugin scaffold with valid manifest, settings.json, and directory structure
- [x] **INTG-02**: Hook handlers intercept UserPromptSubmit to trigger complexity detection (implemented as PM-native auto-trigger per D-01)
- [x] **INTG-03**: Hook handlers intercept SubagentStop to collect results and track state
- [x] **INTG-04**: Custom slash commands for manual orchestration trigger and status check

### Task Analysis
- [x] **TASK-01**: Heuristic complexity detection scores tasks and decides orchestrate vs. solo
- [x] **TASK-02**: LLM-based task decomposition produces structured subtask graph with dependencies
- [x] **TASK-03**: Dependency analysis identifies parallelizable vs. sequential subtasks

### Agent Roles
- [x] **ROLE-01**: PM agent decomposes tasks, assigns work, and monitors progress
- [x] **ROLE-02**: Architect agent designs structure and makes technical decisions
- [x] **ROLE-03**: Developer agent implements code changes
- [x] **ROLE-04**: Reviewer agent validates implementation quality and correctness
- [x] **ROLE-05**: Adaptive PM adjusts workflow dynamically based on agent feedback and progress
- [x] **ROLE-06**: Dynamic agent spawning creates task-specific specialists beyond core roles
- [x] **ROLE-07**: Verify-fix loops route reviewer failures back to developer with specific feedback

### Context & Knowledge
- [x] **CTXT-01**: File-based shared knowledge base where agents register and read discoveries
- [x] **CTXT-02**: Session state persistence allows resuming orchestration after restart
- [x] **CTXT-03**: Smart context handoffs produce structured summaries between sequential agents

### Execution
- [x] **EXEC-01**: Parallel execution of independent subtasks via Claude Code subagents
- [x] **EXEC-02**: File ownership enforcement prevents multiple agents editing same file

### Observability
- [x] **OBSV-01**: Structured audit trail logs agent actions, decisions, and reasoning
- [x] **OBSV-02**: Per-agent token tracking with session cost totals
- [x] **OBSV-03**: Consolidated audit report combining code changes, decisions, reviews, and costs

## v2.0 Requirements (Active)

### Model Routing
- [x] **ROUT-01**: PM selects Haiku/Sonnet/Opus per subtask based on complexity score (0-3=Haiku, 4-7=Sonnet, 8-12=Opus)
- [x] **ROUT-02**: Audit trail logs model used per subtask with cost savings vs. all-Opus baseline
- [x] **ROUT-03**: Routing outcomes (model + score + result + escalation) logged for future threshold tuning

### Persistent Specialists
- [x] **SPEC-01**: PM offers to save dynamic agents to `.orchestray/specialists/` after successful orchestration
- [x] **SPEC-02**: PM checks specialist registry before creating new ephemeral agents for matching subtasks
- [x] **SPEC-03**: Users can add custom specialist templates as .md files to `.orchestray/specialists/`
- [x] **SPEC-04**: `/orchestray:specialists` skill to list, view, remove, and edit persistent specialists

### Skill Learning
- [x] **LERN-01**: Post-orchestration automatic pattern extraction from audit history into `.orchestray/patterns/`
- [x] **LERN-02**: PM checks patterns during task decomposition for similar past tasks
- [x] **LERN-03**: Pattern lifecycle with confidence scoring, usage tracking, and pruning (max 50-100 entries)
- [x] **LERN-04**: `/orchestray:learn` skill for manual pattern extraction from a specific orchestration

### Agent Teams
- [x] **TEAM-01**: Feature-flagged opt-in via `enable_agent_teams` config setting (off by default)
- [x] **TEAM-02**: Dual-mode execution — teams for 3+ parallel tasks needing inter-agent communication, subagents otherwise
- [x] **TEAM-03**: Hook handlers for TaskCreated, TaskCompleted, TeammateIdle events

## Future Requirements

### Advanced Intelligence
- **ADVN-01**: Refined complexity detection learns from past sessions what warrants orchestration
- **ADVN-02**: Adaptive routing thresholds auto-adjust from outcome history
- **ADVN-03**: Cross-orchestration pattern memory

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-agent default models in config | Research suggests PM override at spawn is simpler than config layer; revisit if users request |
| ML-trained routing classifier | Overkill; rule-based on complexity score gets 90% benefit at 5% cost |
| Community specialist registry | Security risk — agent definitions include Bash tool grants |
| Real-time model switching mid-agent | Impossible — model set at spawn, changing loses context |
| Full Agent Teams replacement of subagents | No session resumption, skills/MCP don't apply to teammates |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ROUT-01 | Phase 5 | Complete |
| ROUT-02 | Phase 5 | Complete |
| ROUT-03 | Phase 5 | Complete |
| SPEC-01 | Phase 6 | Complete |
| SPEC-02 | Phase 6 | Complete |
| SPEC-03 | Phase 6 | Complete |
| SPEC-04 | Phase 6 | Complete |
| LERN-01 | Phase 7 | Complete |
| LERN-02 | Phase 7 | Complete |
| LERN-03 | Phase 7 | Complete |
| LERN-04 | Phase 7 | Complete |
| TEAM-01 | Phase 8 | Complete |
| TEAM-02 | Phase 8 | Complete |
| TEAM-03 | Phase 8 | Complete |

**Coverage:**
- v2.0 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0

---
*Requirements defined: 2026-04-07*
*Last updated: 2026-04-06 after v2.0 roadmap creation*
