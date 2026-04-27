<!-- PM Reference: Loaded by Tier-2 dispatch (see pm.md dispatch table) on rare-path triggers.
     Do not load this file on common-path orchestrations (architect → developer → reviewer chains). -->

# Tier 1 Rare-Path Protocols

These sections are extracted from `tier1-orchestration.md` because they fire on fewer than 5%
of orchestrations. They are loaded on-demand via the Tier-2 dispatch table in `pm.md` when
one of the following observable conditions is met:

- Orchestration status in `.orchestray/state/orchestration.md` is `paused`, `redo_pending`,
  or `replay_active`
- The `cost-budget-check` hook has emitted a hard-block event in the current turn
- `enable_drift_sentinel` or `enable_consequence_forecast` flag is `true` in
  `.orchestray/config.json`

---

## 4.Y: Reasoning Trace Distillation

After processing any agent result with status `"success"` or `"partial"` (in Section 4),
check whether to extract a reasoning trace. This step runs AFTER result parsing and
post-condition validation (4.X) but BEFORE proceeding to the next task.

**Gate condition:** `enable_introspection` must be `true` in `.orchestray/config.json`.
Also requires: completed agent was NOT Haiku-tier; result status is `"success"` or `"partial"`.

**Protocol:** See `agents/pm-reference/introspection.md` for the distiller prompt template
and trace file format. In summary:
1. Spawn a Haiku distiller with `model: haiku`, `effort: low`.
2. Write trace to `.orchestray/state/traces/task-<id>-trace.md`.
3. Log `introspection_trace` event to `.orchestray/audit/events.jsonl`.

---

## 3.Z: Confidence Protocol Injection

When `enable_backpressure` is true, append confidence checkpoint instructions to every
delegation prompt. Use the exact template from `agents/pm-reference/delegation-templates.md`
(section "Confidence Checkpoint Instructions"), replacing `{TASK_ID}` with the subtask ID.
Create `.orchestray/state/confidence/` if needed.

> See `agents/pm-reference/cognitive-backpressure.md` for the full guide and PM reaction table.

---

## §3.Y: Adaptive Verbosity (Response-Length Budgeting)

When `adaptive_verbosity.enabled === true` AND `v2017_experiments.adaptive_verbosity === 'on'`
are both set in `.orchestray/config.json`, append a response-length budget line to every
delegation prompt.

**Budget formula:** `budget = base_response_tokens × (phase_position >= 0.5 ? reducer_on_late_phase : 1.0)`
where `base_response_tokens` defaults to 2000, `reducer_on_late_phase` defaults to 0.4.

Inject AFTER all other sections and BEFORE confidence checkpoints (§3.Z):
```
Response budget: ~{N} tokens. Return a summary of ≤ {N} words covering only the
deliverables explicitly requested. Omit exploration narration, re-statements of the
task, and verbose section headers.
```

Reviewer floor: `budget = max(budget, 600)`. Final verify-fix reviewer: skip injection.
Haiku-tier agents: skip injection — they are already terse.

---

## 4.Z: Confidence Signal Reading

After processing any agent result, if `enable_backpressure` is true, check for a confidence
file at `.orchestray/state/confidence/task-{TASK_ID}.json`. Apply PM reaction per the table
in `cognitive-backpressure.md`. Override agent status if confidence < 0.4 (partial) or
< 0.2 (failure). Log `confidence_signal` event.

---

## 4.V: Visual Review Integration

After a developer completes a subtask, if `enable_visual_review` is true AND the developer
changed UI files (`*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `*.css`, `*.scss`, `*.less`,
`*.html`, `*.erb`, `*.ejs`, `*.module.css`), trigger visual review.

**Protocol:** Load `agents/pm-reference/visual-review.md` for the screenshot discovery
protocol. If screenshots found, include them in the reviewer delegation using the screenshot
injection template from `delegation-templates-detailed.md`. Log `visual_review` event.

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

## 6.S: Sentinel-Check Protocol (W7 v2.0.18)

The PM does NOT need to poll for pause/cancel sentinels explicitly. The PreToolUse:Agent
hook (`bin/check-pause-sentinel.js`) intercepts every Agent() spawn automatically.

**What happens at each group boundary:**

- If **no sentinel** is present: the hook exits 0, the spawn proceeds normally.
- If **pause.sentinel** exists: the hook exits 2, Claude Code surfaces a block message.
  The PM stops, shows the user: "Orchestration paused. Run `/orchestray:state pause --resume` to continue."
  Do NOT retry the spawn. Do NOT continue to the next group.
- If **cancel.sentinel** exists (and past the grace window): the hook exits 2
  (same as pause — Claude Code only treats non-zero PreToolUse exit codes of 2 as a block).
  The PM distinguishes cancel from pause by reading the sentinel file, not the exit code.
  When `.orchestray/state/cancel.sentinel` is present, the PM executes the clean-abort
  sequence (below) and stops.

**PM clean-abort sequence (on cancel sentinel detection):**

1. Read `.orchestray/state/cancel.sentinel` to get `orchestration_id`.
2. Rename `.orchestray/state/` to `.orchestray/history/orch-<id>-cancelled/`
   (preserves `events.jsonl` for post-mortem). Use Bash `mv`.
3. Append `state_cancel_aborted` event to `.orchestray/audit/events.jsonl`.
4. Report to user: "Orchestration <id> cancelled and archived to history/."
5. Stop. Do not attempt further agent spawns.

**Sentinel persistence:** sentinels survive session restarts. `/orchestray:resume`
reads sentinel state before resuming — if a pause or cancel sentinel is present,
it surfaces the block rather than blindly restarting.

**Kill flag:** if `state_sentinel.pause_check_enabled: false` is set in config.json,
the hook exits 0 unconditionally. The PM can then read sentinels explicitly if needed,
but the automatic gate is disabled.

---

## 6.T: Preview and Redo Protocol (W8 v2.0.18)

### Preview Mode

When the invocation prompt contains the text "PREVIEW MODE", the PM MUST:

1. Score complexity (Section 12) and decompose the task into W-items (Section 13).
2. Print the W-item table:
   ```
   Cost estimates are approximate; actual usage will vary.
   | W  | Title | Agent | Model/Effort | Size | Est. Cost | Depends on |
   | -- | ----- | ----- | ------------ | ---- | --------- | ---------- |
   ```
   Cost formula (PREVIEW DISPLAY ONLY): `estimate = base_cost(size) × model_multiplier`
   - `base_cost`: XS=$0.25, S=$0.45, M=$0.70, L=$1.20, XL=$2.50
   - `model_multiplier`: haiku/low=0.35, sonnet/medium=1.0, opus/high=2.97
   - **Scope:** these multipliers exist ONLY to render the preview table above.
     They are NOT consulted by any production billing path. The authoritative
     pricing table is `bin/_lib/cost-helpers.js:33-37` (`BUILTIN_PRICING_TABLE`,
     haiku $1/$5, sonnet $3/$15, opus $5/$25 per 1M tokens) plus the cache
     multipliers at `bin/collect-agent-metrics.js:114-123` (cache-read 0.1×,
     cache-create 1.25×). When Anthropic changes per-token pricing, update
     `cost-helpers.js`; this preview table is downstream and self-contained.
   - **Tokenizer caveat:** the opus multiplier was recalibrated from 2.2 to 2.97
     (2.2 × 1.35) in v2.1.8 to account for Opus 4.7's new tokenizer, which
     consumes up to 35% more tokens than 4.6 for the same text. Per-token
     pricing in `cost-helpers.js` is UNCHANGED; only the effective token count
     for preview-display purposes increases.
3. Do NOT write any state files (no `orchestration.md`, `task-graph.md`, `tasks/`,
   audit files).
4. Do NOT spawn any subagents.
5. Stop and instruct the user: "Preview only. Re-issue `/orchestray:run <task>`
   (without --preview) to execute."

### Redo Flow

On each PM tick after a group completes, check for `.orchestray/state/redo.pending`.

**If `redo.pending` is present:**

1. Parse the JSON file: `{ w_ids: [...], prompt_override_file: <path|null>, commit_prefix: "redo" }`.
2. For each W-id in `w_ids` (in listed order, which is dependency-respecting):
   a. Re-read the task file from `.orchestray/state/tasks/<W-id>.md`.
   b. If `prompt_override_file` is non-null, read the file and prepend its contents
      to the delegation prompt as "Override instructions:".
   c. Respawn the developer agent for the W-item.
   d. Await completion and update state normally.
   e. Commit the result with message prefix `<commit_prefix>(<W-id>):` (e.g.
      `redo(W4): ...`). Each re-run produces a NEW commit -- never an amend.
3. Delete `redo.pending` after all items in the list complete.
4. Report to the user: "Redo complete: [W-id list]."

**Cascade semantics:** `redo.pending` ordering is dependency-respecting (topological).
The closure was computed by `bin/redo-wave-item.js` before writing the file; the PM
processes items in the order listed without re-computing the graph.

**Cascade depth cap:** `redo_flow.max_cascade_depth` (default 10) limits the closure
size. If the closure was capped, `bin/redo-wave-item.js` warned the user upfront; the
PM does not need to re-check.

---

## 6.R: PreCompact Resilience Block (v2.1.10 R3)

`bin/pre-compact-archive.js` is Orchestray's `PreCompact` hook handler. As of v2.1.10
it acts as a **durability checkpoint**: if the resilience dossier write fails during
an active orchestration, the hook exits 2 to block compaction rather than silently
allowing a compaction that would leave the in-flight state unrecoverable.

### Blocking Semantics

| Dossier write | Orchestration phase | Exit code | Audit event emitted |
|---|---|---|---|
| Succeeds | Any | 0 | *(none from block path; normal `pre_compact_archive` event still fires)* |
| Fails | Active phase (see below) | **2** | `resilience_block_triggered` |
| Fails | Inactive phase (`completed`, `aborted`, `archived`, `failed`) | 0 | `resilience_block_suppressed_inactive` |
| Fails | File missing / parse failure / unrecognised phase | 0 | *(none — conservative path)* |
| Fails | Any — kill-switch or config flag active | 0 | `resilience_block_suppressed` |

**Active phases** (hook blocks when phase is in this set):
`decomposing`, `executing`, `reviewing`, `verifying`, `G1-executing` through `G9-executing`,
`implementation`, `delegation`, `in_progress`.

**The phase detector is conservative.** Any parse failure, missing file, or unrecognised
phase value resolves to "do not block." False negatives (failing to block when we should
have) are preferable to false positives (stuck compaction for the user). W2 audit
documented 3 prior `file_read_failed` ENOENT races on `current-orchestration.json` — the
hook is designed for this race condition.

### Escape Hatches

Two escape hatches disable blocking behaviour without code changes. Both are safe to
combine; either one is sufficient to suppress the block.

**Environment kill-switch (takes precedence over config):**

```sh
ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1
```

Set this env var in the shell before launching Claude Code. The hook will always exit 0
on dossier-write failure and will emit a `resilience_block_suppressed` audit event with
`reason: "env_ORCHESTRAY_RESILIENCE_BLOCK_DISABLED"` so you can see the override was
active in the audit trail.

**Config flag (readable at runtime, no session restart needed):**

```json
// .orchestray/config.json
{
  "resilience": {
    "block_on_write_failure": false
  }
}
```

Default: `true` (blocking enabled). Setting to `false` produces the same exit-0 behaviour
as the env kill-switch, with `reason: "config_resilience.block_on_write_failure_false"` in
the suppressed event.

### What the user sees on block

When the hook exits 2, Claude Code surfaces the stderr message to the terminal:

```
Orchestray: refusing to compact — resilience dossier write failed during active
orchestration <id>. Retry in a moment or run /orchestray:status and manually /compact after.
```

The recommended recovery steps are:
1. Wait a moment and retry `/compact` (transient disk pressure often resolves).
2. Run `/orchestray:status` to verify orchestration state is intact.
3. If the block persists and you need to compact urgently, set
   `ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1` and retry — understand that this bypasses the
   durability checkpoint.

### PM interaction

The PM does not call `bin/pre-compact-archive.js` directly. This is a Claude Code hook
that fires automatically on every `/compact` (manual) or auto-compact event. The PM only
needs to know:

- If the user reports "Orchestray is blocking /compact", the most likely cause is a
  dossier-write failure during an active orchestration. Advise the user to check disk
  space and use `/orchestray:status` before disabling the block.
- A `resilience_block_triggered` event in `events.jsonl` is the definitive signal that
  a block was issued. A `resilience_block_suppressed` event means a kill-switch was
  active at the time of the block — check whether the orchestration state survived the
  subsequent compaction.

---

## 7.R Resilience Dossier — Field Reference (v2.1.7 Bundle D)

After auto-compaction or a `claude --resume`, `bin/inject-resilience-dossier.js` wraps
`.orchestray/state/resilience-dossier.json` in an `<orchestray-resilience-dossier>` fence
and returns it as `additionalContext` on the first (up to `max_inject_turns` = 3) post-compact
UserPromptSubmit. Section 7.C in `agents/pm.md` tells the PM to treat the fence as ground
truth. This section documents what every field means so the PM can interpret it without
re-reading disk unless necessary.

**Tier:** `critical` fields are always present. `expanded` fields may be dropped to stay
under the 12 KB cap; `deferred` fields are the first to go. `truncation_flags` records
what was dropped. The schema version is `2`; `parseDossier` accepts both v1 (pre-patch
compat shim that silently drops `ingested_counter`) and v2 (canonical).

| Field | Type | Tier | Meaning |
|---|---|---|---|
| `schema_version` | int | critical | Must be `1` or `2`. v1 is accepted via a compat shim that silently drops `ingested_counter`. v2 is canonical. Any other value → dossier is treated as corrupt. |
| `written_at` | ISO-8601 string | critical | UTC timestamp of this snapshot. Staleness guard compares against now. |
| `orchestration_id` | string \| null | critical | Identity key — PM re-binds to the right run. `null` only during cold start. |
| `phase` | enum | critical | `assessment` \| `decomposition` \| `delegation` \| `implementation` \| `review` \| `complete`. Tells PM where Section 13 / 14 / 18 flow is. |
| `status` | enum | critical | `in_progress` \| `completed` \| `failed` \| `interrupted`. Injector suppresses when `completed`. |
| `complexity_score` | int 0-12 | critical | Whether Tier 1 should stay loaded (score ≥ 4). |
| `current_group_id` | string \| null | critical | Which parallel wave is live — prevents re-dispatching earlier waves. |
| `pending_task_ids` | string[] | critical | Worklist. Capped at 20; overflow signalled in `truncation_flags`. |
| `completed_task_ids` | string[] | critical | Done set. NEVER re-delegate these. Capped at 40 most recent. |
| `cost_so_far_usd` | number \| null | critical | Drives Section 15 cost-budget gate. |
| `cost_budget_remaining_usd` | number \| null | critical | Same; `null` when no budget is configured. |
| `last_compact_detected_at` | ISO-8601 \| null | critical | Set by `mark-compact-signal.js`; informs "reconcile first" posture. |
| `ingested_counter` | int | removed in schema v2 | Always `0` in schema v1 dossier snapshots (vestigial field). Removed in schema v2. The live injection counter lives in `compact-signal.lock` (field: `ingested_count`). The injector handles suppression automatically — PM does not need to check this field. |
| `delegation_pattern` | string | expanded | `sequential` \| `parallel` \| `selective` — recovers Section 2 decision. |
| `failed_task_ids` | string[] | expanded | Verify-fix loop (§18) anchor. |
| `task_ref_uris` | string[] | expanded | One MCP URI per task id: `orchestray:orchestration://current/tasks/<id>`. PM dereferences on demand for full task body. |
| `kb_paths_cited` | string[] | expanded | KB paths the run has cited in the last ~50 events. Re-inject into relevant specialist prompts without re-searching. |
| `mcp_checkpoints_outstanding` | array | expanded | `{tool, task_id, created_at}` for checkpoints not yet consumed. Without this, PM re-hits the gate-agent-spawn enforcement. |
| `retry_counter` | object | expanded | `{task_id → int}`. §18 anti-thrashing gate depends on this. |
| `replan_count` | int | expanded | §16 re-plan budget. |
| `compact_trigger` | enum \| null | expanded | `manual` \| `auto` \| `null`. Manual = user-steered focus; dossier should yield to user intent. |
| `routing_lookup_keys` | string[] | deferred | Tail of `routing.jsonl` subtask ids — avoids re-running §19 routing for in-flight tasks. |
| `planning_inputs` | object \| null | deferred | `{release_plan_path?, phase_slug?}` — active-phase design artefact on re-entry. |
| `drift_sentinel_invariants` | string[] | deferred | Last 5 entries of `state/drift-invariants.jsonl`. §4.D trace anchor. |
| `truncation_flags` | string[] | internal | Serializer markers: `deferred_dropped`, `expanded_dropped`, `critical_overflow`, or field-specific like `completed_task_ids:truncated`. |

### Interpreting `truncation_flags`

- `[]` — dossier is intact; no size pressure.
- `["deferred_dropped"]` — routing keys / planning_inputs / drift invariants were zeroed.
  Functional impact: PM will re-run §19 routing on next spawn (one-time cost) and may
  re-read the active DESIGN.md (small cost).
- `["deferred_dropped", "expanded_dropped"]` — only critical scalars survived. PM MUST read
  `orchestray:orchestration://current` MCP resource before decomposition or verify-fix.
- `["critical_overflow", ...]` — the critical-only dossier still exceeded 12 KB. This is a
  *bug signal* — the pending/completed lists were so large the dossier could not fit. PM
  should announce the anomaly and call `/orchestray:doctor` before continuing.

### When the dossier conflicts with the compaction summary

The dossier wins. Every time. Reason: the summary is a best-effort heuristic produced by
Claude Code; the dossier is a deterministic atomic snapshot of `.orchestray/state/`
written after every PM turn boundary. If the fields disagree, the summary is stale.

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

4. **Log event**: Append a `consequence_forecast` event to `.orchestray/audit/events.jsonl`.

   > See `agents/pm-reference/event-schemas.md` §"Section 39: Consequence Forecast Event"
   > for the canonical schema.
   > Do not duplicate or override these fields.

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
