<!-- PM Reference: Close phase slice — loaded when current_phase ∈
     {close, closing, complete}. Cost tracking, ROI scorecard, pattern
     extraction, correction memory extraction, user-correction post-orch
     detection. Step 1 (audit init) and Step 2 (running cost) of §15 also live
     here even though they fire earlier — they're closure-of-the-orchestration
     concerns and grouped with the rest of cost tracking. -->

# Phase: Close

This slice covers everything from "all groups merged" through orchestration
completion: cost tracking & audit, ROI scorecard, pattern extraction,
correction memory extraction, and user-correction post-orchestration capture.

Cross-phase pointers (validated by `bin/_tools/phase-split-validate-refs.js`):

- The shared infrastructure (state, KB, handoff) is in `(see phase-contract.md §"7. State Persistence Protocol")`, `(see phase-contract.md §"10. Knowledge Base Protocol")`, and `(see phase-contract.md §"11. Context Handoff Protocol")`.
- Pattern application that ran pre-decomposition is `(see phase-decomp.md §"22b. Pattern Application (Pre-Decomposition)")` — close phase reads its application records.
- Routing data accumulated during execute lands in `(see phase-execute.md §"19. Model Routing — Detailed Scoring and Logging")`.
- Verify-fix outcomes feed correction-pattern extraction here from `(see phase-verify.md §"18. Verify-Fix Loop Protocol")`.

---

## 15. Cost Tracking — Detailed Audit Protocols

This section contains the detailed audit initialization and completion event protocols.
For the running cost display and summary reporting, see Section 15 in the main pm.md.

### Step 1: Audit Initialization (Before Spawning Any Agents)

Run this ONCE at orchestration start, before
`(see phase-decomp.md §"13. Task Decomposition Protocol")` and before any
agent is spawned. This ensures hook handlers can correlate events to this orchestration.

1. **Generate orchestration_id:** Use the format `orch-{unix-timestamp}`
   (e.g., `orch-1712345678`). This is the correlation key for all events in this
   orchestration.

2-4. **Initialize audit state with `ox state init`** (replaces: `mkdir -p .orchestray/audit`,
   writing `current-orchestration.json`, and appending the `orchestration_start` event):

   ```bash
   ox state init orch-1712345678 --task="<user task summary -- first 100 chars>"
   ```

   `ox state init` atomically: creates `.orchestray/audit/`, writes `current-orchestration.json`,
   and appends an `orchestration_start` event to `events.jsonl`. It is idempotent — re-running
   with the same `orch-id` is a safe no-op. Verify with `ox state peek --json`.

   > The `orchestration_start` event schema is in `agents/pm-reference/event-schemas.md`
   > §"Section 40: Orchestration Start Event". `ox state init` emits it automatically.

This MUST complete before any agent is spawned so hook handlers can read the
orchestration_id from `current-orchestration.json`.

### Step 2: Running Cost Display During Execution (D-08)

After each agent completes, read `agent_stop` events from `.orchestray/audit/events.jsonl`
for the current orchestration_id. Display a single-line cost summary:
`Agent costs so far: architect ~$0.04 | developer ~$0.06 | Total: ~$0.10`
If no cost data is available, skip display silently.

### Step 3: Orchestration Completion Event

Run this ONCE after all agents have completed and all merges are done (end of
`(see phase-execute.md §"14. Parallel Execution Protocol")` flow or after all sequential
tasks complete).

1. **Aggregate metrics:** Read all `agent_stop` events for this orchestration_id. Sum
   input/output/cache tokens and estimated_cost_usd. Calculate duration_ms. Determine
   status: success (all agents OK), partial (some failed), failure (all failed/aborted).

2. **Mark orchestration complete with `ox state complete`** (replaces: appending
   `orchestration_complete` event and removing `current-orchestration.json`):

   ```bash
   ox state complete --status=success   # or: partial | failure
   ```

   `ox state complete` atomically: appends the `orchestration_complete` event to `events.jsonl`
   and removes `current-orchestration.json`. Idempotent — if no active orchestration exists,
   exits 0 silently. Verify with `ox state peek --json` (status should be `none` after).

   > The `orchestration_complete` event schema is in `agents/pm-reference/event-schemas.md`
   > §"Section 41: Orchestration Complete Event". `ox state complete` emits it automatically.

3. **Archive (durable rotation — 2013-W6-cleanup):** Run `bin/_lib/events-rotate.js`
   to atomically rotate `events.jsonl` for the current orchestration_id into
   `.orchestray/history/<orch-id>/events.jsonl`. This step uses a three-state sentinel
   (`started` → `archived` → `truncated`) at `.orchestray/state/.events-rotation-<orch-id>.sentinel`
   to make the rotation crash-safe and idempotent:

   - **No sentinel → fresh run.** Filters the live `events.jsonl` to rows matching
     the current orchestration_id, writes them to the archive with fsync for durability,
     then atomically replaces the live file (rename-dance; no `fs.truncateSync`).
   - **Sentinel `"started"` → crashed before archive complete.** Deletes the partial
     archive, restarts from the filter step.
   - **Sentinel `"archived"` → crashed after archive, before truncate.** Skips the
     archive-write (idempotent), proceeds directly to the rename-dance truncate.
   - **Sentinel `"truncated"` → crashed after truncate, before sentinel delete.** Just
     deletes the sentinel.
   - **Belt-and-braces:** If the archive already exists on disk and the live file is
     non-empty (sentinel was lost), skips the archive-write and proceeds to truncate.
     This is the minimum-floor idempotence invariant (resolved OQ-T2-2).

   After `events-rotate` completes, the live `events.jsonl` contains only rows for
   other orchestrations (empty for the common single-orchestration case). The 2.0.12
   W5 stop-gap scan cap (`ORCHESTRAY_MAX_EVENTS_BYTES`, default L size) remains as
   defense-in-depth — the durable rotation does not remove it.

   To invoke:
   ```bash
   node -e "
   const { rotateEventsForOrchestration } = require('./bin/_lib/events-rotate');
   const result = rotateEventsForOrchestration(process.cwd(), '<orch-id>');
   if (result.error) { process.stderr.write('rotation error: ' + result.error.message + '\n'); process.exit(1); }
   process.stdout.write(JSON.stringify(result) + '\n');
   "
   ```
   Or call `rotateEventsForOrchestration(cwd, orchestrationId)` directly from Node.

   After rotation completes, delete `current-orchestration.json`.

4. **Report cost summary** to user: `Cost estimate: ~$X total (agent ~$Y, ...) | Tokens: N input / N output`

4.5. **Cost prediction accuracy**: If `agents/pm-reference/cost-prediction.md` §31 produced a pre-execution estimate, compare predicted vs actual and log `cost_prediction` event per §31.

5. **Update pattern confidence** per §22c below for any applied patterns.

6. **Project-specific failure memory:** If verify-fix loops or re-plans occurred, write
   the codebase-specific failure reason to `.orchestray/kb/facts/failure-{slug}.md`
   with `ttl_days: 60`. Include in future delegation prompts.

7. **Extract new patterns** per §22a below from the archived history.

7.1. **Thread creation/update**: If `enable_threads` is true, create or update a thread
   entry for this orchestration per `agents/pm-reference/orchestration-threads.md`
   §40a/40c. This runs first because its output is self-contained and fast.

7.2. **Outcome probe creation**: If `enable_outcome_tracking` is true, create an outcome
   probe for this orchestration per `agents/pm-reference/outcome-tracking.md` §41a.
   The probe records delivered files, tests added, and patterns applied for deferred
   quality validation.

7.3. **Persona refresh check**: If `enable_personas` is true, check whether persona
   generation or refresh is triggered per `agents/pm-reference/adaptive-personas.md`
   §42a. Generate or refresh personas for agent types used 2+ times across recent
   orchestrations.

7.4. **Replay analysis**: If `enable_replay_analysis` is true AND friction signals are
   detected (re-plans, verify-fix failures, cost overruns >50%, confidence <0.4, or turns
   >2x budget), run counterfactual analysis per `agents/pm-reference/replay-analysis.md`
   §43a-43c. Write replay pattern to `.orchestray/patterns/replay-{orch-id}.md`.

7.5. **Consequence forecast validation (Phase B)**: If `enable_consequence_forecast` is
   true and `.orchestray/state/consequences.md` exists, run §39 Phase B (in
   `agents/pm-reference/tier1-orchestration-rare.md`) to compare predictions against
   the actual git diff. Include accuracy summary in the final report.
   The `consequence_forecast` event is emitted automatically by
   `bin/pm-emit-state-watcher.js` (PostToolUse hook) on every Phase A/B write to
   `.orchestray/state/consequences.md` — no manual append needed. (v2.2.9 B-8;
   belt-and-braces prose retained for v2.2.9, deletion candidate in v2.2.10.)

7.6. **Drift validation**: If `enable_drift_sentinel` is true, run §39.D (in
   `agents/pm-reference/drift-sentinel.md`) post-execution check. Load all enforced
   invariants (extracted, static, session), check the git diff against each, and
   surface any violations to the user. Log `drift_check` event to
   `.orchestray/audit/events.jsonl`. If error-severity violations exist, present
   user options (fix / update decision / acknowledge) before proceeding. See
   `agents/pm-reference/drift-sentinel.md` for the full post-execution protocol.

8. **Auto-documenter**: After all post-completion steps above, run §36
   (Auto-Documenter Detection, in `agents/pm-reference/auto-documenter.md`). If
   `auto_document` is true and a feature addition is detected, spawn the documenter
   agent as a non-blocking bonus step.

9. **Check for user correction feedback**: After the auto-documenter step, evaluate the
   user's next response per §34c below. If corrective feedback is found, extract as a
   user-correction pattern. (Moved here from step 7.5 to avoid blocking post-processing
   steps 7.5, 7.6, and 8 on an out-of-band user wait.)

### Step 4: Threshold Calibration Signal

After recording completion metrics, evaluate whether this orchestration was appropriately
triggered. Write a threshold calibration signal to patterns:

- **Over-orchestrated**: Zero re-plans, single agent did 90%+ of work, total turns < 10.
  Signal: "threshold_too_low" — suggests raising effective threshold.
- **Right-sized**: Multiple agents contributed meaningfully, orchestration flow was needed.
  Signal: none.
- **Under-orchestrated (from solo path)**: PM handled a task solo but it took >20 turns
  or produced >5 file changes. Signal: "threshold_too_high" — suggests lowering threshold.

Store signals in `.orchestray/patterns/` as category `threshold`:
```json
{"type": "threshold_signal", "score": N, "signal": "threshold_too_low|threshold_too_high", "task_summary": "...", "timestamp": "ISO8601"}
```

**Adaptive threshold application** (in pm.md §0 scoring):
> Read `agents/pm-reference/scoring-rubrics.md` §"Adaptive Threshold Calibration"
> for the rules on adjusting the effective threshold based on accumulated signals.

Never modify `config.json` — only adjust the PM's internal effective threshold for the
current session based on evidence.

### 15.Z: ROI Scorecard Generation

After steps 1-9 above complete, generate an **Orchestration ROI Scorecard** that quantifies
the value delivered alongside the cost. This scorecard MUST be included in the final
summary reported to the user (per pm.md §8 Communication Protocol).

**Metrics derivation:**

1. **Agents used:** Count distinct agents spawned in this orchestration. List their types.
2. **Issues caught pre-merge:** Count `severity: "error"` and `severity: "warning"` from
   all reviewer result `issues` arrays in this orchestration.
3. **Verify-fix rounds:** From `(see phase-verify.md §"18. Verify-Fix Loop Protocol")`
   state tracking -- count how many verify-fix rounds occurred and how many resolved
   successfully.
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

## 22. Pattern Extraction & Application Protocol

Orchestray learns from past orchestrations by extracting reusable patterns and applying
them to future task decomposition. This makes the PM smarter over time. Patterns are
stored as markdown files in `.orchestray/patterns/` with YAML frontmatter metadata.

Four categories of patterns (per orchestration experience):
- **decomposition**: Task breakdown strategies that led to clean success
- **routing**: Model routing decisions that proved correct without escalation
- **specialization**: Dynamic agents saved as specialists or successful specialist reuses
- **anti-pattern**: Re-plan triggers, verify-fix failures, escalations -- what went wrong

> **Pattern application** (pre-decomposition retrieval) lives in
> `(see phase-decomp.md §"22b. Pattern Application (Pre-Decomposition)")`.
> The extraction / confidence-feedback / pruning steps below run post-orchestration.

### 22a. Automatic Pattern Extraction (Post-Orchestration)

Run AFTER §15 step 3 above completes. Extract patterns from the archived audit trail
at `.orchestray/history/<orch-id>/events.jsonl`.

### 22c. Confidence Feedback Loop

Run AFTER orchestration completes but BEFORE extracting new patterns (22a above). Update
confidence scores for applied patterns: +0.1 on success, -0.2 on failure.

#### §22c Stage A — Post-Decomposition Warn Mode (v2.0.15, ships unconditionally)

**What it means.** During the post-decomposition window (after the first `Agent()` spawn
of an orchestration), the PM is expected to have called either
`mcp__orchestray__pattern_record_application` OR `mcp__orchestray__pattern_record_skip_reason`
for this `orchestration_id`. If neither call is recorded in `mcp-checkpoint.jsonl` (or in
`events.jsonl` for skip-reason) by the time the session compacts, the
`bin/record-pattern-skip.js` PreCompact hook emits a `pattern_record_skipped` advisory
event to `events.jsonl`.

**Stage A behaviour.** Advisory only — no spawn is blocked. The event is a warn-mode
signal for observability and analytics. The PM should treat a `pattern_record_skipped`
event as a cue to complete the §22b protocol on the next orchestration, not as a gate
failure.

#### §22c Stage C — Second-Spawn Gate (v2.0.16, shipped)

**What shipped in 2.0.16.** The `bin/gate-agent-spawn.js` PreToolUse:Agent hook now
enforces a post-decomposition check on second-and-subsequent `Agent()` spawns within an
orchestration. Enforcement mode is controlled by
`mcp_enforcement.pattern_record_application` in `.orchestray/config.json`:

- **`hook-strict`** (default in 2.0.16): on a second spawn with no post-decomposition
  record, emit a `mcp_checkpoint_missing` event to `events.jsonl` with
  `phase: 'post-decomposition'` and exit 2 (deny spawn). Re-run §22b (in phase-decomp.md)
  to unblock — call the missing tool, then retry.
- **`hook-warn`** (soft mode): on a second spawn with no post-decomposition record,
  emit a stderr warning and allow the spawn. The PM should call
  `mcp__orchestray__pattern_record_application` or `mcp__orchestray__pattern_record_skip_reason`
  before the next spawn.
- **`hook`, `prompt`, `allow`**: Stage C gate is skipped entirely for these values.

**First-spawn carve-out:** the gate only activates after `routing.jsonl` exists for the
current orchestration (i.e., after decomposition). Pre-decomposition spawns are not gated.

**Re-entry on hook-strict block.** If a second spawn is blocked under `hook-strict`,
follow the §22b.R re-entry protocol (in phase-decomp.md): call
`mcp__orchestray__pattern_record_application` (or
`mcp__orchestray__pattern_record_skip_reason`) for the current `orchestration_id`,
then retry the spawn. The gate reads both `mcp-checkpoint.jsonl` and `events.jsonl` for
the record — either path satisfies the requirement. Emergency override: set
`mcp_enforcement.global_kill_switch=true` or set `pattern_record_application` to `allow`.

**Escalation ladder:**
- Stage A (v2.0.15): warn, allow — advisory event in `events.jsonl`
- Stage B (v2.0.16): `hook-warn` default (warn+allow on second spawn); `hook-strict` opt-in (block)
- Stage C (v2.0.16, shipped): `hook-strict` is now the default — OQ1 field-data gate cleared

### 22d. Pruning

Run AFTER writing new patterns. Cap at 50 patterns, prune lowest `confidence * times_applied`.

> Read `agents/pm-reference/extraction-protocol.md` §§22a–22e for the full extraction steps, pattern file template, application protocol, confidence feedback details, and pruning rules.

### 22.Y: Trace-Aware Pattern Extraction

When `enable_introspection` is true, reasoning traces enrich pattern extraction (22a above)
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
  `(see phase-contract.md §"10. Knowledge Base Protocol")` writing protocol.
- Examples of useful discoveries: "auth module uses in-memory token store",
  "database migrations run synchronously", "test fixtures are shared via a global setup".
- Examples to skip: "file X has 200 lines" (too specific), "import order matters in
  this file" (too narrow).

**Integration with 22a:** These trace-derived candidates are added to the same extraction
pass as audit-trail-derived patterns. They do not run as a separate step.

### 22.D: Design-Preference Pattern Learning

When a user resolves a disagreement (surfaced by §18.D in phase-verify.md) with "keep
current" or "apply suggestion", save a design-preference pattern following the format in
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

1. During `(see phase-decomp.md §"22b. Pattern Application (Pre-Decomposition)")`,
   design-preference patterns are loaded alongside other pattern types from
   `.orchestray/patterns/`.
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
- Application without disagreement (§18.D auto-applied): confidence += 0.1
  (cap 1.0), increment `times_applied`.

**Pruning:** Design-preference patterns participate in the same pruning pass as other
pattern types (§22d above). They are scored by `confidence * times_applied` alongside
decomposition, routing, specialization, and anti-pattern entries.

### 22.f — Auto-extraction first-run notice

When `auto_learning.extract_on_complete.enabled` is true, auto-extraction may propose
patterns at the end of each orchestration. This section governs how the PM surfaces
that to the user — exactly once per run, never noisily.

**Trigger condition (checked at SessionStart and after each orchestration completes):**

1. Read the most-recent `auto_extract_staged` event from `.orchestray/audit/events.jsonl`
   where `orchestration_id` matches the current session's completed orchestration.
2. If no such event exists, or `proposal_count === 0`, skip entirely — nothing to surface.
3. If `shadow === true` in the event, skip — shadow-mode runs are silent to humans.
4. Check for sentinel `.orchestray/state/pm-auto-extract-notice-sent-{session_id}.flag`.
   If the sentinel exists, skip — notice was already sent this session.

**When all conditions are met, emit one line to the user:**

> "Auto-extraction staged N pattern proposals from this orchestration. Review with
> `/orchestray:learn list --proposed`, then `/orchestray:learn accept <slug>` or `reject`."

Where N = `proposal_count` from the event.

**Then immediately touch the sentinel** (create the file):
`.orchestray/state/pm-auto-extract-notice-sent-{session_id}.flag`

This prevents re-emission within the same session. One notice per orchestration per session.

**Implementation notes:**
- `{session_id}` = the current orchestration_id or a session-scoped token available in state.
- Sentinel creation is best-effort; if it fails, the notice may re-appear — acceptable.
- If `proposal_count === 0` (breaker tripped, all proposals rejected, etc.), DO NOT emit.
- No second notice for subsequent orchestrations in the same session; sentinel gates all.

---

## 30. Correction Memory Protocol

Learn from verify-fix loops (`(see phase-verify.md §"18. Verify-Fix Loop Protocol")`)
so the same mistakes are never repeated.

### Extraction (after successful verify-fix loop)
When `(see phase-verify.md §"18. Verify-Fix Loop Protocol")` completes a successful
fix (reviewer passes after developer correction):
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

Application happens at delegation time — the runtime version lives in
`(see phase-execute.md §"30.application — Correction Memory Application (delegation-time)")`.

### Integration with §18 Verify-Fix

Add this step to the END of `(see phase-verify.md §"18. Verify-Fix Loop Protocol")`'s
successful fix flow: After the reviewer passes on the fix, trigger §30 extraction
above before reporting success.

---

## 34. User Correction Protocol

Capture direct user corrections as high-confidence patterns for future orchestrations.

### 34a. Detection During Orchestration

After receiving any user message during an active orchestration, evaluate BEFORE responding:

**Is this a correction?** The message corrects the system's approach if it:
1. Contradicts an agent's output or PM decision ("no", "that's wrong", "don't do it that way")
2. Redirects strategy ("use X instead", "handle this differently", "split this into steps")
3. Provides missing domain knowledge ("actually, this API requires...", "that field is deprecated")

**NOT a correction:** Checkpoint responses (continue/abort/modify), status questions, output review requests, plan modifications via `agents/pm-reference/checkpoints.md` §28.

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
4. Write `.orchestray/patterns/user-correction-{slug}.md` (template in 34d below)
5. Apply immediately to current orchestration:
   - Pending tasks affected: update delegation prompt
   - Completed tasks affected: note for user, suggest re-plan
     (`(see phase-verify.md §"16. Adaptive Re-Planning Protocol")`) if significant
6. Resume orchestration

### 34c. Detection Post-Orchestration

After delivering the final summary (§15 step 3, after step 7):
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

### 34f. Application

Application happens at delegation time — the runtime version lives in
`(see phase-execute.md §"34f. User Correction Application During Delegation")`.

---

> *[Rare path: consequence-forecasting (§39) and drift-check (§39.D) protocols. PM loads
> tier1-orchestration-rare.md via Tier-2 dispatch when `enable_consequence_forecast` or
> `enable_drift_sentinel` is `true` in `.orchestray/config.json`.]*
