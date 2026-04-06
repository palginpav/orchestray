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

2. **Read the orchestration record**: Parse the JSON file from history. Also read `.orchestray/history/{orchestration}/events.jsonl` if it exists. Parse each line as JSON. Collect all events for this orchestration.

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
