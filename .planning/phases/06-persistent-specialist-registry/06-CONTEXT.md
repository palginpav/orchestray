# Phase 6: Persistent Specialist Registry - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

PM offers to save dynamic agents to `.orchestray/specialists/` after successful orchestration, checks specialist registry before creating new ephemeral agents for matching subtasks, and supports user-created specialist templates. Users manage specialists via `/orchestray:specialists` skill. Does NOT include adaptive specialist improvement from usage history (future) or community specialist sharing.

</domain>

<decisions>
## Implementation Decisions

### Save & Reuse Lifecycle
- **D-01:** Save on success only — PM offers to save a dynamic agent when it completes with `status: success`. No user confirmation prompt; PM decides based on agent quality. Failed agents are never saved.
- **D-02:** Name + description matching for reuse — before spawning a new dynamic agent, PM checks registry for specialists whose name or description closely matches the subtask. PM judges the match using its reasoning capabilities. No tag system needed.
- **D-03:** Promotion at threshold — after 5 uses (`times_used >= 5`), PM suggests promoting the specialist to `.claude/agents/` for permanent project-level availability. User must confirm the promotion.
- **D-04:** Soft cap at 20 with warning — when registry reaches 20 specialists, PM warns and suggests pruning via `/orchestray:specialists`. No hard block. Prevents unbounded growth without frustrating power users.

### Registry Format & Storage
- **D-05:** Essential metadata in registry.json — track: `name`, `description`, `source` (auto-saved/user-created), `times_used`, `last_used`, `created_at`. Minimal but sufficient for matching, pruning, and promotion decisions.
- **D-06:** Same .md format as dynamic agents — specialist files use identical YAML frontmatter + markdown body format as Section 17 dynamic agent definitions. On reuse, PM copies from `.orchestray/specialists/` to `agents/` for spawning, cleans up `agents/` copy after completion.
- **D-07:** Storage location is `.orchestray/specialists/` — inside the existing runtime directory, consistent with `.orchestray/kb/`, `.orchestray/audit/`, `.orchestray/state/`. Gitignored by default.

### User-Defined Templates
- **D-08:** User-created specialists always win — if both a user-created and auto-saved specialist match a subtask, the user-created one takes priority. `source` field in registry.json distinguishes them.
- **D-09:** Strict validation with zod — validate specialist .md files against a schema requiring valid YAML frontmatter with `name`, `description`, `tools` fields. Reject files missing required fields or with invalid tool names. Prevents broken specialists from failing at spawn time.
- **D-10:** Both creation paths — users can drop custom .md files directly into `.orchestray/specialists/` AND PM auto-saves successful dynamic agents. Maximum flexibility.

### Specialist Skill (/orchestray:specialists)
- **D-11:** Full CRUD operations — `list` (table with name, source, uses, last_used, description), `view {name}` (show full .md content), `remove {name}` (delete with confirmation), `edit {name}` (open for editing). Covers SPEC-04.
- **D-12:** Table with stats for list output — `| Name | Source | Uses | Last Used | Description |` format matching `/orchestray:report` style. Clean, scannable.
- **D-13:** No test/dry-run mode — users inspect specialists via `view`. Testing happens naturally during orchestration. Keep the skill simple.

### Claude's Discretion
- Exact matching heuristic for name+description similarity (threshold, weighting)
- How to handle specialist files that exist in `.orchestray/specialists/` but aren't in `registry.json` (user dropped a file manually)
- Registry initialization: create directory + registry.json on first save vs. on plugin install
- Save prompt wording and format when offering to persist a dynamic agent
- Promotion prompt wording and what metadata carries over to `.claude/agents/`

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Code to Extend
- `agents/pm.md` — Section 17 (Dynamic Agent Spawning) lifecycle, Section 3 (Agent Spawning), Section 19 (Model Routing Protocol)
- `skills/orchestray:config/SKILL.md` — Current config pattern for adding settings if needed
- `skills/orchestray:run/SKILL.md` — Orchestration flow where specialist save-offer would occur (post-completion)

### Research
- `.planning/research/STACK.md` — Specialist registry design (registry.json schema, lifecycle changes, promotion path)
- `.planning/research/FEATURES.md` — Competitor analysis, specialist patterns
- `.planning/research/PITFALLS.md` — Known risks

### Project
- `.planning/PROJECT.md` — v2.0 milestone goals
- `.planning/REQUIREMENTS.md` — SPEC-01, SPEC-02, SPEC-03, SPEC-04

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- PM Section 17 (Dynamic Agent Spawning) — complete lifecycle for creating, spawning, processing, and deleting ephemeral agents. Phase 6 modifies step 5 (delete) to optionally save instead.
- PM Section 19 (Model Routing Protocol) — routing applies to specialists just like any other agent. No special handling needed.
- `bin/audit-event.js` — pattern for file I/O with JSON, can inform registry management approach
- `skills/orchestray:config/SKILL.md` — established pattern for skill with validation

### Established Patterns
- Config settings with validation and defaults
- Skills as slash commands with structured output
- `.orchestray/` directory for all runtime state (kb/, state/, audit/, history/)
- Agent .md files with YAML frontmatter + markdown body format

### Integration Points
- PM Section 17 step 5 (lifecycle) → check registry before creating, save on success instead of deleting
- PM post-orchestration → offer save for successful dynamic agents
- PM task decomposition → check registry for matching specialists before Section 17
- New skill: `skills/orchestray:specialists/SKILL.md` → CRUD operations on registry

</code_context>

<specifics>
## Specific Ideas

- Registry.json schema from research/STACK.md provides a good starting point: `{ specialists: [{ name, description, source, times_used, last_used, created_at, file }] }`
- Promotion to `.claude/agents/` means the specialist becomes a permanent subagent visible to Claude Code natively — significant upgrade from `.orchestray/specialists/`
- Strict validation catches errors early (e.g., user typos in tool names) rather than failing at spawn time with a confusing error
- Haiku should never be used for architect or reviewer specialists — routing rules from Phase 5 D-01 apply

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-persistent-specialist-registry*
*Context gathered: 2026-04-07*
