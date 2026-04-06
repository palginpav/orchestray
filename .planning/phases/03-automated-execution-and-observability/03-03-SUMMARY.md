---
phase: 03-automated-execution-and-observability
plan: 03
subsystem: observability
tags: [cost-tracking, audit-trail, pm-agent, report-skill, run-skill]
dependency_graph:
  requires: [03-01, 03-02]
  provides: [pm-cost-display, audit-lifecycle, report-cost-breakdown]
  affects: [agents/pm.md, skills/orchestray:run/SKILL.md, skills/orchestray:report/SKILL.md]
tech_stack:
  added: []
  patterns: [jsonl-event-correlation, running-cost-tally, orchestration-lifecycle-events]
key_files:
  created: []
  modified:
    - agents/pm.md
    - skills/orchestray:run/SKILL.md
    - skills/orchestray:report/SKILL.md
decisions:
  - "Cost display uses tilde-prefixed dollar amounts with pipe separation for readability"
  - "Audit archive moves events.jsonl per-orchestration to history for immutable trail"
  - "Missing events.jsonl handled gracefully -- cost sections omitted silently"
metrics:
  duration: 2min
  completed: "2026-04-07T09:04:26Z"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
---

# Phase 03 Plan 03: Cost Tracking, Audit Lifecycle, and Report Extension Summary

PM agent displays running cost tally after each agent completes, initializes audit trail (current-orchestration.json + orchestration_start event) before spawning, writes orchestration_complete with token totals on finish; run skill references parallel execution and audit init; report skill reads events.jsonl to produce Cost Breakdown and Audit Trail tables.

## What Was Done

### Task 1: Add cost tracking section (Section 15) and audit lifecycle to PM agent
**Commit:** 9ecf519

Added Section 15 (Cost Tracking and Display) to `agents/pm.md` with three steps:
- **Step 1 (Audit Init):** Generate orchestration_id, create `.orchestray/audit/current-orchestration.json`, append `orchestration_start` event to `events.jsonl`. Must complete before any agent spawns.
- **Step 2 (Running Cost Display):** After each agent completes, read events.jsonl, filter agent_stop events by orchestration_id, display "Agent costs so far: {agent} ~${cost} | Total: ~${total}". Skip silently if no data.
- **Step 3 (Completion Event):** Sum all agent usage/costs, append `orchestration_complete` event, archive events.jsonl to `.orchestray/history/<orch-id>/`, delete current-orchestration.json, include cost summary in final report.
- **Step 4 (Integration):** Documents exactly where each step is called from (Section 0, Section 4, Section 14).

Also updated Section 0 Medium+ Task Path to reference audit initialization (Section 15, step 1) before decomposition, and updated Section 14 to reference completion event and archive.

PM agent now has 16 sections total (0 through 15).

### Task 2: Update run skill and extend report skill with audit and cost data
**Commit:** bc4d976

**Run skill updates:**
- Step 5a: Added audit trail initialization (current-orchestration.json + orchestration_start event)
- Step 5d: Changed from sequential group description to reference Parallel Execution Protocol (Section 14) with running cost display
- Step 6: Added orchestration_complete event, audit archive, cleanup, and per-agent cost breakdown

**Report skill extensions:**
- Step 2: Read events.jsonl from history directory alongside orchestration record
- Step 3: Added Cost Breakdown table (per-agent tokens + estimated cost) and Audit Trail table (chronological event log with HH:MM:SS timestamps)
- Step 4: Added graceful handling when events.jsonl is missing or empty

Both skills retain `disable-model-invocation: true` frontmatter.

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

All automated verification checks passed:
- PM agent contains Section 15 with all required subsections
- Section 0 references audit initialization
- Run skill references current-orchestration.json, orchestration_complete, and Parallel Execution Protocol
- Report skill contains events.jsonl reading, Cost Breakdown, Audit Trail, and estimated_cost_usd
- Both skills retain disable-model-invocation: true

## Self-Check: PASSED
