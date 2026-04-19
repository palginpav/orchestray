# Orchestray

Multi-agent orchestration plugin for [Claude Code](https://claude.ai/code). Automatically detects complex tasks, decomposes them across specialized AI agents, and produces fully audited output — without manual configuration.

## What it does

You type a prompt. Orchestray's PM agent scores its complexity. If it warrants orchestration, the PM decomposes the task, assigns agents (architect, developer, reviewer, custom specialists), coordinates their work, and delivers a consolidated result with full audit trail.

**Simple prompts** pass through to normal Claude Code behavior. **Complex prompts** get the full treatment.

### Key features

- **Upgrade restart prompt** — after `/orchestray:update`, any open Claude Code session sees a one-time stderr reminder on the next user message to restart so the refreshed agent registry takes effect; driven by a schema-v2 sentinel (`~/.claude/.orchestray-upgrade-pending`) written by install.js and consumed by `post-upgrade-sweep.js`'s 4-case state machine (TTL: 7 days)
- **Context status bar** — live subagent context usage, model tier, and effort level in the Claude Code status line; driven by `bin/collect-context-telemetry.js` and `bin/statusline.js` (< 50 ms); toggle with `context_statusbar.enabled` config key
  Note: Orchestray claims the Claude Code `statusLine` slot; if you already use another statusLine command, disable Orchestray's with `context_statusbar.enabled: false`.
  Diagnostic: run `echo '{}' | node bin/statusline.js --dump-stdin` to verify the statusLine stdin payload shape reaching the hook (useful when the status line renders blank or stale).
  FILL semantics: the percentage and token count in `[ctx 28% 283.3K/1M opu-4-7]` measure input-side context pressure (prompt + cache tokens) — not total tokens transacted per spawn. Output tokens leave the model and don't count against the context window, so this number will always be lower than Claude Code's per-spawn total-token counter. An unknown model shows `~TOTAL` instead of `TOTAL` to signal the denominator is a default guess.
- **Context-saving bundle** — six coordinated prompt-engineering techniques (handoff shrinkage, PM slimming, output discipline, Read/Grep hygiene, cache-boundary preservation, telemetry integration) reduce agent token consumption by an estimated ~7k–15k per medium-complexity orchestration
- **Auto-trigger** — complexity scoring detects when orchestration helps, self-calibrates over time
- **Smart model routing** — assigns Haiku/Sonnet/Opus per subtask based on complexity, tracks cost savings; routing decisions are persisted to `.orchestray/state/routing.jsonl` and hook-enforced on every `Agent()`, `Explore()`, and `Task()` spawn, surviving context compaction and session reloads
- **Mid-task elicitation** — agents can pause to ask the user a structured ≤5-field form via `mcp__orchestray__ask_user` and resume with the answers; no orchestration unwind required
- **Hook-enforced MCP retrieval** — pre-decomposition `pattern_find`, `kb_search`, and `history_find_similar_tasks` calls are verified by `gate-agent-spawn.js` via a checkpoint ledger (`.orchestray/state/mcp-checkpoint.jsonl`) before the first orchestration spawn; falls back gracefully via `mcp_enforcement` config flags with no session restart required; the `mcp_enforcement` block is automatically migrated into `.orchestray/config.json` on first 2.0.13+ use; after `pattern_find` returns, the PM calls either `pattern_record_application` or `pattern_record_skip_reason` to produce an auditable signal for every outcome; a skipped pre-spawn retrieval emits a one-time `info:` advisory to stderr (warn-mode)
- **Cache-Aware Tool Result Compaction (R14)** — a `PreToolUse:Read` hook (`bin/context-shield.js`) denies re-reads of the same `(file_path, mtime, size)` triple within a session with no `offset`/`limit` change, eliminating cache-replay token waste; re-reads with an explicit offset/limit or after on-disk changes are always allowed; disable per-session via `shield.r14_dedup_reads.enabled: false`
- **Cache-choreographed PM prompt** — `agents/pm.md` organised into Block A (immutable prefix) / breakpoint sentinel / Block B (semi-stable) / Block C (tail); a `UserPromptSubmit` hook detects prefix drift and emits an audit event; opt-in pre-commit guard prevents accidental Block A edits
- **Cache-hit and cost telemetry** — per-spawn and per-PM-turn metrics recorded in `agent_metrics.jsonl`; cache-hit sparklines, cost-delta vs frozen baseline, and active-experiment state visible in `/orchestray:analytics`
- **Lean PM prompt** — `agents/pm.md` trimmed ~12% (WASTE-tier only: inline config JSON, duplicated warnings, navigation breadcrumbs); pre-strip rollback scaffolding (`pm_prompt_variant`, `pm.old.md`) retired in v2.0.18
- **Adaptive response-length budgets** — reviewer and architect delegation templates include a `response_budget` line scaled to remaining cost margin; reviewer floor at 600 tokens prevents quality-signal truncation (opt-in experiment, default OFF)
- **Live-tail observability** — `/orchestray:watch` polls the current orchestration and renders a compact agent-status table; `/orchestray:state peek` gives a read-only snapshot at any time
- **Mid-flight operator control** — `/orchestray:state pause` blocks further spawns between groups; `/orchestray:state cancel` triggers a clean abort with state archival; `/orchestray:state gc` archives or discards leaked state dirs
- **W-item replay** — `/orchestray:redo <W-id> [--cascade]` re-runs a single step or its full dependent closure; batch confirmation upfront
- **Plan preview** — `/orchestray:run --preview` shows the decomposition and cost estimate before any agents are spawned
- **Honest pattern confidence** — `pattern_find` returns `decayed_confidence` and `age_days`; patterns lose confidence over time so stale advice is surfaced clearly, not silently applied
- **Counterfactual skip signal** — `pattern_record_skip_reason` captures structured `match_quality` and `skip_category` for every skipped pattern, enabling retrospective loop-quality analysis
- **Anti-pattern advisory gate** — before each agent spawn, matching anti-patterns are injected as advisories into the spawned agent's context; advisory-only, never blocks
- **Pre-spawn cost projection** — `cost_budget_check` MCP tool projects the cost of a proposed `Agent()` spawn against configured caps (`max_cost_usd`, `daily_cost_limit_usd`) before execution; pricing table lives in `.orchestray/config.json` under `mcp_server.cost_budget_check.pricing_table` (single source of truth shared with `bin/collect-agent-metrics.js`)
- **PM-driven per-orchestration `events.jsonl` rotation** — at orchestration completion, the PM cleanup sequence atomically archives audit rows for the completed orchestration to `.orchestray/history/<orch-id>/events.jsonl`, keeping the live file bounded; the rotation is crash-safe via a three-state sentinel and idempotent on restart
- **Explore dispatch coverage** — Claude Code's built-in `Explore` and `Task` dispatches are now gated alongside `Agent()` spawns so their model routing decisions are enforced and audited
- **GitHub Issue integration** — orchestrate directly from GitHub issues via `gh` CLI
- **CI/CD feedback loop** — run CI after orchestration, auto-fix failures up to N retries
- **Shift-left security** — dedicated Security Engineer agent auto-invoked on security-sensitive tasks
- **Pipeline templates** — 10 workflow archetypes for consistent decomposition (bug fix, feature, refactor, migration, security audit, release, UX critique, platform Q&A, and more)
- **TDD mode** — test-first orchestration: architect → tester → developer → reviewer
- **Mid-orchestration control** — checkpoints between groups to review, modify, or abort
- **User playbooks** — project-specific instructions injected into agent delegation prompts
- **Parallel execution** — independent subtasks run concurrently via subagents
- **Verify-fix loops** — reviewer failures route back to developer with specific feedback
- **Correction memory** — learns from verify-fix loops, prevents repeated mistakes
- **Cost prediction** — estimates orchestration cost from historical data before execution
- **Persistent specialists** — dynamic agents that prove useful get saved for reuse
- **Pattern learning** — extracts reusable strategies from past orchestrations; patterns are project-local by default and can be shared across projects on the same machine via opt-in federation (`federation.shared_dir_enabled: true`)
- **Cross-project pattern federation** — `~/.orchestray/shared/patterns/` as machine-local hub; opt-in, sensitivity defaults to `"private"`; share via `/orchestray:learn share`, browse with `/orchestray:learn list --shared`
- **SQLite FTS5 retrieval** — BM25-ranked pattern lookup replaces Jaccard keyword scan; lazy index build; graceful fallback to Jaccard when native build unavailable (`better-sqlite3 ^11`, Node 22.5+ prefers `node:sqlite`)
- **AI pattern curator** — `/orchestray:learn curate` runs promote/merge/deprecate with tombstone rollback; undo via `undo-last` or `undo <action-id>`; sacred invariants: `user-correction` patterns never auto-deprecated, `sensitivity: private` patterns never auto-promoted; every action records a `rationale` field for audit; `/orchestray:learn explain <action-id>` shows the curator's reasoning; `curate --diff` opt-in incremental mode pre-filters patterns on five signals (stamp-absent, body-hash drift, stale-stamp, rollback-touched, merge-lineage-dirty) — only the dirty subset reaches the curator agent
- **Pattern health score** — `/orchestray:patterns` dashboard shows a per-pattern health score (`decayed_confidence × usage_boost × freshness_factor × (1-skip_penalty)`) with tiers healthy ≥ 0.60 / stale 0.40–0.59 / needs-attention < 0.40; a `### Needs attention` section surfaces patterns worth curating
- **Federation tier badges** — `pattern_find` results carry `[local]` / `[shared]` / `[shared, own]` badges in delegation prompts and the `pattern://` resource banner; `promoted_from` and `promoted_is_own` fields make the trust tier auditable in every orchestration; `share --preview` shows the sanitized diff before committing a share
- **Retrieval match reasons** — `pattern_find` now returns per-term match reasons (`"fts5:term=audit (in context, approach)"`) instead of a flat `"fts5"` label; the keyword fallback path emits `"fallback: keyword"` explicitly
- **Degraded-mode journal** — silent fallbacks (FTS5 unavailable, flat config keys, curator reconcile flags, hook-merge no-ops, and more) are recorded to `.orchestray/state/degraded.jsonl` (1 MB × 3-gen rotation); `/orchestray:status` surfaces a one-liner when the journal is non-empty; run `/orchestray:doctor` for full diagnostics; run `/orchestray:doctor --deep` to verify all installed file hashes against the manifest
- **Intelligence bundle (v2.1.3)** — shadow scorer seam runs alternate retrieval ranking side-by-side with baseline (no live ranking change; telemetry in `.orchestray/state/scorer-shadow.jsonl`); MinHash+Jaccard duplicate pre-filter cuts curator attention from O(N²) to O(N+k); `recently_curated_*` frontmatter stamps close the audit loop between curator actions and touched patterns; manifest v2 with per-file SHA-256 hashes enables install-integrity verification via `/orchestray:doctor --deep`
- **Researcher + curate --diff bundle (v2.1.4)** — new Researcher agent surveys external approaches before Architect/Inventor is spawned, returning a decision-ready shortlist; merge tombstones now carry MinHash similarity parameters (`similarity_method`, `similarity_threshold`, `similarity_k`, `similarity_m`) for reproducible pre-filter replay; `curate --diff` opt-in incremental mode (enable with `curator.diff_enabled: true`) cuts curator cost on stable pattern libraries; self-healing forced-full sweep every 10th run
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

### Post-install: enable context status bar (optional)

The context status bar for the **main session** is opt-in and lives in your user-scope
Claude Code settings (not the plugin). Plugin settings cannot register a session-scope
`statusLine` — Claude Code only honors `agent` and `subagentStatusLine` from a plugin.
(Subagent status is already wired automatically by Orchestray's plugin settings — no
action needed for that.)

To enable the **main session** status bar, add the following to
`~/.claude/settings.json` (create the file if it does not exist). Replace
`/ABSOLUTE/PATH/TO/orchestray` with the real install path — `${CLAUDE_PLUGIN_ROOT}`
does NOT expand in user-scope settings, so you must substitute the absolute path to
the plugin's `bin/statusline.js`.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /ABSOLUTE/PATH/TO/orchestray/bin/statusline.js",
    "padding": 0
  }
}
```

For a global install via `npx orchestray --global`, the path is usually
`~/.claude/plugins/orchestray/bin/statusline.js`; resolve the absolute form with
`readlink -f ~/.claude/plugins/orchestray/bin/statusline.js` on Linux/macOS.

Restart Claude Code after the edit. Verify with:

```bash
echo '{}' | node /ABSOLUTE/PATH/TO/orchestray/bin/statusline.js --dump-stdin
```

To disable without removing the entry, set `context_statusbar.enabled: false` in
`.orchestray/config.json`.

## Usage

Orchestray activates automatically on complex prompts. You can also use slash commands:

| Command | What it does |
|---------|-------------|
| `/orchestray:run [task]` | Manually trigger orchestration |
| `/orchestray:run --preview` | Show decomposition plan and cost estimate before executing |
| `/orchestray:issue [#/url]` | Orchestrate from a GitHub issue |
| `/orchestray:status` | Check orchestration state |
| `/orchestray:watch` | Live-tail the current orchestration (refreshes until complete) |
| `/orchestray:state peek` | Read-only snapshot of active and leaked state dirs |
| `/orchestray:state gc` | Archive or discard leaked state dirs |
| `/orchestray:state pause` | Pause between groups (blocks further spawns) |
| `/orchestray:state cancel` | Clean-abort the current orchestration with state archival |
| `/orchestray:redo <W-id>` | Re-run a W-item; use `--cascade` to re-run dependents too |
| `/orchestray:config` | View/modify settings |
| `/orchestray:report` | Generate audit report with cost breakdown |
| `/orchestray:playbooks` | Manage project-specific playbooks |
| `/orchestray:specialists` | Manage persistent specialist agents |
| `/orchestray:workflows` | Manage custom YAML workflow definitions |
| `/orchestray:federation status` | Show federation enabled/disabled/partial state, shared-dir contents, FTS5 status, and origin attribution |
| `/orchestray:doctor` | Run 8 health probes (migrations, MCP tools, config keys, FTS5, ABI, degraded journal); emits `doctor-result-code: 0/1/2`; add `--deep` for full install-integrity manifest verification |
| `/orchestray:learn [id]` | Extract patterns, capture corrections, manage federation sharing (`share` / `unshare` / `list --shared`), curate with AI (`curate` / `curate --diff` / `undo-last` / `undo <id>`); `explain <action-id>` shows curator rationale; `share --preview` diffs without writing |
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
| **Researcher** | Read-only, web-enabled survey of existing external approaches; returns a decision-ready shortlist for PM to route to Architect or Inventor |
| **Inventor** | First-principles creation of novel tools, DSLs, and custom solutions with working prototypes |
| **Debugger** | Systematic bug investigation and root cause analysis (read-only) |
| **Tester** | Dedicated test writing, coverage analysis, and test strategy |
| **Documenter** | Documentation creation and maintenance |
| **Release Manager** | Owns release commits — version bump, CHANGELOG, README sweep, event-schema sync, pre-publish verification, tag prep |
| **UX Critic** | Adversarial read-only critique of user-facing surfaces (commands, errors, statusLine, README) for friction, discoverability, consistency, and surprise |
| **Platform Oracle** | Authoritative answers to Claude Code / Anthropic SDK / API / MCP questions via WebFetch + cited URLs; labels each claim with a stability tier (stable / experimental / community) |
| **Curator** | AI-driven pattern curation — promotes, merges, and deprecates patterns with tombstone rollback; invoked via `/orchestray:learn curate` |
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

v2017_experiments.prompt_caching      "on" (default) | "off" — enables bin/cache-prefix-lock.js drift detection
                                      on every UserPromptSubmit. Monitors Block A stability; never modifies context.
                                      Set "off" to disable; no session restart needed.
v2017_experiments.adaptive_verbosity  "off" (default) | "on" — injects per-agent response-length budgets into
                                      delegation templates. Reviewer minimum floor: 600 tokens.
v2017_experiments.global_kill_switch  true disables all three v2017 behavior flags immediately, no session restart
                                      needed (default: false).

adaptive_verbosity.enabled            Enable adaptive response-length budgets (default: false; also controlled by
                                      v2017_experiments.adaptive_verbosity)
adaptive_verbosity.base_response_tokens    Base token budget for agent responses (default: 2000)
adaptive_verbosity.reducer_on_late_phase   Multiplier applied in late orchestration phases (default: 0.4, range: 0.0–1.0)

cache_choreography.enabled            Enable bin/cache-prefix-lock.js prefix-drift detection (default: false; also
                                      controlled by v2017_experiments.prompt_caching)

state_sentinel.pause_check_enabled    Enable the pause/cancel sentinel PreToolUse hook (default: true); set false
                                      to inert the entire sentinel check without removing the hook
state_sentinel.cancel_grace_seconds   Seconds after cancel.sentinel creation before spawns are blocked (default: 5)

anti_pattern_gate.min_decayed_confidence  Minimum decayed confidence for anti-pattern advisories to fire (default: 0.65);
                                          patterns below this threshold are suppressed even if they match

redo_flow.max_cascade_depth           Maximum W-item cascade depth for /orchestray:redo --cascade (default: 10)
redo_flow.commit_prefix               Git commit prefix used when redo produces a commit (default: "redo")

pattern_decay.default_half_life_days              Default confidence half-life in days (default: 90)
pattern_decay.category_overrides["anti-pattern"]  Half-life override for anti-pattern category (default: 180)

federation.shared_dir_enabled    Enable cross-project pattern sharing (default: false)
federation.sensitivity           Default sensitivity for new patterns: "private" | "shareable" (default: "private")
federation.shared_dir_path       Path to machine-local shared pattern hub (default: "~/.orchestray/shared")

curator.enabled                      Enable the AI pattern curator (default: true)
curator.self_escalation_enabled      Allow curator to escalate uncertain decisions to the user (default: true)
curator.pm_recommendation_enabled    Allow PM to recommend patterns for curation after orchestrations (default: true)
curator.tombstone_retention_runs     Number of past curator runs to keep tombstones for (default: 3)
curator.diff_enabled                 Enable curate --diff incremental mode (default: false — opt-in)
curator.diff_cutoff_days             Stale-stamp threshold for --diff dirty-set: patterns last curated
                                     more than this many days ago are treated as dirty (default: 30)
```

The `mcp_enforcement` block is automatically added to `.orchestray/config.json` on the first `UserPromptSubmit` after upgrading to 2.0.13+ — no manual migration needed. On 2.0.14+, the same sweep also backfills the `mcp_server.cost_budget_check.pricing_table` block if absent. On 2.0.15+, the sweep additionally seeds the `kb_write` tool enable entry and the `pattern_record_skip_reason` / `cost_budget_check` enforcement keys for existing installs. On 2.0.16+, the sweep seeds `routing_lookup`, `cost_budget_reserve`, `pattern_deprecate`, `max_per_task` defaults (20 each), `cost_budget_enforcement`, `cost_budget_reserve.ttl_minutes`, and `routing_gate.auto_seed_on_miss`. On 2.0.17+, the sweep seeds the `v2017_experiments` block (all flags `"off"`), `adaptive_verbosity`, and `cache_choreography`. On 2.0.18+, the sweep also auto-strips the now-removed `pm_prompt_variant` and `pm_prose_strip` keys (emits a `config_key_stripped` audit event).

**MCP resource schemes (2.0.16+).** The MCP server exposes four read-only resource schemes: `kb://`, `history://`, `pattern://`, and `orchestration://`. The `orchestration://` scheme provides live and historical state — `orchestray:orchestration://current` returns the active orchestration phase and task list; sub-resources expose routing decisions (`/current/routing`) and checkpoint state (`/current/checkpoints`). To browse an archived orchestration, use `orchestray:orchestration://<orch-id>`; the `list()` inventory includes the 5 most recent archived IDs. MCP tool count is 15 as of 2.1.0 (`curator_tombstone` added; 14 tools as of 2.0.17).

**Routing-gate match key (2.0.15+).** The routing gate matches spawns on `(task_id, agent_type)` rather than the previous three-field tuple — forgiving to description drift. If you observe gate blocks on valid `Agent()` spawns, confirm that `routing.jsonl` is written before the spawn call; the PM's orchestration prompt now enforces this as a mandatory step.

### Health Signals

`/orchestray:analytics` includes a **Health Signals** section that:
- Warns when `mcp_enforcement.global_kill_switch` is `true` in `.orchestray/config.json` (the gate is bypassed; all MCP checkpoint enforcement is off)
- Scans recent `events.jsonl` for unpaired `kill_switch_activated` events to surface an active kill-switch window that was never closed
- Reports `prefix_drift` events from `bin/cache-prefix-lock.js` when Block A of `agents/pm.md` changed between sessions (2.0.17+, when `v2017_experiments.prompt_caching` is `"on"`)

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
    degraded.jsonl          # Silent-fallback journal; 1 MB × 3-gen rotation (2.1.2+)
    scorer-shadow.jsonl     # Shadow-scorer rank-agreement telemetry; 1 MB × 3-gen rotation (2.1.3+)
    .block-a-hash           # Block A hex hash used by cache-prefix-lock.js (2.0.17+)
  kb/             # Shared knowledge base
  audit/          # Event logs and metrics
  history/        # Archived orchestrations
  metrics/        # Per-spawn and per-PM-turn JSONL metrics (gitignored, 2.0.17+)
    agent_metrics.jsonl           # Per-spawn rows + pm_turn rows
    orchestration_rollup.jsonl    # Per-orchestration rollup
    archive/                      # Rotated files (50 MB threshold)
  specialists/    # Persistent specialist registry
  patterns/       # Extracted learning patterns (gitignored)
  curator/        # Tombstone log for curator rollback (.orchestray/curator/tombstones.jsonl)
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
