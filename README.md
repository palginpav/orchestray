# Orchestray

Multi-agent orchestration plugin for [Claude Code](https://claude.ai/code). Automatically detects complex tasks, decomposes them across specialized AI agents, and produces fully audited output — without manual configuration.

## What it does

You type a prompt. Orchestray's PM agent scores its complexity. If it warrants orchestration, the PM decomposes the task, assigns agents (architect, developer, reviewer, custom specialists), coordinates their work, and delivers a consolidated result with full audit trail.

**Simple prompts** pass through to normal Claude Code behavior. **Complex prompts** get the full treatment.

### Key features

- **Auto-trigger** — complexity scoring detects when orchestration helps, self-calibrates over time
- **Smart model routing** — assigns Haiku/Sonnet/Opus per subtask based on complexity, tracks cost savings; routing decisions are persisted to `.orchestray/state/routing.jsonl` and hook-enforced on every `Agent()`, `Explore()`, and `Task()` spawn, surviving context compaction and session reloads
- **Mid-task elicitation** — agents can pause to ask the user a structured ≤5-field form via `mcp__orchestray__ask_user` and resume with the answers; no orchestration unwind required
- **Hook-enforced MCP retrieval** — pre-decomposition `pattern_find`, `kb_search`, and `history_find_similar_tasks` calls are verified by `gate-agent-spawn.js` via a checkpoint ledger (`.orchestray/state/mcp-checkpoint.jsonl`) before the first orchestration spawn; falls back gracefully via `mcp_enforcement` config flags with no session restart required
- **Explore dispatch coverage** — Claude Code's built-in `Explore` and `Task` dispatches are now gated alongside `Agent()` spawns so their model routing decisions are enforced and audited
- **GitHub Issue integration** — orchestrate directly from GitHub issues via `gh` CLI
- **CI/CD feedback loop** — run CI after orchestration, auto-fix failures up to N retries
- **Shift-left security** — dedicated Security Engineer agent auto-invoked on security-sensitive tasks
- **Pipeline templates** — 7 workflow archetypes for consistent decomposition (bug fix, feature, refactor, migration, etc.)
- **TDD mode** — test-first orchestration: architect → tester → developer → reviewer
- **Mid-orchestration control** — checkpoints between groups to review, modify, or abort
- **User playbooks** — project-specific instructions injected into agent delegation prompts
- **Parallel execution** — independent subtasks run concurrently via subagents
- **Verify-fix loops** — reviewer failures route back to developer with specific feedback
- **Correction memory** — learns from verify-fix loops, prevents repeated mistakes
- **Cost prediction** — estimates orchestration cost from historical data before execution
- **Persistent specialists** — dynamic agents that prove useful get saved for reuse
- **Pattern learning** — extracts reusable strategies from past orchestrations
- **Team features** — shared config, shared patterns, daily/weekly cost budgets
- **Agent Teams** — opt-in dual-mode execution for tasks needing inter-agent communication
- **Prompt tiering** — 3-tier PM prompt architecture, significant token reduction for simple tasks
- **Orchestration contracts** — machine-verifiable quality gates with file ownership tracking
- **Consequence forecasting** — predicts downstream effects before execution, validates after
- **ROI scorecard** — per-orchestration value visibility with cost savings breakdown
- **Diff-scoped review** — reviewer focuses on changed files only, reducing noise
- **Adaptive turn budgets** — dynamic turn limits based on subtask complexity
- **Agent introspection** — Haiku distiller extracts reasoning traces after each agent, eliminating redundant exploration downstream
- **Cognitive backpressure** — agents signal confidence at checkpoints; PM reacts to low-confidence before proceeding
- **Disagreement surfacing** — design trade-offs from reviews presented as structured decisions, not verify-fix loops
- **Drift Sentinel** — architectural drift detection via auto-extracted invariants and static rules
- **Visual Orchestration** — multi-modal screenshot review for UI changes (opt-in)
- **Full audit trail** — per-agent tokens, cost breakdown, routing decisions, model savings
- **Orchestration Threads** — cross-session continuity via compressed thread summaries that carry forward decisions and open items
- **Outcome Tracking** — deferred quality validation via lazy probe execution when you return to delivered files
- **Adaptive Personas** — auto-generated project-tuned behavioral directives injected into agent delegations
- **Replay Analysis** — counterfactual reasoning on friction orchestrations to extract improvement patterns

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
| `/orchestray:issue [#/url]` | Orchestrate from a GitHub issue |
| `/orchestray:status` | Check orchestration state |
| `/orchestray:config` | View/modify settings |
| `/orchestray:report` | Generate audit report with cost breakdown |
| `/orchestray:playbooks` | Manage project-specific playbooks |
| `/orchestray:specialists` | Manage persistent specialist agents |
| `/orchestray:workflows` | Manage custom YAML workflow definitions |
| `/orchestray:learn [id]` | Extract patterns / promote to team / capture corrections |
| `/orchestray:resume` | Resume interrupted orchestration |
| `/orchestray:analytics` | Performance stats + pattern dashboard |
| `/orchestray:patterns` | Pattern effectiveness dashboard |
| `/orchestray:review-pr [#/url]` | Review a GitHub pull request |
| `/orchestray:kb` | View and manage the knowledge base |
| `/orchestray:update` | Update Orchestray to the latest version |

## Agent roles

| Agent | Role |
|-------|------|
| **PM** | Orchestrator — decomposes tasks, assigns work, monitors progress, routes models |
| **Architect** | Design-only — produces design documents and technical decisions |
| **Developer** | Implements code changes |
| **Refactorer** | Systematic code transformation without behavior change |
| **Reviewer** | Read-only review across 7 dimensions: correctness, quality, security, performance, docs, operability, API compatibility |
| **Security Engineer** | Shift-left security — design threat review and implementation audit (read-only) |
| **Inventor** | First-principles creation of novel tools, DSLs, and custom solutions with working prototypes |
| **Debugger** | Systematic bug investigation and root cause analysis (read-only) |
| **Tester** | Dedicated test writing, coverage analysis, and test strategy |
| **Documenter** | Documentation creation and maintenance |
| **Specialists** | Dynamic agents generated during orchestration; successful ones are saved to `.orchestray/specialists/` for reuse |

## Configuration

Run `/orchestray:config` to view all settings. Key options:

```
complexity_threshold    Score threshold for auto-orchestration (default: 4)
auto_review             Auto-spawn reviewer after developer (default: true)
model_floor             Minimum model tier: haiku/sonnet/opus (default: sonnet)
security_review         Security review mode: auto/manual/off (default: auto)
tdd_mode                Prefer TDD orchestration flow (default: false)
confirm_before_execute  Show preview before execution (default: false)
enable_checkpoints      Pause between groups for review (default: false)
ci_command              CI check after orchestration (default: null)
post_to_issue           Comment results on GitHub issue (default: false)
daily_cost_limit_usd    Daily spending limit (default: null)
weekly_cost_limit_usd   Weekly spending limit (default: null)

mcp_enforcement.pattern_find              Hook enforcement mode: hook/prompt/allow (default: hook)
mcp_enforcement.kb_search                 Hook enforcement mode: hook/prompt/allow (default: hook)
mcp_enforcement.history_find_similar_tasks  Hook enforcement mode: hook/prompt/allow (default: hook)
mcp_enforcement.pattern_record_application  Advisory only — not gate-enforced; suppresses pattern_record_skipped advisory event when set to "prompt" or "allow" (default: hook)
mcp_enforcement.unknown_tool_policy       block/warn/allow — policy for unrecognised dispatch names (default: block)
mcp_enforcement.global_kill_switch        true restores 2.0.11 enforcement behaviour; no session restart needed (default: false)
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
  patterns/       # Extracted learning patterns (gitignored)
  playbooks/      # User-authored project playbooks
  config.json     # User configuration (gitignored)
  team-config.json # Team-shared configuration (version-controlled)
  team-patterns/  # Team-shared patterns (version-controlled)
  workflows/      # Custom YAML workflow definitions (version-controlled)
```

## Requirements

- [Claude Code](https://claude.ai/code) v2.0.0+
- Agent Teams features require v2.1.32+ (opt-in)

Agent Teams features (TaskCreated / TaskCompleted / TeammateIdle hooks) require Claude Code v2.1.32+ with the experimental flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` set in the environment or `settings.json`. Without the flag, these hooks are installed but dormant — nothing breaks, they simply never fire.

## License

MIT
