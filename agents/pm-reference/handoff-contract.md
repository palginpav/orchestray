---
id: handoff-contract
title: Universal Structured Result Handoff Contract
tier: 2
load_when: "always"
---

# Universal Structured Result Handoff Contract

Every agent in the orchestration system MUST include a `## Structured Result` block
in its response. This document defines the canonical schema.

The PM's T15 hook (`bin/validate-task-completion.js`) reads this block to gate
task completion. Missing or malformed blocks cause exit(2) blocks.

---

## §1 Universal Fields (all agents)

Every structured result MUST include these fields:

```json
{
  "status": "success | partial | failure",
  "summary": "<one sentence, ≤30 words>",
  "files_changed": ["<list of files created or modified>"],
  "files_read": ["<list of files consulted for context>"],
  "issues": [
    {
      "severity": "error | warning | info",
      "description": "<≤30 words, includes file path and actionable detail>"
    }
  ],
  "assumptions": ["<list, MAY be empty for warn-tier agents>"]
}
```

### Field semantics

- **`status`**: `"success"` = task complete, no blockers. `"partial"` = some work done,
  blockers remain. `"failure"` = could not proceed.
- **`files_changed`**: Every file created or modified. Reviewer/debugger/researcher
  always return `[]`.
- **`files_read`**: Files consulted. If `files_changed` is non-empty, this MUST also
  be non-empty (CRITIC evidence — structural check 4).
- **`issues`**: Findings. If any issue has `severity: "error"`, `status` must NOT be
  `"success"` (structural check 5).
- **`assumptions`**: Hard-tier agents (architect, developer, reviewer) MUST provide
  at least one assumption. Warn-tier agents MAY provide an empty array.

---

## §2 Developer extension fields

```json
{
  "tests_passing": true,
  "commits": ["<sha> <subject>"]
}
```

---

## §3 Architect extension fields

```json
{
  "design_artifact": "<path to the written design document>",
  "rubric_score": { "coverage": 0.9, "risk_identified": true }
}
```

---

## §4 Role-specific fields

### §4.security-engineer

Security-engineer outputs include a `security_summary` extension:

```json
{
  "security_summary": {
    "mode": "design_review | implementation_audit",
    "scope_covered": ["<area 1>", "<area 2>"],
    "severity_breakdown": {
      "critical": 0,
      "high": 0,
      "medium": 1,
      "low": 2,
      "info": 3
    },
    "top_risk": "<one-sentence description of the highest-severity finding, or null>"
  }
}
```

`severity_breakdown` has **5 keys**: `critical`, `high`, `medium`, `low`, `info`.
The `info` key is required — it captures informational findings that do not rise to
warning or error severity but are worth tracking. Do not omit it.

`files_changed` is always `[]` for security-engineer (read-only role).

### §4.debugger

```json
{
  "diagnosis": {
    "root_cause": "<string>",
    "confidence": "high | medium | low",
    "affected_files": ["<file>"],
    "fix_strategy": "<string>",
    "risk_assessment": "<string>",
    "related_issues": []
  }
}
```

`files_changed` is always `[]` for debugger (read-only role).

### §4.release-manager

```json
{
  "release_version": "<version string>",
  "release_artifacts_written": ["<files>"],
  "version_bumped": true,
  "changelog_updated": true,
  "readme_updated": true,
  "event_schemas_refreshed": true,
  "release_readiness_green": true,
  "pre_publish_verified": true,
  "npm_publish_verified": true,
  "tag_created": false,
  "post_release_smoke": true,
  "commit_sha": "<sha or null>",
  "refusal_reason": null
}
```

### §4.tester

```json
{
  "test_summary": {
    "tests_added": 0,
    "tests_modified": 0,
    "coverage_gaps_remaining": []
  }
}
```

### §4.refactorer

```json
{
  "refactoring_summary": {
    "goal": "<string>",
    "steps_completed": 0,
    "steps_planned": 0,
    "verification": {
      "tests_before": { "pass": 0, "fail": 0, "skip": 0 },
      "tests_after":  { "pass": 0, "fail": 0, "skip": 0 },
      "methods_used": ["test_suite"]
    }
  }
}
```

### §4.researcher

`files_changed` is always `[]`.

```json
{
  "research_summary": {
    "goal": "<one-line goal>",
    "candidates_surveyed": 5,
    "verdict": "recommend_existing | recommend_build_custom | no_clear_fit | inconclusive",
    "top_pick": "<name or null>",
    "artifact_location": "<path>",
    "next_agent_hint": "architect | inventor | debugger | stop"
  }
}
```

---

## §5 Structural scoring (B4 Eval Layer 1)

`bin/_lib/scorer-structural.js` evaluates every structured result against 6 checks
and writes a `structural_score` row to `.orchestray/metrics/agent_metrics.jsonl`.
See `agents/pm-reference/observability.md` for the full schema.

The 6 checks:
1. Structured Result block parseable JSON
2. `status` ∈ `{success, partial, failure}`
3. `assumptions` array present (non-empty for hard-tier agents)
4. If `files_changed.length > 0` then `files_read.length > 0`
5. If `issues[]` has `severity=error`, then `status !== "success"`
6. Rubric score block present when architect/developer AND upstream design exists

---

## §6 Commit Handoff (W-items)

W-items MUST include a `## Handoff` subsection in the git commit body. See
`agents/pm-reference/agent-common-protocol.md` §Commit Message Discipline for W-Items
for the template and rationale.
