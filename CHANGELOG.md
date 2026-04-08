# Changelog

All notable changes to Orchestray will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.0.4] - 2026-04-08

### Added
- **GitHub Issue integration** — `/orchestray:issue` skill orchestrates directly from GitHub issues via `gh` CLI. PM auto-detects issue URLs in prompts, creates branches, maps labels to templates, optionally comments results back.
- **CI/CD feedback loop** — PM runs `ci_command` after orchestration, auto-fixes failures up to `ci_max_retries` attempts. Delivers verified, merge-ready code.
- **Mid-orchestration checkpoints** — pause between groups to review, modify, or abort. User sees results and controls flow with continue/modify/review/abort commands.
- **Structured plan editing** — modify tasks during preview: `remove`, `model`, `add`, `swap` commands before execution starts.
- **User-authored playbooks** — `.orchestray/playbooks/*.md` files inject project-specific instructions into agent delegation prompts. CRUD via `/orchestray:playbooks`.
- **Correction memory** — PM learns from verify-fix loops. Correction patterns extracted, stored, and applied to prevent repeated mistakes.
- **Cost prediction** — pre-execution cost estimates from historical data, with post-orchestration accuracy tracking.
- **Agent checkpointing** — per-agent state persistence for reliable resume after interruptions.
- **Pattern effectiveness dashboard** — `/orchestray:analytics` now shows pattern applications, correction effectiveness, and learning trends.
- **Team configuration** — `.orchestray/team-config.json` (version-controlled) sets team-wide policies, overrideable by individual config.
- **Team patterns** — `.orchestray/team-patterns/` for shared patterns across team members. `/orchestray:learn promote` copies local patterns to team.
- **Daily/weekly cost budgets** — `daily_cost_limit_usd` and `weekly_cost_limit_usd` with 80% warning and 100% hard stop.
- Model displayed in all agent status messages (before-group, after-agent, checkpoint results)
- 7 new config settings: `ci_command`, `ci_max_retries`, `post_to_issue`, `enable_checkpoints`, `daily_cost_limit_usd`, `weekly_cost_limit_usd`
- 2 new skills: `/orchestray:issue`, `/orchestray:playbooks`
- PM Sections 25-33 (9 new sections)

### Fixed
- Installer now copies `agents/pm-reference/` directory (previously missing for all installed users)
- Complexity hook no longer scores internal Claude Code messages (task-notification, command-name XML)
- KB index auto-reconciles when empty but files exist in subdirectories
- Token usage fallback chain: transcript → event payload → turn-based estimation (fixes $0.0000 analytics)
- History archive structure standardized (mandatory flat layout with events.jsonl)
- config.json created with all 27 defaults during first-run onboarding
- plugin.json version and URLs synced with package.json
- `security-engineer` added to reserved names (was already present)
- PM section reference updated from "Sections 1-15" to "Sections 1-33"

### Changed
- PM prompt expanded from 24 to 34 sections (1,836 → 2,330 lines)
- Config defaults now include all 27 keys (was 17, missing 10 routing/model keys)
- `usage_source` field added to audit events (transcript/event_payload/estimated)
- Session ID tracked in auto-trigger markers for staleness validation
- Pattern loading now searches both local and team-patterns directories
- Cost budget check runs before task decomposition

## [2.0.3] - 2026-04-08

### Added
- **Security Engineer** — 8th core agent with shift-left security analysis (design review + implementation audit)
- Pipeline templates — 7 workflow archetypes (bug fix, new feature, refactor, test, docs, migration, security audit) for consistent task decomposition
- TDD orchestration mode — test-first workflow: architect → tester → developer → reviewer (`tdd_mode` config)
- Adaptive complexity thresholds — self-calibrating orchestration trigger based on historical signals
- Codebase pre-scan — one-time lightweight project overview on first orchestration (`enable_prescan` config)
- Orchestration preview — task graph with cost estimates before execution (`confirm_before_execute` config)
- Regression detection — test baseline before/after orchestration (`enable_regression_check` config)
- Static analysis integration — run linters before reviewer step (`enable_static_analysis` config)
- 5 new specialist templates: performance-engineer, release-engineer, migration-specialist, accessibility-specialist, api-designer
- 7 new config settings: `security_review`, `tdd_mode`, `enable_regression_check`, `enable_prescan`, `enable_static_analysis`, `test_timeout`, `confirm_before_execute`
- PM Section 24: Security Integration Protocol with auto-detection rules and dual invocation modes
- Enhanced progress visibility — structured per-group announcements during orchestration

### Changed
- Reviewer expanded from 5 to 7 review dimensions (added Operability and API Compatibility)
- Developer self-check protocol now runs automatically on every orchestrated task (compile, lint, test, spec verify, diff review)
- PM task decomposition now classifies tasks into archetypes before decomposing
- Installer reads version from package.json instead of hardcoded string

## [2.0.2] - 2026-04-08

### Fixed
- Fix zero-token transcript parsing — cost tracking now reads `entry.message.usage` (Claude Code's actual format)
- Add cache creation token pricing (25% surcharge) to cost estimates
- Fix KB index sync — added `/orchestray:kb reconcile` command to rebuild index from files
- Standardize event field parsing (`event` vs `type`) for backward compatibility in analytics/report skills
- Remove unconditional debug logging from complexity-precheck.js (now gated behind `verbose` config)
- Fix stale auto-trigger.json cleanup (markers older than 5 minutes auto-deleted)
- Fix empty task archives — state directory now properly copied to history on completion

### Added
- `effort` frontmatter field on all 7 agents (pm: high, architect: high, developer: medium, reviewer: medium, debugger: high, tester: medium, documenter: low)
- `max_cost_usd` config setting for per-orchestration budget enforcement
- `turns_used` metric displayed in `/orchestray:analytics` (turns by agent type table)
- PM prompt size reduction — reference material extracted to `agents/pm-reference/` (loaded on-demand)
- This CHANGELOG.md

### Changed
- Consolidated config reads in complexity-precheck.js (single read instead of two)

## [2.0.1] - 2026-04-08

### Added
- Analytics skill (`/orchestray:analytics`) for aggregate performance stats
- Knowledge base skill (`/orchestray:kb`) for cross-session context reuse
- Update skill (`/orchestray:update`) for npm-based updates
- Learn skill (`/orchestray:learn`) for manual pattern extraction
- Specialist templates (security-auditor, database, frontend, devops)
- `turns_used` metric in agent_stop events
- Installer fix for hook merging

### Changed
- Bumped version to 2.0.1
- Improved reviewer severity calibration
- Developer self-check protocol

## [2.0.0] - 2026-04-08

### Added
- Initial release: multi-agent orchestration plugin for Claude Code
- PM agent with 23 orchestration sections
- 7 specialized agents (PM, architect, developer, reviewer, debugger, tester, documenter)
- 10 slash commands for orchestration management
- 6 hook scripts for audit logging and complexity detection
- Smart model routing (Haiku/Sonnet/Opus per subtask complexity)
- Persistent specialist registry
- Pattern extraction and learning
- Agent Teams integration (experimental)
- Knowledge base with TTL-based staleness
- Audit trail with per-agent cost tracking
- File-based state management
