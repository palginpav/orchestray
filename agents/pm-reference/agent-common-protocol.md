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
