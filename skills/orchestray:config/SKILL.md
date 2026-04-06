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
  "enable_agent_teams": false
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

Use `/orchestray:config [setting] [value]` to change a setting.
```

When setting a value:
```
Updated `{setting}` from `{old_value}` to `{new_value}`.
```
