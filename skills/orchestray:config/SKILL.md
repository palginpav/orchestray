---
name: config
description: View or modify orchestration settings
disable-model-invocation: true
argument-hint: "[setting] [value] | show federation | federation disable-global | repair | or empty to show all"
---

# Orchestration Configuration

The user wants to view or modify orchestration settings.

## Configuration Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If empty: Show all current settings
   - If arguments are `show federation`: go to the **show federation** section below.
   - If arguments are `federation disable-global`: go to the **federation disable-global** section below.
   - If the first argument is `repair`: go to the **repair** section below.
   - If one argument: Show that specific setting's current value
   - If two or more arguments starting with `set`: treat as `set <key> <value>` (the `set` keyword is optional; `set federation.shared_dir_enabled true` and `federation.shared_dir_enabled true` are equivalent)
   - If two arguments (no `set` prefix): Set the first to the value of the second

2. **Configuration file**: Settings are stored in `.orchestray/config.json`. If it does not exist, use these defaults:

```json
{
  "auto_review": true,
  "max_retries": 1,
  "default_delegation": "sequential",
  "verbose": false,
  "complexity_threshold": 4,
  "force_orchestrate": false,
  "force_solo": false,
  "replan_budget": 3,
  "verify_fix_max_rounds": 3,
  "model_floor": "sonnet",
  "force_model": null,
  "haiku_max_score": 3,
  "opus_min_score": 6,
  "default_effort": null,
  "force_effort": null,
  "effort_routing": true,
  "enable_agent_teams": false,
  "max_cost_usd": null,
  "security_review": "auto",
  "tdd_mode": false,
  "enable_prescan": true,
  "enable_repo_map": true,
  "test_timeout": 60,
  "confirm_before_execute": false,
  "enable_checkpoints": false,
  "ci_command": null,
  "ci_max_retries": 2,
  "post_to_issue": false,
  "post_pr_comments": false,
  "daily_cost_limit_usd": null,
  "weekly_cost_limit_usd": null,
  "auto_document": false,
  "adversarial_review": false,
  "enable_introspection": true,
  "enable_backpressure": true,
  "surface_disagreements": true,
  "enable_drift_sentinel": true,
  "enable_visual_review": false,
  "enable_threads": true,
  "enable_outcome_tracking": false,
  "enable_personas": true,
  "enable_replay_analysis": true,
  "max_turns_overrides": null,
  "mcp_enforcement": {
    "pattern_find": "hook",
    "kb_search": "hook",
    "history_find_similar_tasks": "hook",
    "pattern_record_application": "hook",
    "unknown_tool_policy": "block",
    "global_kill_switch": false
  },
  "federation": {
    "shared_dir_enabled": false,
    "sensitivity": "private",
    "shared_dir_path": "~/.orchestray/shared"
  },
  "curator": {
    "enabled": true,
    "self_escalation_enabled": true,
    "pm_recommendation_enabled": true,
    "tombstone_retention_runs": 3
  },
  "ox_telemetry_enabled": false
}
```

**Writing nested sections:** For any key under `federation.*` or `curator.*`, write
the value into the nested object form in `.orchestray/config.json`. That is:
`/orchestray:config set federation.shared_dir_enabled true` must produce
`"federation": {"shared_dir_enabled": true, ...}` in the config file — NOT a top-level
`"federation.shared_dir_enabled": true` key. When writing, read the existing
`"federation"` or `"curator"` object first (or start from defaults), merge the
updated key into it, and write the whole section back as a nested object. Remove any
surviving flat dotted top-level keys for the same section (e.g., delete
`"federation.shared_dir_enabled"` if present as a top-level key after migrating it
to nested).

### Available Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `auto_review` | boolean | `true` | Automatically run reviewer after developer completes |
| `max_retries` | number | `1` | Maximum retry attempts on agent failure (0-2) |
| `default_delegation` | string | `"sequential"` | Default delegation pattern: "sequential", "parallel", or "selective" |
| `verbose` | boolean | `false` | Show detailed agent progress during orchestration |
| `complexity_threshold` | number | `4` | Minimum complexity score to trigger orchestration (1-12) |
| `force_orchestrate` | boolean | `false` | Always orchestrate regardless of complexity score |
| `force_solo` | boolean | `false` | Never orchestrate regardless of complexity score |
| `replan_budget` | number | `3` | Maximum re-plan attempts per orchestration before user escalation (1-10) |
| `verify_fix_max_rounds` | number | `3` | Maximum reviewer-developer fix rounds before user escalation (1-10) |
| `model_floor` | string | `"sonnet"` | Minimum model tier for all agents: "haiku", "sonnet", or "opus" |
| `force_model` | string/null | `null` | Force all agents to use this model, overriding routing. One of: "haiku", "sonnet", "opus", or null |
| `haiku_max_score` | number | `3` | Maximum complexity score for Haiku routing (0-12). Tasks scoring above this get Sonnet or higher |
| `opus_min_score` | number | `6` | Minimum complexity score for Opus routing (0-12). Tasks scoring at or above this get Opus |
| `default_effort` | string/null | `null` | Default effort level for all agents: "low", "medium", "high", "max", or null (auto from model). When set, overrides the model-derived default but override criteria still apply. |
| `force_effort` | string/null | `null` | Force all agents to this effort level, overriding all routing. One of: "low", "medium", "high", "max", or null. |
| `effort_routing` | boolean | `true` | Enable effort routing based on model-effort mapping. When false, agents use their static frontmatter effort defaults. |
| `enable_agent_teams` | boolean | `false` | Enable Agent Teams mode for parallel orchestration (experimental). When true, PM may use Agent Teams for 3+ parallel tasks with inter-agent communication. |
| `max_cost_usd` | number/null | `null` | Maximum cost per orchestration in USD. null = no limit. PM enforces budget when set. |
| `security_review` | string | `"auto"` | Security review mode: "auto" (PM auto-invokes on security-sensitive tasks), "manual" (user requests), "off" (disabled) |
| `tdd_mode` | boolean | `false` | Prefer test-driven development orchestration flow for new features. When true, PM uses: architect → tester → developer → reviewer |
| `enable_prescan` | boolean | `true` | Lightweight codebase pre-scan on first orchestration per project. Creates codebase overview in KB. |
| `enable_repo_map` | boolean | `true` | Generate a structured repository map during orchestration init. Provides agents with project structure, exports, and conventions. When false, agents fall back to standard exploration. Also skipped when `enable_prescan` is false. |
| `test_timeout` | number | `60` | Maximum seconds for test suite execution in validation paths (1-300) |
| `confirm_before_execute` | boolean | `false` | Show orchestration preview with task graph and cost estimates before execution |
| `enable_checkpoints` | boolean | `false` | Pause between parallel groups during orchestration to show results and let the user continue, modify, review, or abort. When `confirm_before_execute` is also true, checkpoints are always enabled regardless of this setting. |
| `ci_command` | string/null | `null` | Shell command to run as CI check after orchestration (e.g., "npm test", "pytest", "make check"). When set, CI runs automatically after orchestration completes. |
| `ci_max_retries` | number | `2` | Maximum number of CI fix-retry iterations. When CI fails, PM creates a mini follow-up orchestration to fix failures, up to this many attempts. |
| `post_to_issue` | boolean | `false` | When orchestrating from a GitHub issue, post an orchestration summary as a comment on the issue after completion. Requires `gh` CLI. |
| `post_pr_comments` | boolean | `false` | Automatically post review findings to GitHub PRs when using `/orchestray:review-pr` (overrides the `--post-comments` flag requirement). |
| `daily_cost_limit_usd` | number/null | `null` | Maximum daily orchestration spend in USD. At 80% shows warning, at 100% blocks new orchestrations. Set to null for unlimited. |
| `weekly_cost_limit_usd` | number/null | `null` | Maximum weekly orchestration spend in USD (Monday-Sunday). At 80% shows warning, at 100% blocks new orchestrations. Set to null for unlimited. |
| `auto_document` | boolean | `false` | Automatically spawn documenter agent after feature additions are detected. Triggers on "New Feature" or "API Addition" archetypes, new file creation, or new exports/endpoints. |
| `adversarial_review` | boolean | `false` | Enable adversarial architecture review for high-complexity tasks (score 8+). When enabled, two competing architect designs are evaluated in parallel and the PM selects the better approach. Doubles architect cost. |
| `enable_introspection` | boolean | `true` | After each non-Haiku agent completes, a Haiku distiller extracts the reasoning trace into a compressed file for downstream agents. Opt-out to skip trace extraction. |
| `enable_backpressure` | boolean | `true` | Agents write structured confidence signals at checkpoints; PM reacts by proceeding, injecting context, re-evaluating, or escalating. Opt-out to disable confidence-based backpressure. |
| `surface_disagreements` | boolean | `true` | Reviewer findings that represent genuine design trade-offs are surfaced to the user as structured decisions instead of routing through verify-fix. Opt-out to treat all findings as verify-fix. |
| `enable_drift_sentinel` | boolean | `true` | Detects architectural drift via invariants extracted from architect output and static rules. Pre/post-execution checks surface violations. Opt-out to disable drift detection. |
| `enable_visual_review` | boolean | `false` | Multi-modal review for UI changes. PM auto-detects screenshots and includes them in reviewer delegation with a 6-dimension visual checklist. Opt-in since it requires screenshot artifacts. |
| `enable_threads` | boolean | `true` | Enable cross-session thread creation and matching. Threads capture domain context across orchestrations and inject relevant history as "Previously" context. Opt-out to disable. |
| `enable_outcome_tracking` | boolean | `false` | Enable deferred quality validation via outcome probes. After orchestration, PM records delivered files; on next relevant session, lazily validates via git history and test runs. Opt-in since it executes test commands. |
| `enable_personas` | boolean | `true` | Enable auto-generated project-tuned agent personas. After 3+ orchestrations, PM synthesizes per-agent behavioral directives injected into delegation prompts. Opt-out to disable. |
| `enable_replay_analysis` | boolean | `true` | Enable counterfactual analysis on friction orchestrations (re-plans, verify-fix failures, cost overruns). Stores alternative strategies as advisory replay patterns. Opt-out to disable. |
| `max_turns_overrides` | object/null | `null` | Per-agent override for the `maxTurns` ceiling. When `null`, each agent's frontmatter `maxTurns` is the ceiling. When set to an object (e.g., `{"reviewer": 50, "debugger": 60}`), the override replaces the frontmatter ceiling for those agents. Values 5-200. Set this when agents consistently hit their turn limit on legitimate large tasks. |
| `mcp_enforcement.pattern_find` | string | `"hook"` | Enforcement mode for the `pattern_find` MCP tool. One of: "hook" (gate requires MCP checkpoint), "prompt" (warn only, allow spawn), "allow" (fully skip enforcement). |
| `mcp_enforcement.kb_search` | string | `"hook"` | Enforcement mode for the `kb_search` MCP tool. One of: "hook", "prompt", "allow". |
| `mcp_enforcement.history_find_similar_tasks` | string | `"hook"` | Enforcement mode for the `history_find_similar_tasks` MCP tool. One of: "hook", "prompt", "allow". |
| `mcp_enforcement.pattern_record_application` | string | `"hook"` | Advisory only — not gate-enforced; controls whether `record-pattern-skip.js` emits the `pattern_record_skipped` event on PreCompact. When set to `"prompt"` or `"allow"`, suppresses the advisory event. Setting this to `"prompt"` has no effect on spawn gating (the gate only enforces `pattern_find`, `kb_search`, `history_find_similar_tasks`). |
| `mcp_enforcement.unknown_tool_policy` | string | `"block"` | Policy for tool_name values not in the agent/skip allowlists. "block" (fail-closed, 2.0.12 default), "warn" (log and allow, 2.0.11 behaviour), "allow" (fully fail-open). |
| `mcp_enforcement.global_kill_switch` | boolean | `false` | When true, gate-agent-spawn.js short-circuits before ALL 2.0.12 checks (MCP checkpoint verification and unknown-tool allowlist). Routing-entry checks from 2.0.11 still apply. EMERGENCY USE ONLY. |
| `federation.shared_dir_enabled` | boolean | `false` | Enable cross-project pattern sharing on this machine. When true, patterns shared via `/orchestray:learn share` become available to all projects that also have this enabled. Off by default — opt-in per machine. |
| `federation.sensitivity` | string | `"private"` | Controls whether this project's patterns are eligible for sharing. `"private"` (default — fail-safe) = patterns from this project are never eligible for sharing (use for NDA work, client projects, personal data). `"shareable"` = patterns may be promoted to `~/.orchestray/shared/`. Opt-in per project. |
| `federation.shared_dir_path` | string | `"~/.orchestray/shared"` | Absolute path (tilde-expanded) for the machine-wide shared patterns directory. Change only if you need to relocate the shared dir (e.g., to a mounted volume). |
| `curator.enabled` | boolean | `true` | Master on/off switch for `/orchestray:learn curate`. When `false`, the curate command reports "Curator is disabled" and stops immediately. |
| `curator.self_escalation_enabled` | boolean | `true` | Allow the curator to escalate to a higher-reasoning model for borderline merge decisions. When `false`, all merges are evaluated at the curator's default model tier. |
| `curator.pm_recommendation_enabled` | boolean | `true` | Allow the PM to surface a once-per-session recommendation to run the curator when the pattern corpus shows signs of needing hygiene. When `false`, the PM never nags about curation. |
| `curator.tombstone_retention_runs` | integer | `3` | Number of curator runs kept in the undo window (1–10). Runs older than this are archived to `.orchestray/curator/tombstones-archive/`. Affects how far back `undo <action-id>` can reach. |
| `ox_telemetry_enabled` | boolean | `false` | Enable ox.jsonl telemetry log. Default false. Opt-in only. |
| `mcp_server.max_per_task.ask_user` | integer | `20` | Per-task call limit for the `ask_user` MCP tool. Integer 1–1000. When exceeded within a single (orchestration_id, task_id) scope, the tool returns a budget-exceeded signal. Out-of-range or non-integer values fall back to the default and write a `mcp_server_max_per_task_out_of_range` degraded-journal entry. |
| `mcp_server.max_per_task.kb_write` | integer | `20` | Per-task call limit for the `kb_write` MCP tool. Same constraints and fallback behaviour as `ask_user`. |
| `mcp_server.max_per_task.pattern_record_application` | integer | `20` | Per-task call limit for the `pattern_record_application` MCP tool. Same constraints and fallback behaviour as `ask_user`. |
| `mcp_server.max_per_task.<custom_tool>` | integer | — | Forward-compat: unknown tool names are passed through unchanged without validation. A `mcp_server_max_per_task_unknown_tool` degraded-journal entry is written once per boot per unknown tool (K5). |

**Note:** Effort routing requires Claude Code v2.1.33+. On older versions, effort settings
are recorded in the audit trail but have no effect on agent behavior.

**Config + PM integration:** The PM agent reads these settings at orchestration start to determine scoring behavior. Changes take effect on the next orchestration.

3. **Validation**: 
   - `max_retries` must be 0, 1, or 2
   - `default_delegation` must be one of: "sequential", "parallel", "selective"
   - `auto_review` and `verbose` must be boolean (true/false)
   - `complexity_threshold` must be a number between 1 and 12
   - `force_orchestrate` and `force_solo` must be boolean (true/false)
   - `replan_budget` must be a number between 1 and 10
   - `verify_fix_max_rounds` must be a number between 1 and 10
   - `force_orchestrate` and `force_solo` cannot both be `true` -- reject with error: "Cannot set both force_orchestrate and force_solo to true. Choose one or set both to false."
   - `model_floor` must be one of: "haiku", "sonnet", "opus"
   - `force_model` must be one of: "haiku", "sonnet", "opus", or null
   - `haiku_max_score` must be a number between 0 and 12
   - `opus_min_score` must be a number between 0 and 12
   - `opus_min_score` must be greater than `haiku_max_score` -- reject with error: "opus_min_score must be greater than haiku_max_score to avoid routing ambiguity."
   - `default_effort` must be null or one of: "low", "medium", "high", "max"
   - `force_effort` must be null or one of: "low", "medium", "high", "max"
   - If `force_effort` is "max", warn: "max effort is Opus 4.6 exclusive. Ensure model_floor or force_model is set to opus."
   - `effort_routing` must be boolean (true/false)
   - `enable_agent_teams` must be boolean (true/false)
   - `max_cost_usd` must be null or a positive number. If 0 or negative, reject with error: "max_cost_usd must be null (no limit) or a positive number."
   - `security_review` must be one of: "auto", "manual", "off"
   - `tdd_mode` must be boolean (true/false)
   - `enable_prescan` must be boolean (true/false)
   - `enable_repo_map` must be boolean (true/false)
   - `test_timeout` must be a number between 1 and 300
   - `confirm_before_execute` must be boolean (true/false)
   - `enable_checkpoints` must be boolean (true/false)
   - `ci_command` must be null or a non-empty string. If empty string, reject with error: "ci_command must be null (disabled) or a non-empty shell command string."
   - `ci_max_retries` must be a number between 0 and 5
   - `post_to_issue` must be boolean (true/false)
   - `post_pr_comments` must be boolean (true/false)
   - `daily_cost_limit_usd` must be null or a positive number. If 0 or negative, reject with error: "daily_cost_limit_usd must be null (no limit) or a positive number."
   - `weekly_cost_limit_usd` must be null or a positive number. If 0 or negative, reject with error: "weekly_cost_limit_usd must be null (no limit) or a positive number."
   - `auto_document` must be boolean (true/false)
   - `adversarial_review` must be boolean (true/false)
   - `enable_introspection` must be boolean (true/false)
   - `enable_backpressure` must be boolean (true/false)
   - `surface_disagreements` must be boolean (true/false)
   - `enable_drift_sentinel` must be boolean (true/false)
   - `enable_visual_review` must be boolean (true/false)
   - `enable_threads` must be boolean (true/false)
   - `enable_outcome_tracking` must be boolean (true/false)
   - `enable_personas` must be boolean (true/false)
   - `enable_replay_analysis` must be boolean (true/false)
   - `max_turns_overrides` must be `null` OR an object mapping agent type strings (architect, developer, reviewer, debugger, tester, documenter, refactorer, inventor, security-engineer, pm) to positive integers between 5 and 200. Unknown agent types are ignored with a warning. Values outside 5-200 fall back to the frontmatter default with a warning.
   - `mcp_enforcement` must be an object when present. Individual keys are validated as follows:
     - `mcp_enforcement.pattern_find` must be one of: "hook", "prompt", "allow"
     - `mcp_enforcement.kb_search` must be one of: "hook", "prompt", "allow"
     - `mcp_enforcement.history_find_similar_tasks` must be one of: "hook", "prompt", "allow"
     - `mcp_enforcement.pattern_record_application` must be one of: "hook", "prompt", "allow"
     - `mcp_enforcement.unknown_tool_policy` must be one of: "block", "warn", "allow"
     - `mcp_enforcement.global_kill_switch` must be a boolean (true/false)
   - When setting `mcp_enforcement.global_kill_switch` to `true`, print the following warning after the normal "Updated" confirmation line:

     ```
     WARNING: mcp_enforcement.global_kill_switch is enabled. 2.0.12 hook-enforcement is fully bypassed. Re-enable with '/orchestray:config set mcp_enforcement.global_kill_switch false' when the emergency has passed.
     ```
   - When setting `mcp_enforcement.global_kill_switch` to any value (true or false), emit a kill-switch audit event **after** the config file has been successfully written. This records the state transition in the event log for analytics and health monitoring. Use the following procedure:

     1. Read the **previous** value of `mcp_enforcement.global_kill_switch` from `.orchestray/config.json` BEFORE applying the write (capture it as `previousKillSwitch`).
     2. **Capture a reason** (optional but strongly recommended when activating the switch). The user may supply a reason via the `--reason "..."` flag on the `/orchestray:config set` invocation (e.g., `/orchestray:config set mcp_enforcement.global_kill_switch true --reason "emergency rollback during W1 execution"`). If no `--reason` flag is present, interactively ask the user for a short reason when **activating** (transitioning from `false` → `true`) — do NOT ask when deactivating (transitioning `true` → `false`), since the deactivation is self-explanatory and asking would add friction to the normal recovery path. Pass an empty string if the user declines or no reason is available.
     3. After the config write succeeds, run:
        ```
        node bin/emit-kill-switch-event.js <absolute-cwd> <previousKillSwitch> <newKillSwitch> <reason>
        ```
        where `<absolute-cwd>` is the absolute path of the project root (where `.orchestray/` lives), and `<reason>` is the captured reason from step 2. The reason is passed as a multi-word argument — `bin/emit-kill-switch-event.js` joins all remaining argv elements, so quoting is optional but recommended for shell clarity. If the reason is empty or absent, omit the argument entirely (the 4th positional arg is optional).
     4. If the previous and new values are identical (no-op flip), the helper will silently skip emission — no action needed.
     5. If the `node` invocation fails for any reason, print a stderr warning but proceed — the config write has already succeeded. **Never fail the config write due to event emission errors.**

     **Why the reason matters:** analytics consumers of the `kill_switch_activated` / `kill_switch_deactivated` events use the `reason` field to distinguish emergency rollbacks from planned tests, upgrade procedures, and debugging sessions. A missing reason is valid (backward-compatible) but less useful for post-hoc root-cause analysis. See `agents/pm-reference/event-schemas.md` "Kill Switch Activated Event" section for the consumer contract.

   - When setting `enable_agent_teams`, perform a two-layer enablement: update `.orchestray/config.json` AND synchronize the live `settings.json` at the repository root (the plugin's merged settings file, NOT `orchestray/settings.json` which is only a reference copy). The config flag controls PM decision logic; the env var `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` enables Claude Code's teams API. Follow the "Agent Teams settings.json sync" procedure below after updating `.orchestray/config.json`.
   - `federation.shared_dir_enabled` must be boolean (true/false). When setting to `true`, emit the following one-time advisory **after** the normal "Updated" confirmation:
     ```
     Federation enabled. Patterns from all projects on this machine are now eligible to be shared to ~/.orchestray/shared/.

     Note: v2.1.0 shares patterns across projects on THIS machine only. Cross-machine sync is planned for v2.2.
     To manually sync to another machine today: /orchestray:learn export all → copy the export dir → /orchestray:learn import <path>

     If any project should never share patterns (NDA work, client projects, personal data), run:
       /orchestray:config set federation.sensitivity private
     inside that project before running /orchestray:learn share there.

     This message appears once. Run /orchestray:config show federation to review settings and detectable projects.
     ```
   - `federation.sensitivity` must be one of: `"private"`, `"shareable"`. Reject any other value with: "Can't set federation.sensitivity: '{value}' is not valid. Use 'private' (this project's patterns are never shared) or 'shareable' (patterns may be shared via /orchestray:learn share)."
   - `federation.shared_dir_path` must be a non-empty string. Tilde expansion (`~/`) is supported.
   - `curator.enabled` must be boolean (true/false).
   - `curator.self_escalation_enabled` must be boolean (true/false).
   - `curator.pm_recommendation_enabled` must be boolean (true/false).
   - `curator.tombstone_retention_runs` must be an integer between 1 and 10. Reject with: "curator.tombstone_retention_runs must be an integer between 1 and 10."
   - Reject invalid values with a helpful error message

4. **Output format**:

When showing settings:
```
## Orchestray Configuration

| Setting | Value | Description |
|---------|-------|-------------|
| auto_review | true | Automatically run reviewer after developer |
| max_retries | 1 | Maximum retry attempts on agent failure |
| default_delegation | sequential | Default delegation pattern |
| verbose | false | Show detailed agent progress |
| complexity_threshold | 4 | Minimum complexity score to orchestrate (1-12) |
| force_orchestrate | false | Always orchestrate regardless of score |
| force_solo | false | Never orchestrate regardless of score |
| replan_budget | 3 | Max re-plan attempts per orchestration (1-10) |
| verify_fix_max_rounds | 3 | Max reviewer-developer fix rounds (1-10) |
| model_floor | sonnet | Minimum model tier for all agents |
| force_model | null | Force all agents to use this model (overrides routing) |
| haiku_max_score | 3 | Max complexity score for Haiku routing (0-12) |
| opus_min_score | 6 | Min complexity score for Opus routing (0-12) |
| default_effort | null | Default effort level for all agents (null = auto from model) |
| force_effort | null | Force all agents to this effort level (overrides routing) |
| effort_routing | true | Enable effort routing based on model-effort mapping |
| enable_agent_teams | false | Enable Agent Teams mode (experimental) |
| max_cost_usd | null | Max cost per orchestration in USD (null = no limit) |
| security_review | auto | Security review mode (auto/manual/off) |
| tdd_mode | false | Prefer TDD orchestration flow for new features |
| enable_prescan | true | Codebase pre-scan on first orchestration |
| enable_repo_map | true | Generate repository map during orchestration init |
| test_timeout | 60 | Max seconds for test execution (1-300) |
| confirm_before_execute | false | Show orchestration preview before execution |
| enable_checkpoints | false | Pause between parallel groups to show results |
| ci_command | null | CI command to run after orchestration (null = disabled) |
| ci_max_retries | 2 | Max CI fix-retry iterations (0-5) |
| post_to_issue | false | Post summary to GitHub issue after orchestration |
| post_pr_comments | false | Auto-post review findings to GitHub PRs |
| daily_cost_limit_usd | null | Max daily orchestration spend in USD (null = no limit) |
| weekly_cost_limit_usd | null | Max weekly orchestration spend in USD (null = no limit) |
| auto_document | false | Auto-spawn documenter after feature additions |
| adversarial_review | false | Dual-architect review for score 8+ tasks |
| enable_introspection | true | Extract reasoning traces from agents for downstream context |
| enable_backpressure | true | Confidence-based backpressure between execution groups |
| surface_disagreements | true | Surface design trade-offs to user instead of verify-fix |
| enable_drift_sentinel | true | Detect architectural drift via invariant checks |
| enable_visual_review | false | Multi-modal review for UI changes (opt-in) |
| enable_threads | true | Cross-session thread creation and matching |
| enable_outcome_tracking | false | Deferred quality validation via outcome probes (opt-in) |
| enable_personas | true | Auto-generated project-tuned agent personas |
| enable_replay_analysis | true | Counterfactual analysis on friction orchestrations |
| max_turns_overrides | null | Per-agent maxTurns ceiling override map (null = use frontmatter) |
| mcp_enforcement.pattern_find | hook | MCP checkpoint enforcement mode for pattern_find (hook/prompt/allow) |
| mcp_enforcement.kb_search | hook | MCP checkpoint enforcement mode for kb_search (hook/prompt/allow) |
| mcp_enforcement.history_find_similar_tasks | hook | MCP checkpoint enforcement mode for history_find_similar_tasks (hook/prompt/allow) |
| mcp_enforcement.pattern_record_application | hook | MCP checkpoint enforcement mode for pattern_record_application (hook/prompt/allow) |
| mcp_enforcement.unknown_tool_policy | block | Policy for unknown tool_name values (block/warn/allow) |
| mcp_enforcement.global_kill_switch | false | When true, all 2.0.12 hook enforcement is bypassed (emergency use only) |
| federation.shared_dir_enabled | false | Enable cross-project pattern sharing on this machine |
| federation.sensitivity | private | Whether this project's patterns are eligible for sharing (private/shareable) |
| federation.shared_dir_path | ~/.orchestray/shared | Machine-wide shared patterns directory |
| curator.enabled | true | Master on/off switch for /orchestray:learn curate |
| curator.self_escalation_enabled | true | Allow curator to escalate model for borderline merge decisions |
| curator.pm_recommendation_enabled | true | Allow PM to surface once-per-session curator recommendation |
| curator.tombstone_retention_runs | 3 | Number of curator runs kept in the undo window (1-10) |
| ox_telemetry_enabled | false | Enable ox.jsonl telemetry log. Default false. Opt-in only. |

Use `/orchestray:config [setting] [value]` to change a setting.
Use `/orchestray:config show federation` for federation settings and detectable projects.
```

When setting a value:
```
Updated `{setting}` from `{old_value}` to `{new_value}`.
```

5. **Agent Teams settings.json sync** (only when the setting being changed is `enable_agent_teams`):

   After `.orchestray/config.json` has been updated, also synchronize the live `settings.json` file at the **repository root** (path: `settings.json` — this is the plugin's merged settings file that Claude Code actually reads). Do NOT touch `orchestray/settings.json`, which is only a reference copy.

   **Procedure:**

   1. Attempt to Read `settings.json` at the repo root.
      - If the file does NOT exist: print a warning and fall back to the legacy guidance path — output exactly: `Warning: settings.json not found at repo root. To complete Agent Teams setup, manually add to your Claude Code settings.json: "env": {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"}`. Do not create the file. Stop here.
      - If the file exists but is NOT valid JSON: bail with an error and do NOT overwrite it. Output: `Error: settings.json at repo root is not valid JSON. Refusing to modify. Fix the file manually and retry.` Stop here.
      - If the file exists and parses as JSON: proceed.

   2. **When setting `enable_agent_teams` to `true`:**
      - Ensure the parsed object has an `env` key that is an object. If `env` is missing, add `env: {}`. If `env` exists but is not an object, bail with the JSON error above.
      - Set `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"` (string, not boolean).
      - Preserve every other key in `env` and every other top-level key in `settings.json` exactly as-is (for example, a pre-existing `"agent": "pm"` must remain untouched).
      - Write the updated JSON back to `settings.json` with 2-space indentation and a trailing newline.
      - Print: `Enabled Agent Teams. settings.json updated with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1.`
      - This operation is idempotent: if the key was already `"1"`, still write (or skip the write) and print the same success message.

   3. **When setting `enable_agent_teams` to `false`:**
      - If `env` is absent or does not contain `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, skip the write and print: `Disabled Agent Teams. settings.json env var already absent.`
      - Otherwise, delete the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` key from the `env` object. Leave all other keys inside `env` untouched.
      - If `env` is now an empty object (no remaining keys), remove the `env` key from the top-level object entirely.
      - Preserve every other top-level key in `settings.json` exactly as-is.
      - Write the updated JSON back to `settings.json` with 2-space indentation and a trailing newline.
      - Print: `Disabled Agent Teams. settings.json env var removed.`

   **Example — enabling with an existing `{"agent": "pm"}` settings.json:**

   Before:
   ```json
   {
     "agent": "pm"
   }
   ```

   After:
   ```json
   {
     "agent": "pm",
     "env": {
       "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
     }
   }
   ```

   **Example — disabling when other env vars exist:**

   Before:
   ```json
   {
     "agent": "pm",
     "env": {
       "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
       "SOME_OTHER_VAR": "keep-me"
     }
   }
   ```

   After:
   ```json
   {
     "agent": "pm",
     "env": {
       "SOME_OTHER_VAR": "keep-me"
     }
   }
   ```

---

## show federation

Display all `federation.*` config values for this project, plus a scan of detectable projects on the machine.

**Invocation:** `/orchestray:config show federation`

**Steps:**

1. **Read federation settings** from `.orchestray/config.json` (or defaults if absent):
   - `federation.shared_dir_enabled`
   - `federation.sensitivity`
   - `federation.shared_dir_path`

2. **Display current federation settings:**
   ```
   ## Federation Settings (this project)

   | Setting                        | Value                    |
   |--------------------------------|--------------------------|
   | federation.shared_dir_enabled  | false                    |
   | federation.sensitivity         | private                  |
   | federation.shared_dir_path     | ~/.orchestray/shared     |

   Note: v2.1.0 shares patterns across projects on THIS machine only. Cross-machine sync is planned for v2.2.
   ```

3. **If `federation.shared_dir_enabled` is `true`**, also display a project scan advisory:

   a. **Scan for detectable projects:** Look for directories containing `.orchestray/config.json` under:
      - `$HOME` (one level deep — i.e., `$HOME/*/` only, not recursive, to avoid performance issues on large home dirs)
      - `$HOME/projects/`, `$HOME/code/`, `$HOME/dev/`, `$HOME/work/`, `$HOME/src/` (two levels deep each, if these directories exist)
      - The current project directory (always included)
      - False positives are acceptable; the scan is conservative and non-exhaustive.

   b. **For each detected project**, read `federation.sensitivity` from its `.orchestray/config.json`. If the file is absent or unreadable, assume `"private"` (default — fail-safe).

   c. **Display the scan results:**
      ```
      ## Detectable Projects on This Machine

      The following projects will share patterns via ~/.orchestray/shared/patterns/.
      Set `federation.sensitivity=private` per-project to exclude a project.

      | Project Path                        | sensitivity |
      |-------------------------------------|-------------|
      | /home/user/projects/my-app          | shareable   |
      | /home/user/projects/client-nda      | private     |
      | /home/user/code/personal            | shareable   |

      To mark a project private:
        cd /path/to/project && /orchestray:config set federation.sensitivity private
      ```

   d. If no projects are detected beyond the current one: "No other Orchestray projects detected under common paths. Add projects and re-run to see them here."

4. **If `federation.shared_dir_enabled` is `false`**, show a brief enablement hint instead of the project scan:
   ```
   Federation is currently disabled. To enable cross-project sharing on this machine:
     /orchestray:config set federation.shared_dir_enabled true
   ```

**Example:**
```
/orchestray:config show federation
```

---

## federation disable-global

Globally disable federation on this machine by setting `federation.shared_dir_enabled: false`.

**WARNING — machine-wide effect:** disabling federation affects ALL Orchestray projects on
this machine. Any project that currently reads shared patterns from `~/.orchestray/shared/`
will stop seeing those patterns after this command runs. Use this command when you are
handing off a machine, fixing a mis-share, or removing federation entirely.

**Invocation:** `/orchestray:config federation disable-global`

**Confirmation required:** Before applying any change, prompt the user to type the literal
word `MACHINE` (uppercase, exact match — no surrounding whitespace, no other text):

```
This command disables federation for ALL Orchestray projects on this machine.
To confirm, type MACHINE (uppercase):
```

- If the user types anything other than the exact string `MACHINE`, abort immediately:
  ```
  Aborted. federation disable-global was NOT applied. Current federation state unchanged.
  ```
- If the user types `MACHINE` exactly, proceed.

**Steps on confirmed execution:**

1. Read `.orchestray/config.json` in the current project directory.
2. Set `federation.shared_dir_enabled` to `false`.
3. Write the updated config back.
4. Output:

```
Federation disabled globally. `~/.orchestray/shared/` data retained (run `rm -rf ~/.orchestray/shared/` to remove). Re-enable with `/orchestray:config set federation.shared_dir_enabled true`.
```

**Data retention:** this command does NOT delete `~/.orchestray/shared/` or any pattern files
in it. The shared directory is preserved so the user can re-enable federation without losing
previously shared patterns.

**Confirmation rules (non-negotiable — W6 F10):**
- Only the exact uppercase string `MACHINE` is accepted.
- `machine`, `Machine`, `MACHINE ` (trailing space), `yes`, `y`, or empty string are all rejected.
- Case-insensitive matches are rejected — the uppercase requirement signals the user has
  understood the machine-wide scope.

**Example session:**
```
/orchestray:config federation disable-global

This command disables federation for ALL Orchestray projects on this machine.
To confirm, type MACHINE (uppercase): machine

Aborted. federation disable-global was NOT applied. Current federation state unchanged.
```

```
/orchestray:config federation disable-global

This command disables federation for ALL Orchestray projects on this machine.
To confirm, type MACHINE (uppercase): MACHINE

Federation disabled globally. `~/.orchestray/shared/` data retained (run `rm -rf ~/.orchestray/shared/` to remove). Re-enable with `/orchestray:config set federation.shared_dir_enabled true`.
```

---

## repair

Reinitialise a missing or corrupt `auto_learning` block in `.orchestray/config.json`
with default-off values. All other config keys are preserved unchanged.

A timestamped backup of the existing config is created before any rewrite, so this
operation is safe to run even on a partially-written config file.

**When to use:** The circuit-breaker TRIPPED banner in `/orchestray:status` shows
`Circuit breaker: TRIPPED — run /orchestray:config repair to reset`. This means
the `auto_learning` block is missing or has become corrupt. Running repair restores
the block to its defaults (all features disabled, kill switch off) so the circuit
breaker can be manually inspected or cleared with a fresh state.

**Invocation:** `/orchestray:config repair`

**Optional flag:** `/orchestray:config repair --dry-run` — shows what would happen
without writing any files.

**Steps:**

1. **Run the repair helper:**
   ```
   node bin/_lib/config-repair.js --project-root="$ORCHESTRAY_PROJECT_ROOT"
   ```
   The helper reads `ORCHESTRAY_PROJECT_ROOT` or defaults to `process.cwd()`. If the
   `$ORCHESTRAY_PROJECT_ROOT` variable is not available in this skill context, omit the
   flag and the helper will resolve the project root from `process.cwd()`.

   For a dry run: append `--dry-run` to the command above.

2. **Interpret the output:**
   - `[config-repair] No repair needed — auto_learning block is valid.` → Config is
     already correct. Report this to the user and suggest they check the circuit-breaker
     sentinel files in `.orchestray/state/` if the TRIPPED banner persists.
   - `[config-repair] Applied repair to <path> (reason: missing|malformed). Backup: <backup-path>` →
     Repair was applied. Report the backup path so the user can verify the change.
   - `[config-repair] DRY RUN — would repair|no-op auto_learning block (reason: ...)` →
     Dry-run completed. Report what would happen if the flag were omitted.
   - Any error written to stderr → Report the error verbatim. The config file was NOT
     modified.

3. **Post-repair guidance:** After a successful repair, remind the user:
   - The `auto_learning` block is now reset to default-off values. If you had custom
     values (e.g., `extract_on_complete.enabled: true`), re-apply them with
     `/orchestray:config set auto_learning.extract_on_complete.enabled true`.
   - The circuit-breaker sentinel files are NOT cleared by repair. If the TRIPPED banner
     persists after repair, the sentinel file remains. A future `/orchestray:doctor` run
     can provide further guidance.

**Example output:**
```
/orchestray:config repair

[config-repair] Applied repair to /path/to/.orchestray/config.json (reason: missing). Backup: /path/to/.orchestray/config.json.bak-1714500000000

auto_learning block reinitialised with default-off values. Backup saved at:
  .orchestray/config.json.bak-1714500000000

If you had custom auto_learning settings, re-apply them now with /orchestray:config set.
```
