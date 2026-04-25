<!-- PM Reference: Phase contract — ALWAYS loaded when phase-slice loading is enabled.
     Contains shared/foundational protocols referenced by every phase slice
     (decomp, execute, verify, close). Per W4 P-PHASE-SPLIT-RECONCILE Pass 3
     promotion: anchors with in-degree >= 2 across distinct phases live here. -->

# Phase Contract: Shared Orchestration Foundations

This file is loaded on every PM turn when `phase_slice_loading.enabled` is true
(default). It contains the orchestration foundations that decomp / execute / verify /
close all depend on: state persistence layout, the knowledge-base protocol, and the
context-handoff protocol. The active phase slice is loaded alongside this file via
`bin/inject-active-phase-slice.js`.

If `phase_slice_loading.enabled` is `false`, the legacy monolith
`tier1-orchestration.md.legacy` loads via the dispatch table's branch (b) instead.

---

## Cross-phase pointer convention (W8)

Phase slices reference each other in canonical form: `(see phase-X.md §"<heading>")`
where `X ∈ {contract, decomp, execute, verify, close}`. This contract file is
referenced as `phase-contract.md`. When a slice needs detail beyond the cited
heading, the PM may also invoke `Read` with the full path.

Allowed pointer forms (validated by `bin/_tools/phase-split-validate-refs.js`):

- `(see phase-contract.md §"<heading>")` — references this file
- `(see phase-decomp.md §"<heading>")` — pre-spawn / decomposition phase
- `(see phase-execute.md §"<heading>")` — spawning / parallel run phase
- `(see phase-verify.md §"<heading>")` — review / verify-fix / re-plan phase
- `(see phase-close.md §"<heading>")` — orchestration completion / pattern extraction

---

## 7. State Persistence Protocol

When orchestrating (not for simple solo tasks), persist state continuously to
`.orchestray/state/`. This directory-tree format uses separate files per task and agent,
making it merge-friendly for parallel agents and human-readable for debugging.

### State Directory Structure

```
.orchestray/state/
├── orchestration.md           # Current orchestration metadata (YAML frontmatter + markdown body)
├── tasks/                     # One file per decomposed task
│   ├── 01-{slug}.md           # Task 1 with status, assignment, result
│   ├── 02-{slug}.md           # Task 2
│   └── ...
└── agents/                    # One file per agent run
    ├── {agent}-run-{n}.md     # e.g., architect-run-1.md, developer-run-1.md
    └── ...
```

- **orchestration.md**: Single source of truth for overall orchestration progress
- **tasks/**: One file per decomposed task with YAML frontmatter for status, assignment, dependencies
- **agents/**: One file per agent invocation with run metadata and result summary

### Orchestration Metadata Format

The file `.orchestray/state/orchestration.md` uses YAML frontmatter for machine-readable
fields and a markdown body for human-readable progress tracking.

    ```yaml
    ---
    id: orch-1712345678
    task: "User's original task description"
    status: in_progress        # in_progress | completed | failed | interrupted
    started_at: "2026-04-07T10:00:00Z"
    complexity_score: 7        # 1-12 scale
    complexity_level: complex  # simple | medium | complex
    delegation_pattern: sequential  # sequential | parallel | selective
    total_tasks: 4
    completed_tasks: 2
    current_phase: implementation  # assessment | decomposition | delegation | implementation | review | complete
    ---
    ```

Markdown body: `## Progress` checklist and `## Decisions Made` list.

> **Phase-slice routing (W8).** `current_phase` is the field
> `bin/inject-active-phase-slice.js` reads to choose the active slice.
> The mapping is: `assessment | decomposition | delegation` → `phase-decomp.md`;
> `implementation` → `phase-execute.md`; `review` → `phase-verify.md`;
> `complete` → `phase-close.md`. Unrecognized values fall back to contract-only
> with a `phase_slice_fallback` event.

### Task File Format

Each `state/tasks/{NN}-{slug}.md` has YAML frontmatter with: `id`, `title`, `status`
(pending|in_progress|completed|failed), `assigned_to`, `depends_on` (task ID array),
`parallel_group`, `files_owned`, `files_read`, `started_at`, `completed_at`.
Markdown body: `## Assignment` (delegation prompt) and `## Result` (agent output).

### Agent Run File Format

Each `state/agents/{agent}-run-{n}.md` has YAML frontmatter with: `agent`, `task_id`,
`status` (running|completed|failed), `started_at`, `completed_at`.
Markdown body: `## Result` (structured result from the agent).

### Continuous Saving Protocol

State is written on EVERY change, not at wave boundaries. This ensures that if a session
is interrupted at any point, the state directory accurately reflects what completed.

1. **Orchestration start**: Create `.orchestray/state/` directory and write
   `state/orchestration.md` with status `in_progress`, the user's task description,
   complexity assessment results, and delegation pattern.

2. **Task decomposition complete**: Create all `state/tasks/*.md` files with status
   `pending`, task descriptions, dependency annotations, and agent assignments.

3. **Agent spawn**: Create `state/agents/{agent}-run-{n}.md` with status `running`.
   Update the corresponding task file's status to `in_progress` and set `started_at`.

4. **Agent complete**: Update the agent run file with status `completed`, the result
   summary, and `completed_at` timestamp. Update the task file with status `completed`,
   the result summary, and `completed_at`. Update `orchestration.md`: increment
   `completed_tasks`, check off the progress item, advance `current_phase` if appropriate.

5. **Agent failure**: Update the agent run file with status `failed` and failure details.
   Update the task file status to `failed`. Do NOT increment `completed_tasks`.

6. **Orchestration complete**: Update `orchestration.md` status to `completed` and
   `current_phase` to `complete`. Archive the state following the mandatory structure below.
   After confirming the copy is complete, delete the contents of `.orchestray/state/`
   (but keep the directory itself for the next orchestration).

   **Archive Structure (mandatory)**
   When archiving to `.orchestray/history/{timestamp}-orchestration/`:
   1. MUST copy `events.jsonl` from `.orchestray/audit/` (if it exists)
   2. MUST copy `orchestration.md` from `.orchestray/state/`
   3. MUST copy `task-graph.md` from `.orchestray/state/` (if it exists)
   4. MUST copy `tasks/` directory from `.orchestray/state/` (if it exists)
   5. MUST copy `agents/` directory from `.orchestray/state/` (if it exists)
   6. Subdirectories (`tasks/`, `agents/`) are preserved as directories -- "flat" means no `state/` wrapper

7. **Re-plan executed**: Update `orchestration.md` with incremented `replan_count`.
   Update invalidated task files with status `invalidated` and reason. Write new
   `task-graph.md` with the revised task graph. Log re-plan event to audit trail.

### Auto-Detect Resume

When starting ANY orchestration (including via `/orchestray:run`), check for interrupted
work before proceeding:

1. Check if `.orchestray/state/orchestration.md` exists.

2. If it exists AND its frontmatter `status` is `in_progress` or `interrupted`:
   - Read all task files in `.orchestray/state/tasks/` to determine what completed
     and what remains
   - Tell the user: "Found interrupted orchestration: {task}. {completed}/{total} tasks
     completed. Resume? (yes/no)"
   - If **yes**: Continue from the next incomplete task, respecting the task dependency
     graph. Pick the next task whose `status` is `pending` and whose `depends_on` tasks
     are all `completed`.
   - If **no**: Archive the old state to `.orchestray/history/{timestamp}-orchestration/`
     and start fresh.

**Fine-grained resume with checkpoints:**
If `.orchestray/state/checkpoints.json` exists, use the checkpoint Resume Protocol
(in `agents/pm-reference/checkpoints.md` §32) to skip completed agents and resume
from the interruption point. This prevents re-running agents whose results are
already in the codebase.

3. If `.orchestray/state/orchestration.md` does not exist, or its status is `completed`:
   Proceed normally with a new orchestration.

### Backward Compatibility

Also update `.orchestray/current-task.json` as a convenience mirror (derives from
`state/orchestration.md`). The state directory is the **source of truth**.

### State Recovery

If `orchestration.md` is corrupted but task files exist: scan task frontmatter, reconstruct
`orchestration.md` with `status: interrupted`, and log recovery to the user.

---

> *[Rare path: resilience dossier field reference (§7.R). PM loads
> tier1-orchestration-rare.md via Tier-2 dispatch when recovering from a
> resume/replay (evidenced by `.orchestray/state/orchestration.md` status field
> in {paused, redo_pending, replay_active}).]*

---

## 10. Knowledge Base Protocol

When orchestrating, maintain the shared knowledge base in `.orchestray/kb/`. The KB
enables agents to share discoveries across orchestrations without dumping full context
into every agent's prompt. It uses a hybrid format: a JSON index for fast lookups and
markdown files for detailed content.

### KB Directory Structure

```
.orchestray/kb/
├── index.json               # Fast lookup index with TTL metadata
├── facts/                   # Codebase facts discovered by agents
│   └── {slug}.md            # One file per fact/topic
├── decisions/               # Architectural decisions made during orchestration
│   └── {slug}.md
└── artifacts/               # Work products (designs, review notes, plans)
    └── {slug}.md
```

- **facts/**: Codebase structure, file purposes, dependency relationships, API contracts
- **decisions/**: Architectural choices, tradeoff analysis, design rationale
- **artifacts/**: Design documents, review notes, implementation plans

### Writing to KB

Before writing any KB entry, follow this protocol:

1. **Check for duplicates first:** Read `.orchestray/kb/index.json` and search for existing
   entries on the same topic. Use the `topic` and `summary` fields to identify overlaps.
2. **If duplicate found:** Update the existing detail file and set `updated_at` to the
   current timestamp in the index entry. Do NOT create a new entry.
3. **If new entry:** Follow these steps:
   a. Choose a category: `facts`, `decisions`, or `artifacts`
   b. Create a slug from the topic: lowercase, hyphens only, no special characters
      (e.g., "auth-module-structure", "jwt-vs-sessions", "api-design-v2")
   c. Write the detail file to `.orchestray/kb/{category}/{slug}.md`
   d. Keep the detail file under **500 tokens** -- concise and actionable
4. **Update index.json** by adding an entry to the `entries` array with these exact fields:

```json
{
  "id": "{category}-{slug}",
  "category": "fact" | "decision" | "artifact",
  "topic": "Human-readable topic description",
  "source_agent": "agent name that wrote this entry",
  "created_at": "ISO 8601 timestamp",
  "updated_at": "ISO 8601 timestamp",
  "ttl_days": 14,
  "stale": false,
  "file": "{category}/{slug}.md",
  "summary": "One-line description, 50 tokens max"
}
```

5. **TTL defaults by category:**
   - `facts`: 14 days -- codebase facts change moderately
   - `decisions`: 30 days -- architectural decisions are longer-lived
   - `artifacts`: 7 days -- work products become stale quickly

6. **Index version:** The top level of `index.json` must include `"version": 1`.

### Reading from KB

Follow these rules when reading KB entries:

1. **NEVER read the entire KB.** Only read specific named files relevant to the current
   task. Reading all entries defeats the purpose of the KB (context efficiency).
2. **TTL check on every read:** For each entry you read, check if it is expired:
   - Parse `created_at` and add `ttl_days` to get the expiry date
   - If current date > expiry date: set `stale: true` in the index entry
   - Still return the entry, but prefix its content with `[STALE]` in any output
3. **When delegating to agents:** Tell them EXACTLY which KB files to read by full path.
   Do not say "check the KB" -- say "Read `.orchestray/kb/facts/auth-module-structure.md`
   for context on the auth module."

### Instructing Agents to Write KB

When delegating to any subagent, include this instruction in the delegation prompt:

> After completing your task, write your key findings to the knowledge base:
> - Write to `.orchestray/kb/{category}/{slug}.md` (choose: facts, decisions, or artifacts)
> - Update `.orchestray/kb/index.json` adding your entry to the `entries` array
> - Check the index first for existing entries on the same topic -- update instead of duplicating
> - Keep detail files under 500 tokens
> - Include in the detail file: what you found, why it matters, what the next agent should know
>
> **Important:** If the index update fails or is skipped, run `/orchestray:kb reconcile` to rebuild the index.

### KB Initialization

When `.orchestray/kb/` does not exist (first orchestration or fresh project):

1. Create the directory structure:
   - `.orchestray/kb/`
   - `.orchestray/kb/facts/`
   - `.orchestray/kb/decisions/`
   - `.orchestray/kb/artifacts/`
2. Create `.orchestray/kb/index.json` with initial content:
   ```json
   {
     "version": 1,
     "entries": []
   }
   ```
3. Do NOT pre-populate with project facts. Let agents discover and register naturally
   during their work. This avoids stale bootstrapped data.

### What Agents Register

All agents register everything they discover during their work (per the "agents register
everything" principle):

- **Facts**: Codebase structure, file purposes, dependency relationships, API contracts,
  configuration patterns, naming conventions, module boundaries
- **Decisions**: Architectural choices made during design, tradeoff analysis, technology
  selection rationale, rejected alternatives and why
- **Artifacts**: Design documents, review notes, implementation plans, API schemas,
  data models, migration plans

---

## 11. Context Handoff Protocol

When orchestrating sequential agents (e.g., architect -> developer -> reviewer), use the
KB + diff pattern for context handoffs. This replaces the need for separate handoff
documents. Each agent writes discoveries to the KB, and the next agent reads those
specific KB entries plus the git diff of what changed.

### Handoff Flow

The 5-step KB + diff handoff is fully specified in `agents/pm-reference/delegation-templates.md` §"Section 11: KB + Diff Handoff Flow". Do not re-enumerate steps here.

### Anti-Patterns

1. **NEVER dump all KB entries to the next agent.** Only include entries from the previous
   agent's work that are relevant to the next agent's task. Selective injection is the
   entire point of the KB architecture.

2. **NEVER skip the diff.** The git diff shows what actually changed in code versus what
   was planned in the KB entry. Agents need both the "what was decided" (KB) and the
   "what was implemented" (diff) for accurate context.

3. **NEVER create a separate "handoff document."** The KB facts/decisions (tracked under
   `.orchestray/kb/facts/` and `.orchestray/kb/decisions/`) plus the git diff ARE the
   handoff. Writing a separate summary document duplicates information and wastes tokens.
   Note: `.orchestray/kb/artifacts/` files are session-scoped scratch and are distinct —
   see anti-pattern #5 below.

4. **Keep diff output manageable.** If the diff exceeds 200 lines, summarize the key
   changes instead of including the full diff. Group changes by file and describe what
   changed in each, focusing on structural changes over line-by-line detail.

5. **For multi-W orchestrations, the commit body IS the durable inter-W handoff.**
   KB artifacts under `.orchestray/kb/artifacts/` are session-scoped scratch; they
   are gitignored and may be absent when a later W-item reads git history. Each
   W-item must embed its key handoff facts in the commit message body using the
   `## Handoff` subsection format defined in
   `agents/pm-reference/agent-common-protocol.md` §Commit Message Discipline for W-Items.

### 11.Y: Trace Injection for Downstream Agents

When `enable_introspection` is true and delegating to a downstream agent, check for
reasoning traces from upstream tasks in the current orchestration. Traces provide the
downstream agent with upstream reasoning context, eliminating redundant exploration.

**Injection protocol:**

1. **Scan traces directory**: Glob `.orchestray/state/traces/task-*-trace.md` for all
   traces in the current orchestration.

2. **Filter by relevance** — include a trace only if:
   - **File overlap**: The upstream agent's `files_changed` intersects with the downstream
     task's `files_read` or `files_owned` from the task definition, OR
   - **Dependency edge**: The downstream task lists the upstream task in its `depends_on`
     field in the task graph.

3. **Cap at 3 traces** per delegation. If more than 3 match, prefer traces from the
   most recently completed tasks (highest relevance to current state).

4. **Cap total trace content** at ~1,000 words. If 3 traces exceed this, trim the
   least-relevant trace (fewest file overlaps).

5. **Format injection**: Add a `## Upstream Reasoning Context` section to the delegation
   prompt (see `agents/pm-reference/delegation-templates.md` for the exact template).
   Place it AFTER the `## Context from Previous Agent` section (Section 11 handoff)
   and BEFORE any playbook or correction pattern injections.

6. **Skip injection** if no relevant traces exist or `enable_introspection` is false.
   The delegation proceeds normally with standard KB + diff handoff.

**Anti-patterns:**
- NEVER inject all traces. Only relevant traces based on file overlap or dependency edges.
- NEVER inject traces from Haiku agents (they should not have traces — see §4.Y in
  `agents/pm-reference/tier1-orchestration-rare.md`).
- NEVER let trace content exceed ~1,000 words total. Trim rather than bloat context.

---

## Inter-phase pointers (canonical)

These are the documented cross-phase pointers used by the v2.1.15 split.
The W5 F-02 BLOCK gate (`bin/_tools/phase-split-validate-refs.js`) verifies
each one resolves to a real heading.

- Decomposition needs the contract for state/KB/handoff: `(see phase-contract.md §"7. State Persistence Protocol")`, `(see phase-contract.md §"10. Knowledge Base Protocol")`, `(see phase-contract.md §"11. Context Handoff Protocol")`.
- Execution dispatches results back to verify: `(see phase-verify.md §"18. Verify-Fix Loop Protocol")`.
- Verify references decomp's task-numbering convention: `(see phase-decomp.md §"13. Task Decomposition Protocol")` — this is the **dogfood traversal target** for W5 F-02 cross-phase flow.
- Close (post-orchestration) reads patterns applied during decomposition: `(see phase-decomp.md §"22b. Pattern Application (Pre-Decomposition)")`.
- Close needs the cost-tracking initialization that ran in execute: `(see phase-execute.md §"19. Model Routing — Detailed Scoring and Logging")`.

---
