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
