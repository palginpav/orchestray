# Scoring Rubrics & Model Routing Reference

Detailed scoring signal definitions and model routing decision criteria.
For score ranges and integration points, see the main PM prompt Sections 12 and 19.

---

## Section 12: Complexity Scoring Signals

Evaluate every task using these four signals, each scoring 0-3 points:

**1. File/Module Count** (estimated files needing modification):
- 0 points: 1 file
- 1 point: 2 files
- 2 points: 3-5 files
- 3 points: 6+ files

**2. Cross-Cutting Concerns** (count distinct domains: auth, DB, UI, API, tests, config, infra):
- 0 points: 1 domain
- 1 point: 2 domains
- 2 points: 3 domains
- 3 points: 4+ domains

**3. Task Description Signals**:
- 0 points: Short, clear, single action
- 1 point: >100 chars or minor ambiguity
- 2 points: >200 chars or ambiguity markers ("maybe", "or", "consider")
- 3 points: >300 chars or scope markers ("all", "entire", "across", "everything")

**4. Keyword Patterns**:
- 0 points: "fix", "typo", "add field", "update", "rename"
- 1 point: "add", "create", "implement" (single feature)
- 2 points: "refactor", "redesign", "restructure"
- 3 points: "migrate", "overhaul", "rewrite", "rebuild"

---

## Section 19: Model Routing Decision Table

1. **Read config overrides** from `.orchestray/config.json`:
   - If `force_model` is set (not null): use that model for ALL agents. Skip all routing
     logic below.
   - Otherwise, read `model_floor`, `haiku_max_score`, `opus_min_score`.

2. **For each subtask** in the task graph (Section 13 output), determine the model:

   - **Haiku**: ONLY for bounded utility tasks that score <= `haiku_max_score` (default 3)
     AND are one of: formatting/linting output, boilerplate/scaffold generation, simple
     file reads/lookups, grep/search operations. NEVER use Haiku for architect or reviewer
     roles.
   - **Opus**: For subtasks scoring >= `opus_min_score` (default 6) -- architecture
     decisions, complex debugging, security audits, cross-cutting refactors, novel system
     design.
   - **Sonnet**: Everything else (default workload). Standard implementation, code
     generation, test writing, reviews of non-complex changes.

   **New agent routing defaults:**
   - **Debugger**: Sonnet default. Opus for complex multi-file bugs or concurrency issues (score >= 6).
   - **Tester**: Sonnet default. Haiku acceptable for simple boilerplate test generation (score <= 3).
   - **Documenter**: Sonnet default. Haiku acceptable for simple changelog updates (score <= 3).

3. **Apply `model_floor` enforcement**: if the routed model is weaker than `model_floor`,
   upgrade to `model_floor`. Model strength order: haiku < sonnet < opus.

4. **Check for natural language override** in the user's original prompt: "use opus",
   "use haiku", "use sonnet" -- if detected, override the routing decision for ALL
   subtasks.

---

## Section 19: Auto-Escalation Protocol

When an agent fails (status != success in Section 4 result parsing) or produces poor
results (reviewer rejects in Section 18):

1. If current model is Haiku: retry with Sonnet. If Sonnet also fails: retry with Opus.
2. If current model is Sonnet: retry with Opus.
3. If current model is Opus: do NOT retry with a different model -- escalate per
   Section 16 (re-planning) or Section 18 (verify-fix loop).
4. Track escalation count per subtask. Maximum 2 escalations per subtask
   (haiku -> sonnet -> opus).
5. Log each escalation in the routing outcome event.
