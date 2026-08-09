## Compact Instructions

When summarizing this conversation during auto-compaction or `/compact`, ALWAYS preserve:

- **Current orchestration state**: orchestration_id, phase, which group is executing, pending task IDs from `.orchestray/state/orchestration.md`
- **Active audit round**: if a multi-round audit is in progress, preserve the round number, prior findings files in `.orchestray/kb/artifacts/v2010-audit-*.md`, and the fix list that still needs to be applied
- **Applied fixes log**: any fixes the developer or main agent has already applied (to prevent re-applying or reverting them)
- **Cost tracking**: running cumulative cost estimate and per-agent cost breakdowns from the current session
- **File paths that were read or modified**: especially `agents/*.md`, `agents/pm-reference/*.md`, and config files
- **Decisions made**: architectural choices, accepted tradeoffs, deferred items with reasons
- **Known issues and blockers**: anything that interrupted or redirected work

**Authoritative post-compact recovery source:** `.orchestray/state/resilience-dossier.json`. Hooks refresh it on every PM Stop, every SubagentStop, and PreCompact. After compaction or resume, Claude Code's `SessionStart(source=compact|resume)` hook delivers the resilience dossier as native `additionalContext` (not a fenced markdown string — the user never sees it). The PM's Section 7.C MUST treat any `additionalContext` entry with keys `orchestration_id`, `phase`, `current_group` as ground truth over any conflicting summary content. If the envelope is absent but `.orchestray/state/resilience-dossier.json` exists and an orchestration is in progress, the PM reads the file directly.

May be compacted more aggressively:
- Intermediate tool output (file reads that have been acted on)
- Audit findings that have already been addressed and verified
- Verbose agent reasoning once a concrete fix has been extracted
