# Orchestray

Multi-agent orchestration plugin for [Claude Code](https://claude.ai/code). Automatically detects complex tasks, decomposes them across specialized AI agents, and produces fully audited output — without manual configuration.

## What it does

You type a prompt. Orchestray's PM agent scores its complexity. If it warrants orchestration, the PM decomposes the task, assigns agents (architect, developer, reviewer, custom specialists), coordinates their work, and delivers a consolidated result with full audit trail.

**Simple prompts** pass through to normal Claude Code behavior. **Complex prompts** get the full treatment.

### Key features

- **Auto-trigger** — complexity scoring detects when orchestration helps, self-calibrates over time
- **Smart model routing** — assigns Haiku/Sonnet/Opus per subtask based on complexity, tracks cost savings; routing decisions are persisted to `.orchestray/state/routing.jsonl` and hook-enforced on every `Agent()`, `Explore()`, and `Task()` spawn, surviving context compaction and session reloads
- **Mid-task elicitation** — agents can pause to ask the user a structured ≤5-field form via `mcp__orchestray__ask_user` and resume with the answers; no orchestration unwind required
- **Hook-enforced MCP retrieval** — pre-decomposition `pattern_find`, `kb_search`, and `history_find_similar_tasks` calls are verified by `gate-agent-spawn.js` via a checkpoint ledger (`.orchestray/state/mcp-checkpoint.jsonl`) before the first orchestration spawn; falls back gracefully via `mcp_enforcement` config flags with no session restart required; the `mcp_enforcement` block is automatically migrated into `.orchestray/config.json` on first 2.0.13+ use; after `pattern_find` returns, the PM calls either `pattern_record_application` or `pattern_record_skip_reason` to produce an auditable signal for every outcome
- **Cache-Aware Tool Result Compaction (R14)** — a `PreToolUse:Read` hook (`bin/context-shield.js`) denies re-reads of the same `(file_path, mtime, size)` triple within a session with no `offset`/`limit` change, eliminating cache-replay token waste; re-reads with an explicit offset/limit or after on-disk changes are always allowed; disable per-session via `shield.r14_dedup_reads.enabled: false`
- **Pre-spawn cost projection** — `cost_budget_check` MCP tool projects the cost of a proposed `Agent()` spawn against configured caps (`max_cost_usd`, `daily_cost_limit_usd`) before execution; pricing table lives in `.orchestray/config.json` under `mcp_server.cost_budget_check.pricing_table` (single source of truth shared with `bin/collect-agent-metrics.js`)
- **PM-driven per-orchestration `events.jsonl` rotation** — at orchestration completion, the PM cleanup sequence atomically archives audit rows for the completed orchestration to `.orchestray/history/<orch-id>/events.jsonl`, keeping the live file bounded; the rotation is crash-safe via a three-state sentinel and idempotent on restart
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
mcp_enforcement.pattern_record_application  Enforcement mode for the pattern-record protocol: "hook-strict" (default) blocks
                                            the 2nd+ Agent() spawn until the PM records a pattern decision; "hook-warn" allows
                                            the spawn with an advisory event only. Set "hook-warn" to roll back the 2.0.16
                                            behavior change.
mcp_enforcement.unknown_tool_policy       block/warn/allow — policy for unrecognised dispatch names (default: block)
mcp_enforcement.global_kill_switch        true restores 2.0.11 enforcement behaviour; no session restart needed (default: false)

audit.max_events_bytes_for_scan   Maximum bytes of events.jsonl scanned per hook invocation;
                                  override with ORCHESTRAY_MAX_EVENTS_BYTES env var (default: 32 MB
                                  (vs the prior 2 MB cap); set lower on constrained environments)

mcp_server.tools.pattern_record_skip_reason  Enable the pattern_record_skip_reason MCP tool (default: true)
mcp_server.tools.cost_budget_check           Enable the cost_budget_check MCP tool (default: true)
mcp_server.tools.kb_write                    Enable the kb_write MCP tool for atomic artifact write + index.json update (default: true)
mcp_server.tools.routing_lookup              Enable the routing_lookup MCP tool (default: true)
mcp_server.tools.cost_budget_reserve         Enable the cost_budget_reserve MCP tool (default: true)
mcp_server.tools.pattern_deprecate           Enable the pattern_deprecate MCP tool (default: true)

mcp_server.max_per_task.ask_user             Maximum ask_user calls per task before rate-limit error (default: 20)
mcp_server.max_per_task.kb_write             Maximum kb_write calls per task before rate-limit error (default: 20)
mcp_server.max_per_task.pattern_record_application  Maximum pattern_record_application calls per task (default: 20)

mcp_server.cost_budget_check.pricing_table   Per-model pricing used by cost_budget_check and collect-agent-metrics;
                                              seeded on install with current Anthropic pricing (Haiku $1/$5,
                                              Sonnet $3/$15, Opus $5/$25); edit this block to update prices
                                              (single source of truth — eliminates two-table drift)

cost_budget_enforcement.enabled              Enable the PreToolUse cost-budget gate hook (default: false)
cost_budget_enforcement.hard_block           When true, gate blocks spawn on budget breach; when false, warns to
                                              stderr only (default: true — applies only when enabled: true)

mcp_server.cost_budget_reserve.ttl_minutes   How long a cost reservation stays valid, in minutes (default: 30,
                                              range: 1–1440)

routing_gate.auto_seed_on_miss               When true, an Agent() spawn with no matching routing entry is
                                              allowed and a synthesized entry is added with a stderr warning;
                                              when false, the gate hard-blocks unregistered spawns (default: true)

shield.r14_dedup_reads.enabled    Enable R14 cache-replay dedup for Read tool calls (default: true);
                                  set false to disable the context-shield hook without removing it
```

The `mcp_enforcement` block is automatically added to `.orchestray/config.json` on the first `UserPromptSubmit` after upgrading to 2.0.13+ — no manual migration needed. On 2.0.14+, the same sweep also backfills the `mcp_server.cost_budget_check.pricing_table` block if absent. On 2.0.15+, the sweep additionally seeds the `kb_write` tool enable entry and the `pattern_record_skip_reason` / `cost_budget_check` enforcement keys for existing installs. On 2.0.16+, the sweep seeds `routing_lookup`, `cost_budget_reserve`, `pattern_deprecate`, `max_per_task` defaults (20 each), `cost_budget_enforcement`, `cost_budget_reserve.ttl_minutes`, and `routing_gate.auto_seed_on_miss`.

**MCP resource schemes (2.0.16+).** The MCP server exposes four read-only resource schemes: `kb://`, `history://`, `pattern://`, and `orchestration://`. The `orchestration://` scheme provides live and historical state — `orchestray:orchestration://current` returns the active orchestration phase and task list; sub-resources expose routing decisions (`/current/routing`) and checkpoint state (`/current/checkpoints`). To browse an archived orchestration, use `orchestray:orchestration://<orch-id>`; the `list()` inventory includes the 5 most recent archived IDs. MCP tool count is 12 as of 2.0.16.

**Routing-gate match key (2.0.15+).** The routing gate matches spawns on `(task_id, agent_type)` rather than the previous three-field tuple — forgiving to description drift. If you observe gate blocks on valid `Agent()` spawns, confirm that `routing.jsonl` is written before the spawn call; the PM's orchestration prompt now enforces this as a mandatory step.

### Health Signals

`/orchestray:analytics` includes a **Health Signals** section that:
- Warns when `mcp_enforcement.global_kill_switch` is `true` in `.orchestray/config.json` (the gate is bypassed; all MCP checkpoint enforcement is off)
- Scans recent `events.jsonl` for unpaired `kill_switch_activated` events to surface an active kill-switch window that was never closed

If the kill switch is active, the analytics output shows a bold warning with the config key and file path needed to clear it.

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
- Claude Code 2.1.59+ recommended — earlier versions may produce `outcome: "skipped"` rows in the MCP checkpoint ledger; the context-shield hook also targets CC 2.1.59's `PreToolUse` payload shape
- Agent Teams features require v2.1.32+ (opt-in)

Agent Teams features (TaskCreated / TaskCompleted / TeammateIdle hooks) require Claude Code v2.1.32+ with the experimental flag `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` set in the environment or `settings.json`. Without the flag, these hooks are installed but dormant — nothing breaks, they simply never fire.

## Troubleshooting

### Gate blocks first spawn after upgrade

If `gate-agent-spawn.js` blocks the PM's first `Agent()` call after upgrading to 2.0.13+, the most likely cause is that the automatic checkpoint-ledger migration has not yet run (it fires on the next `UserPromptSubmit`, not at install time). Try the following in order:

1. **Wait for the sweep.** On the next user prompt the `bin/post-upgrade-sweep.js` hook will run and repair any stale phase rows in `.orchestray/state/mcp-checkpoint.jsonl`. If the gate then passes, you're done.
2. **Nuclear option — kill switch.** Set `mcp_enforcement.global_kill_switch: true` (and a non-empty `kill_switch_reason`) in `.orchestray/config.json` to bypass the checkpoint gate entirely and complete the in-flight orchestration. Clear both fields once you're done. No session restart is required.
3. **Manual sentinel reset.** If the sweep appears stuck, delete `.orchestray/state/.mcp-checkpoint-migrated-2013` to force it to re-run on the next prompt.

Reference: `bin/post-upgrade-sweep.js` is the automatic recovery path. `mcp_enforcement.global_kill_switch` is the always-available manual escape hatch.

## License

MIT
