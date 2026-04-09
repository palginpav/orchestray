# Orchestray Plugin

This is a Claude Code plugin that provides multi-agent orchestration.

## Usage
- PM agent is the default session agent (set via settings.json)
- Use `/orchestray:run [task]` to manually trigger orchestration
- Use `/orchestray:status` to check orchestration state
- Use `/orchestray:config` to view/modify settings
- Use `/orchestray:report` to generate an audit report
- Use `/orchestray:analytics` to view aggregate performance stats
- Use `/orchestray:kb` to manage the knowledge base
- Use `/orchestray:patterns` to view pattern effectiveness dashboard
- Use `/orchestray:review-pr <PR>` to review a GitHub pull request
- Use `/orchestray:issue <URL>` to orchestrate from a GitHub issue
- Use `/orchestray:learn` to extract patterns from orchestrations
- Use `/orchestray:resume` to resume an interrupted orchestration
- Use `/orchestray:playbooks` to manage project-specific playbooks
- Use `/orchestray:specialists` to manage specialist agent templates
- Use `/orchestray:workflows` to manage custom YAML workflow definitions
- Use `/orchestray:update` to update Orchestray to the latest version

## Agent Roles
- **pm** — Orchestrator, decomposes tasks and delegates
- **architect** — Design-only, produces design documents
- **developer** — Implements code changes
- **refactorer** — Systematic code transformation without behavior change
- **reviewer** — Read-only review across correctness, quality, security, performance, docs
- **debugger** — Systematic bug investigation and root cause analysis (read-only)
- **tester** — Dedicated test writing, coverage analysis, and test strategy
- **documenter** — Documentation creation and maintenance
- **inventor** — First-principles creation of novel tools, DSLs, and custom solutions
- **security-engineer** — Shift-left security analysis, threat modeling, vulnerability assessment

## Runtime State
- `.orchestray/` directory stores orchestration state (gitignored)

<!-- GSD:project-start source:PROJECT.md -->
## Project

**Orchestray**

A Claude Code plugin that automatically detects complex tasks and orchestrates multiple specialized AI agents to handle them. It assigns roles (architect, developer, reviewer, PM, etc.), coordinates their work adaptively, and produces fully audited output — all without the user needing to manually configure or trigger anything.

**Core Value:** Maximize task execution efficiency by automatically decomposing work across specialized agents while preserving and reusing context, so developers get better results faster than single-agent Claude Code usage.

### Constraints

- **Platform**: Must work as a Claude Code plugin — cannot modify Claude Code internals
- **Integration**: Limited to Claude Code's extension points (hooks, skills, MCP, CLAUDE.md)
- **Context**: Must be context-efficient — the whole point is saving tokens, not burning more
- **Persistence**: State must survive session restarts using file-based storage
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Recommended Stack Additions
### Smart Model Routing
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Subagent `model` frontmatter field | Claude Code v2.0.0+ | Per-agent model selection | Native field: accepts `haiku`, `sonnet`, `opus`, full model IDs (e.g., `claude-opus-4-6`), or `inherit`. Resolution order: `CLAUDE_CODE_SUBAGENT_MODEL` env var > per-invocation param > frontmatter > parent model. No external code needed. |
| `effort` frontmatter field | Claude Code v2.1.33+ | Control reasoning depth per agent | `low`, `medium`, `high`, `max` (Opus 4.6 only). Pairs with model routing -- Haiku+low for exploration, Opus+max for architecture. |
| Subtask Type | Model | Effort | Rationale |
|-------------|-------|--------|-----------|
| Codebase exploration, file search, simple lookups | `haiku` | `low` | Built-in Explore agent already uses Haiku. 80% cheaper than Sonnet. |
| Standard implementation, code generation, test writing | `sonnet` | `medium` | Best cost/quality ratio for code. Default for developer/reviewer agents. |
| Architecture decisions, complex debugging, security audit | `opus` | `high` | Reserved for tasks requiring deep reasoning. 67% more expensive than Sonnet. |
| Novel system design, cross-cutting refactors | `opus` | `max` | Opus 4.6 exclusive. Use only when stakes justify the cost. |
| Model | Input | Output | Relative Cost |
|-------|-------|--------|---------------|
| Haiku 4.5 | $1.00 | $5.00 | 1x (baseline) |
| Sonnet 4.6 | $3.00 | $15.00 | 3x |
| Opus 4.6 | $5.00 | $25.00 | 5x |
### Skill Learning / Pattern Extraction
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Subagent `memory` field | Claude Code v2.1.33+ | Persistent cross-session agent memory | Native field: `user`, `project`, or `local` scope. Creates `MEMORY.md` + topic files in a dedicated directory. First 200 lines / 25KB auto-loaded into every agent session. No external DB needed. |
| Auto memory system | Claude Code v2.1.59+ | Automatic note-taking by agents | Claude decides what's worth remembering. Stores in `~/.claude/projects/<project>/memory/`. Complementary to agent memory. |
| `.claude/rules/` directory | Claude Code v2.0.0+ | Path-scoped persistent rules | Rules with `paths:` frontmatter load only when Claude works on matching files. Use for extracted patterns that apply to specific file types/directories. |
- PM: orchestration patterns, task decomposition strategies, which model routing worked
- Architect: design patterns that succeeded, anti-patterns discovered
- Developer: implementation patterns, library usage notes, common fixes
- Reviewer: recurring issues, code quality patterns, security observations
# Pattern: [name]
## Context
## Approach
## Evidence
### Persistent Specialist Registry
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| File-based registry in `.orchestray/specialists/` | N/A (plain files) | Store proven dynamic agent templates | Extends existing dynamic agent lifecycle (PM Section 17). Instead of deleting agent definitions after use, save successful ones. |
| `zod` | 3.x | Validate specialist template schemas | Already in the recommended stack from v1 research. Use for validating specialist metadata JSON. |
### Agent Teams Integration
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Claude Code Agent Teams | Experimental, v2.1.32+ | Parallel multi-agent coordination with inter-agent messaging | Native feature. Teammates share task lists, communicate directly, and self-coordinate. Use when subtasks need inter-agent discussion (e.g., architect and developer need to iterate). |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var | v2.1.32+ | Enable agent teams | Must be set in `settings.json` or environment. Teams are disabled by default. |
| `TeammateIdle` hook event | v2.1.32+ | Reassign idle teammates | Use to redirect idle teammates to remaining work instead of letting them stop. |
| `TaskCreated` / `TaskCompleted` hook events | v2.1.32+ | Quality gates for team tasks | Validate task creation and completion criteria. Exit code 2 blocks the action. |
- Research/investigation tasks with competing hypotheses (teammates challenge each other)
- Cross-layer changes (frontend + backend + tests, each owned by a teammate)
- Large parallel implementations where teammates need to coordinate on shared interfaces
- Sequential workflows (architect -> developer -> reviewer)
- Focused single-domain tasks
- Cost-sensitive operations (teams use significantly more tokens)
- No session resumption with in-process teammates (state lost on restart)
- One team per session (Orchestray can only run one team orchestration at a time)
- No nested teams (teammates cannot spawn their own teams)
- `skills` and `mcpServers` from subagent definitions NOT applied to teammates
- Lead is fixed for the team's lifetime
## Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `zod` | 3.x | Schema validation | Validate specialist registry, pattern files, config extensions. Already recommended in v1. |
## New Hook Scripts to Build
| Script | Hook Event | Purpose |
|--------|------------|---------|
| `bin/validate-task-completion.js` | `TaskCompleted` | Quality gate for Agent Teams tasks. Checks task output against criteria before allowing completion. |
| `bin/reassign-idle-teammate.js` | `TeammateIdle` | Checks remaining tasks and redirects idle teammates instead of letting them stop. |
## New PM Agent Sections to Add
| Section | Purpose | Integrates With |
|---------|---------|-----------------|
| Section 19: Pattern Extraction | Post-orchestration pattern learning | Tier 2 skill learning |
| Section 20: Model Routing Protocol | Complexity-based model selection for subtasks | Smart model routing |
| Section 21: Specialist Registry | Check/save/promote persistent specialists | Persistent specialist registry |
| Section 22: Agent Teams Protocol | When and how to use Agent Teams vs subagents | Agent Teams integration |
## Files to Modify
| File | Change | Why |
|------|--------|-----|
| `agents/pm.md` | Add Sections 19-22 | Core routing, learning, specialist, and teams logic |
| `agents/architect.md` | Add `memory: project` frontmatter | Enable persistent learning |
| `agents/developer.md` | Add `memory: project` frontmatter | Enable persistent learning |
| `agents/reviewer.md` | Add `memory: project` frontmatter | Enable persistent learning |
| `agents/pm.md` | Change `model: inherit` to `model: opus` (optional) | PM should use the strongest model for orchestration decisions |
| `agents/pm.md` Section 17 | Update dynamic agent lifecycle to check registry first | Specialist reuse |
| `hooks/hooks.json` | Add `TaskCompleted` and `TeammateIdle` hooks | Agent Teams quality gates |
| `bin/collect-agent-metrics.js` | Update pricing constants | Current model pricing (Opus $5/$25, not $15/$75) |
| `settings.json` | Add `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (optional) | Enable Agent Teams when user opts in |
## New Files to Create
| File | Purpose |
|------|---------|
| `bin/validate-task-completion.js` | TaskCompleted hook handler |
| `bin/reassign-idle-teammate.js` | TeammateIdle hook handler |
| `.orchestray/specialists/registry.json` | Specialist registry index (created at runtime) |
| `.orchestray/patterns/` | Pattern storage directory (created at runtime) |
## What NOT to Add
| Avoid | Why | Do Instead |
|-------|-----|------------|
| External memory/vector DB (Milvus, ChromaDB, Pinecone) | Massive overkill. Patterns are few (tens to hundreds), not millions. File-based search is fast enough. Adds deployment complexity and dependency. | Plain markdown files in `.orchestray/patterns/`. Claude's built-in Read/Grep tools handle search. |
| Custom MCP server for routing | Adds latency and complexity. Model routing is a simple decision the PM makes from its prompt. No need for an external service. | Routing logic lives in the PM's system prompt as a decision table. |
| External pattern extraction libraries (NLP, ML) | Claude IS the pattern extractor. Feeding text through external NLP to extract patterns, then feeding them back to Claude is circular. | PM agent reads audit trails and extracts patterns directly using its own reasoning. |
| `@anthropic-ai/sdk` for direct API calls | Orchestray operates within Claude Code's agent infrastructure. Direct API calls bypass the plugin sandbox, lose tool access, and create a parallel execution path. | Use Claude Code's native Agent tool and subagent system for all model interactions. |
| SQLite for registry/state | JSON files in `.orchestray/` are sufficient for single-user, single-session state. SQLite adds a native dependency and build complexity for no benefit at this scale. | JSON files with zod validation. |
| Heavy npm dependencies (langchain, llamaindex) | Hook handlers must be fast. Large dependency trees slow startup. These frameworks are designed for direct LLM API access, not Claude Code's agent system. | Node.js stdlib + zod only. |
| Modifying Claude Code's built-in agents (Explore, Plan) | These are internal to Claude Code and not user-modifiable. They may change between versions. | Create Orchestray-specific agents that complement the built-ins. |
## Stack Patterns by Feature
- Modify PM Section 17 to set `model:` field based on subtask complexity
- Update `bin/collect-agent-metrics.js` pricing constants
- No new files, no new hooks, ~50 lines of prompt changes
- Add `memory: project` to all 4 agent definitions (one-line change each)
- Add PM Section 19 for post-orchestration pattern extraction
- Create `.orchestray/patterns/` directory structure at runtime
- ~100 lines of prompt + minimal file structure
- Modify PM Section 17 lifecycle (check before create, save on success)
- Add PM Section 21 for registry management
- Create `registry.json` schema and management logic
- ~150 lines of prompt + registry logic
- Add 2 new hook scripts (`bin/validate-task-completion.js`, `bin/reassign-idle-teammate.js`)
- Add PM Section 22 for teams decision logic
- Modify `hooks/hooks.json` with new events
- Feature-flag everything behind `enable_agent_teams` config
- ~200 lines of prompt + ~100 lines of hook scripts
## Version Compatibility
| Component | Minimum Version | Required For | Notes |
|-----------|-----------------|--------------|-------|
| Claude Code | v2.0.0+ | Plugin system, subagents, hooks, skills | Already required by v1 |
| Claude Code | v2.1.32+ | Agent Teams | Experimental feature, must be explicitly enabled |
| Claude Code | v2.1.33+ | Subagent `memory` field, `effort` field | Required for skill learning |
| Claude Code | v2.1.59+ | Auto memory | Nice-to-have, not strictly required |
| Node.js | 20 LTS | Hook scripts | Already required by v1 |
## Sources
- [Claude Code Subagents Guide](https://code.claude.com/docs/en/sub-agents) -- Frontmatter fields, model field, memory field, tool restrictions, effort field (HIGH confidence)
- [Claude Code Agent Teams Guide](https://code.claude.com/docs/en/agent-teams) -- Team architecture, limitations, hooks, subagent integration (HIGH confidence)
- [Claude Code Memory Guide](https://code.claude.com/docs/en/memory) -- CLAUDE.md, auto memory, .claude/rules/, AutoDream (HIGH confidence)
- [Claude API Pricing](https://platform.claude.com/docs/en/about-claude/pricing) -- Current model pricing: Haiku $1/$5, Sonnet $3/$15, Opus $5/$25 (HIGH confidence)
- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) -- TaskCreated, TaskCompleted, TeammateIdle events (HIGH confidence)
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

The PM agent prompt uses a 3-tier architecture introduced in v2.0.8:
- **Tier 0** (`agents/pm.md`, ~1,030 lines) -- Always loaded. Core protocols: auto-trigger, complexity scoring, delegation, communication, anti-patterns, config defaults, Section Loading Protocol.
- **Tier 1** (`agents/pm-reference/tier1-orchestration.md`, ~1,650 lines) -- Loaded only during orchestration (complexity score >= threshold). State persistence, task decomposition, parallel execution, cost tracking, re-planning, verify-fix loops.
- **Tier 2** (`agents/pm-reference/*.md`, 12 feature-gated + 7 always-available files) -- Feature-gated files loaded only when their trigger condition is met (e.g., GitHub issue URL, CI failure, agent teams enabled). Dispatch table in Tier 0 maps conditions to files.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
