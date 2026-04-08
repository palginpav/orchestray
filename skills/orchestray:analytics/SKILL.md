---
name: analytics
description: Show aggregate performance analytics across all orchestrations
disable-model-invocation: true
argument-hint: "[last N]"
---

# Orchestration Analytics

The user wants to see aggregate performance analytics across orchestration history.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If a number N is provided (e.g., `last 10`, `10`): limit analysis to the N most recent orchestrations.
   - If empty: analyze all orchestrations.

2. **Scan history**: List all directories in `.orchestray/history/` using Glob. Sort by name (names contain timestamps, so alphabetical = chronological). If the directory is missing or empty: report "No orchestration history found. Run some orchestrations first." and stop.

3. **Apply limit**: If N was specified, take only the last N directories from the sorted list.

4. **Collect data**: For each orchestration directory, read `.orchestray/history/{orch-id}/events.jsonl`. Parse each line as JSON and collect events by type:

   - `orchestration_start`: extract `task` (original prompt), `complexity_score`, `complexity_level`.
   - `orchestration_complete`: extract `status` (success/partial/failure), `total_cost_usd`, `duration_seconds`.
   - `agent_stop` / `task_completed_metrics`: extract `agent_type`, `estimated_cost_usd`, `model_used`.
   - `routing_outcome`: extract `agent_type`, `model_assigned`, `escalated` (boolean).
   - `replan`: count occurrences per orchestration.
   - `verify_fix_attempt` / `verify_fix_fail`: count verify-fix rounds per orchestration.

   Skip orchestration directories that have no `events.jsonl` or contain no parseable events.

5. **Compute aggregates**:

   **Overview metrics:**
   - Total orchestrations analyzed
   - Status counts: success, partial, failure
   - Success rate: `(success / total) * 100`%
   - Average cost per orchestration: `sum(total_cost_usd) / total`
   - Total cost across all orchestrations: `sum(total_cost_usd)`
   - Average duration (if duration_seconds available): `sum(duration_seconds) / count`

   **Cost trend:**
   - Split orchestrations into two groups: last 5 and previous 5 (or whatever is available).
   - Compute average cost for each group.
   - Direction: "increasing" if last > previous, "decreasing" if last < previous, "stable" if within 5%.

   **Cost by agent type:**
   - Group all `agent_stop` / `task_completed_metrics` events by `agent_type`.
   - For each type: total cost, average cost per invocation, invocation count.
   - Sort by total cost descending.

   **Most expensive agent type:** The agent type with the highest total cost.

   **Routing accuracy:**
   - Total routing decisions: count of `routing_outcome` events.
   - Escalations: count where `escalated` is true.
   - Accuracy: `((total - escalations) / total) * 100`%.

   **Model distribution:**
   - Group `routing_outcome` events by `model_assigned`.
   - For each model: times assigned, times escalated, accuracy %.

   **Verify-fix rounds:**
   - Average verify-fix rounds per orchestration (0 if no verify-fix events found).

6. **Display results** as formatted tables:

   ```
   ## Orchestration Analytics

   Analyzing {N} orchestration(s){if limited: " (last {N} of {total})"}.

   ## Overview
   | Metric | Value |
   |--------|-------|
   | Total orchestrations | {count} |
   | Success | {success_count} |
   | Partial | {partial_count} |
   | Failure | {failure_count} |
   | Success rate | {rate}% |
   | Average cost | ~${avg_cost} |
   | Total cost | ~${total_cost} |
   | Average duration | {duration}s |
   | Cost trend | {direction} (last 5 avg: ~${recent} vs previous 5 avg: ~${previous}) |
   | Avg verify-fix rounds | {avg_rounds} |

   ## Cost by Agent Type
   | Agent | Total Cost | Avg Cost | Invocations |
   |-------|------------|----------|-------------|
   | {type} | ~${total} | ~${avg} | {count} |
   ...

   ## Model Routing
   | Model | Assigned | Escalated | Accuracy |
   |-------|----------|-----------|----------|
   | {model} | {count} | {esc_count} | {accuracy}% |
   ...

   Routing accuracy (overall): {accuracy}% ({total - escalations}/{total} decisions without escalation)
   ```

   Format all dollar amounts to 4 decimal places. Format percentages to 1 decimal place.

7. **Edge cases**:
   - If only 1 orchestration exists: skip cost trend, show "Insufficient data for trend analysis."
   - If no routing_outcome events found: show "No model routing data available (pre-routing orchestrations)."
   - If no agent cost data found: show "No per-agent cost data available."
