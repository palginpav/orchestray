# Phase 1: Plugin Foundation and Core Agents - Research

**Researched:** 2026-04-06
**Domain:** Claude Code plugin system, subagent architecture, skill-based slash commands
**Confidence:** HIGH

## Summary

Phase 1 builds the installable plugin scaffold and four core agent definitions (PM, architect, developer, reviewer) that enable manual orchestration via slash commands. The plugin system is well-documented and stable (v2.0.0+). The core pattern is PM-as-default-session-agent via the `settings.json` `agent` key, which makes every user prompt flow through PM logic that decides whether to orchestrate or pass through.

The implementation is predominantly markdown and JSON files -- agent definitions are markdown with YAML frontmatter, skills are markdown in directories, the manifest is JSON. The only code required is minimal: no hooks or TypeScript build step needed for Phase 1. The primary engineering challenge is writing high-quality agent system prompts (~200+ lines each) and designing the JSON+markdown return format that agents use to communicate results back to the PM.

**Primary recommendation:** Build Phase 1 as pure markdown/JSON plugin files with zero compiled code. Use skills for the 4 slash commands, agent definitions for the 4 roles, and a simple settings.json to set PM as default agent. Defer hooks, TypeScript, and build tooling to later phases.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** PM agent is the default session agent via settings.json `agent` key -- every prompt flows through PM, which decides whether to orchestrate or pass through to normal Claude Code behavior
- **D-02:** Runtime state stored in `.orchestray/` at project root -- task graphs, KB, audit logs all live here, separate from source code
- **D-03:** Distribution via both npm package (for users: `npm install -g orchestray`) and git clone + plugin-dirs (for contributors)
- **D-04:** Standard Claude Code plugin directory structure: manifest.json, settings.json, agents/, skills/, bin/
- **D-05:** Rich & opinionated system prompts (~200+ lines each) with examples, anti-patterns, decision heuristics, and output format specs
- **D-06:** Architect agent is design-only -- analyzes task, proposes file structure and approach, but does not write code. Developer implements based on architect's design.
- **D-07:** Reviewer agent performs full review: correctness, code quality, security, performance, and documentation
- **D-08:** Plugin exposes 4 slash commands with `/orchestray:` prefix: run, status, config, report
- **D-09:** PM uses directed fan-out pattern -- decides per-task whether agents run sequentially or in parallel
- **D-10:** Agents return results in JSON + markdown format: structured JSON for machine parsing (status, files changed, issues) plus markdown summary for readability
- **D-11:** On agent failure, PM retries once with feedback before reporting failure to user

### Claude's Discretion
- Exact plugin manifest.json fields and metadata
- Internal PM decision logic for when to fan-out vs. go sequential
- JSON schema details for agent return format
- Agent prompt iteration and refinement during implementation

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INTG-01 | Plugin scaffold with valid manifest, settings.json, and directory structure | Plugin structure fully documented in official docs; manifest requires only `name` field; `settings.json` supports `agent` key for PM-as-default |
| INTG-04 | Custom slash commands for manual orchestration trigger and status check | Skills system provides namespaced slash commands (`/orchestray:run`, etc.) via `skills/<name>/SKILL.md` directories |
| ROLE-01 | PM agent decomposes tasks, assigns work, and monitors progress | PM defined as `agents/pm.md` with rich system prompt; set as default via `settings.json` `agent` key; spawns subagents via Agent tool |
| ROLE-02 | Architect agent designs structure and makes technical decisions | Defined as `agents/architect.md`; design-only per D-06; tools restricted to read-only + Write for design docs |
| ROLE-03 | Developer agent implements code changes | Defined as `agents/developer.md`; full tool access for implementation |
| ROLE-04 | Reviewer agent validates implementation quality and correctness | Defined as `agents/reviewer.md`; read-only tools per D-07; full review scope |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

The CLAUDE.md contains GSD workflow enforcement directives. Key constraints:
- Use GSD entry points (`/gsd-quick`, `/gsd-debug`, `/gsd-execute-phase`) for all repo changes
- Do not make direct repo edits outside a GSD workflow unless explicitly asked
- No project skills, conventions, or architecture patterns established yet -- Phase 1 establishes them

## Standard Stack

### Core

| Component | Version | Purpose | Why Standard |
|-----------|---------|---------|--------------|
| Claude Code Plugin System | v2.0.0+ (current: v2.1.92) | Plugin packaging and distribution | Official extension mechanism; auto-discovers agents/, skills/, hooks/ directories [VERIFIED: claude --version shows 2.1.92] |
| Claude Code Subagents | Stable (Jul 2025) | Isolated specialized workers | Each gets own context window, system prompt, tool restrictions, model selection [VERIFIED: official docs at code.claude.com/docs/en/sub-agents] |
| Claude Code Skills | Stable (Oct 2025) | Slash commands and model-invoked knowledge | SKILL.md files in `skills/<name>/` become `/orchestray:<name>` commands [VERIFIED: official docs at code.claude.com/docs/en/skills] |
| Node.js | 22.19.0 | Runtime for future hook handlers | Claude Code runtime; available on system [VERIFIED: node --version] |

### Supporting (Phase 1 does NOT need these yet)

| Component | Version | Purpose | When to Use |
|-----------|---------|---------|-------------|
| TypeScript | 5.4+ | Type-safe hook handlers | Phase 2+ when hooks/bin scripts are needed |
| zod | 3.x | Runtime schema validation | Phase 2+ for state file validation |
| vitest | latest | Testing framework | Phase 2+ for hook handler unit tests |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Skills for slash commands | commands/ directory (legacy) | Skills are the current standard; commands/ still works but skills add frontmatter options and supporting files |
| Subagents for delegation | Agent Teams (experimental) | Agent Teams require experimental flag, cannot be created from plugins, self-coordinate instead of PM-controlled; subagents are stable and PM-deterministic |
| File-based state | SQLite | Overkill for Phase 1; file-based matches Claude Code's local-first philosophy |

## Architecture Patterns

### Plugin Directory Structure (Phase 1)

```
orchestray/
├── .claude-plugin/
│   └── plugin.json              # Manifest: name, version, description
├── settings.json                # Sets PM agent as default main agent
├── agents/
│   ├── pm.md                    # PM/Orchestrator agent (~200+ lines)
│   ├── architect.md             # Architecture specialist (read + write design docs)
│   ├── developer.md             # Implementation agent (full tools)
│   └── reviewer.md              # Review specialist (read-only)
├── skills/
│   ├── run/
│   │   └── SKILL.md             # /orchestray:run — trigger orchestration
│   ├── status/
│   │   └── SKILL.md             # /orchestray:status — show state
│   ├── config/
│   │   └── SKILL.md             # /orchestray:config — settings
│   └── report/
│       └── SKILL.md             # /orchestray:report — audit report
├── bin/                         # Empty for Phase 1, ready for Phase 2+
├── CLAUDE.md                    # Plugin-level instructions (minimal)
└── README.md                    # Usage documentation
```

[VERIFIED: structure matches official docs at code.claude.com/docs/en/plugins-reference]

### Pattern 1: PM-as-Default-Agent via settings.json

**What:** The plugin's `settings.json` sets `{"agent": "pm"}` to make the PM agent the default session agent. Every user prompt flows through PM.

**When to use:** Always -- this is the foundational pattern (D-01).

**Example:**
```json
// settings.json at plugin root
{
  "agent": "pm"
}
```
[VERIFIED: official docs confirm only `agent` key is currently supported in plugin settings.json]

**How it works:**
- When plugin is enabled, PM agent's system prompt replaces the default Claude Code system prompt
- PM agent's body (markdown below frontmatter) becomes the system prompt
- PM receives all user prompts and decides: handle directly or orchestrate
- PM can spawn subagents via the Agent tool (built-in to Claude Code)

### Pattern 2: Subagent Delegation via Agent Tool

**What:** PM spawns specialist subagents using Claude Code's built-in Agent tool. Each subagent runs in its own context window with restricted tools and a focused system prompt.

**When to use:** When PM determines a task needs specialist work (D-09).

**Key mechanics:**
- PM spawns subagent by invoking the Agent tool with agent type and prompt
- Subagent works independently in its own context window
- Subagent result is summarized and returned to PM
- Subagents CANNOT spawn other subagents (flat hierarchy) [VERIFIED: official docs]
- PM can restrict which subagents it spawns via `tools: Agent(architect, developer, reviewer)` syntax [VERIFIED: official docs]

**Example agent definition:**
```markdown
// agents/architect.md
---
name: architect
description: Analyzes requirements and designs implementation approach.
  Use when a task needs architectural planning before implementation.
  Creates file structure proposals and technical design documents.
tools: Read, Glob, Grep, Bash, Write
model: inherit
color: blue
---

You are a senior software architect...
[200+ lines of system prompt with examples, anti-patterns, heuristics]
```
[VERIFIED: frontmatter fields from official docs at code.claude.com/docs/en/sub-agents]

### Pattern 3: Skills as Namespaced Slash Commands

**What:** Each skill in `skills/<name>/SKILL.md` becomes `/orchestray:<name>` when the plugin is active.

**Key details:**
- `$ARGUMENTS` placeholder captures user input after command name
- `disable-model-invocation: true` prevents Claude from auto-triggering (use for /run, /config)
- Skills WITHOUT `disable-model-invocation` can be auto-invoked by Claude when relevant
- `context: fork` runs skill in isolated subagent context (useful for /status to avoid polluting main context)

**Example:**
```markdown
// skills/run/SKILL.md
---
name: run
description: Manually trigger orchestration on a task
disable-model-invocation: true
argument-hint: [task description]
---

# Orchestrate Task

Analyze the following task and orchestrate it across specialized agents:

Task: $ARGUMENTS

## Orchestration Protocol
1. Assess complexity and determine if orchestration is warranted
2. If simple, handle directly without spawning subagents
3. If complex, decompose into subtasks and delegate...
```
[VERIFIED: skill frontmatter fields from official docs at code.claude.com/docs/en/skills]

### Pattern 4: JSON + Markdown Agent Return Format

**What:** Agents return structured results that the PM can parse. Since subagent results are returned as text to the parent, the convention must be embedded in each agent's system prompt.

**Design (Claude's discretion per CONTEXT.md):**
```
Each agent returns a response in this format:

## Result Summary
[Human-readable markdown summary]

## Structured Result
\`\`\`json
{
  "status": "success" | "partial" | "failure",
  "files_changed": ["path/to/file.ts"],
  "files_read": ["path/to/other.ts"],
  "issues": [{"severity": "error"|"warning"|"info", "description": "..."}],
  "recommendations": ["..."],
  "retry_context": "..." // Only on failure, helps PM retry per D-11
}
\`\`\`
```
[ASSUMED -- exact schema is Claude's discretion per CONTEXT.md]

### Anti-Patterns to Avoid

- **Dumping full context to every agent:** Each subagent should get ONLY its task-specific instructions from PM, not the full conversation history. The PM is the only agent maintaining broad context. [CITED: architecture research]
- **Building custom coordination protocol:** Use Claude Code's native subagent return values. PM spawns agent, agent works, result returns to PM. No custom message passing needed. [CITED: architecture research]
- **Using Agent Teams instead of subagents:** Agent teams are experimental, self-coordinating, and cannot be created from plugins. Subagents are stable, PM-controlled, and plugin-compatible. [VERIFIED: official docs]
- **Hooks in plugin agents:** Plugin-shipped agents cannot use `hooks`, `mcpServers`, or `permissionMode` frontmatter. These fields are silently ignored. [VERIFIED: official docs]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Slash commands | Custom MCP tools or hook-based command system | Skills (`skills/<name>/SKILL.md`) | Skills are the standard mechanism; auto-discovered, namespaced, support arguments |
| Agent delegation | Custom message-passing or file-based coordination | Claude Code's Agent tool | Built-in, handles context isolation, result summarization, tool restrictions |
| Session agent override | Hook-based prompt interception | `settings.json` `agent` key | Single line of config vs. complex hook logic; guaranteed to intercept every prompt |
| Agent tool restrictions | Validation hooks checking tool usage | Subagent `tools` frontmatter field | Declarative, enforced by Claude Code itself, no code needed |
| Agent model selection | Custom routing logic | Subagent `model` frontmatter field | Declarative per-agent, overridable per-invocation |

## Common Pitfalls

### Pitfall 1: Plugin Agent Security Sandbox Restrictions
**What goes wrong:** Developer defines `permissionMode`, `hooks`, or `mcpServers` in plugin agent frontmatter expecting them to work. They are silently ignored.
**Why it happens:** Plugin agents have security restrictions not present for project-level agents.
**How to avoid:** For Phase 1, rely only on supported plugin agent fields: `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `isolation`, `color`. If full features are needed later, provide a setup script that copies agents to `.claude/agents/`.
**Warning signs:** Agents accepting edits without permission prompts, or hooks not firing.
[VERIFIED: official docs explicitly state this restriction]

### Pitfall 2: PM System Prompt Too Long / Context Explosion
**What goes wrong:** PM system prompt is so large it consumes significant context on every turn, leaving less room for actual work.
**Why it happens:** D-05 calls for ~200+ line prompts with examples and anti-patterns. The PM prompt must include orchestration logic, delegation rules, complexity assessment, and output format specs.
**How to avoid:** Keep PM prompt focused and well-structured. Use progressive disclosure -- core logic up front, detailed examples in skills that load only when needed. Consider preloading frequently-needed knowledge as skills via the `skills` frontmatter field.
**Warning signs:** Context compaction happening too frequently, PM losing track of conversation.
[CITED: pitfalls research, context window costs section]

### Pitfall 3: Skill Descriptions Consuming Context Budget
**What goes wrong:** All skill descriptions (unless `disable-model-invocation: true`) are loaded into context on every request. Four skills with long descriptions eat into the context budget.
**Why it happens:** Claude needs to know what skills are available to auto-invoke them.
**How to avoid:** Use `disable-model-invocation: true` on all 4 slash commands since they are user-invoked only (D-08). This removes their descriptions from context entirely. Keep descriptions under 250 characters (truncation limit).
**Warning signs:** `SLASH_COMMAND_TOOL_CHAR_BUDGET` being exceeded.
[VERIFIED: official docs on skill description truncation at 250 chars]

### Pitfall 4: Subagents Cannot Spawn Subagents
**What goes wrong:** Developer designs nested delegation (PM -> architect -> sub-architect). Architect cannot spawn subagents.
**Why it happens:** Claude Code enforces flat subagent hierarchy. Only the main session agent can spawn subagents.
**How to avoid:** All delegation must go through PM. PM is always the direct parent of every specialist. Design workflows as PM -> [agents] not PM -> architect -> developer.
**Warning signs:** Agent definitions that reference spawning other agents in their prompts.
[VERIFIED: official docs state "Subagents cannot spawn other subagents"]

### Pitfall 5: Agent Description Quality Determines Delegation
**What goes wrong:** PM doesn't delegate to the right agent, or delegates when it shouldn't.
**Why it happens:** Claude uses agent descriptions to decide when to delegate. Vague or overlapping descriptions cause incorrect delegation.
**How to avoid:** Write precise, non-overlapping descriptions for each agent. Include "Use when..." and "Do NOT use when..." in descriptions. Test delegation with various task types.
**Warning signs:** PM consistently choosing the wrong agent or refusing to delegate.
[VERIFIED: official docs emphasize description importance for delegation]

### Pitfall 6: PM Retry Logic Ambiguity (D-11)
**What goes wrong:** PM retries a failed agent but the retry produces the same failure because the PM doesn't provide useful feedback.
**Why it happens:** D-11 says "PM retries once with feedback" but the quality of feedback determines retry success.
**How to avoid:** Agent return format must include `retry_context` on failure (structured info about what went wrong). PM must inject this context into the retry prompt, not just re-run the same prompt.
**Warning signs:** Retries always failing the same way as the original attempt.
[ASSUMED -- retry mechanism design detail]

## Code Examples

### Plugin Manifest (plugin.json)
```json
// .claude-plugin/plugin.json
{
  "name": "orchestray",
  "description": "Multi-agent orchestration for complex tasks",
  "version": "0.1.0",
  "author": {
    "name": "Orchestray"
  },
  "homepage": "https://github.com/user/orchestray",
  "repository": "https://github.com/user/orchestray"
}
```
[VERIFIED: schema from official docs at code.claude.com/docs/en/plugins-reference]

### Settings (settings.json)
```json
// settings.json at plugin root
{
  "agent": "pm"
}
```
[VERIFIED: official docs confirm `agent` is the only supported key]

### Agent Definition Template
```markdown
---
name: architect
description: Analyzes requirements and designs implementation approach.
  Use when a task needs architectural planning, system design, or
  file structure decisions. Does NOT write implementation code.
tools: Read, Glob, Grep, Bash, Write
model: inherit
maxTurns: 30
color: blue
---

[System prompt body - 200+ lines]
```
[VERIFIED: frontmatter fields from official subagent docs]

### Skill Definition Template
```markdown
---
name: run
description: Trigger multi-agent orchestration on a task
disable-model-invocation: true
argument-hint: [task description]
---

# Orchestrate Task

$ARGUMENTS

[Orchestration instructions for PM]
```
[VERIFIED: skill frontmatter and $ARGUMENTS from official docs]

### PM Agent Tool Restriction for Spawning
```markdown
---
name: pm
description: Project manager that orchestrates complex tasks across
  specialized agents. Assesses task complexity and decides whether
  to handle solo or delegate to architect, developer, and reviewer.
tools: Agent(architect, developer, reviewer), Read, Glob, Grep, Bash, Write, Edit
model: inherit
maxTurns: 100
color: purple
---
```
[VERIFIED: `Agent(type1, type2)` syntax from official docs restricts which subagents can be spawned]

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `commands/` directory for slash commands | `skills/` directory with SKILL.md | Oct 2025 | Skills are the standard; commands/ is legacy but still works |
| Task tool for spawning subagents | Agent tool (renamed from Task) | v2.1.63 | `Task(...)` still works as alias but `Agent(...)` is current |
| No plugin settings | `settings.json` with `agent` key | 2026 | Plugins can now set default session agent |
| Manual agent setup | Plugin auto-discovery of agents/ | v2.0.0 | Agents in plugin `agents/` dir are auto-registered |

**Deprecated/outdated:**
- `Task` tool name: renamed to `Agent` in v2.1.63; old name still works as alias [VERIFIED: official docs]
- `commands/` for skills: legacy location, `skills/` preferred [VERIFIED: official docs note "legacy; use skills/ for new skills"]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | JSON + markdown return format with specific fields (status, files_changed, issues, retry_context) | Pattern 4: Agent Return Format | Low -- schema is Claude's discretion per CONTEXT.md; can iterate during implementation |
| A2 | PM retry mechanism uses retry_context from failed agent's response | Pitfall 6 | Low -- implementation detail, easily adjusted |
| A3 | 200+ line system prompts won't cause unacceptable context overhead | Pitfall 2 | Medium -- if prompts are too large, may need to move examples to preloaded skills |
| A4 | All 4 slash commands should use disable-model-invocation: true | Pitfall 3 | Low -- these are user-initiated actions, auto-invocation would be surprising |

## Open Questions (RESOLVED)

1. **PM prompt length vs. context efficiency tradeoff**
   - What we know: D-05 requires ~200+ line prompts; context window costs are real
   - What's unclear: Exact context impact of a 200-line PM system prompt loaded on every turn
   - **Resolution:** Start with full prompts, measure context compaction frequency, refactor to skills if needed

2. **Agent tool invocation syntax in PM prompt**
   - What we know: PM spawns subagents via the Agent tool; the tool accepts agent type and prompt
   - What's unclear: Exact syntax PM should use in its system prompt to reliably invoke subagents (whether to name them explicitly or describe the task and let Claude match descriptions)
   - **Resolution:** Use explicit agent names in PM prompt instructions ("Spawn the architect agent with...") combined with `tools: Agent(architect, developer, reviewer)` restriction

3. **Runtime state directory (.orchestray/) initialization**
   - What we know: D-02 specifies `.orchestray/` for runtime state
   - What's unclear: When/how to create the directory -- on first /orchestray:run? On plugin enable?
   - **Resolution:** Create lazily on first orchestration run; include in .gitignore template

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Future hook handlers (Phase 2+) | Yes | 22.19.0 | -- |
| npm | Package distribution (D-03) | Yes | 10.9.3 | -- |
| Claude Code | Plugin system | Yes | 2.1.92 | -- |
| git | Version control | Yes | (system) | -- |

**Missing dependencies with no fallback:** None -- all required tools are available.

Phase 1 has no external dependencies beyond Claude Code itself. The plugin is pure markdown/JSON files.

## Sources

### Primary (HIGH confidence)
- [Claude Code Plugins Guide](https://code.claude.com/docs/en/plugins) -- Full plugin creation walkthrough, directory structure, settings.json agent key
- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference) -- Complete manifest schema, component specifications, supported frontmatter, environment variables
- [Claude Code Subagents Guide](https://code.claude.com/docs/en/sub-agents) -- All frontmatter fields, Agent tool syntax, security restrictions, delegation mechanics
- [Claude Code Skills Guide](https://code.claude.com/docs/en/skills) -- SKILL.md format, frontmatter fields, $ARGUMENTS, disable-model-invocation, context:fork

### Secondary (MEDIUM confidence)
- `.planning/research/STACK.md` -- Prior stack research covering extension points and patterns
- `.planning/research/ARCHITECTURE.md` -- Prior architecture research covering PM-as-main-agent pattern and data flow
- `.planning/research/PITFALLS.md` -- Prior pitfalls research covering context explosion, error amplification, complexity death spiral

### Tertiary (LOW confidence)
- None -- all claims verified against official documentation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all components verified against official Claude Code docs and local environment
- Architecture: HIGH -- plugin structure, agent frontmatter, and skill system verified against official docs
- Pitfalls: HIGH -- security sandbox restriction verified; context costs documented in official docs
- Agent prompts: MEDIUM -- prompt content is the creative/engineering challenge; structure is verified

**Research date:** 2026-04-06
**Valid until:** 2026-05-06 (plugin system is stable; 30-day validity appropriate)
