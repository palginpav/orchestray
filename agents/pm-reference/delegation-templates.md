# Delegation Templates Reference

Delegation prompt formats and context handoff protocols for the three common-path agents.
For specialised agents (inventor, researcher, security-engineer, ux-critic, platform-oracle,
release-manager, tester, debugger, refactorer, documenter) and advanced injection templates
(trace injection, design-preference context, pattern citations, repo-map delta, visual
review, adaptive verbosity), see `delegation-templates-detailed.md`.

> Additional delegation templates for specialised agents are in `delegation-templates-detailed.md`. PM dispatches on the trigger below.

---

## Context Size Hint (R-BUDGET-WIRE, v2.1.16)

Every `Agent()`, `Explore()`, and `Task()` spawn MUST carry a `context_size_hint`
object in the tool input so the `PreToolUse:Agent` hook
(`bin/preflight-spawn-budget.js`) can compare the total prompt size against the
role's configured budget. The hint is the spawn-time projection — no new
measurement is needed because the PM already assembles the prompt before the
spawn.

**Field shape:**

```json
"context_size_hint": {
  "system":  <int — system-prompt tokens incl. tier-2 reference files>,
  "tier2":   <int — duplicated for back-compat; equals the tier-2 portion of system>,
  "handoff": <int — handoff payload tokens (delta or full)>
}
```

**How to compute (rule of thumb):** total characters in the assembled prompt
sections divided by 4 ≈ tokens. When a precomputed token count is available
(e.g., from `bin/_lib/spec-sketch.js` or the prompt builder), use it instead.
The hint is advisory — the hook fails open on missing or zero values, so
omitting the hint never blocks the spawn but disables soft-warn telemetry for
that spawn.

**Per-template populating:** Every role's delegation contract below carries an
implicit `context_size_hint` field. When a template's example shows a YAML or
JSON contract, the PM SHOULD include the `context_size_hint` block alongside
the role-specific fields. See `agents/pm.md` § "Pre-Spawn Budget Check
(R-BUDGET)" for the canonical PM-side computation step.

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

### Reviewer Delegation: Dimension Scoping

**R-RV-DIMS (v2.1.16).** Every reviewer delegation MUST carry a `review_dimensions`
field plus a `## Dimensions to Apply` block. The PM's classifier
(`bin/_lib/classify-review-dimensions.js`, restated as a prompt rule in `pm.md`
§3.RV) populates these from the developer's `files_changed` set.

**Field shape:**

```yaml
# review_dimensions field (R-RV-DIMS, v2.1.16)
review_dimensions:
  type: "all" | string[]
  default: "all"
  allowed_values: ["code-quality", "performance", "documentation", "operability", "api-compat"]
  invariant: "Correctness and Security are always reviewed; they cannot appear in this list."
```

**Delegation prompt block — insert immediately after `## Context`:**

```
## Dimensions to Apply
{review_dimensions: "all" | bulleted list}

For each item in the bulleted list, Read the matching fragment file BEFORE forming
findings:
- code-quality   → agents/reviewer-dimensions/code-quality.md
- performance    → agents/reviewer-dimensions/performance.md
- documentation  → agents/reviewer-dimensions/documentation.md
- operability    → agents/reviewer-dimensions/operability.md
- api-compat     → agents/reviewer-dimensions/api-compat.md

If the value is "all", Read all five files. Correctness and Security are always
reviewed and live in your core prompt — do NOT request fragment files for them.
```

When `review_dimension_scoping.enabled` is `false` (kill switch) or the env var
`ORCHESTRAY_DISABLE_REVIEWER_SCOPING=1` is set, the PM falls back to
`review_dimensions: "all"` and emits the same block listing all five fragment
paths. v2.1.15-style spawns that omit the block entirely behave as if `"all"`
was passed (back-compat by default per the v2.1.16 release plan).

### Repo-Map Token Budget (R-AIDER-FULL)

**R-AIDER-FULL (v2.1.17 W8).** Code-touching agents (developer, refactorer,
reviewer, debugger) receive an Aider-style repo map prepended to the
delegation prompt under a `## Repo Map (Aider-style, top-K symbols)` block.
Map size is capped by a per-role token budget; a per-spawn override field on
the delegation template lets the PM tighten or lift the cap.

**Field shape:**

```yaml
# repo_map_token_budget field (R-AIDER-FULL, v2.1.17)
repo_map_token_budget: <int>   # 0 disables; defaults: dev 1500, refactorer 2500,
                                #   reviewer 1000, debugger 1000, all others 0.
```

**Override semantics:** Set `repo_map_token_budget: 0` to opt out of repo-map
injection for a single delegation (useful when the agent is reading a small
focused diff and a 1500-token map would compete with handoff context). Set a
larger value (e.g. `3000`) when the agent is doing a cross-cutting refactor
and needs more graph context than the role default. Out-of-range or
non-integer values fall back to the role default.

When `repo_map.enabled` is `false` (kill switch) or `repo_map.cold_init_async`
is `true` AND the cache is cold, the PM emits an empty map and proceeds. The
agent prompt remains valid in both cases — the repo map is supplementary
context, never load-bearing.

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
context_size_hint: { system: <int>, tier2: <int>, handoff: <int> }   # R-BUDGET-WIRE; PM-populated
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

context_size_hint: { system: <int>, tier2: <int>, handoff: <int> }   # R-BUDGET-WIRE; PM-populated

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
- [ ] `review_dimensions` field set? (`"all"` or a subset of `["code-quality","performance","documentation","operability","api-compat"]`; populated by the PM classifier per `pm.md` §3.RV)
- [ ] `## Dimensions to Apply` block included with the explicit list of fragment file paths the reviewer must Read?
- [ ] Git diff included? (per the Reviewer Delegation: Git Diff Inclusion protocol above)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

---

**MCP field selection (R5 AC-05):** When calling `mcp__orchestray__pattern_find`, use the
`fields` parameter to limit response payload to only the fields you need.
Example: `pattern_find({query: "...", fields: ["slug","confidence"]})` — omit `fields` for full response.

---

## Section 12: Re-Delegation — Delta Payload (R-DELTA-HANDOFF, v2.1.15)

When re-delegating to a developer agent after a reviewer pass, send the **delta payload**
by default — not the full prior artifact. The full artifact stays in the KB and the
developer fetches it on demand only when a deterministic fallback trigger fires.

### Default re-delegation payload

```yaml
## Re-delegation context (delta mode)
reviewer_summary: "<reviewer summary — ≤500 chars>"
reviewer_issues:
  - severity: "<error|warn|info>"
    file: "<file path>"
    line: <line number or null>
    message: "<issue description>"
delta_diff: |
  <git diff of what the reviewer saw — max ~2000 tokens>
detail_artifact: "<kb path to full reviewer artifact, e.g. .orchestray/kb/artifacts/reviewer-pass1.md>"
```

The `detail_artifact` field is the documented signal that puts the developer in **delta
mode**. The developer reads the three fallback trigger rules (below) and fetches the
full artifact only when required. This is an agent-side decision — the PM does not
pre-decide for the developer.

### Kill switch

Set `config.delta_handoff.force_full: true` to disable delta mode for all re-delegations.
When the kill switch is active, the developer always fetches the full artifact (reason:
`"force_config"`). This is a rollback switch only — it appears in the CHANGELOG under
"Kill switches available," not as a tuning option.

Kill switch config key: `delta_handoff.force_full` (default: `false`).
Enable/disable delta mode entirely: `delta_handoff.enabled` (default: `true`).

---

## Fallback: full-artifact fetch

When the delegation payload contains `detail_artifact:`, the developer agent is in
delta mode. The developer fetches the full artifact via `kb_read` and emits a
`delta_handoff_fallback` event **only if** any of the three deterministic triggers
below fires. Otherwise the developer emits `{fetched: false}` once and proceeds.

### Trigger 1 — `issue_gap`

`reviewer_issues[]` is empty **AND** the planned change touches a file or symbol that
the `reviewer_summary` does not name.

Signal: the reviewer saw no specific issues but the developer is about to touch
something outside the summary's scope — the summary may be too thin for safe navigation.

### Trigger 2 — `hedged_summary`

The `reviewer_summary` contains any of these hedge phrases (case-insensitive):
`"see details"`, `"additional context"`, `"depends on"`, `"may need"`, `"recommend reviewing"`.

Signal: the reviewer hedged rather than being specific. The developer needs the full
artifact to understand the actual guidance. (Reviewer discipline note: avoid these
phrases — list specific items in `issues[]` instead.)

### Trigger 3 — `cross_orch_scope`

The planned `Edit`/`Write` targets a file whose `git log -1` commit date predates the
current orchestration's start time.

Signal: the developer is about to touch a file that was not part of this orchestration's
context. The full artifact may contain prior-context that the delta summary omits.

### Trigger evaluation order

Triggers are evaluated in order: `force_full` (kill switch) → `hedged_summary` → `cross_orch_scope` → `issue_gap`. The first matching trigger sets `reason` in the emitted event.

### Fallback event

When any trigger fires, emit `delta_handoff_fallback` before fetching:

```json
{
  "event_type": "delta_handoff_fallback",
  "version": 1,
  "orchestration_id": "<current orch id>",
  "task_id": "<task id>",
  "agent_type": "developer",
  "fetched": true,
  "reason": "<issue_gap | hedged_summary | cross_orch_scope | force_config>",
  "summary_chars": <length of reviewer_summary>,
  "detail_artifact": "<kb path>"
}
```

Target fetch rate: 10–30% over a cohort of re-delegations. Rates above 30% indicate
hedge-phrase creep in reviewer summaries (tighten in v2.1.16). Rates below 10% may
indicate under-fetching (loosen trigger 1 in v2.1.16).
