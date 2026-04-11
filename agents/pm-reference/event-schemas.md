# Event Schemas Reference

JSON event schemas used by the PM agent for audit trail logging. These events are appended
to `.orchestray/audit/events.jsonl`.

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

### Consumer guidance

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

```json
{
  "escalation_count": 1,
  "escalated_from": "haiku",
  "model_assigned": "sonnet",
  "result": "escalated"
}
```

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
- `outcome`: Derived from `tool_result.isError` — `"answered"` if the call succeeded,
  `"error"` if `isError === true`, `"skipped"` if `tool_result` is absent or null.
- `phase`: Derived from the presence of `.orchestray/state/routing.jsonl` at hook time —
  `"post-decomposition"` if the file exists, `"pre-decomposition"` otherwise.
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

RESERVED. As of 2.0.12, `bin/gate-agent-spawn.js` blocks a spawn that is missing
required pre-decomposition MCP checkpoints by exiting with code 2 and writing a
diagnostic to stderr — but it does **not** write an `mcp_checkpoint_missing` audit
event to `events.jsonl`.

Consumers tracking blocked spawns should use the absence of a subsequent
`routing_outcome` row for a given `(orchestration_id, agent_type)` pair as the
blocking signal, rather than expecting this event type.

**INFO for T10 reviewer:** DESIGN §D4 item 2 specified this event as emitted by
`gate-agent-spawn.js`. Grep of `bin/gate-agent-spawn.js` confirms the string
`mcp_checkpoint_missing` does not appear in the file — no audit event is emitted.
T10 should confirm whether this is a T3 scope gap and whether the event should be
added to a future release. If added, the expected shape would be:

```json
{
  "timestamp": "<ISO 8601>",
  "type": "mcp_checkpoint_missing",
  "orchestration_id": "<current orch id>",
  "missing_tools": ["kb_search", "history_find_similar_tasks"],
  "diagnostic": "<first line of stderr block message>"
}
```

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
