# Phase 7: Skill Learning and Pattern Extraction - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.

**Date:** 2026-04-07
**Phase:** 07-Skill Learning and Pattern Extraction
**Areas discussed:** Pattern extraction trigger & scope, Pattern storage & format, Pattern application during decomposition, Learn skill

---

## Pattern Extraction Trigger & Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Post-orchestration automatic | PM extracts after every successful orchestration + manual via /orchestray:learn | ✓ |
| Manual only | User decides when to extract | |
| Both + periodic review | Auto + manual + periodic PM review and pruning | |

| Option | Description | Selected |
|--------|-------------|----------|
| Four categories | decomposition, routing, specialization, anti-patterns | ✓ |
| Two categories only | decomposition and anti-patterns only | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Both success and failure | Successful → positive patterns. Failed → anti-patterns. | ✓ |
| Success only | Only extract from successful orchestrations | |
| You decide | | |

## Pattern Storage & Format

| Option | Description | Selected |
|--------|-------------|----------|
| Flat directory with category prefix | .orchestray/patterns/{category}-{name}.md | ✓ |
| Category subdirectories | .orchestray/patterns/{category}/{name}.md | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Essential | confidence, times_applied, last_applied, created_from, category | ✓ |
| Detailed | Essential + success_rate, avg_task_complexity, related_patterns[], source_agent | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Max 50, prune lowest confidence | Remove patterns with lowest confidence * times_applied score | ✓ |
| Max 100, prune by staleness | Remove patterns not applied in 90+ days | |
| You decide | | |

## Pattern Application During Decomposition

| Option | Description | Selected |
|--------|-------------|----------|
| Keyword + description matching | PM matches pattern names/descriptions against task. Same as specialist matching. | ✓ |
| Category-first filtering | PM narrows by category first, then matches within category | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Advisory | Patterns inform but don't dictate. PM mentions when applying. | ✓ |
| Prescriptive | High-confidence patterns applied automatically | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, update after result | Success increases confidence, failure decreases it | ✓ |
| No updates, static | Confidence set at extraction and never changes | |
| You decide | | |

## Learn Skill (/orchestray:learn)

| Option | Description | Selected |
|--------|-------------|----------|
| Specific orchestration by ID | /orchestray:learn [orch-id] or most recent if no ID | ✓ |
| All recent orchestrations | Batch scan all unprocessed orchestrations | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Summary + pattern files | Table of extracted patterns, then writes .md files | ✓ |
| Quiet | Write files silently | |
| Interactive | Confirm each pattern before saving | |

## Deferred Ideas

None
