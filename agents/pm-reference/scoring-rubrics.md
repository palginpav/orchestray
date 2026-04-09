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
   - **Refactorer**: Sonnet default. Opus for cross-cutting refactors touching 10+ files or changing fundamental patterns (score >= 6).
   - **Debugger**: Sonnet default. Opus for complex multi-file bugs or concurrency issues (score >= 6).
   - **Tester**: Sonnet default. Haiku acceptable for simple boilerplate test generation (score <= 3).
   - **Documenter**: Sonnet default. Haiku acceptable for simple changelog updates (score <= 3).
   - **Security-engineer**: Sonnet default. Opus for full threat modeling or complex security audits (score >= 6). NEVER use Haiku for security reviews.
   - **Inventor**: Opus default. Sonnet only for simple tool creation (score <= 3). NEVER use Haiku for invention tasks.

3. **Apply `model_floor` enforcement**: if the routed model is weaker than `model_floor`,
   upgrade to `model_floor`. Model strength order: haiku < sonnet < opus.

4. **Check for natural language override** in the user's original prompt: "use opus",
   "use haiku", "use sonnet" -- if detected, override the routing decision for ALL
   subtasks.

---

## Section 19: Effort Level Assignment

After model routing determines the model for each subtask, assign the effort level.

### Default Model-Effort Mapping

| Model | Default Effort |
|-------|---------------|
| haiku | low |
| sonnet | medium |
| opus | high |

### Override Criteria

Evaluate each subtask for reasoning depth. Override the default effort when:

- **Upgrade sonnet to high**: Security-sensitive logic, complex algorithm implementation,
  multi-file refactoring with subtle dependencies
- **Upgrade opus to max**: Novel system design with no precedent in the codebase,
  cross-cutting refactors touching 10+ files, tasks where failure has high blast radius
  (data migration, auth changes, schema changes)
- **Downgrade sonnet to low**: Pure boilerplate/scaffold generation, simple file
  rename/move operations, straightforward config file updates

**Agent-specific effort overrides (for dynamic agents only):**
- Inventor dynamic tasks: always high or max
- Security audit dynamic tasks: always high
- Simple scaffold/template tasks: low regardless of model

### Anti-Patterns

| Combination | Why It Is Wasteful | Do Instead |
|-------------|-------------------|------------|
| Haiku + high | Haiku's ceiling is low regardless of effort | Use Sonnet instead |
| Haiku + max | max is Opus 4.6 exclusive | Use Sonnet/medium or Opus/high |
| Opus + low | Pays Opus price for minimal reasoning | Use Sonnet/low or Haiku/low |

### Effort Escalation

When a subtask fails and model escalation occurs (Auto-Escalation Protocol below),
effort escalates with the model:

- haiku/low fails -> sonnet/medium retry
- sonnet/medium fails -> opus/high retry
- If the failed subtask already had an effort override (e.g., sonnet/high), preserve
  the override on escalation: sonnet/high -> opus/high (not opus/max unless depth
  warrants it)

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

---

## Turn Budget Reference

Per-agent base turn counts and the adaptive formula for calculating `maxTurns` at spawn
time. Used by Section 3.Y (Turn Budget Calculation) in the main PM prompt.

### Base Turns by Agent Type

| Agent Type | Base Turns | Frontmatter Max | Rationale |
|------------|-----------|-----------------|-----------|
| architect | 15 | 30 | Design tasks need exploration + writing |
| developer | 12 | 25 | Implementation is focused but iterative |
| reviewer | 10 | 20 | Review is read-heavy, fewer write turns |
| debugger | 15 | 30 | Investigation requires broad exploration |
| tester | 12 | 25 | Test writing is similar in scope to implementation |
| documenter | 8 | 20 | Documentation is straightforward writing |
| refactorer | 15 | 25 | Refactoring requires careful incremental changes |
| inventor | 20 | 40 | Novel creation needs the most exploration room |
| security-engineer | 15 | 30 | Security analysis is thorough and exploratory |

### Formula

```
file_factor = count(files_read + files_write)
complexity_factor = subtask_score / 4
estimated_turns = round(base_turns[agent_type] * (0.5 + 0.5 * complexity_factor) + file_factor * 2)
max_turns = min(estimated_turns, frontmatter_max)
```

### Worked Examples

**Example 1: Simple developer task** (score 3, 2 files read, 1 file write)
```
file_factor = 3
complexity_factor = 3 / 4 = 0.75
estimated_turns = round(12 * (0.5 + 0.5 * 0.75) + 3 * 2) = round(12 * 0.875 + 6) = round(16.5) = 17
max_turns = min(17, 25) = 17
```

**Example 2: Complex architect task** (score 9, 5 files read, 3 files write)
```
file_factor = 8
complexity_factor = 9 / 4 = 2.25
estimated_turns = round(15 * (0.5 + 0.5 * 2.25) + 8 * 2) = round(15 * 1.625 + 16) = round(40.375) = 40
max_turns = min(40, 30) = 30  (capped by frontmatter max)
```

**Example 3: Simple documenter task** (score 2, 1 file read, 1 file write)
```
file_factor = 2
complexity_factor = 2 / 4 = 0.5
estimated_turns = round(8 * (0.5 + 0.5 * 0.5) + 2 * 2) = round(8 * 0.75 + 4) = round(10) = 10
max_turns = min(10, 20) = 10
```

### Budget Exhaustion Retry

When an agent returns `status: partial` due to turn budget exhaustion, the PM may retry
with `1.5x` the original calculated budget (rounded up), capped at frontmatter max.
This counts as one retry per Section 5. Do not retry more than once for budget exhaustion.
