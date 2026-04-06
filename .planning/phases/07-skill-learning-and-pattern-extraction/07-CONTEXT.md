# Phase 7: Skill Learning and Pattern Extraction - Context

**Gathered:** 2026-04-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Post-orchestration automatic pattern extraction from audit history into `.orchestray/patterns/`, PM checks patterns during task decomposition for similar past tasks, pattern lifecycle with confidence scoring and pruning (max 50), and `/orchestray:learn` skill for manual extraction. Does NOT include adaptive routing thresholds from history (ADVN-02) or cross-orchestration pattern memory beyond file-based storage (ADVN-03).

</domain>

<decisions>
## Implementation Decisions

### Pattern Extraction Trigger & Scope
- **D-01:** Post-orchestration automatic extraction — PM extracts patterns as a final step after every successful orchestration completion. Plus manual extraction via `/orchestray:learn`. Covers LERN-01 and LERN-04.
- **D-02:** Four pattern categories — decomposition (task breakdown strategies), routing (model choices that worked), specialization (dynamic agents that added value), anti-patterns (approaches that failed). Each pattern is tagged with its category.
- **D-03:** Learn from both success and failure — successful orchestrations yield positive patterns (decomposition, routing, specialization). Failed or escalated orchestrations yield anti-patterns. Both are valuable.

### Pattern Storage & Format
- **D-04:** Flat directory with category prefix — `.orchestray/patterns/{category}-{name}.md`. All patterns in one directory, category in filename. Simple globbing, easy to browse. No separate index file.
- **D-05:** Essential metadata per pattern — YAML frontmatter with: `confidence` (0.0-1.0), `times_applied` (integer), `last_applied` (ISO date or null), `created_from` (orchestration ID), `category` (decomposition|routing|specialization|anti-pattern). Sufficient for matching, pruning, and lifecycle.
- **D-06:** Max 50 patterns, prune by lowest score — when count exceeds 50, compute `confidence * times_applied` for each pattern and remove the lowest-scoring ones until count is 50. Keeps the registry lean and relevant.

### Pattern Application During Decomposition
- **D-07:** Keyword + description matching — PM reads pattern filenames and frontmatter descriptions from `.orchestray/patterns/`, matches against the current task description using its reasoning. Same approach as specialist matching (Phase 6 D-02). Consistent pattern across features.
- **D-08:** Advisory influence — patterns inform but don't dictate PM decisions. PM mentions "Based on past pattern X, using approach Y" in its reasoning when a pattern is relevant. Transparent but flexible — PM can override when context differs.
- **D-09:** Confidence feedback loop — after applying a pattern in an orchestration, PM updates the pattern's confidence based on the orchestration result. Success increases confidence (up to 1.0), failure decreases it (down to 0.0). Implements LERN-03 lifecycle.

### Learn Skill (/orchestray:learn)
- **D-10:** Specific orchestration by ID — `/orchestray:learn [orch-id]` reads events.jsonl from `.orchestray/history/{orch-id}/` and extracts patterns. If no ID given, uses the most recent orchestration. Covers LERN-04.
- **D-11:** Summary + pattern files output — shows extracted patterns in a table (name, category, confidence), writes .md files to `.orchestray/patterns/`. User sees what was learned before files are written.

### Claude's Discretion
- Exact confidence delta on success/failure (e.g., +0.1 on success, -0.15 on failure)
- Pattern name generation from orchestration context
- How to detect "similar past task" for pattern matching (keyword overlap threshold)
- Pattern template markdown body structure (beyond the frontmatter)
- Whether to add `memory: project` frontmatter to agent definitions (research suggests this for tier 1 learning)
- Pruning frequency — every extraction run or only when cap exceeded

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Existing Code to Extend
- `agents/pm.md` — Section 20 (Specialist Save Protocol), Section 21 (Specialist Reuse Protocol) — similar save/reuse lifecycle to follow
- `agents/pm.md` — Section 12 (Complexity Scoring), Section 13 (Task Decomposition) — where pattern application occurs
- `agents/pm.md` — Section 15 (Cost Tracking) — post-orchestration hook where extraction runs
- `skills/orchestray:run/SKILL.md` — Orchestration flow, completion step where auto-extraction triggers
- `skills/orchestray:specialists/SKILL.md` — Skill pattern for CRUD operations (model for /orchestray:learn)

### Research
- `.planning/research/STACK.md` — Two-tier learning design, pattern template, `.orchestray/patterns/` structure
- `.planning/research/FEATURES.md` — Competitor analysis
- `.planning/research/PITFALLS.md` — Known risks

### Project
- `.planning/PROJECT.md` — v2.0 milestone goals
- `.planning/REQUIREMENTS.md` — LERN-01, LERN-02, LERN-03, LERN-04

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- PM Section 20/21 (Specialist lifecycle) — pattern extraction follows same save-to-directory, check-before-creating approach
- `.orchestray/history/{orch-id}/events.jsonl` — audit data source for pattern extraction
- `skills/orchestray:specialists/SKILL.md` — established skill pattern with CRUD operations
- `bin/collect-agent-metrics.js` — parses events.jsonl, can inform extraction logic

### Established Patterns
- File-based storage in `.orchestray/` with YAML frontmatter + markdown
- PM sections with numbered integration points
- Skills as slash commands with structured output
- Config settings with validation and defaults

### Integration Points
- PM post-orchestration step → trigger pattern extraction (new Section 22)
- PM task decomposition (Section 13) → check patterns before decomposing (new Section 22 subsection)
- PM post-orchestration → update confidence for applied patterns (Section 22 feedback)
- New skill: `skills/orchestray:learn/SKILL.md` → manual extraction
- `.orchestray/patterns/` directory → created at runtime on first extraction

</code_context>

<specifics>
## Specific Ideas

- Pattern template from research/STACK.md: YAML frontmatter (name, category, confidence, times_applied, last_applied, created_from) + markdown body with Context, Approach, Evidence sections
- The PM should briefly mention when it applies a pattern: "Applying pattern 'api-endpoint-decomposition' (confidence 0.85) — splitting by endpoint groups"
- Anti-patterns are just as valuable as positive patterns — "Last time we tried X, the reviewer rejected it because Y"
- Pruning should be transparent: if patterns are removed, PM logs "Pruned 3 low-value patterns" in the audit trail

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-skill-learning-and-pattern-extraction*
*Context gathered: 2026-04-07*
