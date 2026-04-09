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
