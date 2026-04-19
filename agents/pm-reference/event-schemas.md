# Event Schemas Reference

JSON event schemas used by the PM agent for audit trail logging. These events are appended
to `.orchestray/audit/events.jsonl`.

---

**2.0.13 additions:** `mcp_checkpoint_missing` (promoted from RESERVED, now IMPLEMENTED
with `phase_mismatch` field), `kill_switch_activated`, `kill_switch_deactivated`. Phase-field
consumer caveat (below) updated for the W1 fix — historical `mcp_checkpoint_recorded` rows
may have `phase: "post-decomposition"` on pre-2.0.13 data due to the BUG-B classification
bug; the W11 sweep flips these on upgrade if they can be identified from `routing.jsonl`
timestamps. Audit-trail rows are never rewritten after emission.

---

---

## Section 19: Routing Outcome Event

`routing_outcome` events come in **three variants**: a hook-emitted partial written
automatically by the `PostToolUse:Agent` hook at `bin/emit-routing-outcome.js`
immediately after `Agent()` is spawned; a PM-supplemented full form written later
during Section 4 result processing; and an auto-emitted completion-time supplement
written by `bin/collect-agent-metrics.js` on every `SubagentStop`/`TaskCompleted`.

### Variant A — Hook-emitted (spawn-time, partial)

Written by `bin/emit-routing-outcome.js` from the `Agent()` tool input. The hook only
has access to what the caller passed to `Agent()`, so fields that require PM knowledge
(complexity score, escalation state, task id, final result) are either omitted or set
to sentinel values.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "routing_outcome",
  "orchestration_id": "<current orch id>",
  "agent_type": "<subagent_type from Agent() call>",
  "tool_name": "Agent | Explore | Task",
  "model_assigned": "<haiku|sonnet|opus, normalized from tool_input.model>",
  "effort_assigned": "<low|medium|high|max or null>",
  "description": "<tool_input.description truncated to 200 chars>",
  "score": null,
  "source": "hook"
}
```

The hook is the primary enforcement mechanism for Section 19 routing compliance: it
fires even if the PM forgets to emit the full form, guaranteeing every spawn leaves
an audit trail with the actual model assigned.

**2.0.12 extension — `tool_name` field:** Added in 2.0.12. Distinguishes which Claude
Code agent-dispatch name was used for the spawn (`"Agent"`, `"Explore"`, or `"Task"`).
The 2.0.12 matcher expansion in `hooks/hooks.json` extended coverage from `Agent`-only
to `Agent|Explore|Task`, making `tool_name` necessary to distinguish Explore (always
Haiku/low-cost per CLAUDE.md guidance) from standard `Agent` invocations.

Backward compatibility: `tool_name` is always present in 2.0.12+ rows. Rows written
by 2.0.11 or earlier do not have this field. Consumers that don't check for `tool_name`
should treat a row without this field as implicit `tool_name: "Agent"` (the 2.0.11
matcher was `Agent`-only). The consumer impact on `bin/collect-agent-metrics.js` cost
attribution for Explore dispatches is documented in the 2.0.12 release notes (T9).

Cross-ref: `tool_name` here is the Claude Code dispatch name — it is NOT related to the
`agent_id` namespace warning in Variant C. Variant A's `tool_name` is never cross-joined
with Agent Teams subtask labels.

### Variant B — PM-supplemented (post-completion, full)

Written by the PM in Section 4 result processing, **in addition to** the hook-emitted
event, when the PM has complete context (task id, complexity score, escalation history,
final outcome). The PM should emit this form for every task so downstream analytics
(cost attribution, pattern extraction, replay analysis) have the full picture.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "routing_outcome",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "agent_type": "<architect|developer|reviewer|{dynamic}>",
  "model_assigned": "<haiku|sonnet|opus>",
  "effort_assigned": "<low|medium|high|max>",
  "effort_override": false,
  "effort_override_reason": null,
  "complexity_score": "<N>",
  "result": "<success|failure|escalated>",
  "escalation_count": 0,
  "escalated_from": null,
  "source": "pm"
}
```

### Variant C — Auto-emitted on SubagentStop (completion-time supplement)

Written by `bin/collect-agent-metrics.js` when a `SubagentStop` or `TaskCompleted`
hook fires. This variant is a safety net: it guarantees a completion-time routing
record exists even when the PM drifts on Variant B. Only emitted when inside an
orchestration context (`orchestration_id !== "unknown"`).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "routing_outcome",
  "orchestration_id": "<current orch id>",
  "agent_type": "<agent_type from SubagentStop, or teammate_name from TaskCompleted>",
  "agent_id": "<agent_id from SubagentStop, or task_id from TaskCompleted>",
  "model_assigned": "<resolved from prior Variant A event, or null if unresolvable>",
  "result": "<heuristic: see derivation below>",
  "turns_used": "<turns counted from transcript>",
  "input_tokens": "<total input tokens>",
  "output_tokens": "<total output tokens>",
  "source": "subagent_stop"
}
```

**What this variant knows:**
- `orchestration_id`, `agent_type`, `agent_id` — from hook payload and orchestration state file
- `model_assigned` — resolved by scanning prior `routing_outcome` events in `events.jsonl`
  for a matching `(orchestration_id, agent_type)` pair (same lookup used for `agent_stop`
  cost attribution)
- `turns_used`, `input_tokens`, `output_tokens` — measured from transcript or event payload

**`agent_id` namespace warning:** the `agent_id` field in Variant C is populated from
**two different sources** depending on the originating hook event, and the two sources
live in different ID namespaces that **must not be cross-joined**:
- For `SubagentStop` events, `agent_id` = `event.agent_id` — an opaque per-invocation
  subagent identifier generated by Claude Code
- For `TaskCompleted` events (Agent Teams), `agent_id` = `event.task_id` — the PM's
  subtask label (human-meaningful string)

Downstream consumers MUST NOT join Variant C records on `agent_id` across mixed
SubagentStop and TaskCompleted events — the values are drawn from incompatible
namespaces and a naive join will silently conflate invocation IDs with subtask labels.
For cross-event correlation, use `(orchestration_id, agent_type)` as the join key
instead. `agent_id` is safe only within a single event-type subset.

**What this variant does NOT know:**
- `task_id` — the PM's internal subtask identifier is not passed through the hook payload
- `complexity_score` — only the PM has this at decomposition time
- Reviewer verdict — the hook fires before any review; `result` is heuristic only
- `effort_override_reason`, escalation history, `escalated_from` — PM-only context

**`result` field derivation (three-way heuristic):**
1. `"error"` — if `output_tokens === 0 && turns_used === 0`: the agent stopped without
   producing output, likely a crash or immediate abort
2. `"unknown"` — if `usage_source === "estimated"`: token counts were fabricated from
   turn count; outcome cannot be determined reliably
3. `"success"` — otherwise: the subagent completed and produced tokens. **This does NOT
   mean the task passed review.** True pass/fail is determined by downstream reviewer
   output. Consumers MUST treat `source: "subagent_stop"` result as "completion
   observed, quality unknown" — not authoritative for task outcome.

### Consumer guidance — routing_outcome (legacy)

Downstream readers (`bin/collect-agent-metrics.js`, pattern extraction, analytics) MUST
handle all three variants. Match on `(orchestration_id, agent_type)` — apply this
precedence when multiple variants exist for the same pair:

- `source: "pm"` (Variant B) is authoritative for `complexity_score`, `result`, and
  escalation state when present. Trust this for pass/fail outcomes.
- `source: "hook"` (Variant A) is authoritative for confirming `model_assigned` was
  actually passed at spawn time. Use this when Variant B is absent.
- `source: "subagent_stop"` (Variant C) is a safety net — guarantees a completion
  observation exists even if the PM drifts on Variant B. Treat `result` as
  "completion observed, quality unknown"; never use it as a pass/fail signal.

New effort fields (Variant B):
- `effort_assigned`: The effort level used for this agent invocation (low, medium, high, max)
- `effort_override`: Whether the effort was overridden from the model's default mapping
  (haiku->low, sonnet->medium, opus->high)
- `effort_override_reason`: Why the override was applied (e.g., "security-sensitive logic",
  "novel design", "boilerplate task"), or null if no override

On escalation, the `escalated_from` field records the previous model and `escalation_count`
increments. For example, a Haiku task that escalated to Sonnet would have:

> **Prefer `routing_decision` (Variant D below) over these three variants.**
> The split routing_outcome pair is retained for backward compatibility.
> New consumers SHOULD prefer `routing_decision` rows which carry both halves
> merged into a single actionable event.

```json
{
  "escalation_count": 1,
  "escalated_from": "haiku",
  "model_assigned": "sonnet",
  "result": "escalated"
}
```

---

### Variant D — `routing_decision` (merged, v2.0.18+)

Emitted by `bin/emit-routing-outcome.js` at `PostToolUse:Agent` time after
correlating the spawn-side data (Variant A) with the stop-side data written by
`bin/collect-agent-metrics.js` to `.orchestray/state/routing-pending.jsonl`.

**Correlation key:** `(orchestration_id, agent_type)`. The pending file entry is
written at `SubagentStop` time (which fires before `PostToolUse:Agent`), so both
sides are available when the merged event is emitted.

**Idempotency:** the pending file entry is consumed (removed) on match, so only
one `routing_decision` is ever emitted per agent invocation.

**Orphan handling:**
- If the stop-side is missing when `PostToolUse:Agent` fires (out-of-order, failed
  agent that never reached `SubagentStop`): no `routing_decision` is emitted.
  The existing Variant A `routing_outcome` row remains as the sole record.
- If `SubagentStop` fires but no matching `PostToolUse:Agent` follows (e.g., the
  PM cancelled the task): `collect-agent-metrics.js` emits a one-line stderr
  warning `routing_decision unmatched: <agent_id>` when it detects the pending
  entry was not consumed after the orchestration ends. The Variant C row remains.

**`completion_volume_ratio`:** `output_tokens / MODEL_OUTPUT_CAPS[model]` where
`MODEL_OUTPUT_CAPS` is defined in `bin/emit-routing-outcome.js`. Currently all
three tiers have a cap of 32768 output tokens. This is a **volume signal, not a
quality score** — a ratio of 1.0 means the agent used the full typical-run output
budget; it does not indicate task quality.

```json
{
  "timestamp": "<stop-time ISO 8601>",
  "type": "routing_decision",
  "orchestration_id": "...",
  "agent_id": "...",
  "agent_type": "developer",
  "tool_name": "Agent | Explore | Task",
  "description": "<tool_input.description truncated to 200 chars>",
  "model_assigned": "<haiku|sonnet|opus>",
  "effort_assigned": "<low|medium|high|max or null>",
  "turns_used": 42,
  "input_tokens": 12000,
  "output_tokens": 5000,
  "result": "<success|error|unknown>",
  "completion_volume_ratio": 0.1526,
  "spawn_timestamp": "<PostToolUse hook timestamp>",
  "duration_ms": 45000
}
```

**Historical synthesis:** `routing_lookup` synthesises `routing_decision` rows
on-the-fly from matched Variant A + Variant C `routing_outcome` pairs found in
`events.jsonl`. Synthesised rows carry `synthesised: true` in the tool response;
emitted rows carry `merged: true`. Consumers SHOULD prefer `merged: true` rows
over `synthesised: true` rows for the same agent invocation (emitted rows used
the actual agent_id as the correlation key; synthesised rows use only agent_type
and may have a small misattribution risk under parallel same-type spawns).

**Retained for backward compatibility:** Variant A, B, and C `routing_outcome`
rows continue to be emitted unchanged. Consumers that currently read
`routing_outcome` rows are not affected. New consumers SHOULD query
`routing_lookup` (which returns merged/synthesised rows preferentially) rather
than scanning `events.jsonl` directly for `routing_outcome`.

---

## Confidence Signal Event

Appended during Section 4.Z (Confidence Signal Reading) after reading an agent's
confidence file. Also appended during Section 14.Z (Inter-Group Confidence Check)
when evaluating confidence between groups.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "confidence_signal",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "agent_type": "<architect|developer|reviewer|...>",
  "checkpoint": "post-exploration | post-approach | mid-implementation | final",
  "confidence": 0.65,
  "risk_factors": ["unfamiliar dependency pattern"],
  "estimated_remaining_turns": 12,
  "would_benefit_from": "architect guidance on module boundary | null",
  "pm_reaction": "proceed | inject_context | escalate | abort"
}
```

Field notes:
- `checkpoint`: The checkpoint at which the agent last wrote its confidence signal.
  Value is one of `post-exploration`, `post-approach`, `mid-implementation`. The PM
  sets this to `final` when logging the signal after agent completion if the agent's
  last checkpoint was `mid-implementation`.
- `confidence`: Float 0.0-1.0 copied from the agent's confidence file.
- `risk_factors`: Array of specific concern strings from the agent's confidence file.
- `pm_reaction`: The action the PM took based on the confidence band:
  `proceed` (>= 0.7), `inject_context` (0.5-0.69), `escalate` (0.3-0.49),
  `abort` (< 0.3). Determined by the PM reaction table in cognitive-backpressure.md.

---

## Dynamic Agent Spawn Event (v2.0.21+)

Auto-emitted by `bin/audit-event.js` (via the `additionalEventsPicker` extension
in `bin/_lib/audit-event-writer.js`) whenever a non-canonical `agent_type` is
detected during `SubagentStart` — i.e., an agent name not in the 17-entry
canonical set (the 13 Orchestray cores plus `Explore`, `Plan`, `general-purpose`,
`Task` from Claude Code's built-ins). Fires alongside the standard `agent_start`
event with the same timestamp; consumers can join on (`agent_id`, `timestamp`).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "dynamic_agent_spawn",
  "orchestration_id": "<current orch id>",
  "agent_id": "<subagent id from SubagentStart payload>",
  "agent_type": "<dynamic agent name>",
  "session_id": "<parent session id>",
  "paired_with": "agent_start"
}
```

Field notes:
- `agent_id`: The subagent's stable id from the `SubagentStart` payload — same
  value as on the paired `agent_start` event.
- `agent_type`: The non-canonical agent name (e.g. `researcher`,
  `claude-code-guide`, or any project-defined specialist).
- `session_id`: The parent (PM) session id, not the subagent's own session.
- `timestamp` is shared with the paired `agent_start` event.
- `paired_with`: Always `"agent_start"`. Emitted alongside; consumers can join
  on `(agent_id, timestamp)` to correlate the spawn event with its corresponding
  `agent_start` event.

Note: `tool_name` and the spawn `description` are NOT in this event because
`SubagentStart` payloads do not carry them. To recover those, join on
(`agent_id`, `timestamp`) against the corresponding `routing_outcome` event
emitted from `PostToolUse(Agent|Explore|Task)`.

Cross-ref: if the dynamic agent is subsequently saved via
`mcp__orchestray__specialist_save`, a `specialist_saved` event follows.
Consumers can join on (`orchestration_id`, `agent_type`) to correlate spawn
and save events.

---

## Section 20: Specialist Saved Event

Appended when a dynamic agent is saved as a persistent specialist:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "specialist_saved",
  "orchestration_id": "<current>",
  "agent_name": "{name}",
  "source": "auto"
}
```

---

## Section 20: Specialist Promoted Event

Appended when a specialist is promoted to permanent availability:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "specialist_promoted",
  "orchestration_id": "<current>",
  "agent_name": "{name}",
  "times_used": "{final count}",
  "promoted_to": ".claude/agents/{name}.md"
}
```

---

## Section 21: Specialist Reused Event

Appended when a specialist from the registry is reused for a subtask:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "specialist_reused",
  "orchestration_id": "<current>",
  "agent_name": "{name}",
  "times_used": "{new count}"
}
```

---

## Pattern Skip Enriched Event (W11 LL1)

Appended by `mcp__orchestray__pattern_record_skip_reason` when the PM records a
structured skip decision for a pattern returned by `pattern_find`. This event is emitted
**in addition to** the standard `mcp_tool_call` audit row and carries counterfactual
signal so operators can distinguish "skipped because contextually mismatched" from
"skipped because forgotten."

Cross-ref: the MCP tool that emits this event is `pattern_record_skip_reason`
(`bin/mcp-server/tools/pattern_record_skip_reason.js`). The structured skip-recording
contract is documented in `pattern-extraction.md §22b-pre`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_skip_enriched",
  "orchestration_id": "<current orch id>",
  "pattern_name": "<kebab-case pattern slug, or null if not provided>",
  "match_quality": "strong-match | weak-match | edge-case",
  "skip_category": "contextual-mismatch | stale | superseded | operator-override | forgotten",
  "skip_reason": "<freeform prose, or null>",
  "cited_confidence": 0.35,
  "superseded_by": "<name of superseding pattern>"
}
```

Field notes:
- `pattern_name`: Identifies which pattern was skipped. Optional in the tool call but
  highly recommended for retrospective analysis — without it the event cannot be
  correlated back to a specific pattern.
- `match_quality`: How well the pattern's context predicate matched the current task.
  `strong-match` = the pattern clearly applied; `weak-match` = partial overlap;
  `edge-case` = the pattern's documented context was at the boundary of applicability.
- `skip_category`: The primary reason the pattern was not applied. See
  `pattern-extraction.md §22b-pre` for the full taxonomy and guidance on when to use each.
- `skip_reason`: Free-form prose (from either the `skip_reason` or `note` input field).
  May be `null` when no prose was provided.
- `cited_confidence`: Optional. The `decayed_confidence` value from `pattern_find`
  results at decision time. Present only when the PM passed `cited_confidence` in the
  tool call. Useful for clustering analysis (e.g., "do stale skips cluster at 0.3–0.4?").
- `superseded_by`: Optional. Present only when `skip_category` is `"superseded"`.
  Names the pattern that takes precedence.

**Operator-facing warning:** when `skip_category: forgotten` exceeds 30% of the last
25 `pattern_skip_enriched` events for a given orchestration, the MCP server emits a
one-line stderr warning: `"pattern skip enrichment: <X>% forgotten over last <N> skips
— consider explicit categorisation"`. This is advisory and never blocks the tool call.

---

## Pattern Pruned Event

Appended when low-value patterns are removed during pruning (step 7 of the learn skill):

```json
{
  "type": "pattern_pruned",
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "name": "pattern-name",
  "category": "decomposition|routing|specialization|anti-pattern|user-correction",
  "confidence": 0.5,
  "times_applied": 0,
  "score": 0.0,
  "reason": "Below pruning threshold (cap: 50 patterns)"
}
```

---

## Contract Check Event

Appended when pre-condition or post-condition contracts are validated (Section 4.X in
pm.md and Section 14.X in tier1-orchestration.md):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "contract_check",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "phase": "pre | post",
  "checks": [
    {
      "type": "file_exists | file_contains | diff_only_in | file_exports | command_exits_zero",
      "target": "<path, pattern, file list, or command being checked>",
      "result": "pass | fail",
      "detail": "<human-readable detail -- file path found, grep match, or failure reason>"
    }
  ],
  "overall": "pass | partial_fail | fail"
}
```

Field notes:
- `phase`: `"pre"` for pre-condition checks before agent spawn, `"post"` for post-condition
  checks after agent completion.
- `overall`: `"pass"` if all checks passed, `"fail"` if all failed, `"partial_fail"` if
  some passed and some failed.
- `checks` array contains one entry per contract. The `target` field holds the argument(s)
  from the contract definition (e.g., the file path for `file_exists`, the file list for
  `diff_only_in`).

---

## Section 39: Consequence Forecast Event

Appended during Section 15 step 7.6 (post-execution consequence validation):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "consequence_forecast",
  "orchestration_id": "<current orch id>",
  "predictions": [
    {
      "target_file": "path/to/file",
      "category": "direct | convention | test",
      "prediction": "One-line prediction of what might be affected",
      "verified": true,
      "outcome": "addressed | missed | wrong"
    }
  ],
  "accuracy": {
    "total": 5,
    "addressed": 3,
    "missed": 1,
    "wrong": 1
  }
}
```

Field notes:
- `category`: How the downstream file was identified — `direct` (imports the modified file),
  `convention` (follows the same pattern), or `test` (test file for the modified file).
- `verified`: Always `true` in Phase B (post-validation). Set to `false` only if validation
  was skipped (e.g., orchestration aborted before Phase B ran).
- `outcome`: `addressed` means the file was touched during orchestration. `missed` means
  the prediction was plausible but the file was not touched — flagged to the user.
  `wrong` means the prediction was incorrect (no real dependency).

---

## Orchestration ROI Event

Appended during Section 15.Z (ROI Scorecard Generation) after all post-orchestration
steps complete:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "orchestration_roi",
  "orchestration_id": "<current orch id>",
  "agents_used": 3,
  "issues_caught": { "error": 2, "warning": 5 },
  "verify_fix_rounds": 1,
  "contract_checks": { "passed": 4, "failed": 0 },
  "consequence_predictions": { "total": 5, "addressed": 3, "missed": 1, "wrong": 1 },
  "files_created": 2,
  "files_modified": 4,
  "tests_added": 3,
  "estimated_manual_minutes": 45,
  "actual_cost_usd": 0.234,
  "opus_baseline_usd": 0.567,
  "routing_savings_usd": 0.333
}
```

Field notes:
- `agents_used`: Count of distinct agents spawned (not counting PM itself).
- `issues_caught`: Errors and warnings from reviewer `issues` arrays. Set to `0` if no
  reviewer was used.
- `verify_fix_rounds`: Total verify-fix rounds across all subtasks. `0` if none occurred.
- `contract_checks`: From `contract_check` audit events. `passed` counts `overall: "pass"`,
  `failed` counts `overall: "fail"` or `"partial_fail"`. Both `0` if `contract_strictness`
  is `"none"`.
- `consequence_predictions`: From `consequence_forecast` audit events. All zeros if
  `enable_consequence_forecast` is `false`.
- `estimated_manual_minutes`: Heuristic estimate (5 min/file created, 3 min/file modified,
  3 min/test, 10 min/design doc, 5 min/file reviewed).
- `opus_baseline_usd`: Sum of `estimated_cost_opus_baseline_usd` from `agent_stop` events.
- `routing_savings_usd`: `opus_baseline_usd - actual_cost_usd`. Can be `0` if all agents
  used Opus.

---

## Introspection Trace Event

Appended during Section 4.Y (Reasoning Trace Distillation) after each non-Haiku agent
completes and the Haiku distiller extracts a reasoning trace:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "introspection_trace",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "source_agent": "<architect|developer|reviewer|...>",
  "source_model": "<sonnet|opus>",
  "distiller_model": "haiku",
  "trace_file": ".orchestray/state/traces/task-<id>-trace.md",
  "sections_extracted": ["approaches_considered", "assumptions", "trade_offs", "risky_decisions", "discoveries"],
  "word_count": 450,
  "distillation_cost_usd": 0.005
}
```

Field notes:
- `source_agent`: The agent type whose output was distilled (never "haiku" — Haiku agents
  are skipped per Section 4.Y skip conditions).
- `source_model`: The model used by the source agent (sonnet or opus, never haiku).
- `distiller_model`: Always "haiku" — the distiller is a lightweight Haiku agent.
- `sections_extracted`: The 5 reasoning sections present in the trace file. Always all 5
  (sections with no content contain "None identified.").
- `word_count`: Approximate total word count across all 5 sections.
- `distillation_cost_usd`: Estimated cost of the Haiku distillation (~$0.005).

---

## Disagreement Surfaced Event

Appended during Section 18.D (Disagreement Detection) when a reviewer warning is
classified as a design trade-off and surfaced to the user:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "disagreement_surfaced",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "agent_a": {
    "type": "reviewer",
    "position": "<description of the reviewer's suggested approach>"
  },
  "agent_b": {
    "type": "developer",
    "position": "<description of the developer's implemented approach>"
  },
  "category": "design-preference | security-trade-off | performance-trade-off",
  "user_decision": "keep_current | apply_suggestion | defer | auto_preference",
  "preference_saved": true,
  "preference_name": "<kebab-case name of the saved design-preference pattern, or null>"
}
```

Field notes:
- `agent_a`: The reviewer who raised the finding. `position` summarizes their suggestion.
- `agent_b`: The developer whose implementation is being questioned. `position` summarizes
  what they built.
- `category`: Classification of the trade-off type. `design-preference` for general design
  choices, `security-trade-off` for security vs. convenience trade-offs,
  `performance-trade-off` for performance vs. readability trade-offs.
- `user_decision`: The user's choice. `keep_current` means the developer's approach stands.
  `apply_suggestion` means the reviewer's approach will be implemented. `defer` means the
  user chose not to decide now. `auto_preference` means a matching design-preference pattern
  was applied automatically without prompting the user.
- `preference_saved`: Whether a design-preference pattern was created or updated. Always
  `false` when `user_decision` is `"defer"`.
- `preference_name`: The name of the saved or updated pattern, or `null` if no pattern
  was saved.

---

## Agent Stop Event

Appended when an agent finishes execution (used in audit trail and cost tracking):

```json
{
  "type": "agent_stop",
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "agent_id": "agent-xxx",
  "agent_type": "developer",
  "session_id": "uuid",
  "last_message_preview": "First 200 chars...",
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
  "usage_source": "transcript|event_payload|estimated",
  "estimated_cost_usd": 0.123,
  "estimated_cost_opus_baseline_usd": 0.456,
  "transcript_path": "/path/to/transcript.jsonl",
  "model_used": "sonnet|opus|haiku|null",
  "turns_used": 12
}
```

---

## Invariant Extracted Event

Appended during Section 4 result processing when an architect agent completes and
`enable_drift_sentinel` is true. Records each invariant extracted from the architect's
output after user confirmation.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "invariant_extracted",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "source": "architect-extraction | static-rule",
  "invariant_id": "decision-{slug}",
  "invariant_text": "<human-readable invariant>",
  "confidence": 0.8,
  "user_confirmed": true
}
```

Field notes:
- `source`: How the invariant was identified. `architect-extraction` for invariants
  parsed from architect output. `static-rule` for built-in rules registered at
  orchestration start.
- `confidence`: 0.8 for explicit "must"/"never" statements, 0.6 for "should" statements.
- `user_confirmed`: Whether the user confirmed the invariant before enforcement. Always
  `true` for architect-extracted invariants (confirmation is required). Always `true` for
  static rules (they are enabled by default).

---

## Drift Check Event

Appended during Section 15 step 7.6 (post-execution drift validation) when
`enable_drift_sentinel` is true.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "drift_check",
  "orchestration_id": "<current orch id>",
  "phase": "pre | post",
  "invariants_checked": 3,
  "violations": [
    {
      "rule": "no-removed-exports | decision-auth-isolation | ...",
      "source": "static | extracted | session",
      "severity": "error | warning",
      "detail": "Human-readable description of the violation",
      "file": "path/to/violating/file"
    }
  ],
  "overall": "clean | warnings | violations"
}
```

Field notes:
- `phase`: `"pre"` for pre-execution invariant loading, `"post"` for post-execution
  drift validation. Pre-execution events have zero violations (they record what was loaded).
- `violations`: Array of individual violations found. Empty array if `overall` is `"clean"`.
- `source`: How the violated invariant was established — `static` for built-in rules,
  `extracted` for architect-output invariants, `session` for same-orchestration decisions.
- `severity`: `"error"` for explicit "must not"/"never" invariants, `"warning"` for
  "should" invariants and static rule violations.
- `overall`: `"clean"` if no violations, `"warnings"` if only warning-severity violations,
  `"violations"` if any error-severity violations exist.

---

## Visual Review Event

Appended during Section 4.V (Visual Review Integration) after screenshot discovery
completes and the reviewer delegation is prepared:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "visual_review",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "screenshots_found": 3,
  "screenshot_sources": ["convention", "storybook", "cypress", "playwright", "manual", "other"],
  "visual_findings": { "error": 0, "warning": 1, "info": 1 },
  "ui_files_changed": 2,
  "fallback_to_text_only": false
}
```

Field notes:
- `screenshots_found`: Total number of screenshots discovered across all sources. `0` if
  fallback to text-only.
- `screenshot_sources`: Array of source classifications (see visual-review.md for the
  classification table). Empty array if no screenshots found.
- `visual_findings`: Counts of visual-specific issues reported by the reviewer, by severity.
  Populated after the reviewer completes. Set to `{ "error": 0, "warning": 0, "info": 0 }`
  if fallback to text-only or if the reviewer reported no visual findings.
- `ui_files_changed`: Count of files from the developer's `files_changed` that matched
  UI file patterns (*.tsx, *.jsx, *.vue, *.svelte, *.css, *.scss, *.less, *.html, etc.).
- `fallback_to_text_only`: `true` if `enable_visual_review` was true and UI files were
  changed but no screenshots were found. `false` if screenshots were found and used.

---

## Thread Created Event

Appended during Section 40a (post-orchestration thread creation):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "thread_created",
  "orchestration_id": "<current orch id>",
  "thread_id": "thread-{orch-id}",
  "thread_file": ".orchestray/threads/thread-{orch-id}.md",
  "domain_tags": ["tag1", "tag2", "tag3"],
  "files_touched_count": 5,
  "summary_word_count": 180
}
```

---

## Thread Matched Event

Appended during Section 40b (pre-decomposition thread scanning):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "thread_matched",
  "orchestration_id": "<current orch id>",
  "thread_id": "thread-{matched-orch-id}",
  "match_score": 0.72,
  "matching_tags": ["auth", "jwt"],
  "tokens_injected": 285
}
```

---

## Thread Updated Event

Appended during Section 40c (thread update when a new orchestration matches an existing thread):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "thread_updated",
  "orchestration_id": "<current orch id>",
  "thread_id": "thread-{matched-orch-id}",
  "thread_file": ".orchestray/threads/thread-{matched-orch-id}.md",
  "sessions_count": 3,
  "new_domain_tags": ["tag4"],
  "new_files_count": 2
}
```

Field notes:
- `sessions_count`: The value of the `sessions` counter after incrementing (reflects how
  many orchestrations have contributed to this thread total).
- `new_domain_tags`: Tags added to the thread by this orchestration that were not already
  present (the delta, not the full merged list).
- `new_files_count`: Number of files from the current orchestration's `files_changed` that
  were not already in the thread's `files_touched` list.

---

## Persona Generated Event

Appended during Section 42b (persona synthesis):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "persona_generated",
  "orchestration_id": "<current orch id>",
  "agent_type": "developer | architect | reviewer | ...",
  "persona_file": ".orchestray/personas/{agent-type}.md",
  "word_count": 85,
  "generated_from_count": 3,
  "is_refresh": false
}
```

Field notes:
- `generated_from_count`: Number of orchestration IDs listed in the persona's
  `generated_from` frontmatter field.
- `is_refresh`: `true` if this overwrites an existing persona file (refresh cycle),
  `false` if this is the initial generation for this agent type.

---

## Persona Injected Event

Appended during Section 42c (persona injection into delegation prompt):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "persona_injected",
  "orchestration_id": "<current orch id>",
  "task_id": "<subtask id>",
  "agent_type": "developer | architect | reviewer | ...",
  "persona_file": ".orchestray/personas/{agent-type}.md",
  "word_count": 85,
  "staleness_days": 0
}
```

Field notes:
- `task_id`: The subtask ID of the delegation this persona was injected into.
- `word_count`: Actual word count injected (may be less than persona's `word_count` if
  trimmed to 150-word cap).
- `staleness_days`: Number of days since `updated_at`. `0` if fresh. If >= 30, the
  injected content includes the `[STALE]` prefix warning.

---

## Probe Created Event

Appended during Section 41a (post-orchestration probe creation):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "probe_created",
  "orchestration_id": "<current orch id>",
  "probe_id": "probe-{orch-id}",
  "probe_file": ".orchestray/probes/probe-{orch-id}.md",
  "files_delivered_count": 4,
  "tests_added_count": 2,
  "success_conditions_count": 5,
  "patterns_tracked": ["pattern-name-1", "pattern-name-2"]
}
```

Field notes:
- `files_delivered_count`: Total number of files in `files_delivered` (all agent results
  combined, excluding test files).
- `tests_added_count`: Number of test files added (matched `*.test.*`, `*.spec.*`,
  `test_*`, `*_test.*` patterns).
- `success_conditions_count`: Total number of success conditions generated across all
  three condition types (files_unchanged, tests_pass, git_log_clean).
- `patterns_tracked`: Names of patterns from `patterns_applied` that will receive
  confidence adjustments when the probe is validated.

---

## Probe Validated Event

Appended during Section 41b (lazy probe validation at session start):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "probe_validated",
  "orchestration_id": "<session context, not the probe's orch id>",
  "probe_id": "probe-{original-orch-id}",
  "probe_orchestration_id": "<the orchestration that created this probe>",
  "outcome": "positive | negative | neutral",
  "checks": [
    {
      "type": "files_unchanged | tests_pass | git_log_clean",
      "result": "positive | negative | neutral | inconclusive",
      "detail": "Human-readable detail"
    }
  ],
  "patterns_affected": ["pattern-name-1"],
  "confidence_adjustments": [
    {
      "pattern": "pattern-name-1",
      "old_confidence": 0.7,
      "new_confidence": 0.85,
      "delta": 0.15
    }
  ]
}
```

Field notes:
- `orchestration_id`: Session identifier — either an active orchestration ID (when
  validation runs during orchestration mode) or `session-{ISO8601}` for session-start
  validation where no orchestration ID exists yet. Never the probe's own orchestration ID.
- `probe_orchestration_id`: The orchestration ID from the probe's frontmatter — the
  orchestration whose quality is being assessed.
- `outcome`: Aggregated outcome across all checks. `positive` if all checks positive,
  `negative` if any check negative, `neutral` if mixed or all inconclusive.
- `checks`: One entry per success condition evaluated. `inconclusive` result means test
  infrastructure failed (command not found, timeout) — not counted toward outcome.
- `patterns_affected`: Pattern names that received confidence adjustments via Section 41c.
- `confidence_adjustments`: Per-pattern delta log. `delta` is `+0.15` for positive
  outcomes and `-0.3` for negative outcomes.

---

## Replay Analysis Event

Appended during Section 43c (replay pattern writing):

```json
{
  "timestamp": "<ISO 8601>",
  "type": "replay_analysis",
  "orchestration_id": "<current orch id>",
  "friction_signals": ["replan", "verify_fix_fail"],
  "counterfactuals_generated": 2,
  "replay_pattern_file": ".orchestray/patterns/replay-{orch-id}.md",
  "expected_savings": {
    "turns": 15,
    "cost_usd": 0.08
  }
}
```

Field notes:
- `friction_signals`: Array of signal types detected (any of: `replan`, `verify_fix_fail`,
  `cost_overrun`, `low_confidence`, `turns_exceeded`).
- `counterfactuals_generated`: Number of counterfactual alternatives written into the
  replay pattern's `counterfactuals` array.
- `replay_pattern_file`: Path to the written replay pattern file.
- `expected_savings.turns`: Estimated turns that could be saved by applying the
  counterfactual alternative (rough estimate from friction event turn counts).
- `expected_savings.cost_usd`: Estimated cost saving in USD based on the turn/model
  difference between actual and counterfactual paths.

---

## MCP Checkpoint Recorded Event

Appended after every enforced MCP tool call (`pattern_find`, `kb_search`,
`history_find_similar_tasks`, `pattern_record_application`) that fires inside an
orchestration. Written by `bin/record-mcp-checkpoint.js` via the
`PostToolUse:mcp__orchestray__*` hook.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "mcp_checkpoint_recorded",
  "orchestration_id": "<current orch id>",
  "tool": "pattern_find | kb_search | history_find_similar_tasks | pattern_record_application",
  "outcome": "answered | error | skipped",
  "phase": "pre-decomposition | post-decomposition",
  "result_count": "<integer or null>",
  "source": "hook"
}
```

Field notes:
- `tool`: The short tool name — the `mcp__orchestray__` prefix is stripped before writing.
  Only the four enforced tools above are written; any other `mcp__orchestray__*` call is
  silently ignored by the hook.
  **Note:** `pattern_record_skip_reason` is NOT recorded as a checkpoint row — its signal
  flows via `mcp_tool_call` rows in `events.jsonl`, not via this event type. Consumers
  that need to count skip-reason events should query `events.jsonl` via
  `history_query_events`.
- `outcome`: Derived from `event.tool_response` (a JSON string) — `"answered"` if parsed
  successfully and `isError` is absent/false, `"error"` on parse failure or `isError === true`,
  `"skipped"` if `tool_response` is absent or null. **2.0.13 note (BUG-A fix):** pre-2.0.13
  rows used `event.tool_result` (undefined in CC 2.1.59), so those rows have
  `outcome: "skipped"` regardless of actual result. The sealed audit trail is immutable —
  no migration is applied to `events.jsonl` outcome fields.
- `phase`: Derived at hook time by reading `.orchestray/state/routing.jsonl` and counting
  entries matching the current `orchestration_id` — `"post-decomposition"` if at least one
  entry matches, `"pre-decomposition"` otherwise. Fails open to `"pre-decomposition"` on
  routing-file errors. **2.0.13 note (BUG-B fix):** pre-2.0.13 rows used a global
  file-presence check (ignoring orchestration identity), so second-and-later orchestrations
  recorded pre-decomposition calls as `"post-decomposition"`. The W11 post-upgrade sweep
  flips identifiable poisoned rows in `mcp-checkpoint.jsonl` using a routing-timestamp
  heuristic; flipped rows gain `_migrated_from_phase: "post-decomposition"`. Rows with
  `_migrated_from_phase: "post-decomposition"` are W11-corrected; other `post-decomposition`
  rows are authentic post-decomposition calls (PM wrote routing entries before calling the
  trio). `events.jsonl` phase fields are never rewritten after emission.
- `result_count`: For `pattern_find` only — the number of patterns returned by the call
  (best-effort: read from `tool_result.structuredContent.count` or heuristic regex on
  `content[0].text`). `null` for all other tools and on parse failure.
- `source`: Always `"hook"` — written by `bin/record-mcp-checkpoint.js`, never by the PM.

**Purpose:** audit-trail record of an MCP retrieval call — the sealed twin of the
operational `mcp-checkpoint.jsonl` ledger. `gate-agent-spawn.js` reads
`.orchestray/state/mcp-checkpoint.jsonl` for enforcement; `events.jsonl` is the sealed
audit copy consumed by `orchestray:analytics` and `orchestray:report`.

**PII discipline:** `tool_input` and `tool_result` content are never written to either
file. Only the classified `outcome`, the `phase`, and (for `pattern_find`) the
`result_count` are derived from `tool_result` — per T4 Review Finding S1.

**Schema stability:** additive only. Consumers that do not recognise this event type
should ignore it. New fields will only be added as optional.

---

## MCP Checkpoint Missing Event

IMPLEMENTED (as of 2.0.13, task 2013-W3). Emitted by `bin/gate-agent-spawn.js`
immediately before `exit(2)` whenever the MCP pre-decomposition checkpoint gate
blocks a spawn. The event provides a machine-readable signal for analytics (gate
block rate, §22c confidence feedback) to learn which tools the PM tends to skip.

Written via `atomicAppendJsonl` to `.orchestray/audit/events.jsonl`. Fail-open:
if the write fails, a stderr warning is emitted but the block still proceeds.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "mcp_checkpoint_missing",
  "orchestration_id": "<current orch id>",
  "missing_tools": ["kb_search", "history_find_similar_tasks"],
  "phase_mismatch": false,
  "source": "hook"
}
```

**Fields:**

- `missing_tools` (string[]) — the tool names that the null-filter check found
  absent. Populated from `missingRequiredToolsFromRows(..., null)` — phase is
  ignored for enforcement, so this reflects genuine absence regardless of how the
  rows were phase-labelled.

- `phase_mismatch` (boolean) — `true` when the gate's strict-phase check
  (`phaseFilter='pre-decomposition'`) would have shown missing tools that the
  null-filter check allowed through. This fires on the BUG-D defense-in-depth
  path under the W1 fix: rows are present in the ledger but with
  `phase: "post-decomposition"` because they were written by a pre-2.0.13 hook
  on a project with an existing `routing.jsonl`. Consumers should treat
  `phase_mismatch: true` as a signal to recommend the W11 migration sweep.

- `source` — always `"hook"` for events emitted by gate scripts.

**Schema stability:** additive only. Consumers that do not recognise this event
type should ignore it. New fields will only be added as optional.

---

## Pattern Record Skipped Event

Appended at pre-compaction (PreCompact hook) as an advisory data-quality signal when
`pattern_find` returned results during an orchestration but `pattern_record_application`
was never called — meaning no pattern was recorded as having shaped decomposition.
Written by `bin/record-pattern-skip.js`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_record_skipped",
  "orchestration_id": "<current orch id>",
  "pattern_find_result_count_total": "<integer>",
  "reason": "pattern_find returned results but pattern_record_application was never called"
}
```

Field notes:
- `type`: Matches the `"type"`/`"timestamp"` key convention used across every other
  event in this file. Consumers scanning for `ev.type === 'pattern_record_skipped'`
  will match these rows correctly.
- `pattern_find_result_count_total`: Sum of `result_count` across all `pattern_find`
  checkpoint rows for this orchestration (nulls counted as 0).
- `reason`: Fixed string — always the value shown above.

**Purpose:** data-quality health signal for §22c confidence feedback. Flags
orchestrations where patterns were available but the PM did not record which pattern
influenced decomposition. §22c should treat this as "no data this run" rather than
"PM failed to comply" (DESIGN §Risks R7).

**Advisory only:** does not block any spawn, does not affect exit codes. The hook exits
0 unconditionally.

**Idempotency:** emitted exactly once per `orchestration_id`. The script scans
`events.jsonl` for a prior `pattern_record_skipped` row with the same `orchestration_id`
before writing. This guard matters because PreCompact may fire more than once per session
(repeated compactions).

**Hook trigger:** PreCompact — NOT SubagentStop. DESIGN §D2 step 7 originally specified
SubagentStop with a PM-only guard. That assumption is architecturally wrong: the
Orchestray PM is the main session agent (configured via `settings.json`), not a spawned
child. `SubagentStop` fires only for spawned subagents and never for the main session.
PreCompact is the closest available session-boundary hook and is already used by this
project (`bin/pre-compact-archive.js`). See commit `8761fb2` for the full investigation.
**T10 action required:** update DESIGN §D2 step 7 to reflect the PreCompact trigger.

---

## Kill Switch Activated Event

IMPLEMENTED (as of 2.0.13, task 2013-W7). Emitted by `bin/emit-kill-switch-event.js`
(called from the `skills/orchestray:config` skill write path) immediately after a
successful write that flips `mcp_enforcement.global_kill_switch` from `false` → `true`.

Written via `atomicAppendJsonl` to `.orchestray/audit/events.jsonl`. Fail-open:
if the write fails, a stderr warning is emitted and the config write proceeds normally.
Only emitted on a real value change — no-op flips (writing the same value) produce
no event. Grep anchor: `2013-W7-kill-switch`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "kill_switch_activated",
  "orchestration_id": "<current orch id, or null if no orchestration active>",
  "reason": "<user-supplied reason string, or null>",
  "source": "config-skill",
  "previous_value": false,
  "new_value": true
}
```

**Fields:**

- `orchestration_id` (string|null) — the active orchestration at the time of the flip,
  read from `.orchestray/audit/current-orchestration.json`. `null` if the file is absent
  or the stored value is `"unknown"` (the switch was flipped outside an active orchestration).

- `reason` (string|null) — optional free-text reason supplied by the operator via the
  `/orchestray:config set mcp_enforcement.global_kill_switch true --reason "..."` flag.
  When activating the switch, the config skill also interactively prompts for a reason
  if the flag is absent — this is the recovery-from-emergency context that analytics
  consumers use to distinguish planned tests from real incidents. When deactivating,
  the skill does NOT prompt (deactivation is the normal recovery path and should not
  add friction). `null` if the operator declined to supply a reason or the flag was
  absent during a non-interactive deactivation. Populated as of 2.0.13.

- `source` — always `"config-skill"` for events emitted via the config write path.

- `previous_value` (boolean) — the value of `global_kill_switch` BEFORE the write.
  Always `false` for `kill_switch_activated` events.

- `new_value` (boolean) — the value of `global_kill_switch` AFTER the write.
  Always `true` for `kill_switch_activated` events.

**Consumer guidance:** analytics-only. This event is NOT consumed by hooks (the
`gate-agent-spawn.js` kill-switch check reads `config.json` directly — not events.jsonl).
Consumers are `orchestray:analytics` (health signals section) for current-state display
and time-window history queries for "kill switch was active from T1 to T2" analysis.

**Schema stability:** additive only. Consumers that do not recognise this event type
should ignore it. New fields will only be added as optional.

---

## Kill Switch Deactivated Event

IMPLEMENTED (as of 2.0.13, task 2013-W7). Emitted by `bin/emit-kill-switch-event.js`
(called from the `skills/orchestray:config` skill write path) immediately after a
successful write that flips `mcp_enforcement.global_kill_switch` from `true` → `false`.

Written via `atomicAppendJsonl` to `.orchestray/audit/events.jsonl`. Fail-open:
if the write fails, a stderr warning is emitted and the config write proceeds normally.
Only emitted on a real value change — no-op flips produce no event.
Grep anchor: `2013-W7-kill-switch`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "kill_switch_deactivated",
  "orchestration_id": "<current orch id, or null if no orchestration active>",
  "reason": "<user-supplied reason string, or null>",
  "source": "config-skill",
  "previous_value": true,
  "new_value": false
}
```

**Fields:** Identical structure to `kill_switch_activated`. The only difference is
`previous_value: true` and `new_value: false`.

**Consumer guidance:** analytics-only. Pairs with `kill_switch_activated` events to
close the activation window. The `orchestray:analytics` health signals section uses the
most recent activation/deactivation pair from the last 100 events to determine whether
the kill switch is currently "open" (activated without a subsequent deactivation).

**Schema stability:** additive only. Consumers that do not recognise this event type
should ignore it. New fields will only be added as optional.

---

## Anti-Pattern Advisory Shown Event

IMPLEMENTED (as of v2.0.18, W12 LL3). Emitted by `bin/gate-agent-spawn.js` (PreToolUse
hook) when the anti-pattern advisory gate fires an advisory injection into a spawned
agent's context via the `additionalContext` hook mechanism.

This event is **advisory-only** — it never correlates with a blocked spawn. Every
emission of this event means an `additionalContext` string was injected and the spawn
was allowed (exit 0). Grep anchor: `W12-LL3-anti-pattern-advisory`.

Written via `atomicAppendJsonl` to `.orchestray/audit/events.jsonl`. Fail-open: if the
write fails, a stderr warning is emitted and the spawn proceeds normally.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "anti_pattern_advisory_shown",
  "orchestration_id": "<current orch id, or 'unknown' if no orchestration active>",
  "pattern_name": "<kebab-case name from pattern frontmatter>",
  "agent_type": "<subagent_type from the Agent() call, or empty string>",
  "matched_trigger": "<the trigger_actions substring that matched>",
  "decayed_confidence": "<number 0.0..1.0, computed at advisory time>"
}
```

**Fields:**
- `timestamp`: ISO 8601 UTC string. Canonical field name — not `ts`.
- `type`: Always `"anti_pattern_advisory_shown"`. Canonical field name — not `event`.
- `orchestration_id`: The current orchestration's ID, or `"unknown"` when no
  orchestration file is readable.
- `pattern_name`: The `name` field from the anti-pattern's frontmatter, or the
  filename stem if `name` is absent.
- `agent_type`: The `subagent_type` from the `Agent()` tool input. Empty string when
  the spawn did not specify a type.
- `matched_trigger`: The specific `trigger_actions` substring that produced the match.
  Useful for tuning: if this trigger fires false-positives, tighten the pattern's
  `trigger_actions` list.
- `decayed_confidence`: The `decayed_confidence` computed at advisory time using W9's
  exponential decay formula. Always >= `anti_pattern_gate.min_decayed_confidence` (0.65
  by default) since sub-threshold matches are filtered before emission.

**Consumer guidance:**
- Analytics: count advisories per pattern to identify which anti-patterns are most
  frequently triggered and whether the threshold is calibrated correctly.
- Suppression audit: join with `pattern_skip_enriched` events (W11) on
  `(orchestration_id, pattern_name)` to see how often a PM explicitly dismisses an
  advisory via `contextual-mismatch` skip — a high dismiss rate on a specific pattern
  suggests either a too-broad `trigger_actions` list or a threshold that's too low.
- Per-agent breakdown: group by `agent_type` to see which agent roles most often
  receive advisory context.

**Schema stability:** additive only. Consumers that do not recognise this event type
should ignore it. New fields will only be added as optional.


---

## Section 22: Pause/Cancel Sentinel Events (W7 v2.0.18)

Four events emitted by the pause/cancel sentinel protocol. All written via
`appendFileSync` to `.orchestray/audit/events.jsonl`. All use canonical field names
(`timestamp`/`type`, not `ts`/`event`). Grep anchor: `W7-UX4cd-sentinel`.

### `state_pause_set`

Emitted by `bin/state-pause.js` when `.orchestray/state/pause.sentinel` is
successfully created.

```json
{
  "timestamp": "<ISO 8601 UTC>",
  "type": "state_pause_set",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "reason": "<operator-supplied string, or null>",
  "paused_at": "<ISO 8601 UTC — same as timestamp>"
}
```

**Fields:**
- `timestamp`: Canonical ISO 8601 UTC string.
- `type`: Always `"state_pause_set"`.
- `orchestration_id`: Read from `.orchestray/state/orchestration.md`; `"unknown"` when no active orchestration.
- `reason`: Optional operator-supplied message passed via `--reason=<msg>`; null if absent.
- `paused_at`: ISO 8601 timestamp of the pause action (matches `timestamp`).

### `state_pause_resumed`

Emitted by `bin/state-pause.js --resume` when the pause sentinel is successfully removed.

```json
{
  "timestamp": "<ISO 8601 UTC>",
  "type": "state_pause_resumed",
  "orchestration_id": "<orch id from the deleted sentinel, or 'unknown'>",
  "resumed_at": "<ISO 8601 UTC>"
}
```

**Fields:**
- `orchestration_id`: Read from the sentinel file before deletion (not from orchestration.md).
- `resumed_at`: ISO 8601 timestamp of the resume action.

### `state_cancel_requested`

Emitted by `bin/state-cancel.js` when `.orchestray/state/cancel.sentinel` is
successfully created.

```json
{
  "timestamp": "<ISO 8601 UTC>",
  "type": "state_cancel_requested",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "reason": "<operator-supplied string, or null>",
  "requested_at": "<ISO 8601 UTC — same as timestamp>"
}
```

**Fields:**
- `reason`: Optional operator-supplied message; null if absent.
- `requested_at`: ISO 8601 timestamp written into the sentinel file. The sentinel hook
  (`check-pause-sentinel.js`) reads this field to enforce the grace window
  (`cancel_grace_seconds`).

### `state_cancel_aborted`

Emitted by the PM after executing the clean-abort sequence: renaming the state dir to
`.orchestray/history/orch-<id>-cancelled/`. Written to `.orchestray/audit/events.jsonl`
(the audit log, which is NOT inside the renamed state dir).

```json
{
  "timestamp": "<ISO 8601 UTC>",
  "type": "state_cancel_aborted",
  "orchestration_id": "<orch id from cancel sentinel>",
  "archived_to": ".orchestray/history/orch-<id>-cancelled",
  "events_jsonl_preserved": true
}
```

**Fields:**
- `archived_to`: Relative path (from project root) of the renamed state directory.
- `events_jsonl_preserved`: Always `true` — the `events.jsonl` inside the archived
  state dir is never deleted. Future analytics can replay the partial orchestration.

**Consumer guidance:**
- To find all cancelled orchestrations: grep for `state_cancel_aborted` in
  `.orchestray/audit/events.jsonl` or check for `orch-*-cancelled/` dirs in history.
- Pair `state_cancel_requested` and `state_cancel_aborted` on `orchestration_id` to
  measure the cancel-to-abort latency (how many groups ran between request and abort).

**Schema stability:** additive only. New fields will only be added as optional.

---

## Section 23: State GC Events (W5 v2.0.18)

Two events emitted by `bin/state-gc.js` during the `/orchestray:state gc` operation.
Both use canonical `timestamp`/`type` fields. Grep anchor: `W5-UX4b-state-gc`.

### `state_gc_run`

Emitted once per `state-gc.js` invocation (both dry-run and mutating). Summarises what
the run found and acted on.

Cross-ref: emitted by `bin/state-gc.js`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "state_gc_run",
  "mode": "archive | discard",
  "dry_run": true,
  "keep_days": 7,
  "archived": 0,
  "discarded": 0,
  "skipped_active": 1
}
```

**Fields:**
- `mode`: The effective mode (`archive` renames to `-abandoned`; `discard` deletes).
- `dry_run`: `true` for `--dry-run` invocations; `false` for mutating runs.
- `keep_days`: Age threshold in days (dirs older than this are considered leaked).
- `archived`: Number of dirs renamed to `*-abandoned`.
- `discarded`: Number of dirs deleted (only non-zero when `mode: "discard"`).
- `skipped_active`: Number of dirs skipped because they matched an active orchestration.

### `state_gc_discarded`

Emitted once per discarded directory (only when `--mode=discard` is active). Gives
fine-grained audit signal for each deletion.

Cross-ref: emitted by `bin/state-gc.js` immediately after each `fs.rmSync()` call.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "state_gc_discarded",
  "dir": "orch-1234567890"
}
```

**Fields:**
- `dir`: The directory name (relative, not full path) that was deleted.

**Consumer guidance:**
- To audit all gc runs: filter `events.jsonl` for `type: "state_gc_run"`.
- To find what was deleted in a discard run: filter for `type: "state_gc_discarded"` with
  timestamps matching the corresponding `state_gc_run`.
- `state_gc_discarded` events are only emitted when `mode: "discard"`. Archive-mode runs
  do not emit per-dir events (only the summary `state_gc_run` event).

---

## Section 24: Redo Event (W8 v2.0.18)

### `w_item_redo_requested`

Emitted by `bin/redo-wave-item.js` when the user confirms a `/orchestray:redo` invocation
(or triggers it via the skill). Records the W-item targeted and whether cascade was
requested.

Cross-ref: emitted by `bin/redo-wave-item.js`; triggered by `skills/orchestray:redo/SKILL.md`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "w_item_redo_requested",
  "w_id": "W4",
  "prompt_override_file": null,
  "cascade": true,
  "dry_run": false
}
```

**Fields:**
- `w_id`: The W-item identifier being redone (e.g., `"W4"`).
- `prompt_override_file`: Path to a prompt-override file if `--prompt` was passed; `null`
  otherwise.
- `cascade`: `true` if `--cascade` was passed (full dependent closure will be re-run);
  `false` if only the named W-item will be re-run.
- `dry_run`: `true` if `--dry-run` was passed (no `redo.pending` written); `false` for
  actual redo.

**Consumer guidance:**
- Pair `w_item_redo_requested` with subsequent `routing_outcome` / `routing_decision` rows
  on `orchestration_id` to measure redo quality vs. original run.
- A `cascade: true` event followed by multiple `routing_decision` rows is the expected
  pattern for a cascaded redo.

---

## Section 25: Config Key Stripped Event (W3 v2.0.18)

### `config_key_stripped`

Emitted by `bin/post-upgrade-sweep.js` when `runFC3bLegacyKeyStrip` removes deprecated
config keys (`pm_prompt_variant` and/or `pm_prose_strip`) from `.orchestray/config.json`
on first use after upgrading to v2.0.18.

Cross-ref: emitted by `bin/post-upgrade-sweep.js`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "config_key_stripped",
  "keys_stripped": ["pm_prompt_variant"],
  "release": "2.0.18"
}
```

**Fields:**
- `keys_stripped`: Array of top-level config keys that were removed. Typically
  `["pm_prompt_variant"]`, `["pm_prose_strip"]`, or `["pm_prompt_variant", "pm_prose_strip"]`
  depending on what was present. `pm_prose_strip` inside `v2017_experiments` is stripped
  silently (sub-object cleanup is not listed in `keys_stripped`).
- `release`: The Orchestray version that performed the strip. Always `"2.0.18"` for the
  initial FC3b sweep.

**Consumer guidance:**
- This event fires at most once per install (the strip is idempotent). A second post-upgrade
  sweep run after the keys are already gone emits no event.
- Use this event to audit whether a given install has had its legacy keys cleaned. Absence
  of this event in `events.jsonl` means either (a) the install never had those keys, or
  (b) the upgrade sweep has not run yet.

**Schema stability:** additive only. New fields will only be added as optional.

---

### `config_key_seeded`

Emitted by `bin/post-upgrade-sweep.js` when one of the v2.0.18 seed helpers
(`runW9PatternDecaySeed`, `runW12AntiPatternGateSeed`, `runW7StateSentinelSeed`,
`runW8RedoFlowSeed`) backfills a missing config block into `.orchestray/config.json`
on first use after upgrading. Complements `config_key_stripped`.

Cross-ref: emitted by `bin/post-upgrade-sweep.js`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "config_key_seeded",
  "key": "pattern_decay",
  "release": "2.0.18"
}
```

**Fields:**
- `key`: The top-level config block that was seeded. One of `pattern_decay`,
  `anti_pattern_gate`, `state_sentinel`, `redo_flow` for the v2.0.18 batch.
- `release`: The Orchestray version that performed the seeding.

**Consumer guidance:**
- Each helper is idempotent: if the block is already present, the sweep preserves
  operator customisations and emits no event. A single upgrade may emit 0–4 of these
  events depending on which blocks were absent.
- **Write-only by design.** Matches the `config_key_stripped` precedent: this event
  exists for a durable post-hoc audit trail (operators and `/orchestray:analytics`
  can query it), not for any runtime consumer. No reader is expected or required.

---

## Section 40: Orchestration Start Event

Emitted by the PM at the beginning of Section 12 (Orchestration Initialization),
before any agent is spawned. This event is the correlation anchor for all subsequent
events in the orchestration — every event emitted during this orchestration references
the same `orchestration_id`.

Cross-ref: the PM also writes `current-orchestration.json` in this same step, which
is read by hook handlers (`SubagentStart`, `SubagentStop`) to tag events with the
`orchestration_id`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "orchestration_start",
  "orchestration_id": "orch-1712345678",
  "task": "<user task summary — first 100 chars>",
  "complexity_score": 7,
  "complexity_level": "medium"
}
```

Field notes:
- `orchestration_id`: Correlation key for all events in this orchestration. Format:
  `orch-{unix-timestamp}` (e.g., `orch-1712345678`).
- `task`: The user's task description, truncated to 100 characters.
- `complexity_score`: The numeric score (1-10) assigned by the PM complexity scorer.
- `complexity_level`: Human-readable band — `"low"` (1-4), `"medium"` (5-7), or
  `"high"` (8-10).

---

## Section 41: Orchestration Complete Event

Emitted by the PM at the end of Section 14 (after all agents have completed and all
merges are done). This is the closing event for the orchestration and triggers the
archive rotation via `bin/_lib/events-rotate.js`.

Cross-ref: `bin/emit-orchestration-rollup.js` reads `orchestration_complete` events
to generate the rollup summary. `bin/state-gc.js` reads them to know which
orchestrations are eligible for cleanup.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "orchestration_complete",
  "orchestration_id": "orch-1712345678",
  "total_agents": 3,
  "total_tokens": {
    "input": 45000,
    "output": 12000,
    "cache_read": 8000,
    "cache_creation": 2000
  },
  "estimated_total_cost_usd": 0.234567,
  "duration_ms": 45000,
  "status": "success"
}
```

Field notes:
- `total_agents`: Count of distinct agent invocations in this orchestration (not
  counting the PM itself).
- `total_tokens`: Aggregated token counts across all `agent_stop` events for this
  orchestration. `cache_read` and `cache_creation` may be `0` for older event rows
  that did not carry cache fields.
- `estimated_total_cost_usd`: Sum of `estimated_cost_usd` from all `agent_stop`
  events. Does not include PM's own cost.
- `duration_ms`: Wall-clock time from the `orchestration_start` event timestamp to
  this event's timestamp.
- `status`: `"success"` if all agents completed successfully, `"partial"` if some
  failed, `"failure"` if all failed or the orchestration was aborted.

---

## Section 42: Replan Event

Emitted by the PM in Section 16 (Adaptive Re-Planning Protocol) each time the PM
discards the current task graph and generates a new one. The `replan_count` in
`.orchestray/state/orchestration.md` is incremented before this event is written.

Cross-ref: `replan` is in the `history_query_events` `EVENT_TYPES` enum and is
queryable via `mcp__orchestray__history_query_events`. No `bin/` script currently
aggregates replan counts automatically — the PM reads its own audit trail via MCP.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "replan",
  "orchestration_id": "<current orch id>",
  "reason": "<approach_invalidation | scope_expansion | dependency_discovery | completed_work_invalidation | design_rejection>",
  "old_task_count": 4,
  "new_task_count": 6,
  "tasks_invalidated": ["task-02", "task-03"]
}
```

Field notes:
- `reason`: The signal that triggered re-planning. One of:
  - `approach_invalidation` — the chosen approach was discovered to be infeasible.
  - `scope_expansion` — new requirements emerged that expand the task scope.
  - `dependency_discovery` — a dependency was discovered that invalidates the current
    task graph ordering.
  - `completed_work_invalidation` — work already completed must be redone.
  - `design_rejection` — the reviewer rejected the design, triggering a redesign.
- `old_task_count`: Number of tasks in the task graph before re-planning.
- `new_task_count`: Number of tasks in the new task graph.
- `tasks_invalidated`: Array of task IDs whose output is no longer valid. May be
  empty if only the graph topology changed (e.g., new tasks added without invalidating
  existing ones).

---

## Section 43: Dynamic Agent Cleanup Event

Emitted by the PM in Section 17 step 7 (Dynamic Agent Lifecycle) after the dynamic
agent's definition file (`agents/{name}.md`) is deleted. Paired with the
`dynamic_agent_spawn` event that was emitted at the start of the same agent's
invocation.

Cross-ref: `bin/mcp-server/tools/history_query_events.js` `EVENT_TYPES` — add
`"dynamic_agent_cleanup"` to enable MCP filtering for this event type.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "dynamic_agent_cleanup",
  "orchestration_id": "<current orch id>",
  "agent_name": "{name}",
  "task_id": "<task id>",
  "file_deleted": "agents/{name}.md"
}
```

Field notes:
- `agent_name`: The dynamic agent's name, matching the `agent_type` field on the
  corresponding `dynamic_agent_spawn` event.
- `task_id`: The PM's internal subtask identifier for the task this agent executed.
- `file_deleted`: The relative path of the agent definition file that was removed.
  Always `agents/{name}.md` for standard dynamic agents.

Consumer guidance: to query the full lifecycle of a dynamic agent, join
`dynamic_agent_spawn` and `dynamic_agent_cleanup` on `(orchestration_id, agent_name)`.
Note that `dynamic_agent_cleanup` is not yet in the `history_query_events` EVENT_TYPES
enum as of v2.0.22 — filter manually by `type` field until EVENT_TYPES is updated.

**Schema stability:** additive only.

---

## Section 44: Federation Events (v2.1.0+)

These events are emitted by the federation-aware pattern lookup path, the pattern
curator agent (B8), and the `/orchestray:learn share` CLI surface (B2).

### `pattern_deprecated` — `by` field extension

**Existing event** (emitted by `mcp__orchestray__pattern_deprecate`). In v2.1.0 the
`by` field is added to distinguish user-initiated deprecation from curator-initiated
deprecation:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_deprecated",
  "orchestration_id": "<current orch id, or null>",
  "pattern_name": "<kebab-case pattern slug>",
  "reason": "<low-confidence | superseded | user-rejected | other>",
  "note": "<freeform prose, or null>",
  "by": "user | curator"
}
```

**Field notes:**
- `by` (optional, default `"user"`): Who triggered the deprecation. `"user"` when
  called directly via the MCP tool or `/orchestray:learn` CLI. `"curator"` when
  called by the pattern curator agent (B8) as part of an automated curation run.
  Pre-v2.1.0 rows that lack this field are treated as `"user"` by consumers.
- All other fields are unchanged from the pre-v2.1.0 schema. The `by` field extension
  is backward-compatible: consumers that do not read `by` continue to work correctly.

**B8 note:** the curator emits `by: "curator"` on every deprecation it performs.
The `pattern_deprecate` MCP tool must accept the `by` field in its input and pass it
through to the audit event. If the tool rejects unknown input fields, curator must
piggyback via a note prefix `"[curator]"` in the `note` field instead — see W2 F11
resolution in the curator design.

---

### `pattern_collision_resolved`

Emitted by `pattern_find` (B5 / `bin/mcp-server/tools/pattern_find.js`) when a slug
collision between tiers is resolved during a multi-tier lookup. This event is
informational — it never blocks the lookup.

Emission condition: `federation.shared_dir_enabled: true` AND a slug appears in more
than one tier.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_collision_resolved",
  "orchestration_id": "<current orch id, or null>",
  "slug": "<kebab-case pattern slug>",
  "winning_tier": "local | team | shared",
  "losing_tier": "local | team | shared",
  "context": "pattern_find"
}
```

**Field notes:**
- `slug`: The pattern slug that appeared in multiple tiers.
- `winning_tier`: The tier whose copy of the pattern was returned to the caller.
  Precedence: `"local"` > `"team"` > `"shared"`. In v2.1.0, `pattern_find` only loads
  Tier 1 (`"local"`) and Tier 3 (`"shared"`); `"team"` is reserved for the v2.2+ 3-tier
  wire-in and will not appear in emitted events.
- `losing_tier`: The tier whose copy was discarded. Same `"team"` reservation as above.
- `context`: Always `"pattern_find"` in v2.1.0. Reserved for future contexts (e.g.,
  a bulk collision scan command).
- `orchestration_id`: The active orchestration at lookup time, or `null` when called
  outside an orchestration (e.g., debug lookups).

**Consumer guidance:** aggregate `pattern_collision_resolved` events by `slug` to find
patterns that exist in multiple tiers and may benefit from a curator merge or manual
cleanup.

**Schema stability:** additive only.

---

### `mcp_tool_call.result_preview` — `source` field for `pattern_find` and `kb_search`

Not a new event type — an extension to the `result_preview` sub-object on existing
`mcp_tool_call` events when the tool is `pattern_find` or `kb_search`. In v2.1.0,
each item in the returned pattern or artifact list carries a `source` field:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "mcp_tool_call",
  "tool": "pattern_find",
  "result_preview": {
    "matches": [
      {
        "slug": "audit-fix-verify-triad",
        "confidence": 0.85,
        "source": "local"
      },
      {
        "slug": "decomposition-parallel-groups",
        "confidence": 0.72,
        "source": "local"
      },
      {
        "slug": "security-review-pre-merge",
        "confidence": 0.61,
        "source": "shared"
      }
    ]
  }
}
```

**`source` enum values:**
- `"local"` — pattern is from `.orchestray/patterns/` (Tier 1, project-local).
- `"team"` — **reserved for v2.2+ 3-tier wire-in; not emitted by v2.1.0 `pattern_find`.**
  The `team-patterns/` directory is preserved but not loaded by the MCP tool in v2.1.0.
- `"shared"` — pattern is from `~/.orchestray/shared/patterns/` (Tier 3, user-global advisory).

**Consumer guidance:** the PM MUST propagate the `source` field when citing a pattern
in a decomposition plan or orchestration summary (see §22b-federation source transparency
rule). Analytics consumers can group by `source` to measure shared-tier adoption.

When `federation.shared_dir_enabled: false`, all returned patterns have `source: "local"`.
In v2.1.0, `pattern_find` populates only `"local"` and `"shared"`; `source: "team"` is
reserved for v2.2+ per the note above. The `source` field is always present in v2.1.0+
`pattern_find` results, even when federation is disabled.

**Schema stability:** additive only.

---

### `curator_run_complete`

Emitted by the pattern curator agent (B8) at the end of each curation run, after all
promote / merge / deprecate actions have been attempted. B8 wires the emitter; this
section documents the schema only.

**Emission:** B8 writes this event to `.orchestray/audit/events.jsonl` as its final
action before returning its structured result. The event is skipped if the curator
exits early due to a federation-absent gate (graceful degradation — see W2 F03
resolution in curator design `2100c-curator-design-v2.md`).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "curator_run_complete",
  "orchestration_id": null,
  "run_id": "<curator-run-{ISO8601}>",
  "actions_applied": {
    "promote_n": 2,
    "merge_n": 1,
    "deprecate_n": 3
  },
  "actions_skipped": {
    "promote_n": 0,
    "merge_n": 1,
    "deprecate_n": 0
  },
  "tombstones_written_count": 3
}
```

**Field notes:**
- `orchestration_id`: Always `null` — the curator runs as a standalone agent outside
  an orchestration context. `null` distinguishes curator events from PM-orchestration
  events in analytics queries.
- `run_id`: Stable identifier for this curator invocation. Format:
  `curator-run-{ISO8601}` (e.g., `curator-run-2026-04-17T15:36:19Z`). Used by
  `undo-last` to target the most recent run's tombstone batch.
- `actions_applied.promote_n`: Count of patterns successfully promoted to the shared
  tier during this run.
- `actions_applied.merge_n`: Count of merge operations that completed and were
  committed.
- `actions_applied.deprecate_n`: Count of deprecations applied (pattern frontmatter
  marked `deprecated: true`). Each deprecation also produces a `pattern_deprecated`
  event with `by: "curator"`.
- `actions_skipped.promote_n`: Count of promote candidates that were evaluated but
  not promoted (e.g., below `times_applied` threshold, sensitivity gate blocked,
  federation absent).
- `actions_skipped.merge_n`: Count of merge candidates that failed the adversarial
  re-read step (`passed: false`), were blocked by the `merged_from` guard, or were
  otherwise skipped.
- `actions_skipped.deprecate_n`: Count of deprecation candidates that were evaluated
  but kept (e.g., score above absolute floor, `corpus_size < 0.8 * cap` guard).
- `tombstones_written_count`: Total tombstone rows written to
  `.orchestray/curator/tombstones.jsonl` across ALL action types during this run
  (promote + merge + deprecate). For a deprecate action, each deprecated pattern
  produces one row. For merge actions, each input pattern produces one row. For
  promote actions, each promoted pattern produces one row.

**Consumer guidance:**
- Use `run_id` to correlate `curator_run_complete` with its associated
  `pattern_deprecated` (by: "curator") events — filter on timestamps between the
  curator run start and this event.
- To find the most recent curator run: filter `events.jsonl` for
  `type: "curator_run_complete"` and take the latest by `timestamp`.
- Tombstones are project-local at `.orchestray/curator/tombstones.jsonl` and power
  the `undo-last` / `undo <action-id>` rollback commands.

**Schema stability:** additive only. Consumers that do not recognise this event type
should ignore it. New fields will only be added as optional.

---

### `curator_run_start`

Emitted by `mcp__orchestray__curator_tombstone` (action: `"start_run"`) at the very
beginning of a curator run, before any promote/merge/deprecate actions. Corresponds to
the `run_id` returned to the curator agent.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "curator_run_start",
  "orchestration_id": null,
  "orch_id": "<curator-run-{ISO8601}>",
  "trigger": "user"
}
```

**Field notes:**
- `orchestration_id`: Always `null` — curator runs outside an orchestration context.
- `orch_id`: The curator run ID. Matches the `run_id` in subsequent tombstone write events
  and the final `curator_run_complete` event.
- `trigger`: Always `"user"` in v2.1.0. Reserved for future auto-trigger paths.

**Consumer guidance:** pair with `curator_run_complete` using `orch_id` to compute run
duration and identify runs without a completion event (crash/abort).

---

### `curator_action_promoted`

Emitted by `mcp__orchestray__curator_tombstone` (action: `"write"`) each time a pattern
is successfully promoted to the shared tier. Emitted BEFORE the promote write to serve
as a tombstone record.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "curator_action_promoted",
  "orchestration_id": null,
  "run_id": "<curator-run-{ISO8601}>",
  "action_id": "<curator-{ISO8601}-a{NNN}>",
  "action": "promote",
  "slug": "<kebab-case pattern slug>"
}
```

**Field notes:**
- `run_id`: Matches the `orch_id` in the `curator_run_start` event for this run.
- `action_id`: Unique per-action identifier. Format: `curator-{ISO8601}-a{NNN}` where
  `NNN` is a zero-padded sequence number within the run (e.g., `a001`, `a002`). Used
  by `/orchestray:learn undo <action-id>` for selective rollback.
- `slug`: The pattern slug that was promoted.

---

### `curator_action_merged`

Emitted by `mcp__orchestray__curator_tombstone` (action: `"write"`) each time a merge
operation is committed. N input patterns are consolidated into 1 merged output.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "curator_action_merged",
  "orchestration_id": null,
  "run_id": "<curator-run-{ISO8601}>",
  "action_id": "<curator-{ISO8601}-a{NNN}>",
  "action": "merge",
  "slug": "<lead-slug (first input pattern)>"
}
```

**Field notes:**
- `slug`: The lead (first) input pattern slug. The full list of merged patterns is in
  the tombstone payload at `.orchestray/curator/tombstones.jsonl`.

---

### `curator_action_deprecated`

Emitted by `mcp__orchestray__curator_tombstone` (action: `"write"`) each time a
pattern is marked for deprecation by the curator. Always followed by a `pattern_deprecated`
event with `by: "curator"` from `mcp__orchestray__pattern_deprecate`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "curator_action_deprecated",
  "orchestration_id": null,
  "run_id": "<curator-run-{ISO8601}>",
  "action_id": "<curator-{ISO8601}-a{NNN}>",
  "action": "deprecate",
  "slug": "<kebab-case pattern slug>"
}
```

**Field notes:**
- `action_id`: Same format as `curator_action_promoted`. Use this ID with
  `/orchestray:learn undo <action-id>` to reverse the deprecation.
- This event precedes the `pattern_deprecated` event for the same slug. Both are
  needed for full audit coverage: `curator_action_deprecated` records the tombstone
  write; `pattern_deprecated` records the actual deprecation tool call.

**Schema stability:** all four curator action events follow the same additive-only
stability contract as `curator_run_complete`.

---

## v2.1.2 additions

### Degraded-mode journal (`.orchestray/state/degraded.jsonl`)

Written by `bin/_lib/degraded-journal.js`. One JSON object per line; file rotated at
1 MB with 3-generation retention. Never throws — write failures return
`{ appended: false }` silently.

```json
{
  "schema": 1,
  "timestamp": "<ISO 8601>",
  "kind": "<kind>",
  "severity": "info | warn | error",
  "detail": {}
}
```

**`kind` enum** (all introduced in v2.1.2):

| kind | severity | When written |
|---|---|---|
| `fts5_fallback` | info | FTS5 query fell back to keyword scan |
| `fts5_backend_unavailable` | warn | better-sqlite3 failed to load at MCP boot |
| `flat_federation_keys_accepted` | info | Flat `federation.*` config keys detected on disk |
| `flat_curator_keys_accepted` | info | Flat `curator.*` config keys detected on disk |
| `shared_dir_create_failed` | warn | Could not create `~/.orchestray/shared/` at install |
| `curator_reconcile_flagged` | warn | Post-curate reconcile found an action requiring user review |
| `config_load_failed` | error | Config file parse or read failed |
| `hook_merge_noop` | info | A hook event already fully installed; no new entries merged |

**`detail` fields vary by kind.** All include at least `dedup_key` (string) for
deduplication by consumers.

---

### `doctor-result-code` sentinel (stdout)

`/orchestray:doctor` always emits a bare sentinel as its final stdout line:

```
doctor-result-code: <code>
```

Where `<code>` is:
- `0` — all 8 probes healthy
- `1` — one or more probes returned warnings, none returned errors
- `2` — one or more probes returned errors

Consumers (scripts, CI integrations) may parse this line to gate on doctor exit status.

---

### `pattern://` resource tier banner (v2.1.2)

The `pattern://` MCP resource body now opens with a tier banner line:

```
[Tier: local | shared | shared (this project)]
```

followed by the pattern body as before. The banner is present only when the pattern
originates from Tier 2 (federation-shared). Tier 1 (local-only) patterns omit the
banner for backward compatibility.

---

### Tombstone `rationale` field (v2.1.2, curator actions)

Each tombstone written by the curator agent may now include a `rationale` object.
The field is optional — old tombstones without it continue to work.

```json
{
  "action_id": "curator-2026-04-19T...-a001",
  "action": "promote | merge | deprecate | unshare",
  "slug": "<pattern-slug>",
  "action_summary": "<one-line summary>",
  "rationale": {
    "schema_version": 1,
    "text": "<curator's full reasoning>",
    "confidence": 0.0
  }
}
```

`rationale.confidence` is the curator's self-assessed confidence (0.0–1.0).
`rationale.text` is the full reasoning used by `/orchestray:learn explain <action-id>`.

---

## v2.1.3 additions

### Shadow scorer JSONL (`.orchestray/state/scorer-shadow.jsonl`)

Written by `bin/_lib/scorer-shadow.js` via `setImmediate` after each `pattern_find`
call when at least one shadow scorer is active. One JSON object per line; 1 MB ×
3-generation rotation. Writes are fire-and-forget — a write failure is swallowed
silently and a `shadow_scorer_failed` degraded-journal entry is appended instead.

```json
{
  "schema": 1,
  "timestamp": "<ISO 8601>",
  "scorer": "<scorer-name, e.g. 'skip-down' | 'local-success'>",
  "query": "<query string, truncated to 120 chars>",
  "baseline_top_k": ["<slug1>", "<slug2>", "..."],
  "shadow_top_k": ["<slug1>", "<slug2>", "..."],
  "kendall_tau_b": 0.85,
  "top_k_overlap": 0.9,
  "displacement": [0, 1, 0, -1, 0]
}
```

**Field notes:**
- `scorer`: Short name of the shadow scorer that produced this row (value from `retrieval.shadow_scorers`).
- `baseline_top_k` / `shadow_top_k`: Slugs of the top-K results in baseline and shadow rank order respectively. K matches the `pattern_find` call's `limit` parameter.
- `kendall_tau_b`: Kendall tau-b rank correlation between baseline and shadow. Range: −1.0 to 1.0. `null` when the intersection is fewer than 2 slugs or all pairs are tied.
- `top_k_overlap`: Proportion of slugs appearing in both top-K lists. Range: 0.0 to 1.0.
- `displacement`: Per-item rank delta `(shadow_rank − baseline_rank)` for slugs that appear in both lists, in baseline rank order. Absent items produce no entry.

**Schema stability:** schema version 1. Additive-only for v2.1.x.

---

### Install manifest v2 (`manifest.json`)

`bin/_lib/install-manifest.js` writes a `manifest.json` alongside the installed files.
v2 extends v1 with per-file SHA-256 hashes.

```json
{
  "manifest_schema": 2,
  "version": "2.1.3",
  "timestamp": "<ISO 8601>",
  "install_type": "global | local",
  "files": ["<rel/path1>", "<rel/path2>"],
  "files_hashes": {
    "<rel/path1>": "<sha256-hex>",
    "<rel/path2>": "<sha256-hex>"
  }
}
```

**Field notes:**
- `manifest_schema`: `2` for v2 manifests; `1` (or absent) for v1 manifests written by v2.1.2 and earlier.
- `files_hashes`: Map from relative file path (relative to plugin root) to lowercase SHA-256 hex digest. Computed at install time. Used by `/orchestray:doctor --deep` and `verifyManifestOnBoot` for drift detection.
- v1 consumers that only read `files` and `version` continue to work — `files_hashes` is additive.

**Boot-time verification:** `verifyManifestOnBoot` in `install-manifest.js` runs on MCP server startup. On hash mismatch it appends one `install_integrity_drift` degraded-journal entry per drifted file and continues boot. Never throws. Without `--deep`, `/orchestray:doctor` does not re-run verification; use `--deep` for an on-demand full check.

---

### `recently_curated_*` frontmatter stamp (pattern files, v2.1.3)

After each curator run, `bin/curator-apply-stamps.js <runId>` writes 5 flat dotted-prefix
keys into each pattern file touched by that run. Written to the frontmatter block
(between `---` delimiters). Uses REPLACE semantics: a re-stamp of the same pattern
overwrites all 5 keys.

```yaml
recently_curated_at: "2026-04-19T15:36:19Z"
recently_curated_action: "promote | merge | deprecate | unshare"
recently_curated_action_id: "curator-2026-04-19T15:36:19Z-a001"
recently_curated_run_id: "curator-run-2026-04-19T15:36:19Z"
recently_curated_why: "<truncated curator rationale, max 120 chars>"
```

**Strip semantics:**
- `curator undo` (via `applyRollback` in `curator-tombstone.js`) strips all 5 keys on rollback, restoring the pattern to its pre-stamp state.
- `/orchestray:learn share` (via `shared-promote.js`) strips all 5 keys before writing to the shared tier. Stamps are project-local metadata and must never appear in federation peers.

**Consumer guidance:** treat `recently_curated_*` as advisory display metadata. Do not use `recently_curated_action_id` as a primary key — use the tombstones file for authoritative rollback state.

---

### Tombstone `rationale.similarity_score` field (v2.1.3)

Merge tombstones may now carry a `similarity_score` field inside `rationale` to record
the MinHash+Jaccard similarity between the merged patterns. This is the only `similarity_*`
field populated by the curator agent in v2.1.3. The fields `similarity_method`,
`similarity_threshold`, `similarity_k`, and `similarity_m` are reserved in the schema
comment (`curator-tombstone.js`) for a v2.1.4 wire-in when the duplicate pre-filter
is promoted to the main curator flow.

```json
{
  "rationale": {
    "schema_version": 1,
    "text": "<curator's full reasoning>",
    "confidence": 0.85,
    "similarity_score": 0.72
  }
}
```

**Field notes:**
- `similarity_score`: Jaccard similarity between the two merged patterns as computed by `curator-duplicate-detect.js`. Range: 0.0–1.0. Present only on merge tombstones where the duplicate pre-filter flagged the pair; `null` or absent otherwise.
- `similarity_method`, `similarity_threshold`, `similarity_k`, `similarity_m`: Reserved; not populated in v2.1.3.

---

### Degraded-journal `kind` additions (v2.1.3)

Six new `kind` values added to the degraded-journal enum (see v2.1.2 section above for
the full schema). All follow the same `{ schema, timestamp, kind, severity, detail }` shape.

| kind | severity | When written |
|---|---|---|
| `install_integrity_drift` | warn | `verifyManifestOnBoot` detected a file hash mismatch at MCP boot |
| `manifest_v1_legacy` | info | Boot-time verify skipped because manifest on disk is v1 (no `files_hashes`) |
| `install_integrity_verify_slow` | info | Manifest verification took longer than 500 ms |
| `shadow_scorer_failed` | warn | A shadow scorer threw an exception; baseline scoring was unaffected |
| `curator_duplicate_detect_failed` | warn | MinHash pre-filter threw; curator fell back to all-pairs |
| `curator_stamp_apply_failed` | warn | `curator-apply-stamps.js` failed to write stamps for one or more patterns |
| `curator_diff_cursor_corrupt` | warn | `curate --diff`: stamp present but `body_sha256` missing/malformed; pattern treated as stamp-absent |
| `curator_diff_hash_compute_failed` | warn | `curate --diff`: could not read/hash pattern body; pattern treated as dirty |
| `curator_diff_forced_full_triggered` | info | `curate --diff`: self-healing forced a full sweep (run counter % N === 0 where N = `curator.diff_forced_full_every`, default 10) |
| `curator_diff_dirty_set_empty` | info | `curate --diff`: entire corpus is clean; no patterns dirty, no curator spawn |

**`detail` fields for `install_integrity_drift`:**
```json
{
  "dedup_key": "install_integrity_drift:<rel/path>",
  "path": "<rel/path>",
  "expected_hash": "<sha256-hex from manifest>",
  "actual_hash": "<sha256-hex of current file>"
}
```

---

### `curator_diff_rollup` event (v2.1.4)

Emitted to `.orchestray/audit/events.jsonl` at the end of each `curate --diff` run
(after the `curator_run_complete` event). Absent on full-sweep `curate` runs.

The `dirty_size / corpus_size` ratio is the incremental efficiency proxy — if it
trends below 0.3 over several runs, `--diff` is meaningfully cheaper than full sweep.

```json
{
  "timestamp":     "<ISO-8601-Z>",
  "type":          "curator_diff_rollup",
  "run_id":        "<curator-<ISO-8601-with-seconds-Z>>",
  "mode":          "diff",
  "corpus_size":   42,
  "dirty_size":    7,
  "dirty_breakdown": {
    "stamp_absent":     3,
    "body_hash_drift":  2,
    "stale_stamp":      1,
    "rollback_touched": 1,
    "merge_lineage":    0
  },
  "actions_applied": {
    "promote_n":    1,
    "merge_n":      0,
    "deprecate_n":  1
  },
  "skipped_clean":    35,
  "forced_full_sweep": false
}
```

**Field semantics:**
- `run_id`: matches `curator_run_complete.run_id` for cross-event joins.
- `corpus_size`: total `.orchestray/patterns/*.md` count at time of dirty-set computation.
- `dirty_size`: number of patterns in the dirty set (equal to corpus_size on first run or forced-full).
- `dirty_breakdown`: per-signal dirty counts; sum equals `dirty_size` (or approximately, if a pattern
  matched multiple signals — only the first-matching signal is counted).
- `actions_applied`: counts from the curator agent's structured result (promote/merge/deprecate taken).
- `skipped_clean`: `corpus_size - dirty_size` — patterns the curator never saw because their stamp was fresh.
- `forced_full_sweep`: true when the self-healing full-sweep cadence triggered (every 10th `--diff` run).

---

## v2.1.6 additions — Self-learning foundations

All events in this section are written via `atomicAppendJsonl` to
`.orchestray/audit/events.jsonl`. All use `schema_version: 1` unless noted. Fail-open:
write failures are swallowed silently. Schema stability: additive only.

---

### `auto_extract_skipped`

Emitted by `bin/post-orchestration-extract.js` (PreCompact hook) whenever the
auto-extraction pipeline exits before attempting any extraction. One event per run.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "auto_extract_skipped",
  "schema_version": 1,
  "reason": "<reason enum — see below>",
  "orchestration_id": "<current orch id, or absent>",
  "size_bytes": 10485761,
  "max_bytes": 10485760,
  "kept_count": 501
}
```

**`reason` enum values:**

| reason | When emitted |
|---|---|
| `kill_switch_env` | `ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1` is set |
| `kill_switch_config` | `auto_learning.global_kill_switch: true` in config |
| `feature_disabled` | `auto_learning.extract_on_complete.enabled` is not `true` |
| `circuit_breaker_tripped` | Rolling 24h extraction cap exceeded |
| `input_too_large` | Scoped event list exceeds 500 events after quarantine |
| `events_file_too_large` | `events.jsonl` exceeds the size cap before parsing (10 MiB default) |
| `backend_not_configured` | No extraction backend wired (stub returns this in v2.1.6) |

**Optional fields:** `size_bytes` and `max_bytes` appear only with `events_file_too_large`.
`kept_count` appears only with `input_too_large`. `orchestration_id` is absent for runs
that exit before the orchestration ID is read.

---

### `auto_extract_quarantine_skipped`

Emitted by `bin/post-orchestration-extract.js` once per distinct quarantine drop reason
after the Layer A pre-processor processes the scoped event stream.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "auto_extract_quarantine_skipped",
  "schema_version": 1,
  "orchestration_id": "<current orch id>",
  "reason": "<drop reason, e.g. 'unknown_type' or 'secret_pattern_match'>",
  "count": 3
}
```

**Field notes:**
- `reason`: One of the quarantine drop reasons from `event-quarantine.js` — `unknown_type`
  (event type not in the §6.1 allowlist), `secret_pattern_match` (retained fields matched
  a secret-pattern regex), or other values added by future quarantine rules. The value is
  truncated to 64 characters and non-printable characters are replaced with `?`.
- `count`: Total events dropped for this reason across the scoped event stream.

---

### `auto_extract_staged`

Emitted by `bin/post-orchestration-extract.js` once per run, after all proposals are
processed. This is the UX signal consumed by PM Tier-1 §22f to notify the user that
proposals are waiting.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "auto_extract_staged",
  "schema_version": 1,
  "orchestration_id": "<current orch id>",
  "proposal_count": 2,
  "shadow": false
}
```

**Field notes:**
- `proposal_count`: Number of proposals written to `.orchestray/proposed-patterns/`
  (or, in shadow mode, the number that would have been written).
- `shadow`: `true` when `auto_learning.extract_on_complete.shadow_mode` is enabled — no
  files were written, only the event trail.

**PM §22f behaviour:** when `proposal_count > 0` and `shadow` is `false`, PM emits a
one-line user-facing notice at next session start (once per session, suppressed for
subsequent `auto_extract_staged` events in the same session). Shadow-mode events produce
no user-visible notice.

---

### `pattern_proposed`

Emitted by `bin/post-orchestration-extract.js` once per proposal that passes validation
and the per-orchestration cap.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_proposed",
  "schema_version": 1,
  "orchestration_id": "<current orch id>",
  "slug": "<kebab-case proposal slug>",
  "shadow": false
}
```

**Field notes:**
- `slug`: The proposal's `name` field — the file stem under `.orchestray/proposed-patterns/`.
- `shadow`: Mirrors `auto_extract_staged.shadow`. When `true`, no file was written.

---

### `pattern_extraction_skipped`

Emitted by `bin/post-orchestration-extract.js` once per proposal that was processed but
not staged. Multiple per run are normal.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_extraction_skipped",
  "schema_version": 1,
  "orchestration_id": "<current orch id>",
  "reason": "<reason enum — see below>",
  "detail": "<field names involved, or absent>",
  "slug": "<slug, or absent>"
}
```

**`reason` enum values:**

| reason | When emitted |
|---|---|
| `malformed_jsonl_line` | A line in `events.jsonl` could not be parsed as JSON |
| `validator_rejected` | Layer B schema or injection-marker validation failed |
| `category_restricted_to_auto` | Proposal category (`anti-pattern`, `user-correction`) not permitted for auto-extraction |
| `slug_collision` | A file with the same slug already exists in `proposed-patterns/` or `patterns/` |
| `per_orchestration_cap` | Per-run proposal cap (`proposals_per_orchestration`, default 3) reached |

**Optional fields:** `detail` is present only for `validator_rejected` and contains the
comma-separated field names that failed (never the rejected values, per F-07). `slug` is
present only for `slug_collision`.

---

### `pattern_proposal_accepted`

Emitted by `bin/_lib/proposed-patterns.js` when `/orchestray:learn accept <slug>` moves
a proposal to the active pattern set.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_proposal_accepted",
  "slug": "<kebab-case slug>",
  "orchestration_id": "<proposed_from value, or 'unknown'>",
  "layer_b_marker_count": 0
}
```

**Field notes:**
- `orchestration_id`: Set from the proposal's `proposed_from` frontmatter field — the
  orchestration that generated the proposal. `"unknown"` if absent.
- `layer_b_marker_count`: Number of Layer B injection-marker patterns that matched the
  proposal body during Layer C re-validation. A non-zero value means the accept step
  showed the user a warning banner; the accept succeeded despite the markers (user chose
  to proceed).

---

### `pattern_proposal_rejected`

Emitted by `bin/_lib/proposed-patterns.js` when `/orchestray:learn reject <slug>` soft-deletes
a proposal to `.orchestray/proposed-patterns/rejected/`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_proposal_rejected",
  "slug": "<kebab-case slug>",
  "reason": "<operator-supplied reason, or 'no_reason_given'>"
}
```

**Field notes:**
- `reason`: Operator-supplied string from the reject subcommand, truncated to 80 characters.
  Defaults to `"no_reason_given"` when no reason was provided.

---

### `pattern_proposal_metr_strip`

Emitted by `bin/_lib/proposed-patterns.js` during `acceptProposed` when the Layer C
validator finds protected fields (METR-invariant fields such as `times_applied`,
`trigger_actions`, `deprecated`, `confidence`, `merged_from`) in the proposal's
frontmatter. The accept operation continues after stripping.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_proposal_metr_strip",
  "slug": "<kebab-case slug>",
  "stripped_fields": ["times_applied", "trigger_actions"]
}
```

**Field notes:**
- `stripped_fields`: Array of protected field names that were removed before the proposal
  was written to the active patterns directory.
- The presence of this event indicates a proposal file was crafted to include protected
  fields — either by a bug in the extractor or as a reward-hacking attempt.

---

### `breaker_lock_contended`

Emitted by `bin/_lib/learning-circuit-breaker.js` when the lock probe detects that the
circuit-breaker lock file is unavailable before the read-modify-write attempt. The
circuit breaker returns `{ allowed: false }` (fail-closed) when this fires.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "breaker_lock_contended",
  "schema_version": 1,
  "scope": "auto_extract",
  "mechanism": "lock_probe_failed",
  "wait_ms": 500
}
```

**Field notes:**
- `scope`: The circuit-breaker scope string — always `"auto_extract"` for the
  auto-extraction path.
- `mechanism`: Always `"lock_probe_failed"` in v2.1.6. The W1c patch replaced an earlier
  stderr-interception approach; this field records which detection mechanism fired.
- `wait_ms`: The `maxWaitMs` value passed to the lock probe (default 500 ms).

---

### `curator_reconcile_promote_flagged`

Emitted by `bin/_lib/curator-reconcile.js` when the post-curate reconcile step finds a
`promote` tombstone whose corresponding shared-tier file is absent, but cannot auto-repair
it (either because auto-repair is disabled for the promote path in v2.1.6, or because the
tombstone's `schema_version` is less than 2).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "curator_reconcile_promote_flagged",
  "schema_version": 1,
  "tombstone_id": "<curator-{ISO8601}-a{NNN}>",
  "reason": "auto_repair_disabled | schema_version_pre_v216",
  "recovery_command": "/orchestray:learn share <slug>"
}
```

**Field notes:**
- `tombstone_id`: The `action_id` from the tombstone record.
- `reason`: `auto_repair_disabled` — promote auto-repair is flag-only in v2.1.6;
  `schema_version_pre_v216` — tombstone was written before v2.1.6 and lacks the
  required `schema_version: 2` field.
- `recovery_command`: Suggested command to manually complete the promote. Operators
  should run this to repair the drift.

---

### `curator_reconcile_unshare_flagged`

Emitted by `bin/_lib/curator-reconcile.js` (W2-04 fix) when the post-curate reconcile
step finds an `unshare` tombstone whose shared-tier file still exists, but the tombstone
lacks `schema_version: 2` and auto-deletion is blocked.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "curator_reconcile_unshare_flagged",
  "schema_version": 1,
  "tombstone_id": "<curator-{ISO8601}-a{NNN}>",
  "reason": "schema_version_pre_v216",
  "recovery_command": "/orchestray:learn unshare <slug>"
}
```

**Field notes:** Identical shape to `curator_reconcile_promote_flagged`. The
`reason` for unshare is always `schema_version_pre_v216` in v2.1.6 — the unshare
path was gated in the W2-04 security fix.

---

### `pattern_roi_snapshot`

Emitted by `bin/pattern-roi-aggregate.js` once per successful run, after computing ROI
scores for all active patterns.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_roi_snapshot",
  "schema_version": 1,
  "window_days": 30,
  "patterns_scanned": 12,
  "artefact_path": ".orchestray/patterns/roi-snapshot.json",
  "top_roi": ["pattern-a", "pattern-b"],
  "bottom_roi": ["pattern-c", "pattern-d"]
}
```

**Field notes:**
- `window_days`: The lookback window used for cost and application event aggregation.
  Configurable via `auto_learning.roi_aggregator.lookback_days` (default 30).
- `patterns_scanned`: Number of active (non-deprecated, non-proposed) patterns included
  in the ROI computation.
- `artefact_path`: Relative path to the machine-readable ROI snapshot. `null` when
  `--dry-run` was passed.
- `top_roi` / `bottom_roi`: Slugs of the top-5 and bottom-5 patterns by ROI score.

---

### `pattern_roi_skipped`

Emitted by `bin/pattern-roi-aggregate.js` when the aggregator exits before computing
any ROI scores.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_roi_skipped",
  "schema_version": 1,
  "reason": "<reason enum — see below>",
  "orchestration_id": "unknown"
}
```

**`reason` enum values:**

| reason | When emitted |
|---|---|
| `kill_switch` | `auto_learning.global_kill_switch: true` or env var set |
| `feature_disabled` | `auto_learning.roi_aggregator.enabled` is not `true` |
| `throttled` | Last run was fewer than `min_days_between_runs` ago |
| `no_patterns` | `.orchestray/patterns/` is absent or empty |
| `no_events` | No relevant events found within the lookback window |
| `error` | Uncaught exception; detail in degraded journal |

---

### `calibration_suggestion_emitted`

Emitted by `bin/pattern-roi-aggregate.js` when at least one calibration suggestion is
written to `.orchestray/kb/artifacts/`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "calibration_suggestion_emitted",
  "schema_version": 1,
  "artefact_path": "kb/artifacts/calibration-suggestion-20260419-1530.md",
  "window_days": 30,
  "suggestion_count": 2
}
```

**Field notes:**
- `artefact_path`: Relative path to the suggestion file. The file carries
  `status: suggestion` and `enforced: false` in its frontmatter — never acted on
  automatically.
- `suggestion_count`: Number of individual suggestions written to the file.
- Not emitted when the aggregator runs but finds no anomalies (the suggestion file is
  only written when there is something to suggest).

---

### `kb_refs_sweep_complete`

Emitted by `bin/kb-refs-sweep.js` once per successful sweep, after the report is written.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "kb_refs_sweep_complete",
  "schema_version": 1,
  "files_scanned": 34,
  "broken_kb_refs": 0,
  "broken_pattern_refs": 1,
  "broken_bare_refs": 2,
  "artefact_path": ".orchestray/kb/artifacts/kb-sweep-20260419-1530.md"
}
```

**Field notes:**
- `files_scanned`: Total `.md` files scanned across KB and patterns directories.
- `broken_kb_refs`: Count of broken `@orchestray:kb://` references.
- `broken_pattern_refs`: Count of broken `@orchestray:pattern://` references.
- `broken_bare_refs`: Count of broken bare-slug references (conservative strategy —
  higher false-positive risk; inspect the report before acting).
- `artefact_path`: Relative path to the human-readable sweep report.

---

### `kb_refs_sweep_skipped`

Emitted by `bin/kb-refs-sweep.js` when the sweep exits before scanning any files.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "kb_refs_sweep_skipped",
  "schema_version": 1,
  "reason": "<reason enum — see below>"
}
```

**`reason` enum values:**

| reason | When emitted |
|---|---|
| `kill_switch` | `auto_learning.global_kill_switch: true` or env var set |
| `feature_disabled` | `auto_learning.kb_refs_sweep.enabled` is not `true` |
| `no_kb` | `.orchestray/kb/` directory not found |
| `no_index` | `.orchestray/kb/index.json` not found (needed for slug verification) |
| `throttled` | Last sweep was fewer than `min_days_between_runs` ago (default 7 days) |
| `error` | Uncaught exception; detail in degraded journal |

---

### `pattern_collision_local_warn`

Emitted by `bin/_lib/shared-promote.js` when a pattern being promoted to the shared
tier has the same slug as an existing shared-tier file with different content. The
promote operation continues — this is a warning, not a block.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pattern_collision_local_warn",
  "schema_version": 1,
  "slug": "<kebab-case pattern slug>",
  "local_hash": "<first 8 chars of SHA-256 of existing shared file>",
  "promoted_hash": "<first 8 chars of SHA-256 of the new content>"
}
```

**Field notes:**
- `local_hash` / `promoted_hash`: 8-character opaque hash prefixes for identifying which
  version is which. Not full hashes — intended for visual comparison only.
- This event fires during `/orchestray:learn share` when the slug already exists in
  `~/.orchestray/shared/patterns/` with different body content.

---

### `config_repair_applied`

Emitted by `bin/_lib/config-repair.js` when `/orchestray:config repair` reinitialises
a missing or malformed `auto_learning` block.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "config_repair_applied",
  "detail": {
    "path": ".orchestray/config.json",
    "backup": ".orchestray/config.json.bak-1713532800000",
    "reason": "missing | malformed"
  }
}
```

**Field notes:**
- `detail.path`: Absolute path to the config file that was repaired.
- `detail.backup`: Absolute path to the backup file created before overwriting. The
  backup uses a millisecond timestamp to avoid collisions.
- `detail.reason`: `"missing"` when the `auto_learning` key was absent from config;
  `"malformed"` when the key was present but failed type validation.

---

### `config_repair_noop`

Emitted by `bin/_lib/config-repair.js` when `/orchestray:config repair` determines
the `auto_learning` block is already valid and no repair is needed.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "config_repair_noop",
  "detail": {
    "path": ".orchestray/config.json",
    "reason": "valid"
  }
}
```

**Field notes:**
- `detail.reason`: Always `"valid"` for a no-op — the block was present and well-formed.
- No backup is created and no config file is written for a no-op.

---

### `learning_circuit_tripped`

Emitted by `bin/_lib/learning-circuit-breaker.js` (`checkAndIncrement`) when the rolling
extraction counter reaches the configured cap, encounters a corrupt counter file, or hits
an internal error. Written inside the locked section (or on the corrupt/error path).
Fail-open: emission failures are silently swallowed.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "learning_circuit_tripped",
  "schema_version": 1,
  "orchestration_id": "<current orch id, or 'unknown'>",
  "scope": "auto_extract",
  "reason": "quota_exceeded",
  "count": 10,
  "max": 10
}
```

**`reason` enum values:**

| reason | When emitted |
|---|---|
| `quota_exceeded` | `state.count >= max` — rolling window cap reached |
| `counter_corrupt` | Counter file exists but cannot be parsed (F-04 fix) |
| `internal_error` | Unexpected exception during the locked section; `detail` field carries truncated message |

**Optional fields:** `count` and `max` appear with `quota_exceeded`. `detail` (string,
max 80 chars) appears with `internal_error`. `orchestration_id` is `'unknown'` when the
orchestration state file cannot be read.

**Consumer:** `/orchestray:status` surfaces the tripped state via the sentinel file
(`.orchestray/state/learning-breaker-{scope}.tripped`); this event provides the
corresponding audit trail entry.

---

### `learning_circuit_reset`

Emitted by `bin/_lib/learning-circuit-breaker.js` (`reset`) when the circuit breaker for
a scope is explicitly cleared — deleting both the counter file and the trip sentinel.
Triggered by `/orchestray:config repair`. Fail-open: emission failures are silently
swallowed.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "learning_circuit_reset",
  "schema_version": 1,
  "orchestration_id": "<current orch id, or 'unknown'>",
  "scope": "auto_extract"
}
```

**Field notes:**
- `scope`: The circuit-breaker scope that was reset — matches the scope used in the
  preceding `learning_circuit_tripped` event.
- `orchestration_id`: Best-effort read from the current orchestration state file;
  `'unknown'` if unavailable.
- No `reason` field — a reset is always user-initiated via repair and has no sub-cases.

**Consumer:** Operators monitoring for recovery after a circuit trip should look for this
event following a `learning_circuit_tripped` in the same session.

---

### Degraded-journal `kind` additions (v2.1.6)

New `kind` values added to the degraded-journal enum (see v2.1.2 section for the full
schema). All follow the same `{ schema, timestamp, kind, severity, detail }` shape.

| kind | severity | When written |
|---|---|---|
| `auto_learning_config_malformed` | warn | `auto_learning` config block failed type validation; all-off defaults used |
| `kb_refs_sweep_file_read_error` | warn | `kb-refs-sweep.js` could not read a KB or patterns file |
| `kb_refs_sweep_malformed_frontmatter` | info | A scanned file has unparseable frontmatter; file is still scanned for refs |
| `pattern_roi_snapshot_write_error` | warn | `pattern-roi-aggregate.js` could not write `roi-snapshot.json` |
