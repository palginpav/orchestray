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

### Per-Model Effort Availability

| Effort | Haiku | Sonnet 4.6 | Opus 4.6 | Opus 4.7 |
|--------|-------|-----------|---------|---------|
| low | ✓ | ✓ | ✓ | ✓ |
| medium | ✓ | ✓ | ✓ | ✓ |
| high | ✓ | ✓ | ✓ | ✓ |
| xhigh | — (coerces to high) | — (coerces to high) | — (coerces to high) | ✓ |
| max | — (coerces to high) | ✓ | ✓ | ✓ |

`xhigh` was introduced in Claude Code v2.1.111 (2026-04-16) as the recommended default for Opus 4.7 on most coding and agentic tasks. If you specify `xhigh` on a model that does not support it, Claude Code silently falls back to the highest supported level at or below the one requested — no error is raised and nothing breaks.

### Override Criteria

Evaluate each subtask for reasoning depth. Override the default effort when:

- **Upgrade sonnet to high**: Security-sensitive logic, complex algorithm implementation,
  multi-file refactoring with subtle dependencies
- **Upgrade opus to xhigh**: Novel system design, cross-cutting architecture, agentic tasks
  where reasoning depth matters. `xhigh` is the Opus 4.7 recommended default; it coerces
  safely to `high` on Opus 4.6. Use xhigh as the standard upgrade path, not max.
- **Upgrade opus to max**: Tasks that combine very high complexity AND very high stakes
  (e.g., security threat modeling with cross-cutting risks, novel system design where failure
  has a catastrophic blast radius). Anthropic guidance: max is prone to overthinking — test
  before adopting broadly. Max is an explicit escalation path, not a default.
- **Downgrade sonnet to low**: Pure boilerplate/scaffold generation, simple file
  rename/move operations, straightforward config file updates

**Agent-specific effort overrides (for dynamic agents only):**
- Inventor dynamic tasks: always xhigh (or max for exceptional escalation)
- Security audit dynamic tasks: always high or xhigh
- Simple scaffold/template tasks: low regardless of model

### Anti-Patterns

| Combination | Why It Is Wasteful | Do Instead |
|-------------|-------------------|------------|
| Haiku + high | Haiku's ceiling is low regardless of effort | Use Sonnet instead |
| Haiku + max | max coerces to high on Haiku — you pay Haiku price, get Haiku ceiling | Use Sonnet/medium or Opus/high |
| Opus + low | Pays Opus price for minimal reasoning | Use Sonnet/low or Haiku/low |
| Opus 4.7 + max (default) | max prone to overthinking per Anthropic; xhigh is recommended default | Use xhigh; reserve max for explicit escalation |

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

## v2.0.10 Feature Interactions

The following v2.0.10 features run automatically based on their config flags and do NOT
directly affect complexity scoring or model routing decisions:

- **Orchestration Threads (§40)**: Cross-session context loaded pre-decomposition.
- **Outcome Tracking (§41)**: Lazy probe validation at session start (opt-in).
- **Adaptive Personas (§42)**: Per-agent behavioral directives injected at delegation time.
- **Replay Analysis (§43)**: Advisory counterfactuals for friction orchestrations.

These features feed context into the PM's decomposition and delegation steps but do not
alter complexity score, effort routing, or model selection. If a thread or replay pattern
surfaces a caution, the PM should weigh it during decomposition but must still score the
task via the standard 4-signal rubric above.

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

| Agent Type | Base Turns | Frontmatter Ceiling | Rationale |
|------------|-----------|---------------------|-----------|
| architect | 15 | 45 | Design tasks need exploration + writing |
| developer | 12 | 65 | Implementation is focused but iterative |
| reviewer | 10 | 45 | Review is read-heavy, fewer write turns |
| debugger | 15 | 55 | Investigation requires broad exploration |
| tester | 12 | 55 | Test writing is similar in scope to implementation |
| documenter | 8 | 45 | Documentation is straightforward writing |
| refactorer | 15 | 65 | Refactoring requires careful incremental changes |
| inventor | 20 | 65 | Novel creation needs the most exploration room |
| security-engineer | 15 | 45 | Security analysis is thorough and exploratory |
| haiku-scout (P2.2) | 3 | 5 | Read-only I/O worker; haiku/low; one Read/Glob/Grep per spawn |

The "Frontmatter Ceiling" column reflects the default values in each agent's
frontmatter `maxTurns` field. These can be **overridden per-agent** via the
`max_turns_overrides` config key — see PM Section 3.Y and the config skill for
the full override protocol. When an override is set, the PM uses the override
value as the ceiling instead of the frontmatter default.

### Formula

```
file_factor = count(files_read + files_write)
complexity_factor = subtask_score / 4
estimated_turns = round(base_turns[agent_type] * (0.5 + 0.5 * complexity_factor) + file_factor * 2)

# Ceiling resolves from config override first, then frontmatter default
ceiling = config.max_turns_overrides[agent_type] or frontmatter_max
max_turns = min(estimated_turns, ceiling)
```

### Worked Examples

**Example 1: Simple developer task** (score 3, 2 files read, 1 file write)
```
file_factor = 3
complexity_factor = 3 / 4 = 0.75
estimated_turns = round(12 * (0.5 + 0.5 * 0.75) + 3 * 2) = round(12 * 0.875 + 6) = round(16.5) = 17
max_turns = min(17, 65) = 17
```

**Example 2: Complex architect task** (score 12, 10 files read, 5 files write)
```
file_factor = 15
complexity_factor = 12 / 4 = 3.0
estimated_turns = round(15 * (0.5 + 0.5 * 3.0) + 15 * 2) = round(15 * 2.0 + 30) = round(60) = 60
max_turns = min(60, 45) = 45  (capped by frontmatter max)
```

**Example 3: Simple documenter task** (score 2, 1 file read, 1 file write)
```
file_factor = 2
complexity_factor = 2 / 4 = 0.5
estimated_turns = round(8 * (0.5 + 0.5 * 0.5) + 2 * 2) = round(8 * 0.75 + 4) = round(10) = 10
max_turns = min(10, 45) = 10
```

### Budget Exhaustion Retry

When an agent returns `status: partial` due to turn budget exhaustion, the PM may retry
with `1.5x` the original calculated budget (rounded up), capped at the resolved ceiling
(config override or frontmatter). This counts as one retry per Section 5. Do not retry
more than once for budget exhaustion. If the same agent type exhausts its budget on
multiple orchestrations, recommend raising `max_turns_overrides[agent_type]` in config.
