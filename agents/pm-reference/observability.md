---
id: observability
title: Observability — Agent Metrics Schema Reference
tier: 2
load_when: "observability OR metrics OR structural_score OR agent_metrics"
---

# Observability — Agent Metrics Schema Reference

## agent_metrics.jsonl

All agent spawn and scoring data is written to `.orchestray/metrics/agent_metrics.jsonl`.
Rows are appended via `appendJsonlWithRotation` (same rotation policy as other JSONL
files in the system).

### Row Types

The file contains rows of two types, distinguished by the `row_type` field.

---

#### `agent_spawn` rows

Written by `bin/collect-agent-metrics.js` on every SubagentStop and TaskCompleted event.

| Field | Type | Description |
|---|---|---|
| `row_type` | `"agent_spawn"` | Discriminator |
| `schema_version` | `number` | Schema version (currently `1`) |
| `timestamp` | ISO-8601 string | Wall-clock time of agent stop |
| `orchestration_id` | string | The orchestration this agent belonged to |
| `agent_type` | string | Agent role (e.g. `"developer"`, `"reviewer"`) |
| `agent_id` | string \| null | Agent instance ID from the hook event |
| `session_id` | string \| null | Claude Code session ID |
| `model_used` | string \| null | Resolved model (e.g. `"claude-sonnet-4-6"`) |
| `turns_used` | number | Number of assistant turns in the transcript |
| `usage` | object | Token counts: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` |
| `usage_source` | `"transcript"` \| `"event_payload"` \| `"estimated"` | How token counts were obtained |
| `cost_confidence` | `"measured"` \| `"estimated"` | Quality of cost estimate |
| `estimated_cost_usd` | number | Cost in USD at resolved model rates |
| `model_resolution_note` | string? | Present only when escalation or scan-cap skipped |

---

#### `structural_score` rows

Written by `bin/_lib/scorer-structural.js` via `appendStructuralScore()` after each
SubagentStop event during active orchestrations. B4 Eval Layer 1 — deterministic,
zero model cost.

| Field | Type | Description |
|---|---|---|
| `row_type` | `"structural_score"` | Discriminator |
| `schema_version` | `number` | Schema version (currently `1`) |
| `timestamp` | ISO-8601 string | Wall-clock time of scoring |
| `orchestration_id` | string | The orchestration this agent belonged to |
| `agent_id` | string \| null | Agent instance ID |
| `agent_type` | string \| null | Agent role |
| `structural_score` | number (0.0–1.0) | Fraction of the 6-item checklist passed |
| `checks_passed` | number | Count of checks that passed |
| `checks_total` | number | Always 6 |
| `failures` | string[] | Machine-readable failure codes, one per failed check |

##### Failure codes

| Code | Meaning |
|---|---|
| `check1_unparseable_structured_result:<reason>` | No parseable JSON block found after `## Structured Result` |
| `check2_invalid_status:<value>` | `status` field absent or not in `{success, partial, failure}` |
| `check3_assumptions_not_array` | `assumptions` key is absent or not an array |
| `check3_assumptions_empty_hard_tier:<agent>` | Hard-tier agent (architect/developer/reviewer) submitted empty assumptions |
| `check4_files_changed_without_files_read:changed=<N>` | CRITIC evidence: files changed but no files_read listed |
| `check5_status_success_with_error_issues` | `status=success` but `issues[]` contains `severity=error` or `severity=critical` |
| `check6_rubric_score_missing:<reason>` | Rubric score block absent for architect/developer when upstream design exists |

##### Structural score in ROI rollup

`bin/pattern-roi-aggregate.js` surfaces `structural_score` in per-orchestration rollup
output (both the JSON snapshot at `.orchestray/patterns/roi-snapshot.json` and the
human-readable calibration suggestion artifact in `.orchestray/kb/artifacts/`).

For each pattern, `structural_score` is the average across all `structural_score` rows
from orchestrations where that pattern was applied. Orchestrations without any
`structural_score` rows (pre-B4, or before the scorer ran) report `null` — backfilling
is not a goal.

---

## Interpreting structural_score

| Score range | Meaning |
|---|---|
| 1.0 | All 6 checks passed — structured result is complete and consistent |
| 0.83 | 5/6 checks passed — one check failed |
| 0.67 | 4/6 checks passed — two checks failed |
| < 0.5 | Multiple structural issues — result is likely incomplete |

A score of 0.0 typically means the JSON block was unparseable; all dependent checks
cascade as failed. Use `failures[]` to identify the root cause.
