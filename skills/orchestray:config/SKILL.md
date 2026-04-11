---
name: config
description: View or modify orchestration settings
disable-model-invocation: true
argument-hint: [setting] [value] or empty to show all
---

# Orchestration Configuration

The user wants to view or modify orchestration settings.

## Configuration Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If empty: Show all current settings
   - If one argument: Show that specific setting's current value
   - If two arguments: Set the first to the value of the second

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
  }
}
```

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

Use `/orchestray:config [setting] [value]` to change a setting.
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
