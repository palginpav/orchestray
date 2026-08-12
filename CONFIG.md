# Orchestray Configuration Reference

Orchestray settings resolve in priority order (highest first):

1. **Natural language in the user prompt** — explicit overrides like "just do it" or "full orchestration"
2. **`.orchestray/config.json`** — per-project user config (edit with `/orchestray:config`)
3. **`.orchestray/team-config.json`** — team-wide baseline, lower priority than individual config
4. **Compiled defaults** — the `DEFAULT_*` objects in `bin/_lib/config-schema.js`

To view or edit live settings, run `/orchestray:config`. The canonical source for every key and its default is `bin/_lib/config-schema.js`. When this document and the schema disagree, **the schema wins**.

All sections are fail-open: a missing or malformed config file causes each loader to return its defaults rather than crashing.

---

## Table of contents

- [1. Orchestration core](#1-orchestration-core)
- [2. Model routing and effort](#2-model-routing-and-effort)
- [3. Cost budget](#3-cost-budget)
- [4. Context economy](#4-context-economy)
- [5. Prompt loading](#5-prompt-loading)
- [6. Plugin loader](#6-plugin-loader)
- [7. Reviewer and gates](#7-reviewer-and-gates)
- [8. Learning and patterns](#8-learning-and-patterns)
- [9. Resilience and telemetry](#9-resilience-and-telemetry)
- [10. Install and worktree](#10-install-and-worktree)
- [11. Oversized-Input Mode](#11-oversized-input-mode)
- [Kill switches](#kill-switches)

---

## 1. Orchestration core

Set at the top level of `.orchestray/config.json` unless noted.

| Key | Default | What it does |
|-----|---------|--------------|
| `complexity_threshold` | `4` | Score at which a task triggers multi-agent orchestration. Set to `99` to disable auto-trigger in practice (scores top out around 12). |
| `force_orchestrate` | `false` | Always route to multi-agent mode regardless of complexity score. |
| `force_solo` | `false` | Always route to single-agent (PM only) regardless of complexity score. |
| `confirm_before_execute` | `false` | Pause and ask the user to confirm the orchestration plan before spawning agents. |
| `enable_outcome_tracking` | `false` | Track probe outcomes (files changed, tests pass) after each orchestration and feed results back into pattern confidence. |
| `max_cost_usd` | `null` | Per-orchestration spend ceiling in USD. `null` disables the check. When set, orchestration stops if the projected cost exceeds this value. Caps are read-only until `cost_budget_enforcement.enabled: true` (see §3b). |
| `dossier_orphan_threshold` | `5` | Number of dossier-orphan events within one orchestration before an alert is emitted. Top-level scalar (not nested). |
| `routing_gate.auto_seed_on_miss` | `true` | When no routing entry exists for an `Agent()` spawn, auto-seed a synthetic entry instead of hard-blocking. Set `false` to restore hard-fail behaviour. |
| `state_sentinel.pause_check_enabled` | `true` | Kill flag for the pause/cancel sentinel check. Set `false` to bypass the check entirely (emergency bypass). |
| `state_sentinel.cancel_grace_seconds` | `5` | Seconds after `cancel.sentinel` is written before new Agent() spawns are blocked. Range: 0–3600. |
| `redo_flow.max_cascade_depth` | `10` | Maximum transitive dependent depth in a `--cascade` redo closure. Range: 1–1000. |
| `redo_flow.commit_prefix` | `"redo"` | Prefix used in redo commit messages: `<prefix>(<W-id>): …`. |

---

## 2. Model routing and effort

| Key | Default | What it does |
|-----|---------|--------------|
| `haiku_routing.enabled` | `true` | Enable automatic Haiku-scout delegation for large read-only operations. |
| `haiku_routing.scout_min_bytes` | `12288` | Minimum file size (bytes) that triggers a Haiku scout instead of inline read. |
| `haiku_routing.scout_blocked_ops` | `["Edit","Write","Bash"]` | Operation types that are never delegated to a Haiku scout. |
| `haiku_routing.scout_blocked_paths` | `[]` | Glob patterns for file paths that are never routed to a Haiku scout. |
| `role_budgets` | `{}` | Map of role name → budget object (see pm.md §role_budgets for shape). Used by `preflight-spawn-budget.js` to enforce per-role spawn budgets. |
| `adaptive_verbosity.enabled` | `false` | Enable response-length budgets injected into delegation prompts. Also requires `v2017_experiments.adaptive_verbosity: "on"`. |
| `adaptive_verbosity.base_response_tokens` | `2000` | Default delegation response budget in approximate tokens. |
| `adaptive_verbosity.reducer_on_late_phase` | `0.4` | Multiplier applied to `base_response_tokens` for phases past the midpoint (phase_position ≥ 0.5). Range: 0.0–1.0. |
| `v2017_experiments.prompt_caching` | `"on"` | Enable v2.0.17 prompt-caching layout (`"off"` or `"on"`). Active and production-default; the `v2017` prefix is frozen for backward compatibility, not a sign of deprecation. |
| `v2017_experiments.adaptive_verbosity` | `"off"` | Enable v2.0.17 adaptive-verbosity response budgets (`"off"` or `"on"`). The `v2017` prefix is frozen for backward compatibility, not a sign of deprecation. |
| `v2017_experiments.global_kill_switch` | `false` | One-flip disables all v2.0.17 experiments simultaneously. |

---

## 3. Cost budget

Nested under `mcp_server` in `.orchestray/config.json` (e.g., `mcp_server.cost_budget_check.pricing_table`).

### 3a. Pricing table (`mcp_server.cost_budget_check.*`)

| Key | Default | What it does |
|-----|---------|--------------|
| `mcp_server.cost_budget_check.pricing_table.haiku.input_per_1m` | `1.00` | Input token price in USD per 1M tokens for Haiku tier. |
| `mcp_server.cost_budget_check.pricing_table.haiku.output_per_1m` | `5.00` | Output token price for Haiku. |
| `mcp_server.cost_budget_check.pricing_table.sonnet.input_per_1m` | `3.00` | Input token price for Sonnet. |
| `mcp_server.cost_budget_check.pricing_table.sonnet.output_per_1m` | `15.00` | Output token price for Sonnet. |
| `mcp_server.cost_budget_check.pricing_table.opus.input_per_1m` | `5.00` | Input token price for Opus. |
| `mcp_server.cost_budget_check.pricing_table.opus.output_per_1m` | `25.00` | Output token price for Opus. |
| `mcp_server.cost_budget_check.pricing_table.fable.input_per_1m` | `10.00` | Input token price for Fable. |
| `mcp_server.cost_budget_check.pricing_table.fable.output_per_1m` | `50.00` | Output token price for Fable. |
| `mcp_server.cost_budget_check.last_verified` | `"2026-04-11"` | ISO date when the pricing table was last verified against Anthropic's published rates. Update this when you update prices. |
| `mcp_server.cost_budget_check.effort_multipliers.low` | `0.7` | Cost multiplier for `effort: "low"` spawns. |
| `mcp_server.cost_budget_check.effort_multipliers.medium` | `1.0` | Cost multiplier for `effort: "medium"` spawns (baseline). |
| `mcp_server.cost_budget_check.effort_multipliers.high` | `1.4` | Cost multiplier for `effort: "high"` spawns. |
| `mcp_server.cost_budget_check.effort_multipliers.xhigh` | `1.6` | Cost multiplier for `effort: "xhigh"` spawns. |
| `mcp_server.cost_budget_check.effort_multipliers.max` | `1.8` | Cost multiplier for `effort: "max"` spawns. |

### 3b. Reservation and enforcement

**Important:** all cost caps (`daily_cost_limit_usd`, `weekly_cost_limit_usd`, `max_cost_usd`) are read-only log entries until `cost_budget_enforcement.enabled: true`. Without it, the budget gate is entirely skipped and no spawn is blocked.

| Key | Default | What it does |
|-----|---------|--------------|
| `mcp_server.cost_budget_reserve.ttl_minutes` | `30` | How long a cost reservation remains active before expiry. Range: 1–1440 minutes. |
| `cost_budget_enforcement.enabled` | `false` | Activate the pre-spawn cost gate. When `false`, the gate is entirely skipped and all cost caps have no effect. |
| `cost_budget_enforcement.hard_block` | `true` | When enforcement is enabled: `true` exits with code 2 (blocks spawn); `false` emits a stderr warning and allows the spawn. |

### 3c. Per-task MCP call limits (`mcp_server.max_per_task.*`)

| Key | Default | What it does |
|-----|---------|--------------|
| `mcp_server.max_per_task.ask_user` | `20` | Max `ask_user` MCP tool calls per task. Range: 1–1000. |
| `mcp_server.max_per_task.kb_write` | `20` | Max `kb_write` calls per task. Range: 1–1000. |
| `mcp_server.max_per_task.pattern_record_application` | `20` | Max `pattern_record_application` calls per task. Range: 1–1000. |

---

## 4. Context economy

| Key | Default | What it does |
|-----|---------|--------------|
| `delta_handoff.force_full` | `false` | Force full prompt delivery on every delegation (disable delta/incremental handoffs). Useful for debugging context issues. |
| `catalog_mode_default` | `true` | Top-level boolean. When `true`, `pattern_find` defaults to catalog mode (returns compact summaries). Set `false` to default to full mode. Env override: `ORCHESTRAY_DISABLE_CATALOG_DEFAULT=1`. |
| `caching.enabled` | `true` | Enable Block A prompt-zone caching (Zone 1). Set `false` to disable the caching layer entirely. |
| `caching.zone1_ttl_ms` | `3600000` | Time-to-live for Zone 1 cache entries in milliseconds (default: 1 hour). |
| `cache_choreography.pre_commit_guard_enabled` | `false` | Opt-in pre-commit hook that alerts on Block A changes missing an `BLOCK-A: approved` commit-message line. Run `bin/install-pre-commit-guard.sh` after enabling. |
| `cache_choreography.drift_warn_threshold_hex_changes` | `1` | Number of Block A hex-content changes before a drift warning fires. `0` disables warnings. |
| `block_a_zone_caching.enabled` | `true` | Enable the Block A zone-caching layer (compose-block-a.js and validate-cache-invariant.js). Kill switch: `ORCHESTRAY_DISABLE_BLOCK_A_ZONES=1`. |
| `block_a_zone_caching.invariant_violation_threshold_24h` | `5` | Number of `cache_invariant_broken` events in 24 hours before the auto-disable sentinel fires. |
| `shield.r14_dedup_reads.enabled` | `true` | Deny re-reads of the same (file_path, offset, limit) triple within a session when the file's mtime is unchanged. Set `false` to allow all re-reads. |
| `audit.max_events_bytes_for_scan` | `null` | Max bytes read from `events.jsonl` when scanning for routing_outcome events. `null` uses the env var `ORCHESTRAY_MAX_EVENTS_BYTES` or the built-in default. |

---

## 5. Prompt loading

| Key | Default | What it does |
|-----|---------|--------------|
| `phase_slice_loading.enabled` | `true` | Load phase-specific prompt slices into agent context at spawn time. Set `false` to disable (agents receive no phase-specific context). |
| `phase_slice_loading.telemetry_enabled` | `true` | Emit telemetry events for phase-slice load operations. |
| `curator_slice_loading.enabled` | `true` | Load curator-stage prompt slices into agent context when a curator stage is active. |
| `event_schema_shadow.enabled` | `true` | Enable shadow injection and staleness checks for event schemas. Kill switch: `ORCHESTRAY_DISABLE_SCHEMA_SHADOW=1`. |
| `event_schema_shadow.miss_threshold_24h` | `10` | Shadow misses within 24 hours that trigger the auto-disable sentinel. |
| `handoff_body_cap.enabled` | `true` | Enable handoff body size checks in the T15 hook. |
| `handoff_body_cap.warn_tokens` | `2500` | Token count (4 bytes/token heuristic) at which a `handoff_body_warn` event is emitted. |
| `handoff_body_cap.block_tokens` | `5000` | Token count above which a block fires when no `detail_artifact` is present. Must be ≥ `warn_tokens`. |
| `handoff_body_cap.hard_block` | `false` | When `false`: soft-warn only (exit 0). When `true`: exit 2 blocks completion. |

---

## 6. Plugin loader

All keys are nested under `plugin_loader` in `.orchestray/config.json`.

| Key | Default | What it does |
|-----|---------|--------------|
| `plugin_loader.enabled` | `true` | Master kill-switch. `false` disables the plugin loader entirely. Env: `ORCHESTRAY_PLUGIN_LOADER_DISABLED=1`. |
| `plugin_loader.dry_run` | `false` | Discover and validate plugins but do not activate them. Env: `ORCHESTRAY_PLUGIN_LOADER_DRY_RUN=1`. |
| `plugin_loader.strict_capabilities` | `true` | Enforce manifest capability declarations: violations kill the plugin and inject-suspected responses are prefixed `[SECURITY]`. Default-on since v2.3.12. Set `false` to revert to advisory-only (violations log but don't kill the plugin). Env: `ORCHESTRAY_PLUGIN_STRICT_CAPS_DISABLED=1`. |
| `plugin_loader.notify_list_changed` | `true` | Emit an event when the active plugin list changes. |
| `plugin_loader.restart_flag_check` | `true` | Check for a restart-required flag file before each tool call. |
| `plugin_loader.discovery.enabled` | `true` | Enable automatic plugin discovery on startup. Env: `ORCHESTRAY_PLUGIN_DISCOVERY_DISABLED=1`. |
| `plugin_loader.discovery.scan_paths` | `null` | Additional directories to scan for plugins. `null` uses built-in defaults only. |
| `plugin_loader.consent.require_explicit_grant` | `true` | Require a user grant before activating a newly discovered plugin. |
| `plugin_loader.consent.auto_approve_unsigned` | `false` | Auto-approve plugins with no signature file. Keep `false` in production. |
| `plugin_loader.lifecycle.max_restart_attempts` | `3` | Max restart attempts before a plugin is marked failed-permanent. |
| `plugin_loader.lifecycle.restart_backoff_ms` | `[1000,5000,30000]` | Delay (ms) between each restart attempt. Last value is reused if more attempts are needed. |
| `plugin_loader.lifecycle.restart_reset_window_ms` | `300000` | If a plugin runs crash-free for this many ms, its restart counter resets (default: 5 min). |
| `plugin_loader.lifecycle.tool_call_timeout_ms` | `60000` | Timeout for a single MCP tool call through a plugin (default: 1 min). |
| `plugin_loader.lifecycle.spawn_timeout_ms` | `10000` | Timeout for spawning the plugin subprocess (default: 10 s). |
| `plugin_loader.lifecycle.tools_response_max_bytes` | `1048576` | Maximum response payload from a plugin tool call (default: 1 MiB). |
| `plugin_loader.telemetry.emit_tool_invocation_events` | `true` | Emit orchestray events for each tool call routed through a plugin. |
| `plugin_loader.telemetry.redact_args` | `true` | Redact tool call arguments before emitting telemetry (prevents secret leakage). |

---

## 7. Reviewer and gates

| Key | Default | What it does |
|-----|---------|--------------|
| `budget_enforcement.enabled` | `true` | Enable preflight spawn-budget checks (`preflight-spawn-budget.js`). |
| `anti_pattern_gate.enabled` | `true` | Enable the pre-spawn anti-pattern advisory gate. Set `false` to disable matching entirely. |
| `anti_pattern_gate.min_decayed_confidence` | `0.55` | Minimum decayed confidence for an anti-pattern to emit an advisory. Range: 0.0–1.0. |
| `anti_pattern_gate.max_advisories_per_spawn` | `1` | Maximum anti-pattern advisories injected per single `Agent()` spawn. Do not raise above 1 without careful consideration. |
| `mcp_enforcement.unknown_tool_policy` | `"block"` | Policy for MCP tool names not in the agent/skip allowlists: `"block"` (fail-closed), `"warn"`, or `"allow"`. |
| `mcp_enforcement.pattern_record_application` | `"hook-strict"` | Enforcement mode for `pattern_record_application` calls: `"hook-strict"` (blocking), `"hook-warn"` (advisory), `"hook"`, `"prompt"`, or `"allow"`. |
| `pattern_evidence.gate_mode` | falls back to `mcp_enforcement.pattern_record_application` (`"hook-strict"`) | Enforcement mode for the §22c post-decomposition pattern-evidence gate: `"hook-strict"` (blocking), `"hook-warn"` (advisory), `"hook"`, `"prompt"`, or `"allow"`. The gate only fires when a pattern was actually offered to a spawned agent this orchestration and no `pattern_record_skip_reason` was recorded for it — an orchestration with an empty/unmatched pattern corpus never triggers it, regardless of mode. Set to `"allow"` as an emergency per-gate override (`mcp_enforcement.global_kill_switch=true` disables all MCP enforcement gates, this one included). |
| `mcp_enforcement.global_kill_switch` | `false` | When `true`, disables all MCP enforcement (requires `kill_switch_reason` to be set). |
| `cochange_oracle.enabled` | `true` | Enable the Co-change Oracle — mines `git log` for files that historically change together, then flags half-done changes. |
| `cochange_oracle.companion_gate` | `"block"` | Companion-file gate at `SubagentStop`: `"block"`, `"advisory"` (telemetry only), or `"off"`. Only rules confirmed on recent history can block. |
| `cochange_oracle.seam_gate` | `"advisory"` | Pre-spawn warning when two parallel tasks own historically coupled files. Advisory-only in v2.3.18; `"off"` silences it. |
| `cochange_oracle.min_conf` | `0.8` | Minimum confidence `P(companion changed \| file changed)` for the companion gate to block. |
| `cochange_oracle.min_support` | `5` | Minimum number of commits backing a rule before it may block. |
| `cochange_oracle.ramp` | `3` | Warn-only occurrences of each individual finding (per role, per co-change rule) before the companion gate starts blocking. A new obligation always warns first. The gate only ever considers files the spawn itself reported writing, and skips read-only roles entirely. |
| `behavior_diff_gate.enabled` | `true` | Enable the Behavior Diff Gate — replays changed hook scripts against harvested real inputs and diffs observed behavior. |
| `behavior_diff_gate.harvest` | `true` | Collect fixtures from live hook runs into `.orchestray/fixtures/`. Separable from `block` on purpose: the corpus must build before the gate is worth arming. |
| `behavior_diff_gate.block` | `true` | Treat an unexplained behavior delta as a failure. Set `false` for telemetry only. |
| `behavior_diff_gate.max_fixtures_per_script` | `40` | Corpus cap per script. |
| — | — | Wired at release-readiness time (`bin/release-readiness.js` check g), diffing changed `bin/*.js` scripts against the last release tag. Not wired to interactive edits — replay cost (git worktree + fixture corpus) is multiple seconds per script, too slow for a hot path. |

---

## 8. Learning and patterns

### 8a. Pattern decay

| Key | Default | What it does |
|-----|---------|--------------|
| `pattern_decay.default_half_life_days` | `90` | Days after which a pattern's confidence decays to half its value. Formula: `confidence × 0.5^(age/half_life)`. Range: 1–3650. |
| `pattern_decay.category_overrides` | `{}` | Per-category half-life overrides (e.g., `{"anti-pattern": 180}`). Keys are category names; values are integers 1–3650. |

### 8b. Pattern retrieval

| Key | Default | What it does |
|-----|---------|--------------|
| `retrieval.scorer_variant` | `"baseline"` | Authoritative scorer for `pattern_find` ranking. Options: `"baseline"`, `"skip-down"`, `"local-success"`, `"composite"`. |
| `retrieval.shadow_scorers` | `[]` | Scorers to run alongside the primary in shadow mode (telemetry only, never affects output). Valid: `"skip-down"`, `"local-success"`. |
| `retrieval.top_k` | `10` | Top-K window for rank-agreement telemetry. Range: 1–50. |
| `retrieval.jsonl_max_bytes` | `1048576` | Size cap for `scorer-shadow.jsonl` before rotation. Range: 65536–10485760 bytes. |
| `retrieval.jsonl_max_generations` | `3` | Rotated JSONL generations to keep. Range: 1–10. |
| `retrieval.global_kill_switch` | `false` | Emergency kill switch: `true` makes the shadow seam a no-op. |

### 8c. Auto-learning

| Key | Default | What it does |
|-----|---------|--------------|
| `auto_learning.global_kill_switch` | `false` | Disables all auto-learning sub-features when `true`. Env override: `ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1`. |
| `auto_learning.extract_on_complete.enabled` | `false` | Automatically propose new patterns after each orchestration completes. Must be explicitly set `true` to activate. |
| `auto_learning.extract_on_complete.shadow_mode` | `false` | Run extraction without writing any proposals (measurement only). |
| `auto_learning.extract_on_complete.proposals_per_orchestration` | `3` | Max pattern proposals per orchestration. Clamped to 1–10. |
| `auto_learning.extract_on_complete.proposals_per_24h` | `10` | Max pattern proposals across all orchestrations in a 24-hour window. Clamped to 1–50. |
| `auto_learning.extract_on_complete.backend` | `"haiku-cli"` | Extraction backend: `"haiku-cli"` (default) or `"stub"`. |
| `auto_learning.extract_on_complete.timeout_ms` | `180000` | Extraction CLI timeout in milliseconds. Clamped to 5000–300000. |
| `auto_learning.extract_on_complete.max_output_bytes` | `65536` | Hard stdout cap for extraction output. Clamped to 1024–1048576 bytes. |
| `auto_learning.roi_aggregator.enabled` | `false` | Enable periodic ROI aggregation runs. |
| `auto_learning.roi_aggregator.min_days_between_runs` | `1` | Minimum days between ROI aggregation runs. Clamped to 1–90. |
| `auto_learning.roi_aggregator.lookback_days` | `30` | Days of history included in each ROI aggregation. Clamped to 1–365. |
| `auto_learning.kb_refs_sweep.enabled` | `false` | Enable periodic KB reference sweep. |
| `auto_learning.kb_refs_sweep.min_days_between_runs` | `7` | Minimum days between KB sweep runs. Clamped to 1–90. |
| `auto_learning.kb_refs_sweep.ignore_slugs` | `[]` | Pattern slugs to exclude from KB sweep. Max 100 entries; each must match `/^[a-z][a-z0-9-]{3,40}$/`. |
| `auto_learning.safety.circuit_breaker.max_extractions_per_24h` | `10` | Extractions in 24 hours that trip the circuit breaker. Clamped to 1–100. |
| `auto_learning.safety.circuit_breaker.cooldown_minutes_on_trip` | `60` | Minutes to wait after circuit breaker trips before allowing more extractions. Clamped to 5–1440. |

### 8d. Curator

| Key | Default | What it does |
|-----|---------|--------------|
| `curator.enabled` | `true` | Enable `/orchestray:learn curate`. Set `false` to disable curator runs entirely. |
| `curator.self_escalation_enabled` | `true` | Allow the curator to request Opus tier for borderline merge decisions (capped at 3 escalations per run). |
| `curator.pm_recommendation_enabled` | `true` | Allow the PM to surface a once-per-session recommendation to run curator. |
| `curator.tombstone_retention_runs` | `3` | Number of curator runs kept in the active tombstone rollback window. Range: 1–10. |
| `curator.diff_enabled` | `false` | Enable the `curate --diff` incremental mode. Opt-in only; when `false`, `--diff` is rejected. |
| `curator.diff_cutoff_days` | `30` | Patterns stamped more than this many days ago are re-evaluated in `--diff` mode even if body is unchanged. Range: 1–365. |
| `curator.diff_forced_full_every` | `10` | Every Nth `--diff` run evaluates the entire corpus regardless of dirty-set signals. Range: 1–1000. |

### 8e. Feature demand gate

| Key | Default | What it does |
|-----|---------|--------------|
| `feature_demand_gate.enabled` | `true` | Enable demand tracking and advisory behavior for feature gates. |
| `feature_demand_gate.observation_window_days` | `14` | Days of shadow data required before auto-quarantine activates. |
| `feature_demand_gate.shadow_mode` | `false` | When `true`, reverts to advisory-only mode (no auto-quarantine). When `false`, features with zero tier2_invoked events in the observation window are auto-quarantined. |
| `feature_demand_gate.quarantine_candidates` | `[]` | Gate slugs treated as quarantined regardless of their config value. Valid slugs: `"pattern_extraction"`, `"archetype_cache"`. |

### 8f. Federation

| Key | Default | What it does |
|-----|---------|--------------|
| `federation.shared_dir_enabled` | `false` | Enable the shared pattern tier (read from and promote to `~/.orchestray/shared/`). Must be explicitly set `true`. |
| `federation.sensitivity` | `"private"` | `"private"` — patterns never eligible for promotion. `"shareable"` — patterns may be promoted via the promote/share command. |
| `federation.shared_dir_path` | `"~/.orchestray/shared"` | Path to the shared pattern directory. Override for testing. |

### 8g. Custom agents

| Key | Default | What it does |
|-----|---------|--------------|
| `custom_agents.enabled` | `true` | Enable discovery and loading of custom agent `.md` files. |
| `custom_agents.max_files` | `100` | Soft cap on `.md` files scanned in the custom-agents source directory. Max 1000. |

---

## 9. Resilience and telemetry

### 9a. Resilience (session recovery)

| Key | Default | What it does |
|-----|---------|--------------|
| `resilience.enabled` | `true` | Enable dossier write and injection for session recovery after compaction or restart. Env override: `ORCHESTRAY_RESILIENCE_DISABLED=1`. |
| `resilience.shadow_mode` | `false` | Write the dossier on every PM/SubagentStop but do NOT inject it on SessionStart. Useful for testing without changing behavior. |
| `resilience.kill_switch` | `false` | Hard-off independent of `enabled`. Takes precedence over `enabled: true`. |
| `resilience.inject_max_bytes` | `12288` | Hard cap on the dossier payload injected into `additionalContext`. Clamped to 512–32768 bytes. |
| `resilience.max_inject_turns` | `3` | Post-compact turns that receive the dossier injection. Clamped to 1–10. |

### 9b. Telemetry

| Key | Default | What it does |
|-----|---------|--------------|
| `telemetry.tier2_tracking.enabled` | `true` | Enable tier-2 prompt load telemetry (emit-tier2-load.js, gate-telemetry.js, tier2-invoked-emitter.js). Kill switch: `ORCHESTRAY_DISABLE_TIER2_TELEMETRY=1`. |

### 9c. Context statusbar

| Key | Default | What it does |
|-----|---------|--------------|
| `context_statusbar.enabled` | `true` | Show the context-usage statusbar. When `false`, the statusbar prints an empty line. |
| `context_statusbar.unicode` | `false` | Use Unicode block-fill bar instead of K/M numbers. |
| `context_statusbar.color` | `false` | Emit ANSI color codes for pressure levels. |
| `context_statusbar.width_cap` | `120` | Maximum rendered statusbar line width; subagent list is truncated from the right. Must be ≥ 40. |
| `context_statusbar.pressure_thresholds.warn` | `75` | Context fill percentage at which the statusbar enters warn state. Range: 0–100. |
| `context_statusbar.pressure_thresholds.critical` | `90` | Context fill percentage at which the statusbar enters critical state. Range: 0–100. |
| `context_statusbar.idle_suppression` | `true` | Suppress the statusbar when no subagents are active and parent fill is below the warn threshold. Set `false` to always render. |

---

## 10. Install and worktree

| Key | Default | What it does |
|-----|---------|--------------|
| `worktree_auto_commit.enabled` | `true` | Auto-commit dirty worktree when an orchestration is active, so agent-level edits are never silently lost on SubagentStop. |
| `master_auto_commit.enabled` | `true` | Auto-commit dirty master tree when an orchestration is active, so PM-level edits are never silently lost on PM Stop. Kill switch env: `ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED=1`. |
| `dual_install.autoheal_enabled` | `true` | Automatically overwrite the global install with the local install when divergence is detected and local is canonical (local mtime ≥ global mtime). Kill switch env: `ORCHESTRAY_DUAL_INSTALL_AUTOHEAL_DISABLED=1`. |

---

## 11. Oversized-Input Mode

All keys are nested under `oversized_input` in `.orchestray/config.json`.

| Key | Default | What it does |
|-----|---------|--------------|
| `oversized_input.enabled` | `true` | Master kill-switch. `false` disables oversized-input detection entirely. Env: `ORCHESTRAY_DISABLE_OVERSIZED_INPUT=1`. |
| `oversized_input.threshold_bytes` | `1572864` (1.5 MB) | File or directory byte size that triggers the mode. |
| `oversized_input.threshold_tokens` | `200000` | Estimated token count for pasted text that triggers the mode (4 chars/token heuristic). |
| `oversized_input.slice_chars` | `6000` | Character window for each map slice sent to a scout agent. |
| `oversized_input.max_slices` | `64` | Maximum slices per map layer. Bounds fan-out and cost. |
| `oversized_input.map_model` | `haiku` | Model used for per-slice scout reads. |
| `oversized_input.synthesis_model` | `sonnet` | Model used for the final synthesis reduce pass. |
| `oversized_input.confirm_over_slices` | `16` | Ask for confirmation before dispatching a map layer wider than this many slices. |
| `oversized_input.hierarchical_reduce` | `true` | When the corpus exceeds `max_slices`, process in batches instead of refusing. |
| `oversized_input.max_corpus_bytes` | `536870912` (512 MB) | Upper size limit — inputs larger than this are treated as normal, not sliced. |

Kill switches: `oversized_input.enabled: false` in `.orchestray/config.json`, or env `ORCHESTRAY_DISABLE_OVERSIZED_INPUT=1`.

---

## Kill switches

To **disable** a feature rather than tune it, see [KILL_SWITCHES.md](KILL_SWITCHES.md). That file catalogs ~80 disable flags across 10 categories, including env-var kill switches that take effect without a session restart.

---

*Generated for v2.3.14; `bin/_lib/config-schema.js` is the source of truth — when this doc and the schema disagree, the schema wins.*
