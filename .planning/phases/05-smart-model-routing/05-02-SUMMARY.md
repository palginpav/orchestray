---
phase: 05-smart-model-routing
plan: 02
subsystem: metrics
tags: [pricing, model-routing, audit, cost-savings, opus-baseline]

# Dependency graph
requires:
  - phase: 05-smart-model-routing plan 01
    provides: routing_outcome events in events.jsonl, model routing config settings
provides:
  - Correct pricing constants (Opus $5/$25, Haiku $1/$5) in metrics script
  - model_used resolution from routing_outcome events by orchestration_id + agent_type
  - Opus-baseline cost calculation for savings comparison
  - Model Routing report section with routing decisions and dual savings analysis
  - Model column in Cost Breakdown table
affects: [report-generation, cost-tracking, routing-tuning]

# Tech tracking
tech-stack:
  added: []
  patterns: [routing-outcome-lookup, dual-savings-calculation, opus-baseline-comparison]

key-files:
  created: []
  modified:
    - bin/collect-agent-metrics.js
    - skills/orchestray:report/SKILL.md

key-decisions:
  - "Resolve model_used by reverse-scanning events.jsonl for routing_outcome events -- handles escalation by finding the most recent match"
  - "Opus baseline cost calculated for every agent_stop event regardless of routing -- enables savings analysis even for mixed orchestrations"

patterns-established:
  - "Routing lookup pattern: reverse-scan allEvents for routing_outcome by orchestration_id + agent_type"
  - "Dual savings reporting: actual cost vs Opus baseline, plus historical comparison when available"

requirements-completed: [ROUT-02, ROUT-03]

# Metrics
duration: 2min
completed: 2026-04-07
---

# Phase 5 Plan 2: Metrics & Report Routing Summary

**Corrected model pricing (Opus/Haiku), added routing_outcome-based model resolution, and dual cost savings analysis in audit reports**

## Performance

- **Duration:** 2 min
- **Started:** 2026-04-07T11:42:30Z
- **Completed:** 2026-04-07T11:44:25Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Fixed stale pricing constants: Opus from $15/$75 to $5/$25, Haiku from $0.25/$1.25 to $1/$5
- Added resolveModelUsed() that looks up routing_outcome events by orchestration_id + agent_type (reverse scan for escalation handling)
- Enhanced getPricing() with routing-resolved model priority over agent_type inference
- Added model_used and estimated_cost_opus_baseline_usd fields to audit events
- Added Model Routing section to report skill with routing decisions table and dual savings analysis
- Added Model column to Cost Breakdown table and model info to Audit Trail

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix pricing constants and resolve model_used from routing_outcome events** - `ff24ff9` (feat)
2. **Task 2: Add model routing summary and savings table to report skill** - `dd2da6e` (feat)

## Files Created/Modified
- `bin/collect-agent-metrics.js` - Fixed pricing, added resolveModelUsed(), opus baseline cost, model_used field
- `skills/orchestray:report/SKILL.md` - Added Model Routing section, Model column, dual savings analysis

## Decisions Made
- Resolve model_used by reverse-scanning events.jsonl for routing_outcome events -- most recent match wins, correctly handles escalation scenarios
- Calculate opus baseline cost for every agent_stop event regardless of whether routing was active -- enables savings analysis even for partially-routed orchestrations

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phase 5 (Smart Model Routing) is now complete: routing protocol in PM agent (plan 01) + metrics and reporting (plan 02)
- Routing decisions are visible in audit reports with per-subtask model assignments and cost savings
- Ready for Phase 6 (Persistent Specialist Registry) which benefits from routing infrastructure

---
*Phase: 05-smart-model-routing*
*Completed: 2026-04-07*
