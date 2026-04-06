# Roadmap: Orchestray

## Milestones

- ✅ **v1.0 MVP** - Phases 1-4 (shipped 2026-04-07)
- 🚧 **v2.0 Intelligence & Integration** - Phases 5-8 (in progress)

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

<details>
<summary>✅ v1.0 MVP (Phases 1-4) - SHIPPED 2026-04-07</summary>

### Phase 1: Plugin Foundation and Core Agents
**Goal**: Users can install Orchestray and manually trigger orchestration that delegates work to specialized agents
**Depends on**: Nothing (first phase)
**Requirements**: INTG-01, INTG-04, ROLE-01, ROLE-02, ROLE-03, ROLE-04
**Success Criteria** (what must be TRUE):
  1. User can install the plugin and see /orchestray:* slash commands available in Claude Code
  2. User can invoke the PM agent which assesses a task and decides whether to delegate or handle solo
  3. PM agent can spawn architect, developer, and reviewer subagents that execute their specialized roles and return results
  4. User can check orchestration status via a slash command
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — Plugin scaffold (manifest, settings, directories) and PM agent definition
- [x] 01-02-PLAN.md — Specialist agent definitions (architect, developer, reviewer)
- [x] 01-03-PLAN.md — Slash commands (run, status, config, report skills)

### Phase 2: Knowledge, State, and Task Decomposition
**Goal**: PM agent can decompose complex tasks into dependency graphs, share knowledge across agents, and resume orchestration after session restarts
**Depends on**: Phase 1
**Requirements**: CTXT-01, CTXT-02, CTXT-03, TASK-01, TASK-02, TASK-03
**Success Criteria** (what must be TRUE):
  1. Agents can read discoveries written by other agents via the shared knowledge base, avoiding duplicate context-building
  2. User can restart Claude Code mid-orchestration and resume from the last checkpoint without losing progress
  3. PM agent decomposes a multi-step task into a structured subtask graph with explicit dependencies and parallelism annotations
  4. Complexity detection scores a task and decides orchestrate vs. solo, defaulting conservatively to solo
**Plans**: 3 plans

Plans:
- [x] 02-01-PLAN.md — KB protocol and context handoff sections in PM agent prompt
- [x] 02-02-PLAN.md — State persistence protocol, resume skill, status skill update
- [x] 02-03-PLAN.md — Complexity scoring, task decomposition, run and config skill updates

### Phase 3: Automated Execution and Observability
**Goal**: Orchestration triggers automatically on complex prompts, runs agents in parallel where safe, enforces file ownership, and produces a complete audit trail with cost tracking
**Depends on**: Phase 2
**Requirements**: INTG-02, INTG-03, EXEC-01, EXEC-02, OBSV-01, OBSV-02, OBSV-03
**Success Criteria** (what must be TRUE):
  1. Complex user prompts automatically trigger orchestration without the user invoking a slash command
  2. Independent subtasks execute in parallel via concurrent subagents, with no two agents editing the same file
  3. User can view a consolidated audit report showing agent actions, decisions, code changes, review notes, and per-agent token costs
  4. Simple prompts pass through to normal Claude Code behavior with no orchestration overhead
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — PM auto-trigger protocol and parallel execution with worktree isolation
- [x] 03-02-PLAN.md — Hook handlers for SubagentStart/SubagentStop audit events and cost tracking
- [x] 03-03-PLAN.md — Real-time cost display, run skill audit integration, report skill extension

### Phase 4: Adaptive Intelligence and Quality Gates
**Goal**: PM agent dynamically adjusts workflows based on agent feedback, spawns task-specific specialists, and routes quality failures through verify-fix loops
**Depends on**: Phase 3
**Requirements**: ROLE-05, ROLE-06, ROLE-07
**Success Criteria** (what must be TRUE):
  1. PM agent re-plans workflow when an agent reports unexpected findings or blockers, rather than following the original plan blindly
  2. PM agent spawns task-specific specialist agents for subtasks that fall outside core role competencies
  3. Reviewer failures route back to the developer agent with specific feedback, and the fix-verify cycle caps at a bounded retry count
**Plans**: 2 plans

Plans:
- [x] 04-01-PLAN.md — Adaptive re-planning protocol with anti-thrashing safeguard and config extension
- [x] 04-02-PLAN.md — Dynamic agent spawning, verify-fix loops, and Section 5 replacement

</details>

### 🚧 v2.0 Intelligence & Integration (In Progress)

**Milestone Goal:** Make orchestration smarter with model routing, pattern learning, persistent specialists, and Agent Teams support.

- [ ] **Phase 5: Smart Model Routing** - PM assigns Haiku/Sonnet/Opus per subtask based on complexity with cost savings tracking
- [ ] **Phase 6: Persistent Specialist Registry** - Dynamic agents that proved useful get saved for reuse; users can add custom specialist templates
- [ ] **Phase 7: Skill Learning and Pattern Extraction** - Extract reusable problem-solving patterns from past orchestrations to improve future task decomposition
- [ ] **Phase 8: Agent Teams Integration** - Feature-flagged dual-mode execution leveraging Claude Code Agent Teams for inter-agent communication

## Phase Details

### Phase 5: Smart Model Routing
**Goal**: PM agent selects the right model tier per subtask so users get optimal cost-quality tradeoff without manual configuration
**Depends on**: Phase 4
**Requirements**: ROUT-01, ROUT-02, ROUT-03
**Success Criteria** (what must be TRUE):
  1. PM agent assigns Haiku, Sonnet, or Opus to each subtask based on its complexity score, and the assigned model is used when spawning the subagent
  2. Audit report shows which model was used for each subtask alongside a cost savings comparison vs. all-Opus baseline
  3. Routing decisions (model, complexity score, task outcome, any escalations) are logged in a format that supports future threshold tuning
**Plans**: 2 plans

Plans:
- [x] 05-01-PLAN.md — PM routing protocol (Section 19), config settings, model param at spawn
- [x] 05-02-PLAN.md — Fix pricing constants, add model_used to audit events, report savings table

### Phase 6: Persistent Specialist Registry
**Goal**: Useful dynamic agents survive beyond their originating session and users can build a library of custom specialist templates
**Depends on**: Phase 5
**Requirements**: SPEC-01, SPEC-02, SPEC-03, SPEC-04
**Success Criteria** (what must be TRUE):
  1. After a successful orchestration that used dynamic agents, PM offers to save proven specialists to `.orchestray/specialists/` for future reuse
  2. When decomposing a new task, PM checks the specialist registry and reuses a matching persistent specialist instead of creating an ephemeral one
  3. User can place custom `.md` specialist templates in `.orchestray/specialists/` and PM discovers and uses them for matching subtasks
  4. User can list, view, edit, and remove persistent specialists via the `/orchestray:specialists` slash command
**Plans**: 2 plans

Plans:
- [x] 06-01-PLAN.md — PM Sections 20-21 (Specialist Save and Reuse Protocols) and Section 17 lifecycle modification
- [x] 06-02-PLAN.md — /orchestray:specialists skill for CRUD management of persistent specialists

### Phase 7: Skill Learning and Pattern Extraction
**Goal**: Orchestray learns from past orchestrations so the PM agent makes better decomposition and assignment decisions over time
**Depends on**: Phase 6
**Requirements**: LERN-01, LERN-02, LERN-03, LERN-04
**Success Criteria** (what must be TRUE):
  1. After each orchestration completes, reusable patterns are automatically extracted from the audit history and stored in `.orchestray/patterns/`
  2. PM agent checks stored patterns during task decomposition and applies relevant strategies from similar past tasks
  3. Patterns have confidence scores and usage tracking, and the system prunes low-value patterns to stay within the configured limit (50-100 entries)
  4. User can manually trigger pattern extraction from a specific orchestration via `/orchestray:learn`
**Plans**: 2 plans

Plans:
- [x] 07-01-PLAN.md — PM Section 22 (Pattern Extraction, Application, Feedback, Pruning)
- [x] 07-02-PLAN.md — /orchestray:learn skill and agent memory frontmatter

### Phase 8: Agent Teams Integration
**Goal**: Orchestray can leverage Claude Code Agent Teams for tasks that benefit from inter-agent communication while preserving subagent mode as the default
**Depends on**: Phase 5
**Requirements**: TEAM-01, TEAM-02, TEAM-03
**Success Criteria** (what must be TRUE):
  1. Agent Teams mode is off by default and can be enabled via `enable_agent_teams` in the Orchestray config
  2. When enabled, PM uses Agent Teams for parallel tasks with 3+ agents that need inter-agent communication, and subagents for everything else
  3. Hook handlers process TaskCreated, TaskCompleted, and TeammateIdle events to maintain audit trail continuity in teams mode
**Plans**: 2 plans

Plans:
- [x] 08-01-PLAN.md — PM Section 23 (Agent Teams decision protocol) and enable_agent_teams config setting
- [x] 08-02-PLAN.md — Hook handler scripts (TaskCreated, TaskCompleted, TeammateIdle) and metrics extension

## Progress

**Execution Order:**
Phases execute in numeric order: 5 -> 6 -> 7 -> 8

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Plugin Foundation and Core Agents | v1.0 | 3/3 | Complete | 2026-04-07 |
| 2. Knowledge, State, and Task Decomposition | v1.0 | 3/3 | Complete | 2026-04-07 |
| 3. Automated Execution and Observability | v1.0 | 3/3 | Complete | 2026-04-07 |
| 4. Adaptive Intelligence and Quality Gates | v1.0 | 2/2 | Complete | 2026-04-07 |
| 5. Smart Model Routing | v2.0 | 2/2 | Complete | 2026-04-07 |
| 6. Persistent Specialist Registry | v2.0 | 0/0 | Not started | - |
| 7. Skill Learning and Pattern Extraction | v2.0 | 0/0 | Not started | - |
| 8. Agent Teams Integration | v2.0 | 0/0 | Not started | - |
