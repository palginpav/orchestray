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
  "enable_agent_teams": false,
  "max_cost_usd": null,
  "security_review": "auto",
  "tdd_mode": false,
  "enable_regression_check": false,
  "enable_prescan": true,
  "enable_repo_map": true,
  "enable_static_analysis": false,
  "test_timeout": 60,
  "confirm_before_execute": false,
  "enable_checkpoints": false,
  "ci_command": null,
  "ci_max_retries": 2,
  "post_to_issue": false,
  "post_pr_comments": false,
  "daily_cost_limit_usd": null,
  "weekly_cost_limit_usd": null
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
| `enable_agent_teams` | boolean | `false` | Enable Agent Teams mode for parallel orchestration (experimental). When true, PM may use Agent Teams for 3+ parallel tasks with inter-agent communication. |
| `max_cost_usd` | number/null | `null` | Maximum cost per orchestration in USD. null = no limit. PM enforces budget when set. |
| `security_review` | string | `"auto"` | Security review mode: "auto" (PM auto-invokes on security-sensitive tasks), "manual" (user requests), "off" (disabled) |
| `tdd_mode` | boolean | `false` | Prefer test-driven development orchestration flow for new features. When true, PM uses: architect → tester → developer → reviewer |
| `enable_regression_check` | boolean | `false` | Run test suite before and after orchestration to detect regressions. Requires project to have tests. |
| `enable_prescan` | boolean | `true` | Lightweight codebase pre-scan on first orchestration per project. Creates codebase overview in KB. |
| `enable_repo_map` | boolean | `true` | Generate a structured repository map during orchestration init. Provides agents with project structure, exports, and conventions. When false, agents fall back to standard exploration. Also skipped when `enable_prescan` is false. |
| `enable_static_analysis` | boolean | `false` | Run detected linters/type checkers before reviewer step. Catches deterministic errors cheaply. |
| `test_timeout` | number | `60` | Maximum seconds for test suite execution during regression check (1-300) |
| `confirm_before_execute` | boolean | `false` | Show orchestration preview with task graph and cost estimates before execution |
| `enable_checkpoints` | boolean | `false` | Pause between parallel groups during orchestration to show results and let the user continue, modify, review, or abort. When `confirm_before_execute` is also true, checkpoints are always enabled regardless of this setting. |
| `ci_command` | string/null | `null` | Shell command to run as CI check after orchestration (e.g., "npm test", "pytest", "make check"). When set, CI runs automatically after orchestration completes. |
| `ci_max_retries` | number | `2` | Maximum number of CI fix-retry iterations. When CI fails, PM creates a mini follow-up orchestration to fix failures, up to this many attempts. |
| `post_to_issue` | boolean | `false` | When orchestrating from a GitHub issue, post an orchestration summary as a comment on the issue after completion. Requires `gh` CLI. |
| `post_pr_comments` | boolean | `false` | Automatically post review findings to GitHub PRs when using `/orchestray:review-pr` (overrides the `--post-comments` flag requirement). |
| `daily_cost_limit_usd` | number/null | `null` | Maximum daily orchestration spend in USD. At 80% shows warning, at 100% blocks new orchestrations. Set to null for unlimited. |
| `weekly_cost_limit_usd` | number/null | `null` | Maximum weekly orchestration spend in USD (Monday-Sunday). At 80% shows warning, at 100% blocks new orchestrations. Set to null for unlimited. |

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
   - `enable_agent_teams` must be boolean (true/false)
   - `max_cost_usd` must be null or a positive number. If 0 or negative, reject with error: "max_cost_usd must be null (no limit) or a positive number."
   - `security_review` must be one of: "auto", "manual", "off"
   - `tdd_mode` must be boolean (true/false)
   - `enable_regression_check` must be boolean (true/false)
   - `enable_prescan` must be boolean (true/false)
   - `enable_repo_map` must be boolean (true/false)
   - `enable_static_analysis` must be boolean (true/false)
   - `test_timeout` must be a number between 1 and 300
   - `confirm_before_execute` must be boolean (true/false)
   - `enable_checkpoints` must be boolean (true/false)
   - `ci_command` must be null or a non-empty string. If empty string, reject with error: "ci_command must be null (disabled) or a non-empty shell command string."
   - `ci_max_retries` must be a number between 0 and 5
   - `post_to_issue` must be boolean (true/false)
   - `post_pr_comments` must be boolean (true/false)
   - `daily_cost_limit_usd` must be null or a positive number. If 0 or negative, reject with error: "daily_cost_limit_usd must be null (no limit) or a positive number."
   - `weekly_cost_limit_usd` must be null or a positive number. If 0 or negative, reject with error: "weekly_cost_limit_usd must be null (no limit) or a positive number."
   - When setting `enable_agent_teams` to `true`, output guidance: "To complete Agent Teams setup, also add to your Claude Code settings.json: `\"env\": {\"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS\": \"1\"}`". The config setting controls PM decision logic; the env var enables Claude Code's teams API (two-layer enablement).
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
| enable_agent_teams | false | Enable Agent Teams mode (experimental) |
| max_cost_usd | null | Max cost per orchestration in USD (null = no limit) |
| security_review | auto | Security review mode (auto/manual/off) |
| tdd_mode | false | Prefer TDD orchestration flow for new features |
| enable_regression_check | false | Run test suite before/after orchestration |
| enable_prescan | true | Codebase pre-scan on first orchestration |
| enable_repo_map | true | Generate repository map during orchestration init |
| enable_static_analysis | false | Run linters before reviewer step |
| test_timeout | 60 | Max seconds for test execution (1-300) |
| confirm_before_execute | false | Show orchestration preview before execution |
| enable_checkpoints | false | Pause between parallel groups to show results |
| ci_command | null | CI command to run after orchestration (null = disabled) |
| ci_max_retries | 2 | Max CI fix-retry iterations (0-5) |
| post_to_issue | false | Post summary to GitHub issue after orchestration |
| post_pr_comments | false | Auto-post review findings to GitHub PRs |
| daily_cost_limit_usd | null | Max daily orchestration spend in USD (null = no limit) |
| weekly_cost_limit_usd | null | Max weekly orchestration spend in USD (null = no limit) |

Use `/orchestray:config [setting] [value]` to change a setting.
```

When setting a value:
```
Updated `{setting}` from `{old_value}` to `{new_value}`.
```
