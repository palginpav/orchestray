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

## 9. Task-YAML `contracts:` block (v2.2.11, W3-1)

The `contracts:` key in `.orchestray/state/tasks/*.yaml` declares file ownership
and pre/postconditions for a task. Validated by `bin/validate-task-contracts.js`
on PreToolUse:Agent (pre) and PostToolUse:Agent (post). Soft-warn in v2.2.11;
hard-fail in v2.2.13.

```yaml
contracts:
  schema_version: "1"          # Required when `contracts:` is present
  inputs:                       # Optional — informative only
    - path/to/input-file.md
  outputs:                      # Required — auto-promoted to file_exists postconditions
    - path/to/output-file.md
  preconditions:                # Optional — checked before agent spawn
    - { type: file_exists,    target: path/to/dep.yaml }
    - { type: file_contains,  target: path/to/doc.md, pattern: "^## Section" }
  postconditions:               # Optional — checked after agent completion
    - { type: file_size_min_bytes, target: path/to/output.md, min_bytes: 1000 }
  file_ownership:               # Required when `contracts:` is present
    write_allowed:              # Globs; writes MUST be subset of this list
      - bin/my-feature.js
    write_forbidden:            # Optional belt-and-suspenders deny list
      - bin/**/*.secret.js
    read_allowed: "*"           # Informative only in v2.2.11 (read enforcement deferred to a future release)
```

**Required fields** (when `contracts:` present): `schema_version`, `outputs`, `file_ownership`.

**Kill switch**: `ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED=1` suppresses all validation.
Missing block emits `contract_check_skipped` (disable via `ORCHESTRAY_CONTRACTS_MISSING_WARN_DISABLED=1`).

## 10. MCP projection conventions (R-PFX, v2.1.14; R-CAT-DEFAULT, v2.1.16)

All agents that call `pattern_find` or `kb_search` MUST minimize response size by
default. v2.1.16 layers two defaults: **catalog mode** is the new top-level default
(smallest payload), and the v2.1.14 `fields` projection still applies as the fallback
shape when an agent explicitly opts out of catalog mode.

### Default mode: catalog (R-CAT-DEFAULT, v2.1.16)

Pass `mode: "catalog"` on every `pattern_find` and `kb_search` call. The response is
a TOON-formatted headline list (one line per match: slug/uri, confidence,
times_applied, one_line/excerpt) — no full bodies. Escalate to a full body fetch ONLY
when a catalog headline meets ALL of:

1. `confidence >= 0.6`
2. `times_applied >= 1`
3. The `one_line` (patterns) or `excerpt` (KB) description plainly matches the task.

Skip headlines that don't meet the bar — DO NOT fetch the body just to check. For
patterns, the full-body fetch is `pattern_read(slug)`. For KB, use a direct file
`Read` via the returned URI.

### Kill switch (R-CAT-DEFAULT)

- `.orchestray/config.json` → `"catalog_mode_default": false` flips the prompt-level
  default back to `mode: "full"` (the v2.1.15 shape).
- Env var `ORCHESTRAY_DISABLE_CATALOG_DEFAULT=1` matches the v2.1.14 kill-switch
  convention and overrides the config flag.
- Agents can always pass `mode: "full"` per call without a config change.

### Default `fields` shapes (R-PFX, v2.1.14 — applies under `mode: "full"`)

When `mode: "full"` is explicitly set (kill switch on, or per-call escape), agents
MUST still minimize the response shape by passing `fields`. This reduces response
size by 93%+ (measured in v2.1.12 telemetry) and avoids burning tokens on full
pattern bodies that agents almost never need on the first call.

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
full bodies by omitting `fields` or passing `fields: null` (and similarly may pass
`mode: "full"` to bypass the catalog default). This exception applies only to
pattern-accuracy review tasks — all other reviewer calls use the default projection.

### Kill switch (R-PFX)

Agents may always pass `fields: null` or omit the argument to get the full legacy
response. There is no config gate. Rollback is reverting the 5 agent prompt edits.

### Per-role output token budget reference (v2.2.21, W-AC-1 / W-AC-2)

Every spawn carries an `**Output token budget:** ≤ {N} tokens; structured JSON
exempt.` line in its prompt suffix, computed by `bin/_lib/output-shape.js
decideShape(role)` and injected by `bin/inject-output-shape.js`. The numeric N
is sourced from operator-emitted p95 telemetry at
`.orchestray/state/role-budgets.json` when present; fallback is the
model-tier default (Haiku 30K / Sonnet 50K / Opus 80K). The role → category →
T15 tier mapping below is the SINGLE SOURCE OF TRUTH that agents and the
T15 hook (`bin/validate-task-completion.js`) read in lock-step.

| Role               | Output category   | T15 tier (v2.2.9+) | Default cap (tier_default) |
|--------------------|-------------------|--------------------|---------------------------:|
| developer          | hybrid            | hard               | 50K (sonnet)               |
| architect          | hybrid            | hard               | 80K (opus)                 |
| reviewer           | hybrid            | hard               | 50K (sonnet)               |
| refactorer         | hybrid            | hard               | 50K (sonnet)               |
| tester             | structured-only   | hard               | 50K (sonnet)               |
| documenter         | hybrid            | hard               | 50K (sonnet)               |
| release-manager    | hybrid            | hard               | 50K (sonnet)               |
| inventor           | hybrid            | hard               | 80K (opus)                 |
| debugger           | hybrid            | hard               | 50K (sonnet)               |
| researcher         | structured-only   | hard               | 50K (sonnet)               |
| security-engineer  | prose-heavy       | hard               | 50K (sonnet)               |
| ux-critic          | prose-heavy       | hard               | 50K (sonnet)               |
| platform-oracle    | none              | hard               | (no cap)                   |
| project-intent     | none              | hard (haiku)       | (no cap)                   |

**v2.2.9 B-2.1 promotion (W-AC-1 reconciliation):** all 14 core roles are now
in `HARD_TIER` (`bin/validate-task-completion.js:328`). The legacy split that
§6 above describes ("7 hard-tier + 6 warn-tier") was correct in v2.1.9 but
superseded in v2.2.9 — `WARN_TIER` is now an empty set, and per-role demotion
is via `ORCHESTRAY_T15_<ROLE>_HARD_DISABLED=1` env vars rather than a static
tier list. The W-AC-1 finding flagged this drift; this table is the
post-promotion ground truth. §6 is being kept verbatim for v2.2.9 archival
context but the table here is authoritative.

**Source of truth contract** (W-AC-1 / W-AC-2 fix):
- `T15 tier` column matches `HARD_TIER_ROLES` and `WARN_TIER_ROLES` in
  `bin/validate-task-completion.js`. Drift between this table and the JS
  constant is caught by the CI parity test
  (`tests/polish-surface-bundle.test.js`).
- `Output category` column matches `ROLE_CATEGORY_MAP` in
  `bin/_lib/output-shape.js`. Drift is caught by the existing output-shape
  drift detector.
- `Default cap` column tracks `MODEL_TIER_DEFAULTS` × `ROLE_MODEL_TIER` in
  `bin/_lib/output-shape.js`. Operator p95 telemetry can override per-role
  via `.orchestray/state/role-budgets.json` (see §10 above and the
  `getRoleLengthCap()` resolver).

**Canonical Agent() invocation shape** (resolves W-AC-2 — the keyword vs object
syntax inconsistency between `delegation-templates.md §"Mandatory model:
field"` and `pm.md`): the PM SHOULD prefer the keyword form because it is the
form the Claude Code Agent tool documents, and it is the form the
`bin/inject-output-shape.js` hook examines on `tool_input`:

```
Agent(
  subagent_type="developer",
  model="sonnet",
  effort="medium",
  prompt="...",
)
```

The object form (`Agent({ subagent_type: "developer", ... })`) is accepted by
the runtime but inverts argument inspection in tooling and complicates hook
authoring; do not introduce it in new prose.

## 11. Artifact body cap & detail pointer

### 11.1 Target body cap

The section of a Structured Result that the next-hop agent reads inline (the
"readable body" — `summary` + `assumptions` + `issues`) MUST NOT exceed **2,000
tokens** (~8 KB, using the 4-bytes-per-token heuristic). The existing `summary ≤
500 chars` rule (§2) is unchanged and independent of this cap.

When a task produces a design, review, or audit artifact whose body would exceed
this threshold, the agent MUST:
1. Keep the inline Structured Result within the 2,000-token body cap.
2. Write the full content to a separate file and cite it via `detail_artifact`.

### 11.2 The `detail_artifact` pointer

`detail_artifact` is an optional top-level string field in the Structured Result
JSON. It names a relative path (from the project root) to a file containing
overflow content — the part of the artifact that exceeds the body cap.

```json
{
  "status": "success",
  "summary": "Reviewed auth module. 3 findings (1 error, 2 warnings). Details in artifact.",
  "detail_artifact": ".orchestray/kb/artifacts/v2114-auth-review-full.md",
  ...
}
```

Rules:
- The path MUST resolve to an existing file on disk (the T15 hook enforces this via
  the `ARTIFACT_PATH_FIELDS` list — `detail_artifact` is included).
- The file MUST be written by the agent BEFORE the Structured Result is emitted.
- Downstream agents reading the result: read `summary` + `assumptions` + `issues`
  by default; fetch `detail_artifact` via `Read` only when accuracy demands the
  full content (e.g., the reviewer is re-auditing the artifact).

### 11.3 Downstream-agent reading rule

Downstream agents (PM routing, reviewer, next developer) MUST follow this
precedence:
1. Always read `summary`, `assumptions`, and `issues` inline — these fit within
   the body cap by design.
2. Fetch `detail_artifact` ONLY when the task requires reading the full artifact
   body (e.g., "audit the prior review", "validate the design", "implement from
   the spec"). Do NOT fetch it for routing decisions or cost projections.
3. If `detail_artifact` is absent, treat the Structured Result body as complete.

### 11.4 Dual-threshold validator (T15 R-HCAP)

The T15 hook (`bin/validate-task-completion.js`) measures the byte size of any
artifact path fields found in the Structured Result (e.g., `design_artifact`,
`findings_path`, `detail_artifact` itself when it exists) and applies two
thresholds using a 4-bytes-per-token heuristic:

| Token range | `detail_artifact` present? | Behavior |
|---|---|---|
| ≤ 2,500 | any | Pass silently |
| 2,501–5,000 | any | Emit `handoff_body_warn` (threshold: `"warn"`); exit 0 |
| > 5,000 | yes | Emit `handoff_body_warn` (threshold: `"warn"`); exit 0 |
| > 5,000 | no | Emit `handoff_body_warn` (threshold: `"block_would_have_fired"`) in v2.1.14; emit `handoff_body_block` + exit 2 when `hard_block: true` |

### 11.5 Kill switch

Set `handoff_body_cap.enabled: false` in `.orchestray/config.json` to disable
all body-size checks (reverts to pre-v2.1.14 behavior):

```json
{
  "handoff_body_cap": {
    "enabled": false
  }
}
```

Default: `enabled: true`. See §11.6 for the full config schema.

### 11.6 Config schema (`handoff_body_cap`)

```json
{
  "handoff_body_cap": {
    "enabled": true,
    "warn_tokens": 2500,
    "block_tokens": 5000,
    "hard_block": false
  }
}
```

- `enabled` — boolean, default `true`. Set `false` to disable all size checks.
- `warn_tokens` — integer, default `2500`. Token count at which `handoff_body_warn`
  is emitted.
- `block_tokens` — integer, default `5000`. Token count above which a block is
  triggered (when no `detail_artifact` is present).
- `hard_block` — boolean, default `false` in v2.1.14 (flip to `true` in v2.1.15).
  When `false`: hard-block threshold is reached but the hook exits 0 with
  `threshold_breached: "block_would_have_fired"` (soft-warn-only, telemetry
  trail only). When `true`: exit 2 blocks completion.

### 11.7 Reviewer and architect guidance

Reviewer and architect artifacts routinely reach 23–43 KB (5,800–10,750 tokens).
Structure large artifacts as:
- `summary` (≤ 500 chars, §2) — the concise outcome.
- `assumptions` (bulleted array) — explicit assumptions made.
- `issues` (bulleted array) — findings by severity.
- Overflow → write to a separate file and cite via `detail_artifact`.

Do NOT embed raw tool output, full diffs, or verbose reasoning directly in the
Structured Result body. These belong in `detail_artifact`.

## 12. Change log

- v1 — v2.1.9 initial schema (2026-04-20)
- v2 — v2.1.14 R-PFX: added §9 MCP projection conventions (2026-04-24)
- v3 — v2.1.14 R-HCAP: added §10 artifact body cap & detail pointer (2026-04-24)
- v4 — v2.1.16 R-CAT-DEFAULT: §9 retitled to "MCP tool usage conventions"; catalog
  mode is now the top-level default for `pattern_find`/`kb_search`; `fields`
  projection becomes the legacy fallback shape; reviewer carve-out documented in
  both axes (2026-04-25)
- v5 — v2.2.11 W3-1: added §9 task-YAML `contracts:` block syntax reference;
  renumbered old §9 → §10, §10 → §11 (2026-04-29)
