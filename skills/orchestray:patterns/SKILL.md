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

2. **Load pattern files**: Glob `.orchestray/patterns/*.md` and `.orchestray/team-patterns/*.md`. Parse each file's YAML frontmatter. Normalize fields to handle both Section 22 and Section 30 schemas:

   ```
   category = frontmatter.category || frontmatter.type || "unknown"
   confidence_numeric = typeof frontmatter.confidence === "number"
     ? frontmatter.confidence
     : { low: 0.3, medium: 0.6, high: 0.9 }[frontmatter.confidence] || 0.5
   times_applied = frontmatter.times_applied || frontmatter.occurrences || 0
   last_applied = frontmatter.last_applied || frontmatter.last_seen || null
   source = frontmatter.created_from || "unknown"
   scope = "local" if from .orchestray/patterns/, "team" if from .orchestray/team-patterns/
   ```

   If no pattern files exist in either directory: show empty state and stop:

   ```
   ## Pattern Effectiveness Dashboard

   No patterns extracted yet. Patterns are automatically created from verify-fix loops
   and past orchestrations. Run `/orchestray:learn` to extract patterns from a specific
   orchestration.
   ```

3. **Load event history**: Glob `.orchestray/history/*/events.jsonl`. For each file, parse each line as JSON. Normalize event type: `const eventType = event.type || event.event;`. Collect events by type:
   - `pattern_applied`: extract `pattern`, `agent`, `confidence`, `category`
   - `orchestration_start`: extract orchestration ID (from directory name), timestamp
   - `orchestration_complete`: extract `status`, `total_cost_usd`
   - `verify_fix_attempt`: count per orchestration and agent
   - `replan`: count per orchestration
   - `pattern_pruned`: extract `name`, `confidence`, `times_applied`, orchestration ID, timestamp

4. **Route by argument**:
   - If a pattern name was provided: go to step 12 (single pattern detail view).
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

6. **Section 2 -- Pattern Inventory**: Show all patterns in a table sorted by confidence descending, then by times_applied descending.

   ```
   ### Pattern Inventory

   | Pattern | Category | Confidence | Applied | Last Applied | Source | Scope |
   |---------|----------|------------|---------|--------------|--------|-------|
   | {name} | {category} | {confidence} | {times_applied} | {last_applied or "never"} | {source} | {scope} |
   ```

   Format confidence to 2 decimal places. Format last_applied as YYYY-MM-DD if present, otherwise "never".

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

8. **Section 4 -- Confidence Trajectory**: Show how each pattern's confidence has changed.

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

9. **Section 5 -- Estimated Impact**: Show estimated savings from pattern applications.

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

10. **Section 6 -- Pruning History**: Show patterns removed by the pruning system.

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

11. **Section 7 -- Actionable Recommendations**: Generate heuristic-based suggestions.

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

12. **Single Pattern Detail View** (when a pattern name was provided in arguments):

    Find the pattern file matching the provided name (match against the `name` frontmatter field, case-insensitive). If not found, show "Pattern '{name}' not found. Run `/orchestray:patterns` to see all available patterns." and stop.

    Read the full pattern file content. Search event history for `pattern_applied` events matching this pattern name.

    Display:
    ```
    ## Pattern Detail: {name}

    **Category:** {category}
    **Confidence:** {confidence}
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

13. **Edge cases**:
    - If `.orchestray/history/` does not exist or is empty: skip all event-based sections, show pattern metadata only with notes that no history is available.
    - If `.orchestray/team-patterns/` does not exist: treat team pattern count as 0.
    - If `team` filter is specified but no team patterns exist: show "No team patterns found. Promote local patterns with `/orchestray:learn promote <name>`." and stop.
    - Format all dollar amounts to 4 decimal places.
    - Format all percentages to 1 decimal place.
    - Format all confidence values to 2 decimal places.
