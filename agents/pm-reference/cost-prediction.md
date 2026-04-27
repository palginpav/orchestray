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

## Section 32 — Background-housekeeper Haiku (P3.3) cost model + promotion path

The v2.2.0 P3.3 design introduces the `orchestray-housekeeper` subagent for
three narrow-scope background ops (KB-write verification, schema-shadow regen
diff, telemetry rollup recompute). Tools FROZEN at `[Read, Glob]` ONLY.

### Per-call cost components

| Component | Inline-Opus path | Housekeeper path |
|---|---|---|
| File content read | included in PM's own usage | small at $1/M (Haiku input) |
| System+delegation prompt | n/a | ~$0.001-0.003/spawn at full $1/M input rate |
| Output tokens | small at $25/M (Opus) | small at $5/M (Haiku) |

**Per-call cost (typical: 5–20 KB Read, structured-result echo back):**

- Inline Opus xhigh: ~$0.005–$0.015 (mostly cache-read).
- Housekeeper: ~$0.001–$0.003 per spawn.
- Net savings: ~$0.005–$0.012 per call. Qualitative until P1.1 telemetry lands.

Typical M-orch fires 3–8 housekeeper ops → $0.015–$0.10/orch. Stacked with
P2.2 scout savings (per §31a) and P2.1 cache geometry (per §6.T).

### v2.2.1+ promotion gate (binding — all four criteria required)

Per locked-scope D-5 contract: "limited tools → proven solid → extend tools
in future versions." A v2.2.1+ release that broadens the housekeeper's tool
list (e.g., adds Grep) MUST satisfy ALL FOUR:

1. **≥ 60 days** of zero `housekeeper_drift_detected` events. The drift
   detector (`bin/audit-housekeeper-drift.js`) has run on every SessionStart
   for ≥ 60 days without firing → the agent file is stable.
2. **≥ 100 `housekeeper_action` events** with zero
   `housekeeper_forbidden_tool_blocked` events. The agent has performed ≥ 100
   ops without ever attempting a forbidden tool → the read-only contract is
   genuinely honored.
3. **Explicit commit tagged `[housekeeper-tools-extension]`** updating BOTH
   `agents/orchestray-housekeeper.md` AND `bin/_lib/_housekeeper-baseline.js`.
   Both files MUST update in the same commit; otherwise the drift detector
   quarantines on the first SessionStart post-merge.
4. **Updated test row in `bin/__tests__/p33-housekeeper-whitelist-frozen.test.js`**
   — the new expected `tools:` line. The test fails immediately on the first
   run after the merge if this is forgotten.

### Reverse path (rollback)

If post-extension telemetry shows `housekeeper_forbidden_tool_blocked`
firing (drift in the wrong direction), the rollback is identical in shape: a
commit tagged `[housekeeper-tools-rollback]` reducing the tool list back to
a previous known-good baseline. The same atomicity rules apply.

### Three-layer enforcement summary

| Layer | Surface | Effect |
|---|---|---|
| (a) frontmatter | `tools: [Read, Glob]` in `agents/orchestray-housekeeper.md` | Declarative whitelist. |
| (b) runtime | `bin/validate-task-completion.js` `READ_ONLY_AGENT_FORBIDDEN_TOOLS` map | Exit-2 + `housekeeper_forbidden_tool_blocked` event on `Edit`/`Write`/`Bash`/`Grep`. |
| (c) CI | `bin/__tests__/p33-housekeeper-whitelist-frozen.test.js` byte-equality vs `BASELINE_TOOLS_LINE` | Test fails on any unsanctioned mutation. |

The architect (not the reviewer) owns this gate; reviewers confirm the
criteria are met before sign-off.
