<!-- PM Reference: Loaded by Section Loading Protocol when confirm_before_execute is true (for cost prediction) -->

## 31. Cost Prediction Protocol

Estimate orchestration cost before execution using historical data.

### When to Predict
- During the orchestration preview (Section 0, step 3.5)
- Always calculate, even if preview is not shown (log for accuracy tracking)

### Prediction Method
1. **Count planned agents and models**: From the task graph, tally agents by model tier (Haiku/Sonnet/Opus). If `adversarial_review` is true and complexity >= 8, double the architect agent count (two competing designs will be spawned per Section 38, in adversarial-review.md).
2. **Historical lookup**: Search `.orchestray/history/*/events.jsonl` for past orchestrations with:
   - Same archetype (from Section 13 classification, in tier1-orchestration.md)
   - Similar agent count (+/-1)
   - Completed successfully
3. **Calculate estimate**:
   - If historical matches found (>=2): use median cost of matched orchestrations as estimate, with min-max as range
   - If insufficient history: use baseline estimates per agent:
     - Haiku agent: ~$0.01
     - Sonnet agent: ~$0.04
     - Opus agent: ~$0.10
   - Multiply by agent count, sum across tiers
4. **Display**: "Estimated cost: ~$<median> (range: $<min>-$<max>, based on <N> similar past orchestrations)"
   - If no history: "Estimated cost: ~$<baseline> (baseline estimate -- no historical data yet)"

### Post-Orchestration Accuracy Tracking
After orchestration completes (Section 15, step 3):
1. Compare predicted cost to actual cost
2. Calculate accuracy: `1 - abs(predicted - actual) / actual`
3. Log `cost_prediction` event: `{"type": "cost_prediction", "predicted": <N>, "actual": <N>, "accuracy": <N>, "archetype": "<name>", "agent_count": <N>}`
4. This data improves future predictions via the historical lookup

---

## Section 31a — Haiku-scout cost model + v2.2.1 promotion gate (P2.2)

The v2.2.0 P2.2 design introduces the `haiku-scout` subagent for Class-B
PM I/O. The cost arithmetic the PM applies at decision time per spawn:

### Per-spawn cost components

| Component | Inline-Opus path | Haiku-scout path |
|---|---|---|
| File content read | included in PM's own usage block | small at $1/M (Haiku input) |
| Inherited PM context (50k tokens) | $0.025/call (cache-read at 0.1× × $1/M) | **N/A** — PM context never flows to subagent (OQ-1) |
| Scout system+delegation prompt | n/a | ~$0.003-0.008/spawn at full $1/M input rate |
| Output tokens | small at $25/M (Opus) | small at $5/M (Haiku) |

**Per-call cost (typical Class-B Read of a ~20 KB file):**

- Inline Opus xhigh: ~$0.015 (mostly cache-read on PM's own self-cached prefix).
- Haiku-scout: ~$0.005-0.010 per spawn (full-rate delegation prompt + small
  file content + small output).
- **Net savings per call:** ~$0.005-$0.010 vs the corrected baseline.

These per-call estimates feed `scout_estimated_inline_cost_usd`,
`scout_estimated_scout_cost_usd`, and `scout_estimated_savings_usd` on the
`scout_spawn` audit event (`event-schemas.md` §`scout_spawn`).

### v2.2.1 promotion telemetry gate (binding)

Per OQ-1 §Q5 ("Recommendation for P2.2"), v2.2.1 must NOT auto-flip any
P2.2 sub-knobs (e.g., tightening `scout_min_bytes` below 12288, or
extending `tools:` to add `Bash`) without satisfying ALL THREE:

1. **≥ 100 `scout_spawn` events** observed across the user base since
   v2.2.0 cutover. Source: `events.jsonl` rollup.
   Query: `rg -c '"type":"scout_spawn"' .orchestray/audit/events.jsonl |
   awk '{s+=$1} END {print s}'`.

2. **Cache-read ratio on scout's repeated invocations ≥ 30%.**
   Computed from `pm_turn` rows where `model_used` matches a Haiku model:
   `sum(cache_read_input_tokens) / (sum(cache_read_input_tokens) +
   sum(cache_creation_input_tokens)) >= 0.30`. Caveat: scout `pm_turn`
   rows are tagged differently from PM `pm_turn` rows; v2.2.1 may need a
   separate `scout_turn` row type if cache attribution gets confused.

3. **Mean scout cost < mean inline-Opus cost for equivalent ops.**
   Computed from rolled-up
   `scout_spawn.scout_estimated_savings_usd`:
   `mean(scout_estimated_savings_usd) > 0` over the most recent 100
   spawns. Negative means scouts are net-expensive on average and the
   design has inverted.

**If any criterion fails:** v2.2.1 ships P2.2 unchanged; the failing
metric drives a follow-up architect spike (e.g., adapt
`scout_min_bytes`, add a Block-Z prelude for haiku-scout, or — worst
case — flip default-off and revisit). The architect (not the reviewer)
owns this gate; reviewers confirm the criteria are met before sign-off.

---

<!--
v2.2.3 P4 W2 Strip: Section 32 (Background-housekeeper Haiku cost model
+ promotion path) removed. The orchestray-housekeeper subagent shipped
in v2.2.0 but never fired (0 invocations across 7 post-v2.2.0 orchs).
Real cost savings: ~$0.05/year — well below noise. Reintroduction (if
any) will use an explicit MCP tool with verifiable cost telemetry, not
marker prose. See .orchestray/kb/artifacts/v223-p3-housekeeper-decision.md
and v223-p4-strip-and-a3-impl.md.
-->

