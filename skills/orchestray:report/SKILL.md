---
name: report
description: Generate audit report for last orchestration
disable-model-invocation: true
argument-hint: [orchestration-id] or empty for latest
---

# Orchestration Report

The user wants an audit report of a completed orchestration.

## Report Generation Protocol

1. **Find the orchestration**: 
   - If `$ARGUMENTS` is empty: Use the most recent file in `.orchestray/history/`
   - If `$ARGUMENTS` is provided: Find the matching orchestration in `.orchestray/history/`
   - If no history exists: Report "No completed orchestrations found. Run `/orchestray:run [task]` first."

2. **Read the orchestration record**: Parse the JSON file from history. Also read `.orchestray/history/{orchestration}/events.jsonl` if it exists. Parse each line as JSON. For each parsed event, normalize the type field: use `event.type || event.event` as the canonical event type. This ensures backward compatibility with pre-v2.0.2 events that used `"event"` instead of `"type"` as the key name. Collect all events for this orchestration.

3. **Generate the report** in this format:

```
## Orchestration Report

**Task:** [original task description]
**Started:** [timestamp]
**Completed:** [timestamp]
**Duration:** [elapsed time]
**Status:** [success/partial/failure]

### Agent Activity

| Agent | Task | Status | Files Changed |
|-------|------|--------|---------------|
| architect | [subtask] | success | [files] |
| developer | [subtask] | success | [files] |
| reviewer | [review] | success | - |

### Cost Breakdown

| Agent | Model | Input Tokens | Output Tokens | Cache Read | Est. Cost |
|-------|-------|-------------|---------------|------------|-----------|
| architect | opus | {N} | {N} | {N} | ~${N.NN} |
| developer | sonnet | {N} | {N} | {N} | ~${N.NN} |
| reviewer | sonnet | {N} | {N} | {N} | ~${N.NN} |
| **Total** | | **{N}** | **{N}** | **{N}** | **~${N.NN}** |

*Costs are estimates based on model pricing at time of execution.*

Populate from `agent_stop` events in `events.jsonl`: use the `usage` fields (`input_tokens`, `output_tokens`, `cache_read_input_tokens`) and `estimated_cost_usd` for each agent. Populate the Model column from the `model_used` field in `agent_stop` events. If `model_used` is null (pre-routing event), show "sonnet" as default. Sum all rows for the Total line.

### Model Routing

**This section is only shown when `routing_outcome` events exist in `events.jsonl`.** If no `routing_outcome` events are found (pre-Phase-5 orchestration without routing), omit this entire section. The rest of the report renders as before for backward compatibility.

#### Routing Decisions

| Subtask | Agent | Model | Score | Result | Escalations |
|---------|-------|-------|-------|--------|-------------|
| {subtask description} | {agent_type} | {model_assigned} | {score}/12 | {success/failure} | {escalation_count} |

Populate from `routing_outcome` events in `events.jsonl`. One row per `routing_outcome` event. Use the `task_id` field for the Subtask column, `agent_type` for Agent, `model_assigned` for Model, `complexity_score` for Score (show as N/12), `result` for Result, and `escalation_count` for Escalations. If `escalated_from` is non-null, append "(from {escalated_from})" to the Escalations column.

#### Cost Savings

| Agent | Model Used | Actual Cost | Opus Baseline | Savings |
|-------|-----------|-------------|---------------|---------|
| architect | opus | ~$0.08 | ~$0.08 | $0.00 (0%) |
| developer | sonnet | ~$0.04 | ~$0.08 | ~$0.04 (50%) |
| reviewer | sonnet | ~$0.03 | ~$0.06 | ~$0.03 (50%) |
| **Total** | | **~$0.15** | **~$0.22** | **~$0.07 (32%)** |

*Savings vs. all-Opus baseline: ~$0.07 (32%)*

Populate from `agent_stop` events: use `model_used` for the Model Used column, `estimated_cost_usd` for Actual Cost, and `estimated_cost_opus_baseline_usd` for the Opus Baseline. Calculate savings as `opus_baseline - actual`. Calculate percentage as `((opus_baseline - actual) / opus_baseline * 100)`. Sum all rows for totals.

**Historical savings comparison:** After the savings table, if `.orchestray/history/` contains past orchestrations, find the most recent orchestration whose task description shares 3+ keywords with the current task. If a similar previous orchestration is found, add:

*Previous similar orchestration (orch-XXXX): ~$0.30 -> Current: ~$0.15 (50% reduction)*

If no similar orchestration found, omit this line.

### Audit Trail

| Time | Event | Agent | Details |
|------|-------|-------|---------|
| {HH:MM:SS} | orchestration_start | - | Complexity: {level} ({score}/12) |
| {HH:MM:SS} | agent_start | architect | Task: {task preview} (model: {model}) |
| {HH:MM:SS} | agent_stop | architect | {input_tokens}in/{output_tokens}out, ~${cost} (model: {model}) |
| {HH:MM:SS} | orchestration_complete | - | {total_agents} agents, ~${total_cost} |

Populate from all events in `events.jsonl`. Show timestamps as HH:MM:SS. List events in chronological order. Use the `type` field to determine the Event column, `agent_type` for the Agent column, and construct Details from the event-specific fields. For `agent_start` events, include the model in Details as `(model: {model})`. For `agent_stop` events, include model info from the `model_used` field as `(model: {model})`. If `model_used` is null, omit the model annotation.

### Execution Trajectory

**Only render this section when `agent_start` and `agent_stop` events exist in `events.jsonl` with non-null timestamps.** If the orchestration was handled solo (no agents spawned), skip this section entirely. If `events.jsonl` is missing, skip this section.

#### Building agent spans

Pair each `agent_start` event with its matching `agent_stop` event by `agent_id`. If `agent_id` is absent, fall back to matching by `agent_type` and timestamp proximity. For each matched pair compute:
- `start_offset_s`: seconds from `orchestration_start.timestamp` to `agent_start.timestamp`
- `duration_s`: seconds from `agent_start.timestamp` to `agent_stop.timestamp`
- `end_offset_s`: `start_offset_s + duration_s`

Edge cases:
- `agent_stop` with no matching `agent_start`: render the stop row only, mark start as `T+?s`.
- `agent_start` with no matching `agent_stop` (agent still running): render as open span `┌─ {type} (agent-{short_id}) (running...)`.

#### Detecting parallel groups

Two agents are in the same parallel group when their time windows overlap:
```
agent_A.start_offset_s < agent_B.end_offset_s AND agent_B.start_offset_s < agent_A.end_offset_s
```
Group agents by connected component of this overlap relation.

#### Rendering the ASCII timeline

Render as a code block or plain text (terminal-friendly). Follow this layout:

```
### Execution Trajectory

Orchestration: {orch-id}  Task: {task description truncated to 60 chars}
Duration: ~{total_duration}s  Agents: {N}  Total cost: ~${total_cost}
Complexity: {level} ({score}/12)     ← omit if complexity_score absent

T+0s    [orchestration_start]

T+{N}s  ┌─ {agent_type} (agent-{short_id})  [{model_used}]      ← model only if model_used present
         │  turns: {turns_used}  cost: ~${cost}  duration: ~{duration}s
T+{M}s  │  [replan] {reason}                                     ← annotation row if replan at this offset
T+{P}s  └─ {agent_type} done  [{outcome_preview}]               ← outcome: first 80 chars of last_message_preview, strip "## Result Summary" header; omit if empty

T+{P}s  ┬─ {agent_type} (agent-{short_id})  [{model_used}]      ← parallel group: 2+ agents with overlapping windows
T+{P}s  ├─ {agent_type} (agent-{short_id})  [{model_used}]
         │  turns: {turns_A} / {turns_B}  cost: ~${cost_A} / ~${cost_B}  duration: ~{max_duration}s
T+{Q}s  ┴─ parallel group done

T+{S}s     [orchestration_complete] status: {status}
```

Rendering rules:
- Timestamps: `T+{N}s` relative to `orchestration_start`. Round to nearest second.
- Agent short ID: first 8 characters of `agent_id` (e.g., `agent-ab7e7714`).
- If `turns_used` is 0 or absent: show `turns: n/a`.
- If `model_used` is null: show `[inherited]`; if model field absent entirely, omit the bracket annotation.
- If `routing_outcome` exists for this agent and `escalated` is true: append `[{model_used}, escalated from {escalated_from}]` instead.
- Parallel group (2+ agents): use `┬─` for first, `├─` for middle, `┴─` for last. Sequential (1 agent): use `┌─` / `└─`.
- Annotate `replan` and `verify_fix_attempt` / `verify_fix_fail` events inline at their `T+{N}s` offset, indented with `│  [{event_type}] {detail}`.
- Outcome preview: take first 80 characters of `last_message_preview`, stripping any leading `## Result Summary` header line. Truncate with `...` if longer than 80 characters. Omit entirely if `last_message_preview` is null or empty.
- Cap each timeline line at 120 characters; truncate with `...` if needed.

#### Trajectory Insights

After the ASCII timeline, render a `### Trajectory Insights` subsection using fixed heuristics on the computed span data.

Compute and display the following:

**Slowest agent** — span with highest `duration_s`. Show agent type, short ID, duration, turns, and cost.

**Most turns** — span with highest `turns_used`. If it differs from slowest agent, note both separately.

**Costliest agent** — span with highest `estimated_cost_usd`.

**Turns efficiency** — `estimated_cost_usd / turns_used` per span (skip spans with `turns_used` = 0). Show the best (lowest ratio) and worst (highest ratio) agents with their ratio. Omit this row entirely if all spans have `turns_used` = 0 or missing.

**Zero-output agents** — spans where `last_message_preview` starts with a generic phrase (`"No changes"`, `"Nothing to do"`, `"Skipped"`) or where `turns_used` is 0 or 1. Label these `potentially unnecessary`. Omit this row if none found.

**Parallelism ratio** — total wall-clock seconds where 2+ agents ran simultaneously divided by total orchestration duration, expressed as a percentage. If 0%: show `Sequential (no parallel execution)` or omit if the information is obvious from the timeline.

**Verify-fix rounds** — count `verify_fix_attempt` events and list involved agent types. Omit this row if count is 0.

**Replan events** — count `replan` events and list reasons from the `reason` field. If zero, show "No replanning required (plan was stable)."

**Model Routing Assessment** (only if `routing_outcome` events exist) — render a sub-table after the main insights table:
- One row per agent span that has a `routing_outcome` event.
- Columns: Agent, Model, Turns, Cost, Assessment.
- Assessment heuristics (these are signals, not hard rules):
  - `optimal` — agent completed in <20 turns with success.
  - `possible over-allocation (consider haiku)` — agent used sonnet or opus, completed in <5 turns, cost <$0.10.
  - `optimal (high turns justified {model})` — agent used opus or sonnet with turns ≥20.
- Omit this sub-table entirely if no `routing_outcome` events exist.

Render format:

```
### Trajectory Insights

| Metric | Value |
|--------|-------|
| Slowest agent | {agent_type} (agent-{short_id}): {N}s, {T} turns, ~${C} |
| Most turns | {agent_type} (agent-{short_id}): {T} turns |
| Costliest agent | {agent_type} (agent-{short_id}): ~${C} |
| Turns efficiency | Best: {agent_type} ~${ratio}/turn  Worst: {agent_type} ~${ratio}/turn |
| Parallelism | {N}% of wall-clock time had 2+ agents running |
| Verify-fix rounds | {N} rounds (agents: {list}) |
| Replan events | {N} — reasons: {list} |
| Potentially unnecessary | {agent_type} (agent-{short_id}): {reason} |

#### Model Routing Assessment

| Agent | Model | Turns | Cost | Assessment |
|-------|-------|-------|------|------------|
| {agent_type} | {model} | {turns} | ~${cost} | {assessment} |
```

### Files Changed (All Agents)
- [deduplicated list of all files changed across all agents]

### Issues Found
| Severity | Agent | Description |
|----------|-------|-------------|
| warning | reviewer | [issue description] |

### Recommendations
- [aggregated recommendations from all agents]

### Agent Results

#### Architect
[architect's result summary]

#### Developer
[developer's result summary]

#### Reviewer
[reviewer's result summary]
```

4. **Edge cases**:
   - If an orchestration was handled solo (no agents spawned), report that: "This task was handled directly without orchestration."
   - If orchestration failed, include failure details and retry attempts.
   - If `events.jsonl` is missing or empty for the orchestration, omit the Cost Breakdown and Audit Trail sections. Show only the existing report format (Agent Activity, Files Changed, Issues, Recommendations, Agent Results).

*For aggregate performance analytics: `/orchestray:analytics`. For pattern learning metrics: `/orchestray:patterns`.*
