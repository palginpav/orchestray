---
section: Tier 2 — Acceptance Rubric Format
audience: all-subagents
always_load: true
owner: architect
version: 1
---

# Rubric Format — Acceptance Rubric Syntax

## 1. Purpose

An acceptance rubric is a set of atomic, binary, objectively-checkable criteria
that a design artifact MUST satisfy for downstream work to be accepted. The
architect (or the reviewer when auditing a pre-existing design) produces the
rubric; the developer and reviewer score against it; the PM uses the score as
the primary acceptance signal. Rubrics exist so that "done" is a decidable
property, not a judgment call — no criterion may be subjective. When a task
is small enough to skip the architect, the PM synthesises a minimal rubric at
delegation time (see §5).

## 2. Rubric syntax

Canonical specification:

- The rubric lives in agent output under a section titled exactly
  `## Acceptance Rubric`, followed by a single fenced code block. Prefer
  ` ```yaml` for programmatic consumption by the structural scorer; a markdown
  bullet list inside a ` ```markdown` fence is accepted but discouraged.
- Each criterion is an object with exactly three fields:

  | field | type | notes |
  |---|---|---|
  | `id` | string, format `AC-<NN>` | Zero-padded two-digit index starting at `AC-01`. |
  | `criterion` | string | Atomic binary test. MUST be phrased so "pass" and "fail" are objectively decidable without further interpretation. |
  | `category` | enum `correctness \| security \| performance \| docs \| operability \| api-compat` | Exactly one. If a criterion straddles two categories, split it. |

- **Cardinality: 5–10 criteria per rubric** (soft cap). A 15-criterion rubric
  is a signal that the design should be split into smaller designs, each with
  its own rubric.
- Every criterion MUST be objectively checkable. Example:
  - OK: *"The new hook exits with code 2 when the input JSON is malformed."*
  - NOT OK: *"The code is clean."* / *"Performance is acceptable."* /
    *"The design is elegant."*
- A criterion may reference concrete anchors (file paths, function names,
  test IDs, telemetry event types). Anchors that do not yet exist at rubric
  time MUST include the phrase "will exist" so reviewers can distinguish a
  broken pointer from a forward reference.
- Cross-reference: the rubric SHOULD cite the spec section it derives from
  (e.g. `(derives from v219-design-spec.md §5 I-12 item d)`). See anti-pattern
  §6 on rubrics that silently contradict the spec.

## 3. Worked example

A complete YAML rubric of 7 items for a hypothetical "add a new hook that
validates teammate task completion" design task:

```yaml
- id: AC-01
  criterion: "bin/validate-task-completion.js exists and is an executable Node.js script with a shebang."
  category: correctness
- id: AC-02
  criterion: "The hook exits with code 2 when the TaskCompleted payload is missing the task_id field."
  category: correctness
- id: AC-03
  criterion: "The hook exits with code 2 when the Structured Result is malformed AND the spawning agent role is in HARD_TIER."
  category: correctness
- id: AC-04
  criterion: "The hook exits with code 0 when the Structured Result is malformed AND the spawning agent role is in WARN_TIER, and emits a task_completion_warn audit event."
  category: correctness
- id: AC-05
  criterion: "The hook is registered in hooks/hooks.json for both TaskCompleted and SubagentStop events."
  category: operability
- id: AC-06
  criterion: "hooks/hooks.json schema-validates against the existing ajv check in lint:hooks."
  category: api-compat
- id: AC-07
  criterion: "The existing bin/validate-task-completion.test.js suite passes with the new logic, and at least 2 new test cases cover the HARD_TIER and WARN_TIER branches."
  category: correctness
```

## 4. Scoring contract

A downstream agent (developer self-scoring, reviewer auditing, or the
structural scorer) records its evaluation as follows:

1. The agent emits a `## Rubric Scoring` section in its output, alongside
   (not inside) the `## Structured Result` section. Both sections appear in
   the final output; `## Rubric Scoring` is placed immediately before
   `## Structured Result`.
2. The body of `## Rubric Scoring` is a single fenced ` ```yaml` block
   containing a list where each entry has:

   | field | type | notes |
   |---|---|---|
   | `id` | string, format `AC-<NN>` | Must match a criterion id from the rubric being scored. |
   | `pass` | boolean | true or false. No `null`, no `"partial"`. If you cannot decide, the criterion is not atomic — flag as an issue and fail it. |
   | `evidence` | string | Mandatory for PASS and FAIL alike. A concrete pointer: file path + line, commit sha, test id, telemetry event type, or CLI command + expected output. |

3. Every criterion in the referenced rubric MUST have exactly one scoring
   entry. Missing entries are treated as `pass: false, evidence: "missing"`
   by the structural scorer and dock `structural_score`.
4. `evidence` is mandatory on BOTH pass and fail. "No evidence" is a
   `structural_score` penalty (B4 scorer). Evidence-less claims do not count.
5. In the agent's `## Structured Result`, summarise the result in the
   `acceptance_rubric` field as
   `{passed_count: N, total_count: N, rubric_ref: "<path or anchor>"}`.
   `passed_count` must equal the number of scoring entries with `pass: true`;
   `total_count` must equal the number of criteria in the referenced rubric
   (not the number of scoring entries — missing entries count against).

Example scoring block (scoring the rubric in §3):

```yaml
- id: AC-01
  pass: true
  evidence: "bin/validate-task-completion.js:1 — `#!/usr/bin/env node` present; chmod +x verified."
- id: AC-02
  pass: true
  evidence: "test/bin/validate-task-completion.test.js:42 — test 'blocks when task_id missing' passes."
- id: AC-03
  pass: true
  evidence: "test/bin/validate-task-completion.test.js:78 — HARD_TIER branch asserts exit code 2."
- id: AC-04
  pass: true
  evidence: ".orchestray/audit/events.jsonl — task_completion_warn event emitted during WARN_TIER test run."
- id: AC-05
  pass: true
  evidence: "hooks/hooks.json:33-48 — TaskCompleted and SubagentStop matchers both registered."
- id: AC-06
  pass: true
  evidence: "npm run lint:hooks → exit 0."
- id: AC-07
  pass: true
  evidence: "npm test → 47 passing, 0 failing; 2 new cases at test/bin/validate-task-completion.test.js:78 and :96."
```

## 5. PM fallback

When a task is small enough that no architect runs, the PM synthesises a
minimal rubric at delegation time and includes it verbatim in the spawning
agent's prompt. The fallback contract:

- **Minimum size:** 3 criteria. Below 3, acceptance becomes indistinguishable
  from the task title and the rubric adds no signal.
- **Composition:** at least one criterion in `correctness`, and at least one
  in either `docs`, `operability`, or `api-compat` (to cover the non-code
  surface).
- **Placement in the spawn prompt:** the PM emits a `## Acceptance Rubric`
  section in the delegation prompt, using the same YAML syntax as §2, so the
  downstream agent can score it without reformatting.
- **Attribution:** the PM-synthesised rubric includes a leading comment
  `# Rubric synthesised by PM (no architect in this dispatch)` inside the
  YAML block so reviewers know it was not architect-produced.
- **Escalation:** if the agent cannot evaluate the PM's rubric (criterion is
  non-atomic, references a file that does not exist, etc.), the agent emits
  an `issues` entry at `severity: "warning"` and falls back to `status:
  "partial"` rather than guessing.

## 6. Anti-patterns

Do NOT do any of the following. Each has been observed producing rubrics
that pass their own checks but fail acceptance in practice.

- **Non-binary criteria.** Phrases like "acceptable performance", "clean
  code", "reasonable coverage", "good error messages", "clear docs". Every
  one is subjective. Replace with a measurable threshold (latency in ms,
  coverage percentage, error message format regex, docs anchor count).
- **Criteria that restate the task title.** "Ships the feature" or
  "Implements the design" is not a criterion — it is a tautology. If the
  rubric says the same thing as the task title, the rubric is empty.
- **Rubric items without evidence pointers on scoring.** A scoring entry
  with `pass: true, evidence: "tested"` is worthless. Evidence must be a
  concrete pointer — file:line, test id, command + output, telemetry event.
- **Rubric that silently contradicts the spec it claims to implement.** If
  the spec says "hook exits with code 2 on hard-tier failure" and the
  architect's rubric says "hook logs a warning on hard-tier failure", the
  rubric is wrong, not the spec. Every criterion SHOULD cross-reference the
  spec section it derives from; contradictions without explicit rationale
  (an `issues` entry flagging the deviation + reviewer approval) are a block.
- **15+ criteria covering every possible surface.** If the rubric is this
  long, the design is too big. Split the design; each split gets its own
  rubric of 5–10 criteria.
- **Criteria phrased as implementation directives.** "Use a Map, not an
  Object" is not an acceptance criterion — it is a design decision. Rubric
  items describe OBSERVABLE post-conditions, not implementation choices.

## 7. Change log

- v1 — v2.1.9 initial rubric format (2026-04-20)
