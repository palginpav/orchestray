# Changelog

All notable changes to Orchestray will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.0.18] - 2026-04-16

### Theme: "Operator ergonomics + honest learning loop + rollback-scaffolding removal"

Track A gives operators first-class mid-flight visibility and control. Track B makes
the pattern learning loop honest. Track C retires the v2.0.17 rollback scaffolding
and collapses duplicated files. Net LOC negative. Test count up.

### Added

- **`/orchestray:watch`** — live-tail poller for the current orchestration. Renders a
  compact agent-status table that refreshes until the orchestration completes or the
  user interrupts.
- **`/orchestray:state` namespace** — four subcommands behind one skill:
  - `peek` — read-only summary of leaked or active state dirs.
  - `gc` — archive or discard leaked state dirs; respects `--keep-days` and `--mode`.
  - `pause` — writes a pause sentinel; blocks further agent spawns between groups.
  - `cancel` — writes a cancel sentinel; triggers clean-abort with state archival.
- **`/orchestray:redo <W-id> [--cascade] [--prompt <file>]`** — re-run a single W-item
  or its full dependent closure. Batch confirmation upfront; no per-item prompts.
- **`/orchestray:run --preview`** — show the decomposition plan and estimated costs before
  execution; accept or abort without spawning any agents.
- **Time-based pattern confidence decay** — `pattern_find` now returns `decayed_confidence`
  and `age_days` alongside raw confidence. Default half-life: 90 days (configurable via
  `pattern_decay.default_half_life_days`); anti-patterns decay at 180 days by default
  via `pattern_decay.category_overrides["anti-pattern"]`. Patterns without `last_applied`
  fall back to `days_since_created`.
- **Counterfactual skip enrichment** — `pattern_record_skip_reason` MCP tool now records
  structured `match_quality` (`strong-match | weak-match | edge-case`) and `skip_category`
  fields alongside free-form prose. Enables retrospective analysis of why patterns were
  not applied.
- **`routing_decision` merged event (Variant D)** — `bin/emit-routing-outcome.js` now
  correlates spawn-side and stop-side data into a single `routing_decision` row per
  agent invocation. `routing_lookup` synthesises these on-the-fly for historical data.
  New consumers should prefer Variant D over the legacy split Variant A/C pair.
- **Anti-pattern pre-spawn advisory gate** — `gate-agent-spawn.js` checks matching
  anti-patterns via `pattern_find` before each `Agent()` spawn and injects advisories
  into `additionalContext`. The `anti_pattern_advisory_shown` audit event fires on each
  injection. Gate is advisory-only (never blocks the spawn); capped at 1 advisory per
  spawn to prevent noise.
- **Sentinel-check `PreToolUse:Agent` hook** (`bin/check-pause-sentinel.js`) — runs
  before each `Agent()` spawn and blocks if a pause or cancel sentinel is present.
  Respects `cancel_grace_seconds` config; exits 0 (allow) / 1 (cancel-abort) / 2 (pause-block).
- **New config blocks**: `state_sentinel` (pause/cancel sentinel settings), `anti_pattern_gate`
  (advisory gate settings), `redo_flow` (cascade depth + commit prefix), `pattern_decay`
  (half-life defaults).
- **New audit events**: `state_pause_set`, `state_pause_resumed`, `state_cancel_requested`,
  `state_cancel_aborted`, `state_gc_run`, `state_gc_discarded`, `anti_pattern_advisory_shown`,
  `pattern_skip_enriched`, `routing_decision`, `w_item_redo_requested`, `config_key_stripped`.
  All use canonical `timestamp`/`type` fields. Documented in `agents/pm-reference/event-schemas.md`.

### Changed

- **`history_scan._normalizeEvent()` now maps `ts → timestamp` symmetrically** with
  the existing `event → type` mapping (FC2). Previously, `orchestration_start` rows
  that used only the legacy `ts` field were silently dropped on the live
  `history_query_events` path. Both legacy fields are now remapped and stripped.
- **`agent-common-protocol.md` is now the single source of the Structured Result schema.**
  Nine agent bodies (architect, developer, reviewer, debugger, tester, refactorer,
  documenter, inventor, security-engineer) replaced their inline JSON schema blocks with
  a short reference to the canonical doc. Net: −190 lines across the nine files.
- **`checkpoints.md` absorbed `agent-checkpointing.md`.** Section 32 (fine-grained agent
  checkpointing for resume) is now a subsection of `checkpoints.md`. The dispatch-table
  row in `agents/pm.md` is collapsed into a single condition covering both interactive
  checkpoints and resume scenarios.
- **`bin/emit-routing-outcome.js`** extended with `MODEL_OUTPUT_CAPS` table,
  `completionVolumeRatio()` helper, and merge logic reading from `routing-pending.jsonl`.
- **`routing_lookup` MCP tool** updated to return `routing_decision` rows preferentially
  from `events.jsonl`; synthesises from historical Variant A + C pairs on-the-fly.
  Synthesised rows carry `synthesised: true`; emitted rows carry `merged: true`.

### Removed

- **`agents/pm.old.md`** — the pre-strip PM prompt committed as a rollback target in
  v2.0.17. Deleted as pre-announced. FC3.
- **`bin/apply-pm-variant.js`** — runtime switcher for `pm_prompt_variant`. Deleted with
  its test file (`tests/apply-pm-variant.test.js`). FC3.
- **`tests/pm-md-prose-strip-replay.test.js`** — tested the deleted flag. Removed. FC3.
- **Config keys `pm_prompt_variant` and `pm_prose_strip`** — stripped from
  `.orchestray/config.json` automatically on first post-upgrade run by
  `bin/post-upgrade-sweep.js` (`runFC3bLegacyKeyStrip`). The strip emits a
  `config_key_stripped` audit event. No operator action required.
- **`agents/pm-reference/agent-checkpointing.md`** — content merged into
  `checkpoints.md §32`. File deleted. Dispatch table updated in `agents/pm.md`.

### Fixed

- **Silent data-loss in `history_query_events` live path** — `orchestration_start` rows
  written with only the legacy `ts` field (not `timestamp`) were silently dropped.
  Fixed in FC2 by extending `_normalizeEvent()` to back-fill `timestamp` from `ts`.

### Post-release refinements

Eight commits landed after the v2.0.18 release commit (bfa17d5) to close audit findings
and harden operational discipline. No new features; no config migration required.

**Audit-directed fixes**

- **cancel-sentinel hook** — `check-pause-sentinel.js` now exits 2 (block) on a cancel
  sentinel, not exit 1 (abort). Previously the wrong exit code bypassed the pause path
  silently. (BUG-2018-01)
- **`pattern_decay` config keys** — corrected the nested shape; keys were being seeded at
  the wrong nesting level, making the configurable half-life values unreachable at runtime.
  (BUG-2018-02, COS-2018-01)
- **`install.js` + `post-upgrade-sweep.js`** — both now seed all four v2.0.18 config blocks
  (`state_sentinel`, `anti_pattern_gate`, `redo_flow`, `pattern_decay`) on fresh install and
  first-run upgrade respectively. Previously these blocks were absent from seeded configs,
  causing silent fallback to hard-coded defaults. (INC-2018-02, INC-2018-03)
- **README / defaults alignment** — `redo_flow` cascade depth and `config_key_seeded` schema
  documentation corrected to match code behaviour. (R2 nits)

**Operational discipline**

- **All 10 core agents**: `maxTurns` raised from 75 → 125 to prevent mid-task exhaustion on
  large W-items (observed root cause of W7 failure during v2.0.18 orchestration).
- **W-item commit-body handoff discipline** — `agents/pm-reference/tier1-orchestration.md`
  now requires a `## Handoff` subsection in every W-item commit body. The subsection records
  files changed, test delta, invariants established, and downstream cues for the next agent
  in sequence. Commit body is the canonical handoff channel; external artifact files are
  supplementary.
- **Worktree failure-mode guidance** — corrected a false claim in `tier1-orchestration.md`
  that `isolation: worktree` is a frontmatter field. Isolation is an `Agent()` tool parameter
  set per-invocation. Added guidance on the stale-base-ref harness limitation and recommended
  fallback to disjoint-file serial execution for long sequential orchestrations.
- **Calibration retrospective** — `ACTUAL.md` for the v2.0.18 phase captures headline metrics,
  per-W-item size calibration verdicts, and the worktree isolation track record.
  `.planning/phases/*/ACTUAL.md` is now excluded from the `.planning/phases/*/` gitignore
  exception so retrospectives are version-tracked.

### Migration — removal of experimental rollback scaffolding

v2.0.17 pre-announced the removal of `pm_prompt_variant` and `pm_prose_strip` for v2.0.18.
This release deletes both.

**Automatic migration:** On first use of Orchestray after upgrading, `bin/post-upgrade-sweep.js`
silently removes these keys from `.orchestray/config.json`. No operator action required.
The removal emits a `config_key_stripped` audit event.

**Manual cleanup (if desired):** Users who previously set `pm_prompt_variant: "fat"` or
toggled `pm_prose_strip` in a custom config can remove those keys; the auto-sweep will
otherwise handle them. No runtime impact.

---

## [2.0.17] - 2026-04-15

### Theme: "Measurement foundation + honest hygiene"

2.0.16 closed the MCP surface and activated enforcement gates; 2.0.17 ships the
context-saving instrumentation, trims the PM token surface, and stages three
opt-in experiments.

Four shipped items:

- **Phase 1 — Measurement harness.** PM-turn usage is now captured alongside
  subagent metrics. `/orchestray:analytics` gains Cache Performance, Cost Delta,
  and Active Experiments sections. Previously, PM-turn token counts were invisible;
  they are now recorded in `agent_metrics.jsonl` and surfaced per-orchestration.
- **Phase 2 — Cache-choreography hygiene.** `agents/pm.md` reorganised into
  Block A (immutable prefix) / breakpoint sentinel / Block B (semi-stable) /
  Block C (tail). Ships as drift-prevention discipline: the measured subagent
  cache-hit ratio over 74 pre-2.0.17 orchestrations was already **0.94** — near
  ceiling — so this is hygiene, not a cost lever.
- **Phase 3 — PM prose strip (~12% lines).** WASTE-tier prose removed from
  `agents/pm.md` (1273 → 1124 lines; inline config JSON, duplicated warnings,
  navigation breadcrumbs). Zero behavioral regressions. Originally targeted 20%;
  the additional PARTIAL pedagogical cuts were held back for safety.
- **Phase 4 — Adaptive verbosity.** Per-agent response-length budgets injected
  into delegation templates. Reviewer floor at 600 tokens; final verify-fix
  reviewer exempt. Prompt-only, no runtime code, default OFF.

Context saving instrumentation shipped. PM cache-hit ratio is now observable but not gated.

### Added

- **PM-turn capture (`bin/capture-pm-turn.js`).** A `Stop`-hook that reads the
  session transcript's last assistant `usage` block and appends a `pm_turn` row
  to `agent_metrics.jsonl`. PM-turn token counts were previously invisible; this
  is the first release where they are recorded. Fail-open; suppressed via
  `ORCHESTRAY_METRICS_DISABLED=1`.
- **`/orchestray:analytics` v2 — three new sections.** Cache Performance (subagent
  and PM cache-hit sparklines), Cost Delta vs frozen v2.0.16 baseline (raw means +
  p50), and Active Experiments. The analytics command now shows whether any
  `v2017_experiments` flags are live and what their current state is.
- **`bin/emit-orchestration-rollup.js` and `bin/_lib/analytics.js`.** Per-orchestration
  rollup computed once on `orchestration_complete`; raw means + p50 stored in
  `orchestration_rollup.jsonl`. Used by the analytics command to generate cost-delta
  and cache-trend views without re-scanning the full event log.
- **`bin/_lib/jsonl-rotate.js`.** Generic JSONL rotation helper shared by the new
  metrics pipeline. Rotates at 50 MB; old files land in
  `.orchestray/metrics/archive/`.
- **`v2017_experiments` config block** with three opt-in flags:
  `prompt_caching`, `pm_prose_strip`, `adaptive_verbosity`. Each defaults `"off"`.
  `pm_prose_strip` is 3-state (`"off" | "shadow" | "on"`); the other two are
  2-state. A shared `global_kill_switch` disables all three with one config edit
  and no session restart.
- **`bin/cache-prefix-lock.js` UserPromptSubmit hook.** Validates that
  `agents/pm.md` Block A is bitwise-stable within a session. On mismatch, emits
  a `prefix_drift` audit event and exits without injecting `additionalContext`
  (fail-open; no hook-side text injection on either path). Enabled when
  `v2017_experiments.prompt_caching` is `"on"`.
- **Opt-in pre-commit guard** (`bin/install-pre-commit-guard.sh`). Rejects commits
  that change pm.md Block A (everything before `<!-- ORCHESTRAY_BLOCK_A_END -->`)
  without a `BLOCK-A: approved` line in the commit message. Never overwrites an
  existing user-managed pre-commit hook. To install: (1) set
  `cache_choreography.pre_commit_guard_enabled: true` in `.orchestray/config.json`;
  (2) run `npx orchestray --pre-commit-guard`.
- **`bin/replay-last-n.sh`** — routing-replay harness for Phase 2 cache-choreography
  regression detection (10 tests in `tests/replay-last-n.test.js`).
- **`bin/apply-pm-variant.js`** — runtime switcher for `pm_prompt_variant`. On `fat`,
  copies `agents/pm.old.md` over `agents/pm.md` with a SHA-256 manual-edit guard,
  `--force` override, and `pm.md.bak` safety backup. Invoked by `install.js` at
  install time and by `post-upgrade-sweep.js` on subsequent sessions via an
  idempotency sentinel (`.pm-variant-applied-2017`).
- **`agents/pm-reference/prompt-caching-protocol.md`** — new Tier-2 file.
  Documents the Block A/B/C caching discipline, the append-only rule for mid-release
  edits, and the pre-commit guard opt-in.
- **`agents/pm.old.md`** — committed verbatim copy of the pre-strip PM prompt.
  Used by `pm_prompt_variant: "fat"` as a rollback target that works for
  plugin-installed users (no git history required). Deleted in v2.0.18 after GA.
- **`pm_prompt_variant` config key** (`"fat" | "lean"`, default `"lean"`). Set
  `"fat"` to load `agents/pm.old.md` instead of the stripped `agents/pm.md`
  without a session restart.
- **`agents/pm-reference/agent-common-protocol.md`** — new shared Tier-2 file
  that consolidates boilerplate repeated across nine non-PM agent bodies. Loaded
  by all nine agents; reduces per-body duplication by ~400 tokens each.
- **Adaptive response-length budgets** in delegation templates. The PM injects a
  `response_budget` line into each agent delegation that scales output to the
  remaining cost margin. Reviewer minimum floor: 600 tokens (prevents quality-signal
  truncation). Final verify-fix reviewer is exempt from budget reduction. Controlled
  by `v2017_experiments.adaptive_verbosity` (default `"off"`).

### Changed

- **`agents/pm.md`: 1273 → 1124 lines (~12% reduction).** WASTE-tier prose removed:
  inline config-defaults JSON (old lines 46–101), duplicated "CRITICAL" warnings
  collapsed, pedagogical anti-pattern prose trimmed, navigation breadcrumbs removed.
  No imperative rule, judgment-call passage, or section anchor was touched. The
  pre-strip prompt is preserved as `agents/pm.old.md`.
- **`agents/pm.md` restructured into Block A / B / C layout.** Stable sections
  (0–11) form Block A; the `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel separates
  them from the semi-stable Block B. Cache-coherent layout; no protocol removed.
- **Section Loading Protocol flipped from advisory to strict.** "When in Doubt,
  Load" replaced by "load only on declared gate" (Tier-2 Loading Discipline). This
  is the folded S2′ benefit delivered as a one-line prompt change; the planned
  `tier2://` MCP resource layer is deferred to v2.0.18.
- **Nine non-PM agent bodies deduped** via `agents/pm-reference/agent-common-protocol.md`.
  Shared boilerplate extracted from: architect, developer, reviewer, debugger,
  tester, refactorer, documenter, inventor, security-engineer. Net aggregate
  reduction: −92 lines across the nine files.
- **`bin/collect-agent-metrics.js` extended** to emit `agent_spawn` rows to
  `agent_metrics.jsonl` and to detect the `orchestration_complete` sentinel for
  triggering rollup. MCP tool count: 12 → 13 (`metrics_query` added).

### Experiments (all default `"off"`, opt-in)

- **`v2017_experiments.prompt_caching`** — enables `bin/cache-prefix-lock.js`
  drift detection on every `UserPromptSubmit`. Monitors Block A stability; never
  modifies context.
- **`v2017_experiments.pm_prose_strip`** — toggles between stripped `agents/pm.md`
  (`"on"`) and the committed rollback target `agents/pm.old.md` (`"fat"` variant).
  The `"shadow"` state generates the lean prompt and logs the diff without serving it.
- **`v2017_experiments.adaptive_verbosity`** — injects per-agent response-length
  budgets into delegation templates. No effect when `"off"`.

### Fixed

- **`isExperimentActive` JSDoc corrected.** The function signature accepts the root
  config object, not the `v2017_experiments` sub-block. JSDoc previously described
  the wrong call convention; callers passing the root config were already correct.
- **Reviewer-budget floor (≥ 600 tokens) prevents quality-signal truncation.** When
  adaptive verbosity is active, reviewers were at risk of hitting a budget so low
  their output would be meaningless. The floor ensures minimum viable reviewer output
  regardless of cost margin.

### Known gaps / deferred to 2.0.18

- **Measured cost delta.** Instrumentation ships in this release; a post-deployment
  window will produce the numbers (mean first-turn PM input tokens, median orch
  cost delta, subagent cache-hit floor) in a future release.
- **`CLAUDE.md` operational split.** `CLAUDE.md` is gitignored; the split cannot
  ship in a `release:` commit. Deferred pending user decision on
  template-materialisation approach.
- **JIT Tier-2 `orchestray:tier2://` MCP resource.** S2 proper is deferred;
  S2′ strict-dispatch flip ships in this release (see Changed above).

### Migration

Fully backwards-compatible. All new flags default `"off"`.

`post-upgrade-sweep.js` seeds the `v2017_experiments` block and the
`adaptive_verbosity` config block on first 2.0.17 run. On 2.0.16+, the sweep
also seeds `cache_choreography` and any missing `pm_prompt_variant` key.
Existing `.orchestray/config.json` files are extended, not rewritten.

Rollback without a re-release: set `v2017_experiments.global_kill_switch: true`
to disable all three behavior flags in under 30 seconds with no session restart.
To restore the pre-strip PM prompt, set `pm_prompt_variant: "fat"` — reads from
the committed `agents/pm.old.md` artifact; no git history required.

On 2.0.17+, the `post-upgrade-sweep.js` sweep seeds: `v2017_experiments` block
(all flags `"off"`), `adaptive_verbosity` config block, `cache_choreography`
block, and `pm_prompt_variant: "lean"`.

### Tests

+155 new tests across Phases 2/3/4 + post-signoff scope expansion (apply-pm-variant:
12 tests, replay-last-n: 10 tests) + 10 contract tests for `isExperimentActive` +
2 Round-1 fix tests (F014 + F019) = **1287 total**.

---

## [2.0.16] - 2026-04-15

### Theme: "Close the deferred gates"

2.0.15 built the safety scaffolding; 2.0.16 makes it enforce. Three new MCP
tools (`routing_lookup`, `cost_budget_reserve`, `pattern_deprecate`) give agents
direct observability into routing decisions, the ability to pre-reserve budget
before a parallel spawn, and a way to retire stale patterns; a new
`orchestration://` read-only resource exposes live and archived orchestration
state to any MCP client; `pattern_record_application` enforcement advances to
`hook-strict` by default — second spawns are blocked until the PM records its
pattern decision; `cost_budget_enforcement.hard_block` defaults to `true` for
operators who have enabled budget enforcement; the `cost_budget` PreToolUse gate
ships (default disabled, flip-to-enable in one config line); `max_per_task` rate
limits activate for `ask_user`, `kb_write`, and `pattern_record_application`;
reservation ledger GC keeps `cost-reservations.jsonl` bounded; the reservation
TTL is now configurable; the routing gate auto-seeds on first miss instead of
hard-blocking; and an `effort` multiplier flows into cost projection. A shared
cost-helpers library consolidates previously duplicated pricing logic.

### Added

- **`routing_lookup` MCP tool.** Query `.orchestray/state/routing.jsonl` by
  `orchestration_id`, `task_id`, or `agent_type`. Results are capped at 500
  matches; the response includes `total` and `truncated` fields so callers know
  when the cap was hit. MCP tool count is now 11 (was 9 in 2.0.15).
- **`cost_budget_reserve` MCP tool.** Pre-reserve an estimated spawn cost before
  launching a parallel agent. Appends a `cost_reservation` record to
  `.orchestray/state/cost-reservations.jsonl` with a 30-minute TTL and returns
  the projected cost. Accepts an optional `reservation_id` for idempotent
  re-reservation. Accepts any `agent_type` string (not limited to built-in roles),
  so dynamic specialist agents can reserve budget.
- **`orchestration://` MCP resource scheme.** Read-only resource exposing live
  orchestration state to any MCP client:
  - `orchestray:orchestration://current` — merged view of
    `.orchestray/state/orchestration.md` and
    `.orchestray/audit/current-orchestration.json` (phase, group, task IDs,
    pending-fix list).
  - `orchestray:orchestration://current/tasks/<task_id>` — per-task markdown file
    from `.orchestray/state/tasks/`.
  - `orchestray:orchestration://current/routing` — full `routing.jsonl` for the
    active orchestration.
  - `orchestray:orchestration://current/checkpoints` — full
    `mcp-checkpoint.jsonl` for the active orchestration.
  - **Historical URI lookup.** `orchestray:orchestration://<orch-id>` exposes the
    checkpoint ledger for any archived orchestration by ID. The `list()` inventory
    includes the 5 most recent archived orchestration IDs alongside `current`.
- **`pattern_deprecate` MCP tool.** Mark a pattern as deprecated so it is excluded
  from `pattern_find` results. Seeded enabled on fresh installs and backfilled on
  upgrade. MCP tool count is now 12 (was 11).
- **Reservation ledger GC.** Expired reservation rows are swept out of
  `cost-reservations.jsonl` opportunistically on each new `cost_budget_reserve`
  call and via the post-upgrade sweep on first startup after upgrading. The ledger
  no longer accumulates indefinitely.
- **`cost_budget_reserve.ttl_minutes` config key** (default: 30, range: 1–1440).
  The 30-minute reservation TTL was previously hardcoded; it is now configurable
  under `mcp_server.cost_budget_reserve.ttl_minutes` in `.orchestray/config.json`.
- **`routing_gate.auto_seed_on_miss` config key** (default: `true`). When the
  routing gate encounters an `Agent()` spawn with no matching routing entry, it now
  synthesizes an entry, emits a stderr warning, and allows the spawn — instead of
  hard-blocking. This eliminates gate-blocks caused by routing-table gaps without
  requiring manual config edits. Set `routing_gate.auto_seed_on_miss: false` to
  restore the previous hard-block behavior.
- **`bin/gate-cost-budget.js` PreToolUse:Agent hook.** Runs before
  `gate-agent-spawn.js` on every `Agent()`, `Explore()`, and `Task()` spawn.
  Sums accumulated session spend (including unexpired reservations) plus the
  projected spawn cost and compares against `max_cost_usd` and
  `daily_cost_limit_usd` caps. Default behavior: disabled. Opt in via
  `cost_budget_enforcement.enabled: true` in `.orchestray/config.json`.
- **`bin/mcp-server/lib/cost-helpers.js` shared pricing library.** Consolidates
  `BUILTIN_PRICING_TABLE`, `DEFAULT_TOKEN_ESTIMATES`, `getRatesForTier`, and
  `readCostCaps` into one import shared by `cost_budget_check`,
  `cost_budget_reserve`, and `gate-cost-budget.js`, eliminating three-way drift
  when Anthropic updates prices.
- **`hook-strict` enforcement value for `pattern_record_application`.** The
  per-tool enforcement enum now accepts `"hook-strict"` as a blocking mode: on a
  second-or-later `Agent()` spawn within an orchestration, the gate blocks if
  neither `pattern_record_application` nor `pattern_record_skip_reason` appears in
  the orchestration's audit trail. First-spawn carve-out and kill-switch bypass are
  retained. `"hook-strict"` is now the default (see Changed).
- **`max_per_task` rate limits for `ask_user`, `kb_write`, and
  `pattern_record_application`.** Each tool now tracks per-`(orchestration_id,
  task_id)` call counts in `.orchestray/state/mcp-tool-counts.jsonl`. When a
  tool's call count reaches `max_per_task` (default: 20), subsequent calls return
  a rate-limit error for that task. Configurable per-tool under
  `mcp_server.max_per_task` in `.orchestray/config.json`.
- **`cost_budget_enforcement` config block.** New top-level config block with two
  keys: `enabled` (default `false`) and `hard_block` (default `true`). When
  `enabled: true` and `hard_block: true`, the cost gate blocks the spawn with
  exit 2 on breach. Set `hard_block: false` to warn to stderr only and allow
  the spawn.
- **`effort` multiplier in `cost_budget_check` cost projection.** When an `effort`
  level (`low`, `medium`, `high`, `max`) is supplied, the projected token estimate
  is scaled by the configured multiplier before comparing against caps.
- **Reservation records count toward accumulated cost.** Unexpired entries in
  `.orchestray/state/cost-reservations.jsonl` are summed into the
  `readAccumulatedCost` total used by both `cost_budget_check` and
  `gate-cost-budget.js`, so a parallel spawn that already has a reservation is
  counted before the next spawn is evaluated.
- **Structured hook output on deny decisions.** `gate-cost-budget.js` and the
  `hook-strict` deny path in `gate-agent-spawn.js` now emit a
  `hookSpecificOutput` JSON object on stdout (with `hookEventName: "PreToolUse"`)
  per the Claude Code PreToolUse protocol, in addition to the stderr message and
  exit 2. This gives downstream tooling a machine-readable deny reason.

### Changed

- **MCP tool count: 9 → 12.** `routing_lookup`, `cost_budget_reserve`, and
  `pattern_deprecate` are the three new tools.
- **MCP resource scheme count: 3 → 4.** `orchestration://` joins `kb://`,
  `history://`, and `pattern://`.
- **`pattern_record_application` default enforcement changed to `hook-strict`.**
  The second-or-later `Agent()` spawn within an orchestration is now blocked
  (exit 2) by default if the PM has not called `pattern_record_application` or
  `pattern_record_skip_reason` since the previous spawn. The previous default was
  `hook-warn` (advisory only, spawn always proceeded). Rollback: set
  `mcp_enforcement.pattern_record_application: "hook-warn"` in
  `.orchestray/config.json`. Existing configs with an explicit value for this key
  are preserved unchanged.
- **`cost_budget_enforcement.hard_block` default changed to `true`.** When
  `cost_budget_enforcement.enabled: true`, a budget breach now blocks the spawn
  (exit 2) by default instead of warning only. This only affects operators who
  have explicitly opted into budget enforcement — the gate remains disabled by
  default (`cost_budget_enforcement.enabled: false`).
- **`tool-counts.js` rate-limit API split into `checkLimit` + `recordSuccess`.**
  The call counter now increments only on a successful tool outcome (after the
  handler returns without error), not on every invocation attempt. Timeouts and
  validation errors no longer consume quota.
- **Reservation ledger writes are atomic.** `cost_budget_reserve` uses the
  project's `atomicAppendJsonl` primitive (same as `gate-agent-spawn.js`)
  instead of a bare `appendFileSync`, preventing line interleave under concurrent
  writes.
- **Resource-layer excerpt hardening.** `kb_resource` and `pattern_resource`
  excerpts are now capped at 80 characters and stripped of markdown-special
  characters before being returned to the client — the same sanitisation applied
  to `kb_search` and `pattern_find` tool results in 2.0.15. Closes the
  prompt-injection surface symmetrically at the resource layer.

### Fixed

- **Cost-budget reservations are now consumed by checks and the spawn gate.**
  Previously, `cost_budget_reserve` wrote to `cost-reservations.jsonl` but no
  code path ever read that file. Both `cost_budget_check` and `gate-cost-budget.js`
  now sum unexpired reservations into the accumulated-cost total before comparing
  against caps.
- **Rate-limit counter fails closed on oversized ledger.** When
  `mcp-tool-counts.jsonl` exceeds 1 MB, the counter now returns
  `{exceeded: true}` (fail-closed) rather than returning an empty list that made
  every tool appear to have zero calls, effectively disabling enforcement.
- **Deterministic result ordering in `pattern_find` and
  `history_find_similar_tasks`.** Result order is now stable across Node.js
  versions via a secondary sort on tied scores. Regression tests added.
- **`missingRequiredToolsFromRows` empty-array contract.** An edge case where
  a missing-tools check returned an incorrect result on empty input was corrected.
  Regression test added.
- **`pattern_record_skip_reason` audit events use the correct orchestration ID in
  the recovery path.** Previously the event could carry a stale filesystem-cached
  ID instead of the one supplied in the tool input. Regression test added.
- **`pattern_record_skip_reason` is included in the PostToolUse checkpoint
  matcher.** Skip-reason calls are now audited consistently with the other MCP
  tools. Regression test added.
- **`record-pattern-skip.js` emits a stderr warning when the 2 MB size guard
  triggers.** Previously, when `events.jsonl` exceeded 2 MB, the guard engaged
  silently. Operators now see a named warning identifying the orchestration.
  Regression test added.
- **`routing_lookup` results are bounded at 500 matches** with `total` and
  `truncated` fields. The tool description and the actual result set now agree.
- **`orchestration://` reads and the Stage B post-decomposition check in
  `gate-agent-spawn.js` cap `events.jsonl` reads at 2 MB**, preventing a hook
  timeout on projects with a large audit trail.
- **`cost_budget_reserve` accepts dynamic specialist `agent_type` values.** The
  schema now accepts any string of 1–64 characters instead of the fixed
  `AGENT_ROLES` enum, consistent with `cost_budget_check`.
- **`cost_budget_reserve` honors the optional `reservation_id` input for
  idempotent re-reservation.** Supplying the same `reservation_id` twice returns
  the existing record without appending a duplicate row.

### Security

- **Resource-layer excerpt hardening closes a prompt-injection surface in
  `kb_resource` and `pattern_resource`.** Symmetric to the 2.0.15 tool-layer fix
  for `kb_search` and `pattern_find`.
- **Rate-limit counter fails closed on ledger oversize**, preventing a misbehaving
  agent loop (or a deliberate padding attack) from bypassing `max_per_task`
  enforcement by inflating the ledger past the read threshold.

### Upgrade notes

- **MCP tool count is now 12** (was 9 in 2.0.15). `routing_lookup`,
  `cost_budget_reserve`, and `pattern_deprecate` are seeded enabled on fresh
  installs. Existing installs receive all three via the post-upgrade sweep on the
  first `UserPromptSubmit` after upgrading.
- **`max_per_task` defaults apply immediately to existing installs.** The upgrade
  sweep seeds `max_per_task: 20` for `ask_user`, `kb_write`, and
  `pattern_record_application` in `.orchestray/config.json` on first startup
  after upgrading. Any task that calls one of these tools more than 20 times will
  now receive a rate-limit error. Raise the limit under
  `mcp_server.max_per_task.<tool_name>` in `.orchestray/config.json` if needed.
- **Hook-strict default flip is a behavioral change.** The
  `pattern_record_application` enforcement mode now defaults to `"hook-strict"`.
  This means any second-or-later `Agent()` spawn is hard-blocked (exit 2) if the
  PM has not called `mcp__orchestray__pattern_record_application` or
  `mcp__orchestray__pattern_record_skip_reason` since the last spawn. This ships
  without prior production field data — legitimate orchestrations may be blocked
  if the PM agent misses the required protocol step. **Rollback**: set
  `mcp_enforcement.pattern_record_application: "hook-warn"` in
  `.orchestray/config.json` to restore advisory-only behavior immediately, without
  a session restart. To gauge false-block rate, monitor `events.jsonl` for rows
  with `type: mcp_checkpoint_missing` and `phase: post-decomposition`.
- **Routing-gate auto-seed is on by default.** Previously, an unregistered
  `Agent()` spawn (no matching entry in `routing.jsonl`) produced a hard block
  (exit 2). Now the gate synthesizes an entry, logs a stderr warning, and allows
  the spawn. If you relied on the gate to hard-block unregistered spawns, set
  `routing_gate.auto_seed_on_miss: false` in `.orchestray/config.json`. No action
  needed otherwise.
- **`cost_budget_enforcement` ships disabled.** Opt in via
  `.orchestray/config.json`:
  ```json
  {
    "cost_budget_enforcement": { "enabled": true }
  }
  ```
  With `enabled: true`, the gate now blocks spawns on budget breach by default
  (`hard_block` defaults to `true` in 2.0.16). To warn only without blocking, set
  `hard_block: false` explicitly.
- **`cost_budget_reserve.ttl_minutes` now configurable.** The 30-minute default
  is unchanged; add `mcp_server.cost_budget_reserve.ttl_minutes` to your config
  to override.
- **Reservations now count toward projected cost.** If you have existing callers
  of `cost_budget_reserve` (none expected — the tool shipped in 2.0.16), their
  unexpired reservations will now affect the spend total returned by
  `cost_budget_check`.

### Tests

1041. No skipped, no todo.

---

## [2.0.15] - 2026-04-15

### Theme: "Harden what shipped in 2.0.14"

Correctness fixes across the Read cache-replay shield and the `cost_budget_check`
tool, a new `kb_write` MCP tool that eliminates KB index drift, prompt-injection
hardening on tool result excerpts, a more forgiving routing-gate match, and the
always-on pattern advisory.

### Added

- **`kb_write` MCP tool.** Atomically writes a KB artifact file and updates
  `.orchestray/kb/index.json` under a single exclusive lock. Fixes the long-standing
  drift where KB directories accumulated artifact files that were never registered in
  the index. Seeded enabled on fresh installs and backfilled automatically on upgrade.
  MCP tool count is now 9 (was 8 in 2.0.14).
- **Data-quality audit events.** When a pattern file is skipped because it lacks
  frontmatter, an `mcp_data_quality` event is now appended to `events.jsonl` alongside
  the existing stderr warning, so data-quality incidents are observable in post-run
  analysis.
- **`hook-warn` and `hook-strict` enforcement values.** The per-tool enforcement enum
  under `mcp_enforcement` now accepts `"hook-warn"` (always-on advisory) and
  `"hook-strict"` (opt-in blocking) in addition to `"hook"`, `"prompt"`, and `"allow"`.

### Changed

- **`cost_budget_check` now includes accumulated session spend.** Cap comparisons
  (`would_exceed_max_cost_usd`, `would_exceed_daily_cost_limit_usd`,
  `would_exceed_weekly_cost_limit_usd`) now sum prior `agent_stop` costs for the given
  `orchestration_id` before comparing against caps. Results will be more conservative
  than in 2.0.14 — that is the correct behaviour.
- **Tool result excerpts are sanitised.** Excerpts returned by `kb_search` and
  `pattern_find` are capped at 80 characters and stripped of markdown-special
  characters before inclusion, closing a prompt-injection surface.
- **`history_query_events` `agent_role` is now enum-validated.** Typos previously
  returned zero results silently; they now produce a validation error.
- **Routing gate matches on task identity.** The `PreToolUse:Agent` gate now matches
  spawns on `(task_id, agent_type)` — either supplied explicitly or derived from the
  leading `TASK-ID` token of the description — rather than requiring exact description
  text. Description drift no longer blocks valid spawns.
- **Pattern advisory is always on.** The `pattern_record_application` advisory emits
  regardless of `mcp_enforcement` config value. Previously suppressed when the config
  value was `"allow"`; now only the blocking-gate variant (planned for a future
  release) is suppressed by `"allow"`.
- **Server version is sourced from `package.json`.** `SERVER_VERSION` now reads from
  the package manifest at load time rather than a hardcoded string, eliminating drift
  on version bumps.

### Fixed

- **Read cache-replay shield (R14) — path normalisation.** A file accessed via a
  relative path and again via its absolute-path equivalent within the same session is
  now correctly recognised as the same file and deduplicated.
- **Read cache-replay shield (R14) — missing-file handling.** Reading a path that
  does not exist no longer caches a denial sentinel that could incorrectly block the
  same path once the file came into existence.
- **Read cache-replay shield (R14) — PDF page-range reads.** Repeated reads of the
  same PDF with different `pages` selections are no longer mis-identified as cache
  replays of a full-file read.
- **`pattern_record_skip_reason` audit gap.** The `PostToolUse` hook matcher now
  includes this tool, so skip-reason calls are audited consistently with the other
  MCP tools.
- **MCP tool audit event source of truth.** MCP tool audit events now prefer the
  `orchestration_id` supplied in the tool input over the filesystem-cached value,
  eliminating a corner case where the two could diverge during recovery.
- **`pattern_find` and `history_find_similar_tasks` result ordering.** Result order
  is now deterministic across Node.js versions (stable secondary sort on tied scores).
- **Upgrade-sweep migrations preserve newline shape.** Files rewritten by the
  upgrade sweep now retain the exact trailing-newline presence of the original.
- **Pattern-skip size-guard bypass is now observable.** When the `events.jsonl` scan
  is skipped because the file exceeds the 2 MB guard, an operator warning naming the
  orchestration is written to stderr instead of silently proceeding.
- **`cost_budget_check` input schema.** The `agent_type` field is now present on the
  input schema (previously documented but missing).

### Security

- **Prompt-injection hardening on tool excerpts.** `kb_search` and `pattern_find`
  excerpts are capped at 80 characters and markdown-special characters stripped before
  returning them, reducing the attack surface exposed by untrusted KB and pattern file
  content.
- **Session-ID sanitiser uses an allow-list.** The shield session-state path no longer
  accepts arbitrary session-ID characters; only a safe allow-list is permitted,
  preventing path-traversal via crafted IDs.
- **`kill_switch_reason` required when the kill switch is active.** Setting
  `mcp_enforcement.global_kill_switch: true` now requires a non-empty
  `kill_switch_reason` string. Blast-radius rationale is captured at the config level
  rather than reconstructed from logs.

### Deferred to a future release

- Default-flip of the `pattern_record_application` advisory to blocking mode
  (conditional on a follow-up false-positive review).
- An `orchestration://` read-only resource for live orchestration state.
- A `routing_lookup` MCP tool (superseded for this release by the routing-gate match
  relaxation above).
- A `cost_budget_reserve` MCP tool for pre-spawn budget holds.
- Activation of the `ask_user` `max_per_task` rate limit.

### Documentation

- The 2.0.14 entry referenced an incorrect path for the R14 shield session-state file.
  The actual path is `.orchestray/state/.shield-session-{session_id}.json`. The 2.0.14
  entry has been corrected in place.

### Upgrade notes

- **MCP tool count is now 9** (was 8). The new `kb_write` tool is seeded enabled on
  fresh installs and backfilled automatically by the upgrade sweep on existing installs.
- **`cost_budget_check` results will be more conservative.** The new accumulated-cost
  comparison is the intended behaviour; a session near its cap will now be flagged
  correctly.
- **Pattern advisory prints on every orchestration.** If you previously suppressed it
  with `mcp_enforcement.pattern_record_application: "allow"`, you will now see
  warn-level output regardless. The `"allow"` setting still suppresses the blocking
  gate (not yet enabled in this release).
- **R14 dedup now treats relative and absolute paths as equivalent.** If a workflow
  relied on re-reading the same file via two different path spellings within a session,
  the second read will now be deduplicated.
- **`global_kill_switch: true` now requires `kill_switch_reason`.** If you have the
  kill switch enabled in `.orchestray/config.json`, add a non-empty
  `kill_switch_reason` field; otherwise validation will fail on next config load.

Tests: 847 → 931.

---

## [2.0.14] - 2026-04-11

### Theme: "Close the §22c False-Positive Path"

Unblock the §22c advisory→blocking transition by closing the legitimate-skip signal
gap, add pre-spawn cost projection, and cut the two largest unchecked context taxes
(post-decision `pattern_find` ambiguity and `Read` cache-replay). Four work items
ship; one (§22c default flip) is explicitly deferred to 2.0.15 pending production
data from the N≥20 prerequisite installed here.

### Added

- **W1 — `pattern_record_skip_reason` MCP tool.** New tool at
  `bin/mcp-server/tools/pattern_record_skip_reason.js`, registered in
  `bin/mcp-server/server.js` TOOL_TABLE and `bin/mcp-server/lib/schemas.js`.
  When `pattern_find` returns results that do not shape a decomposition, the PM
  calls this tool (exactly once) instead of remaining silent — producing an
  auditable `mcp_tool_call` row with `tool: "pattern_record_skip_reason"`,
  `orchestration_id`, and a four-value `reason` enum (`all-irrelevant`,
  `all-low-confidence`, `all-stale`, `other`; `other` requires a mandatory `note`).
  `bin/record-pattern-skip.js` no longer emits the `pattern_record_skipped` advisory
  when a skip-reason call exists for the same `orchestration_id` in the pre-compact
  window — the skip is structurally accounted for. The tool is seeded in the
  `mcp_server.tools` enable map with default `true` on fresh installs (`bin/install.js`).

- **W2 — §22b probe-side prompt hardening.**
  `agents/pm-reference/tier1-orchestration.md` §22b now contains an explicit
  "MUST call EITHER `pattern_record_application` (one or more times) OR
  `pattern_record_skip_reason` (exactly once)" directive — not a suggestion.
  Fallback marker path documented for when the MCP tool is config-disabled: the PM
  writes `pattern_record_skipped_reason: <reason>` to
  `.orchestray/state/orchestration.md`. W2 is the sole owner of this fallback path.
  `agents/pm-reference/pattern-extraction.md` cross-references §22b so the two files
  do not drift. A golden-file test (`tests/pm-prompt-22b-hardening.test.js`) asserts
  the `MUST call either` directive and the fallback marker format are both present.

- **W3 — `cost_budget_check` MCP tool + pricing-table config seed.** New tool at
  `bin/mcp-server/tools/cost_budget_check.js`, registered after W1's TOOL_TABLE
  delta. Accepts `{agent_type, model, effort?, estimated_input_tokens?,
  estimated_output_tokens?}`; when token counts are omitted it computes defaults from
  historical `agent_spawn` averages. Returns `would_exceed_max_cost_usd`,
  `would_exceed_daily_cost_limit_usd`, estimated spawn cost, and warnings when no
  cap is configured. A centralized pricing table at
  `mcp_server.cost_budget_check.pricing_table` in `.orchestray/config.json` is seeded
  on fresh installs (`bin/install.js`): Haiku $1/$5, Sonnet $3/$15, Opus $5/$25, with
  a `last_verified` date for drift detection. `bin/collect-agent-metrics.js` now reads
  from the same config-resolver rather than carrying its own constants (single source
  of truth; eliminates the prior drift point flagged in CLAUDE.md). A new sub-operation
  in `bin/post-upgrade-sweep.js` backfills the pricing table block for pre-2.0.14
  installs, gated by an idempotent sentinel (same shape as 2.0.13's W8+W11 sub-ops).
  Schema additions in `bin/_lib/config-schema.js`.

- **W4 — CATRC: Cache-Aware Tool Result Compaction — new `bin/context-shield.js`
  hook + R14 rule.** Net-new infrastructure: `bin/context-shield.js` (new
  `PreToolUse:Read` hook script), `bin/_lib/shield-rules.js` (R14 rule module),
  `bin/_lib/shield-session-cache.js` (session-scoped manifest helper). On a second
  `Read` of the same `(file_path, mtime, size)` triple within a session with no
  `offset`/`limit` change, the hook returns `permissionDecision: "deny"` with a
  one-line hint pointing to the prior turn; re-reads with an explicit offset/limit or
  after a file-on-disk change are always `allow`-ed. `hooks/hooks.json` now contains
  a `PreToolUse` entry for the `Read` tool invoking `bin/context-shield.js`.
  Session-scoped state at `.orchestray/state/.shield-session-{session_id}.json`
  (corrected in 2.0.15; prior entry incorrectly stated `shield-session/{id}-reads.jsonl`)
  is archived by `bin/pre-compact-archive.js` at session end. New config flag
  `shield.r14_dedup_reads.enabled` (default `true`) seeded by `bin/install.js`;
  set to `false` to disable the rule without removing the hook. Schema addition in
  `bin/_lib/config-schema.js`.

### Deferred to 2.0.15

**§22c `pattern_record_application` advisory→blocking transition.** Deferred because
T1's pre-2.0.14 data snapshot showed N=3 non-skipped `pattern_find` rows — well below
the N≥20 prerequisite for a statistically meaningful false-positive analysis. 2.0.14
closes the signal gap (W1 legitimate-skip tool + W2 MUST directive) so the 2.0.15
scoping task has real K/F inputs to analyze. The transition will ship in 2.0.15 only
if the §22c confidence-feedback analysis over the post-2.0.14 audit window shows a
false-positive rate below a threshold to be set in 2.0.15's DESIGN.md.
Machine-readable status (historical, from the 2.0.14 design phase):
`transition_status: "no-go-data"`.

Also deferred:
- Any hook gate on `PreToolUse:Agent` enforcing `cost_budget_check` results (W3 ships
  advisory only; hard enforcement is 2.0.15 per T3 Part D forward contract)
- `mcp_enforcement.pattern_record_application: "hook-strict"` enum value (2.0.15)
- R1–R13 shield rules (T2 asserted these existed in v2.0.11; T5-r1 confirmed they do
  not; 2.0.14 ships R14 as the first and only rule in the new scaffold)
- Dedup across `Grep` or `Bash` tool calls (R14 is `Read`-only)

### Upgrade caveat / Recovery notes

**Automatic pricing-table migration on first 2.0.14 use.** The first
`UserPromptSubmit` after upgrade fires `bin/post-upgrade-sweep.js`, which now
includes a third sub-operation (W3) that backfills the
`mcp_server.cost_budget_check.pricing_table` block into `.orchestray/config.json` if
absent. Idempotent, sentineled at `.orchestray/state/.pricing-table-migrated-2014`,
fail-open. Manual rollback: delete the sentinel to re-run, or edit the config block
directly.

**Context-shield (W4) is on by default.** If re-reads that Claude Code previously
allowed start returning `deny` unexpectedly, set `shield.r14_dedup_reads.enabled: false`
in `.orchestray/config.json` to disable R14 without removing the hook. No session
restart required.

**MCP tool count is now 8** (was 6 in 2.0.13). New tools: `pattern_record_skip_reason`
and `cost_budget_check`. Both are seeded `enabled: true` in the `mcp_server.tools`
map on fresh installs; the upgrade sweep backfills them for existing installs.

**`bin/collect-agent-metrics.js` pricing is now config-driven.** If you had a
custom pricing override in the script directly (not standard usage but possible), the
script now reads from `mcp_server.cost_budget_check.pricing_table` in
`.orchestray/config.json`. Edit the config file to update pricing.

**Tested against Claude Code 2.1.59.**

Tests: 714 → 847 (+133 across W1/W2/W3/W4).

---

## [2.0.13] - 2026-04-11

### Theme: "Close the Loop"

Close 2.0.12's learning loop: the hook-enforced MCP surface now actually fires,
the gate's own blocking condition is self-consistent, and operational state files
stop growing unbounded.

### Added

- **W4 — Dispatch-name allowlist drift regression test.** `tests/gate-agent-spawn.test.js`
  now imports the `AGENT_DISPATCH_ALLOWLIST` and `SKIP_ALLOWLIST` constants from
  `bin/gate-agent-spawn.js` via regex and compares them to an embedded known-good
  manifest. When a future Claude Code version adds or removes a dispatch name, the
  test fails loudly with a message naming the three files to update in tandem (the
  code constant, the test manifest, `CLAUDE.md` if applicable). Closes 2.0.12 R5
  follow-up.

- **W5 — Configurable `events.jsonl` scan cap.** `bin/collect-agent-metrics.js`
  no longer hardcodes its scan threshold. New precedence chain:
  `ORCHESTRAY_MAX_EVENTS_BYTES` env var → `.orchestray/config.json`
  `audit.max_events_bytes_for_scan` → built-in default (materially larger than
  the 2.0.12 hardcode). The cap is read at hook-script load time per invocation —
  no session restart required to change it. New `audit` section added to
  `bin/_lib/config-schema.js` with validation.

- **W6 — Durable `events.jsonl` rotation with sentinel state machine.**
  `bin/_lib/events-rotate.js` is the new helper. At orchestration completion the
  PM cleanup sequence (tier1-orchestration.md Section 15, step 3) invokes
  `rotateEventsForOrchestration` which (a) filters the live `events.jsonl` to rows
  matching the current orchestration ID, (b) writes them to
  `.orchestray/history/<orch-id>/events.jsonl`, (c) atomically replaces the live
  file via a rename-dance preserving rows from other orchestrations. A three-state
  sentinel at `.orchestray/state/.events-rotation-<orch-id>.sentinel` makes the
  sequence crash-safe: `"started"` → restart from filter; `"archived"` → skip to
  truncate; `"truncated"` → delete sentinel only. `fs.truncateSync` is forbidden;
  a regression test asserts zero hits. Reader side (`history_scan.js`,
  `history_query_events`) is unchanged — archived rows remain queryable
  transparently.

- **W3 — `mcp_checkpoint_missing` audit event (promoted from RESERVED to
  IMPLEMENTED).** `bin/gate-agent-spawn.js` now emits a `mcp_checkpoint_missing`
  event to `events.jsonl` on every gate block. New `phase_mismatch` boolean field
  distinguishes genuine absence (`false`) from BUG-D phase-mismatch (`true`) — the
  latter is reachable when poisoned-phase rows coexist with genuine absences in the
  same orchestration. `agents/pm-reference/event-schemas.md` documents the
  IMPLEMENTED shape. Fails open on emission failure — the event write cannot mask a
  gate block.

- **W7 — Kill-switch health signal + `kill_switch_activated`/`kill_switch_deactivated`
  events.** `/orchestray:analytics` gains a Health Signals section that reads
  `.orchestray/config.json` and emits a bold warning when
  `mcp_enforcement.global_kill_switch === true`; it also scans recent `events.jsonl`
  for unpaired activation events. `/orchestray:config` set paths emit
  `kill_switch_activated`/`kill_switch_deactivated` events to `events.jsonl` (via
  `bin/emit-kill-switch-event.js`, a new CLI wrapper) whenever the switch value
  actually changes (no-op flips do not emit). Two new event shapes documented in
  `event-schemas.md`.

- **W8 + W11 — Post-upgrade sweep.** New `bin/post-upgrade-sweep.js` runs as a
  sibling under the existing `UserPromptSubmit` hook. Session-scoped lock at
  `/tmp/orchestray-sweep-<session>.lock` gives once-per-session fast-path;
  per-operation sentinels at `.orchestray/state/.config-migrated-2013` and
  `.orchestray/state/.mcp-checkpoint-migrated-2013` give once-per-upgrade
  semantics. Two sub-operations: (a) **W8** — additive migration of
  `.orchestray/config.json` to add the `mcp_enforcement` block if missing (preserves
  all other keys including non-schema `_note` fields); (b) **W11** — scan of
  `.orchestray/state/mcp-checkpoint.jsonl` to flip rows with
  `phase: 'post-decomposition'` that were poisoned by 2.0.12's BUG-B, based on a
  conservative timestamp heuristic (only flips rows where no matching `routing.jsonl`
  entry precedes them). Flipped rows gain a `_migrated_from_phase` audit marker.
  Fails open on every error; never blocks the user prompt. Replaces the 2.0.12 NG4
  "manual recovery only" stance.

- **W0 probe record.** `.orchestray/kb/artifacts/2013-posttooluse-probe-record.md`
  captures the Claude Code 2.1.59 `PostToolUse` payload shape for
  `mcp__orchestray__*` tools. Committed as a source of truth for the BUG-A fix
  (see W2 below). The probe revealed the real field is `event.tool_response`
  (a JSON string, not an object) — `event.tool_result`, which 2.0.12 read, is
  undefined. The artifact is the W2 implementation spec and the R1 pinned
  reference for the `tests/w2-smoke.test.js` contract.

### Fixed

- **BUG-A — `classifyOutcome` blindness (W2).** 2.0.12's
  `record-mcp-checkpoint.js` read `event.tool_result` which is undefined in
  CC 2.1.59. Every checkpoint row on disk showed `outcome: "skipped"`,
  `result_count: null`. The pattern-record-skipped advisory (which gated on
  `result_count >= 1`) was permanently dead code. W2 rewrites `classifyOutcome`
  to read `event.tool_response` (a JSON string), parses defensively (parse
  failure = `error`), and populates a new table-driven `extractResultCount`
  covering `pattern_find`, `kb_search`, and `history_find_similar_tasks`
  uniformly. The `pattern_record_skipped` advisory in `bin/record-pattern-skip.js`
  is rewired to gate on the now-populated `outcome === 'answered'` /
  `result_count >= 1` signals per the A-2 path in DESIGN §D2. A new smoke test
  at `tests/w2-smoke.test.js` exercises the end-to-end hook invocation against a
  real-shape PostToolUse payload — this is the test class that would have caught
  BUG-A in 2.0.12 had it existed. Historical pre-2.0.13 rows on disk retain their
  incorrect `outcome: "skipped"` classification — no migration is in scope; the
  sealed audit trail is immutable.

- **BUG-B — Phase derivation stale across orchestrations (W1).**
  `bin/record-mcp-checkpoint.js` derived `phase` from
  `fs.existsSync(routing.jsonl)` — a global file-presence check that ignored
  orchestration identity. Since `routing.jsonl` persists across orchestrations by
  design, every orchestration after the first in a project recorded its
  pre-decomposition MCP calls with `phase: "post-decomposition"`. W1 replaces the
  check with an orchestration-ID-scoped filter: read routing entries, count only
  those matching the current orchestration ID, return `"post-decomposition"` only
  if at least one matches. Fail-open to `"pre-decomposition"` on routing-file
  errors.

- **BUG-C — Gate phase-strict filter locks out repeat orchestrations (W1).**
  `bin/_lib/mcp-checkpoint.js` `missingRequiredToolsFromRows` defaults
  `phaseFilter = 'pre-decomposition'`. `bin/gate-agent-spawn.js` relied on the
  default. Combined with BUG-B, this gate-locked every second-or-later
  orchestration in any Orchestray project — the gate saw zero matching rows and
  blocked the first `Agent()` spawn. W1 passes `phaseFilter = null` explicitly
  at the gate call site with a `BUG-C-2.0.13` grep anchor comment blocking future
  reverts. Phase is now treated as an audit/analytics field, not an enforcement
  field. The default in `mcp-checkpoint.js` remains unchanged for potential future
  callers that want phase-strict behavior.

- **BUG-D — Gate diagnostic was actively misleading (W1).** When the gate blocked
  due to BUG-B+C, its stderr said "missing MCP checkpoint for pattern_find,
  kb_search, history_find_similar_tasks" — but the rows were in the ledger; they
  just had the wrong phase. A user reading the diagnostic would rerun the trio,
  write more wrong-phase rows, and loop forever. W1 adds a secondary phase-strict
  check that distinguishes true absence from phase mismatch and emits a distinct
  "phase mismatch" diagnostic in the latter case. Under the W1 BUG-C fix the
  phase-mismatch path is reachable only when legacy-poisoned rows coexist with
  genuinely-absent rows; the path is kept as defense-in-depth and feeds the W3
  `phase_mismatch` event field.

**BUG discovery context:** W1/W2/W3 were not identified by 2.0.12 review. They
were discovered on 2026-04-11 during the planning orchestration for 2.0.13, when
the PM ran the MCP trio for the first time in a project with an existing
`routing.jsonl` and its first `Agent()` spawn blocked. That single incident
revealed the full chain: BUG-B (phase poisoning) + BUG-C (gate strict-filter)
+ BUG-D (misleading message), plus surfaced BUG-A (classifyOutcome blindness)
for separate investigation. Original design notes lived in the 2.0.13 phase
directory (removed in 2.0.15 cleanup); the probe record remains at
`.orchestray/kb/artifacts/2013-posttooluse-probe-record.md`.

### Deferred to 2.0.14

**Deferred to 2.0.14: `pattern_record_application` advisory→blocking transition.** Depends on BUG-A fix validated in production across at least several orchestrations with non-null `outcome` / `result_count` data. 2.0.14 will ship the transition only if §22c confidence-feedback analysis over the post-2.0.13 audit window shows a false-positive rate of the `pattern_record_skipped` advisory below a threshold to be set in 2.0.14's DESIGN.md. The threshold and the evaluation window are not specified here — they are a 2.0.14 design decision — but the dependency on BUG-A being fixed and validated is a hard prerequisite.

Also deferred (per DESIGN §Non-goals):
- `ask_user` budget counter-hook (NG2 — zero overruns observed in 2.0.12 audit data)
- Empty-patterns-dir gate optimization (NG3 — directory is never empty in observable repos)
- No server-side MCP changes (NG5)
- No cron/daily rotation variants (NG6)

### Upgrade caveat / Recovery notes

**Automatic migration on first 2.0.13 use.** The first `UserPromptSubmit` after
upgrade fires `bin/post-upgrade-sweep.js`, which runs W8 (config `mcp_enforcement`
block) and W11 (ledger phase sweep). Both operations are idempotent, sentineled,
and fail-open — they cannot block the user prompt. Manual rollback: delete the
sentinels at `.orchestray/state/.config-migrated-2013` and
`.orchestray/state/.mcp-checkpoint-migrated-2013`.

**In-flight orchestration upgrade:** an orchestration that was decomposing when
2.0.13 landed continues to work because the gate is idempotent and all new hooks
fail open. The new `mcp_checkpoint_missing` event emission is additive — existing
consumers of `events.jsonl` who do not know the event type will simply ignore it.

**Kill-switch rollback still works** — `mcp_enforcement.global_kill_switch: true`
in `.orchestray/config.json` bypasses the 2.0.13 MCP checkpoint gate entirely
(now with BUG-B/C/D fixes applied). Per-tool `mcp_enforcement.<tool>: "prompt"`
also still works.

**Events.jsonl rotation** is PM-driven at orchestration-complete. A user whose
`events.jsonl` is already oversized at upgrade time: the W5 configurable cap
gives immediate cost-attribution relief (`ORCHESTRAY_MAX_EVENTS_BYTES` env var
OR `audit.max_events_bytes_for_scan` config key); the next orchestration to
complete triggers the durable W6 rotation which moves old rows to
`.orchestray/history/<orch-id>/events.jsonl`.

**Probe record reference.** The BUG-A fix depends on Claude Code 2.1.59's
`PostToolUse` payload shape for `mcp__orchestray__*` tools. The exact shape
captured during the 2.0.13 planning phase is at
`.orchestray/kb/artifacts/2013-posttooluse-probe-record.md`. If a future Claude
Code version renames `tool_response` or changes the MCP response envelope, the
`tests/w2-smoke.test.js` smoke test is the first thing that will fail.

**Tested against Claude Code 2.1.59.**

Tests: 631 → 714 (+83 across W1/W4/W5/W2/W3/W6/W7/W8+W11).

---

## [2.0.12] - 2026-04-11

### Theme: "Hook-Enforced MCP Surface"

Pre-decomposition retrieval becomes auditable, and the hook layer stops
trusting the dispatch name. The thesis: prompt compliance alone has failed
for retrieval-class MCP calls (`pattern_find`, `kb_search`,
`history_find_similar_tasks`, `pattern_record_application` had zero calls
across the full 2.0.11 audit history), exactly as prompt compliance failed
for model routing before 2.0.11. 2.0.12 closes both the retrieval gap and
the separately discovered Explore dispatch bypass using one architectural
principle: **every workflow-critical retrieval or spawn crosses a hook,
the hook writes a checkpoint, and the checkpoint is verified before the
next spawn.**

### Added

- **Hook-enforced MCP retrieval.** The four pre-decomposition MCP tools
  (`pattern_find`, `kb_search`, `history_find_similar_tasks`,
  `pattern_record_application`) that had zero calls across 2.0.11's full
  audit history are now hook-enforced via a new
  `.orchestray/state/mcp-checkpoint.jsonl` ledger. New hook script
  `bin/record-mcp-checkpoint.js` fires on each `PostToolUse` for the three
  required pre-decomposition tools and writes one row to the ledger plus one
  `mcp_checkpoint_recorded` event to `events.jsonl`. `gate-agent-spawn.js`
  reads the ledger before the first orchestration `Agent()` spawn and blocks
  (exit 2) with a diagnostic naming any missing required tool for the current
  `orchestration_id`. Closes the "PM forgets to call the tool" failure mode
  that 2.0.11's durable routing pattern proved the fix for.

- **Explicit dispatch allowlist in `gate-agent-spawn.js`.** The 2.0.11
  implicit `toolName !== 'Agent'` fail-open guard is replaced by an explicit
  `AGENT_DISPATCH_ALLOWLIST = {Agent, Explore, Task}` (tools that must be
  gated) and `SKIP_ALLOWLIST = {Bash, Read, Edit, Glob, Grep, Write, ...}`
  (tools that must be passed through). Any `tool_name` that appears in
  neither list is now handled according to the `mcp_enforcement.unknown_tool_policy`
  config flag, which defaults to `"block"` (fail-closed). A future Claude
  Code built-in that dispatches agents under an unknown name will produce a
  loud diagnostic naming the tool and the config key to flip — it will not
  silently bypass routing.

- **`hooks/hooks.json` matcher expansion.** `PreToolUse` and `PostToolUse`
  matchers grew from `"Agent"` to `"Agent|Explore|Task"` so Claude Code's
  built-in Explore and Task dispatches now flow through `gate-agent-spawn.js`
  (routing-entry validation + MCP checkpoint gate) and
  `emit-routing-outcome.js` (audit). Explore spawns now produce
  `routing_outcome` Variant A events with an added optional `tool_name` field
  so analytics can distinguish Explore from architect/developer spawns.

- **`mcp_enforcement` config block.** New nested section in
  `.orchestray/config.json` with per-tool enforcement mode toggles
  (`"hook" | "prompt" | "allow"`), `unknown_tool_policy`
  (`"block" | "warn" | "allow"`), and `global_kill_switch` (boolean).
  Defaults are frozen in `bin/_lib/config-schema.js` and merged at read
  time — no manual migration needed. The config is read stateless on every
  hook invocation, so **no session restart is required** to change any flag.
  `/orchestray:config` surfaces all keys and warns when `global_kill_switch`
  is `true`. Note: `pattern_record_application` is advisory only — not
  gate-enforced. Setting it to `"prompt"` or `"allow"` suppresses the
  `pattern_record_skipped` advisory event on PreCompact but has no effect
  on spawn gating (the gate only enforces `pattern_find`, `kb_search`,
  `history_find_similar_tasks`).

- **`record-pattern-skip.js` advisory on PreCompact.** Emits a
  `pattern_record_skipped` event once per orchestration if `pattern_find`
  returned ≥1 result but the PM never called `pattern_record_application`.
  Advisory only — does not block. Idempotent. Feeds the §22c confidence
  feedback loop as "no data this run" signal. Fires on the `PreCompact`
  hook (the closest available session-boundary event in Claude Code's
  current hook vocabulary) rather than `SubagentStop`, because the
  Orchestray PM is the main session agent — not a spawned subagent — so
  `SubagentStop` never fires for it.

- **New audit events:** `mcp_checkpoint_recorded` (per enforced MCP call,
  dual-written to the checkpoint ledger and `events.jsonl`) and
  `pattern_record_skipped` (advisory, emitted on `PreCompact` when
  `pattern_find` returned results but `pattern_record_application` was
  never called). A third event name, `mcp_checkpoint_missing`, is
  **RESERVED** — `gate-agent-spawn.js` currently blocks with a stderr
  diagnostic and `exit 2` only; the audit event is documented as a
  forward contract in `agents/pm-reference/event-schemas.md` and will be
  emitted in a follow-up release if analytics usage justifies it. The
  `routing_outcome` Variant A shape gains an optional `tool_name` field
  (backward-compatible; defaults to `"Agent"` when absent).

- **New shared module `bin/_lib/mcp-checkpoint.js`.** Reader and path helpers
  for `mcp-checkpoint.jsonl` — a single module instead of duplicating the
  "filter by orchestration_id + required-tool-set" logic across the writer
  and the gate.

- **From 2.0.11, folded into this release for README coverage.** The
  `mcp__orchestray__ask_user` MCP elicitation tool (mid-task structured
  ≤5-field form, pause-and-resume without unwinding orchestration) and durable
  hook-enforced model routing (`routing.jsonl` + `gate-agent-spawn.js`) were
  both shipped in 2.0.11 but the README was not swept at that release.
  README is now current for both releases in one pass.

### Fixed

- **Explore routing gap closed.** 2.0.11's `PreToolUse:Agent` hook matcher
  missed Claude Code's built-in `Explore` tool, which dispatches under
  `tool_name: "Explore"` rather than `"Agent"`. Explore spawns therefore
  bypassed model routing entirely — the hook never fired, so the model
  parameter was never validated and no `routing_outcome` event was emitted.
  The T2 diagnosis identified two independent bypass paths: (1) the
  `hooks.json` matcher covering only `"Agent"`, (2) the `gate-agent-spawn.js`
  early-exit on `toolName !== 'Agent'`. Both are closed in 2.0.12 via the
  matcher expansion and the explicit allowlist rewrite. Fix is folded into
  this release — no 2.0.11.1 patch.

- **`bin/emit-routing-outcome.js` coverage drift corrected.** The in-script
  `toolName !== 'Agent'` guard was load-bearing in 2.0.11 but would have
  silently blocked Explore/Task dispatches in the 2.0.12 matcher-expansion
  window until the T7 review caught it. The guard now uses the same explicit
  allowlist Set as `gate-agent-spawn.js`, with a `tool_name` field populated
  on the emitted `routing_outcome` Variant A event.

- **PM wire-check: pre-decomposition retrieval checklist and §22b.R re-entry
  instruction.** New Section 13 checklist in `tier1-orchestration.md` and
  a §22b.R sub-subsection give the PM an explicit re-entry path when
  `gate-agent-spawn.js` blocks with a missing-checkpoint diagnostic. Without
  this, the PM could loop retrying the spawn rather than re-running the
  retrieval sequence (R2 infinite-retry loop mitigation).

### Upgrade caveat / Recovery notes

**In-flight orchestrations upgrading to 2.0.12:** the new
`mcp-checkpoint.jsonl` gate fails open when the file is missing or has no
rows for the current orchestration, so a PM that was decomposing when the
upgrade landed will not be blocked on its next spawn. If the gate
unexpectedly blocks a spawn (e.g., the PM called `pattern_find` for this
orchestration but then skipped `kb_search`), set
`mcp_enforcement.kb_search: "prompt"` in `.orchestray/config.json` to fall
back to prompt-only for that tool, or set
`mcp_enforcement.global_kill_switch: true` to restore 2.0.11 enforcement
behavior entirely. **No session restart is required** — the hook re-reads
config on every invocation. To fully revert, delete
`.orchestray/state/mcp-checkpoint.jsonl` and set the kill switch.

To add a tool name that a future Claude Code built-in dispatches under, add
it to `AGENT_DISPATCH_ALLOWLIST` in `bin/gate-agent-spawn.js`, or set
`mcp_enforcement.unknown_tool_policy: "warn"` to restore the 2.0.11
fail-open behavior without editing any code.

**Tested against Claude Code 2.1.59.**

Tests: 569 → 631 (+62 across gate, checkpoint writer, allowlist,
pattern-record-skip, atomic-append IfAbsent helper, allowlist-sync,
and full-suite integration tests).

---

## [2.0.11] - 2026-04-10

### Added
- **Durable model routing.** PM routing decisions (model + effort + score
  per subtask) are now persisted to `.orchestray/state/routing.jsonl` at
  decomposition time and re-read per spawn. The `PreToolUse:Agent` hook
  at `bin/gate-agent-spawn.js` validates every `Agent()` call against the
  file — if the spawn's `model` parameter doesn't match the stored routing
  decision, the hook blocks with a clear diagnostic. This closes the
  long-session fragility where the PM would silently forget routing and
  fall back to the parent session's model (typically Opus), bypassing
  Section 19 entirely and blowing the cost budget. Routing is now
  **immortal** — it survives context compaction, session resumption,
  and PM forgetfulness because the PM reads its own decision fresh from
  the file every spawn, not from working memory. New helper
  `bin/_lib/routing-lookup.js` exposes `ROUTING_FILE`, `getRoutingFilePath`,
  `appendRoutingEntry`, `readRoutingEntries`, and `findRoutingEntry`.
  Matching is word-boundary aware (`"Fix auth"` does NOT match
  `"Fix authority"`) and rejects empty-description wildcards.
  `agents/pm.md` Section 13 and Section 19 updated with the hard rule:
  "The routing file is the SINGLE SOURCE OF TRUTH; do not trust your
  working memory." Dynamic spawns and re-planned tasks must append
  fresh entries — the hook matches most-recent timestamp. 30 new tests
  across `tests/gate-agent-spawn.test.js` (11 integration cases) and
  `tests/hooks/routing-lookup.test.js` (19 unit cases). Tests: 539 → 569.

### Durable routing — upgrade & recovery notes
- **In-flight orchestrations upgrading to 2.0.11:** a PM that was
  decomposing when the upgrade landed has no `routing.jsonl` file. The
  first post-upgrade `Agent()` call with a missing file falls through to
  the existing model-validity check (no new blocking). Once the PM starts
  writing entries, subsequent spawns must have matching entries or they
  are blocked. If an in-flight orchestration stalls on this check, delete
  `.orchestray/state/routing.jsonl` to fall back to the pre-2.0.11
  model-validity-only path and complete the current orchestration under
  the old semantics.
- **Corrupted `routing.jsonl` recovery:** if the file contains all
  garbage (every line fails JSON.parse), `readRoutingEntries` silently
  skips every line and returns an empty array. The hook then blocks with
  "no routing entry" rather than crashing or silently permitting unrouted
  spawns. Recovery: delete the file and re-run decomposition, or manually
  repair the file to have at least one valid JSON line.
- **`enable_regression_check` and `enable_static_analysis` removed**
  from the `agents/pm.md` Section 0 config defaults block. These keys
  were already unused at runtime (no consumer logic) and were flagged
  as dead config by prior audits. No behavior change for operators;
  the cleanup is purely documentation. Any tooling that scans
  `agents/pm.md` defaults should update its expectations.

- **New: `mcp__orchestray__ask_user` MCP tool.** Agents can pause mid-task to
  ask the user a structured ≤5-field form and resume with the answers, without
  unwinding the orchestration. Enabled for pm, architect, developer, and
  reviewer. Configuration under `mcp_server.tools.ask_user` in
  `.orchestray/config.json`.
- Plugin-bundled stdio MCP server at `bin/mcp-server/server.js` (Node 20
  stdlib only — no new npm deps). JSON-RPC 2.0 line-delimited framing;
  server-initiated `elicitation/create` with in-memory id correlation.
- Audit trail: every `ask_user` invocation appends one `mcp_tool_call` event
  to `.orchestray/audit/events.jsonl` with `outcome ∈ {answered, cancelled,
  declined, timeout, error}` and `form_fields_count`. No question or answer
  text is persisted.
- 28 new unit tests under `tests/mcp-server/` covering schema validation,
  audit-event shape, and the handler's decision rules (including timeout and
  cancel/decline branches) with an injected elicitation fake.

### Fixed
- **Model routing is now hook-enforced.** Previously, the PM was asked (by
  prompt) to pass `model: haiku|sonnet|opus` on every `Agent()` spawn during
  orchestrations and to emit a `routing_outcome` audit event. In practice
  the PM silently skipped both steps, so every subagent inherited the parent
  session's model (typically Opus), the UI showed no model badge next to
  running agents, and `model_used` was null on every `agent_stop` event —
  which made `bin/collect-agent-metrics.js` fall back to Sonnet rates and
  under-report cost. New `PreToolUse:Agent` hook at `bin/gate-agent-spawn.js`
  rejects (exit 2) any in-orchestration `Agent()` call missing `model` or
  using `model: "inherit"`. Companion `PostToolUse:Agent` hook at
  `bin/emit-routing-outcome.js` auto-appends a `routing_outcome` event with
  the assigned model, removing the prompt-compliance burden entirely. Both
  hooks no-op outside orchestrations and fail-open on unexpected errors.
- `agents/pm.md` Section 19 Transparency rewritten as a hard rule (was
  advisory). `agents/pm-reference/tier1-orchestration.md` Section 19 notes
  the PM no longer writes hook-covered fields manually but must still emit
  a PM-supplemented event for task_id, complexity_score, and final result.
- `agents/pm-reference/event-schemas.md` Section 19 now documents three
  `routing_outcome` variants — hook-emitted at spawn time (partial,
  `source: "hook"`), PM-supplemented after result processing (full,
  `source: "pm"`), and auto-emitted at completion (safety-net,
  `source: "subagent_stop"`) — with precedence rules and consumer guidance
  for downstream audit readers. Includes an explicit `agent_id` namespace
  warning: Variant C populates `agent_id` from two incompatible sources
  (subagent invocation ID vs team subtask label) and consumers MUST NOT
  cross-join on it.
- **Third-variant routing_outcome safety net.** `bin/collect-agent-metrics.js`
  now auto-emits a `routing_outcome` event with `source: "subagent_stop"`
  on every `SubagentStop` and `TaskCompleted` hook firing (when inside an
  orchestration), carrying orchestration_id, agent_type, agent_id, the
  resolved model assignment (looked up from the prior Variant A event),
  turns_used, token counts, and a heuristic `result` field
  (error/unknown/success). Guarantees pattern-extraction, replay analysis,
  and cost attribution always see a completion observation even if the
  hook-emitted Variant A lands and the PM-emitted Variant B drifts. Fails
  open and cannot block the existing `agent_stop` / `task_completed_metrics`
  write that follows.
- **`bin/emit-routing-outcome.js` tool_name guard.** The hook was missing
  an early-return when `tool_name !== "Agent"`, so during any active
  orchestration every `PostToolUse` event (Bash, Read, Edit, Grep, etc.)
  would have silently appended a bogus `routing_outcome` row to
  `.orchestray/audit/events.jsonl`, poisoning pattern extraction and cost
  attribution downstream. Added the guard, matching the pattern already in
  `bin/gate-agent-spawn.js`. Caught during review, not by the hook matcher
  itself — `matcher: "Agent"` in `hooks.json` IS honored per Claude Code
  hook docs (verified at code.claude.com/docs/en/hooks), but the in-script
  guard is load-bearing as a defense-in-depth measure.
- **Final audit pass — 28 fixes across correctness, security, and dead-code
  dimensions.** Four parallel audit agents (MCP server review, hook-script
  review, cross-cutting security, dead-code/wiring) surfaced 5 majors,
  14 warnings, and 12 info-level findings; every one was landed in two
  parallel fix rounds. Highlights:
  - **TOCTOU fix in `tools/pattern_record_application.js`** — two sequential
    `rewriteField` calls merged into a single read-modify-write so concurrent
    pattern applications no longer silently lose `times_applied` increments.
  - **Correct error code on `resources/history_resource.js` TOCTOU** — all
    four read paths now remap ENOENT from unguarded `readFileSync` to
    `RESOURCE_NOT_FOUND` (−32002) instead of falling through to
    `INTERNAL_ERROR` (−32603).
  - **`history_find_similar_tasks._bodyAfterH1`** — now actually skips to
    after the H1 line instead of returning frontmatter content, fixing
    silent similarity-score pollution.
  - **`install.js` hook dedup is matcher-aware** — two hook blocks for the
    same event with different matchers (e.g., `PreToolUse:Agent` and
    `PreToolUse:Bash`) are no longer conflated during reinstall.
  - **Crypto-random elicitation correlation IDs** — `server.js` replaces the
    sequential `nextElicitationId = 1` counter with
    `crypto.randomBytes(8).toString('hex')`. A compromised client can no
    longer spoof elicitation responses by guessing sequential ids.
  - **`pre-compact-archive.js` symlink skip** — the recursive task-copy
    walk now short-circuits on `entry.isSymbolicLink()` before copying,
    so a malicious symlink in `.orchestray/state/tasks/` cannot leak
    arbitrary file contents into the pre-compact snapshot.
  - **Safe-cwd hook helper `bin/_lib/resolve-project-cwd.js`** — centralizes
    `event.cwd` resolution with null-byte rejection and clean fallback to
    `process.cwd()`. Documented why stricter containment (requiring a
    pre-existing project marker) was rejected: it would break every
    first-ever hook run in a fresh project.
  - **Orchestration-state path helper `bin/_lib/orchestration-state.js`** —
    `.orchestray/audit/current-orchestration.json` is no longer hardcoded
    in seven separate scripts; one constant, one helper.
  - **`schemas.js` `startLen` bail** — `_validate` now tracks the error
    count at entry and bails only on errors accumulated in the current
    call frame. Fixes the bug where a prior sibling property's validation
    error silently skipped all subsequent siblings in the same object.
  - **`kb_resource.list()` descriptions** — resource list responses now
    populate `description` from the first H1 instead of hardcoding empty
    string. Consistent with `pattern_resource`.
  - **Dead config keys removed** — `enable_regression_check` and
    `enable_static_analysis` stripped from `.orchestray/config.json`,
    `agents/pm.md`, and `skills/orchestray:config/SKILL.md` (defaults
    block, Available Settings table, validator list, Quick Reference
    table — three subsections cleaned).
  - **Hook-script hardening (bulk)** — every stdin-reading hook script
    now has a `MAX_INPUT_BYTES = 1 MB` guard that drops and exits cleanly
    on oversized payloads (fails open per each script's normal success
    contract); every audit-dir-creating script now calls
    `fs.chmodSync(auditDir, 0o700)` best-effort after `mkdirSync` to
    restrict world-read on shared systems.
  - **MCP `resources/list` meta propagation** — `server.js` aggregation
    loop now forwards `_truncated` and `_totalCount` from any handler
    that reports them (today: `history_resource` caps archives at 20).
    Previously the handler exposed the meta but the dispatcher stripped
    it silently, so clients could not tell they were seeing a partial
    list.
  - **Consistency sweep** — `lib/audit.js` and `lib/history_scan.js`
    now import `logStderr` from `lib/rpc.js` instead of duplicating the
    `[orchestray-mcp]` prefix locally; `elicit/ask_user.js` emits
    audit events with `tool: "ask_user"` instead of
    `mcp__orchestray__ask_user` for consistency with other tool names;
    `pattern_resource` and `kb_resource` shape errors use
    `INVALID_URI` instead of `PATH_TRAVERSAL`; `history_find_similar_tasks`
    applies `assertSafeSegment` to `orchId`/`taskId` before path joins.
  - **Documentation tightening** — `agents/pm-reference/event-schemas.md`
    `routing_outcome` Variant C documents the `agent_id` cross-event
    namespace caveat; inline comments added in `kb_search.js` (ReDoS
    safety constraint), `schemas.js` (`additionalProperties` exclusion
    rationale), `frontmatter.js` / `atomic-append.js` / `install.js`
    (predictable lockfile/tmp-name single-user acceptability),
    `reassign-idle-teammate.js` (DEF-3 defect ID expanded to human
    rationale), `emit-routing-outcome.js` (`score: null` reserved for
    PM supplement), and `audit-event.js` (SubagentStop is intentionally
    handled by `collect-agent-metrics.js`, positional `start` arg is
    decorative).
- Test suite now at 539/539 across all additions. All audit fixes verified
  by diff-scoped final review; no regressions introduced across the two
  fix rounds.

### Added
- **Dedicated rpc.js unit tests.** `tests/mcp-server/lib/rpc.test.js` —
  43 test cases covering `parseLine` edge cases (empty/malformed/non-object
  JSON, array messages, long lines, unicode), `isResponse` variants,
  `writeFrame` including circular-reference handling, `sendError`/`sendResult`
  envelope shape, `logStderr` prefix + coercion, and numeric values of all
  six error code constants. Locks in the extraction contract from the
  refactor above.
- **Hook script tests.** `tests/gate-agent-spawn.test.js` and
  `tests/emit-routing-outcome.test.js` — 41 test cases across both files
  using `child_process.spawnSync` and isolated tmpdir fixtures. Cover tool
  name filtering (including the `Bash`/`Read`/`Edit` cases that would have
  caught the emit-routing-outcome bug above), outside-orchestration no-op,
  inside-orchestration block/allow paths, case-insensitive model matching,
  full model id normalization (`claude-opus-4-6` → `"opus"`), description
  truncation, atomic append of sequential events, and every fail-open path
  (malformed stdin, empty stdin, read-only audit dir).
- **Additional test hardening** — 6 more cases added as a final pass:
  (1) `writeFrame(null)` and `writeFrame(42)` primitive-argument behavior
  locked in as documentation tests — frame-shape validation is the caller's
  job, not `writeFrame`'s; (2) `gate-agent-spawn.js` `tool_input.tool`
  fallback branch tested (three cases covering Agent-via-fallback, Bash-via-fallback,
  and tool_name precedence over tool_input.tool); (3) concurrent-append
  correctness test for `emit-routing-outcome.js` — spawns 10 parallel hook
  invocations with distinct descriptions and asserts `atomicAppendJsonl`
  preserves all 10 as valid jsonl lines with no lost updates. Also hardened
  the `rpc.test.js` stdout/stderr capture pattern with null guards in every
  `afterEach` so a hypothetical `beforeEach` failure can't leave
  `process.stdout.write` / `process.stderr.write` swapped for subsequent
  tests.
- Test suite now at 539/539 across all additions (up from the 449 baseline
  at the start of v2.0.11 development).

### Changed
- **`bin/mcp-server/server.js` internal refactor.** JSON-RPC 2.0 wire
  plumbing (`writeFrame`, `sendError`, `sendResult`, `isResponse`,
  `logStderr`, `parseLine`, error-code constants) extracted into a new
  sibling module `bin/mcp-server/lib/rpc.js` (106 lines). `server.js`
  drops from 602 to 574 lines and now contains only domain-coupled
  dispatch, elicitation correlation, tool/resource tables, and the
  readline loop. Behavior-preserving; integration test suite stays green
  end-to-end (449 → 533 with the new dedicated rpc.js unit tests and
  hook-script tests layered on top). No protocol, wire, or API surface
  changes — this is purely internal restructuring to keep the MCP server
  module under a sane line budget as the Stage 2 tool and resource
  surface grows.
- **`package.json` test glob** now includes `tests/hooks/*.test.js` so
  hook-script tests placed in that subdirectory are picked up automatically
  without a glob update each time. Existing explicit subdirectory globs
  retained for the other test locations.

### Upgrade caveat
- **Restart your Claude Code session** (or run `/agents`) after upgrading to
  v2.0.11 before `mcp__orchestray__ask_user` becomes visible to agents.
  Claude Code caches agent definitions at session start, so the new `tools:`
  frontmatter entries on pm/architect/developer/reviewer won't take effect
  until a reload.

## [2.0.10] - 2026-04-10

### Theme: "The Self-Improving Orchestrator"

### Added
- **Orchestration Threads** — Cross-session continuity via thread summaries. After each orchestration, PM writes a compressed thread entry (domain tags, files touched, decisions, open items, next steps). Before decomposing new tasks, PM scans threads for semantic overlap and injects matching context as "Previously" section. Thread lifecycle: 30-day age limit, 20-thread cap, automatic update on re-match. Opt-out via `enable_threads`.
- **Outcome Tracking** — Deferred quality validation via outcome probes. After orchestration, PM records delivered files and success conditions. On next session touching same files, PM lazily validates (git history, test runs) and feeds results back into pattern confidence (+0.15 positive, -0.3 negative). `/orchestray:learn validate` for manual validation. Opt-in via `enable_outcome_tracking`.
- **Adaptive Agent Personas** — Auto-generated project-tuned agent behavior. After 3+ orchestrations, PM synthesizes behavioral personas per agent type from accumulated patterns, corrections, KB facts, and repo structure. Injected as `## Project Persona` in delegation prompts. Refreshes every 5 orchestrations. Opt-out via `enable_personas`.
- **Replay Analysis** — Counterfactual reasoning on friction orchestrations. When re-plans, verify-fix failures, cost overruns, or low confidence occur, PM generates alternative strategies stored as replay patterns. Applied as advisory counter-evidence in future decompositions. Opt-out via `enable_replay_analysis`.
- 4 new Tier 2 reference files: `orchestration-threads.md`, `outcome-tracking.md`, `adaptive-personas.md`, `replay-analysis.md`
- 5 new config settings: `enable_threads`, `enable_outcome_tracking`, `enable_personas`, `enable_replay_analysis`, `max_turns_overrides`
- 8 new event schemas: `thread_created`, `thread_matched`, `thread_updated`, `persona_generated`, `persona_injected`, `probe_created`, `probe_validated`, `replay_analysis`
- `validate` subcommand for `/orchestray:learn` skill
- **Configurable `maxTurns` ceilings** — `max_turns_overrides` config key lets users override per-agent turn budget ceilings without editing agent frontmatter. Example: `{"reviewer": 50, "debugger": 60}`. When `null` (default), each agent's frontmatter `maxTurns` is used. PM Section 3.Y turn budget formula now resolves ceiling from config override first, then frontmatter default.
- **PreCompact hook** — New `bin/pre-compact-archive.js` hook script registered in `hooks/hooks.json` under Claude Code's `PreCompact` event. Before auto-compaction or `/compact` runs, the hook archives the current orchestration state (`.orchestray/state/orchestration.md`, `task-graph.md`, `tasks/*`), audit trail (`events.jsonl`, `current-orchestration.json`), and writes a manifest to `.orchestray/history/pre-compact-{timestamp}/`. Non-blocking — compaction always proceeds. Ensures valuable orchestration context is preserved before summarization.
- **Memory integration for personas and threads** — Personas now dual-write to `.claude/agent-memory/{agent-type}/MEMORY.md` so they're auto-loaded into the agent's context by Claude Code's memory system (first 25KB / 200 lines on every spawn). Threads now dual-write to `.orchestray/kb/facts/thread-{orch-id-slug}.md` with `ttl_days: 60` so they're queryable via `/orchestray:kb` and survive auto-compaction. Canonical copies remain in `.orchestray/personas/` and `.orchestray/threads/`; the memory/KB entries are mirrors for context survival.
- **Compact Instructions in CLAUDE.md** — New "Compact Instructions" section at the top of CLAUDE.md tells Claude Code's auto-compactor what to preserve during summarization: orchestration state, active audit round, applied fixes, cost tracking, modified files, decisions, and known blockers.
- **Agent caching troubleshooting note in CLAUDE.md** — Documents the gotcha that editing `agents/*.md` frontmatter mid-session doesn't take effect until the session restarts or `/agents` is run. Explains the workaround: pass `maxTurns` as an explicit parameter on `Agent()` calls.
- **Test coverage** — suite now at 195/195 across 11 test files. New: `tests/hooks-json.test.js` (asserts every `hooks/hooks.json` command path resolves to a real script) and an installer `_lib/` regression test in `tests/install.test.js` asserting every installed script's `require('./_lib/...')` resolves.

### Fixed
- **Installer `_lib/` copy** — `bin/install.js` now copies `bin/_lib/` into the install target. Prior versions shipped broken installed hooks (MODULE_NOT_FOUND on `require('./_lib/...')`). Any user who installed 2.0.8 or 2.0.9 via `npx orchestray --global|--local` should re-run the installer to pick up the fix.
- **Installer non-destructive uninstall** — `bin/install.js` uninstall path now uses conditional `rmdirSync` only when the `orchestray/` directory is empty, instead of a blanket `rmSync`. The uninstall log correctly reflects whether the directory was actually removed or preserved.
- **Installer "already installed" parse** — regex-based detection of existing install entries now handles paths containing spaces.
- **Installer bare-environment error** — `--global` with no `HOME` / `USERPROFILE` now emits a friendly error instead of crashing with a cryptic `TypeError`.
- **`collect-agent-metrics.js` O(n²) scan** — events.jsonl scan is now O(n) with a 2 MB read cap and a `"routing_outcome"` substring pre-filter (previously re-parsed the full file on every SubagentStop). When the cap is hit, writes a stderr warning and sets `model_resolution_note` on the emitted event so `/orchestray:analytics` can flag degraded cost rows.
- **`_lib/atomic-append.js` stale-lock recovery** — on `EEXIST`, stats the lockfile and unlinks + retries if older than 10 s. Fallback stderr message now surfaces the underlying error code instead of a generic "retry exhausted". The unlink guard logs non-ENOENT errors instead of silently dropping them.
- **`pre-compact-archive.js` Node 21+ compat** — uses `entry.parentPath || entry.path` because `entry.path` is deprecated in Node 21+.
- **`reassign-idle-teammate.js` pending-task regex** — now requires line-leading `- [ ]` / `status:` so documentation-style checkboxes embedded in task descriptions no longer match as pending work.
- **`reviewer.md` scope clarification** — line 347 now reads "you do not change source files. KB writes and findings artifacts via Write are allowed." (was ambiguous "you do not change files", which conflicted with the reviewer's audit-write permissions.)
- **PM section reference corrected** — `agents/pm.md:130` now says "Sections 0–43 across this file and `agents/pm-reference/`" (was "Sections 1-43", which both undercounted the range and failed to clarify the scope spans Tier 0 + Tier 2 files).
- **PM Tier 1 cross-references disambiguated** — three "Section 13 / 14 / 17" references in `agents/pm.md` now carry a `(tier1)` suffix so they are not confused with pm.md's own section numbers.
- **`/orchestray:config` agent-teams enablement** — setting `enable_agent_teams: true` now mutates `settings.json` to add `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"` (two-layer enablement: Orchestray config + Claude Code env var). Setting it to `false` removes the env var cleanly.
- **Tier 2 frontmatter cleanup** — stripped stale YAML frontmatter from `adaptive-personas.md`, `outcome-tracking.md`, `orchestration-threads.md`, and `replay-analysis.md` so all 29 tier2 files now follow a uniform "no frontmatter" convention.
- **CLAUDE.md slash-command clarification** — added a one-line note that `skills/orchestray:*` directories are slash commands (all use `disable-model-invocation: true`), not model-invoked skills.

### Changed
- **PM Section 3.Y hardened**: Now explicitly mandates "MUST pass `maxTurns` parameter on every Agent() call" (not "may pass"). Previously the PM relied on frontmatter as a fallback; now it must always pass the calculated value explicitly, bypassing the Claude Code session-start agent definition cache that caused mid-session `maxTurns` edits to be ignored.
- Config defaults now include 47 keys (was 42)
- `agents/pm-reference/scoring-rubrics.md` Turn Budget Reference table updated with current frontmatter ceiling values (previously stale: developer 25→50, reviewer 20→30, debugger 30→40, tester 25→40, documenter 20→30, refactorer 25→50, inventor 40→50)
- PM Tier 0 updated from ~1,082 to ~1,215 lines (config defaults, step references, dispatch entries, inline probe validation protocol in Section 0 step 0.5 to avoid Tier 2 dependency on simple-task path)
- PM Tier 1 post-orchestration flow expanded with steps 7.1-7.4 (thread creation, probe creation, persona refresh, replay analysis)
- Pattern extraction updated with replay pattern advisory integration (Section 22b)
- 29 pm-reference files (was 25)
- Section 0 Silent Pre-Check gains step 0.5 (probe scan on every session)
- Section 3 delegation gains step 9.5 (persona injection)
- Section 0 Medium+ path gains step 2.6 (thread scan)

## [2.0.9] - 2026-04-09

### Theme: "Agents That Think About Thinking"

### Added
- **Agent Introspection Protocol** -- After each non-Haiku agent completes, a Haiku distiller extracts the reasoning trace (approaches considered, assumptions made, trade-offs evaluated, discoveries) into a compressed file. Downstream agents receive relevant traces in their delegation prompts, eliminating redundant exploration and preventing repetition of rejected approaches. Opt-out via `enable_introspection`.
- **Cognitive Backpressure** -- Agents write structured confidence signals to `.orchestray/state/confidence/` at defined checkpoints during execution. PM reads signals between execution groups and reacts: proceeding normally (>=0.7), injecting context (0.5-0.69), re-evaluating (0.3-0.49), or escalating to user (<0.3). Low-confidence successes are flagged. Opt-out via `enable_backpressure`.
- **Agent Disagreement Protocol** -- Reviewer findings that represent genuine design trade-offs (not bugs) are surfaced to the user as structured decisions instead of being routed through the verify-fix loop. User choices are saved as design-preference patterns that proactively guide future orchestrations. Opt-out via `surface_disagreements`.
- **Drift Sentinel** -- Detects architectural drift via 3 invariant sources: auto-extracted from architect output, 3 conservative static rules (no-new-deps, no-removed-exports, test-coverage-parity), and session invariants from the current orchestration. Pre/post-execution checks surface violations to user. Opt-out via `enable_drift_sentinel`.
- **Visual Orchestration** -- Multi-modal review for UI changes. When enabled, PM auto-detects screenshots from project artifact directories (Storybook, Cypress, Playwright) and includes them in reviewer delegation. Reviewer applies 6-dimension visual checklist. No external dependencies — uses Claude's native image reading. Opt-in via `enable_visual_review`.
- 5 new Tier 2 reference files: `introspection.md`, `cognitive-backpressure.md`, `disagreement-protocol.md`, `drift-sentinel.md`, `visual-review.md`
- 5 new config settings: `enable_introspection`, `enable_backpressure`, `surface_disagreements`, `enable_drift_sentinel`, `enable_visual_review`
- 5 new event schemas: `introspection_trace`, `confidence_signal`, `disagreement_surfaced`, `drift_check`, `visual_review` (plus `invariant_extracted`)

### Changed
- Tier 1 orchestration reference expanded with new subsections for introspection injection, backpressure reading, and disagreement routing
- Delegation templates updated with trace injection, confidence checkpoints, and design-preference context
- Config defaults now include 42 keys (was 37)
- PM Tier 0 updated from ~1,043 to ~1,081 lines (dispatch entries and config defaults only; all feature logic in Tier 1/2)
- 5 new Tier 2 reference files (was 3)
- 5 new config settings (was 3)

## [2.0.8] - 2026-04-09

### Theme: "Self-Aware Orchestration"

### Added
- **Prompt tiering** -- PM prompt restructured into 3 tiers (Tier 0 always-loaded ~1,030 lines, Tier 1 orchestration-only, Tier 2 feature-gated). Reduces PM input tokens by 30-40% for simple tasks.
- **Orchestration contracts** -- Machine-verifiable pre/post-conditions per subtask. PM validates file existence, file ownership, and content patterns before accepting agent results. Configurable via `contract_strictness` setting (none/standard/strict).
- **Delegation pre-flight checklists** -- Per-agent-type validation ensures delegation prompts include all required context before spawning. Reduces verify-fix loops.
- **Diff-scoped review** -- Reviewer receives git diff alongside file paths, focusing analysis on changed lines. Reduces reviewer token consumption.
- **Consequence forecasting** -- Pre-execution dependency scan predicts downstream effects; post-execution validation tracks accuracy. Opt-out via `enable_consequence_forecast`.
- **Adaptive agent turn budgets** -- Dynamic `maxTurns` per agent based on subtask complexity and file count instead of static defaults.
- **Orchestration ROI scorecard** -- Post-orchestration summary shows issues caught, files delivered, manual effort estimate, cost vs all-Opus baseline, and routing savings.
- PM Section 39 (Consequence Forecasting)
- 2 new config settings: `contract_strictness`, `enable_consequence_forecast`
- 3 new event schemas: `contract_check`, `consequence_forecast`, `orchestration_roi`
- 42 new tests for `audit-event.js` and `audit-team-event.js` hooks (21 each). All 7 hook scripts now have test coverage.

### Changed
- `command_exits_zero` contract type hardened from freeform command string to indexed enum (1-6). PM selects from a fixed command table instead of composing arbitrary commands.
- PM prompt restructured from monolith to tiered architecture (Tier 0 + Tier 1 + Tier 2). Total content preserved; loading is conditional.
- pm-reference/ expanded from 8 to 20 files with restructured PM sections
- Config defaults now include 37 keys (was 35)
- Reviewer now receives git diff in delegation prompt for focused review
- Agent `maxTurns` set dynamically per-invocation based on complexity
- Section 0 reference updated from "Sections 1-38" to "Sections 1-39"

## [2.0.7] - 2026-04-09

### Added
- **Custom YAML workflows** — Define reusable orchestration sequences in `.orchestray/workflows/*.yaml`. PM auto-matches workflows via `trigger` field or `--workflow` flag. New `/orchestray:workflows` skill for CRUD management.
- **Auto-documenter** — PM automatically spawns documenter agent after feature additions (new files, exports, endpoints). Opt-in via `auto_document` config setting.
- **Monorepo awareness** — Auto-detects monorepo structures (pnpm, lerna, nx, turbo) and scopes agent file ownership to affected packages.
- **Adversarial architecture review** — Two competing architect designs evaluated in parallel for high-complexity tasks (score 8+). Opt-in via `adversarial_review` config setting.
- **Exportable audit reports** — `/orchestray:report --export json|csv` writes machine-readable report files to `.orchestray/exports/`.
- **Cross-project pattern transfer** — `/orchestray:learn export` and `/orchestray:learn import` for sharing patterns between projects.
- **Magic keyword triggers** — Words like "orchestrate", "multi-agent", "use orchestray" automatically trigger orchestration in `complexity-precheck.js`.
- `.gitignore` negation patterns for `team-config.json`, `team-patterns/`, and `workflows/` (version-controlled team files).
- 2 new config settings: `auto_document`, `adversarial_review`
- 1 new skill: `/orchestray:workflows`

### Fixed
- Agent description format now always shows effort level (e.g., `"Fix auth (sonnet/medium)"`) — previously hidden when effort matched model default.
- PM Section 0 reference updated from "Sections 1-34" to "Sections 1-38".
- Magic keyword triggers use word-boundary regex to prevent false positives on conversational text.
- Workflows skill uses `.yaml` extension consistently (matching PM Section 35).
- Report `--export` flag parsing moved to step 1 (before orchestration lookup).
- Learn export confidence threshold corrected from 0.3 to 0.5 (matches minimum creation confidence).

### Changed
- PM prompt expanded from 34 to 38 sections (2,574 → 2,847 lines)
- Config defaults now include 35 keys (was 33, added `auto_document` and `adversarial_review`)
- 15 skills (was 14, added `/orchestray:workflows`)

## [2.0.6] - 2026-04-09

### Added
- **Inventor agent** — 10th core agent. First-principles creation specialist that designs and prototypes novel tools, DSLs, and custom solutions. Includes Phase 5 self-assessment gate (RECOMMEND / DO NOT RECOMMEND) to prevent unnecessary reinvention.
- **Effort/reasoning level routing** — PM assigns `low`/`medium`/`high`/`max` effort alongside model selection. Default mapping: haiku→low, sonnet→medium, opus→high. Configurable via `default_effort`, `force_effort`, `effort_routing`.
- Effort shown in agent descriptions when overridden (e.g., `"Design auth (opus/max)"`)
- Inventor delegation example in delegation-templates.md
- Inventor routing default in scoring-rubrics.md (Opus default, never Haiku)
- Effort assignment section in scoring-rubrics.md with anti-patterns and escalation rules
- `effort_assigned`, `effort_override`, `effort_override_reason` fields in routing_outcome event schema
- 3 new config settings: `default_effort`, `force_effort`, `effort_routing`

### Fixed
- `complexity-precheck.js`: added `process.exit(0)` on early-return paths (hook hung until timeout)
- `install.js`: fixed mergeHooks broken duplicate-detection predicate (both conditions now on same entry)
- `reassign-idle-teammate.js`: added stdout JSON response before exit-code-2 (was missing)
- `collect-agent-metrics.js`: NaN-safe token accumulation with `Number()` coercion
- `collect-agent-metrics.js`: wired to `TaskCompleted` hook for Agent Teams cost tracking (was dead code)
- Report skill now reads both `agent_stop` and `task_completed_metrics` events for cost aggregation
- PM Section 3/13/17/20 incomplete agent enumeration lists (missing refactorer, security-engineer, inventor)
- `pattern-extraction.md`: fixed stale "step 10" reference (actual: step 5)
- `scoring-rubrics.md`: added missing security-engineer routing default (never Haiku)

### Changed
- PM prompt expanded from 34 to 34 sections (2,500 → 2,574 lines); no new section numbers, content added to existing sections
- Config defaults now include 33 keys (was 30, added 3 effort settings)
- 10 core agents (was 9, added Inventor)
- Agent descriptions show effort level when overridden from model default

## [2.0.5] - 2026-04-09

### Added
- **Refactorer agent** — 9th core agent for systematic code transformation without behavior change. Bridges the architect/developer gap with behavioral equivalence verification.
- **Repository map** — compact codebase representation injected into agent prompts, reducing exploration overhead by 60-75%. Per-agent filtering, staleness detection, incremental regeneration.
- **User correction ingestion** — captures direct user corrections as high-confidence patterns. Auto-detection during orchestration, post-orchestration, and manual via `/orchestray:learn correct`.
- **Pattern effectiveness dashboard** — `/orchestray:patterns` shows pattern inventory, application history, confidence trajectories, estimated savings, and actionable recommendations.
- **PR review mode** — `/orchestray:review-pr` reviews GitHub PRs using the reviewer agent. Fetches diff via `gh`, optionally posts findings as review comments.
- **Trajectory analysis** — execution timeline in `/orchestray:report` showing agent sequencing, parallelism, per-agent metrics, and SWE-agent-style insights.
- **Agent description format** — model name shown in background agent UI instead of redundant agent type.
- **Model routing enforcement** — PM must pass explicit `model` parameter on Agent() calls; agents no longer silently inherit parent model.
- 3 new skills: `/orchestray:patterns`, `/orchestray:review-pr`, `/orchestray:learn correct`
- 2 new config settings: `enable_repo_map`, `post_pr_comments`
- PM Section 34 (User Correction Protocol), repo map protocol reference, event schemas for `agent_stop` and `pattern_pruned`

### Fixed
- Agent description bug: background agent UI showed agent type instead of routed model name
- Model routing: agents inherited parent Opus instead of using routed model (now enforced via explicit `model` parameter)
- Double backtick in architect.md line 149 breaking prompt rendering
- `.claude-plugin/` directory missing from package.json `files` array (plugin undiscoverable on npm)
- stdin error handlers added to all 6 hook scripts (was missing on 4)
- install.js banner printed before uninstall check
- install.js missing `'use strict'` directive
- Pricing comment year updated from 2025 to 2026
- Analytics skill step 8 referenced wrong frontmatter field names
- CLAUDE.md missing security-engineer agent and 5 skill commands
- PM Section 17 and Section 13 missing refactorer/security-engineer from agent lists
- Delegation templates missing user-correction and repo map steps
- Learn skill template missing user-correction category
- Report skill missing cross-references to analytics/patterns

### Changed
- PM prompt expanded from 34 to 35 sections (2,330 → ~2,500 lines)
- Config defaults now include 32 keys (was 30)
- Refactorer added to all PM agent lists, routing defaults, and delegation patterns
- Pre-scan (step 2.7) replaced by richer repository map generation

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
