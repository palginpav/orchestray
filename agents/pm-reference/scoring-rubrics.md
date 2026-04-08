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

---

## Adaptive Threshold Calibration

The PM's effective complexity threshold adjusts based on historical signals from past
orchestrations. This self-calibration makes Orchestray smarter over time without
requiring user configuration changes.

### Reading Threshold Signals

During Section 0 scoring, before applying the threshold:

1. Read `.orchestray/patterns/` for files matching the `threshold` category
   (type: "threshold_signal" in the JSON content)
2. Count recent signals (last 10 orchestrations):
   - `threshold_too_low` signals: orchestrations that were over-orchestrated
   - `threshold_too_high` signals: solo tasks that should have been orchestrated
3. Apply adjustment rules below

### Adjustment Rules

- If 3+ `threshold_too_low` signals in last 10: effective threshold = config threshold + 1
- If 3+ `threshold_too_high` signals in last 10: effective threshold = config threshold - 1
- If signals are mixed or fewer than 3 of either: no adjustment (use config threshold)
- Maximum adjustment: ±1 from the configured threshold
- Never go below 2 or above 10 (hard bounds)

### Damping

- Require 3 consistent signals before adjusting (prevents oscillation from outliers)
- Signals older than 30 days are ignored (project characteristics change)
- Each signal is used only once for calibration (mark as consumed after reading)

### Transparency

When an adjustment is active, include it in the complexity announcement:
"Complexity: Medium (5/12, effective threshold: 5, adjusted from 4 based on 3 over-orchestration signals)"

When no adjustment, the standard announcement:
"Complexity: Medium (5/12)"

### Integration Points

- **Section 0 (Auto-Trigger Protocol):** Read signals and compute effective threshold
  before scoring comparison
- **Section 15 Step 4 (Threshold Calibration Signal):** Write new signal after each
  orchestration completes
- **`/orchestray:analytics`:** Display current effective threshold and signal history
