---
id: agent-common-protocol
title: Shared Agent Protocol — KB Write + Slug Validation
tier: 2
load_when: "always"
---

# Shared Agent Protocol

## KB Write Protocol

After completing your task, write significant, reusable findings to the knowledge base
for context sharing with subsequent agents:

- Write to `.orchestray/kb/facts/{slug}.md` (or `security-{slug}.md` for security findings)
- Update `.orchestray/kb/index.json`, adding your entry to the `entries` array
- Check the index first for existing entries on the same topic — update instead of
  duplicating
- Keep detail files under 500 tokens
- Include: what you found, why it matters, and what the next agent should know

**Slug validation (security):** Before constructing the write path, validate `{slug}`
against the regex `^[a-zA-Z0-9_-]+$`. If validation fails, sanitize by replacing
invalid characters with `-` or skip the KB write and log a warning. Never use an
unvalidated slug to construct a file path.

## Structured Result Field Reference

Standard fields in every agent's JSON result block:

- **status**: `"success"` = task complete, no blockers. `"partial"` = some work done,
  blockers remain. `"failure"` = could not proceed.
- **files_changed**: Every file created or modified. Reviewers and investigators always
  return `[]` — report needed changes as issues instead.
- **files_read**: Files consulted for context.
- **issues**: Findings with `severity` (`error`/`warning`/`info`) and `description`
  including file path, location, and actionable detail.
- **recommendations**: Follow-up suggestions for the PM, architect, or next agent.
- **retry_context**: Present only on `"failure"` or `"partial"` — what was tried and
  what prevented completion.

### Response Length Discipline

Your response to the PM has two parts and a combined length budget:

1. **`## Result Summary`** (human-readable): ≤ 150 words. Bullet list preferred over
   prose. State what you did, what you found, and what the next agent needs. Omit
   process narration ("I first read X, then searched for Y, then realized Z") — the
   PM reads the transcript for process; the summary is for outcomes.

2. **`## Structured Result`** (JSON block): as many fields as the schema requires,
   but `issues[].description` ≤ 30 words each, `recommendations[]` ≤ 20 words each.

Combined response budget: ≤ 400 words of prose + structured JSON. If your work
genuinely requires a longer explanation (e.g., a complex architectural decision), put
the long form in a KB artifact (`.orchestray/kb/artifacts/{slug}.md`) and cite it from
the summary. Do not inline long explanations in the agent response — they inflate the
PM's context without aiding decision-making.

**Exemption:** Debuggers returning a `diagnosis` block and Inventors returning an
`invention_summary` block may exceed the 150-word summary cap if the role-specific
extension field demands it, up to 300 words of summary. The 400-word combined budget
still applies.

### Role-Specific Extension Fields

Certain agent roles add extra top-level fields to the standard contract. These are
required only for the named role; all other agents omit them.

- **`diagnosis`** (debugger only): Object with `root_cause` (string), `confidence`
  (`"high"` | `"medium"` | `"low"`), `affected_files` (string[]),
  `fix_strategy` (string), `risk_assessment` (string), and
  `related_issues` (string[]). `files_changed` is always `[]` for the debugger.

- **`test_summary`** (tester only): Object with `tests_added` (number),
  `tests_modified` (number), and `coverage_gaps_remaining` (string[]).
  Always include this field — use `0` / `[]` when nothing was added.

- **`invention_summary`** (inventor only): Object with `name` (string),
  `verdict` (`"recommend"` | `"recommend_with_caveats"` | `"do_not_recommend"`),
  `prototype_location` (string), and `novel_vs_existing` (string — one-sentence
  justification of custom over existing tools).

- **`research_summary`** (researcher only): Object with `goal` (string — restated one-line
  goal), `candidates_surveyed` (integer, 3–7), `verdict`
  (`"recommend_existing"` | `"recommend_build_custom"` | `"no_clear_fit"` | `"inconclusive"`),
  `top_pick` (string or null), `artifact_location` (string — path to the written artifact),
  and `next_agent_hint` (`"architect"` | `"inventor"` | `"debugger"` | `"stop"`).
  `files_changed` is always `[]` for researcher.

- **`refactoring_summary`** (refactorer only): Object with `goal` (string),
  `steps_completed` (number), `steps_planned` (number), and `verification`
  (object with `tests_before`, `tests_after` — each `{pass, fail, skip}` — and
  `methods_used` string[]). Report which verification methods were used:
  `"test_suite"`, `"type_checking"`, `"manual_trace"`.

### Role-Specific Status Semantics

- **reviewer** — `"success"` = no error-severity issues found; `"failure"` = one or more
  error-severity issues found (review complete, implementation must be fixed);
  `"partial"` = review could not complete (files missing, tests would not run).
  `files_changed` is always `[]`.

- **debugger** — `"success"` = root cause identified (medium or high confidence), fix
  strategy clear; `"partial"` = progress made but root cause unconfirmed; `"failure"` =
  could not reproduce or gather evidence. `files_changed` is always `[]`.

- **security-engineer** — `"success"` = audit completed, all in-scope areas reviewed;
  `"partial"` = some areas could not be reviewed; `"failure"` = audit could not proceed.
  `files_changed` is always `[]`.

## Commit Message Discipline for W-Items

Every W-item (a developer agent executing a numbered work-item in a multi-W
orchestration) MUST include a `## Handoff` subsection in its commit message body.
This subsection is the **authoritative durable handoff** — it is readable by any
downstream W-item via `git show <sha>` and survives worktree teardown, session
restart, and `.orchestray/` cleanup.

### Why commit body, not KB artifact

`.orchestray/kb/artifacts/` is gitignored and ephemeral to the session in which it
is written. W-items that run in separate worktrees or after a session restart cannot
reliably read those files. The git commit body is always available.

KB artifacts MAY still be written for the benefit of agents running in the **same
active session** — they are useful scratch during the orchestration. But they are
**session-scoped scratch only**. Do not treat them as the handoff record.

### Handoff subsection format

```
<commit title line>

<prose: 1-2 paragraphs of what changed and why>

## Handoff

**Files changed:** <brief list — one line per file or file group>
**Test delta:** <e.g. "+7 tests (1478 → 1485)" or "no tests added">
**Invariants established:** <one key load-bearing fact downstream W-items must know>
**Downstream cues:** <markers, line numbers, or contracts the next W-item needs>
```

### Size and tone

Keep the Handoff subsection to **5–15 lines**. It is a targeted briefing, not a
full artifact dump. Include only what the NEXT W-item needs to avoid re-discovering
context or breaking an invariant you established.

### Relation to Structured Result

The `## Handoff` block is commit-message companion content. It does NOT replace the
JSON Structured Result (which the PM reads from the agent's response). Both are
required for W-items. The Structured Result goes in the agent's response body; the
Handoff block goes in the git commit message.

## Pattern Citation Cache Interpretation (CiteCache, v2.1.8)

When a delegation prompt contains a `[CACHED]` pattern citation marker, it means
the full pattern body was delivered to an upstream agent earlier in this orchestration.
The format is:

```
- @orchestray:pattern://<slug>     [<label>]     conf <X>, applied <N>x
  [CACHED — loaded by {first_agent}, hash {h6}]
```

**Interpretation rules:**

1. If the slug + one-line description give you enough context for your task, proceed
   without fetching the full body. The hash is provided for integrity verification only.

2. If you need the full pattern body, fetch it via `@orchestray:pattern://<slug>`.

3. **Reviewer agents:** if you see a `[CACHED]` citation in a reviewer delegation,
   this is a bug — the reviewer MUST always receive full pattern bodies regardless of
   cache state. Report it as `issues[]` severity=info and fetch the full body via the
   pattern URI before proceeding with your review.

4. A `[CACHED]` citation does not mean the pattern is inapplicable — it means token
   cost was saved by not re-sending the body you (or an upstream agent) already have.

---

## Anti-Pattern Advisory (W12 LL3)

When a spawned agent receives an `[Anti-pattern advisory]` marker at the start of its
context (injected by `gate-agent-spawn.js` via the `additionalContext` hook mechanism),
it MUST:

1. **Read the advisory before planning.** The marker has this format:

   ```
   [Anti-pattern advisory] The following anti-pattern applies to this task:

   <pattern-name>: <one-line description>

   Why it matched: trigger "<phrase>" matched in spawn description (decayed_confidence=<N>)

   Mitigation: <approach summary>
   ```

2. **Take the mitigation into account** when structuring your approach. The advisory
   is not a hard constraint — you may proceed differently — but you MUST explicitly
   acknowledge the advisory and explain why you are deviating (if you are).

3. **Never ignore it silently.** If the anti-pattern genuinely does not apply to this
   specific task (e.g., context differs from the pattern's trigger), note this in your
   `issues` field with `severity: "info"` so the PM can record a `contextual-mismatch`
   skip-reason for this pattern.

4. **Advisories are informational, not blocking.** The spawn has already been allowed;
   this is guidance, not a veto.

---

## Output Shape Declarations (P1.2, v2.2.0)

Each agent's frontmatter declares `output_shape:` from one of four
values. The PM consults this declaration via `bin/_lib/output-shape.js`
at delegation time and injects (a) the 85-token smart-caveman prompt,
(b) Anthropic `output_config.format`, and/or (c) a per-role length cap.

| Category          | Caveman | Length cap | Structured outputs           |
|-------------------|---------|------------|------------------------------|
| `structured-only` | NO      | NO         | YES (full schema)            |
| `hybrid`          | YES     | YES        | Staged (allowlist; footnote¹) |
| `prose-heavy`     | YES     | YES        | NO                           |
| `none`            | NO      | NO         | NO                           |

¹ v2.2.0 ships `staged_flip_allowlist=["researcher","tester"]` (W2 §5.2 Risk #2
mitigation). Hybrid roles receive the caveman addendum + length cap from day-1
but no Anthropic structured-output schema until v2.2.1 telemetry confirms zero
T15 rejection. The kill-switch list at the bottom of this section names the
config knob; the in-code source of truth is `output-shape.js` `staged_flip_allowlist`.

Per-role assignments (the 14 declaring agent files):

| Role               | output_shape       |
|--------------------|--------------------|
| researcher         | `structured-only`  |
| tester             | `structured-only`  |
| developer          | `hybrid`           |
| debugger           | `hybrid`           |
| reviewer           | `hybrid`           |
| architect          | `hybrid`           |
| documenter         | `hybrid`           |
| refactorer         | `hybrid`           |
| inventor           | `hybrid`           |
| release-manager    | `hybrid`           |
| security-engineer  | `prose-heavy`      |
| ux-critic          | `prose-heavy`      |
| platform-oracle    | `none`             |
| project-intent     | `none`             |

Caveman applies ONLY to the prose body. Structured Result JSON blocks,
code fences, and tool-call payloads MUST stay full English — see
`bin/_lib/proposal-validator.js` for the runtime check.

Length caps come from `bin/calibrate-role-budgets.js` recommendations,
cached at `.orchestray/state/role-budgets.json`. v2.2.0 reads the cache
directly via `bin/_lib/output-shape.js` `getRoleLengthCap()` — preferring
`p95` when present, otherwise `budget_tokens` (the v2.1.16 R-BUDGET-WIRE
fallback). Roles below the `--min-samples` threshold fall back to
model-tier defaults (haiku 30K / sonnet 50K / opus 80K) and the
`output_shape_applied.reason` field records `length_cap=tier_default`.

Operators refresh the cache by running:

```bash
node bin/calibrate-role-budgets.js --emit-cache
```

The `--emit-cache` flag (added in v2.2.0 W7 fix-pass) writes the wrapped
form `{ "role_budgets": { "<role>": { "p95": …, "budget_tokens": …, … } } }`
that `output-shape.js` consumes. Without the flag, the tool prints to
stdout only and the operator hand-edits `config.json` `role_budgets` —
the v2.1.16 path.

Diagnostic kill switches in `.orchestray/config.json`:

- `output_shape.enabled` — master switch (default `true`).
- `output_shape.caveman_enabled` — disable caveman alone.
- `output_shape.structured_outputs_enabled` — disable Anthropic
  schema enforcement alone (kept on a per-role staged-flip allow-list
  even when `true`; v2.2.0 ships `["researcher", "tester"]`).
- `output_shape.length_cap_enabled` — disable caps alone.

The single source of truth for category assignment is
`ROLE_CATEGORY_MAP` in `bin/_lib/output-shape.js`. The frontmatter
declaration above is the human-readable cross-reference; CI drift
detection (`tests/kb-refs-sweep.test.js` extension) fails any divergence.
