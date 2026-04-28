# Event Schemas Reference

<!-- CONDITIONAL-LOAD NOTICE (v2.1.11 R1)
     NOT always-loaded. Dispatched by Tier-2 rule in pm.md on three conditions:
       A. PM about to emit an event type NOT in the index below.
       B. Hook validation error referencing unknown event type appears in current turn.
       C. PM about to edit a file under hooks/ that emits events.
     Kill-switch: ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1 or config prompt_loading.event_schemas_conditional=false.

## Summary Index

routing_outcome — routing decision (3 variants: hook/PM/SubagentStop)
agent_start / agent_stop — invocation lifecycle (hook)
task_created / task_completed / task_validation_failed — task lifecycle (hook/PM)
teammate_idle — Agent-Teams idle signal (hook)
pattern_skip_enriched / auto_extract_quarantine_skipped — pattern skip events (hook)
routing_decision — complexity scoring decision (PM)
invariant_extracted / introspection_trace / confidence_signal — insight capture (PM)
visual_review / consequence_forecast / drift_check — quality gate events (PM)
resilience_block_triggered / resilience_block_suppressed(_inactive) — compact block (hook)
state_cancel_aborted — cancel sentinel fired (PM)
mcp_checkpoint_missing / kill_switch_activated / kill_switch_deactivated — enforcement (hook)
model_auto_resolved — model auto-resolved by gate, warn level (hook, v2.1.11)
pre_compact_archive / cite_cache_hit / spec_sketch_generated / repo_map_delta_injected — telemetry (hook)
tier2_load — Tier-2 pm-reference file loaded (hook, v2.1.12)
tier2_invoked — Tier-2 feature protocol primary action fired (hook, v2.1.14)
feature_gate_eval — Feature gate state snapshot at PM turn start (hook, v2.1.14)
mcp_checkpoint_recorded.fields_used — fields_used + response_bytes augmentation (hook, v2.1.14)
block_a_zone_composed — Block A zone assembly (hook, v2.1.14)
cache_invariant_broken — Zone 1 hash mismatch detected (hook, v2.1.14)
cache_manifest_bootstrap — first-prompt manifest cold-start (hook, v2.2.2)
block_a_zone1_invalidated — Zone 1 manual invalidation (hook, v2.1.14)
delta_handoff_fallback — developer full-artifact fetch decision in delta mode (PM, v2.1.15)
budget_warn — pre-spawn context-size budget exceeded (hook, v2.1.15)
phase_slice_fallback — phase-slice hook degraded path (no orchestration / unknown phase / missing slice file) (hook, v2.1.15 W8)
phase_slice_injected — phase-slice hook positive path (slice pointer staged into PM additionalContext) (hook, v2.1.16 W9 R-PHASE-INJ)
repo_map_built / repo_map_parse_failed / repo_map_grammar_load_failed / repo_map_cache_unavailable — Aider-style repo map events (v2.1.17 W8 R-AIDER-FULL)

END CONDITIONAL-LOAD NOTICE -->

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

### `routing_outcome` event

Spawn-and-completion lifecycle record for `Agent()` invocations. Emitted by
`bin/emit-routing-outcome.js` (Variant A, spawn-time) and by
`bin/collect-agent-metrics.js` (Variant C, completion-time supplement). The
canonical schema below covers all variants — variant-specific field
populations are documented under "Variants" further down this section.

```json
{
  "type": "routing_outcome",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "agent_type": "developer",
  "tool_name": "Agent|Explore|Task",
  "model_assigned": "sonnet|opus|haiku|null",
  "effort_assigned": "low|medium|high|xhigh|max|null",
  "description": "First 200 chars of Agent() prompt or description",
  "score": null,
  "source": "hook|pm|subagent_stop"
}
```

Field notes:
- `source: "hook"` (Variant A) — written at spawn time by the
  `PostToolUse:Agent` hook. Has `score: null` and lacks PM-derived fields.
- `source: "pm"` (Variant B, optional) — written later by the PM during
  Section 4 result processing if it chooses to supplement.
- `source: "subagent_stop"` (Variant C) — written at completion by
  `bin/collect-agent-metrics.js`. Auto-emitted unless the dedupe gate
  (`hasExistingRoutingOutcome`) detects an existing Variant A/B for the
  same `(orchestration_id, agent_type)`. Suppression introduced in
  v2.2.0 P1.1 (`ORCHESTRAY_DISABLE_VARIANT_C_DEDUP=1` reverts).
- Per-variant detailed schemas and consumer guidance follow in the
  "Variants" subsections below.

#### Variants

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

### `pattern_skip_enriched` event

<!-- W11 LL1 -->

Appended by `mcp__orchestray__pattern_record_skip_reason` when the PM records a
structured skip decision for a pattern returned by `pattern_find`. This event is emitted
**in addition to** the standard `mcp_tool_call` audit row and carries counterfactual
signal so operators can distinguish "skipped because contextually mismatched" from
"skipped because forgotten."

Cross-ref: the MCP tool that emits this event is `pattern_record_skip_reason`
(`bin/mcp-server/tools/pattern_record_skip_reason.js`). The structured skip-recording
contract is documented in `extraction-protocol.md §22b-pre`.

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
  `extraction-protocol.md §22b-pre` for the full taxonomy and guidance on when to use each.
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

## Agent Lifecycle Events

### `agent_start`

Appended on every `SubagentStart` hook by `bin/audit-event.js`. Records the
spawn-time identity of an Orchestray subagent for the audit trail. Paired with
the corresponding `agent_stop` event (joinable on `agent_id`).

**Schema version:** `2` (v2.1.17 — additive bump from `1`; old consumers
ignore unknown fields per R-EVENT-NAMING).

```json
{
  "type": "agent_start",
  "version": 2,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "agent_id": "agent-xxx",
  "agent_type": "developer",
  "session_id": "uuid",
  "review_dimensions": "<optional, reviewer-only: \"all\" | string[]>"
}
```

Field notes:
- `agent_id`: Stable per-invocation id from the `SubagentStart` payload.
- `agent_type`: Canonical agent name (`pm`, `architect`, `developer`,
  `reviewer`, etc.) or a non-canonical specialist name (in which case a
  paired `dynamic_agent_spawn` event follows).
- `session_id`: The parent (PM) session id.
- `review_dimensions` *(optional, reviewer-only, v2)*: The dimension scope the
  PM passed via the `## Dimensions to Apply` block of the delegation prompt
  (R-RV-DIMS, v2.1.16). Either the literal string `"all"` or a sorted subset
  of `["code-quality","performance","documentation","operability","api-compat"]`.
  ABSENT (field not present on the event) when:
    - the spawn is not a reviewer;
    - the prompt did not carry a `## Dimensions to Apply` block (legacy
      v2.1.15-style spawns);
    - the staging cache was unavailable at SubagentStart (fail-open).
  This field exists to feed the v2.1.18 R-RV-DIMS scoped-by-default flip
  trigger (≥ 60 % of reviewer spawns carry an explicit field) — the analytics
  rollup is in `skills/orchestray:analytics/SKILL.md` Rollup G.

**Schema changelog:**
- `v1` (≤ v2.1.16): `agent_id`, `agent_type`, `session_id`. Required fields
  unchanged in v2.
- `v2` (v2.1.17, R-RV-DIMS-CAPTURE): added optional `review_dimensions`
  (reviewer-only). Additive — no consumer changes required.

---

### `agent_stop` event

Appended when an agent finishes execution (used in audit trail and cost
tracking). Emitted by `bin/collect-agent-metrics.js` on `SubagentStop` and
`TaskCompleted` hooks.

```json
{
  "type": "agent_stop",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "agent_id": "agent-xxx",
  "agent_type": "developer",
  "session_id": "uuid",
  "last_message_preview": "First 200 chars...",
  "usage": { "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0 },
  "usage_source": "transcript|event_payload|estimated",
  "cost_confidence": "measured|estimated",
  "estimated_cost_usd": 0.123,
  "estimated_cost_opus_baseline_usd": 0.456,
  "transcript_path": "/path/to/transcript.jsonl",
  "model_used": "sonnet|opus|haiku|null|unknown_team_member",
  "turns_used": 12
}
```

Field notes:
- `cost_confidence` *(v2.2.0 P1.1)*: `"measured"` when `model_used` was
  resolved via a matching `routing_outcome` event in `events.jsonl`;
  `"estimated"` when the resolver fell through to
  `bin/_lib/team-config-resolve.js` or to `unknown_team_member`.
  Dashboards SHOULD surface the share of `estimated` rows so silent-default
  pricing never accumulates unobserved.
- `model_used = "unknown_team_member"` *(v2.2.0 P1.1)*: explicit label when
  the team-config resolver cannot find a known model. Replaces the prior
  silent default to Sonnet pricing. Paired with `cost_confidence: "estimated"`.

---

### `task_created` event

Appended on every Agent Teams `TaskCreated` hook by `bin/audit-team-event.js`.
Records the spawn-time identity of a teammate task in an active team
orchestration. Mode-tagged `"teams"` to distinguish from non-team subagent
spawns.

```json
{
  "type": "task_created",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "mode": "teams",
  "task_id": "task-xxx",
  "task_subject": "First-200-char subject",
  "task_description": "Full description provided to teammate",
  "teammate_name": "developer|reviewer|<lead-defined>",
  "team_name": "team-xxx",
  "session_id": "uuid"
}
```

Field notes:
- `mode: "teams"` distinguishes Agent Teams events from the `Agent()`
  subagent path (which emits `agent_start`/`agent_stop` instead). Always
  the literal string `"teams"`.
- `task_id`, `team_name`, `teammate_name`: copied from the `TaskCreated`
  hook payload; may be `null` on malformed payloads (the writer is
  fail-open).
- `task_subject`: provided by the lead at task creation time; null when
  not specified (T15 hook `bin/validate-task-completion.js` enforces it
  for hard-tier teammates).
- The wrapper at `bin/audit-team-event.js` accepts a positional CLI arg
  (`audit-team-event.js created`) for future extensibility but currently
  only the event type is differentiated. Paired with `task_completed` /
  `task_validation_failed` events on team-task lifecycle close.

---

### `delegation_delta_emit` event

Emitted by `agents/pm.md` Section 3 (R-DELEG-DELTA, v2.2.0) once per `Agent()`
spawn during orchestration. Pairs with P2.1 `cache_breakpoint_emit[slot=4]`
rollups to compute delta-mode hit rate and full-bytes-avoided per orchestration.

Schema version: 1

```json
{
  "version": 1,
  "type": "delegation_delta_emit",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "agent_type": "<developer | reviewer | architect | …>",
  "spawn_n": 2,
  "type_emitted": "delta",
  "prefix_hash": "<sha256 hex of the static prefix>",
  "prefix_bytes": 8842,
  "delta_bytes": 612,
  "full_bytes_avoided": 8230,
  "reason": null,
  "post_compact_resume": false
}
```

Field notes:

- `agent_type`: the subagent role. Used to scope the prefix cache; spawns of
  different agent types in the same orch carry different prefix hashes.
- `spawn_n`: 1-indexed sequence number within the
  `(orchestration_id, agent_type)` pair. `spawn_n: 1` is always
  `type_emitted: "full"`.
- `type_emitted`: `"full"` or `"delta"`. `"full"` means the entire assembled
  delegation prompt was passed to `Agent()`. `"delta"` means only the small
  per-spawn delta block was passed.
- `prefix_hash`: SHA-256 hex of the static portion of the delegation prompt.
  `cache_breakpoint_emit[slot=4]` carries the same hex for cross-correlation.
- `prefix_bytes`: utf-8 byte length of the static prefix.
- `delta_bytes`: utf-8 byte length of the per-spawn delta block. `null` when
  `type_emitted === "full"`.
- `full_bytes_avoided`: bytes NOT re-emitted on this spawn (i.e.,
  `prefix_bytes` when `type_emitted === "delta"`; `0` when `"full"`). Rollup
  metric for the v2.2.0 P3.2 savings claim.
- `reason`: `null` on the happy delta path; otherwise one of `"first_spawn"`,
  `"hash_mismatch"`, `"post_compact_resume"`, `"markers_missing"`,
  `"empty_prompt"`, `"disk_write_failed"`, `"disabled"`. Used by operators
  for diagnosis.
- `post_compact_resume`: `true` only on the first spawn after a `/compact`
  recovery (Section 7.C in pm.md). `false` otherwise. Surfaces post-compact
  re-anchoring in dashboards separately from genuine `hash_mismatch`.

Backward compatibility: new event type in v2.2.0; older consumers ignore
unknown types per R-EVENT-NAMING. Schema stability: additive-only.

---

### `delegation_delta_skip` event

Emitted by `bin/inject-delegation-delta.js` (`PreToolUse:Agent` hook,
v2.2.2) on any path where the hook does NOT mutate the prompt AND does
NOT emit a `delegation_delta_emit`. Distinguishes intentional skips
(kill switch, no orchestration active, markers missing) from errors
(`compute_delta` threw). Lets the v2.2.x dashboard separate "feature
disabled by operator" from "feature broken" without parsing per-
event reasons.

Schema version: 1

```json
{
  "version": 1,
  "type": "delegation_delta_skip",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id> | null",
  "agent_type": "<developer | reviewer | …> | null",
  "reason": "kill_switch_env",
  "error_class": null
}
```

Field notes:

- `orchestration_id`: `null` when the hook fired before an
  orchestration was active (e.g., bare `Agent()` calls from the user).
- `agent_type`: `null` when the spawn payload was malformed (no
  `subagent_type` field).
- `reason`: enum — one of:
    - `kill_switch_env` — `ORCHESTRAY_DISABLE_DELEGATION_DELTA=1`
    - `kill_switch_config` — `pm_protocol.delegation_delta.enabled: false`
    - `kill_switch_helper` — helper's own kill switch fired (defence-in-depth)
    - `no_orchestration_active` — no `current-orchestration.json` marker
    - `empty_prompt` — `tool_input.prompt` was empty
    - `markers_missing` — prompt did not carry the static/per-spawn marker pair
    - `compute_delta_threw` — helper raised an unexpected exception
- `error_class`: present only when `reason === 'compute_delta_threw'`;
  the constructor name of the thrown exception (e.g., `'TypeError'`).

Backward compatibility: new event type in v2.2.2; older consumers
ignore unknown types per R-EVENT-NAMING. Schema stability: additive-only.

---

### `scout_spawn` event

Audit row emitted at the moment the PM's Section 23 decision rule returns
`True` (i.e., the PM is about to spawn a `haiku-scout`). One row per spawn.
Written via `bin/_lib/audit-event-writer.js` to
`.orchestray/audit/events.jsonl`.

```json
{
  "type": "scout_spawn",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx | null",
  "session_id": "uuid | null",
  "target_bytes": 22000,
  "scout_min_bytes": 12288,
  "op": "Read | Glob | Grep",
  "path": "/abs/path/to/target",
  "scout_estimated_inline_cost_usd": 0.015,
  "scout_estimated_scout_cost_usd": 0.005,
  "scout_estimated_savings_usd": 0.010,
  "decision_reason": "exceeds_12kb"
}
```

Field notes:
- `target_bytes`: `fs.statSync(target_path).size` at spawn time.
- `scout_min_bytes`: the configured threshold at spawn time (default 12288).
  Captured per row so threshold flips are auditable post-hoc.
- `op`: one of `Read`, `Glob`, `Grep`. Other values are validation errors.
- `scout_estimated_*_usd`: PM-computed inline-Opus baseline vs Haiku-scout
  cost (overhead + content). `scout_estimated_savings_usd =
  scout_estimated_inline_cost_usd − scout_estimated_scout_cost_usd`. May
  be negative on misclassification — telemetry surface for the v2.2.1
  promotion gate.
- `decision_reason`: free-form short tag (e.g., `exceeds_12kb`,
  `forced_inline_path`). Used in v2.2.1 promotion-gate analytics.
- Two paired diagnostic events (`scout_forbidden_tool_blocked`,
  `scout_files_changed_blocked`, defined below) are emitted by
  `bin/validate-task-completion.js` when a `haiku-scout` transcript breaks
  the read-only contract. They are distinct event types with their own
  schema rows — they are NOT folded into `scout_spawn`.

Cross-references: `pm.md §23` (decision rule), `haiku-routing.md §23a`
(Class B), `cost-prediction.md §31a` (savings math + promotion gate).

**Promotion gate:** the v2.2.1 release is gated on ≥ 100 `scout_spawn`
events showing (a) cache-read ratio ≥ 30% on repeated invocations within
5-min and (b) mean `scout_estimated_savings_usd` > 0. See
`cost-prediction.md §31a`.

---

### `scout_forbidden_tool_blocked` event

Diagnostic event emitted by `bin/validate-task-completion.js` (TaskCompleted
hook) when a read-only-tier agent (today: `haiku-scout`) is observed calling
a forbidden tool (`Edit`, `Write`, or `Bash`). Fires AFTER the structural
3-layer enforcement (frontmatter `tools:` whitelist + runtime rejection +
`p22-scout-whitelist-frozen.test.js` byte-equality check) catches the
violation. The event records the violation for analytics; the hook also
exits 2 to block the offending TaskCompleted payload.

Schema version: 1

```json
{
  "version": 1,
  "type": "scout_forbidden_tool_blocked",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "hook": "validate-task-completion",
  "agent_role": "haiku-scout",
  "forbidden_tools": ["Edit"],
  "session_id": "<session uuid or null>"
}
```

Field notes:
- `agent_role`: the read-only-tier role that violated the contract
  (lower-cased, trimmed). The `READ_ONLY_AGENTS` set in
  `bin/validate-task-completion.js` is the authoritative list.
- `forbidden_tools`: the tool names from `event.tool_calls` that
  intersected `SCOUT_FORBIDDEN_TOOLS = {Edit, Write, Bash}`. Tolerant to
  varied payload shapes (`{name}`, `{tool_name}`, raw string).
- `session_id`: the session id from the hook payload, or null when
  unavailable.
- `hook`: always `validate-task-completion` for this event type.
- Source: emitted by `bin/validate-task-completion.js:656-664`.
- feature_optional: true (negative-path guard; legitimately dark per W4 RCA-10. Excluded from the F3 promised-event tracker so it does not alarm.)

---

### `scout_files_changed_blocked` event

Diagnostic event emitted by `bin/validate-task-completion.js` (TaskCompleted
hook) when a read-only-tier agent returns a Structured Result whose
`files_changed` array is non-empty. Read-only agents must always return
`files_changed: []`. Fires alongside the exit-2 block; complementary to
`scout_forbidden_tool_blocked` (forbidden-tool-call vs lying-in-result).

Schema version: 1

```json
{
  "version": 1,
  "type": "scout_files_changed_blocked",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "hook": "validate-task-completion",
  "agent_role": "haiku-scout",
  "files_changed": ["agents/pm.md"],
  "session_id": "<session uuid or null>"
}
```

Field notes:
- `agent_role`: the read-only-tier role that violated the contract.
- `files_changed`: the array the agent returned in its Structured Result.
  Recorded verbatim (entries are the agent-supplied path strings).
- `session_id`: the session id from the hook payload, or null when
  unavailable.
- `hook`: always `validate-task-completion` for this event type.
- Source: emitted by `bin/validate-task-completion.js:676-684`.
- feature_optional: true (negative-path guard; legitimately dark per W4 RCA-10. Excluded from the F3 promised-event tracker so it does not alarm.)

---

### `sentinel_probe` event

Appended on every `runProbe` call from `bin/_lib/sentinel-probes.js` (P1.4,
v2.2.0). The five class-C deterministic probes the PM uses in place of
inline Bash. Pre-materialized telemetry feeds the v2.2.0 §6.T cost rollup
and proves the post-sentinel baseline narrows the variance described in
`v220-scope-locked.md` line 148.

```json
{
  "type": "sentinel_probe",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "op": "fileExists | lineCount | gitStatus | schemaValidate | hashCompute",
  "target": "<truncated 200-char identifier — file path, event type, or 'multi'>",
  "duration_ms": 12,
  "result_type": "ok | fail_soft | over_cap | invalid_path",
  "source": "cli | require"
}
```

Field notes:
- `op`: one of the five whitelisted operations. Future ops MUST add their
  literal to this enum and to `_ALLOWED_OPS` in `sentinel-probes.js` in the
  same commit.
- `target`: human-readable identifier of what was probed; truncated to
  200 chars to bound row size. For `gitStatus({paths:[…]})` the target uses
  the literal prefix `multi:` plus the count.
- `duration_ms`: integer milliseconds from the runProbe entry to the result
  object. Used for the perf-budget assertion in tests and the rollup.
- `result_type`: stable categorical for analytics. `ok` ↔ `result.ok===true`;
  `fail_soft` ↔ `result.ok===false` with a known `reason`; `over_cap` is the
  specialization for `lineCount`/`hashCompute` byte-cap and `args_too_large`
  hits; `invalid_path` is the security-guard reject case.
- `source`: `cli` when invoked via `bin/sentinel-probe.js`; `require` when
  invoked via direct `require('./_lib/sentinel-probes')` from another
  Node-side script.

Backward compatibility: new event type in v2.2.0; older consumers ignore
unknown types per R-EVENT-NAMING. Schema-shadow (R-SHDW) regeneration is
required at release time — `bin/regen-schema-shadow.js` picks the row up
automatically from this section.

---

### `block_z_emit` event

Emitted by `bin/compose-block-a.js` (UserPromptSubmit hook) once per turn when
Block-Z (P2.1, v2.2.0) is built. The event is the observable signal that
Block-Z is being composed — pair with `cache_creation_input_tokens` and
`cache_read_input_tokens` rollups to compute hit-rate over the Block-Z region.

Schema version: 1

```json
{
  "version": 1,
  "type": "block_z_emit",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "project_hash": "<sha256 hex of cwd>",
  "pm_md_hash": "<sha256 hex of agents/pm.md bytes>",
  "claude_md_hash": "<sha256 hex of CLAUDE.md bytes>",
  "handoff_contract_hash": "<sha256 hex of handoff-contract.md bytes>",
  "phase_contract_hash": "<sha256 hex of phase-contract.md bytes>",
  "block_z_hash": "<sha256 hex of the assembled Block-Z body>",
  "prefix_token_estimate": 40100,
  "byte_length": 160574,
  "error": null
}
```

Field notes:
- `project_hash`: `sha256(resolveSafeCwd(cwd))` — anonymises the absolute path
  while preserving cross-orchestration linkability for analytics.
- `pm_md_hash`, `claude_md_hash`, `handoff_contract_hash`, `phase_contract_hash`:
  full hex of each component file's raw bytes. `null` when the corresponding
  component was missing or `error !== null`.
- `block_z_hash`: full hex of the assembled Block-Z body (excluding the
  fingerprint comment, which is derived from this hash). `null` on error.
- `prefix_token_estimate`: chars/4 rough estimate; reviewer should multiply by
  ~1.35 to get the Opus 4.7 tokenizer count.
- `byte_length`: utf-8 byte length of the assembled Block-Z body.
- `error`: `null` on happy path; `"missing_input"` if any of the four component
  files was missing; `"component_oversize"` if any file exceeded 1 MB; or
  `"disabled"` when the kill switch is active.
- Source: emitted by `bin/compose-block-a.js` after `buildBlockZ()` returns.

Backward compatibility: new event type in v2.2.0; older consumers ignore
unknown types per R-EVENT-NAMING.

---

### `cache_breakpoint_emit` event

Emitted by `bin/compose-block-a.js` (UserPromptSubmit hook) once per slot, per
turn (P2.1, v2.2.0). With the 4-slot manifest, this means up to 4 events per
turn. Pair with `cache_creation_input_tokens` and `cache_read_input_tokens`
rollups to compute hit-rate per slot.

Schema version: 1

```json
{
  "version": 1,
  "type": "cache_breakpoint_emit",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "slot": 1,
  "ttl": "1h",
  "marker_byte_offset": 160574,
  "prefix_hash": "<sha256 hex of the bytes before the marker>",
  "prefix_token_estimate": 40100,
  "ttl_downgrade_applied": false
}
```

Field notes:
- `slot`: `1`, `2`, `3`, or `4` per the 4-slot manifest definition.
- `ttl`: `"1h"` or `"5m"`. Slots 1 and 2 default to `"1h"`; downgrade to `"5m"`
  when `pm_protocol.estimated_orch_duration_minutes < 25`. Slots 3 and 4 are
  always `"5m"`.
- `marker_byte_offset`: byte position in the assembled `additionalContext`
  payload where the cache_control marker for this slot would land.
- `prefix_hash`: SHA-256 hex of the bytes BEFORE the marker (i.e., the
  cacheable region for this slot).
- `prefix_token_estimate`: chars/4 estimate of the prefix length.
- `ttl_downgrade_applied`: `true` only on slots 1 and 2 when the short-orch
  downgrade triggered. Always `false` on slots 3 and 4.
- Source: emitted by `bin/compose-block-a.js` after `buildManifest()` returns,
  one event per slot.

Backward compatibility: new event type in v2.2.0; older consumers ignore
unknown types per R-EVENT-NAMING.

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

---

### Auto-extract backend events (v2.1.7 Bundle A)

#### `auto_extract_staged` — field addition

The existing `auto_extract_staged` event gains one new field in v2.1.7:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "auto_extract_staged",
  "schema_version": 1,
  "orchestration_id": "<current orch id>",
  "proposal_count": 2,
  "shadow": false,
  "backend_elapsed_ms": 4200
}
```

**`backend_elapsed_ms`** (new in v2.1.7): wall-clock milliseconds from subprocess spawn
to exit, as measured by `haiku-extractor-transport.js`. Zero for the stub backend.
Useful for doctor probes and performance monitoring of the Haiku CLI invocation.

#### Degraded-journal `kind` additions (v2.1.7 Bundle A)

| kind | severity | detail fields | When written |
|---|---|---|---|
| `auto_extract_parse_failed` | warn | `first_200_bytes`, `backend` | Extractor stdout was not valid `ExtractorOutput` JSON, had wrong `schema_version`, or had missing/invalid required fields |
| `auto_extract_backend_timeout` | warn | `timeout_ms`, `killed_at` | Subprocess did not exit within `timeout_ms`; SIGTERM sent |
| `auto_extract_backend_exit_nonzero` | error | `exit_code`, `stderr_head` | Subprocess exited with a non-zero exit code |
| `auto_extract_backend_oversize` | warn | `bytes_received` | Subprocess stdout exceeded `max_output_bytes`; output discarded |

All four kinds follow the standard degraded-journal shape and appear in
`.orchestray/state/degraded.jsonl`. They are readable via `/orchestray:doctor`.

On any of these conditions:
- Zero proposals are written to `.orchestray/proposed-patterns/`
- The `auto_extract_staged` event still fires with `proposal_count: 0`
- The circuit breaker still increments (prevents runaway on persistently-failing backend)
- The hook still exits 0 (fail-open discipline)

---

### MCP enforcement — `max_per_task` shape (v2.1.7)

The `mcp_server.max_per_task` config block is now validated by `loadMcpServerConfig` in
`bin/_lib/config-schema.js`. The validated shape is `{ ask_user, kb_write, pattern_record_application, ...<unknown-tool pass-throughs> }`, where each known tool value is an integer in the range 1..1000 (defaults all 20). `tool-counts.js` reads the validated shape when `cwd` is supplied; falls back to direct `config.mcp_server.max_per_task` read for raw-config callers. Two new degraded-journal KINDs are used by this path:

| kind | severity | When written |
|---|---|---|
| `mcp_server_max_per_task_out_of_range` | warn | A known tool's configured value is outside 1..1000 or non-integer; value falls back to the default (20). One entry per tool per boot, dedup-keyed on `mcp_server_max_per_task_out_of_range\|<tool>`. |
| `mcp_server_max_per_task_unknown_tool` | warn | A config key names an MCP tool the loader does not recognize; value is passed through unchanged (K5). One entry per tool per boot, dedup-keyed on `mcp_server_max_per_task_unknown_tool\|<tool>`. |

---

## Resilience Dossier — Events (v2.1.7 Bundle D)

Emitted by the three new hooks implementing compaction-resilience dossier writes and
post-compact re-hydration: `bin/write-resilience-dossier.js`,
`bin/mark-compact-signal.js`, and `bin/inject-resilience-dossier.js`. All land in
`.orchestray/audit/events.jsonl` via `atomicAppendJsonl`.

### `compaction_detected`

Emitted by `bin/mark-compact-signal.js` when `SessionStart` fires with
`source:"compact"` or `source:"resume"`. Per K2 arbitration, `source:"clear"` is
intentionally NOT emitted — `/clear` is a deliberate user reset, so no lock is dropped
and no event is recorded.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "compaction_detected",
  "source": "compact" | "resume",
  "trigger": "manual" | "auto" | null,
  "orchestration_id": "<id | null>"
}
```

### `dossier_written`

Emitted by `bin/write-resilience-dossier.js` on every successful atomic write of
`.orchestray/state/resilience-dossier.json`, whether invoked directly as a Stop /
SubagentStop hook or via `writeDossierSnapshot()` from `pre-compact-archive.js`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "dossier_written",
  "orchestration_id": "<id | null>",
  "size_bytes": <int>,
  "phase": "<phase or null>",
  "status": "<status or null>",
  "pending_count": <int>,
  "completed_count": <int>,
  "truncation_flags": ["<flag>", ...],
  "trigger": "stop" | "subagent_stop" | "pre_compact" | "unknown"
}
```

### `dossier_injected`

Emitted by `bin/inject-resilience-dossier.js` when a post-compact UserPromptSubmit
successfully injects the dossier as `additionalContext`. Not emitted in shadow mode;
not emitted when the lock is absent or counter is exhausted.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "dossier_injected",
  "orchestration_id": "<id | null>",
  "written_at": "<ISO 8601 | null>",
  "ingested_counter_before": <int>,
  "ingested_counter_after": <int>,
  "bytes_injected": <int>,
  "source_lock": "compact" | "resume" | null,
  "truncated": <boolean>
}
```

`truncated: true` means the fenced payload exceeded `resilience.inject_max_bytes` and the
advisory fallback (scalars + MCP URI pointer) was injected instead of the full dossier.

### `rehydration_skipped_clean`

Emitted by `bin/inject-resilience-dossier.js` each time injection is suppressed for a
benign reason. Used by `/orchestray:doctor` to distinguish healthy quiet-periods from
failures.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "rehydration_skipped_clean",
  "reason": "no-lock" | "counter_exhausted" | "no-dossier" | "completed" |
            "shadow_mode" | "kill-switch",
  "orchestration_id": "<id | null>",
  "counter": <int, only with counter_exhausted>,
  "max": <int, only with counter_exhausted>,
  "lock_source": "<compact|resume|null>",
  "bytes_would_inject": <int, only with shadow_mode>
}
```

### Degraded-journal `kind` additions (v2.1.7 Bundle D)

| kind | severity | When written |
|---|---|---|
| `dossier_write_failed` | warn | Atomic write of `resilience-dossier.json` failed (ENOSPC, EACCES, path-collision). Dedup-keyed per `orchestration_id\|err_code`. |
| `dossier_inject_failed` | warn | Injector could not read/parse/emit the dossier (fs error or oversize truncation). |
| `dossier_corrupt` | warn | `parseDossier` rejected the file: JSON parse error, `schema_version` mismatch, or missing critical fields. |
| `dossier_stale` | info | Dossier present but `status == "completed"` — injector suppressed the injection. |
| `compact_signal_stuck` | warn | `compact-signal.lock` could not be written, parsed, or cleaned up. |
| `dossier_fence_collision` | warn | Injector detected a fence-escape in the raw dossier file at injection time (defense-in-depth check after `parseDossier`). Injection is aborted; `rehydration_skipped_fence_collision` is emitted to events.jsonl. |

### `rehydration_skipped_fence_collision` (v2.1.7 patch round)

Emitted by `bin/inject-resilience-dossier.js` to `events.jsonl` when the defense-in-depth fence-collision check fires at injection time. The dossier is not injected; the degraded journal also receives a `dossier_fence_collision` entry.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "rehydration_skipped_fence_collision",
  "orchestration_id": "<id | null>",
  "reason": "fence_collision"
}
```

Field notes:
- Emitted only on the defense-in-depth path (injector-side check). The serializer-side check at `serializeDossier` time emits `fence_collision_cleared` in `truncation_flags` on the dossier, not a separate event.
- Consumers that see this event should investigate whether a project file contains the Orchestray context-fence marker strings verbatim.
| `dossier_oversize_truncated` | warn | Serializer had to drop deferred and/or expanded tiers to stay ≤ 12 KB. |

### Degraded-journal `kind` additions (v2.1.7 zero-deferral patch — SEC-04/SEC-05/F4)

| kind | severity | When written |
|---|---|---|
| `file_too_large` | warn | A file exceeded its per-site read cap; the reader returned an empty-equivalent value and the caller fails open. Emitted by `kb-refs-sweep.js` (index.json > 10 MiB, slug-ignore.txt > 1 MiB) and `write-resilience-dossier.js` (marker > 256 KiB, mcp-checkpoint.jsonl > 256 KiB, routing.jsonl > 4 MiB, drift-invariants.jsonl > 256 KiB). |
| `file_read_failed` | warn | An fd-based read failed with an unexpected errno (not a size-cap breach); the caller fails open. Emitted by the same sites as `file_too_large` when the OS returns an error other than a size overflow. |
| `dossier_field_sanitised` | warn | A path-like dossier field failed SEC-05 sanitisation (NUL byte, path-traversal segment, oversize, or ASCII control character); the field was replaced with null and dossier serialisation continues. |

### Degraded-journal `kind` additions (v2.1.8 Bundle CTX)

| kind | emitter | severity | condition | PM fallback action |
|---|---|---|---|---|
| `pattern_seen_set_write_failed` | `bin/_lib/pattern-seen-set.js` `recordSeen()` | warn | Disk write error (ENOSPC, EACCES, lock timeout) when appending a seen-set row | Treat as not-seen; emit full pattern body for this delegation. No orchestration block. |
| `pattern_seen_set_corrupt` | `bin/_lib/pattern-seen-set.js` `_readRows()` | warn | JSONL parse error or file oversize (>2 MB) on seen-set read | Treat file as empty; emit full bodies for remainder of orchestration. |
| `spec_sketch_parse_failed` | `bin/_lib/spec-sketch.js` `generateSketch()` | warn | Symbol parser threw or diff parsing failed (unfamiliar language structure) | Fall back to prose handoff template. Downstream agent receives full prose context. |
| `spec_sketch_budget_exceeded` | `bin/_lib/spec-sketch.js` `generateSketch()` | warn | Rendered skeleton exceeded ~400 tokens (1600 chars); file list truncated to top N | Truncated skeleton emitted with `... {N} more file(s) not listed` trailer appended. |
| `repo_map_delta_first_emit_failed` | `bin/_lib/repo-map-delta.js` `_emitFirstFull()` | warn | First-emission file write or state-record failed | Fall back to full filtered repo-map injection for this delegation. |
| `repo_map_delta_first_agent_unknown` | `bin/_lib/repo-map-delta.js` `injectRepoMap()` | warn | State row exists for this orch_id but `first_agent` field is missing/null (post-compact race or corrupt row) | Fall back to full filtered repo-map injection so downstream agent is not under-informed. |
| `archetype_cache_blacklisted` | `bin/_lib/archetype-cache.js` `recordBlacklisted()` | info | Cache match found but archetype_id appears in the operator blacklist; advisory suppressed | No advisory fence injected; orchestration proceeds with normal PM decomposition. |
| `archetype_cache_signature_failed` | `bin/inject-archetype-advisory.js` `handleUserPromptSubmit()` | warn | `computeSignature()` returned empty string (all four components collapsed to empty) | Advisory skipped; orchestration proceeds normally. |
| `archetype_cache_hint_write_failed` | `bin/_lib/archetype-cache.js` `recordAdvisoryServed()` | warn | `atomicAppendJsonl` write to events.jsonl failed for the advisory_served event | Advisory was served to PM but event not persisted; ROI stats will under-count this serve. |

---

## Section 22: ArchetypeCache Events (v2.1.8)

### `archetype_cache_advisory_served`

Emitted by the PM (via `bin/_lib/archetype-cache.js recordAdvisoryServed()`) after the PM
reads an `<orchestray-archetype-advisory>` fence and decides how to use it.

```jsonc
{
  "timestamp": "<ISO 8601>",
  "type": "archetype_cache_advisory_served",
  "orchestration_id": "<current orch id>",
  "archetype_id": "<12-hex signature>",
  "archetype_name": "<human-readable label, optional>",
  "confidence": 0.91,
  "task_shape_hash": "<12-hex signature>",
  "prior_applications_count": 4,
  "pm_decision": "accepted | adapted | overridden",
  "pm_reasoning_brief": "<≤280 chars explaining the decision>"
}
```

Field notes:
- `archetype_id` and `task_shape_hash` are both the 12-hex signature string. They are
  the same value when the advisory is a direct signature match.
- `pm_decision` MUST be one of the three literal strings: `accepted`, `adapted`,
  `overridden`. Any other value is a protocol error.
- `pm_reasoning_brief` is the PM's ≤280-char explanation of its decision. Required —
  the PM MUST emit this field. Populated from the PM's `pm_reasoning_brief` field in
  its event emission.
- `confidence` is the Weighted-Jaccard score computed at lookup time (0.0–1.0).
- `prior_applications_count` is the count of successful prior applications at the time
  the advisory was served.

**When to emit:** the PM emits this event AFTER deciding accepted/adapted/overridden
in Section 13, as part of the archetype advisory protocol. The hook
`inject-archetype-advisory.js` injects the fence; the PM emits the event.

---

### `archetype_cache_miss`

Emitted by `bin/inject-archetype-advisory.js` (`recordCacheMiss()`) on the no-match
path — the orchestration has a computed task signature but no archetype in the cache
satisfies the confidence/prior-applications guardrails, so no advisory fence is
injected. R-ARCHETYPE-EVENT (v2.1.17) added this event so the `/orchestray:analytics`
rollup can compute `hit_rate = served / (served + miss)` over a rolling window;
the hit-rate gates v2.1.18+ R-SEMANTIC-CACHE's "≤30% hit-rate" defer trigger.

```jsonc
{
  "timestamp": "<ISO 8601>",
  "type": "archetype_cache_miss",
  "version": 1,
  "orchestration_id": "<current orch id>",
  "task_shape_hash": "<12-hex signature>",
  "archetype_count_searched": 12
}
```

Field notes:
- `task_shape_hash` is the 12-hex signature returned by `computeSignature()` for the
  current orchestration's task. Same field shape as `archetype_cache_advisory_served`.
- `archetype_count_searched` is the number of records in `archetype-cache.jsonl` at
  evaluation time (post-TTL filtering not applied — raw line count). Useful for
  distinguishing "miss because cache was empty" from "miss despite a populated
  cache." `0` when the cache file is missing.

**When to emit:** the hook emits this event when `findMatch()` returns `null` after
all guardrails (confidence floor, min prior applications, blacklist, kill switch)
have been considered. Pairs with `archetype_cache_advisory_served` (the hit signal)
to provide the denominator for hit-rate analytics.

**Pairing with `archetype_cache_blacklisted`:** when a match exists but is suppressed
because the archetype_id is on the operator blacklist, the hook emits both
`archetype_cache_blacklisted` (degraded-journal) AND `archetype_cache_miss` —
blacklist suppression IS a miss from the analytics perspective.

---

### archetype_cache_blacklisted (degraded-journal entry)

Written to `.orchestray/state/degraded.jsonl` (NOT to events.jsonl) when a cache match
is found but the archetype_id appears in
`context_compression_v218.archetype_cache.blacklist`.

```jsonc
{
  "timestamp": "<ISO 8601>",
  "kind": "archetype_cache_blacklisted",
  "severity": "info",
  "archetype_id": "<12-hex signature>"
}
```

This is an informational-only degraded entry. No advisory is served. The PM decomposes
from scratch as if no match existed. Visible in `/orchestray:doctor` output.

**Operator action:** if this entry appears frequently for an archetype you want to
re-enable, remove its ID from the `blacklist` array in `.orchestray/config.json`.
| `auto_extract_backend_unsupported_value` | warn | Config specified `backend: 'haiku-sdk'` (reserved, not implemented in v2.1.x); the pipeline fell back to `haiku-cli`. |

---

## Section 23: v2.1.9 Quality Gate Events

### `task_subject_missing`

Emitted by `bin/validate-task-subject.js` (wired as `PreToolUse[Agent]`) when an
`Agent()`, `Task()`, or `Explore()` spawn carries no meaningful description or
`task_subject:` line. The spawn is blocked (exit 2).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "task_subject_missing",
  "hook": "validate-task-subject",
  "orchestration_id": "<current orch id | null>",
  "subagent_type": "<subagent_type from tool_input, or null>",
  "reason": "<human-readable explanation of why validation failed>",
  "session_id": "<session id | null>",
  "payload_keys": ["<sorted list of keys present in tool_input>"]
}
```

Field notes:
- `subagent_type`: The `subagent_type` value the caller passed to `Agent()`, if any.
- `reason`: One of: "no description provided", "description too short (< 5 chars)",
  "description is whitespace-only", "no task_subject: line in prompt".
- `payload_keys`: Sorted list of keys present in `tool_input` — useful for diagnosing
  which fields the caller actually sent.

---

### `reviewer_scope_warn`

Emitted by `bin/validate-reviewer-scope.js` (wired as `PreToolUse[Agent]`) when a
reviewer agent is spawned without an explicit file list. Advisory only — the spawn
is not blocked (exit 0).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "reviewer_scope_warn",
  "hook": "validate-reviewer-scope",
  "orchestration_id": "<current orch id | null>",
  "subagent_type": "<subagent_type from tool_input, or null>",
  "session_id": "<session id | null>"
}
```

Field notes:
- Surfaces in `/orchestray:analytics` so reviewers delegated without file lists are
  visible across orchestrations.
- A reviewer spawn without a file list reviews all files changed in the session —
  this is valid but can be noisy on large orchestrations. The warning encourages
  the PM to pass an explicit `files_changed` list on subsequent spawns.

---

### `no_deferral_block`

Emitted by `bin/validate-no-deferral.js` (wired as `SubagentStop` in release phase)
when an agent's output contains a deferral phrase ("deferred to next release",
"TODO later", "will fix in vX", "for now", "punt", etc.). The stop is blocked (exit 2).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "no_deferral_block",
  "hook": "validate-no-deferral",
  "orchestration_id": "<current orch id | null>",
  "matched_phrase": "<the exact deferral phrase that triggered the block>",
  "context_snippet": "<up to 200 chars surrounding the matched phrase>",
  "session_id": "<session id | null>"
}
```

Field notes:
- `matched_phrase`: The literal phrase that matched the deferral pattern. Useful for
  distinguishing intentional "for now" clauses from accidental ones.
- `context_snippet`: The surrounding text (up to 200 chars) so operators can judge
  whether the phrase is genuinely deferral language.
- Rollback: set `PRE_DONE_ENFORCEMENT=warn` to downgrade to a warning (exit 0).

---

### `pre_done_checklist_failed`

Emitted by `bin/validate-task-completion.js` (wired as `SubagentStop` / `TaskCompleted`)
when a hard-tier agent (architect, developer, reviewer, release-manager) stops without
a valid Structured Result. The stop is blocked (exit 2) unless `PRE_DONE_ENFORCEMENT=warn`.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pre_done_checklist_failed",
  "hook": "validate-task-completion",
  "orchestration_id": "<current orch id | null>",
  "agent_role": "<architect|developer|reviewer|release-manager>",
  "tier": "hard",
  "missing_sections": ["<section name>", "..."],
  "session_id": "<session id | null>"
}
```

Field notes:
- `agent_role`: The agent role inferred from the SubagentStop/TaskCompleted payload.
- `missing_sections`: Which required Structured Result fields were absent or malformed.
  Canonical set: `status`, `summary`, `files_changed`, `files_read`, `issues`, `assumptions`.
- `tier`: Always `"hard"` on this event type. Warn-tier agents emit `task_completion_warn`.

---

### `pre_done_checklist_warn`

Emitted by `bin/validate-task-completion.js` alongside `pre_done_checklist_failed` when
`PRE_DONE_ENFORCEMENT=warn` is set, downgrading the block to a warning. Spawn proceeds.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "pre_done_checklist_warn",
  "hook": "validate-task-completion",
  "orchestration_id": "<current orch id | null>",
  "agent_role": "<agent role>",
  "enforcement_mode": "warn",
  "missing_sections": ["<section name>", "..."],
  "session_id": "<session id | null>"
}
```

Field notes:
- `enforcement_mode`: Always `"warn"` on this event — records that the hard-tier block
  was downgraded by the env var.
- This event appears alongside `pre_done_checklist_failed` (both are emitted when
  `PRE_DONE_ENFORCEMENT=warn`). Consumers should treat the pair as a single "soft block".

---

### `task_completion_warn`

Emitted by `bin/validate-task-completion.js` when a warn-tier agent stops without a
valid Structured Result. Advisory only — the stop is not blocked.

```json
{
  "timestamp": "<ISO 8601>",
  "type": "task_completion_warn",
  "hook": "validate-task-completion",
  "orchestration_id": "<current orch id | null>",
  "agent_role": "<agent role>",
  "tier": "warn",
  "missing_sections": ["<section name>", "..."],
  "session_id": "<session id | null>"
}
```

Field notes:
- `tier`: Always `"warn"` on this event type. Hard-tier agents emit `pre_done_checklist_failed`.

---

### `task_validation_failed`

Emitted by `bin/validate-task-completion.js` when a `TaskCompleted` event (Agent Teams)
is missing `task_id` or `task_subject`. The task is blocked (exit 2).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "task_validation_failed",
  "hook": "validate-task-completion",
  "orchestration_id": "<current orch id | null>",
  "reason": "missing task_id and task_subject | missing task_id | missing task_subject",
  "payload_keys": ["<sorted list of keys in the TaskCompleted payload>"]
}
```

Field notes:
- Distinct from `pre_done_checklist_failed` — this event fires on missing Agent Teams
  task identity fields, not on Structured Result schema violations.

---

### Degraded-journal `kind` additions (v2.1.9)

| kind | emitter | severity | condition |
|---|---|---|---|
| `curator_cursor_reset` | `bin/_lib/curator-diff.js` | warn | Curator detected a corrupt or stale diff-cursor in `curate --diff` mode and reset to full-diff. Gated to one event per session via a dedup key; subsequent detections in the same session are suppressed. |
| `pattern_seen_set_recovered` | `bin/_lib/pattern-seen-set.js` | warn | CiteCache seen-set read or parse failed; fail-open recovery applied — full pattern bodies emitted for the remainder of the orchestration. |
| `pattern_seen_set_oversize` | `bin/_lib/pattern-seen-set.js` | warn | Seen-set file exceeded the 10 MB cap; file was tail-truncated to ~5 MB before parse. Orchestration continues with the truncated set. |

---

## Section 24: v2.1.10 Compression Telemetry and Resilience Events

### `cite_cache_hit`

Emitted by `bin/emit-compression-telemetry.js` (wired as `SubagentStart`) when the
delegation prompt that is about to be sent to a subagent contains the CiteCache hit
marker (`[CACHED — loaded by`). Confirms that the v2.1.8 CiteCache compression path
fired on this delegation.

```json
{
  "type": "cite_cache_hit",
  "orchestration_id": "<current orch id | null>",
  "timestamp": "<ISO 8601>",
  "subagent_type": "<agent_type from SubagentStart payload | null>",
  "match_count": "<N>"
}
```

Field notes:
- `match_count`: Number of non-overlapping occurrences of the CiteCache marker in the
  delegation prompt. One event is emitted per delegation (not one per occurrence), with
  `match_count` recording the cardinality. Typical value is ≥1 when CiteCache is active
  and the PM correctly elided repeated pattern bodies.
- `orchestration_id`: Resolved from `.orchestray/audit/current-orchestration.json`; `null`
  if no orchestration is active at hook time.
- Kill-switch: `ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1` suppresses all compression
  telemetry events. Config key: `context_compression_v218.telemetry_enabled` (default `true`).
- **Historical names (v2.1.12 and earlier):** `event` / `ts` in place of `type` / `timestamp`.
  See §"Field naming — historical and unified (v2.1.13)" below. Consumers should normalize
  every row through `bin/read-event.js :: normalizeEvent` before reading fields.

---

### `spec_sketch_generated`

Emitted by `bin/emit-compression-telemetry.js` (wired as `SubagentStart`) when the
delegation prompt contains a `spec_sketch:` YAML preamble key at line-start position.
Confirms that the v2.1.8 SpecSketch injection fired on this delegation.

```json
{
  "type": "spec_sketch_generated",
  "orchestration_id": "<current orch id | null>",
  "timestamp": "<ISO 8601>",
  "subagent_type": "<agent_type from SubagentStart payload | null>",
  "match_count": "<N>"
}
```

Field notes:
- `match_count`: Number of lines in the delegation prompt that begin with `spec_sketch:`
  (after optional leading whitespace). In practice this is 1 per delegation, but the
  field reflects the actual count for diagnostics.
- Pattern is anchored to line-start (regex `/^\s*spec_sketch:/m`) to avoid false positives
  from prose that mentions the key mid-sentence.
- Same kill-switch and config key as `cite_cache_hit`.
- **Historical names (v2.1.12 and earlier):** `event` / `ts` in place of `type` / `timestamp`
  — normalize via `bin/read-event.js`.

---

### `repo_map_delta_injected`

Emitted by `bin/emit-compression-telemetry.js` (wired as `SubagentStart`) when the
delegation prompt contains a `repo_map_delta:` YAML/fence marker at line-start position.
Confirms that the v2.1.8 RepoMapDelta injection fired on this delegation.

```json
{
  "type": "repo_map_delta_injected",
  "orchestration_id": "<current orch id | null>",
  "timestamp": "<ISO 8601>",
  "subagent_type": "<agent_type from SubagentStart payload | null>",
  "match_count": "<N>"
}
```

Field notes:
- `match_count`: Number of lines in the delegation prompt beginning with `repo_map_delta:`
  (after optional leading whitespace). Typically 1 per delegation.
- Pattern is anchored to line-start (regex `/^\s*repo_map_delta:/m`), same rationale as
  `spec_sketch_generated`.
- Same kill-switch and config key as `cite_cache_hit`.
- **Historical names (v2.1.12 and earlier):** `event` / `ts` in place of `type` / `timestamp`
  — normalize via `bin/read-event.js`.

---

### `dossier_truncated`

Emitted by `bin/inject-resilience-dossier.js` (wired as `UserPromptSubmit` and
`SessionStart`) when the serialised resilience dossier exceeds the 10 000-character
`additionalContext` cap. The dossier is truncated before injection and a truncation
marker is appended so the PM knows to read the full dossier from disk.

```json
{
  "type": "dossier_truncated",
  "orchestration_id": "<current orch id | null>",
  "original_length": "<N>",
  "cap": 10000,
  "mode": "<legacy_fence | native_envelope>"
}
```

Field notes:
- `original_length`: Byte-length of the serialised dossier before truncation. Useful
  for sizing the dossier schema and identifying phases where state explodes.
- `cap`: Always `10000` in v2.1.10 (the `NATIVE_ENVELOPE_MAX_CHARS` constant). Reserved
  for future configurability.
- `mode`: `"native_envelope"` when `hookSpecificOutput.additionalContext` is used (the
  default in v2.1.10); `"legacy_fence"` when `ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1`
  reverts to the prior fenced-markdown output.

---

### `resilience_block_triggered`

Emitted by `bin/pre-compact-archive.js` (wired as `PreCompact`) when the resilience
dossier write fails during an active orchestration and the block-on-write-failure
default is enabled. The hook exits 2 after emitting this event, blocking the compaction.

```json
{
  "type": "resilience_block_triggered",
  "orchestration_id": "<active orch id | unknown>",
  "phase": "<decomposing | executing | reviewing | verifying>",
  "reason": "<human-readable error description>"
}
```

Field notes:
- `phase`: The `current_phase` read from `.orchestray/state/orchestration.md` at hook
  time. Only phases in `{decomposing, executing, reviewing, verifying}` can trigger a
  block; other phases (completed, aborted) or parse failures always exit 0.
- `reason`: The underlying I/O error message from the failed dossier write.
- Kill-switch: `ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1` or
  `resilience.block_on_write_failure: false` in `.orchestray/config.json` — see
  `resilience_block_suppressed`.

---

### `resilience_block_suppressed_inactive`

Emitted by `bin/pre-compact-archive.js` when the dossier write fails but no active
orchestration is detected (phase is completed, aborted, null, or parse failure). The
hook exits 0 after emitting this event.

```json
{
  "type": "resilience_block_suppressed_inactive",
  "phase": "<phase value or null>",
  "reason": "<human-readable error description>"
}
```

Field notes:
- Distinguishes from `resilience_block_suppressed` (kill-switch path) so operators can
  tell whether the non-block was intentional or due to absent orchestration context.

---

### `resilience_block_suppressed`

Emitted by `bin/pre-compact-archive.js` when `ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1`
or `resilience.block_on_write_failure: false` overrides what would otherwise have been
a triggered block during an active orchestration. The hook exits 0.

```json
{
  "type": "resilience_block_suppressed",
  "orchestration_id": "<active orch id | unknown>",
  "phase": "<phase value>",
  "reason": "<human-readable error description>",
  "override": "<env_var | config_flag>"
}
```

Field notes:
- `override`: `"env_var"` when suppressed by `ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1`;
  `"config_flag"` when suppressed by `resilience.block_on_write_failure: false`.

---

### `isolation_omitted_warn`

Emitted by `bin/warn-isolation-omitted.js` (wired as `PreToolUse[Agent]`) when a
write-capable agent (architect, developer, refactorer, tester, security-engineer,
inventor) is spawned without worktree isolation. Advisory only — the spawn is not
blocked (exit 0). Confirms the silent-skip risk identified in v2.1.10 R4.

```json
{
  "type": "isolation_omitted_warn",
  "orchestration_id": "<current orch id | unknown>",
  "timestamp": "<ISO 8601>",
  "agent": "<subagent_type>",
  "reason": "write-capable agent spawned without worktree isolation"
}
```

Field notes:
- `agent`: The `subagent_type` value from the `Agent()` tool call.
- `reason`: Always `"write-capable agent spawned without worktree isolation"` in v2.1.10.
- Kill-switch: `ORCHESTRAY_ISOLATION_WARN_DISABLED=1` or
  `worktree_isolation.warn_on_omission: false` in `.orchestray/config.json`.
- As of v2.1.10, the six write-capable agents carry `isolation: worktree` in frontmatter,
  so this event should not fire on standard orchestrations. It fires for custom/dynamic
  agents that omit the field, or on Claude Code versions that do not apply frontmatter
  isolation.
- **Historical names (v2.1.12 and earlier):** `event` / `ts` in place of `type` / `timestamp`
  — normalize via `bin/read-event.js`.

---

## v2.1.11 additions

### `model_auto_resolved` event (R-DX1)

Emitted by `bin/gate-agent-spawn.js` whenever an `Agent()` call omits the `model` parameter
and the gate auto-resolves it instead of blocking. Level is always `warn` so it is
visible in the post-orchestration rollup without hard-blocking the spawn.

```jsonc
{
  "type":                    "model_auto_resolved",
  "orchestration_id":        "orch-1234567890",
  "timestamp":               "2026-04-24T12:00:00.000Z",
  "level":                   "warn",
  "resolved_model":          "sonnet",
  "source":                  "routing_lookup",
  "subagent_type":           "developer",
  "task_hint":               "DEV-1 implement feature X",
  "routing_entry_timestamp": "2026-04-24T11:58:00.000Z"
}
```

Field notes:
- `source` values:
  - `routing_lookup` — resolved from `.orchestray/state/routing.jsonl` using the task_id + agent_type match.
  - `frontmatter_default` — resolved from the `default_model:` field in `agents/<subagent_type>.md` frontmatter.
  - `global_default_sonnet` — no routing hint and no frontmatter default; `sonnet` applied unconditionally.
- `routing_entry_timestamp` — present only when `source=routing_lookup`; records the original routing decision timestamp for forensic use (W6 T09/Info #2).
- Kill-switch: `ORCHESTRAY_STRICT_MODEL_REQUIRED=1` disables auto-resolve and restores the v2.1.10 hard-block.
- These events appear in the `model_auto_resolved_warnings` field of the orchestration rollup row as human-readable lines.
- **Historical names (v2.1.12 and earlier):** `event` / `ts` in place of `type` / `timestamp`.
  See §"Field naming — historical and unified (v2.1.13)" below. Consumers should normalize
  every row through `bin/read-event.js :: normalizeEvent` before reading fields.

---

## v2.1.12 additions

### `tier2_load` event (R-TEL)

Emitted by `bin/emit-tier2-load.js` (PostToolUse:Read hook) whenever a Read tool call
targets a Tier-2 file under `agents/pm-reference/`. Provides the measurement signal
needed to verify R1/R2/R3 cost-saving effectiveness by counting how often each
conditional file is actually loaded.

**Tier-2 allowlist:** all files under `agents/pm-reference/` EXCLUDING the always-loaded
set: `tier1-orchestration.md`, `scoring-rubrics.md`, `specialist-protocol.md`,
`delegation-templates.md`.

Emitted to `.orchestray/audit/events.jsonl`. Fail-open: any write failure is silently
swallowed and the Read tool call is never blocked (exit 0 always).

```json
{
  "timestamp": "<ISO 8601>",
  "type": "tier2_load",
  "orchestration_id": "<current orch id, or 'unknown' if no orchestration active>",
  "task_id": "<subtask id, optional — present only when hook payload carries one>",
  "file_path": "<basename of the loaded pm-reference file, e.g. 'event-schemas.md'>",
  "agent_role": "<agent_type from hook payload, or null>",
  "source": "hook"
}
```

Field notes:
- `type`: Always `"tier2_load"`.
- `orchestration_id`: Read from `.orchestray/audit/current-orchestration.json` at hook
  time. `"unknown"` when the file is absent or unreadable (e.g., Read called outside an
  active orchestration, or before orchestration initialization).
- `task_id`: Optional. Only present when `event.task_id` is populated in the hook
  payload. The PM's Read calls may happen between tasks (task_id not yet assigned).
- `file_path`: Basename only (e.g., `"event-schemas.md"`) — the full path is not needed
  for measurement, and stripping it keeps the event compact.
- `agent_role`: The `agent_type` field from the hook payload, or `null` when absent.
- `source`: Always `"hook"` — emitted by `bin/emit-tier2-load.js`, never by the PM.

**Consumer guidance:** aggregate `tier2_load` events by `file_path` over an orchestration
to measure Tier-2 dispatch frequency. A count of 0 for `tier1-orchestration-rare.md`
on a common-path orchestration retroactively verifies R2 AC-03. The post-orchestration
rollup (`bin/emit-orchestration-rollup.js`) summarises counts-by-file as a human-readable
section.

**Schema stability:** additive only. Consumers that do not recognise this event type
should ignore it. New fields will only be added as optional.

---

## Field naming — historical and unified (v2.1.13)

**Context.** `.orchestray/audit/events.jsonl` has always had two-way drift on two
fields: a handful of emitters wrote `event` + `ts`, while the canonical writers
(`bin/_lib/audit-event-writer.js`, `bin/_lib/kill-switch-event.js`, the `ox events
append` CLI) wrote `type` + `timestamp`. Same semantics, different keys. v2.1.13
R-EVENT-NAMING unifies emission on `type` + `timestamp` going forward and
establishes a back-compat read path so v2.1.12-and-earlier `events.jsonl` files
continue to read cleanly.

**Scope of the rename.** ONLY fields in `.orchestray/audit/events.jsonl`.
`.orchestray/state/routing.jsonl` documents `ts` as canonical there and is
**excluded** from this rename — different file, different historical schema.

**Unified mapping (historical → canonical).**

| Historical | Canonical | Notes |
|---|---|---|
| `event` | `type` | Event-type identifier |
| `ts` | `timestamp` | ISO 8601 UTC |

Both names remain accepted by readers. New emit sites MUST use the canonical
names. Source of truth: `bin/event-field-migration-map.js` (`OLD_TO_NEW`,
`NEW_TO_OLD`).

**Consumer contract.** Every consumer of `.orchestray/audit/events.jsonl` must
normalise through `bin/read-event.js :: normalizeEvent(obj)` before dereferencing
fields. `normalizeEvent` is idempotent: passing an already-canonical event is a
no-op.

**Back-compat guarantee.** Existing `.jsonl` files on disk are **not rewritten**.
The read path handles legacy fields; the write path emits canonical fields. A
v2.1.13 installation reading a v2.1.12 audit log produces well-formed events.

**Drift prevention.** `tests/unit/event-field-migration.test.js` includes a grep
lint that fails the test suite if any new emission site introduces a rogue field
name. Expected keys are pinned against the migration map; any name that is
neither canonical nor legacy is a drift candidate.

---

## v2.1.13 additions

### project_intent_fallback_no_agent

Emitted when the PM dispatches to the `project-intent` agent at Step 2.7a but
the agent is unavailable (agent file missing from the session's registry,
spawn throws, or returns an invalid block). The PM falls back to the in-process
mechanical generator in `bin/_lib/project-intent.js`, preserving v2.1.12 inline
behaviour, and emits this event so operators can see the degraded state.

Canonical payload:

```json
{
  "type": "project_intent_fallback_no_agent",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or null if no active orchestration>",
  "reason": "<agent_file_missing|spawn_error|restart_required|other>",
  "detail": { "...": "caller-supplied context, optional" },
  "source": "pm-step-2.7a"
}
```

Field notes:
- `type`: Always `"project_intent_fallback_no_agent"`.
- `reason`: One of the four documented values above, or any caller-supplied
  string. Consumers that don't recognise a reason should treat it as "other".
- `detail`: Optional free-form object; reserved for caller-supplied diagnostic
  context (stack, file path, retry count). Do not rely on any specific shape.
- `source`: Always `"pm-step-2.7a"` — emitted by `bin/_lib/project-intent-fallback-event.js`.

Schema stability: additive-only. New reason values may appear in future releases;
consumers should fail open on unknown reasons.

Correlated user signal: `post-upgrade-sweep.js` names `project-intent-agent` in
the restart reminder (v2.1.13 R-RCPT-V2 + F-M-2), so users who see this event
fire while the upgrade sentinel is present are on the documented restart-required
path.

---

## v2.1.14 additions (R-TGATE)

### `tier2_invoked` event

Emitted by `bin/_lib/tier2-invoked-emitter.js` (called from protocol entry-point
scripts) when a Tier-2 feature protocol fires its primary action. Provides signal
to distinguish file-loaded (`tier2_load`) from actually-executed (this event) — a
protocol may be loaded but silently skip if its conditions are not met.

Wired protocols (hook-script entry points): `archetype_cache`, `pattern_extraction`.
Protocols without entry-point scripts (PM-prompt only, not wired in v2.1.14):
`drift_sentinel`, `consequence_forecast`, `replay_analysis`, `auto_documenter`,
`disagreement_protocol`, `cognitive_backpressure` — these require a PM-prompt edit
to emit this event (finding for reviewer: PM Section additions needed for these 6).

Kill switches: `ORCHESTRAY_METRICS_DISABLED=1`, `ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1`,
or `config.telemetry.tier2_tracking.enabled: false`.

```json
{
  "version": 1,
  "type": "tier2_invoked",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "protocol": "<slug: archetype_cache | pattern_extraction | drift_sentinel | ...>",
  "trigger_signal": "<free-text reason the protocol fired>"
}
```

Field notes:
- `version`: Always `1`. Bump on breaking schema changes.
- `protocol`: One of the 8 slugs listed in the release plan. Unknown slugs are accepted
  (fail-open) so future protocol additions don't break existing emitters.
- `trigger_signal`: Human-readable reason string. Not parsed by consumers — informational only.

**Consumer guidance:** join `tier2_invoked` with `tier2_load` on `(orchestration_id, protocol/file_path)`
to measure conversion rate from loaded → actually executed. A file that loads frequently
but never invokes may indicate a misconfigured gate condition.

Schema stability: additive-only.

---

### `feature_gate_eval` event

Emitted by `bin/gate-telemetry.js` (UserPromptSubmit hook) on every PM turn. Records
which feature gates are currently enabled or disabled in `.orchestray/config.json`.
Provides signal for correlating feature-gate state with orchestration outcomes.

Kill switches: `ORCHESTRAY_METRICS_DISABLED=1`, `ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1`,
or `config.telemetry.tier2_tracking.enabled: false`.

```json
{
  "version": 1,
  "type": "feature_gate_eval",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "gates_true": ["enable_drift_sentinel", "auto_review"],
  "gates_false": ["enable_consequence_forecast", "enable_replay_analysis"],
  "eval_source": "config_snapshot"
}
```

Field notes:
- `version`: Always `1`.
- `gates_true`: Sorted array of gate key names whose value is truthy in config.
- `gates_false`: Sorted array of gate key names whose value is falsy or absent.
- `eval_source`: Always `"config_snapshot"` in v2.1.14. Reserved for future eval sources
  (e.g., runtime override, env-var override).

Known gate keys evaluated (as of v2.1.14):
`enable_drift_sentinel`, `enable_consequence_forecast`, `enable_replay_analysis`,
`enable_disagreement_protocol`, `enable_personas`, `enable_introspection`,
`enable_backpressure`, `enable_outcome_tracking`, `enable_repo_map`,
`enable_visual_review`, `enable_threads`, `enable_agent_teams`, `auto_review`,
`auto_document`, plus any other top-level config key starting with `enable_`.

**Consumer guidance:** aggregate `feature_gate_eval` events by `orchestration_id` to
build a per-orchestration feature-gate histogram. The truthy histogram rollup is
surfaced in `/orchestray:analytics`.

Schema stability: additive-only. New gate keys may appear in `gates_true`/`gates_false`
as features are added; consumers should not assume a fixed key set.

---

### `mcp_checkpoint_recorded` — `fields_used` + `response_bytes` field additions (v2.1.14)

`mcp_checkpoint_recorded` events (emitted by `bin/record-mcp-checkpoint.js`,
PostToolUse hook) now carry two additional fields:

```json
{
  "type": "mcp_checkpoint_recorded",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "tool": "<tool name>",
  "outcome": "answered | error | skipped",
  "phase": "pre-decomposition | post-decomposition",
  "result_count": null,
  "fields_used": true,
  "response_bytes": 1234,
  "source": "hook"
}
```

New fields:
- `fields_used` (bool): `true` when the caller passed a non-empty `fields` parameter
  to the tool (enabling field projection / cost reduction). `false` when absent or empty.
  Allows measuring field-projection compliance across all MCP tool calls.
- `response_bytes` (int): byte length of the raw `tool_response` string. Never logs
  content — only the size. Useful for detecting unexpectedly large responses that may
  indicate pagination issues or oversized patterns.

Scope note: W2 (R-PFX) adds these fields for `pattern_find` and `kb_search`; R-TGATE
adds them for `history_find_similar_tasks` and `pattern_record_application` (all
remaining ENFORCED_TOOLS). Both fields are present on every `mcp_checkpoint_recorded`
row from v2.1.14 onward. Pre-v2.1.14 rows omit both fields; consumers must handle
absent fields gracefully.

Schema stability: additive-only. No existing field is removed or renamed.

---

## v2.1.14 additions (R-HCAP)

### `handoff_body_warn` event

Emitted by the T15 hook (`bin/validate-task-completion.js`) when an artifact body
exceeds the warn threshold (default 2,500 tokens) OR when the block threshold
would have fired but `hard_block` is `false` (v2.1.14 soft-warn-only mode).
Hook exits 0 in all cases — this event is advisory.

Schema version: 1

```json
{
  "version": 1,
  "type": "handoff_body_warn",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "task_id": "<task id or null>",
  "file": "<relative path to the artifact file>",
  "body_tokens": "<estimated token count (4-bytes-per-token heuristic)>",
  "has_detail_artifact": "<boolean — true if detail_artifact is set in the Structured Result>",
  "threshold_breached": "<'warn' | 'block_would_have_fired'>"
}
```

Field notes:
- `threshold_breached`: `"warn"` — body is between warn_tokens and block_tokens,
  OR body exceeds block_tokens but detail_artifact is present.
  `"block_would_have_fired"` — body exceeds block_tokens, no detail_artifact, but
  `hard_block` is `false` (v2.1.14 default). This is the telemetry trail for the
  v2.1.15 flip to hard-block.
- `has_detail_artifact`: `true` means the Structured Result already carries a
  `detail_artifact` pointer. This may explain why the body is large — the pointer
  is set but the inline content was not trimmed.
- `file`: the specific artifact file whose content triggered the threshold.
- `body_tokens`: estimated using the 4-bytes-per-token heuristic from W2
  internal-token-profile conventions.

---

### `handoff_body_block` event

Emitted by the T15 hook when an artifact body exceeds the block threshold (default
5,000 tokens), no `detail_artifact` pointer is set, AND `hard_block` is `true`.
Hook exits 2 (blocks completion). Only emitted when `handoff_body_cap.hard_block:
true` (default `false` in v2.1.14; default `true` from v2.1.15).

Schema version: 1

```json
{
  "version": 1,
  "type": "handoff_body_block",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "task_id": "<task id or null>",
  "file": "<relative path to the artifact file>",
  "body_tokens": "<estimated token count>",
  "has_detail_artifact": false,
  "threshold_breached": "block"
}
```

Field notes:
- `has_detail_artifact` is always `false` for this event — if `detail_artifact`
  were present, the hook would emit `handoff_body_warn` instead.
- `threshold_breached` is always `"block"`.
- The agent MUST split overflow content into a separate file and cite it via
  `detail_artifact` in the Structured Result to resolve the block.
- See `agents/pm-reference/handoff-contract.md §10` for full remediation guidance.

---

## v2.1.14 additions (R-SHDW)

### `schema_shadow_hit` event

Emitted when the PM consults the event-schema shadow and finds the event type.
Indicates the shadow served its purpose and a full `event-schemas.md` load was
avoided for this event type.

Schema version: 1

```json
{
  "version": 1,
  "type": "schema_shadow_hit",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "event_type": "<the event type slug that was found in the shadow>"
}
```

Field notes:
- `event_type`: The slug of the event type that was found in the shadow index.
- Source: emitted by the PM agent when it confirms an event type via the shadow.

---

### `schema_shadow_miss` event

Emitted when the PM consults the event-schema shadow and does NOT find the event
type — falling through to load the full `event-schemas.md`. Triggers a miss
counter increment; 3 misses in 24 hours auto-disables the shadow.

Schema version: 1

```json
{
  "version": 1,
  "type": "schema_shadow_miss",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "event_type": "<the event type slug that was NOT found in the shadow>",
  "source_hash": "<sha256 of event-schemas.md at miss time>"
}
```

Field notes:
- `event_type`: The slug that caused the miss.
- `source_hash`: Current hash of event-schemas.md — matches `_meta.source_hash`
  in the shadow if the shadow is up to date.
- Source: emitted by `bin/_lib/load-schema-shadow.js` recordMiss() on miss.

---

### `schema_shadow_validation_block` event

Emitted by `bin/validate-schema-emit.js` (PreToolUse validator / pre-write check)
when an audit event payload fails schema validation and is blocked before reaching
`events.jsonl`. This is the correctness-gate firing.

Schema version: 1

```json
{
  "version": 1,
  "type": "schema_shadow_validation_block",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "blocked_event_type": "<the event type slug that was blocked>",
  "errors": ["<validation error message 1>", "..."],
  "schema_ref": "agents/pm-reference/event-schemas.md"
}
```

Field notes:
- `blocked_event_type`: The `type` field of the event that was blocked.
- `errors`: Array of human-readable validation error messages naming the missing
  or wrong fields and the schema doc reference.
- `schema_ref`: Always `"agents/pm-reference/event-schemas.md"`.
- Source: emitted by `bin/validate-schema-emit.js`.

---

### `schema_shadow_stale` event

Emitted by `bin/inject-schema-shadow.js` when the shadow's `_meta.source_hash`
does not match the current SHA-256 of `event-schemas.md`. Indicates the shadow
needs regeneration (`node bin/regen-schema-shadow.js`). Shadow injection is
skipped; the PM falls back to loading the full schema file.

Schema version: 1

```json
{
  "version": 1,
  "type": "schema_shadow_stale",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "source_hash_stored": "<sha256 stored in shadow _meta.source_hash>"
}
```

Field notes:
- `source_hash_stored`: The hash that was in the shadow when the mismatch was
  detected. Compare to the current file hash to confirm staleness.
- Source: emitted by `bin/inject-schema-shadow.js` on hash-mismatch detection.
- Auto-resolution: edit `agents/pm-reference/event-schemas.md` (PostToolUse
  hook auto-regenerates), or run `node bin/regen-schema-shadow.js` manually.

---

### `block_a_zone_composed` event

Emitted by `bin/compose-block-a.js` (UserPromptSubmit hook) when Block A zones
are successfully assembled and injected into PM context.

Schema version: 1

```json
{
  "version": 1,
  "type": "block_a_zone_composed",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "turn_number": null,
  "zone1_hash": "<sha256 prefix of Zone 1 content>",
  "zone2_hash": "<sha256 prefix of Zone 2 content or 'empty'>",
  "zone3_bytes": 42,
  "cache_breakpoints": 4,
  "block_z_hash": "<sha256 hex of assembled Block-Z body, or null>",
  "manifest_slot_count": 4
}
```

Field notes:
- `turn_number`: Reserved for future use; always null in v1.
- `zone1_hash`: SHA-256 hash of Zone 1 assembled content (full hex string).
  Compare successive events to verify Zone 1 byte-stability within a session.
- `zone2_hash`: SHA-256 hash of Zone 2 content, or `"empty"` if no active
  orchestration.
- `zone3_bytes`: Byte length of Zone 3 content (mutable, uncached).
- `cache_breakpoints`: Number of cache breakpoints emitted on this turn.
  `4` when both Block-Z and the engineered-breakpoints manifest are enabled
  and healthy (v2.2.0 default); `3` on fallback (Zone 1, Zone 2, tools
  array — v2.1.x layout, e.g. when `caching.block_z.enabled: false` or
  `caching.engineered_breakpoints.enabled: false`, or when either input
  failed to assemble).
- `block_z_hash` (v2.2.0+): SHA-256 hex of the assembled Block-Z body
  (the four Tier-0 component files joined with header markers). `null`
  when Block-Z is disabled, when any component is `missing_input`, or
  when `caching.block_z.enabled: false`.
- `manifest_slot_count` (v2.2.0+): Number of slots in the
  cache-breakpoint manifest. `4` when the engineered-breakpoints feature
  is enabled and the manifest computed cleanly; `0` when the feature is
  disabled, when the manifest helper rejected the offset layout, or
  when Block-Z assembly failed.
- Source: emitted by `bin/compose-block-a.js`.

---

### `cache_invariant_broken` event

Emitted by `bin/validate-cache-invariant.js` (PreToolUse hook) when an
invariant for the cached prefix is violated. Two emission modes share this
event type:

1. **Zone 1 mode (`zone: "zone1"`):** the recomputed Zone 1 hash differs
   from the stored hash in `.orchestray/state/block-a-zones.json`.
   Indicates an unintended Zone 1 mutation occurred (e.g., CLAUDE.md was
   edited without calling `bin/invalidate-block-a-zone1.js`).
2. **Manifest mode (`zone: "manifest"`, v2.2.0+):** the 4-slot
   cache-breakpoint manifest computed by
   `bin/_lib/cache-breakpoint-manifest.js` failed an invariant check. The
   `reason` field carries the specific failure code; `expected_hash` /
   `actual_hash` are reused to carry diagnostic strings (`"manifest"` and
   the reason code respectively). Always advisory in v2.2.0 even when
   `caching.engineered_breakpoints.strict_invariant: true` — strict mode
   is reserved for v2.2.1 after observation.

This event is advisory. The tool call is never blocked.

Schema version: 1

Zone 1 example:

```json
{
  "version": 1,
  "type": "cache_invariant_broken",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "zone": "zone1",
  "expected_hash": "<12-char prefix of stored hash>",
  "actual_hash": "<12-char prefix of recomputed hash>",
  "delta_files": ["CLAUDE.md", "agents/pm-reference/handoff-contract.md"]
}
```

Manifest example (v2.2.0+):

```json
{
  "version": 1,
  "type": "cache_invariant_broken",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "zone": "manifest",
  "expected_hash": "manifest",
  "actual_hash": "non_monotonic_offsets",
  "reason": "non_monotonic_offsets",
  "delta_files": []
}
```

Field notes:
- `zone`: One of `"zone1"` (Zone 1 hash mismatch) or `"manifest"`
  (cache-breakpoint manifest invariant failure, v2.2.0+). Zone 2 and
  Zone 3 are not invariant-checked.
- `expected_hash`: First 12 hex characters of the hash stored at last
  compose (Zone 1 mode); literal string `"manifest"` (manifest mode).
- `actual_hash`: First 12 hex characters of the freshly recomputed hash
  (Zone 1 mode); the manifest reason code (manifest mode).
- `reason` (manifest mode only): one of
  `slot_count_mismatch | non_monotonic_offsets | invalid_ttl |
  invalid_hash | manifest_missing`. Absent for Zone 1 emissions.
  `manifest_missing` is always advisory regardless of strict mode (a
  legitimate first-turn-after-fresh-install state).
- `delta_files`: Array of source file paths that were hashed in Zone 1 (used
  to narrow down which file changed). Empty array in manifest mode.
- Source: emitted by `bin/validate-cache-invariant.js`.
- Recovery (Zone 1): run `node bin/invalidate-block-a-zone1.js [reason]`
  to mint a fresh Zone 1 breakpoint.
- Recovery (manifest): the manifest is regenerated automatically on the
  next `compose-block-a.js` run; if the failure persists, set
  `caching.engineered_breakpoints.enabled: false` to fall back to the
  3-breakpoint v2.1.x layout.

---

### `cache_manifest_bootstrap` event

Emitted by `bin/validate-cache-invariant.js` (PreToolUse hook, v2.2.2)
on the first UserPromptSubmit after a fresh install when the
cache-breakpoint manifest does not yet exist. This is a cold-start
bootstrap state — `bin/compose-block-a.js` is the sole writer of
`.orchestray/state/cache-breakpoint-manifest.json` and runs in the
SAME UserPromptSubmit batch (slot AFTER this validator, see
`hooks/hooks.json`). The manifest will exist by the end of the batch.

Distinct from `cache_invariant_broken{reason: "manifest_missing"}` so
the rollup can separate "fresh install bootstrap" (informational, this
event) from "manifest disappeared mid-orchestration" (anomaly,
`cache_invariant_broken`). Always advisory — never blocks the tool
call. Replaces what would have been a spurious
`cache_invariant_broken` row on every fresh install.

Schema version: 1

```json
{
  "version": 1,
  "type": "cache_manifest_bootstrap",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "slot_count_expected": 4,
  "note": "compose-block-a will seed manifest in same UserPromptSubmit batch"
}
```

Field notes:
- `slot_count_expected`: the number of slots `bin/compose-block-a.js`
  will populate in the manifest on this same UserPromptSubmit batch.
  Always `4` in v2.2.2 (the engineered-breakpoints layout).
- `note`: human-readable reminder of where the manifest comes from.
  Useful in dashboards to clarify why no remediation action is needed.
- Source: emitted by `bin/validate-cache-invariant.js`.
- Recovery: none required. The next `compose-block-a.js` run (same
  UserPromptSubmit batch) will write the manifest.

Backward compatibility: new event type in v2.2.2; older consumers
ignore unknown types per R-EVENT-NAMING. Schema stability:
additive-only.

---

### `block_a_zone1_invalidated` event

Emitted by `bin/invalidate-block-a-zone1.js` when a Zone 1 hash is manually
cleared. The next `compose-block-a.js` run will recompute and store a fresh
hash with the current source content.

Schema version: 1

```json
{
  "version": 1,
  "type": "block_a_zone1_invalidated",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id or 'unknown'>",
  "reason": "<user-supplied reason string>",
  "prior_hash": "<12-char prefix of the cleared hash>",
  "sentinel_cleared": false,
  "block_z_invalidated": false,
  "block_z_components_changed": []
}
```

Field notes:
- `reason`: The reason argument passed to the CLI (default `"manual invalidation"`).
- `prior_hash`: First 12 hex characters of the hash that was cleared.
- `sentinel_cleared`: `true` if the auto-disable sentinel was also removed,
  re-enabling zone caching.
- `block_z_invalidated` (v2.2.0+): `true` when `--watch-pm-md` was passed
  and one of the four Block-Z components (`agents/pm.md`, `CLAUDE.md`,
  `agents/pm-reference/handoff-contract.md`,
  `agents/pm-reference/phase-contract.md`) drifted relative to the prior
  composed hash; `false` otherwise. Always `false` when invoked without
  `--watch-pm-md`.
- `block_z_components_changed` (v2.2.0+): Array of changed Block-Z
  component names (e.g. `["agents/pm.md"]`) when `block_z_invalidated`
  is `true`; empty array otherwise.
- Source: emitted by `bin/invalidate-block-a-zone1.js`.

---

## v2.1.14 additions (R-GATE)

### `feature_quarantine_candidate` event

Emitted by `bin/feature-quarantine-advisor.js` (UserPromptSubmit hook, shadow mode)
when a gate is computed to be quarantine-eligible (eval_true_count >= 5, invoked_count == 0,
observation window >= 14 days). Shadow mode: no gate action is taken.

Rate-limited to one emission per gate per 24 hours via
`.orchestray/state/feature-quarantine-advisor-cursor.json`.

```json
{
  "version": 1,
  "type": "feature_quarantine_candidate",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "gate_slug": "<gate slug, e.g. pattern_extraction>",
  "eval_true_count_30d": 8,
  "invoked_count_30d": 0,
  "first_eval_at": "<ISO 8601 timestamp of first gate_eval_true, or null>",
  "eligibility_reason": "<human-readable eligibility summary>"
}
```

Field notes:
- `version`: Always `1`.
- `gate_slug`: Gate identity (e.g., `pattern_extraction`, `archetype_cache`).
  Only wired-emitter gates are eligible in v2.1.14.
- `eval_true_count_30d`: Count of `feature_gate_eval` events where this gate appeared
  in `gates_true` in the last 30 days.
- `invoked_count_30d`: Count of `tier2_invoked` events for this gate's protocol in the
  last 30 days.
- `first_eval_at`: ISO timestamp of the earliest qualifying `feature_gate_eval` event
  in the 30-day window.
- `eligibility_reason`: Free-text description of why this gate is eligible.

Schema stability: additive-only.

Kill switches: `ORCHESTRAY_DISABLE_DEMAND_GATE=1`, `config.feature_demand_gate.enabled: false`.

---

### `feature_quarantine_active` event

Emitted when an opt-in or auto quarantine takes effect for a gate. In v2.1.14, this is
emitted when gate-telemetry.js applies a quarantine overlay (gate in quarantine_candidates).

```json
{
  "version": 1,
  "type": "feature_quarantine_active",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "gate_slug": "<gate slug>",
  "mode": "opt_in",
  "released_until": null
}
```

Field notes:
- `version`: Always `1`.
- `gate_slug`: The gate that is quarantined.
- `mode`: `"opt_in"` (user-specified via quarantine_candidates) or `"auto_window"`
  (future: after 14-day observation window elapses automatically).
- `released_until`: ISO timestamp until which the quarantine is lifted (by a pinned wake),
  or `null` if no expiry (session wake or permanent opt-in).

Schema stability: additive-only.

---

### `feature_wake` event

Emitted by `bin/feature-wake.js` (invoked by `/orchestray:feature wake`) when a user
manually wakes a quarantined gate.

```json
{
  "version": 1,
  "type": "feature_wake",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "gate_slug": "<gate slug>",
  "scope": "session",
  "caller": "cli"
}
```

Field notes:
- `version`: Always `1`.
- `gate_slug`: The gate being woken.
- `scope`: `"session"` (wake lasts for this session only) or `"30d_pinned"` (wake
  persists across sessions for 30 days, stored in feature-wake-pinned.json).
- `caller`: `"cli"` (from `/orchestray:feature wake`) or `"auto_release"` (future,
  from auto-release on issues[]).

Schema stability: additive-only.

---

### `feature_wake_auto` event

Emitted by `bin/feature-auto-release.js` (PostToolUse hook) when a structured result's
`issues[]` array contains text matching a quarantined feature's namespace, triggering
automatic session-scoped wake.

```json
{
  "version": 1,
  "type": "feature_wake_auto",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "gate_slug": "<gate slug>",
  "match_text": "<the issues[] entry text that matched>"
}
```

Field notes:
- `version`: Always `1`.
- `gate_slug`: The gate that was auto-woken.
- `match_text`: The full text of the issues[] entry that triggered the match. Not parsed
  further — informational only.

Schema stability: additive-only.

Kill switches: `ORCHESTRAY_DISABLE_DEMAND_GATE=1`, `config.feature_demand_gate.enabled: false`.

---

### `feature_demand_gate_migrated` event

Emitted once per repo by `bin/session-feature-gate.js` on the first session under
v2.1.15 when an explicit `feature_demand_gate.shadow_mode: true` setting (the
v2.1.14 opt-out) is overridden by the locked-Q1 aggressive default-on migration.
Records the override for the audit trail. Idempotent via the
`.orchestray/state/.r-gate-auto-migration-2115` sentinel.

```json
{
  "version": 1,
  "type": "feature_demand_gate_migrated",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "previous_value": true,
  "new_value": false,
  "reason": "v2.1.15 R-GATE-AUTO aggressive default-on migration"
}
```

Field notes:
- `version`: Always `1`.
- `previous_value`: Always `true` (the explicit opt-out being overridden). Other
  values cannot trigger this event.
- `new_value`: Always `false` (the v2.1.15 default).
- `reason`: Free-form provenance string.

Schema stability: additive-only.

Kill switches: `feature_demand_gate.shadow_mode: true` re-set after migration
(per the migration banner) reverts the aggressive flip.

---

## v2.1.15 additions (R-DELTA-HANDOFF)

### `delta_handoff_fallback` event

Emitted by the developer agent (or the PM on behalf of the developer prompt rule) when
a re-delegation uses a delta payload and the agent must decide whether to fetch the full
artifact. Emitted once per re-delegation regardless of fetch outcome.

Three deterministic fetch triggers (P-DELTA-FALLBACK, W4 Gap 2):
- `issue_gap` — `reviewer_issues[]` empty and planned file not named in summary.
- `hedged_summary` — summary contains hedge phrases ("see details", "additional context",
  "depends on", "may need", "recommend reviewing").
- `cross_orch_scope` — planned Edit/Write targets a file whose `git log -1` predates
  the orchestration start.

Kill switch: `config.delta_handoff.force_full: true` forces `fetched: true` with
`reason: "force_config"` regardless of trigger evaluation.

```json
{
  "event_type": "delta_handoff_fallback",
  "version": 1,
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "task_id": "<subtask id, or 'unknown'>",
  "agent_type": "developer",
  "fetched": true,
  "reason": "<issue_gap | hedged_summary | cross_orch_scope | force_config | null>",
  "summary_chars": 340,
  "detail_artifact": "<kb path to full reviewer artifact>"
}
```

Field notes:
- `version`: Always `1`.
- `fetched`: `true` if the developer fetched the full artifact; `false` if delta was sufficient.
- `reason`: The trigger that caused the fetch, or `null` when `fetched` is `false`.
  `force_config` means `config.delta_handoff.force_full` was `true`.
- `summary_chars`: Character length of the reviewer summary — used to track summary
  verbosity over time.
- `detail_artifact`: KB path the developer used (or would use) to fetch the full artifact.

Target fetch rate: 10–30%. Aggregate via `bin/collect-context-telemetry.js`.

---

## v2.1.15 additions (R-BUDGET)

### `budget_warn` event

Emitted by `bin/preflight-spawn-budget.js` (PreToolUse:Agent hook) when a role's
computed context size (system + tier-2 + handoff) exceeds its configured budget.
Emitted on WARN and BLOCK outcomes; not emitted when the check is disabled or
the spawn is within budget.

Enforcement default: **soft (warn-only)**. Hard-block requires
`config.budget_enforcement.hard_block: true`.

Kill switch: `config.budget_enforcement.enabled: false` disables all checks
(hook exits 0 silently).

Initial budgets ship as conservative defaults recorded as
`source: "fallback_model_tier_thin_telemetry"` (W5 F-03: no p50 derivation
when telemetry window < 14 days or N < 30 samples). Run
`node bin/calibrate-role-budgets.js --window-days 14` after 14 days of data to
generate recommended `1.2× p95` updates (v2.1.16 actor; does not auto-run).

```json
{
  "event_type": "budget_warn",
  "version": 1,
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown'>",
  "agent_role": "developer",
  "computed_size": 72000,
  "budget": 60000,
  "source": "fallback_model_tier_thin_telemetry",
  "overage_tokens": 12000,
  "overage_pct": 20,
  "hard_block": false,
  "components": {
    "system_prompt": 30000,
    "tier2_injected": 20000,
    "handoff_payload": 22000
  }
}
```

Field notes:
- `version`: Always `1`.
- `agent_role`: The role being spawned (e.g. `"developer"`, `"reviewer"`).
- `computed_size`: Total tokens being sent to the agent (sum of components).
- `budget`: The `budget_tokens` value from `config.role_budgets[role]`.
- `source`: Source tag for the budget value (e.g. `"fallback_model_tier_thin_telemetry"`).
- `overage_tokens`: `computed_size - budget`. Always positive when this event fires.
- `overage_pct`: `round((overage_tokens / budget) * 100)`.
- `hard_block`: `true` when `config.budget_enforcement.hard_block` is set and this
  event causes the spawn to be denied (exit 2); `false` in soft-warn mode.
- `components`: Breakdown of where the tokens come from — useful for identifying
  the largest contributor to trim (system prompt vs. tier-2 injections vs. handoff).

On receiving this event: trim `tier2_injected` by loading fewer `pm-reference/`
files, or split the task into smaller subtasks to reduce `handoff_payload`.

Schema stability: additive-only.


---

### `phase_slice_fallback` event (v2.1.15 W8 I-PHASE-GATE)

Emitted by `bin/inject-active-phase-slice.js` when the runtime hook cannot
stage a phase slice for the current PM turn. This is a degraded path —
when fired, the PM falls back to contract-only context (no slice). The
event is informational; it never blocks the turn.

```json
{
  "version": 1,
  "type": "phase_slice_fallback",
  "ts": "2026-04-25T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "reason": "no_active_orchestration"
}
```

`reason` field values:

- `no_active_orchestration` — `.orchestray/state/orchestration.md` missing or
  has no `current_phase` field. Common at session start.
- `unrecognized_phase` — `current_phase` is set but does not map to any of the
  five phase slices (decomp / execute / verify / close). May indicate a
  mis-spelled phase value.
- `slice_file_missing:<filename>` — the resolved slice file is not present on
  disk (e.g. someone deleted `phase-execute.md`). Investigate the install.

The hook returns `{continue: true}` regardless. Operators monitoring this
event regularly indicate a slice mis-mapping needing investigation.

Schema stability: additive-only.


---

### `phase_slice_injected` event (v2.1.16 W9 R-PHASE-INJ)

Emitted by `bin/inject-active-phase-slice.js` on the **positive path** —
whenever it successfully stages a phase slice and writes the pointer into
the PM's `additionalContext`. Pairs with `phase_slice_fallback` so the
`injected / (injected + fallback)` ratio empirically validates the v2.1.15
I-PHASE-GATE ~21K-tokens-per-turn savings claim.

```json
{
  "version": 1,
  "type": "phase_slice_injected",
  "timestamp": "2026-04-25T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "phase": "execute",
  "slice_path": "agents/pm-reference/phase-execute.md",
  "pointer_bytes": 142
}
```

Field meanings:

- `phase`: the resolved phase value driving slice selection. One of
  `decomp`, `execute`, `verify`, `close`, or `contract`. The first four
  match the slice files; `contract` is reserved for future contract-only
  emissions if the dispatch table ever stages `phase-contract.md` directly.
- `slice_path`: repository-relative path of the slice file referenced by
  the pointer (e.g. `agents/pm-reference/phase-execute.md`). Source of
  truth for which slice the PM saw on this turn.
- `pointer_bytes`: byte length of the `additionalContext` string written
  to Claude Code. Useful for tracking the staged-pointer footprint over
  time (the design budgets it well under the 10K char cap).
- `orchestration_id`: auto-filled by the audit-event gateway when absent.
- `timestamp`: ISO 8601, auto-filled by the audit-event gateway.

Read-only telemetry — never blocks the hook. Gated by
`phase_slice_loading.telemetry_enabled` (defaults `true`); the env kill
switch `ORCHESTRAY_DISABLE_PHASE_INJECT_TELEMETRY=1` also disables
emission. The kill switches gate ONLY this positive-path event; the
sad-path `phase_slice_fallback` always emits because it is a fault signal.

Consumed by the `/orchestray:analytics` rollup (Phase Slice Loading
section) which displays the injected/fallback ratio per orchestration
window.

Schema stability: additive-only.


---

### `repo_map_built` event (v2.1.17 W8 R-AIDER-FULL)

Emitted by `bin/_lib/repo-map.js` after every successful repo-map build,
warm-cache hit included. Pairs with the three failure-mode events below to
give the analytics rollup a complete picture of repo-map health.

```json
{
  "version": 1,
  "type": "repo_map_built",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "cwd": "/home/user/project",
  "files_parsed": 312,
  "symbols_ranked": 312,
  "ms": 2840,
  "cache_hit": false,
  "token_count": 987
}
```

Fields:

- `cwd`: absolute project root the build ran against.
- `files_parsed`: count of files whose tags landed in the graph.
- `symbols_ranked`: count of nodes scored by PageRank (typically equal to
  `files_parsed`; lower when a file had zero defs and was dropped).
- `ms`: end-to-end build time in milliseconds (`process.hrtime.bigint`
  delta).
- `cache_hit`: `true` when the on-disk aggregate matched and the build
  reused the persisted graph + scores; `false` on cold or partial rebuild.
- `token_count`: tokens of the rendered map (post-binary-search). Hits
  `0` when `tokenBudget === 0` or no symbols ranked.

Schema stability: additive-only.


---

### `repo_map_parse_failed` event (v2.1.17 W8 R-AIDER-FULL)

Emitted when tree-sitter rejects a single file (parser threw, file >1 MB,
or the read failed). The build continues; the offending file is dropped
from the graph.

```json
{
  "version": 1,
  "type": "repo_map_parse_failed",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "cwd": "/home/user/project",
  "file": "src/broken.py",
  "error_class": "file_too_large"
}
```

`error_class` values:

- `file_too_large` — source exceeded the 1 MB cap (W4 §3 step 1).
- `read_error` — `fs.readFileSync` threw (permissions, vanished file).
- `parse_error:<truncated message>` — tree-sitter parser or query threw.

Schema stability: additive-only.


---

### `repo_map_grammar_load_failed` event (v2.1.17 W8 R-AIDER-FULL)

Emitted at most once per process per language when the WASM grammar
cannot be loaded (file missing, corrupt bytes, runtime ABI mismatch).
The language is dropped from the build; surviving languages still parse.

```json
{
  "version": 1,
  "type": "repo_map_grammar_load_failed",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "cwd": "/home/user/project",
  "language": "sh",
  "error_class": "grammar_load_failed:sh"
}
```

`language` is the canonical short code (`js`, `ts`, `py`, `go`, `rs`,
`sh`). `error_class` carries the truncated underlying error string.

Schema stability: additive-only.


---

### `repo_map_cache_unavailable` event (v2.1.17 W8 R-AIDER-FULL)

Emitted once per `buildRepoMap` invocation when the cache directory is
not writable (read-only mount, permission denied, path collision). The
build proceeds in-memory: results return normally but nothing is
persisted.

```json
{
  "version": 1,
  "type": "repo_map_cache_unavailable",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "cwd": "/home/user/project",
  "reason": "cache_dir_not_writable"
}
```

`reason` values (extensible):

- `cache_dir_not_writable` — `fs.writeFileSync` probe failed.

Schema stability: additive-only.


---

### `staging_write_failed` event (v2.1.17 W11-fix F-W11-07 R-RV-DIMS-CAPTURE)

Emitted by `bin/_lib/context-telemetry-cache.js` (and its callers in
`bin/collect-context-telemetry.js`) when an I/O operation against the
context-telemetry staging cache (`.orchestray/state/context-telemetry.json`)
fails. The cache itself remains fail-open — the spawn never blocks — but
the emission gives operators a visible signal when a read-only filesystem,
a race condition, or a permission error is silently degrading the
R-RV-DIMS-CAPTURE telemetry stream.

```json
{
  "version": 1,
  "type": "staging_write_failed",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "cwd": "/home/user/project",
  "cache_path": "/home/user/project/.orchestray/state/context-telemetry.json",
  "error_class": "EACCES",
  "error_message": "EACCES: permission denied, open '...context-telemetry.json.tmp'",
  "op": "write"
}
```

Fields:

- `cwd`: absolute project root the failed I/O ran against.
- `cache_path`: full path of the cache file whose I/O failed.
- `error_class`: `error.code` when present (e.g., `EACCES`, `ENOSPC`,
  `EROFS`), otherwise `error.constructor.name` (e.g., `TypeError`).
- `error_message`: the underlying `error.message`, truncated to 256 chars.
- `op`: which operation failed. One of `read`, `write`, `update`, `delete`.
  - `read` — `readCache` could not parse / read the file.
  - `write` — atomic tmp-then-rename or direct write failed.
  - `update` — `updateCache` outer catch (lock or read-modify-write failed).
  - `delete` — staging-entry delete from within an `updateCache` body
    failed (e.g., serialization rejected after mutation).

The emit itself is fail-open: any failure inside the emitter is swallowed
so a degraded audit pipeline cannot itself block the spawn.

Schema changelog:

- v1 — initial (v2.1.17 W11-fix F-W11-07).

Schema stability: additive-only.


---

### `housekeeper_action` event

Audit row emitted by the `orchestray-housekeeper` subagent's PostToolUse path
(or by the PM at spawn-time, depending on emit-site choice). One row per
housekeeper operation. Written via `bin/_lib/audit-event-writer.js` to
`.orchestray/audit/events.jsonl`. Per Clause 4 of the locked-scope D-5
hardening contract.

```json
{
  "version": 1,
  "type": "housekeeper_action",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "session_id": "uuid-or-null",
  "op_type": "kb-write-verify",
  "target_bytes": 4096,
  "savings_claimed_usd": 0.008,
  "marker_received": "[housekeeper: write /abs/path]"
}
```

Field notes:

- `op_type`: one of `kb-write-verify`, `regen-schema-shadow`,
  `rollup-recompute`. Other values are validation errors and indicate
  scope drift.
- `target_bytes`: integer — total bytes the housekeeper Read in this op.
- `savings_claimed_usd`: PM-computed estimate of $ saved vs inline-Opus
  equivalent. May be `0` or negative on misclassification.
- `marker_received`: the literal `[housekeeper: ...]` marker string the PM
  emitted. Used for drift-from-scope analysis.
- `orchestration_id`: from `.orchestray/state/current-orchestration.json`;
  null if no active orchestration.

**Cardinality:** ~3-15 rows per orchestration in mid-load orchestrations.
The 90-day rolling rollup answers "is this agent still in scope?" by
counting the distribution of `op_type` values — a non-three-class
distribution indicates drift requiring investigation.

**Cross-references:** `pm.md §23f` (marker contract), `haiku-routing.md
§23f` (housekeeper section), `cost-prediction.md §32` (savings math +
promotion gate).

**Promotion gate:** the v2.2.1+ tool-extension release is gated on ≥ 100
`housekeeper_action` events with zero `housekeeper_forbidden_tool_blocked`
events. See `cost-prediction.md §32`.

Schema stability: additive-only.


---

### `housekeeper_drift_detected` event

Diagnostic event emitted by `bin/audit-housekeeper-drift.js` (SessionStart
hook) when the current `agents/orchestray-housekeeper.md` SHA-256 OR
`tools:` line diverges from the baseline pinned in
`bin/_lib/_housekeeper-baseline.js`. Fires on every SessionStart that
detects drift (one event per session — the hook runs once at session
start). Side effect: the hook writes a quarantine sentinel at
`.orchestray/state/housekeeper-quarantined`; `bin/gate-agent-spawn.js`
refuses housekeeper spawns until the sentinel is removed. Per Clause 3
of the locked-scope D-5 hardening contract.

```json
{
  "version": 1,
  "type": "housekeeper_drift_detected",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "hook": "audit-housekeeper-drift",
  "previous_sha": "c170f96e...",
  "current_sha": "deadbeef...",
  "previous_tools": "tools: [Read, Glob]",
  "current_tools": "tools: [Read, Glob, Bash]",
  "reason": "sha_and_tools"
}
```

Field notes:

- `previous_sha`: the baseline SHA-256 from `_housekeeper-baseline.js`.
- `current_sha`: the just-computed SHA of the current agent file.
  `null` if the agent file is missing.
- `previous_tools`: the baseline `tools:` line.
- `current_tools`: the just-extracted `tools:` line. `null` if the agent
  file is missing.
- `reason`: one of `sha_only`, `tools_only`, `sha_and_tools`,
  `agent_file_missing`.
- `hook`: always `audit-housekeeper-drift` for this event type.

**Cross-references:** Clause 3 of locked-scope D-5,
`bin/audit-housekeeper-drift.js`, `cost-prediction.md §32` (promotion gate
requires zero of these for ≥ 60 days).

**Operator response on emission:** investigate the diff between
`agents/orchestray-housekeeper.md` and the baseline; either revert the
agent file OR (if the change is sanctioned) update
`_housekeeper-baseline.js` AND `p33-housekeeper-whitelist-frozen.test.js`
in a commit tagged `[housekeeper-tools-extension]`. The quarantine
sentinel (`.orchestray/state/housekeeper-quarantined`) clears
automatically on the first clean SessionStart post-fix.

Schema stability: additive-only.


---

### `housekeeper_forbidden_tool_blocked` event

Diagnostic event emitted by `bin/validate-task-completion.js` (TaskCompleted
/ SubagentStop hook) when the `orchestray-housekeeper` subagent is observed
calling a forbidden tool (`Edit`, `Write`, `Bash`, or `Grep`). Fires AFTER
the structural 3-layer enforcement (frontmatter `tools:` whitelist + runtime
rejection + `p33-housekeeper-whitelist-frozen.test.js` byte-equality check)
catches the violation. The event records the violation for analytics; the
hook also exits 2 to block the offending TaskCompleted payload. Per
Clause 2 layer (b) of the locked-scope D-5 hardening contract.

**Note:** the housekeeper's forbidden set is STRICTER than the scout's — it
includes `Grep`. Scout permits `Grep`; housekeeper does not. This is
intentional per Clause 1 of locked-scope D-5.

```json
{
  "version": 1,
  "type": "housekeeper_forbidden_tool_blocked",
  "timestamp": "2026-04-26T12:34:56.789Z",
  "orchestration_id": "orch-1777200000",
  "hook": "validate-task-completion",
  "agent_role": "orchestray-housekeeper",
  "forbidden_tools": ["Grep"],
  "session_id": "uuid-or-null"
}
```

Field notes:

- `agent_role`: always `orchestray-housekeeper` for this event type.
- `forbidden_tools`: the tool names from `event.tool_calls` that
  intersected the housekeeper's forbidden set
  `{Edit, Write, Bash, Grep}`. Tolerant to varied payload shapes.
- `session_id`: the session id from the hook payload, or null when
  unavailable.
- `hook`: always `validate-task-completion` for this event type.

**Cross-references:** Clause 2 layer (b) of locked-scope D-5,
`bin/validate-task-completion.js` `READ_ONLY_AGENT_FORBIDDEN_TOOLS` map,
`p33-housekeeper-tool-runtime-rejection.test.js`,
`cost-prediction.md §32` (zero-violations promotion-gate criterion).

Schema stability: additive-only.

- feature_optional: true (negative-path guard; legitimately dark per W4 RCA-10. Excluded from the F3 promised-event tracker so it does not alarm.)

---

### `housekeeper_baseline_missing` event

Emitted by `bin/audit-housekeeper-drift.js` (Clause 3 of locked-scope D-5
hardening contract) on SessionStart when the baseline file
`bin/_lib/_housekeeper-baseline.js` is missing or unreadable. Fail-CLOSED
contract: drift detector also writes `.orchestray/state/housekeeper-quarantined`
sentinel, which `bin/gate-agent-spawn.js` honors to refuse all housekeeper
spawn attempts until the baseline is restored.

```json
{
  "type": "housekeeper_baseline_missing",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx-or-unknown",
  "baseline_path": "bin/_lib/_housekeeper-baseline.js",
  "reason": "missing|unreadable|malformed",
  "quarantine_sentinel_written": true,
  "session_id": "uuid-or-null",
  "hook": "audit-housekeeper-drift"
}
```

Field notes:

- `reason`: enum — `missing` (file not present), `unreadable` (file present
  but `require()` threw), `malformed` (file loaded but expected exports
  `BASELINE_AGENT_SHA` / `BASELINE_TOOLS_LINE` are absent or non-string).
- `quarantine_sentinel_written`: `true` if the drift detector successfully
  wrote `.orchestray/state/housekeeper-quarantined`.
- Paired with `housekeeper_drift_detected` (different trigger — drift
  compares current vs baseline; this fires when baseline is unavailable).

**Cross-references:** Clause 3 of locked-scope D-5,
`bin/audit-housekeeper-drift.js`, `bin/gate-agent-spawn.js`,
`p33-housekeeper-baseline-missing.test.js` (fail-CLOSED test).

Schema stability: additive-only.

---

### `audit_round_closed` event

Emitted by `bin/audit-round-archive-hook.js` (SubagentStop hook, P3.1,
v2.2.0) once per audit round when the hook detects that a verify-fix
round has just closed (i.e. one of `verify_fix_pass | verify_fix_fail
| verify_fix_oscillation` was emitted by the PM since the previous
`audit_round_closed`). This is an internal Orchestray event — Claude
Code itself does not emit it. The event is the **trigger** for
`audit_round_archived`; if the archive flag is off, this event is
still emitted (so observability of round-cadence survives the kill
switch).

Schema version: 1

```json
{
  "version": 1,
  "type": "audit_round_closed",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "round_n": 2,
  "outcome": "pass",
  "finding_count": 3,
  "task_id": "<task-N or null>"
}
```

Field notes:
- `round_n`: matches `round` from `verify_fix_*` rows
  (`agents/pm-reference/phase-verify.md:286-302`).
- `outcome`: enum `"pass" | "fail" | "oscillation"`.
- `finding_count`: count of finding-bearing rows scanned.
- `task_id`: `"task-N"` or `null` when not associated with a single task.
- Source: `bin/audit-round-archive-hook.js`. Backward compat: new
  in v2.2.0, ignore-unknown per R-EVENT-NAMING.

---

### `audit_round_archived` event

Emitted by `bin/_lib/audit-round-archive.js::archiveRound()` (P3.1,
v2.2.0) after a round's verbatim findings have been distilled into a
digest. Pair with the next turn's `cache_read_input_tokens` rollup to
prove the round-N+1 PM turn re-uses the cache rather than re-hydrating
the verbatim transcript.

Schema version: 1

```json
{
  "version": 1,
  "type": "audit_round_archived",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "round_n": 2,
  "full_transcript_bytes": 30182,
  "digest_bytes": 487,
  "ratio": 0.0162,
  "digest_path": ".orchestray/kb/artifacts/<orch>-round-<n>-digest.md",
  "finding_ids": ["3.1.task-12.verify_fix_pass", "..."],
  "mode": "deterministic"
}
```

Field notes:
- `round_n`: matches `audit_round_closed.round_n`.
- `full_transcript_bytes` / `digest_bytes`: utf-8 byte counts.
- `ratio`: `digest_bytes / full_transcript_bytes`; headline KPI,
  target ≤ 0.10.
- `digest_path`: relative to project cwd.
- `finding_ids`: full enumeration. **Hard invariant**: every
  finding id present in input rows for `round_n` is in this array
  (`bin/__tests__/p31-archive-finding-id-preservation.test.js` is the gate).
- `mode`: enum `"deterministic" | "haiku"`. v2.2.0 always emits
  `"deterministic"`; v2.2.1+ may flip to `"haiku"` when the housekeeper
  promotion gate opens.
- Source: `bin/_lib/audit-round-archive.js`. Backward compat: new
  in v2.2.0, ignore-unknown per R-EVENT-NAMING.

---

### `verify_fix_start` event

Emitted by the PM at the start of each verify-fix loop round
(`agents/pm-reference/phase-verify.md §5.f`). Documents the round
counter and the error count at round-start. Per S-008 (v2.2.0 fix-pass)
the schema row exists so `bin/_lib/schema-emit-validator.js` accepts
the event type and the event lands in `events.jsonl`. Without this
row the schema-emit validator rejected the event with a
`schema_shadow_validation_block` surrogate, which silently disabled
the P3.1 audit-round auto-archive feature.

```json
{
  "version": 1,
  "type": "verify_fix_start",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "task_id": "task-N",
  "round": 1,
  "error_count": 3
}
```

Field notes:
- `task_id`: the task whose verify-fix loop just opened (string).
- `round`: 1-indexed round counter.
- `error_count`: number of error-severity issues from the most-recent
  reviewer pass at round start.
- Source: PM via `ox events append`. Backward compat: new in v2.2.0,
  ignore-unknown per R-EVENT-NAMING.

---

### `verify_fix_pass` event

Emitted by the PM when a verify-fix loop exits successfully (errors
cleared) per `phase-verify.md §5.f`. This is one of the three trigger
events that close an audit round and fire the P3.1 auto-archive flow.

```json
{
  "version": 1,
  "type": "verify_fix_pass",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "task_id": "task-N",
  "round": 2,
  "rounds_total": 2
}
```

Field notes:
- `task_id`: the task whose verify-fix loop just closed.
- `round`: the round counter at the successful exit (1-indexed).
- `rounds_total`: same as `round` for `pass` (the loop exited at this
  round); included for symmetry with `verify_fix_fail`.
- Triggers `audit_round_closed` with `outcome: "pass"`.
- Source: PM via `ox events append`. Backward compat: new in v2.2.0,
  ignore-unknown per R-EVENT-NAMING.

---

### `verify_fix_fail` event

Emitted by the PM when the verify-fix loop reaches `verify_fix_max_rounds`
without converging (`phase-verify.md §5.f`). Documents the residual
error count for downstream escalation. Triggers `audit_round_closed`
with `outcome: "fail"`.

```json
{
  "version": 1,
  "type": "verify_fix_fail",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "task_id": "task-N",
  "round": 3,
  "remaining_errors": 2
}
```

Field notes:
- `round`: the cap-reaching round (typically `verify_fix_max_rounds`).
- `remaining_errors`: number of unresolved error-severity issues.
- Source: PM via `ox events append`. Backward compat: new in v2.2.0,
  ignore-unknown per R-EVENT-NAMING.

---

### `verify_fix_oscillation` event

Emitted by the PM when the oscillation detector trips
(`phase-verify.md §"Regression Prevention"`): round N has the same or
more errors than round N-1, signaling that fixing one issue
reintroduces another. Triggers `audit_round_closed` with
`outcome: "oscillation"`.

```json
{
  "version": 1,
  "type": "verify_fix_oscillation",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "task_id": "task-N",
  "round": 2,
  "errors_current": 3,
  "errors_previous": 2
}
```

Field notes:
- `errors_current`: error count for the just-completed round.
- `errors_previous`: error count for the prior round.
- The oscillation detector treats `errors_current >= errors_previous`
  as the trip condition.
- Source: PM via `ox events append`. Backward compat: new in v2.2.0,
  ignore-unknown per R-EVENT-NAMING.

---

### `output_shape_applied` event

Emitted by the PM at delegation time, immediately after the `Agent()`
spawn for any agent whose `decideShape()` result is non-null AND
`category !== "none"`. Documents which P1.2 levers fired for this
spawn so the v2.2.0 dashboard can roll up output-token reduction per
role. Per locked scope `.orchestray/kb/decisions/v220-scope-locked.md`
line 107: `output_shape.enabled` defaults to `true`; absence of this
event on hybrid/prose-heavy spawns indicates the kill switch fired.

```json
{
  "version": 1,
  "type": "output_shape_applied",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "session_id": "uuid-or-null",
  "task_id": "task-N-or-null",
  "role": "developer",
  "category": "hybrid",
  "caveman": true,
  "structured": false,
  "length_cap": 50000,
  "baseline_output_tokens": null,
  "observed_output_tokens": null,
  "accuracy_holds": null,
  "reason": "caveman=on,length_cap=tier_default,structured=staged_off"
}
```

Field notes:

- `task_id`: PM-issued task identifier when emitted from the in-prose
  protocol (PM Section 9.7). The `bin/inject-output-shape.js` hook
  (v2.2.2 Bucket C2) does NOT have access to a task_id at the
  PreToolUse:Agent boundary (the `Agent` tool signature carries
  `description` but no task_id), so the hook always emits `null` here.
  Nullable since v2.2.2.
- `session_id`: Claude Code session UUID when available on the hook
  payload; `null` otherwise (e.g., when the in-prose PM emit fires
  outside a hook context).
- `role`: canonical role name (matches `ROLE_MODEL_TIER` in
  `bin/_lib/output-shape.js`).
- `category`: enum from `ROLE_CATEGORY_MAP` —
  `structured-only|hybrid|prose-heavy|none`. The `none` category
  never emits this event (silenced at `decideShape()`).
- `caveman`: `true` if the 85-token addendum was injected; `false`
  otherwise (e.g., when `output_shape.caveman_enabled: false`).
- `structured`: `true` if `output_config.format` was passed on the
  `Agent()` call; `false` otherwise.
- `length_cap`: integer (output-token cap) or `null` when
  `output_shape.length_cap_enabled: false` OR the role is
  `structured-only`.
- `baseline_output_tokens`: PM-recorded pre-shape baseline from the
  `routing_outcome` event for this role, or `null` if unavailable.
  Populated post-spawn by an audit-event-rewriter pass in v2.2.1
  (out of scope for v2.2.0 — keep the field nullable).
- `observed_output_tokens`: actual output tokens used by the spawn.
  Populated by `bin/collect-agent-metrics.js` once the metrics flow
  joins (post-P1.1 M0.1 dedupe fix is the gate).
- `accuracy_holds`: `null` initially. v2.2.1 fills with
  `true|false|null` based on a post-spawn correctness check
  (deferred — schema-stable since the field is nullable).
- `reason`: comma-separated diagnostic string mirroring
  `decideShape().reason`. Useful for "why was caveman off on this
  spawn?" queries.

Cardinality: ~3-8 rows per orchestration (one per non-PM, non-`none`
spawn). 90-day rollup is the savings dashboard for P1.2.

Cross-references: `bin/_lib/output-shape.js` (decision module);
delegation injection point is `agents/pm.md` step 9.7 inside Block A.

Schema stability: additive-only. The five `null`-defaulted fields
(`baseline_output_tokens`, `observed_output_tokens`, `accuracy_holds`,
plus any v2.2.1 additions) are ignore-unknown-safe per
R-EVENT-NAMING. Source: PM via `ox events append`.

---

### `tier2_index_lookup` event

Emitted by `bin/_lib/tier2-index.js` (via the `schema_get` MCP verb or
the PM's fingerprint read) every time the PM resolves an event_type via
the chunked Tier-2 path instead of a full-file Read. Provides the
measurement signal needed to verify P1.3 effectiveness.

```json
{
  "version": 1,
  "type": "tier2_index_lookup",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown' if none active>",
  "file": "event-schemas.md",
  "event_type": "<the slug looked up>",
  "fingerprint_only_bytes": 1024,
  "full_file_bytes_avoided": 186058,
  "found": true,
  "source": "fingerprint"
}
```

Field notes:
- `file`: basename of the indexed source file. Always
  `"event-schemas.md"` in v2.2.0 — additional indexed files would
  introduce new values.
- `event_type`: the slug the PM resolved, or `"<unknown>"` on miss.
- `fingerprint_only_bytes`: bytes of the fingerprint string the PM
  consumed when this lookup was a fingerprint-scan (~1024).
- `full_file_bytes_avoided`: `_meta.source_bytes` from the sidecar — the
  number of bytes the PM did NOT have to read. Used to compute
  cumulative savings.
- `found`: `false` when the slug is not in the index. When
  `event_schemas.full_load_disabled: true`, the lookup terminates
  with `found: false` — no full-file fallback per the P1.3 D-8 contract.
- `source`: `"fingerprint"` if the PM read the fingerprint section;
  `"mcp_schema_get"` if the resolution went through the MCP verb.
- Schema stability: additive only. New fields will only be added as
  optional. Backward compat: new in v2.2.0; ignore-unknown per
  R-EVENT-NAMING. Source: `bin/mcp-server/tools/schema_get.js` or
  `ox events append` from the PM.

---

### `event_schemas_full_load_blocked` event

Emitted by `bin/emit-tier2-load.js` (PostToolUse:Read hook) whenever a
Read tool call targets `agents/pm-reference/event-schemas.md` while
`event_schemas.full_load_disabled: true` is in effect. This is the
observability half of the P1.3 D-8 contract: even when the PM
misroutes through Read instead of `schema_get`, telemetry surfaces the
slip so the next audit catches it. The hook is fail-open and does NOT
block the Read at the OS level — it only emits the event.

```json
{
  "version": 1,
  "type": "event_schemas_full_load_blocked",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id, or 'unknown' if none active>",
  "file_path": "agents/pm-reference/event-schemas.md",
  "agent_role": "pm",
  "source": "hook"
}
```

Field notes:
- `file_path`: the absolute or repo-relative path the Read targeted, as
  reported by the PostToolUse hook payload.
- `agent_role`: the role attribute from the hook event envelope, or
  `null` when unavailable.
- `source`: always `"hook"` — only the PostToolUse:Read hook is
  authorised to emit this event.
- Schema stability: additive only. Backward compat: new in v2.2.0;
  ignore-unknown per R-EVENT-NAMING. Source:
  `bin/emit-tier2-load.js`.

---

### `schema_get_call` event

Emitted by `bin/mcp-server/tools/schema_get.js` on every invocation of
the `mcp__orchestray__schema_get` MCP tool (P1.3, v2.2.0). Mirrors the
`mcp_tool_call` pattern but carries the specific `event_type` argument
so analytics can rank which event_types are looked up most often.
Fail-open: if the audit-event-writer is unavailable, the schema_get
call still proceeds.

```json
{
  "type": "schema_get_call",
  "version": 1,
  "timestamp": "ISO 8601",
  "tool": "schema_get",
  "event_type": "agent_stop",
  "orchestration_id": "orch-xxx-or-unknown"
}
```

Field notes:

- `event_type`: the literal string the PM passed to `mcp__orchestray__schema_get`.
  Slug pattern enforced by the tool's input schema (`^[a-z][a-z0-9_.-]*$`),
  so this is always a safe slug — never user-prose.
- `orchestration_id`: read from `.orchestray/audit/current-orchestration.json`
  if present; falls back to `'unknown'` (orphan invocations are still
  recorded for unbiased rollups).
- This event is paired with `tier2_index_lookup` (different signal —
  `schema_get_call` records the *invocation*, `tier2_index_lookup`
  records the *outcome* including `full_file_bytes_avoided`). Both are
  emitted on every `schema_get` call.

Schema stability: additive-only.

---

### `prompt_compression` event

Emitted by `bin/inject-tokenwright.js` (PreToolUse:Agent hook) on every
spawn whose delegation prompt passed through the tokenwright compressor
at policy level other than `off`. Captures pre/post byte counts plus the
list of dropped sections so analytics can attribute savings and detect
when the classifier becomes too aggressive.

```json
{
  "type": "prompt_compression",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx-or-unknown",
  "task_id": "task-xxx-or-null",
  "agent_type": "developer | architect | ...",
  "technique_tag": "safe-l1 | aggressive-l1l2 | experimental-l1l2l3 | debug-passthrough",
  "input_bytes": 12345,
  "output_bytes": 9876,
  "ratio": 0.8,
  "input_token_estimate": 3086,
  "output_token_estimate": 2469,
  "dropped_sections": [{"heading": "## Prior Findings", "kind": "dedup-eligible"}],
  "layer1_dedup_blocks_dropped": 2
}
```

Field notes:
- `technique_tag`: maps from policy level — `safe` → `safe-l1`,
  `aggressive` → `aggressive-l1l2`, `experimental` → `experimental-l1l2l3`,
  `debug-passthrough` → `debug-passthrough`. The `off` level emits no
  event.
- `ratio`: `output_bytes / input_bytes`. Sentinel value `1.0` indicates
  no compression occurred (parser found nothing to dedup).
- `input_token_estimate` and `output_token_estimate`: byte-count-divided-
  by-4 approximations. The realized token count comes from the paired
  `tokenwright_realized_savings` event written at SubagentStop (which
  uses the actual usage from the model's response).
- `dropped_sections`: only populated when at least one section was
  removed; empty array when all sections were kept.
- `layer1_dedup_blocks_dropped`: count of blocks removed by MinHash dedup
  in Layer 1. Other layer-counts are added when their layers ship in
  later releases.
- Schema stability: additive-only. Source: `bin/inject-tokenwright.js`
  via the `bin/_lib/tokenwright/emit.js` helper which stamps `version: 1`
  explicitly (the v2.2.2 audit-event-writer does NOT autofill the
  `version` field).

#### v2.2.6 additive fields

All fields below are additive (schema_version stays 1). Readers on v2.2.5 tolerate unknown fields.

- `sections_total` `{number}` — total parsed section count from the prompt.
- `sections_dedup_eligible` `{number}` — count of sections classified as `kind === 'dedup-eligible'`.
- `sections_score_eligible` `{number}` — count of sections classified as `kind === 'score-eligible'`.
- `sections_preserve` `{number}` — count of sections classified as `kind === 'preserve'`.
- `eligibility_rate` `{number}` — `(sections_dedup_eligible + sections_score_eligible) / sections_total`, or `0` when total is 0.
- `dedup_drop_by_heading` `{Record<string, number>}` — every heading in `DEDUP_ELIGIBLE_HEADINGS` gets a key; value is the count of dropped sections with that heading in this spawn. Headings with 0 drops still appear with value `0`.
- `compression_skipped_path` `{string|null}` — name of the skip path if compression was effectively a no-op (mirrors `compression_skipped.reason`); `null` when compression actually ran. Set to `"invariant_violation_fallback"` when invariant check caused fallback to original.
- `tokenwright_version` `{string}` — `"2.2.6-l1"` literal; distinguishes layer mix; rolls forward when L2 ships.
- `dropped_sections` backward-compat note: v2.2.5 emitted as `string[]` of headings; v2.2.6 emits as `Array<{heading: string|null, kind: string, body_bytes: number, dropped_reason: string}>`. Analytics readers MUST accept both shapes — legacy `string[]` rows from older events remain valid. Normalize via `normalizeDroppedSections(field)` helper in analytics readers.

---

### `tokenwright_realized_savings` event

Emitted by `bin/capture-tokenwright-realized.js` (SubagentStop hook) for
every spawn that previously emitted a `prompt_compression` event. Pairs
the compression-time estimate with the actual input-token count from
the model's response so analytics can compute estimation error and
detect token-counting drift.

```json
{
  "type": "tokenwright_realized_savings",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "task_id": "task-xxx-or-null",
  "agent_type": "developer | architect | ...",
  "estimated_input_tokens_pre": 3086,
  "actual_input_tokens": 3201,
  "actual_savings_tokens": -115,
  "quality_signal_status": "success | partial | failure",
  "estimation_error_pct": 3.7
}
```

Field notes:
- `estimated_input_tokens_pre`: the `input_token_estimate` from the
  paired `prompt_compression` event (pre-compression byte count / 4).
- `actual_input_tokens`: the `usage.input_tokens` value from the
  spawn's `agent_stop` row. Captured via the same metrics path as
  cost-tracker; never compressed.
- `actual_savings_tokens`: `estimated_input_tokens_pre - actual_input_tokens`.
  May be negative if the byte-count estimate underestimated the true
  token count (Claude's tokenizer is not strictly 4-bytes-per-token).
- `quality_signal_status`: mirrors `agent_stop.status` so the analytics
  rollup can detect quality regression in the compressed cohort vs the
  uncompressed baseline.
- `estimation_error_pct`: `|actual - estimated| / actual * 100`. Used
  by the 14-day observation gate to verify estimation accuracy before
  promoting `aggressive` to default.
- Schema stability: additive-only. Source:
  `bin/capture-tokenwright-realized.js` via `bin/_lib/tokenwright/emit.js`.

#### v2.2.6 additive fields

All fields below are additive (schema_version stays 1).

- `realized_status` `{"measured"|"unknown"}` — `"measured"` when actual tokens > 0; `"unknown"` when no token source was resolved (B1 fix). Required in v2.2.6+.
- `actual_input_tokens` `{number|null}` — now nullable (was non-null in v2.2.5). `null` when `realized_status === "unknown"`.
- `actual_savings_tokens` `{number|null}` — now nullable. `null` when no actual token count.
- `estimation_error_pct` `{number|null}` — now nullable. `null` when actual tokens unavailable.
- `usage_source` `{"transcript"|"hook_event"|"tool_response"|"unknown"}` — provenance of the actual token count. `"transcript"` is the primary source (B1 fix); others are fallbacks.
- `drift_exceeded` `{boolean}` — `true` when `|estimation_error_pct| > drift_budget_pct`.
- `drift_budget_pct` `{number}` — echoes config `compression.estimation_drift_budget_pct` (default 15).
- `removed_pending_entry` `{boolean}` — `true` confirms the B2 key-tuple equality fix worked and the matched pending entry was successfully removed from the journal.

---

## v2.2.6 additions

New event types added in v2.2.6 for end-to-end tokenwright instrumentation. All are routed through `bin/_lib/tokenwright/emit.js`. All fail-safe (emit-only, no caller disruption). All use `version: 1`, `schema_version: 1`.

### `tokenwright_realized_unknown` event

Emitted by `bin/capture-tokenwright-realized.js` when a pending journal entry is matched but no actual-token source could be resolved. Lower-cardinality alarm signal for dashboards — every emission means a compression event went unpaired with real token data.

```json
{
  "type": "tokenwright_realized_unknown",
  "version": 1,
  "timestamp": "2026-04-28T08:42:00.000Z",
  "orchestration_id": "orch-20260428T084117Z-v226-tokenwright-verify",
  "task_id": null,
  "agent_type": "researcher",
  "spawn_key": "researcher:0a1b2c3d",
  "estimated_input_tokens_pre": 1136,
  "reason": "no_token_source",
  "transcript_path_present": false,
  "hook_usage_present": false
}
```

Field notes:
- `spawn_key`: sha256-prefix key from the pending journal entry; links back to the `prompt_compression` event.
- `reason` ∈ `{no_token_source, transcript_unreadable, transcript_outside_containment, parse_failure}`. `no_token_source` means all three sources (transcript, hook event, tool_response) returned 0 or were absent.
- `transcript_path_present`: `true` if `event.agent_transcript_path` was non-empty in the hook payload.
- `hook_usage_present`: `true` if `event.usage.input_tokens` was present and non-zero.

### `compression_invariant_violated` event

Emitted by `bin/inject-tokenwright.js` when post-compression verification finds that a load-bearing section was dropped or modified. Should be zero in healthy runs. On violation, the original (uncompressed) prompt is used instead (defensive fallback when `compression.invariant_check_fallback_to_original` is true).

```json
{
  "type": "compression_invariant_violated",
  "version": 1,
  "timestamp": "2026-04-28T08:42:00.000Z",
  "orchestration_id": "orch-...",
  "agent_type": "developer",
  "violated_section": "## Structured Result",
  "violation_kind": "load_bearing_dropped",
  "input_bytes_pre": 12345,
  "input_bytes_post": 9876,
  "load_bearing_set": ["## Structured Result", "## Repository Map", "## Project Intent", "## Acceptance Rubric", "## Output Style"]
}
```

Field notes:
- `violated_section`: the heading that was absent or modified in the compressed output.
- `violation_kind` ∈ `{load_bearing_dropped, block_a_sentinel_missing, prefix_byte_drift}`.
- `load_bearing_set`: the full set of headings checked; useful for diagnosing false-positive trips if the list is misconfigured.
- When emitted alongside a `prompt_compression` event, `prompt_compression.compression_skipped_path` is set to `"invariant_violation_fallback"` and the prompt shipped to the model is the original.

### `tokenwright_estimation_drift` event

Emitted by `bin/capture-tokenwright-realized.js` when `|estimation_error_pct|` exceeds the configured drift budget (default 15%). Emitted alongside (not replacing) `tokenwright_realized_savings`. Signals that the 4-bytes-per-token estimator is systematically off for a particular spawn context (e.g., heavy emoji or CJK content).

```json
{
  "type": "tokenwright_estimation_drift",
  "version": 1,
  "timestamp": "2026-04-28T08:42:00.000Z",
  "orchestration_id": "orch-...",
  "agent_type": "developer",
  "estimated_input_tokens_pre": 1136,
  "actual_input_tokens": 1542,
  "estimation_error_pct": 35.7,
  "drift_budget_pct": 15,
  "direction": "underestimate"
}
```

Field notes:
- `direction` ∈ `{underestimate, overestimate}`. `underestimate` means actual > estimated; `overestimate` means estimated > actual.
- `drift_budget_pct`: echoes config `compression.estimation_drift_budget_pct` (default 15). Why 15%: Opus 4.7 tokenizer can consume up to 35% more tokens than the 4-bytes-per-token approximation; 15% allows normal variance while catching actionable drift.
- `estimation_error_pct`: `|actual - estimated| / actual * 100`.

### `tokenwright_spawn_coverage` event

Emitted once per orchestration at close time by `bin/_lib/tokenwright/coverage-probe.js` (called from `bin/post-orchestration-extract-on-stop.js`). Summarizes how many agent spawns produced paired compression/realized events. Primary input to the 14-day observation gate.

```json
{
  "type": "tokenwright_spawn_coverage",
  "version": 1,
  "timestamp": "2026-04-28T08:42:30.000Z",
  "orchestration_id": "orch-...",
  "agent_starts_total": 12,
  "prompt_compression_emits": 11,
  "realized_savings_emits": 9,
  "realized_unknown_emits": 2,
  "compression_skipped_emits": 1,
  "coverage_compression_pct": 91.7,
  "coverage_realized_pct": 81.8,
  "missing_pairs": [
    {"agent_type": "developer", "spawn_key": "developer:abc123", "missing_event": "tokenwright_realized_savings"}
  ]
}
```

Field notes:
- `coverage_compression_pct`: `prompt_compression_emits / agent_starts_total * 100`.
- `coverage_realized_pct`: `(realized_savings_emits + realized_unknown_emits) / prompt_compression_emits * 100`.
- `missing_pairs`: list of spawns that have a `prompt_compression` but no matching `tokenwright_realized_savings` or `tokenwright_realized_unknown`. Each entry has `agent_type`, `spawn_key`, `missing_event`.
- Source: tail-scan of `events.jsonl` for the orchestration window using the `orchestration_id` key.

### `compression_skipped` event

Emitted by `bin/inject-tokenwright.js` for every silent no-op path (kill-switch, missing prompt, oversize stdin, parse failure, exception). Replaces all previously silent exits so every compression decision is observable. In-memory skip cache suppresses duplicate emits within the same script invocation (process-local; cross-invocation dedup not required in v2.2.6).

```json
{
  "type": "compression_skipped",
  "version": 1,
  "timestamp": "2026-04-28T08:42:00.000Z",
  "orchestration_id": "orch-...",
  "agent_type": "developer",
  "reason": "kill_switch_env",
  "skip_path": "ORCHESTRAY_DISABLE_COMPRESSION=1"
}
```

Field notes:
- `reason` ∈ `{kill_switch_env, kill_switch_config, level_off, level_debug_passthrough, no_prompt_field, oversize_stdin, parse_failure, runtime_exception, agent_type_excluded}`.
- `skip_path`: human-readable detail about the skip path — e.g. the env var name, the config path that triggered it, or a truncated error message (max 200 chars) for `runtime_exception`.
- Kill switch: `ORCHESTRAY_DISABLE_SKIP_EVENT=1` or `compression.skip_event_enabled: false` suppresses all `compression_skipped` events (restores silent behavior; debug only).

### `compression_double_fire_detected` event

Emitted by `bin/inject-tokenwright.js` or `bin/capture-tokenwright-realized.js` when the same `dedup_token` is seen twice within the 100ms detection window. Indicates double hook registration (B3 bug). One event per detection per orchestration; subsequent detections are suppressed.

```json
{
  "type": "compression_double_fire_detected",
  "version": 1,
  "timestamp": "2026-04-28T08:42:00.000Z",
  "orchestration_id": "orch-...",
  "agent_type": "researcher",
  "dedup_token": "researcher:0a1b:1745832120000",
  "delta_ms": 12,
  "first_caller": "/home/palgin/.claude/orchestray/bin/inject-tokenwright.js",
  "second_caller": "/home/palgin/orchestray/.claude/orchestray/bin/inject-tokenwright.js"
}
```

Field notes:
- `dedup_token`: sha256 prefix of `prompt + agentType + spawnTimestamp` (first 16 hex chars); identifies the specific spawn.
- `delta_ms`: milliseconds between first and second fire.
- `first_caller` / `second_caller`: `__filename` from each invocation, allowing identification of which install path fired.
- Kill switch: `ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1` or `compression.double_fire_guard_enabled: false`.

### `tokenwright_journal_truncated` event

Emitted by `bin/inject-tokenwright.js` when the pending journal is truncated by TTL sweep or hard cap. Should be zero in healthy runs — any emission indicates the B4 fix is actively catching runaway growth (or the B1/B2 fixes were insufficient).

```json
{
  "type": "tokenwright_journal_truncated",
  "version": 1,
  "timestamp": "2026-04-28T08:42:00.000Z",
  "orchestration_id": "orch-...",
  "entries_before": 287,
  "entries_after": 100,
  "bytes_before": 14523,
  "bytes_after": 5050,
  "trigger": "size_cap_10kb"
}
```

Field notes:
- `trigger` ∈ `{size_cap_10kb, ttl_sweep, count_cap_100}`. `size_cap_10kb` fires when journal exceeds 10 KB; `count_cap_100` fires when entry count exceeds 100; `ttl_sweep` fires when expired entries are removed on a normal write path.
- Config controls: `compression.pending_journal_ttl_hours` (default 24), `compression.pending_journal_max_bytes` (default 10240), `compression.pending_journal_max_entries` (default 100).

### `tokenwright_self_probe` event

Emitted once on first session post-v2.2.6 install by `bin/_lib/tokenwright/self-probe.js` (invoked from `bin/post-upgrade-sweep.js`). Verifies the full instrumentation stack is wired correctly. Triggered by sentinel `.orchestray/state/tokenwright-self-probe-needed`; deleted after run. Re-trigger via `node bin/_lib/tokenwright/self-probe.js --force`.

```json
{
  "type": "tokenwright_self_probe",
  "version": 1,
  "timestamp": "2026-04-28T08:42:00.000Z",
  "version_installed": "2.2.6",
  "global_install_present": true,
  "local_install_present": true,
  "hook_dedup_clean": true,
  "compression_block_in_config": true,
  "transcript_token_path_resolves": true,
  "fixture_compression_ran": true,
  "fixture_emitted_prompt_compression": true,
  "fixture_emitted_realized_savings": true,
  "result": "pass",
  "failures": []
}
```

Field notes:
- `result` ∈ `{pass, fail, skipped}`. `pass` means all boolean checks were true. `fail` means at least one check failed — see `failures[]` for which ones. `skipped` means the probe was suppressed by kill switch.
- `failures`: list of flag names that resolved to `false` (e.g. `["hook_dedup_clean", "transcript_token_path_resolves"]`).
- Kill switch: `ORCHESTRAY_DISABLE_TOKENWRIGHT_SELF_PROBE=1` or `compression.self_probe_enabled: false`.
- Detection from analytics: `/orchestray:analytics` reads `tokenwright_self_probe` with `result: fail` and surfaces a banner in the next session.

---

## v2.2.8 event additions

### `verify_fix_coverage_report` event

Emitted once per orchestration at close time by `bin/_lib/verify-fix-coverage.js` (called from `bin/post-orchestration-extract-on-stop.js`). Reports how many developer/refactorer agent tasks were paired with a `verify_fix_start` event.

```json
{
  "type": "verify_fix_coverage_report",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "tasks_total": 5,
  "tasks_with_verify_fix": 0,
  "ratio": 0.0,
  "alert": "zero_coverage",
  "distinct_agents": ["developer"]
}
```

Field notes:
- `alert` ∈ `{ok, below_threshold, zero_coverage, n/a_single_task}`. Threshold default 0.5.
- Kill switch: `verify_fix.coverage_report.enabled: false`.

### `sentinel_probe_session` event

Emitted once per session start by `bin/sentinel-probe.js` (registered as `SessionStart` hook). Runs 4 health checks (orchestray_dir, audit_dir_writable, hooks_json, config_json).

```json
{
  "type": "sentinel_probe_session",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "results": [{"check_name": "orchestray_dir", "status": "pass", "detail": "..."}],
  "overall_status": "pass",
  "ts": "ISO 8601"
}
```

Field notes:
- `overall_status` ∈ `{pass, fail}`. On `fail`, a stderr banner is written.
- Kill switch: `ORCHESTRAY_DISABLE_SENTINEL_PROBE=1` or `sentinel_probe.enabled: false`.

### `block_z_sentinel_retripped` event

Emitted by `bin/compose-block-a.js` when the Block-Z sentinel was recently auto-cleared on TTL but a fresh violation re-trips it within 60 seconds.

```json
{
  "type": "block_z_sentinel_retripped",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "time_since_clear_ms": 1234,
  "recovery_attempts": 1,
  "observed_hash": "sha256...",
  "pinned_hash": "sha256..."
}
```

Field notes:
- `recovery_attempts` increments per re-trip within a 1-hour window.
- Kill switch: existing `caching.block_z.enabled: false`.
- feature_optional: true (untriggered failure-recovery path; legitimately dark per W4 RCA-4. Excluded from the F3 promised-event tracker so it does not alarm.)

### `block_z_drift_unresolved` event

Emitted by `bin/compose-block-a.js` when zone1 hash drift produces ≥3 sentinel re-trips within 1 hour. Auto-clear is then disabled (operator must manually recover).

```json
{
  "type": "block_z_drift_unresolved",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "recovery_attempts": 3,
  "distinct_hashes_seen": ["...", "...", "..."],
  "window_minutes": 60
}
```

Field notes:
- After this event fires, a permanent-style sentinel `.block-a-zone-caching-disabled-permanent` is written.
- feature_optional: true (untriggered failure-recovery path; legitimately dark per W4 RCA-4. Excluded from the F3 promised-event tracker so it does not alarm.)

### `context_pin_applied` event

Emitted by `bin/compose-block-a.js` when `--context <file>` pins are present in `.orchestray/state/orchestration-pins.json` for the current orchestration.

```json
{
  "type": "context_pin_applied",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "pinned_files": ["README.md", "src/foo.ts"],
  "total_bytes": 5432,
  "soft_cap_exceeded": false
}
```

Field notes:
- Soft cap: 8 KB total pin-budget. When exceeded, `soft_cap_exceeded: true` but the pins are NOT blocked.

### `schema_redirect_emitted` event

Emitted by `bin/context-shield.js` (PreToolUse:Read) when a Read of `agents/pm-reference/event-schemas.md` is denied with a redirect to `mcp__orchestray__schema_get`.

```json
{
  "type": "schema_redirect_emitted",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "blocking_path": "/abs/path/event-schemas.md",
  "suggested_tool": "mcp__orchestray__schema_get",
  "suggested_slug": "agent_start"
}
```

Field notes:
- `suggested_slug`: best-guess from context, defaults to `agent_start` as a generic example.
- Opt-out: `event_schemas.full_load_disabled: false`.

### `schema_redirect_followed` event

Emitted by `bin/emit-schema-redirect-followed.js` (PostToolUse:`mcp__orchestray__schema_get`) when an agent calls the chunked-MCP tool after receiving a redirect.

```json
{
  "type": "schema_redirect_followed",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "agent_type": "developer",
  "time_to_follow_ms": 1234,
  "called_slug": "agent_start",
  "suggested_slug": "agent_start",
  "slug_match": true
}
```

Field notes:
- Pairs with `schema_redirect_emitted` via `.orchestray/state/schema-redirect-pending.jsonl`.

### `housekeeper_pending_queued` event

Emitted by `bin/spawn-housekeeper-on-trigger.js` (PostToolUse) when a KB write or schema edit triggers a queued housekeeper run.

```json
{
  "type": "housekeeper_pending_queued",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "trigger_type": "kb_write",
  "trigger_source": "facts/test.md",
  "debounced": false
}
```

Field notes:
- `trigger_type` ∈ `{kb_write, schema_edit, phase_transition}`.
- Debounce TTL: 60s per trigger_type.
- Kill switch: `housekeeping.auto_delegate.enabled: false` or `ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER=1`.

### `hook_double_fire_detected` event

Emitted by `bin/_lib/double-fire-guard.js` when the same `dedup_key` is seen from a different caller path within the TTL window. Catches dual-install duplicate registrations.

```json
{
  "type": "hook_double_fire_detected",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "guard_name": "compose-block-a",
  "dedup_key": "...",
  "delta_ms": 12,
  "first_caller": "/abs/path/...",
  "second_caller": "/abs/path/..."
}
```

Field notes:
- `guard_name` ∈ `{tokenwright, compose-block-a, inject-delegation-delta, emit-routing-outcome}`.
- One emit per `(orchestration_id, guard_name, dedup_key)` tuple (Issue D fix).

### `snapshot_captured` event

Emitted by `bin/snapshot-pre-write.js` (PreToolUse:Write|Edit|MultiEdit) when a target file's pre-write contents are copied to `.orchestray/snapshots/<orch_id>/<spawn_id>/`.

```json
{
  "type": "snapshot_captured",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "spawn_id": "...",
  "agent_type": "developer",
  "path": "/abs/file/path",
  "bytes": 12345
}
```

Field notes:
- Disk cap: 50 MB per orchestration; oldest evicted on overflow.
- Auto-GC: snapshot dir deleted at orchestration close.
- Kill switch: `snapshots.enabled: false` or `ORCHESTRAY_DISABLE_SNAPSHOTS=1`.

### `rollback_applied` event

Emitted by the `/orchestray:rollback` skill when a snapshot is restored over a working file.

```json
{
  "type": "rollback_applied",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "spawn_id": "...",
  "agent_type": "developer",
  "path": "/abs/file/path",
  "source": "user_skill"
}
```

### `loop_started` event

Emitted by the `/orchestray:loop` skill when a tight-loop primitive is initialized.

```json
{
  "type": "loop_started",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "loop_id": "...",
  "agent_type": "developer",
  "max_iterations": 10,
  "completion_promise": "TASK_COMPLETE"
}
```

Field notes:
- feature_optional: true (opt-in `/orchestray:loop` slash command; legitimately dark per W4 RCA-8 when the user does not invoke the loop. Excluded from the F3 promised-event tracker so it does not alarm.)

### `loop_iteration` event

Emitted by `bin/loop-continue.js` (SubagentStop) when a loop iteration completes without meeting the completion promise.

```json
{
  "type": "loop_iteration",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "loop_id": "...",
  "iter_count": 3,
  "last_output_excerpt": "..."
}
```

Field notes:
- feature_optional: true (opt-in `/orchestray:loop` slash command; legitimately dark per W4 RCA-8 when the user does not invoke the loop. Excluded from the F3 promised-event tracker so it does not alarm.)

### `loop_completed` event

Emitted by `bin/loop-continue.js` when a loop ends.

```json
{
  "type": "loop_completed",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "loop_id": "...",
  "iter_count": 5,
  "completion_reason": "promise_met"
}
```

Field notes:
- `completion_reason` ∈ `{promise_met, max_iterations, cost_cap, user_cancel}`.
- feature_optional: true (opt-in `/orchestray:loop` slash command; legitimately dark per W4 RCA-8 when the user does not invoke the loop. Excluded from the F3 promised-event tracker so it does not alarm.)

### `spawn_requested` event

Emitted by `mcp__orchestray__spawn_agent` when a worker requests a reactive spawn.

```json
{
  "type": "spawn_requested",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "request_id": "uuid",
  "requester_agent": "developer",
  "requester_spawn_id": "...",
  "requested_agent": "security-engineer",
  "justification": "...",
  "max_cost_usd": 0.50
}
```

Field notes:
- Per-orchestration quota: 5 (configurable via `reactive_spawn.per_orchestration_quota`).
- Kill switch: `reactive_spawn.enabled: false` or `ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1`.

### `spawn_approved` event

Emitted by `bin/process-spawn-requests.js` (PreToolUse:Agent) when an auto-approve threshold is met.

```json
{
  "type": "spawn_approved",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "request_id": "...",
  "decision_source": "auto",
  "reason": "below_threshold"
}
```

Field notes:
- `decision_source` ∈ `{auto, user}`.
- Auto-approve threshold default: 20% of remaining orchestration budget.

### `spawn_denied` event

Emitted by `bin/process-spawn-requests.js` when a spawn request fails the cost cap, quota, or max-depth check.

```json
{
  "type": "spawn_denied",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "request_id": "...",
  "decision_source": "auto",
  "reason": "above_threshold"
}
```

Field notes:
- `reason` ∈ `{above_threshold, quota_exhausted, max_depth_exceeded, user_explicit}`.
- Max-depth default: 2 (a reactive-spawned agent cannot itself reactive-spawn).

### `audit_event_autofilled` event

Emitted by `bin/_lib/audit-event-writer.js` (F1, v2.2.9) whenever the writer
populates one or more required fields on an emitted event because the caller
omitted them. Closes the v2.2.8 silent-drop class (W4 RCA-9: 64/74 = 86% of
`agent_stop` rows lost because `version: 1` was omitted).

```json
{
  "type": "audit_event_autofilled",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "orch-xxx",
  "event_type": "agent_stop",
  "fields_autofilled": ["version", "session_id"]
}
```

Field notes:
- `event_type`: the type of the underlying event whose fields were autofilled
  (NOT the type of this telemetry row, which is always `audit_event_autofilled`).
- `fields_autofilled`: ordered list of field names the writer populated.
  Caller-provided values are NEVER reported here — only fields the writer
  filled from the F1 allowlist (`version`, `timestamp`, `orchestration_id`,
  `session_id`).
- Recursion-guarded: this telemetry row never re-triggers itself, even if its
  own emit goes through the schema-unreadable or skipValidation path.
- Kill switch: `ORCHESTRAY_AUDIT_AUTOFILL_DISABLED=1` reverts the writer to
  the pre-F1 two-field behavior, which suppresses this event entirely.

### `orchestration_events_archived` event

Emitted by `bin/archive-orch-events.js` (Stop hook, before `post-orchestration-extract-on-stop.js`) every time the live `.orchestray/audit/events.jsonl` is filtered by the active `orchestration_id` and written atomically (tmp+rename) to `.orchestray/history/<orch_id>/events.jsonl`. The archive is mutable until the orchestration is officially complete; on the Stop fire that follows the `orchestration_complete` event, a sibling `.archived` marker is written and subsequent fires become idempotent no-ops.

```json
{
  "type": "orchestration_events_archived",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "event_count": 42,
  "byte_size": 18432,
  "archive_path": "/abs/path/.orchestray/history/orch-.../events.jsonl"
}
```

Field notes:
- `event_count`: number of JSONL lines copied to the archive on this fire (filtered by `orchestration_id`).
- `byte_size`: archive payload size in bytes (post-write, equals on-disk size of `archive_path`).
- `archive_path`: absolute path to the canonical archive file (post-rename).
- Idempotent: skipped silently when `<archive_dir>/.archived` exists.
- Kill switch: `ORCHESTRAY_ORCH_ARCHIVE_DISABLED=1`.
- Unblocks downstream: `replay-last-n.sh`, `watch-events.js`, `audit-default-true-flags.js`, `mcp-server/lib/history_scan.js`, `pattern-roi-aggregate.js`, `_lib/archetype-cache.js`, `verify-fix-coverage.js`.

### `event_promised_but_dark` event

Emitted by `bin/audit-promised-events.js` (Stop hook, after `archive-orch-events.js`) when a registered event-type in `event-schemas.shadow.json` has fired ZERO times across the live audit log + per-orch archives, has been registered for more than 7 days, and is NOT marked `feature_optional: true` in its `event-schemas.md` Field notes block. Catches the v2.2.8 class of "CHANGELOG promises an event nobody emits" silent failure (W4 §E.1, RCA-1/2/5/6). Each registered dark event-type emits at most ONE `event_promised_but_dark` row per 24h per type — debounced via `.orchestray/state/promised-event-tracker.last-run.json`.

```json
{
  "type": "event_promised_but_dark",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "event_type": "housekeeper_action",
  "days_dark": 8,
  "first_seen_in_shadow_at": "ISO 8601",
  "total_fire_count": 0
}
```

Field notes:
- `event_type`: the dark event-type whose schema entry has zero fires (NOT the type of this row, which is always `event_promised_but_dark`).
- `days_dark`: integer days since `first_seen_in_shadow_at` (floor).
- `first_seen_in_shadow_at`: best-effort ISO 8601 timestamp of when the tracker first recorded the event-type as registered. Sourced from a tracker-managed registry at `.orchestray/state/promised-event-registry.json`; falls back to the shadow's `_meta.generated_at` when no registry entry exists yet.
- `total_fire_count`: always 0 by construction (the tracker only emits when the count is zero).
- Debounced: at most one fire per (event_type, 24h window).
- Kill switch: `ORCHESTRAY_PROMISED_EVENT_TRACKER_DISABLED=1`.
- `feature_optional: true` opt-out: events legitimately dark for opt-in / negative-path / failure-recovery reasons are excluded by the `feature_optional: true` Field-notes flag (parsed by `bin/_lib/event-schemas-parser.js` into the `f` shadow column).

### `event_promised_but_dark_scan_truncated` event

Emitted when `bin/audit-promised-events.js` exhausts its 5-second wall-clock budget before scanning every registered event-type. Carries the partial result count so analytics can flag a tracker that's outgrown its budget.

```json
{
  "type": "event_promised_but_dark_scan_truncated",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "partial_count": 23,
  "total_event_types": 147,
  "elapsed_ms": 5012
}
```

Field notes:
- `partial_count`: number of event-types fully scanned before the budget tripped.
- `total_event_types`: number of registered event-types in `event-schemas.shadow.json` at scan-start.
- `elapsed_ms`: wall-clock time at truncation (must be ≥ 5000).
- The tracker exits 0 (never fail-closes a Stop hook) on truncation.

### `changelog_naming_drift_detected` event

Emitted by `bin/release-manager/changelog-event-name-check.js` when a backtick-quoted event-name token in the unreleased / topmost CHANGELOG section is not present as a key in `agents/pm-reference/event-schemas.shadow.json`. Catches the v2.2.8 `snapshot_taken` (typo for `snapshot_captured`) and `loop_complete` (typo for `loop_completed`) drift classes mechanically. The firewall script writes this event BEFORE exiting 2 so analytics see the drift even when the release commit is blocked.

```json
{
  "type": "changelog_naming_drift_detected",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "missing_tokens": ["snapshot_taken", "loop_complete"],
  "changelog_section": "[2.2.8] - 2026-04-28"
}
```

Field notes:
- `missing_tokens`: array of backtick-quoted event-name tokens (regex `/^[a-z][a-z0-9_]+$/` with at least one underscore) that appeared in the CHANGELOG section but are NOT keys in `event-schemas.shadow.json`.
- `changelog_section`: the section header line as it appears in CHANGELOG.md (e.g. `[2.2.9] - 2026-04-28` or `Unreleased`).
- Kill switch: `ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED=1` — honored ONLY for non-release commits. Release commits (subject starting `release:`) cannot opt out.
- The script exits 2 after emitting this event; the calling pre-commit / SubagentStop gate aborts the commit.

### `housekeeper_trigger_debounced` event

Emitted by `bin/spawn-housekeeper-on-trigger.js` (PostToolUse, v2.2.9 B-1.1) whenever a fresh trigger collapses against an already-pending system housekeeper request for the same orchestration. The debounce limit is one pending system-housekeeper row in `.orchestray/state/spawn-requests.jsonl` per orchestration_id; when a duplicate would be enqueued, the trigger is suppressed and this row makes the collapse observable.

```json
{
  "type": "housekeeper_trigger_debounced",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "trigger_reason": "kb_write",
  "debounced_count": 1
}
```

Field notes:
- `trigger_reason` ∈ `{kb_write, schema_edit, phase_transition}`. Mirrors the `justification` field on the synthetic `spawn_requested` row that survived the debounce.
- `debounced_count`: number of system-housekeeper requests already pending for this orchestration_id at the moment the duplicate trigger fired. With the v2.2.9 N=1 cap this is always `1`; the field is preserved for forward compatibility if the cap loosens.
- Kill switch: same as the upstream trigger (`ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED=1`, `ORCHESTRAY_DISABLE_AUTO_HOUSEKEEPER=1`, or `housekeeping.auto_delegate.enabled: false`).

### `housekeeper_trigger_orphaned` event

Emitted by `bin/audit-housekeeper-orphan.js` (Stop hook tail, v2.2.9 B-1.2) when a synthetic `spawn_requested` row queued by `bin/spawn-housekeeper-on-trigger.js` has no matching `spawn_approved` or `spawn_denied` event within 60 seconds. Indicates that the trigger fell through the spawn-queue handoff and surfaces the failure mode mechanically rather than via prose inspection.

```json
{
  "type": "housekeeper_trigger_orphaned",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "request_id": "uuid",
  "trigger_reason": "kb_write",
  "age_seconds": 73
}
```

Field notes:
- `request_id`: the `request_id` of the orphaned `spawn_requested` row in `.orchestray/state/spawn-requests.jsonl` and `events.jsonl`.
- `trigger_reason`: copied verbatim from the orphaned request's `justification` field; nullable when the source row predates field coverage.
- `age_seconds`: integer seconds between the orphaned request's timestamp and the moment this row was emitted (always ≥ 60).
- Idempotent: a request_id already reported as orphaned in the same orchestration's events archive is not re-emitted on subsequent Stop fires.
- No kill switch — pure observability per `feedback_default_on_shipping.md`.

### `dossier_injection_skipped`

Emitted by `bin/inject-resilience-dossier.js` (UserPromptSubmit and SessionStart hooks) on every silent-skip / early-return branch, so operators can distinguish "inject ran and succeeded" from "inject ran and silently bailed at branch X". Introduced in v2.2.9 B-3 to fix the v2.2.8 regression where `dossier_written: 64` but `dossier_injected: 0` because every skip path was unobservable.

```json
{
  "type": "dossier_injection_skipped",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "<id | null>",
  "skip_reason": "kill_switch_set",
  "dossier_path": ".orchestray/state/resilience-dossier.json"
}
```

Field notes:
- `skip_reason` ∈ `{not_session_start, dossier_file_missing, dossier_file_corrupt, dossier_stale, no_orchestration_active, additional_context_already_present, kill_switch_set, unknown_skip}`.
- `kill_switch_set` covers env kill switch, config disabled, config kill_switch, configured `max_inject_turns` exhaustion, and `shadow_mode` — all are operator-configured suppressions, not bugs.
- `not_session_start` covers UPS turns where no `compact-signal.lock` is present (i.e. the turn isn't a post-compact recovery turn).
- `dossier_file_corrupt` covers lock-parse failure, dossier-read failure, dossier-parse failure, and fence-collision detection.
- `dossier_stale` covers `dossier.status === 'completed'` (the orchestration already finished).
- `unknown_skip` is a fallback for un-categorised exceptions — treat as TODO; v2.2.10 should categorise.
- Optional fields: `trigger` (`UserPromptSubmit | SessionStart`), `sub_reason` (free-text refinement), and per-branch detail fields (`err_code`, `parse_reason`, `bytes_would_inject`, `lock_source`, `counter`, `max`, `offending_field`).
- **`feature_optional: false`** — required for fail-closed observability. The orphan auditor (`bin/audit-dossier-orphan.js`) consumes this stream to decide whether a `dossier_written` row had a paired outcome; if both `dossier_injected` AND `dossier_injection_skipped` are absent for the same orchestration, `dossier_write_without_inject_detected` fires.
- Kill switch: `ORCHESTRAY_DOSSIER_INJECT_TELEMETRY_DISABLED=1` suppresses this telemetry only; the inject mechanism itself stays working.

### `dossier_write_without_inject_detected`

Emitted by `bin/audit-dossier-orphan.js` (Stop-hook tail, post-orchestration) when at least one `dossier_written` event landed in an orchestration without any paired `dossier_injected` OR operator-relevant `dossier_injection_skipped` event. Catches the v2.2.8 regression class: writes happening, injects silently dropping.

```json
{
  "type": "dossier_write_without_inject_detected",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "<id>",
  "write_count": 3,
  "inject_count": 0
}
```

Field notes:
- `write_count`: number of `dossier_written` rows for this `orchestration_id`.
- `inject_count`: number of `dossier_injected` rows for this `orchestration_id`.
- A row with `write_count > 0` AND `inject_count == 0` AND no `dossier_injection_skipped(skip_reason ≠ kill_switch_set)` means the inject side is dark — operator must investigate.
- Skips with `skip_reason == kill_switch_set` are NOT counted as orphans because the operator deliberately suppressed inject.
- Optional fields: `skip_count` (count of paired `dossier_injection_skipped` rows), `kill_switch_skip_count`, `archive_source` (`per_orch_archive | live_events_filter`).
- **`feature_optional: false`** — required for the v2.2.9 anti-regression invariant.

### `agent_stop_double_fire_suppressed` event

Emitted by `bin/collect-agent-metrics.js` (v2.2.9 B-4.1) when the double-fire guard catches a duplicate `agent_stop` invocation. Pairs with `hook_double_fire_detected` (the generic guard event) to give first-class visibility to the SubagentStop+TaskCompleted dual-wire and dual-install drift.

```json
{
  "type": "agent_stop_double_fire_suppressed",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "agent_type": "developer",
  "dedup_token": "<orch>:<agent_type>:<session_id|agent_id>:agent_stop",
  "delta_ms": 12,
  "first_caller": "/abs/path/...",
  "second_caller": "/abs/path/..."
}
```

Field notes:
- Suppressed write paths: the `agent_stop` audit row, the Variant-C `routing_outcome` supplement, and the per-spawn `agent_metrics.jsonl` row are ALL skipped on the second fire.
- Kill switch: `ORCHESTRAY_AGENT_STOP_DOUBLE_FIRE_GUARD_DISABLED=1` (default-on); also respects the global `ORCHESTRAY_DISABLE_DOUBLE_FIRE_GUARD=1`.
- TTL: 5 minutes (covers the typical SubagentStop → TaskCompleted re-fire window).

### `sentinel_probe_bypassed` event

Emitted by `bin/sentinel-probe.js` (v2.2.9 B-4.2) when SessionStart bypasses the probe via the env-kill-switch or config-disabled path. Pairs with `sentinel_probe_session` (success path) so every SessionStart produces exactly one of the two events — the bypass case is no longer dark.

```json
{
  "type": "sentinel_probe_bypassed",
  "version": 1,
  "timestamp": "ISO 8601",
  "bypass_reason": "kill_switch"
}
```

Field notes:
- `bypass_reason` ∈ `{kill_switch, config_disabled, unknown}`.
- `kill_switch` — `ORCHESTRAY_DISABLE_SENTINEL_PROBE=1` set in env.
- `config_disabled` — `sentinel_probe.enabled: false` in `.orchestray/config.json`.
- Pure observability: emitting this event does NOT change bypass behavior.

### `delegation_delta_marker_missing` event

Emitted by `bin/inject-delegation-delta.js` (v2.2.9 B-4.3) when an Agent tool call carries a non-empty prompt but the PM forgot to wrap it with delta markers AND mechanical injection failed. Distinguishes "PM should have emitted markers but didn't" from genuine `delegation_delta_skip` reasons (kill switch, no orchestration, empty prompt). Fires alongside `delegation_delta_skip(markers_missing)` so legacy consumers are unaffected.

```json
{
  "type": "delegation_delta_marker_missing",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "spawn_target_agent": "developer",
  "spawn_id": "..."
}
```

Field notes:
- Only fires when the Agent tool call is valid (non-empty prompt, recognised `subagent_type`) — pure prose-loss signal.
- `spawn_id` is `null` when the PM did not include one in the spawn payload.
- Kill switch: `ORCHESTRAY_DELEGATION_DELTA_MARKER_TRACK_DISABLED=1` (default-on).
- Healthy ratio: `delegation_delta_marker_missing` ≪ `delegation_delta_emit` indicates the PM is wrapping prompts. A high ratio means F-PM-1 prose has rotted.

### `spawn_escalation_hint_seen` event

Emitted by `bin/validate-task-completion.js` (TaskCompleted/SubagentStop, v2.2.9 B-5.1) when a write-capable specialist agent (developer, refactorer, security-engineer) returns with a transcript containing an escalation-hint pattern (e.g. "TODO escalate to <role>", "needs <role> review", "should be reviewed by <role>") but did NOT call `mcp__orchestray__spawn_agent` to spawn the suggested helper. Pure observability — does not block the agent. Distinguishes "agent surfaced follow-up" from "agent escalated mechanically".

```json
{
  "type": "spawn_escalation_hint_seen",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "requester_agent": "developer",
  "suggested_agent": "security-engineer",
  "regex_match": "TODO: escalate to security-engineer for crypto review"
}
```

Field notes:
- `requester_agent` ∈ `{developer, refactorer, security-engineer}` — the targeted write-capable specialists.
- `suggested_agent` ∈ `{reviewer, architect, security-engineer, tester, documenter, debugger, refactorer, developer, researcher, inventor, ux-critic, platform-oracle, release-manager}`.
- `regex_match`: ≤ 200 chars of the matched substring for diagnostic context.
- Optional fields: `session_id`, `hook` (always `validate-task-completion`).
- **`feature_optional: true`** — only fires when the regex catches something. A zero-fire baseline does NOT mean broken telemetry.
- Kill switch: `ORCHESTRAY_SPAWN_ESCALATION_HINT_TRACK_DISABLED=1` (default-on).
- Pairs with `spawn_requested` (the mechanical escalation): when `spawn_escalation_hint_seen` fires but no `spawn_requested` follows for the same `orchestration_id`, the escalation was identified but not actioned.

### `schema_redirect_bypassed` event

Emitted by `bin/context-shield.js` (PreToolUse:Read, v2.2.9 B-5.2) when a Read of `agents/pm-reference/event-schemas.md` would have triggered the redirect-to-`mcp__orchestray__schema_get` gate but bypassed it via the `FULL_READ_ALLOWED_AGENTS` allowlist (architect, release-manager, documenter) or via the null-agent-type fall-through (orchestrator/PM). Pure observability — does NOT change bypass behavior. Lets operators audit whether the allowlist is too permissive.

```json
{
  "type": "schema_redirect_bypassed",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "agent_type": "architect",
  "file_path": "agents/pm-reference/event-schemas.md",
  "bypass_reason": "allowlist"
}
```

Field notes:
- `agent_type` ∈ `{architect, release-manager, documenter, null}` (the literal string `"null"` when `agent_type` was null/absent on the hook payload).
- `bypass_reason` ∈ `{allowlist, null_agent}`. `allowlist` covers the three named roles; `null_agent` covers orchestrator/PM reads.
- `file_path`: the resolved path being read (always under `agents/pm-reference/event-schemas.md`).
- Kill switch: `ORCHESTRAY_SCHEMA_REDIRECT_BYPASS_TELEMETRY_DISABLED=1` suppresses this event ONLY; the bypass itself remains active.
- **`feature_optional: false`** — required for v2.2.9 W3 G-3b coverage. Zero fires across an active orchestration suggests the bypass path is dead and the allowlist can be tightened.

### `group_boundary_violation` event

Emitted by `bin/gate-agent-spawn.js` (PreToolUse:Agent, v2.2.9 B-5.3 / W1 F-PM-13) when a PM `Agent()` spawn targets a task in a group that is STRICTLY AFTER the orchestration's `current_group`. With the gate active (default-on) the spawn is blocked with exit 2; with the kill switch on (`ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED=1`) the spawn is permitted but the violation is STILL emitted so the violation count remains observable.

```json
{
  "type": "group_boundary_violation",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "spawn_target": "B-5.3",
  "current_group": "A1",
  "target_group": "B",
  "agent_role": "developer",
  "kill_switch_active": false
}
```

Field notes:
- `spawn_target`: the task identifier resolved from the spawn payload (`tool_input.task_id`, then a regex over `description`/`prompt`).
- `current_group`: read from `**current_group**: <id>` in `.orchestray/state/orchestration.md`.
- `target_group`: read from `.orchestray/state/task-graph.md` (heading-delimited groups OR inline `[group: X]` markers).
- `agent_role`: `tool_input.subagent_type` (specialist role name).
- `kill_switch_active`: `true` when the gate is bypassed via `ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED=1`. The event still emits in this case (observability preserved).
- Fail-open: when either state file is missing/unparseable OR the target task is not in the graph, NO violation is emitted (gate is permissive — no scope to enforce).
- Group ordering: leading-letter compare (A < B < C ...), then trailing numeric (A1 < A2 < A3). Groups that share a letter prefix but differ only by suffix are ordered by suffix.
- Default-on. Kill switch documented above.

### `agent_max_turns_violation` event

Emitted by `bin/gate-agent-spawn.js` (PreToolUse:Agent) when an `Agent()` spawn requests `maxTurns` greater than `spawn.max_turns_hard_cap` (default 200). Spawn is hard-blocked.

```json
{
  "type": "agent_max_turns_violation",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "spawn_target": "developer",
  "requested_turns": 999,
  "hard_cap": 200
}
```

Field notes:
- v2.2.9 B-7.1 (W1 F-PM-18): mechanises the prose-only base_turns table at pm.md:872-885 by enforcing a single hard ceiling read from `.orchestray/config.json`.
- Operator override: raise `spawn.max_turns_hard_cap` in config (no env kill switch — per-call permission is the escape hatch).

### `repo_map_threshold_drift` event

Emitted by `bin/_lib/repo-map-drift-detector.js` (called from periodic validation) when a numeric threshold cited in pm.md / phase-*.md prose disagrees with `.orchestray/config.json` `repo_map_thresholds.*`.

```json
{
  "type": "repo_map_threshold_drift",
  "version": 1,
  "timestamp": "ISO 8601",
  "config_value": 96,
  "pm_prose_value": 64,
  "source_pm_line": 247
}
```

Field notes:
- v2.2.9 B-7.2 (W1 F-PM-11, F-PM-19): warn-only in v2.2.9 (`repo_map_thresholds.shadow_mode: true`); flips to hard-error in v2.2.10.
- `source_pm_line` may be in `pm.md`, `phase-execute.md`, `phase-decomp.md`, or `phase-close.md`.

### `kb_index_invalid` event

Emitted by `bin/validate-kb-index.js` (PreToolUse:Edit|Write|mcp__orchestray__kb_write) when `.orchestray/kb/index.json` fails structural validation. The triggering write is hard-blocked.

```json
{
  "type": "kb_index_invalid",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "index_path": "/abs/.orchestray/kb/index.json",
  "reason": "parse_error"
}
```

Field notes:
- v2.2.9 B-7.3 (W1 F-PM-26): mechanises the prose-only "update index.json" KB-write protocol.
- `reason` enum: `parse_error`, `root_not_object`, `entries_not_array`, `entry_<i>_bad_id`, `entry_<i>_bad_path`, `entry_<i>_path_unsafe`, `entry_<i>_duplicate_id_<id>`, `bucket_<name>_not_array`, `read_error`.

### `agent_model_unspecified_blocked` event

Emitted by `bin/gate-agent-spawn.js` when an `Agent()` spawn omits the `model` parameter and the v2.2.9 default hard-block is active (`ORCHESTRAY_STRICT_MODEL_REQUIRED != '0'`).

```json
{
  "type": "agent_model_unspecified_blocked",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "spawn_target": "developer"
}
```

Field notes:
- v2.2.9 B-7.4 (W1 F-PM-17, locked per scope-lock #4): default hard-block. Set `ORCHESTRAY_STRICT_MODEL_REQUIRED=0` to disable the gate and restore the legacy auto-resolve cascade.
- The pm.md:1879 soft-mode prose has been deleted in this release.

### `cite_unlabelled_detected` event

Emitted by `bin/scan-cite-labels.js` (Stop) when assistant output contains an `@orchestray:pattern://<slug>` URL that lacks a `[label]` (e.g., `[local]`, `[shared]`, `[team]`) immediately after.

```json
{
  "type": "cite_unlabelled_detected",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "pattern_url": "@orchestray:pattern://retry-on-flake",
  "surrounding_text": "...we apply @orchestray:pattern://retry-on-flake here..."
}
```

Field notes:
- v2.2.9 B-7.5 (W1 F-PM-27): warn-tier — never blocks the spawn or stop. Promotes to hard-block in a future release.
- `surrounding_text` truncated to 200 chars for log hygiene.

### `auto_trigger_expired` event

Emitted by `bin/_lib/auto-trigger-ttl.js` (called from `bin/expire-auto-trigger.js`, UserPromptSubmit early-tail) when `.orchestray/auto-trigger.json` is older than `auto_trigger_ttl_seconds` (default 3600) and gets unlinked.

```json
{
  "type": "auto_trigger_expired",
  "version": 1,
  "timestamp": "ISO 8601",
  "age_seconds": 7400,
  "file_path": "/abs/.orchestray/auto-trigger.json"
}
```

Field notes:
- v2.2.9 B-7.6 (W1 F-PM-25, folded from defer list per scope-lock #1): mechanises the prose-only "DELETE the auto-trigger.json file immediately" lifecycle invariant.
- TTL is reset every UserPromptSubmit; a marker that survives one TTL window is treated as orphaned.

### `dual_install_divergence_detected` event

Emitted by `bin/release-manager/dual-install-parity-check.js` (v2.2.9 B-6.1, SubagentStop on the release-manager agent and on manual CLI invocation) once per divergent file when canonical `bin/` and installed `.claude/orchestray/bin/` disagree. Replaces the prior prose-only "release-manager must verify dual-install parity" convention.

```json
{
  "type": "dual_install_divergence_detected",
  "version": 1,
  "timestamp": "ISO 8601",
  "orchestration_id": "...",
  "file_path": "relative/path/from/bin.js",
  "divergence_type": "orphan",
  "source_hash": null,
  "target_hash": "sha256-hex"
}
```

Field notes:
- `divergence_type` ∈ `{orphan, content_mismatch}`. `orphan` = file present in `.claude/orchestray/bin/` but not in `bin/` (a stale installer artefact). `content_mismatch` = same relative path in both but different SHA-256 (dedup pass dropped a hook update; install ran on a divergent branch; etc.).
- `source_hash` / `target_hash` — SHA-256 hex of the canonical (`bin/`) and installed (`.claude/orchestray/bin/`) copies respectively. `null` when the file is missing on that side (orphans always have `source_hash: null`).
- `feature_optional: false` — this event is REQUIRED to fire on every dual-install divergence; F3's promised-event tracker SHOULD alarm if dark across releases.
- Kill switch: `ORCHESTRAY_DUAL_INSTALL_CHECK_DISABLED=1` is honored only for non-release SubagentStop invocations. Releases (subagent_type === `release-manager`) always parity-check (scope-lock #3).

### `pm_emit_backstop_engaged`

Emitted by `bin/pm-emit-state-watcher.js` (PostToolUse:Edit|Write|MultiEdit hook,
v2.2.9 B-8) whenever the watcher had to fire one of 4 prose-only PM emits on
the PM's behalf because the PM did not emit it within the recent-emit window
(30 s) of mutating the corresponding state file. Pairs 1:1 with the
backstop-emitted underlying event (`tier2_invoked`, `pattern_roi_snapshot`,
`verify_fix_start`, or `consequence_forecast`) — both rows are written in the
same hook invocation.

```json
{
  "version": 1,
  "type": "pm_emit_backstop_engaged",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "original_event_type": "tier2_invoked | pattern_roi_snapshot | verify_fix_start | consequence_forecast",
  "source_state_file": ".orchestray/...",
  "finding_ref": "F-PM-7 | F-PM-9 | F-PM-12 | F-PM-21"
}
```

Field notes:
- `original_event_type`: the event the PM was supposed to emit. The watcher
  ALSO writes that event with `source: "state_watcher_backstop"` — query for
  paired rows to reconstruct the missed-emit context.
- `source_state_file`: project-relative path that triggered the watcher.
- `finding_ref`: W1 finding slug (`F-PM-7` / `F-PM-9` / `F-PM-12` / `F-PM-21`)
  for traceability back to the v2.2.9 mechanisation plan.

Kill switch: `ORCHESTRAY_PM_EMIT_WATCHER_DISABLED=1`. Schema stability:
additive-only.

---

### `pm_emit_prose_rotting`

Emitted by `bin/audit-pm-emit-coverage.js` (Stop hook tail, v2.2.9 B-8.2) at
orchestration close, ONCE per watched event-type for which backstop emits
outnumbered PM-prose emits over the threshold (`backstop_count / total >
0.5`, with a floor of 2 total emits to avoid alarming on a single
backstop). Tells the operator that a section of pm.md has decayed below
"good enough" and the prose half of the dual prose-AND-mechanism block
should be deleted in the next release.

```json
{
  "version": 1,
  "type": "pm_emit_prose_rotting",
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<current orch id>",
  "event_type": "tier2_invoked | pattern_roi_snapshot | verify_fix_start | consequence_forecast",
  "pm_count": 1,
  "backstop_count": 4,
  "ratio": 0.8
}
```

Field notes:
- `pm_count`: number of rows of `event_type` for this orch where
  `source !== "state_watcher_backstop"`.
- `backstop_count`: number of rows where `source === "state_watcher_backstop"`.
- `ratio`: `backstop_count / (pm_count + backstop_count)` rounded to floating
  point. Always > 0.5 when the row is emitted.

Kill switch: `ORCHESTRAY_PM_EMIT_WATCHER_DISABLED=1`. Schema stability:
additive-only.
