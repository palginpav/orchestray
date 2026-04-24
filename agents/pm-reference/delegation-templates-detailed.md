<!-- PM Reference: Loaded by Tier-2 dispatch (see pm.md dispatch table) when PM is selecting
     an agent whose type is NOT in {architect, developer, reviewer}, or when the delegation
     shape is not already in the current turn's context. -->

# Delegation Templates — Detailed (Specialised Agents)

Specialised delegation templates, pre-flight checklists, and advanced handoff protocols.
For the common-path templates (architect, developer, reviewer) and the core handoff
format, see `delegation-templates.md`.

---

## Per-Agent Pre-Flight Checklists

Before spawning any agent, the PM must verify the delegation prompt addresses every item
on that agent's checklist (Section 3.X in pm.md). This is a PM-internal reasoning step --
zero tool calls, zero extra cost. Items that cannot be addressed should be noted as
"N/A: {reason}" in the delegation prompt.

### Tester Checklist

- [ ] Test scope defined? (unit, integration, e2e -- which types to write)
- [ ] Edge cases listed? (boundary conditions, error cases, empty inputs the tests should cover)
- [ ] Existing test patterns referenced? (test framework, helper utilities, fixture conventions)
- [ ] Source files to test identified? (exact paths, not "test the new code")
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Debugger Checklist

- [ ] Symptom description included? (what fails, how it manifests, error messages)
- [ ] Reproduction steps provided? (commands, inputs, or test cases that trigger the issue)
- [ ] Relevant file paths listed? (where the bug likely lives, recent changes)
- [ ] Expected vs. actual behavior stated? (what should happen vs. what does happen)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Refactorer Checklist

- [ ] Scope of refactoring defined? (which files/modules, what transformation)
- [ ] Behavioral equivalence requirement stated? (output must not change, tests must still pass)
- [ ] Existing test coverage noted? (are there tests that protect against regressions)
- [ ] Target structure described? (desired end state -- module boundaries, naming, patterns)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Inventor Checklist

- [ ] Problem description included? (what needs to be solved, why existing solutions fail)
- [ ] Constraints stated? (no external dependencies, performance targets, API surface)
- [ ] Success criteria defined? (what makes the invention "done" -- prototype, benchmark, proof)
- [ ] Build-vs-buy context provided? (why custom over off-the-shelf, what was considered)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Researcher Checklist

- [ ] Goal stated as one-sentence technology-free problem? (not "find libraries", but
      "survey approaches for <problem X> under <constraints Y>")
- [ ] Hard constraints listed? (non-negotiables — e.g., language, runtime, license)
- [ ] Soft constraints listed? (desirable tradeables)
- [ ] Non-goals stated? (scope boundaries for the survey)
- [ ] Known-not-wanted approaches listed? (prevents surveying dead options)
- [ ] Decision deadline / downstream-agent expectation stated? (architect next, inventor
      next, or user-decides)
- [ ] Scope guard reaffirmed? ("Do NOT search our codebase as primary activity — that is
      Explore's job. Do NOT produce a design doc — that is Architect's job. Do NOT
      prototype — that is Inventor's job.")
- [ ] Exploration hygiene stated? (house-standard boilerplate from §"Exploration
      Hygiene — Boilerplate")

### Documenter Checklist

- [ ] Documentation type specified? (README, API reference, changelog, ADR, inline docs)
- [ ] Target audience identified? (developers, end users, contributors, ops)
- [ ] Source files referenced? (what code to document, what behavior to describe)
- [ ] Existing doc conventions noted? (format, location, style of existing documentation)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Security Engineer Checklist

- [ ] Threat scope defined? (which components, attack surfaces, data flows to analyze)
- [ ] Security requirements listed? (compliance standards, auth model, data sensitivity)
- [ ] Existing security measures noted? (current auth, encryption, input validation in place)
- [ ] Output format specified? (threat model, vulnerability report, remediation plan)
- [ ] Exploration hygiene stated? (delegation says: "Use Glob for structure and Grep with `output_mode: files_with_matches` to locate candidates; Read only files you intend to act on. The Repository Map is authoritative for project layout — do not Glob the whole repo to re-discover structure.")

### Release Manager Checklist

- [ ] Target version explicit? (e.g. "v2.0.21" — bump type may be inferred from change set if uninstructed)
- [ ] Prior tag named? (so the agent can `git log <prior>..HEAD` for the change range)
- [ ] Release surfaces inventoried? (CHANGELOG.md, README.md, package.json, VERSION, manifest.json, event-schemas.md — list any unusual ones)
- [ ] Verification gate stated? (lint + tests + `npm pack --dry-run` must all pass; iterative-audit clean per `feedback_preship_audit_loop`)
- [ ] Hard-fence reminder included? (release-manager refuses any diff with >2 non-release files; if non-release work is needed, PM must spawn the right agent first)
- [ ] No-push contract reaffirmed? (release-manager stages the commit only; user/PM does the push and tag)
- [ ] Commit-style guidance: terse one-liner, no `Co-Authored-By` or "Generated with" trailers (per `feedback_commit_style`)

### UX Critic Checklist

- [ ] Surface scope stated? (which user-facing artifacts: slash commands, errors, statusLine, README, config keys, agent role descriptions)
- [ ] Persona requested? (first-time user, returning-after-month, power-user-with-sister-tool, operator-under-pressure — pick one or two)
- [ ] Rubric dimensions referenced? (friction, discoverability, consistency, surprise — defaults to all four if unspecified)
- [ ] Findings format reminder? (every finding must include current state, friction observed, proposed rewrite, hand-off agent)
- [ ] Read-only mandate reaffirmed? (ux-critic NEVER edits source; produces an artifact for developer/inventor/architect to act on)
- [ ] Cap stated? (>15 findings in one pass = stop and let PM batch the fixes; do not pad to look productive)

### Platform Oracle Checklist

- [ ] Question crisply phrased? (a single answerable question, not "tell me about hooks" — e.g. "does PreToolUse fire for tool calls inside subagents, and what fields does the payload contain?")
- [ ] Platform named? (Claude Code | Anthropic SDK | Anthropic API | MCP — refuse if outside these four)
- [ ] Stability tier required in the answer? (so PM can branch on stable-primitive vs experimental vs plugin/community vs undocumented)
- [ ] Citation requirement stated? (every claim must cite a fetched URL or `file:line` of installed code; no uncited assertions)
- [ ] Cross-reference scope? (explicitly invite or restrict reading installed code under `~/.claude/` or `node_modules/`)
- [ ] Scope refusal reminded? (oracle returns "out of scope, route to {agent}" rather than guessing on platforms it doesn't cover)
- [ ] WebFetch fallback path stated? (what to do if the canonical URL returns non-200)

---

## Trace Injection Format

When `enable_introspection` is true and relevant reasoning traces exist (per Section 11.Y
filtering rules in tier1-orchestration.md), include this section in the delegation prompt.
Place it AFTER `## Context from Previous Agent` and BEFORE any playbook or correction
pattern injections.

### Template

```
## Upstream Reasoning Context

The following reasoning traces were extracted from upstream agents in this orchestration.
Use them to avoid re-exploring rejected approaches and to build on discovered insights.

### Trace: {source_agent} on task-{task_id} ({source_model})

**Rejected approaches:** {merge Approaches Considered + Risky Decisions — one line each, max 3 items}
**Key assumptions:** {merge Assumptions Made + Trade-Offs that are load-bearing — max 3 items}
**Carry-over insights:** {Discoveries the downstream agent should not re-derive — max 3 items}

[Repeat for up to 3 relevant traces]
```

### Template Field Reference

- `{source_agent}`: The agent type that produced the trace (architect, developer, etc.)
- `{task_id}`: The subtask ID from the trace's YAML frontmatter
- `{source_model}`: The model used by the source agent (sonnet, opus)

### Rules

- Only include traces that pass the relevance filter (file overlap or dependency edge).
- Cap at 3 traces and ~600 words total. If exceeded, drop the least relevant trace.
- A trace that cannot fit 3 items per bullet must be dropped, not truncated mid-bullet.
- If no relevant traces exist, omit the entire `## Upstream Reasoning Context` section.
  Do NOT include an empty section.
- Traces from Haiku agents should never exist (Section 4.Y skips Haiku), but if
  encountered, exclude them.

---

## Design-Preference Context

When `surface_disagreements` is true and matching design-preference patterns exist for
the current task context (per Section 22.D in tier1-orchestration.md), inject this
section into the delegation prompt. Place it AFTER playbook and correction pattern
injections and BEFORE confidence checkpoints.

### Template

```
## Design Preferences

The following design preferences have been learned from prior user decisions. Follow
these preferences proactively when the context applies. If you encounter a situation
where a preference conflicts with correctness or security, note the conflict in your
result but still follow the preference unless doing so would introduce a bug.

- **{preference_name}**: {description}
  Context: {context field from the pattern}
  Confidence: {confidence}

[Repeat for each matching preference, up to 3]
```

### Injection Rules

- Only include preferences with confidence >= 0.5 and `deprecated` is not true.
- Match preferences against the current subtask by comparing the pattern's `context`
  field against the task description and affected file paths (keyword match).
- Cap at 3 preferences per delegation. If more than 3 match, prioritize by confidence
  (highest first).
- If no matching preferences exist, omit the entire `## Design Preferences` section.
  Do NOT include an empty section.

---

## Architectural Invariant Constraints

When `enable_drift_sentinel` is true and enforced invariants overlap with a subtask's
`files_write` (per Section 39.D Phase A in tier1-orchestration.md), inject this section
into the delegation prompt. Place it AFTER design preferences and BEFORE confidence
checkpoints.

### Template

```
## Architectural Constraints

The following architectural invariants are enforced for this task. You MUST NOT violate
these constraints. If a constraint prevents you from completing the task as described,
report this in your result rather than silently violating the invariant.

- **{invariant_id}**: {invariant text}
  Source: {source — architect-extraction | static-rule | user-defined}
  Files: {files_affected patterns}

[Repeat for each matched invariant]
```

### Injection Rules

- Only include invariants with `enforced: true` whose `files_affected` patterns overlap
  with the subtask's `files_write` fields.
- For architect delegations: include ALL enforced invariants (architects need the full
  picture to produce designs that respect existing constraints). Additionally, instruct
  the architect to output architectural decisions in extractable format — use explicit
  constraint language ("must", "must not", "always", "never") when stating invariants
  so the PM can auto-extract them post-completion.
- For developer delegations: include only invariants whose `files_affected` overlap with
  the specific files the developer will modify.
- Cap at 5 invariants per delegation. If more than 5 match, prioritize by severity
  (error-level first) then recency.
- If no matching invariants exist, omit the entire `## Architectural Constraints` section.
  Do NOT include an empty section.

---

## Pattern Citations

**Pattern-body elision on repeat citation (CiteCache, v2.1.8).** When
`context_compression_v218.cite_cache` is true (default), within a single orchestration
the **first** delegation that cites a pattern receives the full body. **Subsequent**
delegations citing the same pattern receive a cached marker instead.

Use `bin/_lib/pattern-citation-render.js` to render citations. It handles the full-body
vs. cached rendering and records the seen-set via `bin/_lib/pattern-seen-set.js`.

**Reviewer exception:** reviewer delegations ALWAYS include full pattern bodies regardless
of cache state. This is enforced in `renderCitation()` (agentType === 'reviewer' bypasses
the cache check). A reviewer receiving a `[CACHED]` cite is a bug — see agent-common-protocol.md.

**Config:** `context_compression_v218.cite_cache: true` (default). Set `false` to disable
(every delegation gets full bodies).

**Seen-set cleared:** on `orchestration_complete` (hook: `collect-agent-metrics.js` calls
`clearForOrch(orchId)` from `pattern-seen-set.js`).

### Full-body rendering (first cite or reviewer)

```
## Patterns Applied

- @orchestray:pattern://<slug>     [local]     conf 0.85, applied 3x

<full pattern body here>

- @orchestray:pattern://<slug>     [shared]    conf 0.72, applied 7x, from my-other-project

<full pattern body here>
```

### Cached rendering (subsequent cite, non-reviewer)

```
## Patterns Applied

- @orchestray:pattern://<slug>     [local]     conf 0.85, applied 3x
  [CACHED — loaded by developer, hash a1b2c3]
```

### Label derivation

| `source` field | `promoted_is_own` | Label |
|---|---|---|
| `"local"` | n/a | `[local]` |
| `"shared"` | `false` or absent | `[shared]` |
| `"shared"` | `true` | `[shared, own]` |

### Rules

- Include the bracket label for every pattern citation. Omitting it is a protocol violation.
- For `[shared]` and `[shared, own]`: append `, from <promoted_from>` after the applied count.
  Add `(this project)` suffix only when `promoted_is_own: true`.
- `conf X` = `confidence` field value from the match object (e.g., `0.85`).
- `applied Nx` = `times_applied` field value (e.g., `3x`). Use `0x` when field is absent.
- Omit the entire `## Patterns Applied` section if `pattern_find` returns zero matches.
  Do NOT include an empty section.

---

## Repo-map handoff (RepoMapDelta, v2.1.8)

When `context_compression_v218.repo_map_delta` is true (default), inject the full
filtered repo map only into the **first** agent delegation of an orchestration.
Subsequent agents receive a pointer block with a hash and per-agent filter hints.

Use `bin/_lib/repo-map-delta.js` `injectRepoMap()` to generate the correct block.

Track `repo_map_injected_in_orch` state via the delta utility's own state file
(`.orchestray/state/repo-map-delta-state.jsonl`) — no change to the main orchestration
state file required.

**Config:** `context_compression_v218.repo_map_delta: true` (default). Set `false` to
restore pre-v2.1.8 behavior (every agent gets full map injected).

**Fail-open:** if the state file cannot be read or written, fall back to full map injection.
Record a `repo_map_delta_first_emit_failed` degraded entry in degraded.jsonl.

### First agent — full filtered map

```
## Repository Map

{full filtered repo-map content — same algorithm as current, trimmed to relevant rows}
```

The map is also written to `.orchestray/kb/facts/repo-map.md` and its sha256 hash is
recorded in `.orchestray/state/repo-map-delta-state.jsonl` for subsequent pointer blocks.

### Subsequent agents — pointer block

```
## Repository Map (unchanged this orchestration)

The repo map was injected fully into the first agent. It is at
`.orchestray/kb/facts/repo-map.md` (hash `a1b2c3d4`, unchanged since orch start).
Read it only if you need structural knowledge beyond the per-agent hints below.

### Relevant rows for your task
- src/api/tasks.ts
- tests/tasks.test.ts
- agents/developer.md
```

The `### Relevant rows for your task` section lists 3–5 rows most relevant to the
agent's `files_write`/`files_read` — same filtering algorithm as current repo-map
injection, trimmed to the top rows. This preserves per-agent relevance even in pointer
mode so an expensive later model does not need to Read the full map for 90% of tasks.

---

## Visual Review Screenshot Injection

When `enable_visual_review` is true and Section 4.V discovers screenshots, inject this
section into the reviewer delegation prompt. Place it AFTER the `## Git Diff` section
and BEFORE any playbook, correction pattern, or confidence checkpoint injections.

### Template

```
## Visual Review Context

You have been provided with screenshot images of the UI changes alongside the code diff.
Perform a multi-modal review that examines BOTH the code AND the visual output.

### Visual Review Checklist

1. **Layout integrity**: Are elements properly aligned, spaced, and contained within their parents?
2. **Text rendering**: Is all text visible, properly sized, and not clipped or overflowing?
3. **Color and contrast**: Do colors match the expected design? Is text readable against its background?
4. **Typography**: Are font sizes, weights, and families consistent with the design system?
5. **Responsive indicators**: If multiple viewport screenshots are provided, check consistency across sizes.
6. **Regression signals**: Does anything look broken, misaligned, or visually different from what the code change intends?
7. **Accessibility signals**: Are interactive elements visually distinguishable? Is there sufficient color contrast?

### Severity for Visual Issues

- error: Visible rendering bug -- broken layout, overlapping elements, invisible text, missing components
- warning: Degraded but functional -- spacing inconsistency, contrast borderline, alignment slightly off
- info: Cosmetic suggestion -- could be improved but not broken

### Screenshots Provided

{for each screenshot: "- {path} (source: {source_classification})"}
{if before/after pairs exist: "Before/after pairs: {list of paired filenames}"}

Use the Read tool to view each screenshot image. Compare what you see against the code
diff to identify any discrepancies between intent and rendered result.
```

### Injection Rules

- Only inject when Section 4.V found at least one screenshot.
- If no screenshots were found, omit the entire `## Visual Review Context` section.
  The reviewer proceeds with standard text-only review.
- Cap at 10 screenshot paths in the list (per visual-review.md cap rules).
- Before/after pairs should be listed together so the reviewer examines them side by side.

---

## Response-Length Budget Line (§3.Y Adaptive Verbosity)

When `adaptive_verbosity.enabled === true` AND `v2017_experiments.adaptive_verbosity === 'on'`
(see §3.Y in tier1-orchestration.md), append this line to the delegation prompt for every
agent type. Compute `{N}` per the §3.Y formula before injecting.

Place this line AFTER all other content sections (task description, context, playbooks,
correction patterns, repo map, design preferences, architectural constraints, visual review,
upstream traces) and BEFORE confidence checkpoints (§3.Z). If §3.Y gates are closed,
omit this section entirely.

### Template Line

```
Response budget: ~{N} tokens. Return a summary of ≤ {N} words covering only the
deliverables explicitly requested. Omit exploration narration, re-statements of the
task, and verbose section headers.
```

### Per-Agent Defaults (base_response_tokens = 2000, reducer = 0.4)

| Agent type | Early phase (< 0.5) | Late phase (≥ 0.5) |
|---|---|---|
| developer | ~2000 tokens | ~800 tokens |
| architect | ~2000 tokens | ~800 tokens |
| reviewer | ~2000 tokens | ~800 tokens |
| refactorer | ~2000 tokens | ~800 tokens |
| tester | ~2000 tokens | ~800 tokens |
| documenter | ~2000 tokens | ~800 tokens |
| debugger | ~2000 tokens | ~800 tokens |
| security-engineer | ~2000 tokens | ~800 tokens |
| dynamic agents | ~2000 tokens | ~800 tokens |

Haiku-tier agents: skip injection — they are already terse.

Note: reviewer agents get a minimum-600-token floor — `{N}` is never less than 600
regardless of phase or reducer value (see §3.Y reviewer floor rule).

Note: final-round verify-fix reviewers are exempt — if `current_verify_fix_round ===
verify_fix_max_rounds`, omit this budget line entirely for that reviewer delegation.

### Injection Rules

- Only inject when both gates are open (see §3.Y). If either is closed, omit entirely.
- The `{N}` value is the integer budget in tokens (rounded to nearest 50 for readability).
- Do NOT include this section in first-spawn (pre-decomposition) PM self-calls.
- Do NOT include this section in Haiku-tier agent delegations.
- Do NOT include this section in the final verify-fix reviewer delegation (see exemption note above).

---

**Compression path observability (v2.1.10):** Each compression path (CiteCache, SpecSketch, RepoMapDelta) is now audit-traced by `bin/emit-compression-telemetry.js` on `SubagentStart`. When the delegation prompt reaches the subagent, the hook greps it for the three markers and appends a `cite_cache_hit`, `spec_sketch_generated`, or `repo_map_delta_injected` event to `.orchestray/audit/events.jsonl`. Running `grep -c cite_cache_hit .orchestray/audit/events.jsonl` is now a valid runtime smoke-test for confirming that CiteCache is actually firing during a given orchestration. If the count is zero after several delegations, it indicates the PM has fallen back to full pattern-body prose and the compression is not active. Kill-switch: `ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1`.

---

## Section 11: KB + Diff Handoff Flow

Follow this 5-step pattern for every sequential agent handoff:

1. **PM spawns Agent A** with the task description plus an instruction to write discoveries
   to the KB (using the template from Section 10: "Instructing Agents to Write KB").

2. **Agent A completes work** and writes findings to `.orchestray/kb/{category}/{slug}.md`,
   updating `index.json` with the new entry.

3. **PM prepares handoff for Agent B** by:
   a. Checking `index.json` for entries where `source_agent` matches Agent A and
      `updated_at` is recent (within the current orchestration timeframe)
   b. Running `git diff` to capture Agent A's code changes (use `git diff HEAD~1` or
      the appropriate range for Agent A's commits)
   c. Composing Agent B's delegation prompt with all three components:
      the task, the KB references, and the diff
   d. **Selective relevance filter:** Before including any KB entry in the handoff, evaluate
      whether it is relevant to Agent B's SPECIFIC subtask (not just the overall orchestration).
      Skip entries about parts of the system Agent B won't touch. This prevents context waste
      from irrelevant KB entries.

4. **Agent B reads specified KB entries**, understands the changes via the diff, and
   proceeds with its own task. Agent B does NOT re-read files that Agent A already
   analyzed -- the KB entry provides the distilled context.

5. **Agent B writes its own discoveries to KB**, continuing the chain for any subsequent
   agent (e.g., reviewer after developer).

---

## Confidence Checkpoint Instructions

When `enable_backpressure` is true, append this block to every agent delegation prompt
(architect, developer, reviewer, refactorer, inventor, debugger, tester, documenter,
security-engineer, and dynamic agents). This is the exact template used by Section 3.Z
in tier1-orchestration.md. Replace `{TASK_ID}` with the subtask's actual ID before
injection.

### Template Block

```
## Confidence Checkpoints

At three points during your work, pause and write a confidence signal to:
  .orchestray/state/confidence/task-{TASK_ID}.json

Use this exact JSON format:
{
  "task_id": "{TASK_ID}",
  "checkpoint": "<post-exploration|post-approach|mid-implementation>",
  "confidence": <0.0-1.0>,
  "risk_factors": ["<list of specific concerns>"],
  "estimated_remaining_turns": <number>,
  "would_benefit_from": "<what additional context would help, or null>"
}

Checkpoint triggers:
1. AFTER reading relevant files but BEFORE writing any code/design — write with
   checkpoint "post-exploration"
2. AFTER deciding on an implementation approach but BEFORE committing to it — write
   with checkpoint "post-approach"
3. HALFWAY through your estimated work — write with checkpoint "mid-implementation"

Each write overwrites the previous one. Only your latest signal matters.

Confidence calibration:
- 0.9+: Very confident, familiar pattern, clear path
- 0.7-0.89: Confident but some unknowns, manageable risk
- 0.5-0.69: Uncertain, multiple concerns, may need help
- 0.3-0.49: Low confidence, significant blockers, approach may be wrong
- <0.3: Very low, should probably stop and get guidance

Be honest. Overconfidence wastes more tokens than admitting uncertainty.
In risk_factors, be specific: "unfamiliar async pattern in auth module" not "might be hard".
In would_benefit_from, name the exact context: "architect guidance on module boundary"
or null if nothing specific would help.
```

### Injection Rules

- Place the `## Confidence Checkpoints` section at the END of the delegation prompt,
  after all other sections (task description, context, playbooks, corrections, repo map,
  upstream traces).
- The section is self-contained — agents do not need to read any external file to
  understand the protocol.
- For dynamic agents (Section 17), include the same template block in the dynamically
  generated agent definition's system prompt.
- If `enable_backpressure` is false or absent, omit this section entirely. Do not include
  an empty placeholder.
