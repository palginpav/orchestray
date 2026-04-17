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

**3-Tier Pattern Model (v2.1.0+).** As of v2.1.0, Orchestray supports three pattern tiers.
This section covers Tiers 1 and 2; Tier 3 is user-global and distinct from this team tier.

| Tier | Location | Scope | Versioned? | How populated |
|------|----------|-------|------------|---------------|
| 1 — project-local | `.orchestray/patterns/` | Per-project | No (gitignored) | PM extraction, curator |
| 2 — team-patterns/ | `.orchestray/team-patterns/` | Per-team / per-repo | Yes (git-tracked) | Manual PR to repo |
| 3 — shared/ | `~/.orchestray/shared/patterns/` | User-global, machine-local | No | `/orchestray:learn share` or curator |

**Tier 2 (team-patterns/) is unchanged in v2.1.0.** It continues to be the git-tracked,
peer-reviewed team tier. Its semantics, promotion flow, and loading behavior are the same as
in v2.0.x. Do NOT confuse it with Tier 3 (shared/):

- `team-patterns/` is git-tracked and lives inside the project repo. It is available to
  all team members who pull the repo. Changes go through a normal PR review cycle.
- `~/.orchestray/shared/` is user-global and machine-local. It is NOT git-tracked and is
  NOT committed to any project repo. It is written by `/orchestray:learn share` (B2 CLI)
  or by the pattern curator (B8). It is only available on the machine where it was written.

**The `/orchestray:learn share` command (v2.1.0 new command) writes to Tier 3, NOT Tier 2.**
If you want to promote a pattern to the git-tracked team tier, open a PR against the project
repo and add the pattern file to `.orchestray/team-patterns/` manually. There is no CLI
shortcut for Tier 2 promotion in v2.1.0 — this is intentional (team patterns require review).

**Pattern Loading (extends Section 22 and Section 30, in tier1-orchestration.md):**
When loading patterns for application during orchestration:
1. Glob `.orchestray/patterns/*.md` -- Tier 1: project-local patterns (personal)
2. Glob `.orchestray/team-patterns/*.md` -- Tier 2: team patterns (git-tracked)
3. Glob `~/.orchestray/shared/patterns/*.md` -- Tier 3: user-global patterns (advisory only, when `federation.shared_dir_enabled: true`)
4. Merge all tiers. On slug collision: Tier 1 wins over Tier 2; Tier 2 wins over Tier 3.
5. Apply matching/prioritization as normal (Section 22b, Section 30, in tier1-orchestration.md).
   Tier 3 patterns carry `source: "shared"` — treat as advisory per §22b-federation.

**Pattern Promotion to team-patterns/ (Tier 2, unchanged):**
Users can add a proven local pattern to the git-tracked team tier by:
1. Copy `.orchestray/patterns/<name>.md` to `.orchestray/team-patterns/<name>.md`
2. Commit the file and open a PR to the project repo for peer review
3. Once merged, the pattern is available to all team members who pull
4. Remove the local copy to avoid duplication (optional — Tier 1 takes precedence anyway)

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
