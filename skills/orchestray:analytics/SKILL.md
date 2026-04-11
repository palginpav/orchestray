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

2. **Scan history via MCP:** Call `mcp__orchestray__history_query_events` with:
   - `event_types: ["orchestration_start", "orchestration_complete", "agent_stop", "task_completed_metrics", "routing_outcome", "replan", "verify_fix_attempt", "verify_fix_fail"]`
   - `limit: 500` (the server-side maximum)
   - If N was specified, filter the returned `events` array client-side to the
     last N unique `orchestration_id` values (the server does not expose a
     per-orchestration limit — filter after the call returns).

   If the call returns `isError: true` or the `events` array is empty, report
   "No orchestration history found. Run some orchestrations first." and stop.

   **Fallback (MCP unavailable):** if the MCP call itself fails with a transport
   error (not an empty result), fall back to the pre-v2.0.11 behavior: Glob
   `.orchestray/history/` directories, read each events.jsonl, normalize the
   `event`/`type` field.

3. **Apply limit**: (unchanged — operates on the client-filtered list from step 2.)

4. **Collect data**: The MCP call already returns the normalized event objects.
   No JSONL parsing, no `event`/`type` normalization needed — the server does
   both. Group the returned events by `orchestration_id` and proceed:

   - `orchestration_start`: extract `task` (original prompt), `complexity_score`, `complexity_level`.
   - `orchestration_complete`: extract `status` (success/partial/failure), `total_cost_usd`, `duration_seconds`.
   - `agent_stop` / `task_completed_metrics`: extract `agent_type`, `estimated_cost_usd`, `model_used`.
   - `routing_outcome`: extract `agent_type`, `model_assigned`, `escalated` (boolean).
   - `replan`: count occurrences per orchestration.
   - `verify_fix_attempt` / `verify_fix_fail`: count verify-fix rounds per orchestration.

   Skip orchestrations that have no `orchestration_start` event in the returned set.

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

   **Turns by agent type:**
   - Group all `agent_stop` / `task_completed_metrics` events by `agent_type`.
   - For each type: average `turns_used`, min `turns_used`, max `turns_used`, invocation count.
   - Sort by average turns descending.
   - If all `turns_used` values are 0 or missing, show "No turns data available (pre-v2.0.1 orchestrations)."

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

   ## Turns by Agent Type
   | Agent | Avg Turns | Min | Max | Invocations |
   |-------|-----------|-----|-----|-------------|
   | {type} | {avg_turns} | {min_turns} | {max_turns} | {count} |
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

8. **Pattern Effectiveness Dashboard**: After displaying the main analytics, show pattern learning metrics.

   **Read pattern files**: Glob `.orchestray/patterns/*.md` and parse each file's YAML frontmatter. Normalize fields to handle both Section 22 and Section 30 schemas:
   - `category` (or `type` for Section 30 corrections -- use `frontmatter.category || frontmatter.type || "unknown"`)
   - `times_applied` (or `occurrences` for corrections -- use `frontmatter.times_applied || frontmatter.occurrences || 0`)
   - `confidence` level (numeric 0.0-1.0 or string low/medium/high -- map strings: low=0.30, medium=0.60, high=0.90)
   - `last_applied` (or `last_seen` for corrections -- use `frontmatter.last_applied || frontmatter.last_seen || null`)

   **Read pattern_applied events**: Search all `.orchestray/history/*/events.jsonl` for events where the normalized event type equals `pattern_applied`. Compute:
   - Total patterns applied across all orchestrations.
   - Average patterns applied per orchestration (total applied / number of orchestrations that had at least one pattern_applied event).
   - Most frequently applied patterns (top 5 by count, using the pattern `name` or `pattern` field from the event).
   - Correction effectiveness: count correction-type patterns that were applied and where no `verify_fix_attempt` event occurred for the same issue/agent in the same orchestration. These are estimated re-occurrences prevented.

   **Count new patterns**: From the pattern files, count how many have a `last_applied` (or `last_seen`) timestamp within the last 5 orchestrations (by comparing against `orchestration_start` timestamps from the most recent 5 history directories).

   **Display pattern dashboard**:

   ```
   ## Pattern Learning

   Total patterns: {N} ({correction_count} corrections, {strategy_count} strategies)
   Patterns applied: {N} times across {M} orchestrations

   ### Top Patterns by Impact
   | Pattern | Category | Applied | Confidence | Last Used |
   |---------|----------|---------|------------|-----------|
   | {name}  | {category} | {N}x | {confidence} | {date} |
   ...

   ### Correction Effectiveness
   Corrections applied: {N}
   Re-occurrences prevented: {N} (estimated)

   ### Learning Trend
   Avg patterns applied per orchestration: {N}
   Pattern library growth: {N} new in last 5 orchestrations
   ```

   **If no pattern files exist** (`.orchestray/patterns/*.md` glob returns no results): skip the dashboard tables and instead show:

   ```
   ## Pattern Learning

   No patterns extracted yet. Patterns are automatically created from verify-fix loops and past orchestrations. Run `/orchestray:learn` to extract patterns from a specific orchestration.
   ```

   After displaying the pattern learning section (whether populated or empty), add: "Run `/orchestray:patterns` for detailed pattern effectiveness data."

## Health Signals

After displaying all analytics sections, check for active emergency conditions that
require immediate operator attention.

**Kill-switch health check:**

1. Read `.orchestray/config.json`. If it does not exist, skip this section.
2. Check `mcp_enforcement.global_kill_switch`. If the value is `true`, display:

   ```
   ## Health Signals

   **WARNING: MCP enforcement kill switch is ACTIVE.**
   2.0.12's hook-enforced MCP surface is fully bypassed.
   Re-enable via `/orchestray:config set mcp_enforcement.global_kill_switch false` when the emergency is resolved.
   ```

3. Additionally, scan `.orchestray/audit/events.jsonl` for `kill_switch_activated`
   and `kill_switch_deactivated` events among the **last 100 events** in the file
   (read the tail of the file; ignore earlier events beyond that window).

   - Find the most recent `kill_switch_activated` event in that window.
   - Check whether a `kill_switch_deactivated` event with a **later** timestamp
     exists after it in the same window.
   - If the most recent activation has no later deactivation, append to the
     Health Signals block:

     ```
     Kill switch activated <relative time ago> and has not been deactivated since.
     ```

     Compute the relative time from the event's `timestamp` field to the current
     wall-clock time (e.g., "3 minutes ago", "2 hours ago", "4 days ago").

4. If `global_kill_switch` is `false` AND no unmatched `kill_switch_activated`
   event is found in the last 100 events, **omit the Health Signals section
   entirely** — do not show an empty section or a "No health issues" placeholder.

*Per-orchestration execution timelines available via `/orchestray:report`.*
