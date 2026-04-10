<!-- PM Reference: Loaded by Section Loading Protocol when orchestrating (complexity score >= threshold) -->

# Tier 1: Orchestration Protocols

These sections are loaded when the PM enters orchestration mode (complexity score >= threshold).
They contain the detailed protocols for state management, task decomposition, parallel execution,
cost tracking, re-planning, dynamic agents, verify-fix loops, pattern extraction, playbooks,
and correction memory.

---

## 4.D: Drift Sentinel — Invariant Extraction from Architect Output

After processing an architect agent result with status `"success"` or `"partial"`
(in Section 4), check whether to extract architectural invariants.

**Trigger conditions:** ALL must be true:
- `enable_drift_sentinel` is true in `.orchestray/config.json`
- The completed agent type is `architect`
- The agent result status is `"success"` or `"partial"`

If any condition is false, skip extraction and proceed to 4.Y.

**Protocol:** See `agents/pm-reference/drift-sentinel.md` Source 1 (Architect Output)
for the full extraction protocol. In summary:
1. Scan the architect's full text output for constraint-like statements (must not, never,
   always, should not, isolated, no direct imports).
2. Extract candidate invariants with text, files_affected, and confidence.
3. Present candidates to the user for confirmation.
4. On confirmation, write each invariant to `.orchestray/kb/decisions/` with
   `enforced: true` and `type: architectural-constraint`.
5. Log `invariant_extracted` event to `.orchestray/audit/events.jsonl`.

---

## 4.Y: Reasoning Trace Distillation

After processing any agent result with status `"success"` or `"partial"` (in Section 4),
check whether to extract a reasoning trace. This step runs AFTER result parsing and
post-condition validation (4.X) but BEFORE proceeding to the next task.

### Trigger Conditions

Run the distiller when ALL of these are true:
- `enable_introspection` is true in `.orchestray/config.json`
- The completed agent was NOT a Haiku-tier agent (distilling Haiku with Haiku is circular)
- The agent result status is `"success"` or `"partial"` (not `"failure"`)

If any condition is false, skip distillation and proceed normally.

### Distillation Protocol

1. **Spawn a Haiku distiller**: Use the Agent tool with `model: haiku` and `effort: low`.
   Pass the distiller prompt template from `agents/pm-reference/introspection.md`,
   replacing `{agent_full_output}` with the complete text output from the agent that
   just completed (both Result Summary and Structured Result).

2. **Write trace file**: Save the distiller's output to:
   `.orchestray/state/traces/task-<id>-trace.md`
   using the trace file format defined in `introspection.md` (YAML frontmatter with
   `task_id`, `source_agent`, `source_model`, `orchestration_id`, followed by the
   5 reasoning sections).

3. **Create traces directory** if it does not exist:
   `.orchestray/state/traces/`

4. **Log audit event**: Append an `introspection_trace` event to
   `.orchestray/audit/events.jsonl` (see event-schemas.md for the full schema).
   Record the source agent, source model, trace file path, sections extracted,
   approximate word count, and estimated distillation cost (~$0.005).

5. **Proceed**: Continue with the next task in the orchestration graph. The trace
   is now available for injection into downstream agent delegations (Section 11.Y).

### Cost Impact

Each distillation costs ~$0.005 (Haiku input: ~10-20K tokens, output: ~500 words).
A typical 4-agent orchestration adds ~$0.02 in distillation overhead (~3%).
This is negligible compared to the savings from eliminating redundant exploration
in downstream agents.

### Display

Include distillation in the per-agent completion line:
```
[done] architect (opus) -- Designed auth module (~$0.08, 12 turns) [contracts: 3/3 pass] [trace extracted]
```

### 3.Z: Confidence Protocol Injection

When `enable_backpressure` is true in `.orchestray/config.json`, append the confidence
checkpoint instructions to EVERY agent delegation prompt during orchestration. This is
done at spawn time, after all other prompt assembly (Section 3 delegation, playbooks,
correction patterns, repo map) but before the final prompt is sent.

**Injection protocol:**

1. **Check config:** Read `enable_backpressure` from `.orchestray/config.json`. If false
   or absent, skip injection entirely.

2. **Create confidence directory:** Ensure `.orchestray/state/confidence/` exists.
   ```bash
   mkdir -p .orchestray/state/confidence
   ```

3. **Append checkpoint instructions** to the delegation prompt. Use the exact template
   block from `agents/pm-reference/delegation-templates.md` (section "Confidence Checkpoint
   Instructions"), replacing `{TASK_ID}` with the subtask's actual ID.

4. **Three checkpoint triggers** the agent will execute:
   - **post-exploration**: After reading files, before writing code/design
   - **post-approach**: After choosing an approach, before committing to it
   - **mid-implementation**: Halfway through estimated work

5. **No additional cost:** The checkpoint instructions add ~200 tokens to the delegation
   prompt. The agent's file writes are negligible. The PM's reads are single small JSON files.

> Read `agents/pm-reference/cognitive-backpressure.md` for the full confidence calibration
> guide, PM reaction table, file format, and synergy with introspection.

---

### 4.Z: Confidence Signal Reading

After processing any agent result (Section 4) and AFTER post-condition validation (4.X)
but BEFORE re-plan signal evaluation, read the agent's confidence signal if backpressure
is enabled.

**Protocol:**

1. **Check config:** If `enable_backpressure` is false or absent, skip this step.

2. **Read confidence file:** Check for `.orchestray/state/confidence/task-{TASK_ID}.json`.
   - If file does not exist: no signal. Proceed normally. This is NOT an error.
   - If file exists but JSON is malformed: log a warning. Treat as no signal.

3. **Override check — confidence vs. self-report discrepancy:**
   - If final confidence < 0.4 AND agent self-reported `"status": "success"`:
     Override status to `"partial"`. Log: "Confidence override: agent reported success
     but confidence is {value}. Overriding to partial."
   - If confidence < 0.2: Treat as failure regardless of agent self-report.
     Log: "Confidence override: agent confidence {value} is critically low. Treating
     as failure."

4. **Log confidence signal** to `.orchestray/audit/events.jsonl` as a `confidence_signal`
   event (see event-schemas.md for schema). Set `pm_reaction` field based on the
   reaction table in cognitive-backpressure.md.

5. **Apply PM reaction** per the reaction table:
   - >= 0.7: proceed
   - 0.5-0.69: inject context if available
   - 0.3-0.49: pause before next group
   - < 0.3: escalate to user

6. **Display:** Include confidence in the per-agent completion line when backpressure
   is active:
   ```
   [done] developer (sonnet) -- Implemented auth module (~$0.06, 8 turns) [contracts: 3/3 pass] [confidence: 0.82]
   [done] developer (sonnet) -- Implemented auth module (~$0.06, 8 turns) [contracts: 2/3 pass] [confidence: 0.45 -- PAUSED]
   ```

---

### 4.V: Visual Review Integration

After a developer completes a subtask (Section 4 result processing), check whether
visual review should be triggered. This step runs AFTER confidence signal reading (4.Z)
and BEFORE proceeding to the standard reviewer delegation.

**Trigger conditions** -- ALL must be true:
1. `enable_visual_review` is true in `.orchestray/config.json`
2. The completed agent was a **developer** (not architect, reviewer, etc.)
3. At least one file in the developer's `files_changed` matches a UI file pattern:
   `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.css`, `*.scss`, `*.less`, `*.html`,
   `*.erb`, `*.ejs`, `*.module.css`

If any condition is false, skip visual review and proceed with normal reviewer delegation.

**Protocol when triggered:**

1. **Load visual review reference**: Read `agents/pm-reference/visual-review.md` for the
   full screenshot discovery protocol.

2. **Discover screenshots**: Follow the 4-step discovery protocol in visual-review.md
   (user paths -> convention directory -> project artifacts -> fallback).

3. **If screenshots found**: Include them in the reviewer delegation prompt using the
   screenshot injection template from delegation-templates.md. The reviewer receives
   both the standard code diff AND the screenshot paths for multi-modal review.

4. **If no screenshots found**: Add a note to the reviewer delegation:
   `"Visual review was requested (enable_visual_review is true and UI files were changed)
   but no screenshots were found. Proceeding with text-only code review."`
   Continue with standard reviewer delegation.

5. **Log audit event**: Append a `visual_review` event to `.orchestray/audit/events.jsonl`
   (see event-schemas.md for schema). Record screenshot count, sources, and whether
   fallback to text-only occurred.

6. **UI file count**: Record `ui_files_changed` as the count of files from `files_changed`
   that matched the UI file patterns. Include in the audit event.

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
If `.orchestray/state/checkpoints.json` exists, use Section 32's Resume Protocol
(in agent-checkpointing.md) to skip completed agents and resume from the interruption
point. This prevents re-running agents whose results are already in the codebase.

3. If `.orchestray/state/orchestration.md` does not exist, or its status is `completed`:
   Proceed normally with a new orchestration.

### Backward Compatibility

Also update `.orchestray/current-task.json` as a convenience mirror (derives from
`state/orchestration.md`). The state directory is the **source of truth**.

### State Recovery

If `orchestration.md` is corrupted but task files exist: scan task frontmatter, reconstruct
`orchestration.md` with `status: interrupted`, and log recovery to the user.

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

The handoff uses a 5-step KB + diff pattern:
1. PM spawns Agent A with KB write instruction
2. Agent A writes findings to KB
3. PM prepares Agent B's prompt with relevant KB entries + git diff
4. Agent B reads KB entries and diff, proceeds with its task
5. Agent B writes its own discoveries to KB for the next agent

> Read `agents/pm-reference/delegation-templates.md` for the detailed handoff flow, delegation template with field reference, and example prompts.

### Anti-Patterns

1. **NEVER dump all KB entries to the next agent.** Only include entries from the previous
   agent's work that are relevant to the next agent's task. Selective injection is the
   entire point of the KB architecture.

2. **NEVER skip the diff.** The git diff shows what actually changed in code versus what
   was planned in the KB entry. Agents need both the "what was decided" (KB) and the
   "what was implemented" (diff) for accurate context.

3. **NEVER create a separate "handoff document."** The KB entries + git diff IS the handoff.
   Writing a separate summary document duplicates information and wastes tokens.

4. **Keep diff output manageable.** If the diff exceeds 200 lines, summarize the key
   changes instead of including the full diff. Group changes by file and describe what
   changed in each, focusing on structural changes over line-by-line detail.

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
   prompt (see delegation-templates.md for the exact template). Place it AFTER the
   `## Context from Previous Agent` section (Section 11 handoff) and BEFORE any
   playbook or correction pattern injections.

6. **Skip injection** if no relevant traces exist or `enable_introspection` is false.
   The delegation proceeds normally with standard KB + diff handoff.

**Anti-patterns:**
- NEVER inject all traces. Only relevant traces based on file overlap or dependency edges.
- NEVER inject traces from Haiku agents (they should not have traces — see Section 4.Y).
- NEVER let trace content exceed ~1,000 words total. Trim rather than bloat context.

---

## 13. Task Decomposition Protocol

When complexity score >= 4 (medium or complex), decompose the task into a structured
subtask graph before delegating. This ensures clear ownership, dependency tracking,
and parallel execution where possible.

### When to Decompose

Decompose when complexity score >= 4 (medium or complex). Simple tasks (score < 4)
are handled solo without decomposition. The overhead of decomposition exceeds its
benefit for simple tasks.

### Decomposition Steps

**Pre-check:** Before decomposing, apply Section 22b pattern check. Any relevant patterns
from past orchestrations will inform the decomposition strategy below.

**Workflow override:** Before step 1, check Section 35 (Custom YAML Workflow Definitions,
in yaml-workflows.md). If a workflow is matched (via `--workflow` flag or auto-match),
use the workflow-derived task graph instead of the decomposition steps below -- skip
directly to Section 14.
If a workflow is matched, Section 38 (adversarial review, in adversarial-review.md) does not apply.

**Adversarial architecture:** If NO workflow was matched, complexity score >= 8, and
`adversarial_review` is true, apply Section 38 (Adversarial Architecture Review, in
adversarial-review.md) -- replace the single architect step with a dual-architect evaluation.

1. **Load playbooks**: If `.orchestray/playbooks/` exists, load matching playbooks per Section 29.
   Matched playbooks will be injected into agent delegation prompts in Section 3.

1b. **Classify task archetype**: Read `agents/pm-reference/pipeline-templates.md` to match
   the task against a standard workflow archetype (Bug Fix, New Feature, Refactor, Test
   Improvement, Documentation, Migration, Security Audit). Use the archetype's template
   as the starting decomposition strategy. Log: "Archetype: {name}".
   
   **TDD mode**: If `.orchestray/config.json` has `tdd_mode: true` AND archetype is
   "New Feature", use the TDD variant: architect -> tester -> developer -> reviewer.
   The tester writes tests from the architect's spec BEFORE the developer implements.

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

- **Agent:** architect | developer | refactorer | inventor | reviewer | debugger | tester | documenter | security-engineer
- **Depends on:** task IDs (e.g., "Task 1, Task 2") or "none"
- **Parallel group:** group number
- **Files (read):** list of file paths this task reads for context
- **Files (write):** list of file paths this task creates or modifies (exclusive)
- **Granularity:** file-level | feature-level
- **Description:** What to do -- specific, actionable, self-contained
```

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

When invoked from Section 16 (re-planning), the decomposition steps are identical but
with additional context:

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
(see Section 14.X). They verify that required inputs from prior tasks exist:

```markdown
## Pre-Conditions

- `file_exists("src/api/schema.ts")` -- architect's design output
- `file_contains("src/api/schema.ts", "TaskSchema")` -- required interface
```

Pre-conditions use the same contract types but are checked before execution, not after.

---

## 14. Parallel Execution Protocol

When task decomposition (Section 13) identifies parallel groups -- multiple tasks in
the same group with no inter-dependencies -- use this protocol to execute them
concurrently with worktree isolation.

### When to Use

Use this protocol when the task graph from Section 13 contains a parallel group with
2+ tasks. If a group has only one task, execute it directly using Section 2 delegation
patterns. Single-task groups do not need worktree isolation.

### Spawning Parallel Agents

For each task in a parallel group:

1. **Spawn the assigned agent** with the task description (per Section 3 delegation rules).
   Each agent runs with worktree isolation -- the `isolation: worktree` frontmatter field
   on each specialist agent handles this automatically.
   Write a `running` checkpoint for this task per Section 32 (in agent-checkpointing.md).
   After the agent completes and results are processed (Section 4), update the checkpoint
   to `completed`.

2. **Dual isolation layers:**
   - **Layer 1 (file ownership):** Already assigned in Section 13 decomposition. Each task
     has exclusive "Files (write)" ownership. This prevents logical conflicts.
   - **Layer 2 (worktree isolation):** Each agent's changes are on a separate git branch
     in a separate worktree. This prevents physical file conflicts even if an agent
     accidentally touches files outside its ownership.

3. **Worktree branch naming:** Each agent's worktree branch follows this pattern:
   `orchestray/<orch-id>/task-<N>` (e.g., `orchestray/orch-1712345678/task-3`).
   The `<orch-id>` comes from the orchestration metadata in `.orchestray/state/orchestration.md`.

4. **Spawn all agents in the group**, then wait for all to complete. Do NOT spawn agents
   from the next group until the current group is fully merged.

### 14.X: Pre-Condition Validation

Before spawning each agent in a parallel group (or sequential task), validate the
task's pre-conditions. Pre-conditions are generated during Section 13.X (Contract
Generation) and written to the task file's `## Pre-Conditions` section.

**Skip condition:** If `contract_strictness` is `"none"`, skip pre-condition validation.
Root tasks (Group 1, no dependencies) have no pre-conditions -- skip this step for them.

**Validation protocol:**

1. **Read pre-conditions**: Open `.orchestray/state/tasks/{NN}-{slug}.md` and read the
   `## Pre-Conditions` section. If the section is empty or missing, proceed to spawn.

2. **Run each check**: Use the same check methods as post-condition validation
   (Section 4.X in pm.md): Glob for `file_exists`, Grep for `file_contains`, etc.

3. **Act on results:**
   - **All pass**: Proceed to spawn the agent normally.
   - **Any fail**: Do NOT spawn the agent. This means a dependency was not met --
     a prior task either failed or did not produce the expected output.
     - Check the dependency task's status in `.orchestray/state/tasks/`.
     - If the dependency task succeeded but its output is missing, this indicates a
       contract gap -- the dependency's post-conditions were too loose. Log a warning
       and attempt to spawn anyway (the agent may still succeed).
     - If the dependency task failed or was skipped, mark this task as
       `status: skipped` with `skip_reason: "pre-condition failed: {check details}"`.

4. **Log results**: Write a `contract_check` event to `.orchestray/audit/events.jsonl`
   with phase `"pre"` and the check results (see event-schemas.md).

### Sequential Merge After Completion

After ALL agents in the parallel group have completed, merge their changes one at a time
in task order (Task 1 before Task 2, etc.). Sequential merge prevents compound conflicts.

For each completed agent's worktree (in task order):

1. **Review the diff:** Run `git diff main...<worktree-branch>` to see what the agent changed.

2. **Verify file ownership:** Check that changes are ONLY in files assigned to that task
   (from the task graph "Files (write)" field in `.orchestray/state/task-graph.md`).

3. **If ownership violated:** Log the violation to `.orchestray/audit/events.jsonl` as a
   `file_ownership_violation` event with these JSON fields:
   - `timestamp`: ISO 8601 timestamp
   - `type`: `"file_ownership_violation"`
   - `orchestration_id`: current orchestration ID
   - `task_id`: the violating task's ID
   - `agent_type`: the agent type (architect, developer, reviewer)
   - `file`: the file that was modified outside ownership
   - `assigned_files`: array of files that were assigned to this task

   Continue with the merge but warn the user about the violation.

4. **Merge:** Run `git merge <worktree-branch>` into the current branch.

5. **If merge conflict:** Attempt automatic resolution. If unresolvable, keep the
   first-merged version (the version already on the current branch) and log the conflict
   details to `.orchestray/audit/events.jsonl`. If the conflict renders the task's work
   unusable, re-run that task sequentially after the merge phase completes.

6. **Clean up:** Run `git worktree remove <path>` after successful merge. This removes
   the worktree directory and its association. The branch can be deleted with
   `git branch -d <worktree-branch>` after merge.

After all worktrees are merged:
- Run tests/lint if applicable to verify the combined changes work together.
- Update state: mark the parallel group as complete in `.orchestray/state/task-graph.md`.

### Waiting Behavior

Show incremental progress per the Section 8 Communication Protocol:
- Before group: announce all agents and tasks
- After each agent: `[done] {agent} -- {one-line result} (~${cost}, {turns} turns)`
- After group: running total and next group preview
Do NOT spawn additional work or process new user prompts during the parallel wait.

### Error Handling

- **Agent fails:** Log to audit, continue waiting for group. Offer retry/skip/abort after group finishes.
- **Merge fails:** Keep first-merged version, re-execute conflicting task sequentially if critical.
- **Worktree cleanup fails:** Log but do not block. Clean up with `git worktree prune`.

### Integration with Task Graph Execution Flow

After Section 13 produces the task graph, execution proceeds group by group:

1. **Group 1 (roots):** Execute all tasks in the group via this parallel protocol.
2. **Collect results:** Merge all worktrees, update state, perform context handoffs
   (Section 11) to prepare context for the next group's agents.
2.5. **Checkpoint (if active):** If checkpoints are enabled (Section 27, in checkpoints.md),
   present checkpoint to user before proceeding to next group. Wait for user response.
3. **Group 2:** Execute via this parallel protocol, using context from Group 1 results.
4. **Continue** until all groups complete.
5. **Final validation:** After the last group merges, run any applicable tests or
   validation to confirm the combined changes work together.
6. **Complete audit trail:** Write orchestration_complete event and archive audit data
   (Section 15, step 3).

### 14.Y: Mid-task Ambiguity Handling via `ask_user`

When you write delegation prompts for specialists, include this verbatim:
"If you hit an ambiguity only the user can resolve (two valid interpretations,
missing context, confirmation before a destructive action), call
`mcp__orchestray__ask_user` with a ≤5-field form before returning
`status: partial`. Budget: at most 2 questions per task. A `cancelled: true`
or `timedOut: true` result means fall back to `status: partial`."

### 14.Z: Inter-Group Confidence Check

When `enable_backpressure` is true, perform a confidence check between group transitions
(after step 2 "Collect results" and before step 3 "Group 2"). This prevents low-confidence
work from cascading into downstream groups.

**Protocol:**

1. **Read all confidence files** for tasks completed in the just-finished group:
   Glob `.orchestray/state/confidence/task-{ID}.json` for each task ID in the group.

2. **Evaluate each signal** against the PM reaction table (cognitive-backpressure.md):

3. **If ANY confidence < 0.4 in the completed group:**
   - **PAUSE** before spawning the next group.
   - Log: "Inter-group confidence check: task-{id} reported confidence {value}. Pausing
     before Group {N+1}."
   - Evaluate options per the reaction table:
     a. **Re-route**: Re-execute the low-confidence task with enriched context from KB
        and/or higher model tier (Section 19.Z escalation).
     b. **Split**: Break the downstream tasks that depend on the low-confidence result
        into smaller pieces to reduce risk propagation.
     c. **Accept and continue**: If the PM judges the low confidence is in an area that
        does not affect downstream tasks, proceed with a logged justification.
   - If multiple tasks have low confidence, address each before proceeding.

4. **If all confidences >= 0.4:** Proceed to the next group normally.

5. **If no confidence files exist** for any task in the group: Proceed normally. Absence
   of signal is not a blocker.

6. **Display** confidence summary between groups:
   ```
   Group 1 complete (3/3 tasks). Confidence: task-1: 0.85, task-2: 0.72, task-3: 0.91
   Proceeding to Group 2...
   ```
   ```
   Group 1 complete (3/3 tasks). Confidence: task-1: 0.85, task-2: 0.38 [LOW], task-3: 0.91
   Pausing: task-2 confidence below threshold. Evaluating before Group 2...
   ```

**Integration with checkpoints (Section 27):** If both `enable_checkpoints` and
`enable_backpressure` are true, the confidence check runs BEFORE the user checkpoint
(step 2.5). Low confidence may resolve the checkpoint automatically (PM re-routes
before asking the user).

---

## 15. Cost Tracking — Detailed Audit Protocols

This section contains the detailed audit initialization and completion event protocols.
For the running cost display and summary reporting, see Section 15 in the main pm.md.

### Step 1: Audit Initialization (Before Spawning Any Agents)

Run this ONCE at orchestration start, before Section 13 decomposition and before any
agent is spawned. This ensures hook handlers can correlate events to this orchestration.

1. **Generate orchestration_id:** Use the format `orch-{unix-timestamp}`
   (e.g., `orch-1712345678`). This is the correlation key for all events in this
   orchestration.

2. **Create audit directory:** Ensure `.orchestray/audit/` exists.
   ```bash
   mkdir -p .orchestray/audit
   ```

3. **Write current-orchestration.json:** This file is read by hook handlers
   (SubagentStart, SubagentStop) to tag events with the orchestration_id.
   ```json
   {
     "orchestration_id": "orch-1712345678",
     "task": "<user task summary -- first 100 chars>",
     "started_at": "<ISO 8601 timestamp>"
   }
   ```

4. **Append orchestration_start event** to `.orchestray/audit/events.jsonl`:
   ```json
   {
     "timestamp": "<ISO 8601>",
     "type": "orchestration_start",
     "orchestration_id": "orch-1712345678",
     "task": "<user task summary>",
     "complexity_score": 7,
     "complexity_level": "medium"
   }
   ```

This MUST complete before any agent is spawned so hook handlers can read the
orchestration_id from `current-orchestration.json`.

### Step 3: Orchestration Completion Event

Run this ONCE after all agents have completed and all merges are done (end of
Section 14 flow or after all sequential tasks complete).

1. **Aggregate metrics:** Read all `agent_stop` events for this orchestration_id. Sum
   input/output/cache tokens and estimated_cost_usd. Calculate duration_ms. Determine
   status: success (all agents OK), partial (some failed), failure (all failed/aborted).

2. **Append orchestration_complete event** to `.orchestray/audit/events.jsonl`:
   ```json
   {
     "timestamp": "<ISO 8601>",
     "type": "orchestration_complete",
     "orchestration_id": "orch-1712345678",
     "total_agents": 3,
     "total_tokens": {
       "input": 45000,
       "output": 12000,
       "cache_read": 8000,
       "cache_creation": 2000
     },
     "estimated_total_cost_usd": 0.234567,
     "duration_ms": 45000,
     "status": "success"
   }
   ```

3. **Archive:** Copy `events.jsonl` to `.orchestray/history/<orch-id>/events.jsonl`,
   then delete the originals. Delete `current-orchestration.json`.

4. **Report cost summary** to user: `Cost estimate: ~$X total (agent ~$Y, ...) | Tokens: N input / N output`

4.5. **Cost prediction accuracy**: If Section 31 (in cost-prediction.md) produced a pre-execution estimate, compare predicted vs actual and log `cost_prediction` event per Section 31.

5. **Update pattern confidence** per Section 22c for any applied patterns.

6. **Project-specific failure memory:** If verify-fix loops or re-plans occurred, write
   the codebase-specific failure reason to `.orchestray/kb/facts/failure-{slug}.md`
   with `ttl_days: 60`. Include in future delegation prompts.

7. **Extract new patterns** per Section 22a from the archived history.

7.1. **Thread creation/update**: If `enable_threads` is true, create or update a thread
   entry for this orchestration per Section 40a/40c (in orchestration-threads.md). This
   runs first because its output is self-contained and fast.

7.2. **Outcome probe creation**: If `enable_outcome_tracking` is true, create an outcome
   probe for this orchestration per Section 41a (in outcome-tracking.md). The probe records
   delivered files, tests added, and patterns applied for deferred quality validation.

7.3. **Persona refresh check**: If `enable_personas` is true, check whether persona
   generation or refresh is triggered per Section 42a (in adaptive-personas.md). Generate
   or refresh personas for agent types used 2+ times across recent orchestrations.

7.4. **Replay analysis**: If `enable_replay_analysis` is true AND friction signals are
   detected (re-plans, verify-fix failures, cost overruns >50%, confidence <0.4, or turns
   >2x budget), run counterfactual analysis per Section 43a-43c (in replay-analysis.md).
   Write replay pattern to `.orchestray/patterns/replay-{orch-id}.md`.

7.5. **Consequence forecast validation (Phase B)**: If `enable_consequence_forecast` is
   true and `.orchestray/state/consequences.md` exists, run Section 39 Phase B to compare
   predictions against the actual git diff. Include accuracy summary in the final report.
   Log `consequence_forecast` event to `.orchestray/audit/events.jsonl`.

7.6. **Drift validation**: If `enable_drift_sentinel` is true, run Section 39.D
   post-execution check. Load all enforced invariants (extracted, static, session), check
   the git diff against each, and surface any violations to the user. Log `drift_check`
   event to `.orchestray/audit/events.jsonl`. If error-severity violations exist, present
   user options (fix / update decision / acknowledge) before proceeding. See
   `agents/pm-reference/drift-sentinel.md` for the full post-execution protocol.

8. **Auto-documenter**: After all post-completion steps above, run Section 36
   (Auto-Documenter Detection, in auto-documenter.md). If `auto_document` is true and
   a feature addition is detected, spawn the documenter agent as a non-blocking bonus step.

9. **Check for user correction feedback**: After the auto-documenter step, evaluate the
   user's next response per Section 34c. If corrective feedback is found, extract as a
   user-correction pattern. (Moved here from step 7.5 to avoid blocking post-processing
   steps 7.5, 7.6, and 8 on an out-of-band user wait.)

### 15.Z: ROI Scorecard Generation

After steps 1-9 above complete, generate an **Orchestration ROI Scorecard** that quantifies
the value delivered alongside the cost. This scorecard MUST be included in the final
summary reported to the user (per Section 8 Communication Protocol).

**Metrics derivation:**

1. **Agents used:** Count distinct agents spawned in this orchestration. List their types.
2. **Issues caught pre-merge:** Count `severity: "error"` and `severity: "warning"` from
   all reviewer result `issues` arrays in this orchestration.
3. **Verify-fix rounds:** From Section 18 state tracking -- count how many verify-fix
   rounds occurred and how many resolved successfully.
4. **Contract checks:** Count `contract_check` events in the audit trail for this
   orchestration_id. Tally `overall: "pass"` vs `overall: "fail"` or `"partial_fail"`.
5. **Consequence predictions:** From `consequence_forecast` events -- extract `accuracy`
   totals (total, addressed, missed, wrong).
6. **Files delivered:** Aggregate all `files_changed` arrays from agent results. Count
   unique files, split into created (new files) vs modified (existing files).
7. **Tests added:** Count files in `files_changed` matching test file patterns
   (`*.test.*`, `*.spec.*`, `test_*`, `*_test.*`). Count distinct test suites
   (unique directories containing test files).
8. **Estimated manual effort:** Apply heuristic: 5 min per file created, 3 min per file
   modified, 3 min per test file, 10 min per design document (architect output), 5 min
   per file reviewed. Sum for total estimate.
9. **Cost vs baseline:** Actual cost from step 1 aggregation. All-Opus baseline from sum
   of `estimated_cost_opus_baseline_usd` across `agent_stop` events. Routing savings =
   baseline - actual.

**Scorecard format (include in final user summary):**

```
## Orchestration ROI
- Agents used: N (list)
- Issues caught pre-merge: N (errors, warnings)
- Verify-fix rounds: N (resolved in N rounds)
- Contract checks: N passed, N failed
- Consequence predictions: N (N addressed, N missed)
- Files delivered: N created, N modified
- Tests added: N (N suites)
- Estimated manual effort: ~X-Y min
- Cost: ~$X.XX | All-Opus baseline: ~$X.XX | Routing savings: ~$X.XX
```

**Append `orchestration_roi` event** to `.orchestray/audit/events.jsonl` with the
scorecard metrics (see event-schemas.md for the schema).

If any metric cannot be computed (e.g., no reviewer was used, so issues caught = 0;
consequence forecasting was disabled), report `0` or `N/A` as appropriate. Never omit
the scorecard -- even a simple orchestration produces useful ROI data.

---

## 16. Adaptive Re-Planning Protocol

When agents report structural problems -- not implementation bugs -- the PM can
restructure the entire task graph mid-execution, including revisiting completed work.
This implements dynamic workflow adjustment (ROLE-05).

### When to Re-Plan

After Section 4 processes each agent result, evaluate these signals. If ANY of
the following are present, a re-plan may be warranted:

1. **Approach invalidation:** Agent reports the chosen approach is fundamentally flawed.
   The design won't work, the library doesn't support the needed feature, the constraint
   was misunderstood.

2. **Scope expansion:** Agent discovers the task is significantly larger than estimated.
   What was a 2-file change is actually a 10-file refactor. New subsystems are involved
   that weren't in the original assessment.

3. **Dependency discovery:** Agent found a dependency not captured in the original graph.
   Task B actually needs Task C to complete first, but C doesn't exist yet.

4. **Completed work invalidation:** New information means already-completed work is wrong.
   The architect designed for REST but the requirement is actually GraphQL. Previous
   implementation must be revisited. Per D-02, there is no completed-work lock-in.

5. **Reviewer design rejection:** Reviewer identifies a design flaw -- not an
   implementation bug. The approach itself is wrong, not just the code. Implementation
   bugs (missing null check, wrong return type, test failure) route to the verify-fix
   loop in Section 18, NOT to re-planning.

If NONE of these signals are present, proceed with the current graph. No re-plan needed.
The vast majority of agent results will NOT trigger re-planning.

### Re-Plan Execution

When a re-plan trigger is confirmed:

1. **Read current task graph** from `.orchestray/state/task-graph.md`. This is the
   baseline for restructuring.

2. **Read all completed task results** from `.orchestray/state/tasks/*.md`. Understand
   what work has been done and what each agent produced.

3. **Evaluate which completed work is still valid** given the new information. Per D-02,
   the PM can revisit completed work -- there is no lock-in. Mark any tasks whose
   output is invalidated by the new information.

4. **Generate a new task graph** by re-running Section 13 (Task Decomposition Protocol)
   with updated context including the new information. Section 13's "Re-Planning Entry
   Point" subsection provides the additional context available during re-planning.

5. **Log re-plan event** to audit trail `.orchestray/audit/events.jsonl`:
   ```json
   {
     "timestamp": "<ISO 8601>",
     "type": "replan",
     "orchestration_id": "<current orch id>",
     "reason": "<approach_invalidation | scope_expansion | dependency_discovery | completed_work_invalidation | design_rejection>",
     "old_task_count": 4,
     "new_task_count": 6,
     "tasks_invalidated": ["task-02", "task-03"]
   }
   ```

6. **Register re-plan decision in KB** at `.orchestray/kb/decisions/replan-{timestamp}.md`
   with the reason and a summary of what changed. This ensures future orchestrations
   can learn from re-plan history.

7. **Update `.orchestray/state/orchestration.md`** with incremented `replan_count` field.
   If this is the first re-plan, add `replan_count: 1` to the YAML frontmatter.

8. **Update state files** for any invalidated tasks: set status to `invalidated` with
   a `invalidation_reason` field explaining why the work is no longer valid.

### Anti-Thrashing Safeguard

Re-planning is expensive -- it discards work and restructures the graph. Unbounded
re-planning can thrash indefinitely. To prevent this:

1. **Track re-plan count** per orchestration in `orchestration.md` frontmatter
   (`replan_count` field).

2. **Read `replan_budget`** from `.orchestray/config.json`. Default is 3 if not set.
   Valid range: 1-10 (validated by the config skill).

3. **Before executing a re-plan**, check: `replan_count >= replan_budget`?

4. **If budget reached**, do NOT re-plan. Instead, escalate to the user:
   ```
   Re-planning budget reached ({N}/{budget}).

   Current situation: [summary of what's happening -- what triggered re-plan,
   what the current state of the task graph is, what work has completed]

   Options:
   1. Increase re-plan budget and continue (I'll try a different approach)
   2. Provide guidance on how to proceed
   3. Abort this orchestration
   ```

5. **Wait for user response** before proceeding. The user decides whether to increase
   the budget, provide direction, or abort.

### Distinguishing Re-Plan from Verify-Fix

Not every problem requires re-planning. Use this decision tree:

| Signal | Route To | Why |
|--------|----------|-----|
| Implementation bug (reviewer found code errors: missing null check, wrong return type, test failure) | Section 18 (Verify-Fix Loop) | The approach is correct; the code just has bugs. Fix the code, don't restructure the graph. |
| Design flaw (the approach itself is wrong, not just the code) | Section 16 (Re-Plan) | The task graph is based on a flawed design. Restructuring is needed. |
| Scope change (task is bigger or different than expected) | Section 16 (Re-Plan) | The original decomposition doesn't cover the actual scope. New tasks are needed. |
| Agent failure (crash, timeout, no useful output) | Section 5 (Retry) | Try once more with enhanced context. If retry also fails, THEN evaluate for re-plan. |
| Dependency missing (need something not in the graph) | Section 16 (Re-Plan) | The graph is incomplete. Add the missing task and re-order dependencies. |

**Key principle:** Re-planning is for structural problems with the task graph. Verify-fix
is for implementation problems with the code. Retries are for transient agent failures.
Routing correctly prevents wasting the re-plan budget on problems that don't need
graph restructuring.

---

## 17. Dynamic Agent Spawning Protocol

When task decomposition (Section 13) or re-planning (Section 16) identifies a subtask
that requires domain expertise not covered by the core agents (architect, developer,
refactorer, inventor, reviewer, debugger, tester, documenter, security-engineer), the PM can spawn an ephemeral specialist agent. Dynamic agents are created
on demand and removed after completion.

### When to Spawn Dynamic Agents

Consider spawning a dynamic agent when ALL of these apply:

1. **The subtask requires domain expertise not covered by the core agents.**
   Examples: database migration specialist, security auditor, performance profiler.
   Note: documentation and testing now have dedicated agents (documenter, tester).

2. **The subtask has unique tool restrictions** different from the core agents, OR
   benefits from a highly focused system prompt that would be diluted if added to a
   core agent's instructions.

3. **The core agents genuinely cannot handle the task well.** Most tasks fit
   architect/developer/reviewer. Per research: the 3-5 agent sweet spot means dynamic
   agents add overhead and should be RARE.

There is no hard cap on dynamic agents (per D-03). The PM decides based on task needs,
and the token budget provides the natural limit. However, per Anti-Pattern #10
(Section 9), never spawn dynamic agents for tasks the core agents can handle.

### Agent Definition Generation

The PM writes a temporary agent definition file to the `agents/` directory. The file
must follow Claude Code's standard agent `.md` format (YAML frontmatter + markdown body).

**Frontmatter template:**

```yaml
---
name: {task-specific-name}
description: {one-line description of specialization}
tools: {appropriate tool subset -- see tool access patterns below}
model: {routed_model_from_section_19}  # Set by Section 19 Model Routing Protocol. Do NOT use 'inherit' during orchestrations.
maxTurns: 30
color: cyan
---
```

**Markdown body (100-200 lines MAX):** The system prompt MUST include:

- Task-specific instructions and domain knowledge
- The project's standard output format (Section 6 JSON+markdown result structure)
- KB protocol instruction (Section 10 -- write findings to `.orchestray/kb/`)
- Explicit scope boundaries (what to do and what NOT to do)

Keeping the prompt under 200 lines prevents scope creep and context bloat. A focused
specialist performs better than a generalist with a sprawling prompt.

### Tool Access Patterns

Choose the minimal tool set that enables the task (per D-04):

- **Read-only specialists** (analysis, audit, profiling): `Read, Glob, Grep, Bash`
- **Write specialists** (implementation, migration, documentation): `Read, Glob, Grep, Bash, Write, Edit`

Grant write tools only when the specialist needs to modify files. Analysis and audit
agents should never have Write or Edit access.

### Lifecycle

Dynamic agents follow a persistent-aware lifecycle. Before creating a new agent from
scratch, the PM checks the specialist registry for reusable matches. Successful agents
may be saved for future reuse instead of being discarded.

0. **Check specialist registry** (Section 21): Before creating a new dynamic agent,
   check the specialist registry per Section 21. If a matching specialist is found,
   copy it from `.orchestray/specialists/` to `agents/`, apply model routing from
   Section 19 (override the `model:` field in frontmatter), and skip to step 2.

1. **PM creates agent definition file** at `agents/{name}.md` before spawning.
   (Only executed if no matching specialist was found in step 0.)

2. **PM spawns the agent** using `Agent("{name}")`. Claude Code resolves the name to
   the file in `agents/`. The PM frontmatter lists `tools: Agent(architect, developer,
   reviewer)` which documents the core agents, but Claude Code's Agent() tool resolves
   any agent name to a matching `.md` file in the `agents/` directory. The PM is NOT
   restricted to only the listed names.

3. **Agent executes** and returns a structured result per Section 6.

4. **PM processes the result** per Section 4 (Agent Result Handling).

5. **Save-or-delete decision:**
   - If `status: success` AND agent was newly created (not from registry): evaluate
     for save per Section 20. After save evaluation, delete `agents/{name}.md`.
   - If agent was reused from registry: increment `times_used` and update `last_used`
     in `registry.json`. Check promotion threshold per Section 20. Delete
     `agents/{name}.md` copy.
   - If `status: failure`: delete `agents/{name}.md` without saving. Never save
     failed agents.

6. **Log `dynamic_agent_spawn` event** to `.orchestray/audit/events.jsonl`:
   ```json
   {
     "timestamp": "<ISO 8601>",
     "type": "dynamic_agent_spawn",
     "orchestration_id": "<current orch id>",
     "agent_name": "{name}",
     "task_id": "<task id>",
     "tools": ["Read", "Glob", "Grep", "Bash"],
     "from_registry": false
   }
   ```

7. **Log `dynamic_agent_cleanup` event** after deletion:
   ```json
   {
     "timestamp": "<ISO 8601>",
     "type": "dynamic_agent_cleanup",
     "orchestration_id": "<current orch id>",
     "agent_name": "{name}",
     "task_id": "<task id>",
     "file_deleted": "agents/{name}.md"
   }
   ```

**Name validation:** Dynamic agent names MUST match `^[a-zA-Z0-9_-]+$`. Reject any name
containing path separators (`/`), traversal sequences (`..`), dots, or other non-alphanumeric
characters. If the derived name fails this check, sanitize by replacing invalid characters
with `-` and re-validating. Additionally, specialist names must NOT be `pm`, `architect`,
`developer`, `refactorer`, `inventor`, `reviewer`, `debugger`, `tester`, `documenter`, or
`security-engineer` to avoid conflicts with core agent definitions.

---

## 18.D: Disagreement Detection

**When to run:** After receiving reviewer findings and BEFORE entering the verify-fix
loop (Section 18). This step classifies "warning" severity findings as either normal
warnings (proceed as usual) or design disagreements (route to surfacing protocol).

**Prerequisite:** `surface_disagreements` config is `true`. If `false`, skip this
section entirely and proceed to Section 18 as normal.

### Classification Steps

1. **Filter to warning-severity findings:** From the reviewer's structured result, select
   all issues where `severity: "warning"`. Error-severity issues always route to
   Section 18 verify-fix. Info-severity issues are always informational.

2. **Apply detection criteria** to each warning finding. A finding is a disagreement
   when ALL four conditions are met:
   - Severity is "warning" (already filtered in step 1)
   - Description contains trade-off language: "consider", "alternatively", "trade-off",
     "could also", "one approach vs another", "might prefer", "another option"
   - Finding is about a design CHOICE, not correctness (no compilation error, no security
     vulnerability, no broken test, no missing null check)
   - Finding references a valid alternative approach

3. **Check for matching design-preference pattern:** Before surfacing, glob
   `.orchestray/patterns/design-preference-*.md` and check if any existing preference
   matches this disagreement's context. If a matching preference exists with
   confidence >= 0.8 (requiring at least 3 reaffirmations from the initial 0.6)
   and `deprecated` is not true:
   - Apply the preference automatically (no user prompt needed).
   - Log `disagreement_surfaced` event with `user_decision: "auto_preference"` and
     `preference_name: "{name}"`.
   - Auto-applied preferences must be logged in the orchestration summary.
   - Increase the matched preference's confidence by +0.1 (cap 1.0).
   - Skip surfacing for this finding.

4. **Route disagreements to surfacing protocol:**
   - Read `agents/pm-reference/disagreement-protocol.md` for the surfacing format and
     user response handling.
   - Present each disagreement to the user using the structured format from that file.
   - Log `disagreement_surfaced` event per the schema in event-schemas.md.

5. **Route non-disagreement warnings normally:** Warnings that do not meet all four
   criteria proceed through the normal flow (reported in the summary but not triggering
   verify-fix or surfacing).

**When in doubt, do NOT classify as disagreement.** False negatives (routing a
disagreement through verify-fix) waste some tokens but cause no harm. False positives
(skipping a real issue) miss necessary fixes.

---

## 18. Verify-Fix Loop Protocol

This section replaces the old Section 5 (Retry Protocol). The old Section 5 allowed
one blind retry. Section 18 implements structured multi-round quality loops where
reviewer feedback is extracted, formatted, and fed to the developer for targeted fixes
with regression prevention.

### When to Enter Verify-Fix Loop

The verify-fix loop is triggered when:

- Reviewer returns `status: "failure"` with `issues` containing `severity: "error"` items.
- Only **error-severity issues** trigger the loop. Warnings and info items do NOT.
- The failure is an **implementation bug**, NOT a design flaw. Design flaws route to
  Section 16 (re-planning), not verify-fix.
- **Warning findings classified as disagreements** by Section 18.D are excluded from
  this loop -- they route to the disagreement surfacing protocol instead.

If the reviewer returns `status: "failure"` but all issues are warning or info severity,
proceed normally -- the implementation is acceptable with noted improvements.

### Loop Mechanics

For each round of the verify-fix loop:

**a. Extract fix instructions from reviewer:**

Parse the reviewer's structured result (Section 4 format). Filter the `issues` array
to `severity: "error"` only. Each issue's `description` field contains a file path,
line reference, and suggested fix (per reviewer protocol Section 4). These become the
fix instructions for the developer.

**b. Build developer fix prompt:**

Include ALL of the following in the developer's delegation prompt:

1. **Original task context** (abbreviated): task title, key files, constraints. Do NOT
   re-send the full original prompt -- just enough for the developer to understand scope.

2. **Specific issues to fix**: the error-severity issues from the reviewer, verbatim.
   Do not paraphrase or summarize -- the reviewer's exact descriptions contain file paths
   and line references the developer needs.

3. **Files that need changes**: extracted from the issue descriptions.

4. **Cumulative fix history**: ALL issues fixed in previous rounds, with the explicit
   instruction: "These issues were fixed in previous rounds and MUST remain fixed. Do
   not regress them." This is the primary anti-regression mechanism.

5. **Attempt counter**: "This is attempt {N} of {verify_fix_max_rounds}" where
   `verify_fix_max_rounds` comes from `.orchestray/config.json` (default 3 per D-05).

6. **Scope restriction**: "Fix ONLY the listed issues. Do not refactor, add features,
   or make unrelated changes."

**c. Spawn developer** with the fix prompt.

**d. Spawn reviewer** to re-validate the developer's fixes.

**e. Evaluate reviewer result:**

- If `status: "success"` (no error-severity issues): **EXIT loop**, proceed normally
  with the orchestration flow.
- If errors remain AND round < `verify_fix_max_rounds`: **CONTINUE loop** (go to step a
  with the new reviewer result).
- If errors remain AND round >= `verify_fix_max_rounds`: **ESCALATE** to the user
  (see User Escalation below).
- If the developer reports the fix is impossible or requires a design change: **TRIGGER
  re-plan** (Section 16). The verify-fix loop cannot resolve design problems.

**f. State tracking:**

Update `.orchestray/state/tasks/{task}.md` with a verify_fix block in the YAML
frontmatter:

```yaml
verify_fix:
  rounds_completed: {N}
  max_rounds: {max}
  round_history:
    - round: 1
      reviewer_issues: {count}
      developer_fixed: {count}
      remaining: {count}
  status: in_progress | resolved | escalated | design_rejected
```

**g. Audit logging:**

For each round, append events to `.orchestray/audit/events.jsonl`:

- **Round start:**
  ```json
  {"timestamp": "<ISO 8601>", "type": "verify_fix_start", "orchestration_id": "...", "task_id": "...", "round": 1, "error_count": 3}
  ```

- **Round pass (loop exits successfully):**
  ```json
  {"timestamp": "<ISO 8601>", "type": "verify_fix_pass", "orchestration_id": "...", "task_id": "...", "round": 2, "rounds_total": 2}
  ```

- **Round fail (cap reached):**
  ```json
  {"timestamp": "<ISO 8601>", "type": "verify_fix_fail", "orchestration_id": "...", "task_id": "...", "round": 3, "remaining_errors": 2}
  ```

### User Escalation

When `verify_fix_max_rounds` is reached and errors remain (per D-06):

```
Verify-fix loop reached maximum rounds ({N}/{max}).

Remaining issues:
- {list of unresolved error-severity issues from last reviewer pass, verbatim}

Options:
1. Accept current implementation with known issues (I'll document the warnings)
2. Provide guidance for another attempt (describe what to try differently)
```

Log the escalation event:
```json
{"timestamp": "<ISO 8601>", "type": "escalation", "orchestration_id": "...", "task_id": "...", "reason": "verify_fix_cap", "remaining_errors": 2}
```

- If user chooses **option 1**: set `verify_fix.status` to `"escalated"` in the task
  state file. Proceed with the orchestration, documenting known issues in the final report.
- If user chooses **option 2**: reset the round counter with the user's guidance as
  additional context in the developer prompt. Continue the loop from round 1, but include
  ALL previous fix history (from before the reset) in the cumulative fix history.

### Regression Prevention

The cumulative fix history included in each developer prompt is the primary
anti-regression mechanism. Every round's developer prompt includes ALL previously
fixed issues with the instruction "MUST remain fixed."

**Oscillation detection:** If round N has the same number of or more errors than
round N-1, this may indicate an oscillation pattern (fixing one issue reintroduces
another). When detected:

1. Log a warning to the audit trail:
   ```json
   {"timestamp": "<ISO 8601>", "type": "verify_fix_oscillation", "orchestration_id": "...", "task_id": "...", "round": 2, "errors_current": 3, "errors_previous": 2}
   ```

2. Consider escalating early (before reaching the cap) if the error count is trending
   upward across multiple rounds. Two consecutive rounds with non-decreasing errors
   is a strong signal that the developer cannot converge without human guidance.

### Integration with Section 16

If during a verify-fix loop the developer reports that the fix requires a design change
(not just a code change), the verify-fix loop exits with `status: "design_rejected"` and
control passes to Section 16 (Adaptive Re-Planning Protocol). The structural failure
in verify-fix becomes a re-plan trigger signal (Signal 5: Reviewer design rejection).

### Integration with Section 30

After successful fix (reviewer passes after developer correction), extract correction
pattern per Section 30.

---

## 19. Model Routing — Detailed Scoring and Logging

This section contains the detailed routing outcome logging and integration points.
For the routing decision summary, effort assignment, and transparency rules, see
Section 19 in the main pm.md.

### Routing Outcome Logging

After each agent completes (in Section 4 result processing), append a `routing_outcome`
event to `.orchestray/audit/events.jsonl`.

> Read `agents/pm-reference/event-schemas.md` for the exact JSON format before writing this event.

### Integration Points

- **Section 12 output feeds Section 19**: After scoring, before Section 13 decomposition,
  determine model per subtask.
- **Section 3 spawning uses Section 19 output**: When spawning any agent (core or dynamic),
  set `model: {routed_model}` in the agent invocation. For core agents, pass the model
  parameter. For dynamic agents (Section 17), write `model: {routed_model}` and
  `effort: {routed_effort}` in the frontmatter instead of `model: inherit`.
- **Section 4 result handling triggers routing outcome logging**: After parsing agent
  result, append the routing_outcome event.
- **Section 18 verify-fix loop triggers escalation**: On reviewer rejection, check if
  model escalation should happen before entering fix loop.

### 19.Z: Confidence-Triggered Escalation

When `enable_backpressure` is true and a confidence signal indicates low confidence,
the PM may escalate the model tier for re-execution instead of accepting a low-quality
result.

**Trigger:** Confidence < 0.4 on a completed task (detected in Section 4.Z or 14.Z).

**Escalation protocol:**

1. **Check current model tier:** Read the `routing_outcome` event for this task to
   determine the model used (haiku, sonnet, opus).

2. **Determine escalation target:**
   - Haiku -> Sonnet (1 tier up)
   - Sonnet -> Opus (1 tier up)
   - Opus -> no escalation available. Escalate to user instead.

3. **Re-execute the task** with the higher model tier. Preserve the original delegation
   prompt but add a context note: "Previous attempt completed with low confidence
   ({value}). Risk factors: {risk_factors}. Please address these concerns."

4. **Log escalation** in the `routing_outcome` event for the re-execution:
   - Set `result: "escalated"` on the original task's routing_outcome
   - Set `escalated_from: "{original_model}"` and `escalation_count: N` on the new event

5. **Track confidence patterns:** If a particular agent type or task archetype consistently
   produces low confidence at a given model tier, this is a signal for Section 22
   pattern extraction. Log for future routing optimization.

**Cost awareness:** Escalation increases cost. The PM should only escalate when the
confidence signal indicates the result quality is genuinely insufficient, not for
marginal improvements. Confidence >= 0.4 does not trigger escalation.

---

## 22. Pattern Extraction & Application Protocol

Orchestray learns from past orchestrations by extracting reusable patterns and applying
them to future task decomposition. This makes the PM smarter over time. Patterns are
stored as markdown files in `.orchestray/patterns/` with YAML frontmatter metadata.

Four categories of patterns (per orchestration experience):
- **decomposition**: Task breakdown strategies that led to clean success
- **routing**: Model routing decisions that proved correct without escalation
- **specialization**: Dynamic agents saved as specialists or successful specialist reuses
- **anti-pattern**: Re-plan triggers, verify-fix failures, escalations -- what went wrong

### 22a. Automatic Pattern Extraction (Post-Orchestration)

Run AFTER Section 15 step 3 completes. Extract patterns from the archived audit trail
at `.orchestray/history/<orch-id>/events.jsonl`.

### 22b. Pattern Application (Pre-Decomposition)

Run BEFORE Section 13. Glob `.orchestray/patterns/*.md` and `.orchestray/team-patterns/*.md` (see Section 33B, in team-config.md, for merge order), match against current task,
apply relevant patterns as advisory context. Patterns are **ADVISORY** -- they inform
decomposition but do not override PM judgment.

### 22c. Confidence Feedback Loop

Run AFTER orchestration completes but BEFORE extracting new patterns (22a). Update
confidence scores for applied patterns: +0.1 on success, -0.2 on failure.

### 22d. Pruning

Run AFTER writing new patterns. Cap at 50 patterns, prune lowest `confidence * times_applied`.

> Read `agents/pm-reference/pattern-extraction.md` for the full extraction steps, pattern file template, application protocol, confidence feedback details, and pruning rules.

### 22.Y: Trace-Aware Pattern Extraction

When `enable_introspection` is true, reasoning traces enrich pattern extraction (22a)
with two additional signal sources:

**Rejected alternatives as candidate anti-patterns:**
- During post-orchestration extraction, read all trace files in
  `.orchestray/state/traces/` (before archiving clears them).
- For each "Approaches Considered" entry marked as "Rejected", evaluate whether it
  represents a generalizable anti-pattern (not just a one-off bad fit).
- If the rejection reason applies broadly (e.g., "GraphQL rejected because team has no
  experience" is project-specific, not an anti-pattern; "synchronous event handlers
  rejected because they block the request loop" IS a generalizable anti-pattern),
  create a candidate anti-pattern entry.
- Cross-reference against existing patterns in `.orchestray/patterns/` to avoid
  duplicates. If a similar anti-pattern already exists, increment its `times_applied`
  instead of creating a new one.

**Discoveries as candidate KB facts:**
- For each "Discoveries" entry in traces, check whether the insight is already captured
  in `.orchestray/kb/facts/`. If not, and the discovery is broadly useful (not just
  relevant to the current task), write it as a new KB fact entry following
  Section 10's KB writing protocol.
- Examples of useful discoveries: "auth module uses in-memory token store",
  "database migrations run synchronously", "test fixtures are shared via a global setup".
- Examples to skip: "file X has 200 lines" (too specific), "import order matters in
  this file" (too narrow).

**Integration with 22a:** These trace-derived candidates are added to the same extraction
pass as audit-trail-derived patterns. They do not run as a separate step.

### 22.D: Design-Preference Pattern Learning

When a user resolves a disagreement (surfaced by Section 18.D) with "keep current" or
"apply suggestion", save a design-preference pattern following the format in
`agents/pm-reference/disagreement-protocol.md`.

**Saving preferences:**

1. After the user responds to a surfaced disagreement with "keep current" or "apply
   suggestion", create a pattern file at `.orchestray/patterns/design-preference-{slug}.md`
   using the template from disagreement-protocol.md.
2. The slug should be a kebab-case descriptor of the design choice (e.g.,
   `singleton-over-di`, `flat-config-over-nested`).
3. Set initial confidence to 0.6, `times_applied` to 0, and record the current
   orchestration_id in the evidence array.
4. If "defer" was chosen, do NOT save a pattern -- the user expressed no preference.

**Applying preferences in future orchestrations:**

1. During Section 22b (Pattern Application, Pre-Decomposition), design-preference
   patterns are loaded alongside other pattern types from `.orchestray/patterns/`.
2. When a design-preference pattern matches the current task context (by keyword match
   on the `context` field against the task description and affected files), inject
   it into the developer's delegation prompt using the Design-Preference Context
   template from `agents/pm-reference/delegation-templates.md`.
3. Only inject preferences with confidence >= 0.8 and `deprecated` is not true.
4. Cap at 3 design-preference injections per delegation to limit context usage.

**Confidence lifecycle:**

- Reaffirmation (same choice in matching context): confidence += 0.1 (cap 1.0),
  add orchestration_id to evidence.
- Reversal (opposite choice in matching context): confidence -= 0.2 (floor 0.1).
  If confidence drops below 0.3, set `deprecated: true`.
- Application without disagreement (Section 18.D auto-applied): confidence += 0.1
  (cap 1.0), increment `times_applied`.

**Pruning:** Design-preference patterns participate in the same pruning pass as other
pattern types (Section 22d). They are scored by `confidence * times_applied` alongside
decomposition, routing, specialization, and anti-pattern entries.

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

### Injection During Agent Delegation (Section 3)
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

## 30. Correction Memory Protocol

Learn from verify-fix loops (Section 18) so the same mistakes are never repeated.

### Extraction (after successful verify-fix loop)
When Section 18 completes a successful fix (reviewer passes after developer correction):
1. Extract a correction pattern:
   - **What went wrong**: The reviewer's original finding (severity, category, description)
   - **How it was fixed**: The developer's correction approach
   - **When to apply**: File patterns or task types where this mistake is likely (e.g., `**/*.ts` for TypeScript issues)
   - **Confidence**: `low` on first occurrence, `medium` after 2 occurrences, `high` after 3+
2. Ensure `.orchestray/patterns/` directory exists (create if missing).
3. Check `.orchestray/patterns/` for existing correction patterns with similar descriptions
   - If a similar correction exists: increment its `occurrences` count and update confidence
   - If no match: create a new file at `.orchestray/patterns/correction-<slug>.md`

### Correction Pattern File Format
```markdown
---
type: correction
name: <descriptive-slug>
occurrences: <count>
confidence: low|medium|high
last_seen: <ISO timestamp>
file_patterns: ["<glob>", ...]
task_types: ["<archetype>", ...]
---

## What Goes Wrong
<reviewer finding description>

## Correct Approach
<how to avoid or fix this issue>

## Evidence
- <orchestration-id>: <brief description of occurrence>
```

### Application (during agent delegation)
During Section 3 (Agent Spawning), before delegating to a developer agent:
1. Glob `.orchestray/patterns/correction-*.md` and `.orchestray/team-patterns/correction-*.md`
2. For each correction pattern, check if it matches the current task:
   - File patterns match any files in the subtask's file ownership list
   - OR task type matches the current archetype
3. If matches found (max 3, prioritize by confidence then recency):
   - Append to delegation prompt:
     ```
     ## Known Pitfall: <correction name>
     <Correct Approach section content>
     ```
4. Log `pattern_applied` event to audit trail: `{"type": "pattern_applied", "pattern": "<name>", "agent": "<agent_type>", "confidence": "<level>"}`
5. Also check user-correction patterns per Section 34f. Combined cap: max 5 total correction warnings (verify-fix + user-correction), prioritized by confidence then recency.

### Integration with Section 18
Add this step to the END of Section 18's successful fix flow:
After the reviewer passes on the fix, trigger Section 30 extraction before reporting success.

---

## 34. User Correction Protocol

Capture direct user corrections as high-confidence patterns for future orchestrations.

### 34a. Detection During Orchestration

After receiving any user message during an active orchestration, evaluate BEFORE responding:

**Is this a correction?** The message corrects the system's approach if it:
1. Contradicts an agent's output or PM decision ("no", "that's wrong", "don't do it that way")
2. Redirects strategy ("use X instead", "handle this differently", "split this into steps")
3. Provides missing domain knowledge ("actually, this API requires...", "that field is deprecated")

**NOT a correction:** Checkpoint responses (continue/abort/modify), status questions, output review requests, plan modifications via Section 28 (in checkpoints.md).

**When uncertain:** Ask the user: "Should I save this as a correction for future orchestrations, or is this specific to this task?"

### 34b. Extraction

When a correction is detected:

1. Acknowledge: "Understood. Adjusting approach and saving this as a correction pattern."
2. Extract fields:
   - `what_was_wrong`: What the system did or planned incorrectly
   - `correct_approach`: The user's stated correct approach
   - `applies_to`: Infer file patterns and task types from context. If unclear, ask the user.
3. Check for existing patterns (deduplication):
   - Glob `correction-*.md` and `user-correction-*.md` in `.orchestray/patterns/` and `.orchestray/team-patterns/`
   - If match found: upgrade existing pattern (see dedup rules below)
   - If no match: create new file
4. Write `.orchestray/patterns/user-correction-{slug}.md` (template in 34d)
5. Apply immediately to current orchestration:
   - Pending tasks affected: update delegation prompt
   - Completed tasks affected: note for user, suggest re-plan (Section 16) if significant
6. Resume orchestration

### 34c. Detection Post-Orchestration

After delivering the final summary (Section 15 step 3, after step 7):
- Evaluate the user's response for corrective feedback
- If correction detected: extract using 34b steps 2-4
- If no correction: proceed normally

### 34d. Pattern File Format

File: `.orchestray/patterns/user-correction-{slug}.md`

    ---
    name: {kebab-case-name}
    category: user-correction
    confidence: 0.8
    times_applied: 0
    last_applied: null
    created_from: {orch-id or "manual"}
    source: {auto-during | auto-post | manual}
    description: {one-line description for matching}
    file_patterns: ["{glob}", ...]
    task_types: ["{archetype}", ...]
    ---

    # User Correction: {Human Readable Name}

    ## What Went Wrong
    {Description of what went wrong}

    ## Correct Approach
    {User's stated correct approach}

    ## Context
    {When this applies}

    ## Evidence
    - {orch-id}: {brief description}

### 34e. Deduplication Rules

Before creating a new user-correction pattern:

1. **Matches existing verify-fix correction (`correction-*.md`):**
   Upgrade the existing pattern's confidence to 0.8, add evidence. Do not create duplicate.
   Log: "User correction matches verify-fix correction '{name}' -- upgraded to 0.8"

2. **Matches existing user correction (`user-correction-*.md`):**
   Update Correct Approach if new details provided, add evidence, bump confidence +0.1 (cap 1.0).
   Log: "Updated existing user correction '{name}' with new evidence"

3. **No match:** Create new pattern file.

### 34f. Application During Delegation

Extends Section 3, step 7 (correction patterns). After checking Section 30 correction patterns:

1. Glob `.orchestray/patterns/user-correction-*.md` and `.orchestray/team-patterns/user-correction-*.md`
2. Match against subtask: file_patterns vs files_owned, task_types vs archetype, description similarity
3. Max 3 matches (prioritize confidence, then recency)
4. Append to delegation prompt:
       ## Known Pitfall (User Correction): {name}
       {Correct Approach content}
5. Log `pattern_applied` event with category `user-correction`

Combined cap with Section 30: max 5 total correction warnings per delegation (3 verify-fix + 3 user-correction, take top 5 by confidence).

---

## 39. Consequence Forecasting

Predict downstream effects of orchestration changes before execution and validate
predictions afterward. This creates a self-improving quality feedback loop: the PM learns
which changes ripple and which are contained, reducing missed side-effects over time.

**Skip condition:** If `enable_consequence_forecast` in `.orchestray/config.json` is
`false`, skip both phases entirely.

### Phase A: Pre-Execution Scan

Run AFTER task decomposition (Section 13) completes and BEFORE execution begins
(Section 14 / Section 2 delegation). This scan uses the repo map to predict what
downstream files might be affected by the planned changes.

**Protocol:**

1. **Collect write targets**: From the task graph (`.orchestray/state/task-graph.md`),
   gather all files listed in every task's "Files (write)" field into a single set.

2. **Load repo map**: Read `.orchestray/kb/facts/repo-map.md` (already loaded during
   Section 0 step 2.7). If the repo map does not exist, skip consequence forecasting
   for this orchestration -- the scan requires dependency data.

3. **Walk dependency edges FORWARD** from each write target. For each file being modified,
   identify three categories of downstream files:

   - **Direct dependents**: Files that import/require the modified file. Look for the
     modified file's name in the repo map's Module Index dependency edges or use
     `Grep("import.*{module_name}")` to find importers.
   - **Convention dependents**: Files following the same pattern as the modified file.
     For example, if `src/api/users.ts` is modified, other route handlers in `src/api/`
     may need similar changes. Identify by matching directory + file naming patterns.
   - **Test dependents**: Test files corresponding to the modified files. Look for
     `*.test.*`, `*.spec.*`, or files in `__tests__/` directories that reference the
     modified file.

4. **Generate predictions**: For each downstream file found (across all categories),
   write a 1-line prediction describing what might be affected and how. Format:

   ```
   - [direct] src/api/index.ts — may need updated import if export name changes
   - [convention] src/api/tasks.ts — similar route handler, may need same pattern update
   - [test] tests/auth.test.ts — test assertions may break if return type changes
   ```

5. **Cap at 8 predictions** per orchestration. Prioritize: direct > test > convention.
   If more than 8 downstream files are found, keep the 8 most likely to be affected
   (direct dependents first, then tests, then convention matches).

6. **Write predictions** to `.orchestray/state/consequences.md`:

   ```markdown
   ---
   orchestration_id: orch-XXXXXXXXXX
   generated_at: "ISO 8601"
   source_files: ["list of files_write from task graph"]
   ---

   ## Consequence Predictions

   - [direct] path/to/file — prediction text
   - [test] path/to/test — prediction text
   - [convention] path/to/similar — prediction text
   ```

7. **Display brief forecast** to the user before proceeding to execution:
   ```
   Consequence forecast: N predictions (N direct, N test, N convention)
   ```

### Phase B: Post-Execution Validation

Run AFTER all agents complete and BEFORE the final summary (triggered from Section 15
step 7.5 above).

**Protocol:**

1. **Read predictions**: Open `.orchestray/state/consequences.md` and parse the
   prediction list.

2. **Get actual changes**: Run `git diff --name-only` to get the list of all files
   actually modified during this orchestration.

3. **Classify each prediction**:
   - **addressed**: The predicted file appears in the git diff (it was touched by an agent).
   - **missed**: The predicted file does NOT appear in the git diff AND the prediction
     was plausible (the dependency relationship is real). Flag these for the user --
     they represent potential side-effects that were not handled.
   - **wrong**: The prediction was incorrect -- the dependency relationship does not
     actually exist, or the change type does not affect the downstream file. Mark as
     wrong to calibrate future predictions.

4. **Log event**: Append a `consequence_forecast` event to `.orchestray/audit/events.jsonl`
   (see `agents/pm-reference/event-schemas.md` for the schema):
   ```json
   {
     "timestamp": "<ISO 8601>",
     "type": "consequence_forecast",
     "orchestration_id": "<current>",
     "predictions": [
       {
         "target_file": "path/to/file",
         "category": "direct",
         "prediction": "one-line prediction text",
         "verified": true,
         "outcome": "addressed"
       }
     ],
     "accuracy": {
       "total": 5,
       "addressed": 3,
       "missed": 1,
       "wrong": 1
     }
   }
   ```

5. **Include accuracy summary** in the orchestration report (Section 8 final summary):
   ```
   Consequence forecast: 3/5 addressed, 1 missed, 1 wrong
   ```

6. **Flag missed predictions**: For each `missed` prediction, include a warning in the
   final report:
   ```
   Warning: Predicted consequence not addressed:
     - [direct] src/api/index.ts — may need updated import if export name changes
   Consider checking this file manually.
   ```

### Accuracy Over Time

Consequence forecast accuracy improves naturally through the pattern system. If the PM
consistently produces `wrong` predictions for certain file types or dependency patterns,
these will surface as low-accuracy trends in the audit trail. The PM should use this
signal to refine its dependency-walking heuristics in future orchestrations.

No explicit calibration mechanism is needed -- the PM's reasoning adapts based on the
accuracy metrics it logs and reviews during Section 22a pattern extraction.

### 39.D: Drift Check

Architectural drift detection runs alongside consequence forecasting. Both are pre/post-
execution validation mechanisms, but they check different things: consequences predict
downstream effects, drift checks enforce invariants established by prior decisions.

**Skip condition:** If `enable_drift_sentinel` in `.orchestray/config.json` is `false`,
skip both phases entirely.

#### Phase A: Pre-Execution Invariant Loading

Run AFTER task decomposition (Section 13) and BEFORE execution begins, at the same time
as Section 39 Phase A (consequence forecasting).

1. **Load enforced decisions**: Read all entries in `.orchestray/kb/decisions/` where
   `enforced: true` and `type: architectural-constraint`. Parse the `invariant` and
   `files_affected` fields from each.

2. **Register static rules**: Load the 3 built-in rules (`no-new-deps`,
   `no-removed-exports`, `test-coverage-parity`) from `drift-sentinel.md`. These are
   always active unless the user has explicitly disabled individual rules.

3. **Match invariants to task graph**: For each loaded invariant, compare its
   `files_affected` glob patterns against every task's `files_write` field in the task
   graph. If any overlap exists, mark that invariant as relevant for this orchestration.

4. **Inject constraints into delegation**: For each relevant invariant, append the
   constraint text to the delegation prompt of the agent assigned to the overlapping
   task. Use the constraint injection format from `delegation-templates.md`.

5. **Log pre-execution event**: Append a `drift_check` event with `phase: "pre"` to
   `.orchestray/audit/events.jsonl`. Record `invariants_checked` as the count of
   relevant invariants, `violations` as an empty array, `overall` as `"clean"`.

6. **Display**:
   ```
   Drift sentinel: N invariants loaded (N extracted, N static, N session)
   ```

#### Phase B: Post-Execution Drift Validation

Run AFTER all agents complete, triggered from Section 15 step 7.6 (after consequence
forecast validation in step 7.5).

1. **Get actual changes**: Run `git diff` to get the full diff of all changes made
   during this orchestration.

2. **Check extracted/session invariants**: For each enforced decision loaded in Phase A:
   - Scope to files matching the decision's `files_affected` patterns.
   - Search the diff for patterns that violate the invariant text. For example, if the
     invariant is "No file outside src/auth/ imports from src/auth/internal/", grep the
     diff for added import lines referencing `src/auth/internal/` in files outside
     `src/auth/`.
   - If a violation is found, record it with severity based on the constraint strength:
     `error` for "must not"/"never", `warning` for "should not".

3. **Check static rules**: Run each static rule against the diff per the protocol in
   `drift-sentinel.md`. All static rule violations are `warning` severity.

4. **Compile violations**: Aggregate all violations into a single list.

5. **Log post-execution event**: Append a `drift_check` event with `phase: "post"` to
   `.orchestray/audit/events.jsonl`. Set `overall` based on violation severities.

6. **Surface violations**: If any violations exist, present them to the user using the
   surfacing format in `drift-sentinel.md`. For `error`-severity violations, wait for the
   user to choose an option (fix / update decision / acknowledge) before proceeding. For
   `warning`-severity violations, display and continue.

7. **Display summary**:
   ```
   Drift check: N invariants checked, N violations (N error, N warning)
   ```
   Or if clean:
   ```
   Drift check: N invariants checked, clean
   ```
