# Orchestray

Multi-agent orchestration plugin for [Claude Code](https://claude.ai/code). Automatically detects complex tasks, decomposes them across specialized AI agents, and produces fully audited output — without manual configuration.

## What it does

You type a prompt. Orchestray's PM agent scores its complexity. If it warrants orchestration, the PM decomposes the task, assigns agents (architect, developer, reviewer, custom specialists), coordinates their work, and delivers a consolidated result with full audit trail.

**Simple prompts** pass through to normal Claude Code behavior. **Complex prompts** get the full treatment.

### What's new in v2.2.5

**Tokenwright** — Layer 1 prompt compression — ships default-on in v2.2.5. Before each agent spawn, Orchestray now runs a near-duplicate deduplication pass over the delegation prompt and removes redundant blocks (repeated KB attachments, duplicate prior-findings context, accumulated background sections) while leaving all load-bearing content — the handoff contract, structured-result schema, repo map, project-intent block, and immutable prompt prefix — byte-identical. Savings are auditable per-spawn via two new telemetry events visible in `/orchestray:analytics`. Default policy is `safe` (Layer 1 only); additional layers ship in a later release. Kill switches: `compression.enabled: false` in config or `ORCHESTRAY_DISABLE_COMPRESSION=1` env var. The installer also fixes a long-standing bug where hooks pointing at scripts that no longer exist silently accumulate across upgrades, producing noisy `MODULE_NOT_FOUND` errors in Claude Code's hook runner — the installer now sweeps and removes stale entries at install time.

v2.2.3 and v2.2.4 have been rolled back and are not present in v2.2.5. Those releases shipped a routing gateway that was designed to reduce token overhead on simple slash commands by intercepting them before the PM. Audit-log forensics showed the gateway was narrating orchestration outcomes rather than running them — no specialist-spawn events fired across any run. The gateway has been removed; slash commands route directly to the PM as in v2.2.2. Tokenwright is the actual compression that pm-router was supposed to enable, implemented where its effects are verifiable. Restart Claude Code after upgrading.

### What's new in v2.2.0 ("Tokens, not Actions")

The v2.2.0 release reshapes how Orchestray pays for the prompt prefix it sends to Claude on every turn. Nine shipping items, every flag default-on, every behavior change with a kill switch. Headline savings: roughly **−18% to −33% per orchestration** (mid-range −22%; multi-round audits land at the upper end).

- **Smart output shaping** trims hedging and pad-words from prose-heavy agents (debugger, reviewer, documenter) — roughly −21% Opus output / −14% Sonnet on a public April-2026 benchmark with 100% accuracy retained. Default on; `output_shape.enabled: false` or `ORCHESTRAY_DISABLE_OUTPUT_SHAPE=1` to disable. (v2.2.2: the addendum is now applied by a `PreToolUse:Agent` hook on every spawn, so it no longer depends on the orchestrator remembering to inject it.)
- **Chunked schema lookup** replaces the 186 KB event-schemas reload with a small fingerprint plus a new `mcp__orchestray__schema_get` MCP verb that returns the chunk you need. Default on; full-file Read is blocked.
- **Engineered cache geometry** anchors stable prompt prefixes in a byte-stable Block-Z header backed by a 4-slot cache-control manifest with TTL auto-downgrade. Back-to-back orchestrations within the hour pay 90% less for shared overhead. (v2.2.1: the auto-disable sentinel now carries a 1-hour TTL and a trip-counter so transient false positives no longer disable cache geometry permanently.)
- **Haiku scout** (new agent: `haiku-scout`) takes Read/Glob/Grep recon at and above 12 KB off Opus. Three-layer tool-whitelist enforcement; default on.
- **Background-housekeeper Haiku** (new agent: `orchestray-housekeeper`) handles three narrow background ops (KB-write verify, schema-shadow regen, telemetry rollup recompute) at Read+Glob only — stricter than scout. Per-action audit telemetry, drift detector that fails closed on tool-whitelist mutation, three independent kill switches.
- **Deterministic sentinel probes** replace inline Bash for five common checks (file-exists, line-count, git-status, schema-validate, hash-compute) with zero LLM cost.
- **Audit-round auto-archive** distills completed rounds of multi-round audits into compact 500-token digests. Verbatim findings stay in the audit log.
- **Delta delegation for repeat agent spawns** — first spawn gets the full prompt; subsequent spawns get a prefix reference plus a small delta block, hash-anchored so cache misses self-heal. (v2.2.2: composed by a `PreToolUse:Agent` hook on every spawn, so the delta event fires deterministically rather than depending on orchestrator-side prompt composition.)
- **Telemetry truth** — fixed the ~59% duplicate-row bug in `agent_metrics.jsonl`, the silent-default-to-Sonnet bug for team-member rows, and made PM-direct token cost visible in the metrics dashboard for the first time.

**Restart Claude Code after upgrading**: the two new agents (`haiku-scout`, `orchestray-housekeeper`) require a session restart to load.

### Key features

- **Upgrade restart prompt** — after `/orchestray:update`, any open Claude Code session sees a one-time stderr reminder on the next user message to restart so the refreshed agent registry takes effect; driven by a schema-v2 sentinel (`~/.claude/.orchestray-upgrade-pending`) written by install.js and consumed by `post-upgrade-sweep.js`'s 4-case state machine (TTL: 7 days)
- **Context status bar** — live subagent context usage, model tier, and effort level in the Claude Code status line; driven by `bin/collect-context-telemetry.js` and `bin/statusline.js` (< 50 ms); toggle with `context_statusbar.enabled` config key
  Note: Orchestray claims the Claude Code `statusLine` slot; if you already use another statusLine command, disable Orchestray's with `context_statusbar.enabled: false`.
  Diagnostic: run `echo '{}' | node bin/statusline.js --dump-stdin` to verify the statusLine stdin payload shape reaching the hook (useful when the status line renders blank or stale).
  FILL semantics: the percentage and token count in `[ctx 28% 283.3K/1M opu-4-7]` measure input-side context pressure (prompt + cache tokens) — not total tokens transacted per spawn. Output tokens leave the model and don't count against the context window, so this number will always be lower than Claude Code's per-spawn total-token counter. An unknown model shows `~TOTAL` instead of `TOTAL` to signal the denominator is a default guess.
- **Context-saving bundle** — six coordinated prompt-engineering techniques (handoff shrinkage, PM slimming, output discipline, Read/Grep hygiene, cache-boundary preservation, telemetry integration) reduce agent token consumption by an estimated ~7k–15k per medium-complexity orchestration; v2.1.11 adds conditional prompt loading that removes up to ~56K tokens from the PM's first orchestration turn (~162 KB of always-loaded files moved to on-demand)
- **Auto-trigger** — complexity scoring detects when orchestration helps, self-calibrates over time
- **Smart model routing** — assigns Haiku/Sonnet/Opus per subtask based on complexity, tracks cost savings; routing decisions are persisted to `.orchestray/state/routing.jsonl` and hook-enforced on every `Agent()`, `Explore()`, and `Task()` spawn, surviving context compaction and session reloads
- **Aider-style repo map (v2.1.17+)** — when developer, reviewer, refactorer, or debugger is spawned to touch code, the PM sends a focused symbol map (tree-sitter tag extraction → reference graph → PageRank → fit-to-token-budget) instead of a flat file dump. Six bundled language grammars (JS, TS, Python, Go, Rust, Bash); per-role token budgets default to developer 1500 / refactorer 2500 / reviewer 1000 / debugger 1000. Cached on git blob SHA so unchanged files never re-parse. Default on; disable with `repo_map.enabled: false`.
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
- **Pattern learning** — extracts reusable strategies from past orchestrations via `/orchestray:learn`, or automatically after each orchestration when `auto_learning.extract_on_complete.enabled: true` (opt-in, default off); patterns are project-local by default and can be shared across projects on the same machine via opt-in federation (`federation.shared_dir_enabled: true`)
- **Cross-project pattern federation** — `~/.orchestray/shared/patterns/` as machine-local hub; opt-in, sensitivity defaults to `"private"`; share via `/orchestray:learn share`, browse with `/orchestray:learn list --shared`
- **SQLite FTS5 retrieval** — BM25-ranked pattern lookup replaces Jaccard keyword scan; lazy index build; graceful fallback to Jaccard when native build unavailable (`better-sqlite3 ^11`, Node 22.5+ prefers `node:sqlite`)
- **AI pattern curator** — `/orchestray:learn curate` runs promote/merge/deprecate with tombstone rollback; undo via `undo-last` or `undo <action-id>`; sacred invariants: `user-correction` patterns never auto-deprecated, `sensitivity: private` patterns never auto-promoted; every action records a `rationale` field for audit; `/orchestray:learn explain <action-id>` shows the curator's reasoning; `curate --diff` opt-in incremental mode pre-filters patterns on five signals (stamp-absent, body-hash drift, stale-stamp, rollback-touched, merge-lineage-dirty) — only the dirty subset reaches the curator agent
- **Pattern health score** — `/orchestray:patterns` dashboard shows a per-pattern health score (`decayed_confidence × usage_boost × freshness_factor × (1-skip_penalty)`) with tiers healthy ≥ 0.60 / stale 0.40–0.59 / needs-attention < 0.40; a `### Needs attention` section surfaces patterns worth curating
- **Federation tier badges** — `pattern_find` results carry `[local]` / `[shared]` / `[shared, own]` badges in delegation prompts and the `pattern://` resource banner; `promoted_from` and `promoted_is_own` fields make the trust tier auditable in every orchestration; `share --preview` shows the sanitized diff before committing a share
- **Retrieval match reasons** — `pattern_find` now returns per-term match reasons (`"fts5:term=audit (in context, approach)"`) instead of a flat `"fts5"` label; the keyword fallback path emits `"fallback: keyword"` explicitly
- **Degraded-mode journal** — silent fallbacks (FTS5 unavailable, flat config keys, curator reconcile flags, hook-merge no-ops, and more) are recorded to `.orchestray/state/degraded.jsonl` (1 MB × 3-gen rotation); `/orchestray:status` surfaces a one-liner when the journal is non-empty; run `/orchestray:doctor` for full diagnostics; run `/orchestray:doctor --deep` to verify all installed file hashes against the manifest
- **Intelligence bundle (v2.1.3)** — shadow scorer seam runs alternate retrieval ranking side-by-side with baseline (no live ranking change; telemetry in `.orchestray/state/scorer-shadow.jsonl`); MinHash+Jaccard duplicate pre-filter cuts curator attention from O(N²) to O(N+k); `recently_curated_*` frontmatter stamps close the audit loop between curator actions and touched patterns; manifest v2 with per-file SHA-256 hashes enables install-integrity verification via `/orchestray:doctor --deep`
- **Researcher + curate --diff bundle (v2.1.4)** — new Researcher agent surveys external approaches before Architect/Inventor is spawned, returning a decision-ready shortlist; merge tombstones now carry MinHash similarity parameters (`similarity_method`, `similarity_threshold`, `similarity_k`, `similarity_m`) for reproducible pre-filter replay; `curate --diff` opt-in incremental mode (enable with `curator.diff_enabled: true`) cuts curator cost on stable pattern libraries; self-healing forced-full sweep every 10th run
- **Compaction resilience (v2.1.7, on by default)** — when Claude Code compacts context mid-orchestration, Orchestray now writes a dossier of active orchestration state to disk before compaction and re-injects a summary on your next message, so the PM resumes without losing task context. Disable with `resilience.enabled: false` or `ORCHESTRAY_RESILIENCE_DISABLED=1`. Running `/clear` is recognized as a deliberate reset and does not trigger re-injection. A `/orchestray:doctor` probe (P9) checks the resilience surface is healthy.
- **Kill-switch reliability + project-intent injection + rollup observability (v2.1.12)** — the v2.1.11 kill-switch env vars now mechanically inject the backing file via hook (guaranteed rollback regardless of PM dispatch behaviour); a new `project-intent.md` block is generated once and injected into delegation prompts so downstream agents know your project's goal without re-reading README; post-orchestration rollup gains three new lines (Tier-2 dispatch counts, model auto-resolve breakdown, field-projection usage); MCP field projection now covers `routing_lookup` and `metrics_query` (four tools total). See CHANGELOG for details.
- **Context reduction + ox helper + DX hardening (v2.1.11)** — seven bundles. The PM's always-loaded prompt bundle shrinks by ~162 KB: `event-schemas.md` is now Tier-2 (loaded on demand), `tier1-orchestration.md` splits into common-path and rare-path halves, and `delegation-templates.md` splits into lean-core and detailed extension. The new `ox` CLI helper (installed to PATH on `npx orchestray --global`) replaces verbose bash in PM workflows with six named verbs (`state init/complete/pause/peek`, `routing add`, `events append`). `pattern_find` and `kb_search` now accept a `fields` parameter for up to 80% response-size reduction. The "Agent() missing model" first-spawn block is eliminated by auto-resolve. Agents that must produce written artifacts can no longer silently skip them (T15 validator + per-agent override clause). The event-schema validator now hard-blocks unknown event types. PATH prepend fixed in the installer. See CHANGELOG for details.
- **Native resilience envelope + PreCompact durability + 1-hour prompt cache + compression telemetry + worktree isolation (v2.1.10)** — five bundles. Post-compaction state recovery now uses Claude Code's native `additionalContext` envelope instead of a prompt fence (15–30% token reduction on recovery turns; rollback: `ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1`). PreCompact blocks compaction if state serialization fails during an active orchestration (`ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1` for warn-only). `ENABLE_PROMPT_CACHING_1H=1` is now default-on for ~77% input-token saving on the cacheable prefix of a typical long orchestration (rollback: `FORCE_PROMPT_CACHING_5M=1`). CiteCache / SpecSketch / RepoMapDelta now emit `cite_cache_hit`, `spec_sketch_generated`, `repo_map_delta_injected` events proving the v2.1.8 compression paths fired. Write-capable agents carry `isolation: worktree` in frontmatter; `isolation_omitted_warn` events surface when custom specialists skip it. See CHANGELOG for details.
- **Agent quality gates + five shipped specialists + auto-learning wiring + hardening (v2.1.9)** — every agent now validates a common Structured Result schema (`status`, `summary`, `files_changed`, `files_read`, `issues`, `assumptions`) before it can stop — architect, developer, reviewer, and release-manager are hard-blocked; other agents warn. Three new specialists (database-migration, api-contract-designer, error-message-writer) join the previously shipped Translator and UI/UX Designer; all five are installed into `~/.claude/agents/` and callable by name. Auto-learning now triggers on orchestration completion (not only on context compaction); the Haiku extraction backend accepts fenced JSON output and uses a 180 s timeout. A curator log storm (hundreds of `curator_cursor_reset` events per session), a pattern-seen-set crash on oversized files, and an agent-registry stale-race (90% of prior log noise) are all fixed. See CHANGELOG for details.
- **First-spawn UX fix + Opus 4.7 cost calibration + xhigh adoption + shipped specialists + context compression (v2.1.8)** — four shipped bundles. (a) The first `Agent()` spawn of every session during an orchestration no longer fails for a missing `model` parameter — a pre-spawn reminder preempts the failure and the gate now tells you the exact model to re-spawn with if one still slips through. (b) `/orchestray:status` cost estimates for Opus-routed agents were running ~35% low because Opus 4.7 uses a new tokenizer that consumes more tokens for the same text; we recalibrated the cost model so new orchestrations show accurate numbers (historical rollups stay at the old value). (c) Architect and Inventor agents now default to Claude Code's new `xhigh` effort level (introduced in Claude Code 2.1.111) — Anthropic's recommended default for Opus 4.7. On older Claude Code, `xhigh` silently runs as `high`, so nothing breaks. (d) Two specialist templates now ship with every Orchestray install: Translator and UI/UX Designer. Both activate automatically when the PM detects matching keywords; project-local specialists at `.orchestray/specialists/` override shipped ones. (e) Four context-compression mechanisms (CiteCache, SpecSketch, RepoMapDelta, ArchetypeCache advisory) reduce repeated input tokens across long orchestrations; gated by `context_compression_v218.enabled` (default on), each with individual on/off controls. See CHANGELOG for details.
- **Self-learning foundations (v2.1.6)** — Orchestray can stage pattern proposals automatically after each completed orchestration, instead of waiting for a manual `/orchestray:learn` run. All auto-learning features are off by default and gated behind a single kill switch (`auto_learning.global_kill_switch: true` in config, or `ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1` in environment). Enable extraction with `auto_learning.extract_on_complete.enabled: true`; proposals land in `.orchestray/proposed-patterns/` for your review — nothing applies without `/orchestray:learn accept <slug>`. Run `/orchestray:learn list --proposed` to see what is staged. The Haiku extraction backend that was stubbed in v2.1.6 is now live in v2.1.7.
- **Team features** — shared config, shared patterns, daily/weekly cost budgets
- **Agent Teams** — opt-in dual-mode execution for tasks needing inter-agent communication. Default off as of v2.1.16. Both `agent_teams.enabled: true` in `.orchestray/config.json` AND `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in env are required to spawn teams; see `agents/pm-reference/agent-teams-decision.md` for the three use-case conditions.
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

This installs agents, skills, and hooks into `~/.claude/`. No `--plugin-dir` flag needed — Claude Code discovers them automatically. The `ox` helper is also installed to your PATH — run `ox --help` to verify. If `ox` is not found after install, restart your shell (the PATH prepend takes effect on the next login).

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
| `/orchestray:feature` | Manage feature quarantine — show status, wake quarantined features, persist 30-day pins. See CHANGELOG R-GATE entry for details. |
| `/orchestray:federation status` | Show federation enabled/disabled/partial state, shared-dir contents, FTS5 status, and origin attribution |
| `/orchestray:doctor` | Run 8 health probes (migrations, MCP tools, config keys, FTS5, ABI, degraded journal); emits `doctor-result-code: 0/1/2`; add `--deep` for full install-integrity manifest verification |
| `/orchestray:learn [id]` | Extract patterns, capture corrections, manage federation sharing (`share` / `unshare` / `list --shared`), curate with AI (`curate` / `curate --diff` / `undo-last` / `undo <id>`); `explain <action-id>` shows curator rationale; `share --preview` diffs without writing; review auto-extracted proposals with `list --proposed` / `accept <slug>` / `reject <slug>` |
| `/orchestray:learn-doc <url>` | Distill a URL into a reusable skill pack auto-loaded by future agents. Source-aware expiry: Claude Code docs 14d, Anthropic Platform 30d, other 90d. |
| `/orchestray:distill <url>` | Alias for `/orchestray:learn-doc` — same command, shorter name. |
| `/orchestray:resume` | Resume interrupted orchestration |
| `/orchestray:analytics` | Performance stats + pattern dashboard |
| `/orchestray:patterns` | Pattern effectiveness dashboard |
| `/orchestray:review-pr [#/url]` | Review a GitHub pull request |
| `/orchestray:kb` | View and manage the knowledge base |
| `/orchestray:update` | Update Orchestray to the latest version |

### Feature demand and quarantine (v2.1.15+)

Starting in v2.1.15, auto-quarantine is active by default. Orchestray automatically skips feature protocols that haven't been used on your repo in the past 14 days and shows a session-start banner naming any quarantined features. If you set `feature_demand_gate.shadow_mode: true` in v2.1.14, that setting was overridden on your first session under v2.1.15 (you will have seen a one-time banner). To opt out, set `feature_demand_gate.shadow_mode: true` in `.orchestray/config.json` again.

Use `/orchestray:feature status` to see demand counts, and `/orchestray:feature wake <name>` to re-enable a quarantined protocol instantly for the current session (or `/orchestray:feature wake --persist <name>` for a 30-day pin). Note: setting `shadow_mode: true` in config alone does not re-enable any already-quarantined protocol; use `/orchestray:feature wake --persist <name>` for each one.

## Agent roles

| Agent | Role |
|-------|------|
| **PM** | Orchestrator — decomposes tasks, assigns work, monitors progress, routes models |
| **Architect** | Design-only — produces design documents and technical decisions |
| **Developer** | Implements code changes |
| **Refactorer** | Systematic code transformation without behavior change |
| **Reviewer** | Read-only review across 7 dimensions: correctness, quality, security, performance, docs, operability, API compatibility. As of v2.1.16, the PM scopes reviewer dimensions to the changed-file shape (correctness and security always run); see `agents/pm-reference/agent-teams-decision.md`-sibling `agents/reviewer-dimensions/` for the 5 conditional fragments. |
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
| **Project Intent** | Lightweight Haiku agent — reads `README.md`, `CLAUDE.md`, and `AGENTS.md` once per session and stages a project-intent block that every downstream agent receives for free. Read-only; invoked automatically by the PM on fresh repos. |
| **Haiku Scout (v2.2.0+)** | Read-only Haiku agent — handles Read/Glob/Grep operations at and above the 12 KB threshold so the PM keeps Opus for orchestration decisions. Tools restricted to `[Read, Glob, Grep]`; three-layer tool-whitelist enforcement (declarative frontmatter, runtime rejection, frozen-byte CI test). Disable with `haiku_routing.enabled: false`. |
| **Orchestray Housekeeper (v2.2.0+)** | Read-only Haiku agent — handles three narrow background ops: knowledge-base write verification, schema-shadow regen, and telemetry rollup recompute. Tools restricted to `[Read, Glob]` (stricter than scout). Per-action audit telemetry, drift detector fails closed on tool-whitelist mutation, three independent kill switches (`haiku_routing.housekeeper_enabled: false`, `ORCHESTRAY_HOUSEKEEPER_DISABLED=1`, runtime sentinel). Promotion to broader tools requires explicit tagged commit cycle. (v2.2.1: drift detector now resolves the agent through project → user → plugin priority order, fixing a v2.2.0 false-positive that quarantined global-scope installs.) |
| **Specialists** | Plugin-shipped templates at `specialists/` (translator, ui-ux-designer, database-migration, api-contract-designer, error-message-writer); project-local overrides saved to `.orchestray/specialists/` by the PM when dynamic agents succeed |

### Shipped specialists (v2.1.9)

Five specialist templates ship with every Orchestray install and are callable
via `Agent(subagent_type=…)` or triggered automatically by the PM on matching
keywords. The installer symlinks them into `~/.claude/agents/` (copies on Windows).

- **translator** — makes apps multi-lingual: detects your i18n framework
  (i18next, FormatJS, Lingui, gettext, Flutter intl, iOS, Android, and more),
  extracts untranslated strings, produces locale-correct translations with ICU
  MessageFormat awareness. Default model: sonnet. Project-local override:
  `.orchestray/specialists/translator.md`.

- **ui-ux-designer** — premium UI generation anchored to shadcn/ui + Radix +
  Tailwind v4, W3C DTCG design tokens, and WCAG 2.2 AA accessibility. Works
  from design tokens, screenshots (Claude vision), or plain text descriptions.
  Default model: sonnet. Project-local override:
  `.orchestray/specialists/ui-ux-designer.md`.

- **database-migration** — plans zero-downtime schema migrations. Detects the
  migration framework (Prisma, Knex, Flyway, Liquibase, Alembic, Rails,
  TypeORM, sqlx, goose), emits staged migrations (nullable add → backfill →
  constraint add), monitoring checkpoints, and rollback triggers. Default
  model: opus/high. Routes on "migration", "schema change", "backfill",
  "ALTER TABLE", "zero-downtime", "NOT NULL", "ADD COLUMN", "DROP COLUMN"
  when a framework signal is also detectable.

- **api-contract-designer** — designs REST / GraphQL / gRPC contracts with
  versioning discipline: OpenAPI 3.1 or AsyncAPI 3 authoring, JSON Schema
  evolution, deprecation path design, backward-compat impact analysis.
  Default model: sonnet/high. Routes on "API contract", "OpenAPI",
  "REST endpoint", "GraphQL schema", "gRPC", "versioning", "breaking change",
  "deprecate", "backward-compat".

- **error-message-writer** — polishes user-facing error messages, CLI output,
  and validation feedback for clarity, tone, actionability, and progressive
  disclosure. Preserves error codes, i18n keys, and programmatic contracts.
  Default model: sonnet/medium. Routes on "error message", "error UX",
  "CLI help", "validation feedback", "form errors", "user-facing copy",
  "error tone".

Run `npm run lint:specialists` to validate frontmatter on any specialist you author.

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

ox_telemetry_enabled                         Enable ox.jsonl telemetry log. Default false. Opt-in only.

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
curator.diff_forced_full_every       Forced-full-sweep cadence for --diff: every Nth run evaluates the
                                     entire corpus regardless of dirty-set signals (integer 1..1000,
                                     default: 10)

auto_learning.global_kill_switch             Disable the entire auto-learning bundle immediately (default: false);
                                             also controlled by the ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1 env var
auto_learning.extract_on_complete.enabled    Auto-stage pattern proposals after each orchestration (default: false — opt-in)
auto_learning.extract_on_complete.shadow_mode  Count proposals and emit events but write no files (default: false)
auto_learning.extract_on_complete.proposals_per_orchestration  Cap per orchestration (default: 3, range: 1–10)
auto_learning.extract_on_complete.proposals_per_24h            Rolling 24-hour cap across all orchestrations (default: 10, range: 1–50)
auto_learning.roi_aggregator.enabled         Daily read-only ROI scan and calibration suggestions (default: false — opt-in)
auto_learning.roi_aggregator.min_days_between_runs  Minimum days between ROI scans (default: 1, range: 1–90)
auto_learning.roi_aggregator.lookback_days   Events window for ROI computation (default: 30, range: 1–365)
auto_learning.kb_refs_sweep.enabled          Weekly dry-run broken-reference scan of KB and patterns (default: false — opt-in)
auto_learning.kb_refs_sweep.min_days_between_runs  Minimum days between sweeps (default: 7, range: 1–90)
auto_learning.safety.circuit_breaker.max_extractions_per_24h    Rolling cap on extraction attempts (default: 10, range: 1–100)
auto_learning.safety.circuit_breaker.cooldown_minutes_on_trip   Minutes before a tripped breaker can be reset (default: 60, range: 5–1440)

resilience.enabled              Write a dossier before context compaction and re-inject on the next message (default: true)
resilience.shadow_mode          When true, dossier is written but never injected — observe events without affecting the session (default: false)
resilience.inject_max_bytes     Maximum bytes injected into context per compaction event (default: 12288, range: 512–32768)
resilience.max_inject_turns     Maximum injections per compaction before suppression (default: 3)
resilience.kill_switch          Disable resilience instantly without changing enabled (default: false)

retrieval.scorer_variant        Which ranking scorer pattern_find uses: "baseline" (default, unchanged),
                                "skip-down" (patterns you skip rank lower), "local-success" (patterns that
                                worked in your project rank higher), or "composite" (both combined).
                                Default flip from baseline is planned for v2.2.0 once cross-install shadow
                                data crosses threshold.
retrieval.synonyms_enabled      Expand pattern_find queries with a ~44-entry synonym list (default: true).
                                Every expansion is auditable via the response's match_reasons field; set
                                false to disable.
enable_drift_sentinel           Detect architectural drift via auto-extracted invariants and static
                                rules; pre/post-execution checks surface violations (default: false
                                for new installs as of v2.1.14 — off by default because it seldom
                                produces actionable output on typical workloads). To restore prior
                                behavior, set `"enable_drift_sentinel": true` in
                                `.orchestray/config.json`.

auto_document                   Automatically spawn a documenter agent after orchestration when a
                                feature addition is detected (default: false as of v2.1.16 — was
                                true through v2.1.15). The reviewer's documentation pass already
                                audits docs drift on every orchestration, making the auto-spawn
                                redundant insurance on typical workloads. To restore the v2.1.15
                                behavior, set `"auto_document": true` in
                                `.orchestray/config.json`.

config_drift_silence            Top-level config keys to silence from the boot-time drift warning
                                (default: []). Use for intentional custom keys (e.g., a third-party
                                integration seed). Example: ["my_custom_key"].

feature_demand_gate.shadow_mode      Set true to disable automatic feature quarantine and restore
                                     v2.1.14 observe-only behavior (default: false as of v2.1.15;
                                     if you set this to true in v2.1.14, it was overridden on upgrade
                                     — set it again to opt out)

delta_handoff.enabled                Send only changed sections in agent handoffs instead of full
                                     artifacts (default: true); set false to restore full-payload mode

delta_handoff.force_full             Force a full handoff payload for this session regardless of
                                     delta eligibility (default: false); rollback switch only

phase_slice_loading.enabled          Load only the orchestration-phase-relevant slice of the main
                                     reference file instead of the full file (default: true);
                                     set false to restore full-file loading

curator_slice_loading.enabled        Load only the active curator stage slice (default: true);
                                     set false to restore full curator context loading

budget_enforcement.enabled           Enable per-role context-size budget checks before each agent
                                     spawn (default: true); set false to disable entirely

budget_enforcement.hard_block        When true, block spawns that exceed their role budget;
                                     when false, warn only (default: false)

role_budgets.<role>.budget_tokens    Token budget for a named agent role
                                     (e.g. role_budgets.developer.budget_tokens);
                                     all roles seeded with conservative defaults on install

catalog_mode_default                 Pattern catalog mode is on by default for the busiest 5 agents
                                     (pm, architect, developer, reviewer, debugger). Agents request a
                                     compact catalog and escalate to `pattern_read(slug)` only when the
                                     headline matches the task (default: true as of v2.1.16). Reviewer
                                     keeps full-body access when auditing pattern accuracy itself.

review_dimension_scoping.enabled     Allow the PM to scope reviewer dimensions per spawn (default: true
                                     as of v2.1.16). Correctness and Security always load. Default
                                     `review_dimensions: "all"` for unspecified spawns; the PM
                                     classifies based on changed-file paths via
                                     `bin/_lib/classify-review-dimensions.js`.

agent_teams.enabled                  Enable Agent Teams (default: false as of v2.1.16; legacy key
                                     `enable_agent_teams` is honored for one release). Spawning a team
                                     also requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in env or
                                     `settings.json`. Read `agents/pm-reference/agent-teams-decision.md`
                                     for the three use-case conditions before enabling.

phase_slice_loading.telemetry_enabled  Emit `phase_slice_injected` events on every successful slice
                                       inject so `/orchestray:analytics` can show the positive-path
                                       slice-load ratio (default: true as of v2.1.16). Read-only
                                       telemetry; no behavior change.

repo_map.enabled            Enable the Aider-style repo map for code-touching agent spawns
                            (default: true as of v2.1.17). When true, PM Section 3 step 9.6
                            invokes the repo-map CLI on developer/reviewer/refactorer/debugger
                            spawns and routes the rendered map into the delegation prompt.
repo_map.languages          Languages to parse with bundled tree-sitter grammars
                            (default: ["js", "ts", "py", "go", "rs", "sh"]).
repo_map.cache_dir          On-disk cache location, keyed on git blob SHA + grammar manifest
                            (default: ".orchestray/state/repo-map-cache"; gitignored).
repo_map.cold_init_async    On first run after install, build the cache asynchronously so the
                            first orchestration is not blocked on parse (default: true).

# v2.2.0 keys

output_shape.enabled                    Smart output shaping for prose-heavy agents (caveman
                                        addendum + per-role length caps + Anthropic Structured
                                        Outputs on report-mode roles). Default: true. Disable
                                        to restore unconstrained agent prose. Env override:
                                        ORCHESTRAY_DISABLE_OUTPUT_SHAPE=1 (added in v2.2.2).

event_schemas.full_load_disabled        Block the legacy full-file Read of `event-schemas.md`;
                                        the chunked path via `mcp__orchestray__schema_get`
                                        becomes the only path. Default: true. Set false to
                                        restore the legacy Read path (not recommended).

pm_protocol.tier2_index.enabled         Enable the pre-materialized Tier-2 schema index
                                        (~3,200-token fingerprint plus chunk-on-demand verb).
                                        Default: true.

pm_protocol.delegation_delta.enabled    Send first agent spawn full delegation prompt; send
                                        subsequent spawns a prefix reference + delta block
                                        with hash-anchored re-emission on cache mismatch.
                                        Default: true. Env override:
                                        ORCHESTRAY_DISABLE_DELEGATION_DELTA=1.

caching.block_z.enabled                 Anchor the prompt prefix in a byte-stable Block-Z
                                        header so 1-hour TTL writes land where they pay back.
                                        Default: true.

caching.engineered_breakpoints.enabled  Use the deterministic 4-slot cache-control manifest
                                        with TTL auto-downgrade for short orchestrations.
                                        Default: true.

haiku_routing.enabled                   Enable the read-only Haiku scout for Class-B file
                                        operations at and above 12 KB. Default: true.

haiku_routing.scout_min_bytes           File-size threshold above which the PM hands Read/
                                        Glob/Grep operations to the scout instead of doing
                                        them inline. Default: 12288 (12 KB). Per OQ-1 verdict.

haiku_routing.housekeeper_enabled       Enable the background-housekeeper Haiku agent for
                                        narrow background ops (KB-write verify, schema-shadow
                                        regen, telemetry rollup recompute). Default: true.
                                        Env override: ORCHESTRAY_HOUSEKEEPER_DISABLED=1.

audit.round_archive.enabled             Distill completed rounds of multi-round audit
                                        orchestrations into compact 500-token digests in the
                                        active prompt; verbatim findings stay in the audit
                                        log. Default: true.
```

### Emergency kill switches (v2.1.15)

All v2.1.15 features have kill switches. To roll back any feature immediately, set the corresponding config key in `.orchestray/config.json`:

| Feature | Kill switch | Effect |
|---|---|---|
| Auto-quarantine | `feature_demand_gate.shadow_mode: true` | Restores observe-only mode |
| Delta handoff | `delta_handoff.enabled: false` | Full artifact payload restored |
| Phase slice loading | `phase_slice_loading.enabled: false` | Full reference file loaded |
| Curator slice loading | `curator_slice_loading.enabled: false` | Full curator context loaded |
| Spawn budget gate | `budget_enforcement.enabled: false` | All budget checks disabled |
| Catalog default (v2.1.16) | `catalog_mode_default: false` | Restores full-body pattern fetches |
| Reviewer scoping (v2.1.16) | `review_dimension_scoping.enabled: false` | All 7 dimensions on every review |
| Agent Teams (v2.1.16) | `agent_teams.enabled: false` (default) | Teams cannot spawn |
| Aider repo map (v2.1.17) | `repo_map.enabled: false` | Code-touching spawns receive no symbol map |

### Emergency kill switches (v2.2.0)

All nine v2.2.0 shipping items default on. Each has a dedicated kill switch; where applicable, an environment-variable override is provided for in-session opt-out without touching `config.json`.

| Feature | Kill switch | Env override | Effect |
|---|---|---|---|
| Smart output shaping | `output_shape.enabled: false` | `ORCHESTRAY_DISABLE_OUTPUT_SHAPE=1` | Prose-heavy agents revert to unconstrained output |
| Chunked schema lookup | `event_schemas.full_load_disabled: false` | — | Restores legacy full-file Read of event-schemas.md |
| Pre-materialized Tier-2 index | `pm_protocol.tier2_index.enabled: false` | — | Falls back to per-turn Read of the schema reference |
| Engineered Block-Z prefix | `caching.block_z.enabled: false` | — | Prompt prefix reverts to non-anchored composition |
| 4-slot cache-control manifest | `caching.engineered_breakpoints.enabled: false` | — | Cache-control falls back to inherited defaults |
| Haiku scout | `haiku_routing.enabled: false` | — | All Class-B file ops run inline at PM model rate |
| Background housekeeper | `haiku_routing.housekeeper_enabled: false` | `ORCHESTRAY_HOUSEKEEPER_DISABLED=1` | Three background ops run inline |
| Audit-round auto-archive | `audit.round_archive.enabled: false` | — | Multi-round audits keep verbatim findings in the active prompt |
| Delta delegation | `pm_protocol.delegation_delta.enabled: false` | `ORCHESTRAY_DISABLE_DELEGATION_DELTA=1` | All agent spawns receive the full delegation prompt |

No session restart is needed for any of these kill switches.

**Per-pattern sharing (2.1.13+).** A pattern with `sharing: local-only` in its frontmatter stays on this machine regardless of project-level federation settings. Honored on both the read path (pattern search excludes local-only patterns from cross-install views) and the write path (shared-tier promotion refuses local-only patterns). Forward-compatible with future federation sync. To pin a pattern today, edit its frontmatter directly: open `.orchestray/patterns/<slug>.md` and add `sharing: local-only` under the existing fields; `/orchestray:federation status` shows the total count of pinned patterns.

The `mcp_enforcement` block is automatically added to `.orchestray/config.json` on the first `UserPromptSubmit` after upgrading to 2.0.13+ — no manual migration needed. On 2.0.14+, the same sweep also backfills the `mcp_server.cost_budget_check.pricing_table` block if absent. On 2.0.15+, the sweep additionally seeds the `kb_write` tool enable entry and the `pattern_record_skip_reason` / `cost_budget_check` enforcement keys for existing installs. On 2.0.16+, the sweep seeds `routing_lookup`, `cost_budget_reserve`, `pattern_deprecate`, `max_per_task` defaults (20 each), `cost_budget_enforcement`, `cost_budget_reserve.ttl_minutes`, and `routing_gate.auto_seed_on_miss`. On 2.0.17+, the sweep seeds the `v2017_experiments` block (all flags `"off"`), `adaptive_verbosity`, and `cache_choreography`. On 2.0.18+, the sweep also auto-strips the now-removed `pm_prompt_variant` and `pm_prose_strip` keys (emits a `config_key_stripped` audit event).

**MCP resource schemes (2.0.16+).** The MCP server exposes four read-only resource schemes: `kb://`, `history://`, `pattern://`, and `orchestration://`. The `orchestration://` scheme provides live and historical state — `orchestray:orchestration://current` returns the active orchestration phase and task list; sub-resources expose routing decisions (`/current/routing`) and checkpoint state (`/current/checkpoints`). To browse an archived orchestration, use `orchestray:orchestration://<orch-id>`; the `list()` inventory includes the 5 most recent archived IDs. MCP tool count is 15 as of 2.1.0 (`curator_tombstone` added; 14 tools as of 2.0.17).

**Routing-gate match key (2.0.15+).** The routing gate matches spawns on `(task_id, agent_type)` rather than the previous three-field tuple — forgiving to description drift. If you observe gate blocks on valid `Agent()` spawns, confirm that `routing.jsonl` is written before the spawn call; the PM's orchestration prompt now enforces this as a mandatory step.

### Health Signals

`/orchestray:analytics` includes a **Health Signals** section that:
- Warns when `mcp_enforcement.global_kill_switch` is `true` in `.orchestray/config.json` (the gate is bypassed; all MCP checkpoint enforcement is off)
- Scans recent `events.jsonl` for unpaired `kill_switch_activated` events to surface an active kill-switch window that was never closed
- Reports `prefix_drift` events from `bin/cache-prefix-lock.js` when Block A of `agents/pm.md` changed between sessions (2.0.17+, when `v2017_experiments.prompt_caching` is `"on"`)
- Shows the phase-slice load ratio (`phase_slice_injected` vs `phase_slice_fallback`) so the v2.1.15 ~21K-tokens-per-turn savings claim is verifiable per install (2.1.16+)
- Documenter spawn frequency over the last 14 days, validating the v2.1.16 `auto_document: false` default (2.1.17+)
- Archetype cache hit-rate (`archetype_cache_hit` vs `archetype_cache_miss`); the miss event is new in v2.1.17, making the hit-rate denominator measurable for the first time and gating the v2.1.18 R-SEMANTIC-CACHE deferral trigger
- Reviewer dimension adoption — share of reviewer spawns whose delegation included a `## Dimensions to Apply` block; ≥60% over 14 days triggers the v2.1.18 scoped-by-default flip (2.1.17+)

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
    resilience-dossier.json # Active orchestration snapshot for compaction resilience (2.1.7+)
    compact-signal.lock     # Transient lock written on compaction, consumed on next prompt (2.1.7+)
    role-budgets.json       # Live per-role context-size budgets read by bin/preflight-spawn-budget.js
                            # (2.1.16+; falls back to static defaults when absent)
    repo-map-cache/         # Aider-style repo-map cache, keyed on git blob SHA + grammar manifest
                            # (2.1.17+; auto-cleaned; disable with `repo_map.enabled: false`)
  kb/             # Shared knowledge base
    facts/
      project-intent.md   # Cached project intent block (domain, primary user problem, architectural
                          # constraint, tech stack, entry points); generated by Step 2.7a, injected
                          # into delegation prompts when low_confidence is false (2.1.12+)
  audit/          # Event logs and metrics
  history/        # Archived orchestrations
  metrics/        # Per-spawn and per-PM-turn JSONL metrics (gitignored, 2.0.17+)
    agent_metrics.jsonl           # Per-spawn rows + pm_turn rows
    orchestration_rollup.jsonl    # Per-orchestration rollup
    archive/                      # Rotated files (50 MB threshold)
  specialists/    # Project-local specialist overrides (gitignored). Shipped templates live at <plugin-root>/specialists/
  patterns/       # Extracted learning patterns (gitignored)
  proposed-patterns/  # Auto-extracted proposals awaiting review (gitignored; v2.1.6+)
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

### Scout or housekeeper disabled but Class-B file ops still occur (v2.2.0+)

If you have set `haiku_routing.enabled: false` (or `haiku_routing.housekeeper_enabled: false`) but `/orchestray:analytics` still shows Class-B Read/Glob/Grep operations running at the PM's model rate, this is **expected**: the kill switch tells the PM to do the I/O inline rather than delegating it to Haiku. The "forgone savings" line in `/orchestray:analytics` reports how much you would have saved if the scout had been on for those operations — useful as a one-glance signal of whether to flip the kill switch back.

To re-enable scout routing without restarting the session, set `haiku_routing.enabled: true` in `.orchestray/config.json`; the next Class-B op picks up the new setting.

### `mcp__orchestray__schema_get` returns `{found: false, error: 'stale_index'}` (v2.2.0+)

The chunked schema lookup keys on a SHA-256 of `agents/pm-reference/event-schemas.md`. If you edit the file directly without running the regen hook, the sidecar index lags one regen behind and returns `stale_index` until the hook fires.

Fix: run `node bin/regen-schema-shadow.js` followed by `node -e "require('./bin/_lib/tier2-index').buildIndex({cwd: process.cwd()})"`. The PostToolUse(Edit) hook normally does this automatically; manual regen is the recovery path when the hook was bypassed.

### Gate blocks first spawn after upgrade

If `gate-agent-spawn.js` blocks the PM's first `Agent()` call after upgrading to 2.0.13+, the most likely cause is that the automatic checkpoint-ledger migration has not yet run (it fires on the next `UserPromptSubmit`, not at install time). Try the following in order:

1. **Wait for the sweep.** On the next user prompt the `bin/post-upgrade-sweep.js` hook will run and repair any stale phase rows in `.orchestray/state/mcp-checkpoint.jsonl`. If the gate then passes, you're done.
2. **Nuclear option — kill switch.** Set `mcp_enforcement.global_kill_switch: true` (and a non-empty `kill_switch_reason`) in `.orchestray/config.json` to bypass the checkpoint gate entirely and complete the in-flight orchestration. Clear both fields once you're done. No session restart is required.
3. **Manual sentinel reset.** If the sweep appears stuck, delete `.orchestray/state/.mcp-checkpoint-migrated-2013` to force it to re-run on the next prompt.

Reference: `bin/post-upgrade-sweep.js` is the automatic recovery path. `mcp_enforcement.global_kill_switch` is the always-available manual escape hatch.

## License

MIT
