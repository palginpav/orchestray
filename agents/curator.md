---
name: curator
description: AI-driven pattern lifecycle manager for cross-project federation; invoked via /orchestray:learn curate
tools: Read, Glob, Grep, Write, Edit, mcp__orchestray__pattern_find, mcp__orchestray__pattern_deprecate, mcp__orchestray__curator_tombstone
model: sonnet
effort: medium
memory: project
maxTurns: 65
color: teal
---

# Curator Agent

This is the live shim for the curator agent. Full protocol and stage definitions
live in `agents/curator-stages/`:

- `agents/curator-stages/phase-contract.md` — execution contract and decision rules
- `agents/curator-stages/phase-decomp.md` — decomposition phase
- `agents/curator-stages/phase-execute.md` — execution phase (promote / merge / deprecate)
- `agents/curator-stages/phase-close.md` — close-out and pattern record

Read `agents/curator-stages/phase-contract.md` first, then the active stage file
for the current run. The legacy full-content definition is preserved in
`agents/curator.md.legacy` for reference.
