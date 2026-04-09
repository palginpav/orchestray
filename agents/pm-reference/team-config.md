<!-- PM Reference: Loaded by Section Loading Protocol when team config file exists (.orchestray/team-config.json) -->

## 33. Team Configuration, Patterns, and Cost Budgets

Enable team adoption with shared configuration, shared patterns, and spending controls.

### 33A: Team Configuration

Team-wide settings live in `.orchestray/team-config.json` (version-controlled, NOT gitignored).
Individual settings in `.orchestray/config.json` (gitignored) override team settings.

**Config Resolution Order:**
1. Read `.orchestray/team-config.json` (if exists) -- team baseline
2. Read `.orchestray/config.json` (if exists) -- individual overrides
3. Merge: individual values override team values for matching keys
4. Apply defaults for any keys missing from both files

**When to use team-config.json:**
- Team-enforced policies: `security_review: "auto"`, `model_floor: "sonnet"`, `tdd_mode: true`
- Shared CI settings: `ci_command: "npm test"`, `ci_max_retries: 2`
- Cost controls: `daily_cost_limit_usd: 5.00`, `weekly_cost_limit_usd: 20.00`

**Integration with Section 0:**
Replace the single config read in Section 0 with the Team Config Resolution Order above.
Read team-config.json first, then config.json, merge with individual overriding team.

### 33B: Team Patterns

Team-shared patterns live in `.orchestray/team-patterns/` (version-controlled, NOT gitignored).
Local patterns live in `.orchestray/patterns/` (gitignored).

**Pattern Loading (extends Section 22 and Section 30, in tier1-orchestration.md):**
When loading patterns for application during orchestration:
1. Glob `.orchestray/patterns/*.md` -- local patterns (personal)
2. Glob `.orchestray/team-patterns/*.md` -- team patterns (shared)
3. Merge both sets. If a local and team pattern have the same filename, local takes precedence.
4. Apply matching/prioritization as normal (Section 22b, Section 30, in tier1-orchestration.md)

**Pattern Promotion:**
Users can promote a proven local pattern to team-shared via `/orchestray:learn promote <pattern-name>`:
1. Copy `.orchestray/patterns/<name>.md` to `.orchestray/team-patterns/<name>.md`
2. The pattern is now version-controlled and available to all team members
3. Remove the local copy to avoid duplication

### 33C: Cost Budgets

Prevent runaway spending with daily and weekly cost limits.

**Config Settings:**
- `daily_cost_limit_usd`: Maximum daily spend (null = unlimited)
- `weekly_cost_limit_usd`: Maximum weekly spend (null = unlimited)

**Budget Check Protocol (at orchestration start, before Section 13 decomposition, in tier1-orchestration.md):**
1. Read `.orchestray/history/*/events.jsonl` for `orchestration_complete` events
2. Sum `total_cost_usd` for:
   - Today's date -> daily cumulative cost
   - Current week (Monday to now) -> weekly cumulative cost
3. Compare against limits:
   - If daily or weekly at 80%+: warn user "Cost budget: $X.XX / $Y.YY daily (ZZ%). Proceed?"
   - If daily or weekly at 100%+: hard stop. "Daily/weekly cost budget exceeded ($X.XX / $Y.YY). Use `--force` in the prompt to override, or adjust budget via `/orchestray:config`."
4. Log `budget_check` event: `{"type": "budget_check", "daily_used": <N>, "daily_limit": <N>, "weekly_used": <N>, "weekly_limit": <N>}`

**Integration with Section 26 CI/CD Loop (in ci-feedback.md):**
Before each CI fix retry attempt, re-check budget. If budget exceeded during fix loop, stop fixing and report CI failures to user.
