# Orchestray

Multi-agent orchestration plugin for [Claude Code](https://claude.ai/code). Automatically detects complex tasks, decomposes them across specialized AI agents, and produces fully audited output — without manual configuration.

## What it does

You type a prompt. Orchestray's PM agent scores its complexity. If it warrants orchestration, the PM decomposes the task, assigns agents (architect, developer, reviewer, custom specialists), coordinates their work, and delivers a consolidated result with full audit trail.

**Simple prompts** pass through to normal Claude Code behavior. **Complex prompts** get the full treatment.

### Key features

- **Auto-trigger** — complexity scoring detects when orchestration helps
- **Smart model routing** — assigns Haiku/Sonnet/Opus per subtask based on complexity, tracks cost savings
- **Parallel execution** — independent subtasks run concurrently via subagents
- **Verify-fix loops** — reviewer failures route back to developer with specific feedback
- **Persistent specialists** — dynamic agents that prove useful get saved for reuse
- **Pattern learning** — extracts reusable strategies from past orchestrations
- **Agent Teams** — opt-in dual-mode execution for tasks needing inter-agent communication
- **Full audit trail** — per-agent tokens, cost breakdown, routing decisions, model savings

## Install

```bash
npx orchestray --global
```

This installs agents, skills, and hooks into `~/.claude/`. No `--plugin-dir` flag needed — Claude Code discovers them automatically.

For project-local install:

```bash
npx orchestray --local
```

### Uninstall

```bash
npx orchestray --global --uninstall
```

## Usage

Orchestray activates automatically on complex prompts. You can also use slash commands:

| Command | What it does |
|---------|-------------|
| `/orchestray:run [task]` | Manually trigger orchestration |
| `/orchestray:status` | Check orchestration state |
| `/orchestray:config` | View/modify settings |
| `/orchestray:report` | Generate audit report with cost breakdown |
| `/orchestray:specialists` | Manage persistent specialist agents |
| `/orchestray:learn [id]` | Extract patterns from a past orchestration |
| `/orchestray:resume` | Resume interrupted orchestration |

## Agent roles

| Agent | Role |
|-------|------|
| **PM** | Orchestrator — decomposes tasks, assigns work, monitors progress, routes models |
| **Architect** | Design-only — produces design documents and technical decisions |
| **Developer** | Implements code changes |
| **Reviewer** | Read-only review across correctness, quality, security, performance |
| **Specialists** | Dynamic or persistent agents for domain-specific tasks |

## Configuration

Run `/orchestray:config` to view all settings. Key options:

```
complexity_threshold    Score threshold for auto-orchestration (default: 6)
auto_review             Auto-spawn reviewer after developer (default: true)
model_floor             Minimum model tier: haiku/sonnet/opus (default: sonnet)
force_model             Override all routing with a specific model (default: null)
enable_agent_teams      Enable Agent Teams mode (default: false)
```

## How it works

```
User prompt
    |
    v
Complexity scoring (0-12)
    |
    +-- Score < threshold --> Normal Claude Code
    |
    +-- Score >= threshold --> PM orchestration
            |
            v
        Task decomposition
            |
            v
        Model routing (Haiku/Sonnet/Opus per subtask)
            |
            v
        Agent spawning (parallel where safe)
            |
            v
        Result collection + verify-fix loops
            |
            v
        Pattern extraction + audit report
```

## Runtime state

All orchestration state lives in `.orchestray/` (gitignored):

```
.orchestray/
  state/          # Active orchestration state
  kb/             # Shared knowledge base
  audit/          # Event logs and metrics
  history/        # Archived orchestrations
  specialists/    # Persistent specialist registry
  patterns/       # Extracted learning patterns
  config.json     # User configuration
```

## Requirements

- [Claude Code](https://claude.ai/code) v2.0.0+
- Agent Teams features require v2.1.32+ (opt-in)

## License

MIT
