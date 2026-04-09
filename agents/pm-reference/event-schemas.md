# Event Schemas Reference

JSON event schemas used by the PM agent for audit trail logging. These events are appended
to `.orchestray/audit/events.jsonl`.

---

## Section 19: Routing Outcome Event

Appended after each agent completes (in Section 4 result processing):

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
  "escalated_from": null
}
```

New effort fields:
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

Appended during Section 15 step 7.7 (post-execution drift validation) when
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
