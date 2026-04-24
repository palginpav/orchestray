# Delegation Templates Reference

Delegation prompt formats and context handoff protocols for the three common-path agents.
For specialised agents (inventor, researcher, security-engineer, ux-critic, platform-oracle,
release-manager, tester, debugger, refactorer, documenter) and advanced injection templates
(trace injection, design-preference context, pattern citations, repo-map delta, visual
review, adaptive verbosity), see `delegation-templates-detailed.md`.

> Additional delegation templates for specialised agents are in `delegation-templates-detailed.md`. PM dispatches on the trigger below.

---

## Section 3: Delegation Prompt Format

When delegating to a subagent, provide a **clear, self-contained task description**.
The subagent has NO context from this conversation. It starts fresh.

### What to Include in Every Delegation

1. **Task description:** What needs to be done, in specific terms
2. **Relevant file paths:** Where to look, where to make changes
3. **Requirements and constraints:** Must-haves, must-not-haves
4. **Expected deliverables:** What the agent should produce
5. **Context from prior agents:** If architect produced a design, include it for developer
6. **Playbook instructions:** If Section 29 matched any playbooks for this agent type, append their Instructions sections to the delegation prompt
7. **Correction patterns**: If Section 30 found matching correction patterns for this agent, include the Known Pitfall warnings
8. **User correction patterns**: If Section 34f found matching user-correction patterns, include the Known Pitfall (User Correction) warnings. Combined cap with step 7: max 5 total correction warnings per delegation, prioritized by confidence.
9. **Repository map:** Include the relevant portion of the repo map from
   `.orchestray/kb/facts/repo-map.md` as a `## Repository Map` section (see Section 3
   Repository Map Injection rules for per-agent filtering)

9.5. **Project persona:** If `enable_personas` is true and a persona file exists for this
   agent type in `.orchestray/personas/`, inject it as a `## Project Persona` section in
   the delegation prompt. Cap at 150 words. See Section 42c in adaptive-personas.md.

10. **Exploration Discipline boilerplate:** Inject the `## Exploration Discipline`
    block from `agents/pm-reference/delegation-templates.md` §"Exploration Hygiene —
    Boilerplate" into every delegation (except trivially one-file tasks). Place
    AFTER `## Repository Map` and BEFORE `## Context from Previous Agent`.

### Exploration Hygiene — Boilerplate

Include this verbatim block in every delegation prompt (unless the agent's task is
trivially one-file). Place it AFTER the `## Repository Map` section and BEFORE the
`## Context from Previous Agent` section.

#### Template

```
## Exploration Discipline

Before reading any file:
1. If the Repository Map above answers your question, do NOT re-verify with a Read.
2. Use Glob for structure lookups (e.g., `Glob("src/**/*.ts")`) — never Read a
   directory.
3. Use Grep with `output_mode: "files_with_matches"` to find candidate files, then
   use `output_mode: "content"` with `-n` and `head_limit` on the narrow subset.
4. When a file is > 500 lines, Read it with `offset` and `limit`. Full reads of
   long files are the largest single source of wasted context.
5. Reading the same file twice in one session is a signal you should have taken
   notes the first time — re-check your prior tool results before re-reading.
```

### Example Delegation Prompts

**Good:** "Create a REST API endpoint POST /api/tasks in src/api/tasks.ts that accepts
{name: string, priority: number} and saves to the tasks table. Use the existing pattern
from src/api/users.ts. Return validation errors as 400 with {error: string} body."

**Good:** "Review the implementation in src/api/tasks.ts and src/models/task.ts.
Validate: correct error handling, SQL injection prevention, input validation completeness,
proper HTTP status codes. The endpoint accepts POST with {name, priority} body."

**Good:** "Design the caching architecture for the /api/products endpoint. Consider:
cache invalidation strategy, TTL values, storage backend (Redis vs in-memory), cache
key design. Output a design document with file structure and implementation approach."

### Reviewer Delegation: Git Diff Inclusion

When delegating to the **reviewer**, always include a `## Git Diff` section in the
delegation prompt. This enables the reviewer's diff-scoped reading mode, which reduces
token consumption by 25-35% while maintaining review quality.

```
[Task description -- what to review and what to check for]

## Files to Review
{files_changed from the developer's structured result}

## Git Diff
{output of `git diff -- <files_changed>` showing what the developer changed}

If the diff exceeds 300 lines, include a file-grouped summary instead of raw diff lines.
For each file: one line stating the change category (added function X, modified
error handling in Y, removed dead code in Z). Only include raw diff lines for files
the reviewer MUST read closely (maximum 2 files, 80 lines each).

## Context
{architect design, task requirements, or other relevant context}
```

The diff gives the reviewer a precise map of what changed, so it can focus analysis on
modified lines and only read full files when surrounding context is needed.

---

## Section 11: Context Handoff Template

Use this template when spawning a sequential agent that depends on a prior agent's work.

**SpecSketch (v2.1.8):** When `context_compression_v218.spec_sketch` is true (default),
use the YAML skeleton template below instead of the prose template for developer,
reviewer, tester, refactorer, and security-engineer downstream agents. For architect,
inventor, and debugger downstream agents (which benefit from rationale prose), use the
prose fallback template. `bin/_lib/spec-sketch.js` generates the skeleton; fall back to
prose if it returns `{ fallback: true }`.

**Budget:** the entire `## Context from Previous Agent` block MUST fit in ≤ 400 tokens.
SpecSketch skeleton median is ~140 tokens. Prose fallback: drop raw diff if needed and
include only a file-grouped summary.

### SpecSketch Template (YAML skeleton — default for most agents)

```yaml
## Previous: {agent_type} on task-{id}
files:
  src/api/tasks.ts:
    added_exports: [createTask, updateTask]
    modified_functions: [validateInput@L42]
    lines_delta: +58 -4
  src/models/task.ts:
    added_exports: [TaskSchema]
    added_types: [Task, TaskInput]
    lines_delta: +23 -0
contracts_met: [file_exists, diff_only_in, file_exports(tasksRouter)]
kb_refs: [decisions/api-validation-strategy]
rationale: |     # OPTIONAL — architect/inventor/debugger only, ≤ 60 tokens
  Chose zod over joi because zod integrates with the existing TypeScript types.
```

**Per-agent rule:** developer (after architect) → SpecSketch + KB slug refs + rationale ≤ 60 tokens; developer (after developer/debugger) → SpecSketch no rationale; reviewer → SpecSketch + raw git diff always; tester/refactorer → SpecSketch + raw git diff; architect/inventor/debugger → Prose template.

### Prose Fallback Template (architect/inventor/debugger, or when SpecSketch fails)

```
[Task description for Agent B -- specific, self-contained, per Section 3 rules]

## Context from Previous Agent

The {previous_agent} completed {previous_task}. Key context:

### KB Entries to Read
- `.orchestray/kb/{category}/{slug-1}.md` -- {summary from index}

### Code Changes
{git diff output -- summarize if > 120 lines}

Use the KB entries and code changes above to understand the current state before
proceeding. Do NOT re-read files covered by the KB entries.
```

---

## Per-Agent Pre-Flight Checklists (Core Agents)

Before spawning any agent, the PM must verify the delegation prompt addresses every item
on that agent's checklist. This is a PM-internal reasoning step — zero tool calls, zero
extra cost. Items that cannot be addressed should be noted as "N/A: {reason}" in the
delegation prompt.

For specialised agent checklists (tester, debugger, refactorer, inventor, researcher,
documenter, security-engineer, release-manager, ux-critic, platform-oracle), see
`delegation-templates-detailed.md`.

### Developer Checklist

- [ ] Input validation requirements specified? (what inputs does the code accept, what are the constraints)
- [ ] Error handling pattern referenced? (how should errors be caught, logged, surfaced)
- [ ] Test expectations included? (should the developer write tests, which types, for which cases)
- [ ] Backward compatibility constraints noted? (existing APIs, consumers, data formats to preserve)
- [ ] Import/dependency constraints stated? (allowed libraries, no new dependencies, use existing utils)
- [ ] Self-check instruction included? (compile, lint, test commands to run before reporting)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Architect Checklist

- [ ] Existing patterns to follow referenced? (current codebase conventions, established approaches)
- [ ] Constraints listed? (performance budgets, security requirements, compatibility targets)
- [ ] Scope boundaries explicit? (what is in scope vs. out of scope for this design)
- [ ] Decision format requested? (tradeoff analysis with options, pros/cons, recommendation)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Reviewer Checklist

- [ ] Specific file paths listed? (not "review the changes" -- exact files to examine)
- [ ] Task requirements included? (what the code should do, not just "check for bugs")
- [ ] Architect design reference linked if applicable? (design doc or KB entry for spec conformance)
- [ ] Priority dimensions specified? (correctness, security, performance, maintainability -- which matter most)
- [ ] Git diff included? (per the Reviewer Delegation: Git Diff Inclusion protocol above)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

---

**MCP field selection (R5 AC-05):** When calling `mcp__orchestray__pattern_find`, use the
`fields` parameter to limit response payload to only the fields you need.
Example: `pattern_find({query: "...", fields: ["slug","confidence"]})` — omit `fields` for full response.
