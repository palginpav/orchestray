<!-- PM Reference: Decomposition phase slice — loaded when current_phase ∈
     {assessment, decomposition, delegation}. Pre-spawn protocols: task graph
     building, contract generation, pattern application, playbook loading,
     trace-injection plan. The shared infrastructure (state, KB, handoff) lives
     in phase-contract.md (always loaded). -->

# Phase: Decomposition

This slice covers everything that happens between "complexity score ≥ threshold"
and "first `Agent()` spawn": archetype classification, task graph construction,
contract generation, pattern application, and playbook loading.

Cross-phase pointers (validated by `bin/_tools/phase-split-validate-refs.js`):

- State/KB/handoff foundations: `(see phase-contract.md §"7. State Persistence Protocol")`, `(see phase-contract.md §"10. Knowledge Base Protocol")`, `(see phase-contract.md §"11. Context Handoff Protocol")`.
- After decomp emits the task graph, execution proceeds via `(see phase-execute.md §"14. Parallel Execution Protocol")`.
- Re-planning re-enters this slice via `(see phase-verify.md §"16. Adaptive Re-Planning Protocol")` step 4 ("Generate a new task graph").

---

## 13. Task Decomposition Protocol

When complexity score >= 4 (medium or complex), decompose the task into a structured
subtask graph before delegating. This ensures clear ownership, dependency tracking,
and parallel execution where possible.

### Reading an Archetype Advisory

When an `<orchestray-archetype-advisory>` fence appears in your context before decomposition, it means the ArchetypeCache (advisory-active mode) found a prior orchestration whose task shape closely matches yours (confidence ≥ 0.85, applied ≥ 3 times before). The fence contains that prior orchestration's decomposition: agent set, file ownership, dependencies.

This is an **advisory hint**, not a prescription. You MUST decide one of:
- **accepted** — adopt the prior decomposition verbatim. Use when task shapes are truly identical.
- **adapted** — use the prior decomposition as a starting point, modify 1–3 details. Use when task shape is similar but your current task has a meaningful delta (different agents needed, different complexity).
- **overridden** — ignore the advisory and decompose from scratch per the steps below. Use when the prior decomposition is wrong for your task (misleading match).

After deciding, emit `pm_reasoning_brief` (≤280 chars) in your `archetype_cache_advisory_served` event explaining why you chose that decision. The PM's `pm_decision` field in the event captures one of the three values above.

If no fence is present, proceed normally — the cache either found no match, the feature is disabled, or decomposition is already underway.

### When to Decompose

Decompose when complexity score >= 4 (medium or complex). Simple tasks (score < 4)
are handled solo without decomposition. The overhead of decomposition exceeds its
benefit for simple tasks.

### Decomposition Steps

**Pre-check:** Before decomposing, apply §22b pattern check below. Any relevant patterns
from past orchestrations will inform the decomposition strategy below.

**Pre-decomposition retrieval checklist (MANDATORY before first `Agent()` spawn).**
Before calling `Agent()` for the first time, confirm §22b retrieval has actually run
for the current `orchestration_id`: `mcp__orchestray__pattern_find`,
`mcp__orchestray__kb_search`, and `mcp__orchestray__history_find_similar_tasks` must
each have been invoked once (each call emits a `mcp_checkpoint_recorded` row to
`.orchestray/state/mcp-checkpoint.jsonl`). If any of the three was skipped — or if
`gate-agent-spawn.js` blocks your first spawn with a diagnostic naming a missing MCP
tool (e.g., `missing MCP checkpoint for pattern_find`) — **do not retry the spawn
blindly**; follow the re-entry protocol at §22b.R. Retrying without re-running the
missing retrieval call produces the R2 infinite-retry loop that §22b.R was written
to prevent.

**Prior-art check:** Also before decomposing, call
`mcp__orchestray__history_find_similar_tasks` with the user's task summary and
`min_similarity: 0.75`. If any match has `outcome: "success"`, read its summary via
`@orchestray:history://orch/<orch_id>/summary` (or the archive events if the summary
is missing), flag it as prior art in the plan preview, and bias decomposition toward
the same shape. If the MCP server is unavailable, fall back to the cross-session KB
scan (per pm.md §2.4). Prior art is **advisory** -- read the returned task's
`outcome_reason` and discard matches that don't actually apply. This call is the
same `history_find_similar_tasks` call tracked by the pre-decomposition retrieval
checklist above — running it here satisfies that checklist item.

**Workflow override:** Before step 1, check Section 35 (Custom YAML Workflow Definitions,
in `agents/pm-reference/yaml-workflows.md`). If a workflow is matched (via `--workflow` flag or auto-match),
use the workflow-derived task graph instead of the decomposition steps below -- skip
directly to `(see phase-execute.md §"14. Parallel Execution Protocol")`.
If a workflow is matched, Section 38 (adversarial review, in `agents/pm-reference/adversarial-review.md`) does not apply.

**Adversarial architecture:** If NO workflow was matched, complexity score >= 8, and
`adversarial_review` is true, apply Section 38 (Adversarial Architecture Review, in
`agents/pm-reference/adversarial-review.md`) -- replace the single architect step with a dual-architect evaluation.

1. **Load playbooks**: If `.orchestray/playbooks/` exists, load matching playbooks per §29 below.
   Matched playbooks will be injected into agent delegation prompts in pm.md §3 (Delegation).

1b. **Classify task archetype**: Read `agents/pm-reference/pipeline-templates.md` and
   use its Archetype Classification table to match the task against the canonical
   workflow archetypes. Do NOT enumerate archetype names inline here — the canonical
   list lives in `pipeline-templates.md` and is the sole authoritative source.
   Use the matched archetype's template as the starting decomposition strategy.
   Log: "Archetype: {name}".

   > See `agents/pm-reference/pipeline-templates.md` §"Archetype Classification" for
   > the complete list of archetypes, keyword triggers, and agent-flow templates.
   > Do not duplicate or override the archetype list here.

   **TDD mode**: If `.orchestray/config.json` has `tdd_mode: true` AND archetype is
   "New Feature", use the TDD variant: architect -> tester -> developer -> reviewer.
   The tester writes tests from the architect's spec BEFORE the developer implements.

   **Config gate — `auto_review`**: After loading the archetype template, check
   `.orchestray/config.json` for `"auto_review": false`. If set to `false`, remove the
   reviewer group from the template before building the task graph and record
   `auto_review_skipped` in `.orchestray/state/orchestration.md` under `## Decisions Made`.
   Default (key absent or `true`) continues to include the reviewer group as normal.
   This gate applies to the routine post-implementation reviewer only — it does NOT
   affect verify-fix reviewers (`(see phase-verify.md §"18. Verify-Fix Loop Protocol")`),
   adversarial review (Section 38), or security review (PM Section 24), which are
   governed by their own config keys.

2. **Identify subtasks**: Break the task into 2-6 independent units of work. Each
   subtask should be completable by a single agent in one invocation.

3. **Assign agents**: Each subtask gets exactly one agent type:
   - **architect**: Design decisions, API schemas, architecture documents
   - **developer**: Code implementation, file creation/modification
   - **refactorer**: Code restructuring, pattern migration, duplication removal, module extraction
   - **reviewer**: Code review, security validation, correctness checks
   - **debugger**: Bug investigation, root cause analysis, failure diagnosis
   - **tester**: Test writing, coverage analysis, test strategy
   - **documenter**: Documentation creation, README updates, changelogs
   - **security-engineer**: Security design review, implementation audit, threat modeling
   - **inventor**: Novel tool/framework/DSL creation, custom solutions, first-principles design with prototype

4. **Map dependencies**: Determine which subtasks must complete before others can start.
   Use the `depends_on` field to express these relationships.

5. **Assign file ownership**: Each writable file belongs to exactly one subtask. No two
   subtasks write to the same file. This prevents merge conflicts and ensures clear
   responsibility. If two subtasks need to write to the same file, either merge them
   into one subtask or make one depend on the other.

6. **Choose granularity**: PM decides per-subtask based on change complexity:
   - **File-level**: One subtask per file. Use for simple, mechanical changes with
     clean ownership boundaries (e.g., adding a field to multiple independent files).
   - **Feature-level**: One subtask spans multiple related files. Use for complex
     features where splitting by file would lose context (e.g., an API endpoint
     spanning route, controller, model, and test files).

7. **Identify parallel groups**: Tasks with no dependency relationship form parallel
   groups that can execute simultaneously:
   - Group 1: Tasks with no dependencies (roots)
   - Group 2: Tasks depending only on Group 1 tasks
   - Group 3: Tasks depending on Group 1-2 tasks
   - And so on until all tasks are assigned to a group

8. **Verify no circular dependencies**: Every task must be reachable from a root task
   with no dependencies. If a circular dependency is detected (A depends on B, B
   depends on C, C depends on A), restructure the graph by merging tasks or removing
   unnecessary dependencies.

9. **Write task graph**: Create the task graph document and individual task files in
   `.orchestray/state/tasks/`.

10. **Estimate orchestration duration (P2.1, v2.2.0; refined v2.2.3 P3 W5/C11).**
    After the task graph is finalized, write `pm_protocol.estimated_orch_duration_minutes`
    (a positive integer) into `.orchestray/audit/current-orchestration.json` — the
    canonical orchestration marker file resolved via
    `getCurrentOrchestrationFile()` in `bin/_lib/orchestration-state.js`. The cache
    manifest reader at `bin/_lib/cache-breakpoint-manifest.js:144-149` opens this
    same file and reads `pm_protocol.estimated_orch_duration_minutes` to decide
    Slot 1/Slot 2 TTL.

    **Calibrated heuristic (size × model-tier × parallelism).** The earlier
    `5 × pending_task_count` rule ignored both per-item size and model tier. The
    refined formula matches the §6.T cost multipliers so duration estimates and
    cost estimates use the same shape:

    Per-item base minutes (from the W-item's `Granularity` + scope):

    | Item size | Base minutes | Use when |
    |-----------|-------------:|----------|
    | XS        | 2            | trivial single-line/file edit, doc tweak |
    | S         | 5            | small focused change in 1–2 files |
    | M         | 15           | standard feature in 3–5 files (default) |
    | L         | 30           | cross-cutting change with tests |
    | XL        | 60           | architectural sweep, multi-module refactor |

    Model-tier multiplier (matches the §6.T tier table):

    | Model tier         | Multiplier |
    |--------------------|-----------:|
    | haiku / low        | 0.35       |
    | sonnet / medium    | 1.00       |
    | opus / high        | 2.20       |
    | opus / xhigh, max  | 2.50       |

    Per-item minutes = `base × tier_multiplier`.

    Parallelism roll-up:
    - **Sequential group:** sum of children's per-item minutes.
    - **Parallel group:** max of children's per-item minutes (longest path
      governs wall-clock).
    - **Total:** sum across groups (groups always execute sequentially relative
      to each other — see step 7).

    Clamp the final integer to `[5, 480]`. Floor at 5 prevents division-by-zero
    in the TTL helper; ceiling at 480 is a sanity bound.

    **Fallback (no per-item sizing available).** When item sizes have not been
    annotated (re-plans, dynamic graphs), fall back to the legacy
    `5 × pending_task_count` heuristic with the same `[5, 480]` clamp.

    **Write template (current-orchestration.json).** After computation, merge
    the field into the existing JSON marker without disturbing other keys:

    ```json
    {
      "orchestration_id": "orch-1712345678",
      "pm_protocol": {
        "estimated_orch_duration_minutes": 15,
        "duration_estimate_method": "calibrated"
      }
    }
    ```

    `duration_estimate_method` is `"calibrated"` for the size×tier path or
    `"fallback"` for the `5 × count` path. The PM SHOULD also write the field
    into the `.orchestray/state/orchestration.md` frontmatter as a human-readable
    mirror, but the JSON marker is authoritative — that is the file the cache
    manifest reader actually opens.

    **Audit event.** Immediately after the write, append a
    `pm_orch_duration_estimated` event to `.orchestray/audit/events.jsonl`
    (schema in `agents/pm-reference/event-schemas.md`). The event records the
    estimate, item count, parallel-group count, longest-path minutes, and the
    method (`calibrated` | `fallback`) so analytics can compare predicted vs
    actual duration over time.

    **Why this matters.** This single field powers the cache-breakpoint
    manifest's TTL auto-downgrade: orchestrations expected to finish in under
    25 minutes get Slot 1/Slot 2 written with TTL `5m` instead of `1h`,
    eliminating the 1h-write tax on short orchestrations. Fall-through: if the
    field is missing or non-numeric, the helper assumes "long orch" and uses
    1h TTL — safe but suboptimal. The whole purpose of step 10 is to keep the
    refined cache TTL rule (which has shipped since v2.2.0) from being dormant.

### Task Graph Format

Write a task graph as a markdown document with YAML frontmatter. Store it as
`.orchestray/state/task-graph.md` alongside the individual task files.

**YAML frontmatter fields:**
- `orchestration_id`: `orch-{timestamp}` (e.g., `orch-1712345678`)
- `task`: User's original task description
- `total_tasks`: Number of subtasks (N)
- `parallel_groups`: Array of group objects, each with:
  - `group`: Group number (1, 2, 3, ...)
  - `tasks`: Array of task IDs in this group

**Markdown body:** One H2 section per task with these bullet fields:

```
## Task 1: {title}

- **Agent:** architect | developer | refactorer | inventor | reviewer | debugger | tester | documenter | security-engineer | release-manager | ux-critic | platform-oracle
- **Depends on:** task IDs (e.g., "Task 1, Task 2") or "none"
- **Parallel group:** group number
- **Files (read):** list of file paths this task reads for context
- **Files (write):** list of file paths this task creates or modifies (exclusive)
- **Granularity:** file-level | feature-level
- **Description:** What to do -- specific, actionable, self-contained
```

> **Cross-phase reference (W8 dogfood traversal target).** This Task Graph Format
> is the canonical task-numbering convention referenced from
> `(see phase-verify.md §"16. Adaptive Re-Planning Protocol")` step 4.
> A re-plan that produces a new task graph reads back to this section.

### Dependency Analysis

For each subtask pair, determine the relationship:

- **Sequential**: Task B reads or modifies files that Task A writes -> B depends on A
- **Parallel**: Tasks touch completely disjoint files and have no data dependency ->
  same parallel group
- **Design-Implementation**: Architecture/design task always precedes implementation
  of that architecture
- **Implementation-Review**: Review always follows implementation of the code being reviewed

### Validation Rules

Before finalizing the task graph, verify all of these:

1. **Root reachability**: Every task must have at least one root (no dependencies) ancestor.
   If a task has no path back to a root, the graph is malformed.
2. **No circular dependencies**: A -> B -> C -> A is forbidden. Walk the dependency
   graph and verify no cycles exist.
3. **Exclusive file ownership**: No file appears in "Files (write)" of two different tasks.
   If a conflict is detected, either merge the conflicting tasks or make one depend on
   the other so they write sequentially.
4. **Reasonable task count**: 2-6 subtasks. If decomposition produces more than 6, the
   original task is too broad -- ask the user to narrow scope instead.

### Anti-Patterns

- Do NOT decompose tasks with score < 4. The overhead exceeds the benefit.
- Do NOT create more than 6 subtasks. If you need more, the original task is too
  broad -- ask the user to narrow scope.
- Do NOT assign the same writable file to multiple subtasks. This causes merge
  conflicts and unclear ownership.
- Do NOT create subtasks that are too small (single-line changes). Combine related
  small changes into a single subtask.

### Re-Planning Entry Point

When invoked from `(see phase-verify.md §"16. Adaptive Re-Planning Protocol")`,
the decomposition steps are identical but with additional context:

1. The original task graph is available in `.orchestray/state/task-graph.md`.
2. Completed task results are available in `.orchestray/state/tasks/*.md`.
3. Some completed tasks may be marked as `invalidated` -- their work should be redone.
4. The re-plan reason provides context about what changed.

Use all of this to produce a revised task graph that accounts for the new information.
Preserve completed work that is still valid, re-assign invalidated work, and add new
tasks as needed. The revised graph replaces the original in `.orchestray/state/task-graph.md`.

### 13.X: Contract Generation

After producing the task graph (step 9 above), generate 2-4 machine-verifiable contracts
for EACH subtask. Contracts replace trust-based acceptance with deterministic checks that
the PM runs after agent completion (Section 4.X in pm.md).

**Skip condition:** If `contract_strictness` in `.orchestray/config.json` is `"none"`,
skip contract generation entirely. Contracts are still useful documentation even at
`"standard"` level, so generate them unless explicitly disabled.

**Contract types (progressive strictness):**

| Type | Check Method | Strictness Level | Example |
|------|-------------|-----------------|---------|
| `file_exists(path)` | Glob for path | standard | `file_exists("src/api/tasks.ts")` |
| `file_contains(path, pattern)` | Grep pattern in file | strict | `file_contains("src/api/tasks.ts", "export.*createTask")` |
| `diff_only_in(files[])` | `git diff --name-only` scope check | standard | `diff_only_in(["src/api/tasks.ts", "src/models/task.ts"])` |
| `file_exports(path, name)` | Grep for export statement | strict | `file_exports("src/api/tasks.ts", "createTask")` |
| `command_exits_zero(index)` | Run pre-approved command by index, check exit 0 | strict | `command_exits_zero(4)` |

**Pre-approved command index (the ONLY commands allowed for `command_exits_zero`):**
| Index | Command | Use When |
|-------|---------|----------|
| 1 | `npm test` | Node.js projects with test suite |
| 2 | `npm run build` | Node.js projects with build step |
| 3 | `npm run lint` | Node.js projects with linter |
| 4 | `npx tsc --noEmit` | TypeScript projects |
| 5 | `go build ./...` | Go projects |
| 6 | `python -m py_compile` | Python projects |

NEVER pass a raw command string. ONLY use the index number (1-6). If the project needs
a command not in this list, use `file_contains` or `file_exports` instead.

**Generation rules:**

1. **Every subtask MUST have** at least one `file_exists` contract for each file in its
   "Files (write)" list. This is the minimum viable contract -- it verifies the agent
   actually created or modified the assigned files.

2. **Every subtask MUST have** one `diff_only_in` contract listing its "Files (write)"
   set. This verifies the agent did not modify files outside its ownership boundary.

3. **For implementation tasks** (developer, refactorer, inventor): Add `file_contains`
   or `file_exports` contracts for key deliverables. Example: if the task is "create a
   REST endpoint," add `file_exports("src/api/tasks.ts", "tasksRouter")`.

4. **For strict mode only**: Add `command_exits_zero` contracts for build/lint commands
   when the project has them configured. Use ONLY index numbers 1-6 from the pre-approved
   command table above. NEVER embed a raw command string -- always reference by index.

5. **Cap at 4 contracts per subtask.** More than 4 indicates the subtask is too broad --
   consider splitting it. Prioritize: `file_exists` > `diff_only_in` > `file_contains` >
   `file_exports` > `command_exits_zero`.

**Writing contracts to task files:**

Append a `## Contracts` section to each task file in `.orchestray/state/tasks/{NN}-{slug}.md`:

```markdown
## Contracts

- `file_exists("src/api/tasks.ts")`
- `file_exists("src/models/task.ts")`
- `diff_only_in(["src/api/tasks.ts", "src/models/task.ts"])`
- `file_exports("src/api/tasks.ts", "tasksRouter")`
```

**Pre-conditions (for dependent tasks):**

For tasks that depend on prior tasks (non-root tasks), also generate pre-conditions in
a `## Pre-Conditions` section. Pre-conditions are checked BEFORE spawning the agent
(see `(see phase-execute.md §"14.X: Pre-Condition Validation")`). They verify that
required inputs from prior tasks exist:

```markdown
## Pre-Conditions

- `file_exists("src/api/schema.ts")` -- architect's design output
- `file_contains("src/api/schema.ts", "TaskSchema")` -- required interface
```

Pre-conditions use the same contract types but are checked before execution, not after.

---

## 22b. Pattern Application (Pre-Decomposition)

Run BEFORE Section 13. **Retrieval:** call `mcp__orchestray__pattern_find` with the
current task summary, the `agent_role` of the primary specialist the task will spawn,
a best-effort `file_globs` guess of the files the task will touch, `max_results: 5`,
and `min_confidence: 0.5`. Inject the returned pattern URIs into the decomposition
prompt as `@orchestray:pattern://<slug>` attachments. Patterns are **ADVISORY** --
read the `match_reasons` field on each result and discard any that look wrong. **Team
patterns:** `pattern_find` reads `.orchestray/patterns/` only; to merge in
`.orchestray/team-patterns/*.md` (see `agents/pm-reference/team-config.md` §33B for merge order),
glob them separately and combine client-side after the MCP call returns. **Application record — MUST call either tool before the first `Agent()` spawn:**

> **Timing:** this MUST happen before the first `Agent()` spawn in the orchestration.

After `pattern_find` returns, the PM MUST call EITHER:
- `mcp__orchestray__pattern_record_application` one or more times (one call per
  pattern that measurably shaped the decomposition), with `slug`, `orchestration_id`,
  and `outcome: "applied"`, OR
- `mcp__orchestray__pattern_record_skip_reason` once per unapplied pattern (when a
  returned pattern did NOT shape the decomposition), with `orchestration_id`,
  `pattern_name` set to the pattern's `slug` from the `pattern_find` result (REQUIRED
  — omitting it produces `pattern_name: null` in the audit event and breaks the
  curator's deprecation formula), a `reason` from
  `all-irrelevant | all-low-confidence | all-stale | other`, and (when
  `reason: "other"`) a mandatory `note` explaining the decision.

Calling neither is a protocol violation. Both paths produce an auditable `mcp_tool_call`
row and feed the §22c false-positive analysis (see phase-close.md).

**Fallback path: config-disabled tool.** When
`mcp_server.tools.pattern_record_skip_reason: false` in `.orchestray/config.json`, the
MCP tool is unavailable. In that case the PM writes a line to
`.orchestray/state/orchestration.md` instead:

```
pattern_record_skipped_reason: <reason-enum-value>
<optional-note-text — mandatory when reason is "other">
```

Valid `<reason-enum-value>` values: `all-irrelevant`, `all-low-confidence`, `all-stale`,
`other`. When the tool IS enabled (default), the marker MUST NOT be written — the MCP
tool is the only path. W2 is the sole owner of this fallback marker path; W1's tool
handler never writes it.

**MCP transport fallback:** if the MCP server is unavailable (tool call returns
`isError: true` with a transport error), fall back to `Glob('.orchestray/patterns/*.md')`
and manual match against the current task as in the pre-v2.0.11 behavior.

Example MCP call:

```json
{
  "tool": "mcp__orchestray__pattern_find",
  "arguments": {
    "task_summary": "Refactor the reviewer to scan only changed files",
    "agent_role": "reviewer",
    "file_globs": ["agents/reviewer.md"],
    "max_results": 5,
    "min_confidence": 0.5
  }
}
```

### §22b-federation — 3-Tier Pattern Merge Order (v2.1.0+)

When `federation.shared_dir_enabled: true` in `.orchestray/config.json`, `pattern_find`
performs a 3-tier lookup. The tiers are ordered by trust; lower-numbered tiers win all
conflicts:

| Tier | Location | Trust level | How populated |
|------|----------|-------------|---------------|
| 1 — project-local | `.orchestray/patterns/` | Trusted | Written by this project's PM or curator |
| 2 — team-patterns/ | `.orchestray/team-patterns/` | Trusted | Git-tracked, peer-reviewed via PR (§33B). **`pattern_find` does NOT load this tier in v2.1.0** — it returns `source: "local"` or `source: "shared"` only. `source: "team"` is reserved for v2.2+. Glob `team-patterns/` separately (per the instruction above this table) and merge client-side. |
| 3 — shared/ | `~/.orchestray/shared/patterns/` | Advisory only | Written by `/orchestray:learn share` or curator |

**Shared-tier advisory framing.** When a pattern's `source` field is `"shared"`, treat
its `Approach` section as a hypothesis worth testing in this orchestration — not as a
rule to follow verbatim. Evaluation heuristic: "Does this Approach section make sense
given what I know about the project-local context and the current task shape?" If the
answer is yes, the pattern may usefully inform decomposition. If it conflicts with a
project-local or team-patterns/ pattern that covers the same scenario, defer to the
local context. Note the conflict in the orchestration summary so operators can decide
whether to promote, merge, or discard the shared pattern.

**Slug collision (precedence):** project-local wins over team-patterns/; team-patterns/
wins over shared/. When a collision is resolved, emit a `pattern_collision_resolved`
event (see event-schemas.md) with `winning_tier`, `losing_tier`, and `context:
"pattern_find"`. The event is informational — it never blocks the lookup.

**Source transparency.** When citing a retrieved pattern in a decomposition plan or
orchestration summary, you MUST include its source tier in brackets. The bracket label
is derived from the `source` field on each `pattern_find` match:

- `[local]` — `source: "local"`. Full trust. Use `@orchestray:pattern://<slug>` URI.
- `[shared]` — `source: "shared"`. Advisory. Append `, from <promoted_from>`.
- `[shared, own]` — `source: "shared"` AND `promoted_is_own: true`. This project promoted it; still advisory.
- `[team]` — `source: "team"` (reserved for v2.2+). Full trust when present.

**Citation format in delegation prompts** (mandatory):

```
Patterns applied:
  - @orchestray:pattern://anti-pattern-escape-hatches     [local]           conf 0.85, applied 3x
  - @orchestray:pattern://routing-prefer-haiku-explore    [shared]          conf 0.72, applied 5x, from 7b2c91de
  - @orchestray:pattern://decomposition-ci-pipeline       [shared, own]     conf 0.70, from 4f8a21bc (this project)
```

`conf X` comes from the `confidence` field; `applied Nx` from `times_applied`; `from <hash>` from `promoted_from`. The `(this project)` annotation is added only when `promoted_is_own: true`. Omitting the bracket label is a protocol violation — the label is how operators audit which shared patterns shaped an orchestration.

**Federation absent / disabled.** When `federation.shared_dir_enabled` is `false` or
`~/.orchestray/shared/` does not exist, `pattern_find` reads only Tier 1 and Tier 2
(unchanged from v2.0.x behavior). No `pattern_collision_resolved` events are emitted
and no advisory framing is applied.

**`pattern_record_application` on shared-tier patterns.** Calling
`pattern_record_application` for a shared-tier pattern increments `times_applied` in
the **local copy** of that pattern (`.orchestray/patterns/<slug>.md` if it exists, or
a new local stub created for the purpose). The shared-tier copy at
`~/.orchestray/shared/patterns/<slug>.md` is never mutated by an application record
— shared patterns are read-only from the PM's perspective. B8 (curator) handles
shared-tier write operations.

### §22b.R — Re-entry on MCP checkpoint block

If a subsequent `Agent()` spawn is blocked by `gate-agent-spawn.js` with a
diagnostic naming a missing MCP tool (e.g., `missing MCP checkpoint for
pattern_find`, `missing MCP checkpoint for kb_search`, or `missing MCP
checkpoint for history_find_similar_tasks`), **do not retry the spawn
blindly**. The block is a signal that one of the three pre-decomposition
retrieval calls (`pattern_find`, `kb_search`, `history_find_similar_tasks`)
was skipped for the current `orchestration_id`. **Re-run §22b from the top**
— specifically, call the missing MCP tool(s) named in the diagnostic — then
re-attempt the spawn. The checkpoint ledger at
`.orchestray/state/mcp-checkpoint.jsonl` is append-only, so re-running §22b
adds fresh rows without wiping prior entries. The PM's prior
`pattern_find`/`kb_search`/`history_find_similar_tasks` results for this
`orchestration_id` (if any) remain valid — §22b.R is about filling in the
missing call, not redoing the entire retrieval.

**Cross-reference:** the `mcp_checkpoint_missing` event (documented in
`agents/pm-reference/event-schemas.md`, added in 2.0.12) is the audit-trail
record of a block. Its `missing_tools` field names the specific retrieval
call(s) to re-run. If the diagnostic text is ambiguous, read the most recent
`mcp_checkpoint_missing` event for the current `orchestration_id` in
`.orchestray/audit/events.jsonl` and use its `missing_tools` array as the
authoritative list.

**Why this re-entry path exists:** DESIGN §Risks R2 (2.0.12) identifies the
failure mode this mitigates — without an explicit re-entry instruction, a PM
that does not understand the block will loop on retrying the spawn, burning
turns and tokens without ever unblocking. The diagnostic from
`gate-agent-spawn.js` names §22b as the re-run point; this subsection names
the exact action.

**Session-reload property:** the checkpoint ledger is a file, not in-memory
state. After a session reload (CLAUDE.md "Troubleshooting"), the PM re-reads
`.orchestray/state/mcp-checkpoint.jsonl` directly — no session restart or
reload is required for `gate-agent-spawn.js` to pick up the fresh rows
written by §22b.R (DESIGN §D6 rule 6).

---

## 29. Playbook Loading Protocol

User-authored playbooks provide project-specific instructions that augment agent delegation prompts.

### Playbook Location
- Directory: `.orchestray/playbooks/`
- Format: Markdown files with structured sections

### Playbook Schema
```markdown
# Playbook: <name>

## When
<one or more trigger conditions -- glob patterns, keywords, or descriptions>
Examples:
- Files matching `**/*.proto`
- Tasks mentioning "database" or "migration"
- Any task touching the `src/api/` directory

## Instructions
<specific rules and commands for agents to follow>

## Applies To
<comma-separated agent names: developer, tester, architect, reviewer, etc.>
If omitted, applies to all agents.
```

### Loading During Task Decomposition (Section 13)
1. At the START of task decomposition, glob `.orchestray/playbooks/*.md`
2. For each playbook file, read the `## When` section
3. Match against:
   - Task description keywords (case-insensitive substring match)
   - Affected file patterns (glob match against files identified in decomposition)
4. Collect all matching playbooks
5. For each matching playbook, note which agents it `Applies To`

### Injection During Agent Delegation (pm.md §3)
When spawning an agent, check if any matched playbooks apply to that agent type:
1. If yes, append to the delegation prompt:
   ```
   ## Project Playbook: <playbook name>
   <Instructions section content>
   ```
2. If multiple playbooks match, include all of them, each with its own heading
3. Maximum 3 playbooks per agent delegation (to limit context usage). If more than 3 match, prioritize by specificity: playbooks with glob patterns first, then keyword triggers, then broad descriptions.
4. Per-playbook instruction limit: truncate each playbook's Instructions to 500 words. If truncated, append "[truncated -- full playbook at .orchestray/playbooks/<name>.md]"

### Playbook Validation
- Ignore playbook files that lack a `## When` or `## Instructions` section
- Warn (but do not fail) if a playbook references an unknown agent type in `Applies To`
- Playbook names should be kebab-case (e.g., `proto-changes`, `api-conventions`)

---
