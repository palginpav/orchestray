---
name: patterns
description: Show pattern effectiveness dashboard with learning metrics
disable-model-invocation: true
argument-hint: "[pattern-name] | team"
---

# Pattern Effectiveness Dashboard

The user wants to see the pattern learning dashboard showing what the system has learned and how effective those patterns are.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If `team` is provided: filter to team patterns only (`.orchestray/team-patterns/`).
   - If a pattern name is provided: show single pattern detail view.
   - If empty: show the full dashboard (all sections).

2. **Load patterns via MCP:** Call `mcp__orchestray__pattern_find` with:
   - `task_summary: "all patterns"` (a neutral query that is broad enough not to
     bias the scoring hard; the skill wants everything)
   - `max_results: 50` (the server-side maximum)
   - `min_confidence: 0.0` (no filter)

   The returned `matches` array contains objects with `slug`, `uri`, `category`,
   `confidence` (numeric 0-1), `decayed_confidence` (time-weighted, numeric 0-1),
   `age_days` (integer), `times_applied`, `one_line`, and `match_reasons`.
   The server already normalizes confidence to numeric and merges Section 22 /
   Section 30 field aliases — no client-side normalization needed.

   `decayed_confidence` applies exponential decay: `confidence × 0.5^(age_days / half_life)`
   where `half_life` defaults to 90 days (configurable via `pattern_decay.default_half_life_days`).
   `age_days` is measured from `last_applied` (if set) or the pattern file's mtime.

   Note: `pattern_find` reads `.orchestray/patterns/` only. To include
   `.orchestray/team-patterns/*.md`, glob them separately (same code as before)
   and merge client-side. Set `scope = "local"` for MCP results,
   `scope = "team"` for globbed team-patterns results.

   **Fallback (MCP unavailable):** if `pattern_find` returns a transport error,
   fall back to the pre-v2.0.11 Glob + read + normalize behavior.

   If both the MCP call and the team-pattern glob return no results: show empty
   state and stop (unchanged from before).

   If no pattern files exist in either directory: show empty state and stop:

   ```
   ## Pattern Effectiveness Dashboard

   No patterns extracted yet. Patterns are automatically created from verify-fix loops
   and past orchestrations. Run `/orchestray:learn` to extract patterns from a specific
   orchestration.
   ```

3. **Load event history**: Glob `.orchestray/history/*/events.jsonl`. Also glob `.orchestray/audit/events.jsonl`. For each file, parse each line as JSON. Normalize event type: `const eventType = event.type || event.event;`. Collect events by type:
   - `pattern_applied`: extract `pattern`, `agent`, `confidence`, `category`
   - `orchestration_start`: extract orchestration ID (from directory name), timestamp
   - `orchestration_complete`: extract `status`, `total_cost_usd`
   - `verify_fix_attempt`: count per orchestration and agent
   - `replan`: count per orchestration
   - `pattern_pruned`: extract `name`, `confidence`, `times_applied`, orchestration ID, timestamp
   - `pattern_skip_enriched`: collect into a Map keyed by `pattern_name` (used for health score skip penalty)
   - `curator_diff_rollup`: collect all into an array (used for Section 4 — Curate --diff Efficiency)

4. **Route by argument**:
   - If a pattern name was provided: go to step 13 (single pattern detail view).
   - If `team` was specified: filter loaded patterns to team scope only, then continue to step 5.
   - If no arguments: continue to step 5 with all patterns.

5. **Section 1 -- Library Overview**: Display summary metrics at the top.

   Count patterns by category: decomposition, anti-pattern, routing, specialization, correction, user-correction, unknown.
   Count total `pattern_applied` events and unique orchestrations that had at least one.
   Compute average confidence across all patterns (numeric, 2 decimal places).

   ```
   ## Pattern Effectiveness Dashboard

   ### Library Overview

   Total patterns: {N} ({local_count} local, {team_count} team)
   Categories: {decomposition_count} decomposition, {anti_count} anti-pattern, {routing_count} routing, {spec_count} specialization, {correction_count} correction, {user_correction_count} user-correction
   Average confidence: {avg_confidence}
   Patterns applied: {total_applied} times across {orchestration_count} orchestrations
   ```

6. **Section 2 -- Pattern Inventory**: Compute health scores using `bin/_lib/pattern-health.js`.
   Call `annotatePatterns(patterns, skipEvents, now)` with the patterns from step 2 and
   the `pattern_skip_enriched` events from step 3. Sort by `health desc`, then `times_applied desc`.

   ```
   ### Pattern Inventory

   | Pattern | Health | Category | Confidence | Decayed | Age (days) | Applied | Last Applied | Source | Scope |
   |---------|--------|----------|------------|---------|------------|---------|--------------|--------|-------|
   | {name} | {health or "[stale] health"} | {category} | {confidence} | {decayed_confidence} | {age_days} | {times_applied} | {last_applied or "never"} | {source} | {scope} |
   ```

   Health display rules:
   - Format `health` to 2 decimal places.
   - If `health_tier === 'stale'`: prefix the value with `[stale] ` (e.g., `[stale] 0.52`).
   - If `health_tier === 'needs-attention'`: omit from this table (listed in Section 2b below).
   - Footnote: "Health combines decayed_confidence, times_applied, age, and contextual-mismatch skip events. For the formula, see `bin/_lib/pattern-health.js`. Tiers: ≥0.60 healthy, 0.40-0.59 stale, <0.40 needs attention."

   If ALL skip events have `pattern_name: null` (pre-A2 state), add footnote: "Skip penalty suppressed — per-slug skip attribution unavailable (A2 plumbing not yet deployed)."

   Format `confidence` and `decayed_confidence` to 2 decimal places. Format `last_applied` as YYYY-MM-DD if present, otherwise "never".
   When `decayed_confidence` is less than 50% of `confidence` (i.e. `decayed_confidence < confidence * 0.5`), mark the decayed value with a `*` suffix and show a footnote: `* Decayed to <50% of raw confidence — pattern has not been applied in more than one half-life.`

6b. **Section 2b -- Needs Attention**: Shown immediately after Section 2.

   If at least one pattern has `health_tier === 'needs-attention'`:
   ```
   ### Needs Attention (health < 0.40)

   | Pattern | Health | Why |
   |---------|--------|-----|
   | {name} | {health} | {health_reason} |

   To investigate: /orchestray:patterns <slug>
   To curate: /orchestray:learn curate --dry-run
   ```

   If zero patterns are in this tier:
   ```
   ### Needs Attention

   No patterns below 0.40 health. Library is in good shape.
   ```

7. **Section 3 -- Application History**: Show per-orchestration pattern usage from event data.

   For each orchestration in `.orchestray/history/*/events.jsonl`:
   - Find `orchestration_start` event for the timestamp
   - Find all `pattern_applied` events, extract pattern names and categories
   - Find `orchestration_complete` event for status
   - Count `verify_fix_attempt` events as corrections triggered

   If no `pattern_applied` events exist in any orchestration:
   ```
   ### Application History

   No pattern application events recorded yet. Patterns will be tracked as they are
   applied in future orchestrations.
   ```

   Otherwise display:
   ```
   ### Application History

   | Orchestration | Date | Patterns Applied | Outcome | Corrections Triggered |
   |---------------|------|------------------|---------|----------------------|
   | {orch-id} | {date} | {pattern (category), ...} | {status} | {count} |
   ```

   Sort by date descending (most recent first). Show last 20 orchestrations maximum.

8. **Section 4 — Curate `--diff` Efficiency**: Surface efficiency telemetry for incremental curation runs.

   Use the `curator_diff_rollup` events collected in step 3.

   If no `curator_diff_rollup` events are present:
   ```
   ### Section 4 — Curate --diff Efficiency

   No `curate --diff` runs yet. Run `/orchestray:learn curate --diff` to start collecting efficiency telemetry.
   ```

   Otherwise, for each event (sort by `timestamp` ascending), display a row:
   - **Run ID**: first 8 chars of `run_id` (e.g. `curator-`)
   - **Corpus / Dirty**: `{corpus_size} / {dirty_size}` and ratio as `({pct}%)` where `pct = (dirty_size / corpus_size * 100).toFixed(1)` (show `0.0%` when `corpus_size === 0`)
   - **Actions**: `promote: {promote_n}, merge: {merge_n}, deprecate: {deprecate_n}` from `actions_applied`
   - **Full sweep**: `yes` if `forced_full_sweep === true`, `no` otherwise

   ```
   ### Section 4 — Curate --diff Efficiency

   | Run ID   | Corpus / Dirty (%) | Actions                           | Full sweep |
   |----------|--------------------|-----------------------------------|------------|
   | {run_id} | {corpus} / {dirty} ({pct}%) | promote: {N}, merge: {N}, deprecate: {N} | {yes/no} |
   ```

   Show at most the last 20 runs (most recent last).

   If there are 3 or more runs, compute the average `dirty_size / corpus_size` ratio across all runs and append a trend line:
   - avg < 0.30 → `[GOOD] Average dirty ratio {avg_pct}% — --diff is saving significant curator work.`
   - avg 0.30–0.60 → `[OK] Average dirty ratio {avg_pct}% — --diff is providing moderate savings.`
   - avg > 0.60 → `[LOW] Average dirty ratio {avg_pct}% — most patterns are dirty each run; --diff savings are limited.`

   Skip `corpus_size === 0` runs when computing the average ratio.

9. **Section 5 -- Confidence Trajectory**: Show how each pattern's confidence has changed.

   Determine initial confidence by category convention:
   - decomposition, routing, specialization: 0.50
   - anti-pattern: 0.60
   - user-correction: 0.80
   - correction: mapped from low=0.30, medium=0.60, high=0.90

   Current confidence: read from the pattern file frontmatter (already normalized).

   Trend logic:
   - If times_applied is 0: "-- (unused)"
   - If current > initial: "improving"
   - If current < initial: "declining"
   - If current == initial and times_applied > 0: "stable"

   ```
   ### Confidence Trajectory

   | Pattern | Initial | Current | Change | Trend |
   |---------|---------|---------|--------|-------|
   | {name} | {initial} | {current} | {+/-change} | {trend} |
   ```

   Format initial, current, and change to 2 decimal places. Prefix change with + or -.

10. **Section 6 -- Estimated Impact**: Show estimated savings from pattern applications.

   Calculation:
   - **Corrections preventing re-occurrence**: Count `pattern_applied` events where category is `correction` or `user-correction`, AND no `verify_fix_attempt` event occurred for the same agent in the same orchestration. Each prevented round estimated at ~$0.15.
   - **Anti-patterns avoiding known failures**: Count `pattern_applied` events where category is `anti-pattern`, AND no `replan` event occurred in the same orchestration. Each prevented re-plan estimated at ~$0.50.
   - **Routing patterns reducing cost**: Count `pattern_applied` events where category is `routing`. Savings from routing_outcome events using cheaper models vs opus baseline.

   ```
   ### Estimated Impact

   | Impact Type | Count | Estimated Value |
   |-------------|-------|-----------------|
   | Corrections preventing re-occurrence | {N} | ~${value} saved ({N} verify-fix rounds avoided) |
   | Anti-patterns avoiding known failures | {N} | ~${value} saved ({N} re-plans avoided) |
   | Routing patterns reducing cost | {N} | ~${value} saved |
   ```

   Format dollar amounts to 4 decimal places.

   If no `pattern_applied` events exist, show the table with all zeros and add:
   ```
   No patterns have been applied yet. Impact tracking begins after patterns are used in
   orchestrations. Run `/orchestray:learn` to extract patterns from past orchestrations.
   ```

11. **Section 7 -- Pruning History**: Show patterns removed by the pruning system.

    Search event history for `pattern_pruned` events.

    If none found:
    ```
    ### Pruning History

    No patterns have been pruned. Pruning occurs when the pattern library exceeds 50 patterns.
    ```

    If found:
    ```
    ### Pruning History

    | Pattern | Score | Pruned In | Date |
    |---------|-------|-----------|------|
    | {name} | {confidence * times_applied} | {orch-id} | {date} |

    Total pruned: {N} patterns removed to maintain the 50-pattern cap.
    ```

12. **Section 8 -- Actionable Recommendations**: Generate heuristic-based suggestions.

    Check these conditions and display matching recommendations:

    | Condition | Recommendation |
    |-----------|---------------|
    | Any pattern with times_applied == 0 | "{N} patterns have never been applied. Consider running orchestrations on similar tasks, or remove patterns that no longer match your workflow with `/orchestray:learn prune <name>`." |
    | No user-correction patterns exist | "No user corrections captured. Use `/orchestray:learn correct <description>` to teach the system about mistakes it should avoid." |
    | No team patterns exist | "No team patterns. Promote proven local patterns with `/orchestray:learn promote <name>` to share with your team." |
    | Any pattern with confidence < 0.3 | "{N} patterns have low confidence. They may need more evidence or should be removed." |
    | Pattern library > 40 (approaching cap) | "Pattern library at {N}/50 capacity. Lower-value patterns will be pruned automatically." |
    | All corrections applied without verify-fix triggers in same orchestration | "Correction patterns are preventing {N} known issues per orchestration." |

    Display as a bulleted list under `### Recommendations`.

    If no recommendations trigger, show:
    ```
    ### Recommendations

    No specific recommendations at this time. The pattern library is healthy.
    ```

13. **Single Pattern Detail View** (when a pattern name was provided in arguments):

    Find the pattern file matching the provided name (match against the `name` frontmatter field, case-insensitive). If not found, show "Pattern '{name}' not found. Run `/orchestray:patterns` to see all available patterns." and stop.

    Read the full pattern file content. Search event history for `pattern_applied` events matching this pattern name.

    Compute the health score for this pattern using `computeHealth` from
    `bin/_lib/pattern-health.js`, passing the pattern's data and any
    `pattern_skip_enriched` events for its slug from step 3.

    Display:
    ```
    ## Pattern Detail: {name}

    **Category:** {category}
    **Confidence:** {confidence} (raw) / {decayed_confidence} (decayed, age {age_days} days)
    **Health:** {health} ({health_tier})
    **Why:**   {health_reason}
    **Times Applied:** {times_applied}
    **Created From:** {source}
    **Scope:** {scope}
    **Last Applied:** {last_applied or "never"}

    ### Description
    {description from frontmatter}

    ### Context
    {Context section from the pattern file body}

    ### Approach
    {Approach section from the pattern file body}

    ### Evidence
    {Evidence section from the pattern file body}

    ### Application Log
    ```

    If `pattern_applied` events exist for this pattern, show:
    ```
    | Orchestration | Date | Agent | Confidence at Application |
    |---------------|------|-------|--------------------------|
    | {orch-id} | {date} | {agent} | {confidence} |
    ```

    If no events, show: "No application events recorded for this pattern."

13b. **Section 9 — Retrieval Shadow Scorer Agreement**: shown after Section 8.

    Read `.orchestray/state/scorer-shadow.jsonl` (and `.orchestray/state/scorer-shadow.1.jsonl`,
    `.2.jsonl` if they exist). If the file does not exist, or `retrieval.shadow_scorers` is empty
    in `.orchestray/config.json` (or the config file is absent), show:

    ```
    ### Section 9 — Retrieval Shadow Scorer Agreement

    Shadow scorers not enabled. See `retrieval.shadow_scorers` in `.orchestray/config.json`.
    Example: {"retrieval": {"shadow_scorers": ["skip-down", "local-success"]}}
    ```

    Otherwise parse up to the last 500 rows (newest-first). For each unique `scorer_name`
    in those rows, compute aggregate statistics:
    - **Calls**: count of rows for this scorer.
    - **Mean τ**: mean of `kendall_tau` values (skip null entries).
    - **Median τ**: median of non-null `kendall_tau` values.
    - **Top-K overlap (mean)**: mean of `top_k_overlap` / `k` expressed as "X.X/{k}".
    - **Displacement (median)**: median of `displacement.median` values across rows where
      `displacement` is not null.

    Also collect per-slug displacement history: for each slug appearing in `baseline_top_k`
    or `shadow_top_k`, track `rank_shadow - rank_baseline` across rows (use index in the
    respective array as rank). Compute per-slug average displacement (signed, not abs).

    Display format:

    ```
    ### Section 9 — Retrieval Shadow Scorer Agreement

    Last {N} pattern_find calls ({date_range}, {scorer_count} scorer(s) enabled).

    | Scorer         | Calls | Mean τ | Median τ | Top-K overlap (mean) | Displacement (median) |
    |----------------|-------|--------|----------|----------------------|-----------------------|
    | {scorer_name}  |  {N}  |  {tau} |   {tau}  |         {X.X}/{k}    |                  {d}  |

    Top patterns displaced by shadow (rank_shadow - rank_baseline, avg across calls):
      {scorer_name}:
        - {slug}: {avg_disp:+.1f} avg (reasons: {top_reason_from_shadow_reasons_by_slug})
        - ...  (show top 5 by absolute avg displacement)

    Shadow scorers never affect live rankings. To promote a scorer to primary,
    review these displacements and run /orchestray:issue to propose Bundle RS promotion.
    ```

    If `displacement` is null for all rows of a scorer, omit the displacement column value
    and show "—". Format `kendall_tau` to 2 decimal places. If fewer than 5 rows exist,
    note "(insufficient data for reliable aggregation)".

14. **Edge cases**:
    - If `.orchestray/history/` does not exist or is empty: skip all event-based sections, show pattern metadata only with notes that no history is available.
    - If `.orchestray/team-patterns/` does not exist: treat team pattern count as 0.
    - If `team` filter is specified but no team patterns exist: show "No team patterns found. Promote local patterns with `/orchestray:learn promote <name>`." and stop.
    - Format all dollar amounts to 4 decimal places.
    - Format all percentages to 1 decimal place.
    - Format all confidence values to 2 decimal places.
