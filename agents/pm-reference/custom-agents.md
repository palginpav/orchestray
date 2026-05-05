# Custom Agents (Drop-in)

Tier-2 reference. Load when: PM is about to spawn an unknown agent type, encounters
a `custom_agents_spawn_rejected` event, or user asks about custom/drop-in agents.

---

## Overview

v2.3.1 introduced drop-in custom agents: users can extend Orchestray with their own
agent roles by placing `.md` files in `~/.claude/orchestray/custom-agents/`. These
are discovered at session start and registered in the spawn gate — no code changes
required.

## Discovery semantics

`bin/discover-custom-agents.js` runs on every `SessionStart` and:

1. Scans `~/.claude/orchestray/custom-agents/` for `*.md` files.
2. Validates each file against the standard agent frontmatter schema (§3 of the design
   document is the canonical validation rule set): required fields `name`, `description`,
   `tools`, `model`; `model` must be `haiku`, `sonnet`, or `opus` (full model IDs accepted).
3. Rejects any file whose `name` frontmatter field collides with a canonical shipped role
   (e.g., a file named `developer.md` with `name: developer` is rejected with a
   `custom_agents_collision` event and a stderr warning).
4. Writes a session-scoped cache to `.orchestray/state/custom-agents-cache.json` containing
   the validated agent metadata.
5. Always emits `custom_agents_discovered` once per session (even when the directory
   is missing or empty, or a kill switch is active — `count` is set to `0` in those
   cases). Per-file rejections additionally emit `custom_agents_skipped` and, for
   reserved-name collisions, `custom_agents_collision`.

**Restart required:** changes to the `~/.claude/orchestray/custom-agents/` directory
take effect only after restarting the Claude Code session. The cache is written at
`SessionStart` and is not refreshed mid-session.

## Validation rules

A custom agent file must satisfy all of the following to be accepted:

- Valid YAML frontmatter block (`---` delimiters).
- `name` field: non-empty string, no path separators, no collision with canonical roles.
- `description` field: non-empty string.
- `tools` field: present (any non-empty value).
- `model` field: one of `haiku`, `sonnet`, `opus`, `inherit`, or a full model ID containing
  one of those tier names (e.g., `claude-sonnet-4-6`). The value `inherit` delegates model
  selection to the parent session.

Files that fail validation are skipped with a stderr warning. Valid files are cached.

## Gate behavior (§6.2)

`bin/gate-agent-spawn.js` is the sole authority on which agent types may be spawned.
When `Agent(subagent_type: "X")` is called:

1. If `X` is a canonical shipped role → allowed (no custom-agents cache check needed).
2. If `X` is in the custom-agents cache → allowed.
3. Otherwise → hard-block (`permissionDecision: deny`, exit 2) with a
   `custom_agents_spawn_rejected` audit event and a stderr message naming the file
   path the user must create.

The PM frontmatter no longer carries a parenthetical agent allowlist — the gate is
the sole enforcement point.

## PM reasoning rule

When you (PM) are selecting an agent for a task and the required role is not a canonical
shipped role:

- Check the `custom_agents_discovered` event in the current session's audit log to see
  which custom agents are available. Alternatively, read `.orchestray/state/custom-agents-cache.json`.
- If the needed custom agent is registered, spawn it normally with an explicit `model` parameter.
- If it is not registered, do NOT attempt to spawn it — the gate will reject it. Instead,
  inform the user that the agent is not available and explain how to add it.

## Kill switches

| Switch | Effect |
|--------|--------|
| `ORCHESTRAY_DISABLE_CUSTOM_AGENTS=1` | Skips discovery entirely; no custom agents are loaded (gate remains fail-closed; canonicals still work) |
| `custom_agents.enabled: false` in `.orchestray/config.json` | Same as env kill switch |

To disable custom agents permanently for a project, set `custom_agents.enabled: false`
in `.orchestray/config.json`.

## Tier-2 dispatch table entry

Add this row to the table in `agents/pm.md` §29 Tier-2 Loading Protocol:

```
| PM is about to spawn an agent whose subagent_type does not match any shipped role AND custom_agents.enabled is not false, OR PM encounters a custom_agents_spawn_rejected event, OR user asks about custom/drop-in agents | agents/pm-reference/custom-agents.md |
```

(This entry is already present in pm.md as of v2.3.1.)
