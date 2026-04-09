# Delegation Templates Reference

Detailed delegation prompt formats and context handoff protocols.
For principles and anti-patterns, see the main PM prompt Sections 3 and 11.

---

## Section 3: Delegation Prompt Format

When delegating to a subagent, provide a **clear, self-contained task description**.
The subagent has NO context from this conversation. It starts fresh.

### What to Include in Every Delegation

1. **Task description:** What needs to be done, in specific terms
2. **Relevant file paths:** Where to look, where to make changes
3. **Requirements and constraints:** Must-haves, must-not-haves
4. **Expected deliverables:** What the agent should produce
5. **Context from prior agents:** If architect produced a design, include it for developer
6. **Playbook instructions:** If Section 29 matched any playbooks for this agent type, append their Instructions sections to the delegation prompt
7. **Correction patterns**: If Section 30 found matching correction patterns for this agent, include the Known Pitfall warnings
8. **User correction patterns**: If Section 34f found matching user-correction patterns, include the Known Pitfall (User Correction) warnings. Combined cap with step 7: max 5 total correction warnings per delegation, prioritized by confidence.
9. **Repository map:** Include the relevant portion of the repo map from
   `.orchestray/kb/facts/repo-map.md` as a `## Repository Map` section (see Section 3
   Repository Map Injection rules for per-agent filtering)

### Example Delegation Prompts

**Good:** "Create a REST API endpoint POST /api/tasks in src/api/tasks.ts that accepts
{name: string, priority: number} and saves to the tasks table. Use the existing pattern
from src/api/users.ts. Return validation errors as 400 with {error: string} body."

**Good:** "Review the implementation in src/api/tasks.ts and src/models/task.ts.
Validate: correct error handling, SQL injection prevention, input validation completeness,
proper HTTP status codes. The endpoint accepts POST with {name, priority} body."

**Good:** "Design the caching architecture for the /api/products endpoint. Consider:
cache invalidation strategy, TTL values, storage backend (Redis vs in-memory), cache
key design. Output a design document with file structure and implementation approach."

**Good (Inventor):** "We need a lightweight task queue for this project. Existing solutions
(Bull, Bee-Queue) are Redis-dependent and overkill for our 10-job/minute volume. Design
and prototype a file-based task queue using only Node.js stdlib. Evaluate whether it
justifies the maintenance cost vs. just using Bull. Produce prototype code + trade-off
analysis."

### Reviewer Delegation: Git Diff Inclusion

When delegating to the **reviewer**, always include a `## Git Diff` section in the
delegation prompt. This enables the reviewer's diff-scoped reading mode, which reduces
token consumption by 25-35% while maintaining review quality.

```
[Task description -- what to review and what to check for]

## Files to Review
{files_changed from the developer's structured result}

## Git Diff
{output of `git diff -- <files_changed>` showing what the developer changed}

If the diff exceeds 500 lines, include only the first 500 lines and append:
"[diff truncated -- {total_lines} total lines, showing first 500]"

## Context
{architect design, task requirements, or other relevant context}
```

The diff gives the reviewer a precise map of what changed, so it can focus analysis on
modified lines and only read full files when surrounding context is needed.

---

## Section 11: Context Handoff Template

Use this template when spawning a sequential agent that depends on a prior agent's work:

```
[Task description for Agent B -- specific, self-contained, per Section 3 rules]

## Context from Previous Agent

The {previous_agent} completed {previous_task}. Key context:

### KB Entries to Read
- `.orchestray/kb/{category}/{slug-1}.md` -- {summary from index}
- `.orchestray/kb/{category}/{slug-2}.md` -- {summary from index}

### Code Changes
{git diff output -- or summary if diff exceeds 200 lines}

Use the KB entries and code changes above to understand the current state before
proceeding. Do NOT re-read files covered by the KB entries -- they contain the
distilled analysis.
```

**Template field reference:**
- `{previous_agent}`: The agent type that just completed (architect, developer, etc.)
- `{previous_task}`: One-line description of what the previous agent did
- `{category}/{slug-N}`: Exact paths from index.json entries written by the previous agent
- `{summary from index}`: The `summary` field from the index entry (50 tokens max)
- `{git diff output}`: Output of `git diff` for the previous agent's changes

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

**Approaches Considered:**
{approaches_considered section content}

**Assumptions Made:**
{assumptions section content}

**Key Trade-Offs:**
{trade_offs section content}

**Risky Decisions:**
{risky_decisions section content}

**Discoveries:**
{discoveries section content}

[Repeat for up to 3 relevant traces]
```

### Template Field Reference

- `{source_agent}`: The agent type that produced the trace (architect, developer, etc.)
- `{task_id}`: The subtask ID from the trace's YAML frontmatter
- `{source_model}`: The model used by the source agent (sonnet, opus)
- Section content fields: Copy directly from the trace file's markdown sections

### Rules

- Only include traces that pass the relevance filter (file overlap or dependency edge).
- Cap at 3 traces and ~1,000 words total. If exceeded, drop the least relevant trace.
- If no relevant traces exist, omit the entire `## Upstream Reasoning Context` section.
  Do NOT include an empty section.
- Traces from Haiku agents should never exist (Section 4.Y skips Haiku), but if
  encountered, exclude them.

---

## Per-Agent Pre-Flight Checklists

Before spawning any agent, the PM must verify the delegation prompt addresses every item
on that agent's checklist (Section 3.X in pm.md). This is a PM-internal reasoning step --
zero tool calls, zero extra cost. Items that cannot be addressed should be noted as
"N/A: {reason}" in the delegation prompt.

### Developer Checklist

- [ ] Input validation requirements specified? (what inputs does the code accept, what are the constraints)
- [ ] Error handling pattern referenced? (how should errors be caught, logged, surfaced)
- [ ] Test expectations included? (should the developer write tests, which types, for which cases)
- [ ] Backward compatibility constraints noted? (existing APIs, consumers, data formats to preserve)
- [ ] Import/dependency constraints stated? (allowed libraries, no new dependencies, use existing utils)
- [ ] Self-check instruction included? (compile, lint, test commands to run before reporting)

### Architect Checklist

- [ ] Existing patterns to follow referenced? (current codebase conventions, established approaches)
- [ ] Constraints listed? (performance budgets, security requirements, compatibility targets)
- [ ] Scope boundaries explicit? (what is in scope vs. out of scope for this design)
- [ ] Decision format requested? (tradeoff analysis with options, pros/cons, recommendation)

### Reviewer Checklist

- [ ] Specific file paths listed? (not "review the changes" -- exact files to examine)
- [ ] Task requirements included? (what the code should do, not just "check for bugs")
- [ ] Architect design reference linked if applicable? (design doc or KB entry for spec conformance)
- [ ] Priority dimensions specified? (correctness, security, performance, maintainability -- which matter most)
- [ ] Git diff included? (per the Reviewer Delegation: Git Diff Inclusion protocol above)

### Tester Checklist

- [ ] Test scope defined? (unit, integration, e2e -- which types to write)
- [ ] Edge cases listed? (boundary conditions, error cases, empty inputs the tests should cover)
- [ ] Existing test patterns referenced? (test framework, helper utilities, fixture conventions)
- [ ] Source files to test identified? (exact paths, not "test the new code")

### Debugger Checklist

- [ ] Symptom description included? (what fails, how it manifests, error messages)
- [ ] Reproduction steps provided? (commands, inputs, or test cases that trigger the issue)
- [ ] Relevant file paths listed? (where the bug likely lives, recent changes)
- [ ] Expected vs. actual behavior stated? (what should happen vs. what does happen)

### Refactorer Checklist

- [ ] Scope of refactoring defined? (which files/modules, what transformation)
- [ ] Behavioral equivalence requirement stated? (output must not change, tests must still pass)
- [ ] Existing test coverage noted? (are there tests that protect against regressions)
- [ ] Target structure described? (desired end state -- module boundaries, naming, patterns)

### Inventor Checklist

- [ ] Problem description included? (what needs to be solved, why existing solutions fail)
- [ ] Constraints stated? (no external dependencies, performance targets, API surface)
- [ ] Success criteria defined? (what makes the invention "done" -- prototype, benchmark, proof)
- [ ] Build-vs-buy context provided? (why custom over off-the-shelf, what was considered)

### Documenter Checklist

- [ ] Documentation type specified? (README, API reference, changelog, ADR, inline docs)
- [ ] Target audience identified? (developers, end users, contributors, ops)
- [ ] Source files referenced? (what code to document, what behavior to describe)
- [ ] Existing doc conventions noted? (format, location, style of existing documentation)

### Security Engineer Checklist

- [ ] Threat scope defined? (which components, attack surfaces, data flows to analyze)
- [ ] Security requirements listed? (compliance standards, auth model, data sensitivity)
- [ ] Existing security measures noted? (current auth, encryption, input validation in place)
- [ ] Output format specified? (threat model, vulnerability report, remediation plan)

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
