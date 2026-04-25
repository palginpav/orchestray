---
section: Tier 2 — Handoff Contract
audience: all-subagents
always_load: true
owner: architect
version: 1
---

# Handoff Contract — Universal Structured Result Schema

## 1. Purpose

Every Orchestray subagent ends its output with a single `## Structured Result` JSON
block so that the PM (or the next agent in a chain) can parse the outcome
deterministically without re-reading free-form prose, and so the T15 pre-done
checklist hook (`bin/validate-task-completion.js`, fires on `SubagentStop` and
`TaskCompleted`) can gate completion on a minimal set of required fields. One
schema covers all 12 core agent roles plus specialists; role-specific extensions
are additive, optional, and documented below. This file is the canonical
reference cited by all agent prompts — when an agent and this file disagree, this
file wins.

## 2. Required fields (BLOCKED if missing on hard-tier agents)

| field | type | required | notes |
|---|---|---|---|
| `status` | enum `"success" \| "partial" \| "failure"` | yes | Must be exactly one of these three strings. Any other value is treated as malformed. |
| `summary` | string, non-empty, ≤500 chars | yes | Single-paragraph abstract of the task outcome. No bulleted essay. |
| `files_changed` | array of `{path: string, description: string}` | yes (may be empty) | Every path MUST be one the agent actually wrote. Empty array is legal for read-only agents. |
| `files_read` | array of strings | yes (may be empty) | MUST be non-empty when `files_changed.length > 0` — this is the CRITIC evidence the T15 hook cross-checks per design-spec §5 I-12 item (d). |
| `issues` | array of `{severity: "error" \| "warning" \| "info", text: string}` | yes (may be empty) | One entry per distinct issue. `severity: "error"` is incompatible with `status: "success"`. |
| `assumptions` | array of strings | yes (may be empty) | Per design-spec §5 I-12 item (c), the field MUST appear even when empty. Absence means the agent skipped the step; empty array means the agent deliberately made no assumptions. |

Hard-tier agents (see §6) are blocked by exit 2 on any missing/malformed field.
Warn-tier agents log a `task_completion_warn` audit event but are not blocked.

## 3. Required fields for design-producing agents

When the task produced, audited, or materially modified a design artifact (a
DESIGN.md, an interface contract, a refactor plan, a test plan, a rubric),
add one more required field:

| field | type | required when | notes |
|---|---|---|---|
| `acceptance_rubric` | object `{passed_count: N, total_count: N, rubric_ref: string}` OR inline list | role ∈ {architect, developer, reviewer, refactorer, tester, security-engineer} AND artifact is design-like | Format and syntax are defined in `agents/pm-reference/rubric-format.md`. `rubric_ref` is a path or anchor pointing to the rubric the score applies to. |

For non-design tasks (pure docs edits, telemetry plumbing, a README sweep) the
field is optional. When in doubt, emit it — extra structure is harmless, missing
structure blocks.

## 4. Conditional / recommended fields (per role)

These are optional, additive extensions. Emit what applies; omit the rest.

### architect
- `design_decisions` — array of `{decision: string, rationale: string}`
- `alternatives_considered` — array of strings, one per rejected option
- `open_questions` — array of strings; empty means no unresolved questions

### developer
- `tests_added` — array of test file paths
- `tests_passing` — boolean; MUST reflect an actual run, not a projection
- `commits` — array of `"<sha> <subject>"` strings, one per commit created

### reviewer
- `verdict` — enum `"APPROVE" | "APPROVE_WITH_NITS" | "BLOCK"`
- `findings_by_severity` — object `{error: N, warning: N, info: N}`

### refactorer
- `behavior_preserved` — `{value: boolean, rationale: string}` (one sentence)
- `surface_unchanged` — boolean (public API / export shape untouched)

### tester
- `test_suite_result` — object `{total: N, pass: N, fail: N}`
- `new_tests_added` — array of test file paths

### release-manager
- `version_bumped` — string (the new version, e.g. `"2.1.9"`)
- `changelog_updated` — boolean
- `readme_updated` — boolean (per the "release commits must sweep README" rule)
- `npm_publish_verified` — boolean (per I-09; must be true before tag)
- `tag_created` — boolean

### documenter
- `files_documented` — array of paths
- `canonical_source_checked` — boolean (per I-07 — did you grep the canonical
  source before tightening claim language?)

### ux-critic
- `surfaces_reviewed` — array of strings (command names, error IDs, file paths)
- `consistency_findings` — array of `{surface: string, finding: string}`

### researcher
- `verdict` — enum `"RECOMMEND" | "DO_NOT_RECOMMEND" | "NEEDS_MORE_INFO"`
- `top_pick` — string (the recommended option / library / approach)
- `sources_cited` — array of URLs, minimum 3

### debugger
- `root_cause` — string (one-sentence causal claim)
- `repro_confirmed` — boolean (did you reproduce before hypothesising?)
- `fix_location_hint` — string (file path + approximate line range)

### security-engineer
- `threats_found` — array of `{threat: string, severity: string, location: string}`
- `severity_breakdown` — object `{critical: N, high: N, medium: N, low: N, info: N}`

### platform-oracle
- `claims` — array of `{text: string, stability_tier: "stable" | "experimental" | "community", source_url: string}`

### inventor
- `novel_mechanism` — string (one-sentence description of what is new)
- `prototyped` — boolean (does a runnable sketch exist, even if throwaway?)

### curator (specialist)
- `compact_delta_bytes` — integer (KB removed / added to KB)
- `facts_deduped` — integer
- `decisions_promoted` — integer

### pattern-extractor (specialist)
- `patterns_found` — integer
- `patterns_promoted` — integer (moved from proposed → active)
- `run_id` — string (the extractor run identifier)

### release-manager (specialist variant)
- Same as the release-manager core role above; specialists inherit the role's
  required fields and may add a `release_kind` string (e.g. `"patch"`, `"minor"`).

## 5. Emission protocol

How an agent emits its Structured Result:

1. The block lives in the agent's final assistant message under a section titled
   exactly `## Structured Result` (case-sensitive match on `Structured Result`;
   the regex used by the hook is
   `/##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i`).
2. The section body MUST be a single fenced code block. Prefer ` ```json` for
   clarity; a bare ` ``` ` is accepted by the parser.
3. Inside the fence is one valid JSON object, with all required fields at the
   top level. No commentary inside or outside the fence between this section
   header and its closing backticks.
4. Place the `## Structured Result` section as the **last** section of the
   output. The parser tail-scans the last 64 KB; anything earlier can be
   truncated.
5. Do NOT emit partial / draft Structured Result blocks earlier in the output.
   Only the final block is consumed; multiple blocks are an anti-pattern (§8).
6. On partial work (`status: "partial"`), populate `issues` with what remains
   and `assumptions` with anything you decided to treat as given rather than
   verify.
7. On failure (`status: "failure"`), `summary` explains what blocked you and
   `issues` lists the specific errors. `files_changed` may still be non-empty
   if you made partial edits before the block.

## 6. T15 hook enforcement (read-only; informational)

The T15 pre-done checklist hook lives at `bin/validate-task-completion.js` and
fires on both the `TaskCompleted` event (Agent Teams mode) and the
`SubagentStop` event (normal subagent dispatch). The enforcement contract is:

- **Hard-tier agents** (missing/malformed Structured Result → **exit 2**, blocks
  the completion): `developer`, `architect`, `reviewer`, `refactorer`, `tester`,
  `release-manager`, `documenter`. Defined in `validate-task-completion.js:45-53`.
- **Warn-tier agents** (missing/malformed → `task_completion_warn` audit event,
  exit 0, does not block): `researcher`, `debugger`, `inventor`,
  `security-engineer`, `ux-critic`, `platform-oracle`. Defined in
  `validate-task-completion.js:54-61`.
- The exact required-section set enforced by the hook is declared at
  `bin/validate-task-completion.js:63` —
  `['status', 'summary', 'files_changed', 'files_read', 'issues', 'assumptions']`.
  This file's §2 is a strict superset of that set; any additional contract here
  is advisory unless a downstream agent or scorer enforces it.
- On unexpected errors (malformed JSON in the hook payload, disk read failure,
  etc.) the hook fails open — it only blocks on the specific rules listed above.

## 7. Worked example (developer)

A minimally-realistic developer Structured Result for a task that added a
new hook and its unit tests:

```json
{
  "status": "success",
  "summary": "Added bin/reassign-idle-teammate.js (TeammateIdle handler) and 4 tests. Hook redirects idle teammates to remaining tasks instead of letting them stop. Lint + tests green.",
  "files_changed": [
    {"path": "bin/reassign-idle-teammate.js", "description": "new TeammateIdle hook handler"},
    {"path": "test/bin/reassign-idle-teammate.test.js", "description": "4 unit tests covering happy path + 3 error branches"},
    {"path": "hooks/hooks.json", "description": "registered TeammateIdle matcher"}
  ],
  "files_read": [
    "bin/validate-task-completion.js",
    "hooks/hooks.json",
    "agents/pm-reference/event-schemas.md"
  ],
  "issues": [
    {"severity": "info", "text": "Hook fails open on unknown payload shape — matches validate-task-completion.js convention; noted for reviewer."}
  ],
  "assumptions": [
    "TeammateIdle event payload has the same envelope as TaskCompleted (verified in event-schemas.md)",
    "Idle teammates should NOT be reassigned across orchestration boundaries — scoped to current orchestration_id"
  ],
  "acceptance_rubric": {
    "passed_count": 5,
    "total_count": 5,
    "rubric_ref": "docs/designs/teammate-idle-hook.design.md#acceptance-rubric"
  },
  "tests_added": ["test/bin/reassign-idle-teammate.test.js"],
  "tests_passing": true,
  "commits": ["a1b2c3d feat: add TeammateIdle hook handler"]
}
```

## 8. Anti-patterns

Do NOT do any of the following. Each has been observed breaking downstream
parsers, scorers, or human reviewers.

- **Omitting `assumptions` when you did make assumptions.** Silence is not zero
  assumptions. Empty array is legal; missing field is a hook block.
- **Summary as bulleted essay.** `summary` is a single-paragraph abstract, ≤500
  characters. If you need more space, use `design_decisions` (architect) or
  `issues` (any role). Parsers truncate long summaries.
- **`status: "success"` with `issues[i].severity === "error"`.** Contradictory
  on its face. Either downgrade the issue to `warning`/`info` with rationale,
  or set `status: "partial"` or `"failure"`.
- **Multiple `## Structured Result` sections.** Only the last is parsed (tail
  scan, 64 KB window). Earlier drafts inside the same output will be silently
  dropped — and worse, if a later section lacks a proper fence, the parser can
  stitch the wrong payload.
- **`files_changed` listing paths you did not actually write.** The
  structural scorer (B4) cross-checks this against the git index and docks
  `structural_score` on mismatch. Lying here also poisons the reviewer's
  file-list scope.
- **Claiming `tests_passing: true` without having run them.** The CRITIC step
  (§5 I-12 (d)) exists precisely to prevent this. Run the suite; capture the
  result; then emit.
- **Putting the Structured Result in the middle of the output.** Tail scan only.
- **Wrapping the JSON in extra prose inside the fence.** The fence body must
  parse as a single JSON object, nothing else.

## 9. MCP projection conventions (R-PFX, v2.1.14)

All agents that call `pattern_find` or `kb_search` MUST pass the `fields` projection
argument by default. This reduces response size by 93%+ (measured in v2.1.12 telemetry)
and avoids burning tokens on full pattern bodies that agents almost never need on the
first call.

### Default `fields` shapes

| Tool | Default `fields` value | Purpose |
|------|------------------------|---------|
| `pattern_find` | `["slug", "confidence", "one_line"]` | Compact index: enough to decide whether the pattern is relevant |
| `kb_search` | `["uri", "section", "excerpt"]` | Compact index: excerpt tells you if the entry is worth fetching |

### Follow-up full-body call pattern

If the compact index surface suggests a match is highly relevant but the agent needs the
full pattern or KB document body, issue a second call **without `fields`** (or with
`fields: null`) to retrieve the complete response. This two-step pattern ensures most
calls stay cheap while exact reads are still possible on demand.

Example:
1. First call: `pattern_find(task_summary="...", fields=["slug","confidence","one_line"])`
2. If a returned slug looks like an exact match: follow-up read via the URI or a second
   `pattern_find` call with `fields` omitted to get the full body.

### Reviewer exception

When the reviewer agent is auditing the correctness of the pattern library itself
(i.e., reviewing pattern files, not applying them to a code review), it SHOULD request
full bodies by omitting `fields` or passing `fields: null`. This exception applies only
to pattern-accuracy review tasks — all other reviewer calls use the default projection.

### Kill switch

Agents may always pass `fields: null` or omit the argument to get the full legacy
response. There is no config gate. Rollback is reverting the 5 agent prompt edits.

## 10. Change log

- v1 — v2.1.9 initial schema (2026-04-20)
- v2 — v2.1.14 added §9 MCP projection conventions (R-PFX)
