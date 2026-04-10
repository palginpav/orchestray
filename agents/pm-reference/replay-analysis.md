# Section 43: Replay Analysis

Counterfactual analysis for friction orchestrations — detects when orchestrations went
poorly and generates alternative strategies to guide future decision-making.

---

## 43a. Friction Signal Detection

**Integration point:** Section 15 step 3, step 7.4 — after persona refresh check (step 7.3)
and BEFORE auto-documenter (step 8) and user correction feedback (step 9).

**Trigger condition:** `enable_replay_analysis` is true.

Protocol:

1. **Read archived events**: Load `.orchestray/history/{orch-id}/events.jsonl` from the
   just-archived orchestration.

2. **Check for friction signals** — ANY of the following qualifies:
   - `replan` events exist (`replan_count >= 1`)
   - `verify_fix_fail` events exist (quality loop produced a failure)
   - Actual cost (from `orchestration_complete` event `estimated_total_cost_usd`) exceeds
     predicted cost (from `cost_prediction` event if present) by more than 50%
   - Any `confidence_signal` event has `confidence < 0.4`
   - Total `turns_used` across all `agent_stop` events exceeds 2x the sum of estimated
     turn budgets from the task graph

3. **Decision**:
   - If NO friction signals detected: skip replay analysis. Log: "No friction signals
     detected — replay analysis skipped." Stop here.
   - If friction signals detected: record which signals were found, then proceed to 43b.

---

## 43b. Counterfactual Generation

Protocol:

1. **Load archived orchestration context**:
   - Task graph: `.orchestray/history/{orch-id}/task-graph.md` (if archived), or
     reconstruct from task files in `.orchestray/history/{orch-id}/tasks/*.md`.
   - Agent results: `.orchestray/history/{orch-id}/tasks/*.md`
   - Audit events: already loaded in 43a.
   - Reasoning traces: `.orchestray/history/{orch-id}/traces/` (if introspection was
     enabled and trace files exist).

2. **Identify key PM decision points**:
   - **Decomposition strategy**: How many tasks, which agents, what dependency structure.
   - **Model routing**: Which model was assigned to which agent (from `routing_outcome`
     events in the audit trail).
   - **Delegation pattern**: Sequential vs parallel vs selective (from task graph structure).
   - **Architect usage**: Was an architect used? Could the developer have handled it directly?

3. **Generate counterfactual alternatives** using PM reasoning — for each friction signal,
   generate 1-2 alternatives:
   - If `replan` occurred: "What decomposition would have avoided the re-plan?"
   - If `verify_fix_fail` occurred: "Would a higher model tier or additional context have
     prevented the quality failure?"
   - If cost overrun: "Was there a cheaper decomposition (fewer agents, skip architect,
     use Haiku for exploration)?"
   - If low confidence: "Would different model routing or additional context injection
     have raised confidence?"
   - If turns exceeded budget: "Was the task over-decomposed? Could fewer agents have
     handled it with more turns each?"

4. **Estimate expected improvement** for each counterfactual:
   - Turns saved (rough estimate based on turns consumed by the friction event)
   - Cost saved (rough estimate based on model pricing differences)
   - Quality improvement (qualitative: "likely avoided verify-fix" or "reduced re-plan risk")

---

## 43c. Replay Pattern Writing

Protocol:

1. **Write replay pattern** to `.orchestray/patterns/replay-{orch-id}.md`. Before
   writing, ensure the parent directory exists — the Write tool auto-creates parent
   directories, but if writing via Bash run `mkdir -p .orchestray/patterns` first.

   ```markdown
   ---
   name: replay-{orch-id}
   category: replay
   confidence: 0.5
   times_applied: 0
   last_applied: null
   created_from: {orch-id}
   friction_signals: ["{signal1}", "{signal2}"]
   description: "{one-line description of what went wrong and the counterfactual insight}"
   counterfactuals:
     - decision: "{what was decided}"
       alternative: "{what could have been done}"
       expected_saving: "{estimated improvement}"
       rationale: "{why this alternative would have been better}"
   ---

   # Replay: {Human Readable Title}

   ## What Happened
   {Brief description of the orchestration and friction events}

   ## Counterfactual Analysis
   {Detailed analysis of 1-2 alternatives}

   ## Lesson
   {Actionable guidance for future orchestrations}
   ```

   Do not include credentials, tokens, or password-like strings verbatim in summaries.
   Summarize intent instead.

2. **Log `replay_analysis` event** to `.orchestray/audit/events.jsonl`.

3. **Standard pruning**: Replay patterns participate in Section 22d pruning with the same
   scoring formula: `score = confidence * times_applied`. They are not exempt from pruning
   when the pattern cap (50) is reached.

---

## 43d. Replay Pattern Application

**Integration point:** Section 22b pattern application (pre-decomposition), step 3.

When matching patterns during pre-decomposition (Section 22b):

1. **Include replay patterns**: When globbing `.orchestray/patterns/*.md`, replay patterns
   (those with `category: replay`) are included alongside decomposition, routing, and
   specialization patterns.

2. **Advisory counter-evidence role**: Replay patterns are NOT positive guidance — they
   are caution signals. If the PM is about to make a decomposition decision that matches
   a replay pattern's `decision` field (by keyword overlap), surface the `alternative` as
   a consideration with this note:

   > "Note: A previous orchestration using this approach experienced friction
   > ({friction_signals}). Consider alternative: {alternative}."

3. **Cap**: Maximum 1 replay pattern injected per decomposition (the most relevant by
   keyword match and recency — prefer patterns created from more recent orchestrations).

4. **No override**: Replay patterns do NOT override PM judgment. They add advisory
   counter-evidence. If context clearly differs from the replay pattern's documented
   context, ignore the pattern.
