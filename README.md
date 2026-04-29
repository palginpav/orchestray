# Orchestray

Multi-agent orchestration plugin for [Claude Code](https://claude.ai/code). Detects complex tasks automatically, decomposes them across specialized AI agents, and delivers fully audited results — no manual configuration needed.

Simple prompts pass straight through to normal Claude Code. Complex ones get decomposed, routed to the right agents, and reassembled with a full audit trail.

## Install

```bash
npx orchestray --global
```

Installs agents, skills, and hooks into `~/.claude/`. Restart Claude Code after install.

Project-local install:

```bash
npx orchestray --local
```

Uninstall:

```bash
npx orchestray --global --uninstall
```

## Quick start

```
/orchestray:run "add rate limiting to the API"
```

That's it. Orchestray scores complexity, decomposes the task, routes agents, runs verify-fix loops, and reports results. Use `--preview` to see the plan before anything runs.

## Key commands

| Command | What it does |
|---------|-------------|
| `/orchestray:run [task]` | Trigger orchestration; `--preview` shows plan first |
| `/orchestray:status` | Active orchestration state |
| `/orchestray:resume` | Resume an interrupted orchestration |
| `/orchestray:loop` | Iterate-until primitive for tasks that need repeated adjustment |
| `/orchestray:rollback` | Restore workspace to a pre-spawn snapshot |
| `/orchestray:analytics` | Cost breakdown, pattern dashboard, health signals |
| `/orchestray:patterns` | Pattern effectiveness dashboard |
| `/orchestray:learn [id]` | Extract patterns; `curate` to AI-curate; `list --proposed` to review auto-proposals |
| `/orchestray:specialists` | Manage persistent specialist agents |
| `/orchestray:workflows` | Manage custom YAML workflow definitions |
| `/orchestray:update` | Update Orchestray to the latest version |
| `/orchestray:report` | Full audit report with cost breakdown |
| `/orchestray:issue [#/url]` | Orchestrate from a GitHub issue |
| `/orchestray:doctor` | Health probes; `--deep` for install-integrity check |

## Agent roles

| Agent | Role |
|-------|------|
| **PM** | Orchestrator — decomposes tasks, assigns work, routes models |
| **Architect** | Design-only — produces design documents and technical decisions |
| **Developer** | Implements code changes |
| **Refactorer** | Code transformation without behavior change |
| **Reviewer** | Read-only review: correctness, quality, security, performance, docs, operability, API compatibility |
| **Debugger** | Bug investigation and root cause analysis (read-only) |
| **Tester** | Test writing, coverage analysis, and test strategy |
| **Documenter** | Documentation creation and maintenance |
| **Security Engineer** | Shift-left security — threat modeling and implementation audit (read-only) |
| **Researcher** | Surveys external approaches; returns decision-ready shortlist before Architect/Inventor |
| **Inventor** | First-principles creation of novel tools, DSLs, and custom solutions |
| **Release Manager** | Version bump, CHANGELOG, README sweep, event-schema sync, tag prep |
| **UX Critic** | Adversarial critique of user-facing surfaces for friction and consistency (read-only) |
| **Platform Oracle** | Authoritative answers to Claude Code / Anthropic SDK / API / MCP questions with cited sources |

Five specialist templates also ship: translator, ui-ux-designer, database-migration, api-contract-designer, error-message-writer. The PM activates them automatically on matching keywords; project-local overrides go in `.orchestray/specialists/`.

## How it works

- PM scores every prompt (0–12). Score below threshold → normal Claude Code. Score at or above threshold → orchestration.
- PM decomposes the task into subtasks, routes each to the right agent (Haiku / Sonnet / Opus by complexity), and runs independent subtasks in parallel.
- Each agent delivers a structured result. Reviewer failures route back to Developer with specific feedback (verify-fix loop).
- On close, Orchestray archives per-orchestration events, extracts patterns, and emits a cost rollup visible in `/orchestray:analytics`.
- Session resilience: if context compacts mid-orchestration, Orchestray writes a dossier before compaction and re-injects it on the next message.

## Configuration

Run `/orchestray:config` to view all settings. Most-used knobs:

| Key | Default | What it does |
|-----|---------|-------------|
| `complexity_threshold` | `4` | Score threshold for auto-orchestration |
| `auto_review` | `true` | Auto-spawn reviewer after developer |
| `model_floor` | `sonnet` | Minimum model tier: haiku / sonnet / opus |
| `confirm_before_execute` | `false` | Show preview before execution |
| `daily_cost_limit_usd` | `null` | Daily spending cap |

## Kill switches

Set in `.orchestray/config.json` or as env vars. No session restart required.

| Feature | Config key | Env var |
|---------|-----------|---------|
| Orchestration auto-trigger | `complexity_threshold: 99` | — |
| Prompt compression (Tokenwright) | `compression.enabled: false` | `ORCHESTRAY_DISABLE_COMPRESSION=1` |
| Reactive agent spawning | — | `ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1` |
| Housekeeper auto-spawn | — | `ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED=1` |
| Loop primitive | — | `ORCHESTRAY_DISABLE_LOOP=1` |
| Workspace snapshots | — | `ORCHESTRAY_DISABLE_SNAPSHOTS=1` |
| Haiku scout (file ops) | `haiku_routing.enabled: false` | — |
| Compaction resilience | `resilience.enabled: false` | `ORCHESTRAY_RESILIENCE_DISABLED=1` |
| MCP enforcement gate | `mcp_enforcement.global_kill_switch: true` | — |

## Requirements

- [Claude Code](https://claude.ai/code) v2.0.0+; v2.1.59+ recommended
- Node.js 20 LTS

## Troubleshooting

**Agent registry changes don't take effect after `/orchestray:update`.**
Claude Code caches agent definitions at session start. Restart the session after every update.

**`mcp__orchestray__schema_get` returns `stale_index`.**
Run `node bin/regen-schema-shadow.js` followed by `node -e "require('./bin/_lib/tier2-index').buildIndex({cwd: process.cwd()})"`. The PostToolUse(Edit) hook normally handles this automatically.

**Gate blocks first spawn after upgrade.**
On the next user prompt, `bin/post-upgrade-sweep.js` repairs stale checkpoint rows automatically. If the gate still blocks, set `mcp_enforcement.global_kill_switch: true` (and a `kill_switch_reason`) in `.orchestray/config.json` to complete the in-flight orchestration, then clear both fields.

## License

MIT
