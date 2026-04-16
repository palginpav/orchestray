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
