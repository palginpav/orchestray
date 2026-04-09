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
