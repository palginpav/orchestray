# hooks/hooks.json — structure notes

`hooks.json` is strict JSON (Claude Code parses it directly) and cannot hold
inline comments. This file is the place for structural notes that would
otherwise need to live as JSON comments.

## Ownership (v2.3.18 W3)

W3 owns `hooks.json` for this release wave. Later waves append to it:

- **W4 (CEL)** — engine + ledger, retires 6 point-gates. Append new
  `PreToolUse`/`SubagentStop` entries; when a retired gate's script is
  deleted, remove its hook entry in the same change.
- **W5a (BDG)** — gate + doctor probe. The harvest seam already exists
  (`bin/_lib/hook-stdin.js`, dormant until `ORCHESTRAY_FIXTURE_HARVEST=1`);
  W5a only needs to add the gate's own hook entry, not touch the harvest.
- **W5b (Co-change Oracle)** — append its own `PreToolUse`/`PostToolUse`
  entry; does not need to reorder existing entries.

**Append at the end of the relevant event's hook array** unless ordering
matters for your case (see below) — this keeps diffs reviewable and avoids
reshuffling entries other waves depend on.

## Hook ordering within an event

Order matters for two reasons:

1. **PreToolUse `updatedInput` — last writer wins.** Sibling `PreToolUse`
   hooks each receive the ORIGINAL stdin, never a prior sibling's mutated
   `tool_input` (platform constraint, see `bin/_lib/hook-stdin.js` header and
   `inject-delegation-delta.js`). When multiple hooks in the same matcher
   group return `updatedInput`, only the LAST one to run is what the tool
   call actually receives. Any hook that injects into `tool_input.prompt`
   (`inject-delegation-delta.js`, `inject-review-dimensions.js`,
   `inject-spawn-agent-hint.js`, `inject-output-shape.js`,
   `inject-tokenwright.js`, `validate-reviewer-git-diff.js`) must run in a
   position where its injection is the one that should win. As of v2.3.18,
   `validate-reviewer-git-diff.js` runs LAST among the prompt-mutators in the
   `Agent` matcher group so its auto-injected `## Git Diff` section is not
   silently discarded by an earlier injector's `updatedInput`.
2. **Validators after mutators.** Read-only validators
   (`validate-task-contracts.js`, `validate-reviewer-dimensions.js`,
   `validate-context-size-hint.js`, etc.) generally belong after the
   injectors in the same matcher group — though since they read the
   ORIGINAL stdin too (same platform constraint), they validate the
   pre-injection prompt, not the final one. This is a pre-existing platform
   limitation, not something any single hook can fix.

If your new hook mutates `tool_input`, place it after the existing
prompt-mutators unless you have a specific reason it needs to win over one
of them (document that reason inline in the hook's own file header, as
`validate-reviewer-git-diff.js` does).
