# Phase 6: Persistent Specialist Registry - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.

**Date:** 2026-04-07
**Phase:** 06-Persistent Specialist Registry
**Areas discussed:** Save & reuse lifecycle, Registry format & storage, User-defined templates, Specialist skill

---

## Save & Reuse Lifecycle

| Option | Description | Selected |
|--------|-------------|----------|
| On success only | PM offers to save after dynamic agent completes with status: success | ✓ |
| On success + user confirmation | PM asks user whether to save after each successful dynamic agent | |
| Auto-save all, prune later | Every successful dynamic agent auto-saves | |

| Option | Description | Selected |
|--------|-------------|----------|
| Name + description match | PM checks if specialist name/description matches subtask. PM judges the match. | ✓ |
| Tag-based matching | Each specialist has tags, PM matches subtask keywords to tags | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, suggest at threshold | After 5 uses, PM suggests promoting to .claude/agents/. User confirms. | ✓ |
| No promotion path | Specialists stay in .orchestray/specialists/ only | |
| Auto-promote silently | After threshold, auto-copy to .claude/agents/ | |

| Option | Description | Selected |
|--------|-------------|----------|
| Soft cap with warning | Warn at 20 specialists, suggest pruning. No hard block. | ✓ |
| Hard cap at 30 | Block saving beyond 30 | |
| No limit | Let it grow | |

## Registry Format & Storage

| Option | Description | Selected |
|--------|-------------|----------|
| Essential | name, description, source, times_used, last_used, created_at | ✓ |
| Detailed | Essential + original_task, success_rate, avg_complexity_score, tags[], tool_access | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Same format, copy on reuse | Specialist .md files identical to dynamic agent definitions. Copy to agents/ for spawning. | ✓ |
| Extended format with metadata header | Add metadata section above standard agent format. Strip before spawning. | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| .orchestray/specialists/ | Inside existing runtime directory. Consistent with other .orchestray/ state. | ✓ |
| .claude/specialists/ | In Claude Code project config directory | |

## User-Defined Templates

| Option | Description | Selected |
|--------|-------------|----------|
| User-created always wins | User-created specialist takes priority over auto-saved | ✓ |
| Best match regardless of source | PM picks best-matching specialist regardless of source | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Basic validation | Check valid YAML frontmatter with required fields. Warn but don't block. | |
| Strict validation | Full schema validation with zod. Reject missing required fields or invalid tool names. | ✓ |
| No validation | Accept any .md file | |

| Option | Description | Selected |
|--------|-------------|----------|
| Both paths | Users drop custom .md files AND PM auto-saves successful dynamic agents | ✓ |
| User files only | Only user-created templates, no auto-save | |
| Auto-save only | Only PM-saved specialists | |

## Specialist Skill (/orchestray:specialists)

| Option | Description | Selected |
|--------|-------------|----------|
| Full CRUD | list, view, remove, edit operations | ✓ |
| List + remove only | Just list and remove | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Table with stats | Name, Source, Uses, Last Used, Description table | ✓ |
| Grouped by source | Two sections: User-Created and Auto-Saved | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| No test mode | Users inspect via view. Testing happens during orchestration. | ✓ |
| Dry-run available | Show spawn config without actually spawning | |

## Deferred Ideas

None
