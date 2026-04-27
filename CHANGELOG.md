# Changelog

All notable changes to Orchestray will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [2.2.3] - 2026-04-27

v2.2.3 is the **"v2.2.0 was the design; v2.2.3 is the runtime"** release. v2.2.0 shipped six token-saving features default-on, but production telemetry collected after v2.2.2 showed only one of them was actually firing. This release heals six production-correctness regressions, instruments the rest of the v2.2.0 telemetry path so savings claims become measurable for the first time, expands four leverage features that had been gated on measurement windows, lands the new `pm-router` Haiku entry-point gateway for `/orchestray:run`, and strips the `orchestray-housekeeper` agent that was structurally non-functional. Every shipping item defaults on. Restart Claude Code after upgrading; agent definitions changed.

### Fixed

- **Haiku routing actually works in production for the first time since v2.2.0.** The `haiku-scout` and `orchestray-housekeeper` agents shipped in v2.2.0 with `model: haiku` frontmatter, but two compounding bugs meant the PM never actually delegated to them — they recorded zero spawns across every post-v2.2.0 orchestration. Cause one: the PM's tool allowlist did not list either agent, so the dispatch layer rejected every spawn. Cause two: the model resolver's canonical-agent allowlist excluded all four Haiku-default agents, so even reachable spawns fell through to the global Sonnet default. v2.2.3 fixes both layers, adds a `path_trace` field to the `model_auto_resolved` event so any future bypass is detectable in production telemetry, and ships a one-shot session-start migrator that purges poisoned `routing.jsonl` entries left over from the auto-seed loop. Verification: spawn a Haiku agent without `model:` and observe `model_auto_resolved` with `resolved_model: haiku, source: frontmatter_default`.

- **Cache geometry no longer self-trips on every release.** Every release that added an audit event type regenerated `event-schemas.shadow.json`, which v2.2.0 folded into the prompt-cache zone-1 invariant hash — so each release fired roughly forty `cache_invariant_broken` events and latched the cache-disable sentinel for twenty-four hours. v2.2.3 excludes the shadow file from the zone-1 invariant (it is a derived artifact whose mutation is normal release-time behaviour, not user-content drift the invariant exists to detect), introduces a separate `cache_zone_shadow_regen_observed` event so shadow drift remains observable, and clears the v2.2.2-era stale sentinel so users pay no further self-tripped 24h penalty post-upgrade. Cache-prefix consumers continue to see shadow content embedded in Block-A as before.

- **Pattern-extractor circuit breaker auto-resets after cooldown.** The post-orchestration pattern extractor tripped its circuit breaker once during v2.2.0 setup and never recovered — six `auto_extract_skipped` events all citing `circuit_breaker_tripped`, zero pattern extractions thereafter. v2.2.3 adds an automatic cooldown reset on session start, distinguishes "started" from "failed" via two new audit events (`pattern_extractor_started`, `pattern_extractor_failed`) so future trips name the actual failure rather than hiding it, and clears any stale breaker state on first session post-upgrade. Pattern learning resumes automatically.

- **Phase-slice hook stops emitting noise outside orchestrations.** The phase-slice injector fired on every PM turn — including idle prompts and session starts — and emitted `phase_slice_fallback{reason: "no_active_orchestration"}` events whenever no orchestration was active. Forty-six of forty-eight fallback events in the W3 telemetry sample were this non-actionable noise, drowning the legitimate `unrecognized_phase` and `slice_file_missing:*` signals. v2.2.3 makes the no-orchestration path a silent no-op; only real install faults emit `phase_slice_fallback`. Inject ratio rises from 4% toward 90%+ in healthy installs.

- **Spawn-counter and validator-script failures now surface in telemetry instead of failing silent.** Two long-standing fail-open paths in `bin/inject-delegation-delta.js` (`nextSpawnN` / `peekSpawnN`) returned 1 on `.count` write failure with no event emitted, so a misconfigured filesystem could silently break delta-delegation accounting forever. v2.2.3 adds a new `spawn_counter_write_failed` event preserving the fail-open semantics but making the gap observable. Separately, `bin/validate-task-completion.js` (the T15 validator that gates every agent stop) carried non-ASCII characters from prior edits, exposing a latent tool-compatibility risk; v2.2.3 ASCII-folds the script and adds a CI assertion that prevents future drift.

### Added — telemetry instrumentation (Phase 2)

- **Output-shape token savings now actually measured.** v2.2.0 advertised "−21% Opus output / −14% Sonnet output" but the `output_shape_applied.baseline_output_tokens` and `observed_output_tokens` fields were both `null` on every event since v2.2.2 — savings unverifiable. v2.2.3 emits a paired `output_shape_observed` event from a SubagentStop hook with the real observed token count, populates `baseline_output_tokens` from the role-budget cache (with a `baseline_source` enum naming the lookup path), adds `cap_respected` for at-a-glance bounds checking, and emits `output_shape_observed_pair_missing` when a busy orchestration scrolls past the 32 KB tail-scan window so the silent-loss case is visible. After 14 days of post-ship telemetry, smart-shaping savings will read directly off `/orchestray:analytics`.

- **Repo-map injection observable per-spawn.** v2.1.17 emitted `repo_map_built` once when the map was constructed, but no event tracked whether each agent actually received it on delegation. v2.2.3 adds per-spawn `repo_map_injected` and `repo_map_skipped` events with a new `template_drift` skip reason that detects PM template variations on the canonical `## Repository Map` heading (lower-cased, indented, alternate names like `## Repo Map`). The reviewer audit can now distinguish "map missing because PM template drifted" from "map missing because of a real injection failure".

- **Scout-decision telemetry surfaced for the first time.** A new `bin/track-scout-decision.js` hook fires on every PM Read at or above the 12 KB scout threshold and emits `scout_decision` events naming the four cases (`inline_read_observed`, `scout_spawn_required`, `inline_read_forced`, `exempt_path_observed`). v2.2.3 ships in **warn** mode (signal surfaced, no behaviour break) — block mode promotes in v2.2.4 once the warn-rate distribution is understood. Static exempt-path allowlist covers `.orchestray/state/`, `.orchestray/config.json`, and the Tier-2 reference; current-orchestration KB artifacts are dynamically exempt; foreign-orch artifacts remain enforceable. Per-session escape hatch: `ORCHESTRAY_SCOUT_BYPASS=1`. Disable entirely with `haiku_routing.scout_enforcement: "off"`.

- **Tier-2 schema lookups distinguish real callers from fuzz tests.** Every `tier2_index_lookup` event from a fuzz-suite caller now carries `caller_context: "test_fixture"` while real reviewer-side lookups carry `real_call: true`, so the 0%-found-rate metric is no longer polluted by attack-fuzz traffic. Documentation caveat names the `npm_lifecycle_event === 'test'` ambiguity (e.g., `npm run test:integration` against a live orchestration) with disambiguation guidance.

### Added — leverage features (Phase 3)

- **Eight more agent roles get Anthropic Structured Outputs schema enforcement.** v2.2.0 staged the structured-outputs flip behind a canary allowlist of `[researcher, tester]` only; the eight high-volume hybrid roles (developer, debugger, reviewer, architect, documenter, refactorer, inventor, release-manager) stayed unstructured. v2.2.0–v2.2.2 telemetry on the canary roles confirmed zero T15 rejections, so v2.2.3 expands the allowlist to all eight hybrids using a single shared `HYBRID_ROLE_SCHEMA` that mirrors the universal handoff-contract floor. Per-role optional fields (architect's `design_decisions`, developer's `tests_passing`, etc.) survive via `additionalProperties: true`. Per-role rollback: set `output_shape.staged_flip_allowlist: ["researcher", "tester"]` in `.orchestray/config.json`.

- **Five features default-on (cost budget, disagreement protocol, outcome tracking, checkpoints, adaptive verbosity).** Per project policy that new functionality ships default-on, five gates that were silently `false` in fresh-install configs now seed `true`: `cost_budget_enforcement.enabled`, `enable_disagreement_protocol`, `enable_outcome_tracking`, `enable_checkpoints`, `adaptive_verbosity.enabled` (paired with `v2017_experiments.adaptive_verbosity: "on"` so the AND-gate actually fires). Cost-budget enforcement is a no-op when no caps are configured — installs with `daily_cost_limit_usd: null` see no behaviour change. Users with explicit `false` overrides in `.orchestray/config.json` keep their choice. Upgrade path: post-upgrade sweep updated to seed `enabled: true` for upgraded installs lacking the relevant blocks (closing the regression vector W3 identified).

- **Cache TTL auto-downgrade now actually fires.** v2.2.0's cache manifest contained a TTL-downgrade rule for short orchestrations: when `pm_protocol.estimated_orch_duration_minutes < 25`, slot 1 and slot 2 downgrade from 1h to 5m TTL — saving the 1h-write tax on quick tasks. The reader was correct from day one; nothing on the PM side ever wrote the field. v2.2.3 adds the write step to `phase-decomp` with a calibrated `size × tier × parallelism` formula (XS/S/M/L/XL × haiku/sonnet/opus/xhigh, sequential/parallel groups, clamped 5–480 minutes), a `duration_estimate_method` tag (`calibrated` vs legacy `5 × count` fallback), and a `pm_orch_duration_estimated` audit event so prediction-versus-actual error is visible in `/orchestray:analytics`. Every short orchestration starts paying the cheaper TTL automatically.

- **Role-budget cache auto-refreshes on stale data.** `bin/calibrate-role-budgets.js --emit-cache` already existed but no hook invoked it, so length caps stayed frozen at the v2.1.16 fallback seed forever. v2.2.3 adds a SessionStart hook that runs the calibrator with a new `--if-stale` flag — a no-op when the cache is fresh (< 14 days old) and a refresh-from-real-telemetry pass otherwise. After v2.2.3 ships and a 14-day telemetry window accumulates, `output_shape_applied.baseline_source` flips from `budget_tokens_cache` to `p95_cache` automatically and smart-shaping savings measurement becomes accurate.

### Added — architecture (Phase 4)

- **New `pm-router` Haiku entry-point gateway for `/orchestray:run`.** Trivial single-file tasks (typos, README edits, isolated questions) are now routed through a cheap Haiku-tier `pm-router` agent that solo-handles them end-to-end at roughly 5× input + 5× output discount versus Opus. Complex tasks pay one Haiku classification turn (~$0.001) and escalate to the existing Opus PM unchanged — escalation is transparent: the user sees the same orchestration output as today. The router runs a deterministic 4-signal predicate (hard-decline keywords, hard-escalate keywords, file-count threshold, lite-complexity score) implemented in `bin/_lib/pm-router-rule.js` and mirrored on the prompt side. Default-fallback-to-escalate on any uncertain input — never solo on parse errors. Other slash commands (`/orchestray:resume`, `/orchestray:redo`, `/orchestray:issue`, `/orchestray:review-pr`) bypass the router and continue to invoke the Opus PM directly. **Disable with `pm_router.enabled: false` in `.orchestray/config.json` or `ORCHESTRAY_DISABLE_PM_ROUTER=1` in env** — atomic rollback to direct PM invocation. Conservative cost upside: roughly $0.30/orch saved on the 30% of `/orchestray:run` invocations that solo-handle.

### Removed

- **`orchestray-housekeeper` agent stripped.** Shipped in v2.2.0 to offload three narrow background ops (KB-write verification, schema-shadow regen, telemetry rollup recompute) to Haiku, but in practice the trigger protocol was never wired to actually spawn the agent — zero invocations across all seven post-ship orchestrations. Structural review found the marker-to-spawn routing was never built, the housekeeper's contract (read-only verifier, not delegator) provided much smaller savings than `cost-prediction.md` §32 advertised, and the realistic upside was roughly $0.05/year. Honest closure of a non-functional protocol; the design will be re-introduced in a future release as an explicit MCP tool with verifiable cost telemetry. Removed: agent file, two SubagentStop/SessionStart audit hooks, four frozen test files, four event-schema rows, the §23f marker prose in PM agent and reference, the §32 cost-prediction section, and the `ORCHESTRAY_HOUSEKEEPER_DISABLED=1` kill switch (no longer needed).

- **Hook-superseded PM prose deleted from §9.7, §12.a, and Delegation Delta Pre-Render.** v2.2.0 made these three protocols hook-enforced; the prose stayed in place as the behaviour contract until 14 days of telemetry confirmed the hooks fire on 100% of eligible spawns. The window passed cleanly, so v2.2.3 deletes the redundant prose. Behaviour unchanged — the hook chain has been the source of truth since v2.2.2.

### Changed

- **Reviewer scope validator promoted from observe to warn.** `bin/validate-reviewer-scope.js` shipped in v2.2.2 in observe-only mode after a false-positive fix; a 14-day telemetry window confirmed `reviewer_scope_warn` rate stays under one per 100 reviewer spawns. v2.2.3 promotes the validator from observe to warn (advisory stderr, never blocks). Block (exit-2) mode is the next promotion step in v2.2.4 once warn-mode shipping data confirms the new false-positive floor.

### Migration notes

- **Restart Claude Code after upgrading.** Two agent files change: `pm-router` joins the registry; `orchestray-housekeeper` is removed. Sessions that started before the upgrade will not see either change until restart.
- **All shipping items default on.** A one-time post-upgrade banner names each default-on flip, the kill switch, and any env-var override on first session post-upgrade.
- **`pm-router` is opt-out, not opt-in.** Users who prefer the v2.2.0–v2.2.2 direct-to-PM flow on `/orchestray:run` set `pm_router.enabled: false` in `.orchestray/config.json` or `ORCHESTRAY_DISABLE_PM_ROUTER=1` in env.
- **Block-A prompt-cache hash rotates this release.** The PM agent file changes substantially in this release (housekeeper §23f deletion, pm-router entry-line edits, hook-superseded prose deletion, tools allowlist update). Expect one cold cache fetch on the first orchestration after upgrade; engineered breakpoints re-warm normally afterward.
- **`ORCHESTRAY_HOUSEKEEPER_DISABLED=1` is no longer recognized.** The agent it disabled is removed; the env var is now a silent no-op. Remove from your environment if set.

### Under the hood — hardening / observability

- New audit event types ship in v2.2.3: `pm_router_decision`, `pm_router_complete`, `pm_router_solo_complete`, `output_shape_observed`, `output_shape_observed_pair_missing`, `repo_map_injected`, `repo_map_skipped`, `scout_decision`, `cache_zone_shadow_regen_observed`, `pattern_extractor_started`, `pattern_extractor_failed`, `spawn_counter_write_failed`, `pm_orch_duration_estimated`, `routing_jsonl_migrator_purge`. Schema shadow regenerates in lock-step with the Tier-2 sidecar index; both consumers stay in source-hash agreement.
- Four housekeeper-related event types (`housekeeper_action`, `housekeeper_drift_detected`, `housekeeper_forbidden_tool_blocked`, `housekeeper_baseline_missing`) removed from the schema.
- Section 23 enforcement gate ships in **warn** mode for v2.2.3; promotion to **block** mode planned for v2.2.4 after the 14-day measurement window closes. Telemetry kill-switches preserved separately from enforcement so operators who silence telemetry still hit the enforcement gate (override both with `ORCHESTRAY_SCOUT_BYPASS=1`).
- The post-upgrade banner names every default-on flip with its config key, env-var kill switch, and ship rationale; gated by the standard 7-day upgrade-sentinel TTL so the banner does not repeat across sessions.

### Tests

- **4653 tests / 4652 pass / 1 intentional skip / 0 fail.** Test runtime ~17.6 s.

### Not in this release (with triggers)

- **Block-mode promotion of `validate-reviewer-scope.js` and `track-scout-decision.js`.** Both validators ship in warn mode this release. **Trigger:** 14 days of v2.2.3 telemetry showing warn-rate ≤ 1 per 100 spawns and the exempt-path allowlist confirmed exhaustive.
- **A8 — Batch API for non-interactive subagents.** **Trigger:** Orchestray gains a "background audit" or "scheduled pattern extraction" workflow that consumes the 50% async discount.
- **A6 — Aider-style deterministic edit-applier.** **Trigger:** ≥60 days post-v2.2.0 showing Edit whitespace-mismatch retry rate ≥ 20%.
- **A5 — Adaptive `scout_min_bytes` threshold.** **Trigger:** ≥100 orchestrations of `scout_spawn` telemetry showing distribution bimodality (now collectable post-P0-1).

---

## [2.2.2] - 2026-04-27

v2.2.2 fixes eight telemetry regressions a real-orchestration test surfaced after v2.2.1 shipped. Two new pre-spawn hooks make the smart-output-shaping addendum and the mandatory handoff-contract suffix fire automatically on every `Agent()` spawn — they no longer rely on the orchestrator remembering to inject them. Four parser and regex fixes restore four telemetry signals that were silently broken since v2.2.0. One hook-registration fix removes a 2× duplicate emission on three high-frequency event types. All flags default-on; one new env-var kill switch.

### Fixed

- **Smart output shaping and the handoff contract now fire on every spawn.** In v2.2.0 and v2.2.1, the smart-caveman addendum, the per-role token budget, and the mandatory `## Structured Result` JSON contract suffix were injected by the orchestrator at delegation time. When the orchestrator skipped that step (operator-typed prompts, dense workloads, post-compact recovery), all three silently dropped — and downstream hooks counted the resulting agent responses as contract violations. v2.2.2 moves both injectors into the pre-spawn hook chain so they fire deterministically before every `Agent()` call, regardless of who composed the prompt. Disable with `output_shape.enabled: false`, `pm_protocol.delegation_delta.enabled: false`, `ORCHESTRAY_DISABLE_OUTPUT_SHAPE=1`, or `ORCHESTRAY_DISABLE_DELEGATION_DELTA=1`.

- **Phase-aware reference loading was matching no orchestration files.** The hook that injects the active phase reference into PM turns expected YAML frontmatter, but the orchestrator writes a bold-list format — so every PM turn fell back to the legacy full-file path and the positive-path `phase_slice_injected` event never fired. v2.2.2 teaches the parser both formats; the positive-path event will start firing on your next orchestration.

- **Reviewer scope check was rejecting the project's own house style.** The `reviewer_scope_warn` audit event was firing on every reviewer spawn because the validator's bullet-path regex did not accept paths wrapped in backticks — which is how the orchestrator and operator prompts have always written file references. v2.2.2 makes the backticks optional and recognizes `## Verification` / `### Files to verify` heading-style markers so well-scoped prompts no longer trip the warn.

- **Per-agent model defaults were always falling through to the global default.** The runtime model resolver looked for the wrong frontmatter field name on agent files, so every spawn resolved by the global-default fallback (Sonnet) and `/orchestray:analytics` showed `model_auto_resolved.source` as 100% `global_default_sonnet`. v2.2.2 reads the correct field so per-agent defaults take effect — your Haiku-routed scout and housekeeper spawns now actually run on Haiku.

- **Three high-frequency events were being recorded twice per turn.** v2.2.1 close-out telemetry surfaced apparent 2× inflation on `phase_slice_fallback`, `agent_start`, and `routing_outcome`. The audit-event writer itself was clean; the duplicates came from the phase-slice injector being registered on both `SessionStart` and `UserPromptSubmit` chains and so running twice on every prompt that opened a session. v2.2.2 drops the redundant `SessionStart` registration; only the `UserPromptSubmit` registration remains. **Audit-log comparison gotcha**: pre-v2.2.2 archives are inflated only for those three event types — divide them by 2 when comparing. All other event-type counts in your archive are accurate as recorded.

- **Cost rollup mistook independent re-spawns for mid-run model escalation.** When the same agent role ran two independent tasks in one orchestration (e.g., reviewer in two audit rounds), the cost rollup flagged the second run as a mid-run escalation and tagged the cost as upper-bound. v2.2.2 distinguishes "different spawns of the same role" from "same spawn re-routed mid-run" by deduping on agent ID, not agent type.

- **Cold-start cache validation no longer reports a violation it immediately fixes.** On the first user prompt after a fresh install, the cache-geometry validator ran milliseconds before the cache-geometry writer in the same `UserPromptSubmit` batch and emitted a noisy `cache_invariant_broken` event for a manifest that was about to be created. v2.2.2 emits a distinct `cache_manifest_bootstrap` info event for this case so the rollup no longer counts a non-violation. Cache geometry now self-heals on first session post-install instead of emitting a noisy violation event.

### Migration notes

- **No action required.** All fixes are runtime; no config schema changes; no agent file changes. Restart Claude Code after upgrading per the standard plugin restart protocol.
- **One new env kill switch** (`ORCHESTRAY_DISABLE_OUTPUT_SHAPE=1`) mirrors the existing `ORCHESTRAY_DISABLE_DELEGATION_DELTA=1` for parity.
- **Audit-log comparison gotcha:** the dup-emit pattern affected ONLY three event types (`phase_slice_fallback`, `agent_start`, `routing_outcome`) — not "most events" as initially suspected. The audit-event writer was clean; the dups came from a duplicate hook registration. For fair comparison of pre-v2.2.2 archives against v2.2.2 onward, divide pre-v2.2.2 counts of those three event types by 2; all other event-type counts are accurate as-recorded.

### Under the hood — hardening / observability

- 2 new audit event types ship in v2.2.2: `cache_manifest_bootstrap` and `delegation_delta_skip` — both `version: 1`. Schema shadow regenerated to **118 event types / 5660 bytes** (was 116 / 5538 in v2.2.0; v2.2.1 added zero event types). The Tier-2 schema sidecar index is regenerated alongside.
- Two new `PreToolUse:Agent` hook scripts move the smart-output-shaping addendum and the delegation-delta payload off the orchestrator's prompt-composition path and into the deterministic hook chain. Both follow the established `permissionDecision: allow` + `updatedInput` pattern, and both are fail-open (any hook error passes the original prompt through unchanged).
- The handoff-contract suffix and required-section list are now sourced from a single in-source constant, eliminating drift risk between the three sites that consumed the previously inlined literal.
- A new regression test pins the audit-event writer's per-call contract (1 `writeEvent` call → 1 line) so any future multi-registration regression is caught at unit-test time. Both new injector tests copy the real `event-schemas.md` into their tmpdir and assert that no validation-surrogate events fire.
- **PM prompt prefix hash rotates** from `e068ae0dfab5e752` to `7f43a0b52d169d1b` due to three v2.2.2 marker comments added to `agents/pm.md` (sections 9.7, 12.a, and the Delegation Delta Pre-Render heading) noting that those protocols are now hook-enforced. Expect one cold cache fetch on the first orchestration after upgrade; the engineered breakpoints re-warm normally afterward.

### Tests

- **4424 tests / 4424 pass / 1 intentional skip / 0 fail.**

### Not in this release (with triggers)

- **Delete the v2.2.0 PM prose for the three protocols now hook-enforced (sections 9.7 / 12.a / Delegation Delta Pre-Render).** The prose stays in place as the behavior contract until 14 days of orchestration telemetry confirm the hooks fire on 100% of eligible `Agent()` spawns. **Trigger:** `output_shape_applied` count matches eligible-spawn count AND `delegation_delta_emit` count matches the expected first-spawn-vs-delta distribution across a 14-day window.
- **Promote `validate-reviewer-scope.js` from warn to exit-2.** The fix in this release lowers the false-positive rate but cannot prove the new floor without telemetry. **Trigger:** 14 days of v2.2.2 telemetry showing `reviewer_scope_warn` rate ≤ 1 per 100 reviewer spawns.

---

## [2.2.1] - 2026-04-27

v2.2.1 fixes three regressions in v2.2.0 that disabled most installs' cache geometry and housekeeper agent. v2.2.1 ships an automatic post-upgrade cleanup so users are healed on first session — no manual action required.

### Fixed

- **Engineered cache geometry was self-disabling permanently.** v2.2.0's invariant validator wrote an `auto-disabled` sentinel on the first false-positive trip with no recovery path; once tripped, cache geometry never came back. v2.2.1 adds a 1-hour TTL and trip-counter; the sentinel re-arms automatically if the invariant recovers, and the post-upgrade migration clears stale v2.2.0 sentinels on first session.

- **Housekeeper agent reported missing for global-scope installs.** v2.2.0's drift hook only looked at one agent path, so installs using the recommended user-scope (`~/.claude/agents/`) saw `agent_file_missing` and quarantined the housekeeper before it ever spawned. v2.2.1 resolves the agent through the same project → user → plugin priority order Claude Code uses, and clears stale quarantine files on first session.

- **`feature_gate_eval` audit events were silently underreporting v2.2.0 gates.** The telemetry walker only knew about top-level `enable_*` keys, so `output_shape.enabled`, `caching.block_z.enabled`, `haiku_routing.enabled`, and five more were invisible in `/orchestray:analytics` snapshots. v2.2.1 walks the config tree for any `<namespace>.enabled` leaf and surfaces all of them.

### Migration notes

- **No action required.** First session post-upgrade auto-clears stale sentinels and quarantine markers. A one-line banner names what was cleared.
- **No flag changes.** All v2.2.0 default-on flips remain default-on.

---

## [2.2.0] - 2026-04-27

v2.2.0 is the **"Tokens, not Actions"** release — Orchestray's first major bump in the v2.x line. Nine shipping items reshape how Orchestray pays for the prompt prefix it sends to Claude on every turn: agents narrate less, the PM stops re-reading the largest reference file, stable prefixes anchor in Anthropic's 1-hour cache, and trivial file I/O moves off Opus onto Haiku. Two new agents ship (`haiku-scout` and `orchestray-housekeeper`) plus six new feature areas — every flag default-on, every behavior change with a kill switch. Headline savings: roughly **−18% to −33% per orchestration** (mid-range −22%; multi-round audits land at the upper end). Numbers are directionally correct, magnitude-uncertain until your own telemetry accumulates — see `/orchestray:analytics` for your install. Restart Claude Code after upgrading; agent definitions changed.

### Added

- **Smart output shaping for prose-heavy agents.** Debugger, reviewer, and documenter answers stop hedging and using pad-words; the structured-result JSON they emit is unchanged. On a public April-2026 benchmark this delivered roughly −21% Opus output and −14% Sonnet output with 100% accuracy retained. A short prompt addendum, per-role length caps, and Anthropic's native Structured Outputs compose into a single decision module. Default on; disable with `output_shape.enabled: false`.

- **Chunked schema lookup for the largest reference file.** Orchestray no longer reads the 186 KB event-schemas reference on every orchestration that touches event emission. A small fingerprint replaces the full file, and a new `mcp__orchestray__schema_get` MCP verb returns the specific 200–600-token chunk you need on demand. The full-file Read path is blocked by default; restore legacy behavior with `event_schemas.full_load_disabled: false`.

- **Engineered prompt-cache geometry.** Stable prompt prefixes now anchor on a byte-stable Block-Z header backed by a deterministic 4-slot cache-control manifest with TTL auto-downgrade for short orchestrations. Back-to-back orchestrations within the hour pay 90% less for the shared overhead. Default on; disable with `caching.block_z.enabled: false` or `caching.engineered_breakpoints.enabled: false`.

- **Haiku scout for large file recon.** A new read-only `haiku-scout` agent (Read, Glob, Grep only — no Edit, no Write, no Bash) takes care of file recon at and above the 12 KB threshold. The PM keeps Opus 4.7 for orchestration decisions; the I/O wrapper moves down-tier. Three-layer tool-whitelist enforcement: declarative frontmatter, runtime rejection, and a CI test that fails on any unsanctioned mutation. Default on; disable with `haiku_routing.enabled: false`.

- **Background-housekeeper Haiku.** A new read-only `orchestray-housekeeper` agent (Read, Glob only — stricter than scout) handles three narrow background ops: knowledge-base write verification, schema-shadow regen, and telemetry rollup recompute. Per-action audit telemetry, a drift detector that fails closed on any unsanctioned mutation of the agent's tool whitelist, and three independent kill switches (env var, config flag, and runtime sentinel). Default on; disable with `haiku_routing.housekeeper_enabled: false` or `ORCHESTRAY_HOUSEKEEPER_DISABLED=1`. Promoting the housekeeper to broader tools requires an explicit tagged commit cycle in a future release — the narrow whitelist is intentional.

- **Deterministic helpers replace inline Bash for routine probes.** Five common probes — file-exists, line-count, git-status, schema-validate, hash-compute — now run as a deterministic helper with zero LLM cost, replacing the inline Bash calls the PM used to issue for these checks. The new `ox sentinel` CLI exposes the same helpers for ad-hoc use. No flag; this is a correctness and cost lever, not a behavior change.

- **Audit-round auto-archive for multi-round orchestrations.** When a ship-blocker audit runs three or more rounds, completed rounds are automatically distilled into a compact 500-token digest in the active prompt; the verbatim findings stay in the audit log for replay. Default on; disable with `audit.round_archive.enabled: false`.

- **Delta delegation for repeat agent spawns.** Within an orchestration, the first spawn of an agent gets the full delegation prompt; subsequent spawns of the same agent get a prefix reference plus a small delta block. Hash-anchored re-emission triggers automatically on prefix mismatch so cache misses self-heal. Default on; disable with `pm_protocol.delegation_delta.enabled: false` or `ORCHESTRAY_DISABLE_DELEGATION_DELTA=1`.

### Changed

- **Telemetry truth — three correctness fixes that change what `/orchestray:analytics` shows.** The `agent_metrics.jsonl` file no longer carries the ~59% duplicate rows that v2.1.x cost rollups silently double-counted (cost reports for new orchestrations will be lower because the duplication is gone, not because spending dropped). Agent Teams team-member spawns are now priced at their real model rate instead of defaulting to Sonnet. PM-direct token cost is now visible in the metrics dashboard for the first time. Historical rollups stay at the old values; only new orchestrations reflect the corrected accounting.

- **`event_schemas.full_load_disabled: true` is the new default.** Reading `agents/pm-reference/event-schemas.md` as a single file is blocked from the PM's chunked path. Use `mcp__orchestray__schema_get` for targeted lookups, or set `event_schemas.full_load_disabled: false` to restore legacy full-file Read.

### Migration notes

**Restart Claude Code after upgrading.** Two new agents (`haiku-scout`, `orchestray-housekeeper`) join the registry. Claude Code loads agent definitions at session start and caches them — running sessions will not see the new agents until restart.

**All nine shipping items default on.** A one-time post-upgrade banner names each default-on flip and the kill switch on first session post-upgrade. Every change has a `.enabled` setting in `.orchestray/config.json` and where applicable an `ORCHESTRAY_<NAME>_DISABLED=1` environment-variable override.

**`event_schemas.full_load_disabled: true` is binding by default.** If a downstream agent or skill reads `event-schemas.md` as a whole file today, it will see a structured rejection on first try post-upgrade. Switch to `mcp__orchestray__schema_get` (returns specific chunks) or set `event_schemas.full_load_disabled: false` to restore the legacy Read path.

**Haiku scout and housekeeper are read-only by design.** `haiku-scout` ships with `tools: [Read, Glob, Grep]` only; `orchestray-housekeeper` ships with `tools: [Read, Glob]` only. Both have three-layer tool-whitelist enforcement and a frontmatter-byte-equality CI test that fails on any unsanctioned mutation. Promoting either to broader tools requires an explicit tagged commit cycle — this is the lifecycle the project committed to in v2.2.0 scope.

### Under the hood — hardening / observability

- 21 new audit event types ship in v2.2.0, all carrying `version: 1`. Schema shadow regenerated to **116 event types / 5538 bytes** (was 92 / 4411 in v2.1.17). A new tier-2 sidecar index (`event-schemas.tier2-index.json`) keeps the chunked schema lookup honest at 56 KB / ~3,200 fingerprint tokens — the chunked path is the only path; full-file Read is disabled by default.
- A pinned Block-A hash (`e068ae0dfab5e752`) anchors the prompt prefix that agents see. Any drift in `agents/pm.md`'s Block A is caught at test time before it can reach Anthropic's cache layer.
- Three new top-level config blocks (`pm_protocol`, `event_schemas`, `output_shape`) plus the existing `caching`, `haiku_routing`, and `audit.round_archive` blocks are registered in the boot-time config-drift detector. Fresh installs see zero "unknown top-level key" warnings.
- The post-upgrade banner names all nine default-on flips with their config keys and env-var kill switches; gated by the standard 7-day upgrade-sentinel TTL so the banner does not repeat across sessions.
- Net **+341 tests** across the release (P1.1: 12, P1.2: 32, P1.3: 41, P1.4: 28, P2.1: 27, P2.2: 24, P3.1: 14, P3.2: 14, P3.3: 23, plus cross-phase fixpass and regression suites).

### Tests

- **4316 tests / 4316 pass / 1 intentional skip / 0 fail.** Test runtime ~17 s.

### Not in this release (with triggers)

- **Adaptive scout-byte threshold.** Today the scout fires at a fixed 12 KB. **Trigger:** 30 days of v2.2.0 telemetry showing the threshold misclassifies more than 5% of Class-B operations.
- **Repo-map pin per orchestration.** v2.2.0 ships the repo map at session scope; per-orchestration pinning is deferred. **Trigger:** measured cache-thrash on long orchestrations that span multiple feature surfaces.
- **Haiku PM-router gateway.** The PM's reasoning model stays Opus; only its file I/O wrapper moved down-tier. **Trigger:** v2.2.0 telemetry confirms the Class-B routing rule holds and a measured cost hotspot remains in PM reasoning.
- **Aider-style deterministic edit-applier.** Strong but it's an output offload, not a token-reduction lever, and conflicts on schedule with v2.2.0 cache geometry. **Trigger:** v2.2.1 schedule.
- **Batch API for non-interactive subagents.** 50% async discount available, but routing logic is non-trivial. **Trigger:** v2.2.x cycle once the v2.2.0 baseline measurement window closes.
- **`count_tokens` pre-spawn budget gate.** Hard pre-spawn token caps remain soft-warn in v2.2.0. **Trigger:** measured oversized-spawn rate above the v2.1.16 budget-warn baseline.

---

## [2.1.17] - 2026-04-26

v2.1.17 is the "discharge the carryover backlog" release. Four items deferred from v2.1.16 ship together: the full Aider-style repo map (replacing the recipe stub from v2.1.16), and three telemetry signals — documenter spawn-frequency, archetype cache hit-rate, and reviewer dimension adoption — that close the measurement loop on three v2.1.16 defaults so v2.1.18 can flip them with evidence rather than guesswork. No user-facing config defaults change behavior; one new default-on config block (`repo_map`) ships pre-configured. 5 R-items shipped. 3975/3975 tests pass.

### Added

- **Aider-style repo map for code-aware agents.** When the developer, reviewer, refactorer, or debugger is spawned to touch code, Orchestray now sends a focused repo map — symbol declarations and reference graph extracted with tree-sitter, ranked by graph-PageRank, fit to a per-role token budget — instead of dumping whole files into the prompt. The agent sees the most-relevant symbols across the repository, not a flat file listing. Per-role budgets default to: developer 1500 tokens, refactorer 2500, reviewer 1000, debugger 1000. Six languages ship with bundled tree-sitter grammars: JavaScript, TypeScript, Python, Go, Rust, and Bash. The map is cached on git blob SHA + grammar manifest so unchanged files never re-parse. Default on; disable with `repo_map.enabled: false` in `.orchestray/config.json`.

- **Documenter spawn analytics.** `/orchestray:analytics` now reports how often the documenter agent has been auto-spawned post-orchestration over the last 14 days. This is the measurement window for v2.1.16's `auto_document: false` default — if the rollup shows zero documenter spawns and zero reviewer-flagged docs drift, the default flip is validated; if drift is appearing without doc updates, you have a signal to flip `auto_document` back on.

- **Archetype cache hit-rate analytics.** `/orchestray:analytics` now reports archetype cache hit-rate (hits vs misses) across recent orchestrations. The new `archetype_cache_miss` event makes the miss path visible for the first time — until v2.1.17, only the hit path emitted, so the hit-rate denominator was unmeasurable. The 30-day measurement window gates the v2.1.18 R-SEMANTIC-CACHE deferral trigger named in v2.1.16.

- **Reviewer dimension adoption telemetry.** `/orchestray:analytics` now reports the share of reviewer spawns whose delegation prompt carried an explicit `## Dimensions to Apply` block, parsed from the spawn's prompt context. This is the trigger metric for v2.1.16's R-RV-DIMS scoped-by-default plan: once adoption clears 60% over a 14-day window with no correctness regression, v2.1.18 flips the back-compat `"all"` default to scoped-by-default.

### Changed

- **`repo_map.enabled: true` is the new default for fresh installs.** The v2.1.16 stub recipe in `agents/pm-reference/repo-map-protocol.md` is replaced with a working call-site invoked by the PM in Section 3 step 9.6 for code-touching spawns. The legacy 388-line heuristic file remains available as `repo-map-protocol.md.legacy` for one more release. To opt out, set `repo_map.enabled: false`.

- **`agent_start` audit event schema bumped v1 → v2 (additive).** Reviewer spawns whose delegation prompt includes a `## Dimensions to Apply` block now record the parsed dimensions in a new optional `review_dimensions` field. The bump is additive — analytics consumers that ignore unknown fields keep working unchanged. All other agent types emit `agent_start` v2 with the field absent.

### Under the hood — hardening / observability

- 4 new audit event types for repo-map observability (`repo_map_built`, `repo_map_parse_failed`, `repo_map_grammar_load_failed`, `repo_map_cache_unavailable`) plus 1 (`archetype_cache_miss`) plus 1 (`staging_write_failed`, observability for the reviewer-dimension prompt-staging cache — emitted on read/write/update/delete failure paths in `bin/_lib/context-telemetry-cache.js` and `bin/collect-context-telemetry.js`; closes the silent-failure observability gap noted in pre-ship audit). All carry `version: 1` per R-EVENT-NAMING. Schema in `agents/pm-reference/event-schemas.md`.
- Schema shadow regenerated: 92 events / 4411 bytes (was 83 / 4052 in v2.1.16).
- Swept 33 stale `tier1-orchestration.md` references in `agents/pm.md` to point at the v2.1.15 phase-split files (`phase-contract.md` / `phase-decomp.md` / `phase-execute.md` / `phase-verify.md` / `phase-close.md` / `tier1-orchestration-rare.md`). Closes the v2.1.15 stub-split documentation drift; the legacy file remains preserved at `tier1-orchestration.md.legacy` for one more release.
- `bin/_lib/repo-map.js` plus four helpers (`repo-map-graph.js`, `repo-map-cache.js`, `repo-map-render.js`, `repo-map-tags.js`) and a grammar manifest with six bundled WASM parsers under `bin/_lib/repo-map-grammars/`.
- PM call-site instructions in `agents/pm.md` Section 3 step 9.6 invoke the repo-map CLI on code-touching spawns and route the rendered map into the delegation prompt.
- `graphology-pagerank` (deprecated upstream) replaced with `graphology-metrics/centrality/pagerank`.
- New parser `bin/_lib/extract-review-dimensions.js` reads the reviewer delegation prompt for the `## Dimensions to Apply` block and surfaces the result on `agent_start` v2 events.
- Three new `/orchestray:analytics` rollups: documenter spawn frequency (rollup E), archetype cache hit-rate (rollup F), and reviewer dimension adoption (rollup G).
- New `NOTICE` file at the repo root attributes the six Aider `.scm` query files (Apache-2.0) and the bundled tree-sitter WASM grammars; in-file header comments on each `.scm` file already cited the Aider source.
- 56 new tests across the release: R-AIDER-FULL ~25, R-DOCUMENTER-EVENT 11, R-ARCHETYPE-EVENT 17, R-RV-DIMS-CAPTURE 15, plus three W10 sweep files (~46 tests across coverage gaps) and ~5 W11-fix parallel-spawn regressions.

### Migration notes

**`repo_map.enabled: true` is on by default for fresh installs.** The bundled tree-sitter grammars add roughly 5–6 MB to your `node_modules/web-tree-sitter` footprint (one-time on-disk cost, lazy-loaded only when the map is first built). The on-disk cache lives at `.orchestray/state/repo-map-cache/` and is gitignored. To disable, set `repo_map.enabled: false` in `.orchestray/config.json` — no session restart needed. To restrict the languages parsed, edit `repo_map.languages` (default `["js", "ts", "py", "go", "rs", "sh"]`).

**`agent_start` event schema bumped v1 → v2 (additive).** External analytics consumers that read `agent_start` rows from `.orchestray/audit/events.jsonl` will see an optional `review_dimensions` field on reviewer spawns whose delegation included a dimensions block. Old consumers that ignore unknown fields require no changes. The `version: 1` rows already in your archive remain readable; the schema shadow validator accepts both versions.

### Not in this release (with triggers)

- **Compact-pattern-catalog default for the remaining 7 agents.** v2.1.16 covered the 5 busiest (pm, architect, developer, reviewer, debugger). **Trigger:** `pattern_read_warn_zero` event rate stays at zero across 14 days on the v2.1.16 rollout — earliest fire date 2026-05-09.
- **Reviewer scoped-by-default flip (Phase 2).** **Trigger:** ≥60% of v2.1.17 reviewer spawns carry an explicit `review_dimensions` field across a 14-day window — measurable as of v2.1.17 via the new R-RV-DIMS-CAPTURE adoption rollup.
- **LLMLingua-2 prose compression.** Trigger unchanged from v2.1.16: `@atjsh/llmlingua-2` ships v3.x with documented production deployments, OR a measured prose-dominated cost hotspot emerges. The npm port has not advanced in this cycle.
- **Local semantic cache for archetype matching.** **Trigger:** archetype cache hit-rate ≤30% on the existing string-match path for 30+ days (now measurable via the v2.1.17 R-ARCHETYPE-EVENT rollup), AND pattern corpus exceeds 200 patterns (currently ~40), AND the embedded path beats the string path by ≥2K tokens/orch in measured savings.
- **Anthropic-recipe contextual retrieval.** Trigger unchanged: KB artifact count exceeds 1,000 files (currently 432) OR `kb_search` recall-at-top-3 drops below 80% in a measured audit OR the pattern corpus exceeds 500.

### Tests

- **3975 tests / 3975 pass / 0 fail.** Net +124 tests across the release.

---

## [2.1.16] - 2026-04-25

v2.1.16 is the "carryover discipline + telemetry fill" release. It discharges four turnkey defaults that have been deferred across v2.1.13/14/15 — reviewer dimension scoping, compact pattern catalog by default for the busiest agents, `auto_document` flipped off, and Agent Teams flagged opt-in with the missing idle-teammate hook — and closes the three telemetry gaps v2.1.15 left open so the per-orchestration token-ceiling claims become verifiable. Two user-facing defaults change (`auto_document: false`, `agent_teams.enabled: false`); both come with one-line restore steps. 7 R-items shipped. 3851/3851 tests pass.

### Added

- **Compact pattern catalog by default for the five busiest agents.** PM, architect, developer, reviewer, and debugger now ask for a compact pattern catalog by default and fetch the full pattern body only when the catalog signal looks relevant (confidence ≥ 0.6, has been applied at least once, and the one-line description matches the task). Most pattern lookups now use roughly half the tokens of v2.1.15 with no setup from you. Reviewer keeps full-body access when auditing pattern accuracy itself. The full-body path is one explicit call away when an agent needs it. Soft-audit hook (`pattern_read_warn_zero` from v2.1.14) detects under-fetch at runtime; reviewer's correctness pass catches any regression. Kill switch: `catalog_mode_default: false` in `.orchestray/config.json` reverts the prompt-level default for new pattern queries.

- **Scoped reviewer dimensions.** Reviewers now focus on the dimensions that actually apply to your change — a documentation-only diff gets a documentation-focused review, a UI/CLI tweak gets code-quality + documentation + operability, a backend API change gets code-quality + performance + operability + api-compat — saving roughly 2–5K tokens per orchestration. **Correctness and Security run on every review** regardless of scope; the PM cannot skip them. Default is `review_dimensions: "all"` for back-compat — explicit scoping is opt-in this release and becomes the default in v2.1.17 once compliance data accumulates. Kill switch: `review_dimension_scoping.enabled: false`.

- **Live per-role context budgets.** v2.1.15 shipped the budget hook and 15 per-role defaults but the PM did not yet stamp every spawn with a context size — so the hook ran dormant. v2.1.16 wires `context_size_hint` into every `Agent()` spawn from PM delegation templates, and `bin/preflight-spawn-budget.js` now reads the live `.orchestray/state/role-budgets.json` file (with fallback to the static defaults when absent). Warnings stay soft; turn on hard-block via `budget_enforcement.hard_block: true` if you want the hook to refuse oversized spawns. Initial calibration uses fallback values pending 14 days of telemetry — the file recalibrates automatically once samples accumulate.

- **Phase slice load telemetry (positive path).** The `/orchestray:analytics` dashboard now shows how often phase-scoped reference loading actually fires (positive-path) versus falls back to the legacy file — confirming the v2.1.15 ~21K-tokens-per-turn savings claim is being realized on your install. New event `phase_slice_injected` (paired with the existing `phase_slice_fallback`); rollup line in the analytics view shows the injected/fallback ratio. Read-only telemetry, additive only. Kill switch: `phase_slice_loading.telemetry_enabled: false`.

- **Agent Teams decision protocol.** Agent Teams ships as a documented experimental feature with a use-case protocol naming the three conditions for using teams (≥ 3 independently-parallel tasks needing inter-agent messaging during execution; cross-layer changes where teammates own different layers; research-divergent investigations with competing hypotheses), the missing `bin/reassign-idle-teammate.js` hook so an idle teammate with remaining tasks gets redirected instead of allowed to stop, and a default-off gate. Turn it on with `agent_teams.enabled: true` AND `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` when your task fits the protocol. Both the config flag and the env var must be true to spawn a team; missing either keeps teams off.

### Changed

- **`auto_document` default flipped to `false`.** The auto-documenter post-orchestration trigger is now off by default. The reviewer's documentation pass already audits docs drift on every orchestration, making the auto-spawn redundant insurance on typical workloads. **Restore the v2.1.15 behavior** by setting `"auto_document": true` in `.orchestray/config.json`. Existing users with `"auto_document": true` already in their config keep their behavior; only implicit defaults flip. A one-time post-upgrade banner names the flip and the restore step.

- **`enable_agent_teams` renamed to `agent_teams.enabled` and default flipped to `false`.** The legacy `enable_agent_teams` key is honored for one release with a deprecation warning. Implicit defaults flip from on to off; explicit `enable_agent_teams: true` is migrated to `agent_teams.enabled: true` on first session post-upgrade. The double-gate (config flag AND `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var) is required to spawn teams. A one-time post-upgrade banner names the rename, the default flip, and the dual-gate requirement.

- **Repo-map protocol replaced with a recipe stub.** The 388-line hand-rolled file-list-and-heuristic ranking implementation in `agents/pm-reference/repo-map-protocol.md` is replaced with a concise stub recipe that names the canonical algorithm (tree-sitter tag extraction → reference graph → graphology-pagerank → fit-to-token-budget) and the v2.1.17 architect spike that will implement it. The legacy file is preserved as `repo-map-protocol.md.legacy` for one release.

### Under the hood — hardening / observability

- One new audit event type: `phase_slice_injected` (positive-path companion to `phase_slice_fallback`). All carry `version: 1` per R-EVENT-NAMING. Schema in `agents/pm-reference/event-schemas.md`.
- Schema shadow cap raised 4096 → 8192 bytes; `event-schemas.shadow.json` now 83 events / 4052 bytes (up from 81/3966 in v2.1.15).
- Boot-time config drift detector recognizes 11 newly-registered config keys: the v2.1.16 additions (`catalog_mode_default`, `review_dimension_scoping`, `phase_slice_loading`) plus a carryover-discipline cleanup of 5 v2.1.14/15 keys that shipped without drift-list entries (`delta_handoff`, `feature_demand_gate`, `role_budgets`, `budget_enforcement`, `curator_slice_loading`). Fresh-install users no longer see boot-time "unknown config key" warnings for valid shipped keys.
- New PM classifier `bin/_lib/classify-review-dimensions.js` deterministically picks reviewer dimensions from changed-file paths across five archetypes (doc-only, UI/CLI including `agents/*.md` and `skills/**/SKILL.md`, backend API, security-touched, default fallback).
- New script `bin/calibrate-role-budgets.js` produced `.orchestray/state/role-budgets.json` (fallback values seeded; recalibrates automatically after 14 days of telemetry).
- New hook `bin/reassign-idle-teammate.js` registered for the `TeammateIdle` event; redirects idle teammates with remaining tasks instead of allowing stop. Falls back to allow-stop when no remaining work.
- New one-shot script `bin/backfill-pattern-context-hooks.js` ships ready-to-run; uses Haiku to generate the `context_hook` field on existing patterns whose frontmatter lacks one. Idempotent and dry-run-verified.
- New Tier-2 reference `agents/pm-reference/agent-teams-decision.md` (~85 lines) names the three use-case conditions and three anti-conditions for Agent Teams; cited from `agents/pm.md` Section 22.
- 31 new tests across the release: R-RV-DIMS classifier and split (11), R-PHASE-INJ event emission and analytics (6), R-BUDGET preflight + live-file readback (5), R-AT-FLAG decision-doc + TeammateIdle handler (5), W12-fix regressions (~7) including the lone-`agents/*.md` classifier case, post-upgrade `runRAtFlagMigration` 6-case suite, and the `phase_slice_loading.telemetry_enabled` zod schema field.

### Migration notes

**`auto_document` default flip — action required if you relied on auto-doc generation**

If you have not set `auto_document` in `.orchestray/config.json`, the auto-documenter post-orchestration trigger is now OFF on your next orchestration under v2.1.16. The reviewer's documentation dimension still runs on every review and surfaces docs drift there. You will see this one-time stderr banner on your first session post-upgrade:

```
[orchestray] v2.1.16 R-AUTODOC-OFF: auto_document default flipped from true to false.
[orchestray]   The auto-documenter post-orchestration trigger is now off by default.
[orchestray]   The reviewer's documentation dimension already audits docs drift on every orchestration.
[orchestray]   To restore the v2.1.15 behavior:
[orchestray]   set `"auto_document": true` in `.orchestray/config.json`.
```

To restore v2.1.15 behavior, set `"auto_document": true` in `.orchestray/config.json`. Existing users with explicit `"auto_document": true` in config keep that setting unchanged.

**`enable_agent_teams` rename + default flip — action required if you relied on Agent Teams**

The `enable_agent_teams` config key is renamed to `agent_teams.enabled` for namespace consistency. The legacy key is honored for one release with a deprecation warning. The default flips from `true` (v2.1.15) to `false` (v2.1.16) — Agent Teams is token-negative on most workloads, and v2.1.16 ships it as a documented experimental opt-in rather than an implicit default.

If you had `enable_agent_teams: true` in v2.1.15, the v2.1.16 post-upgrade sweep migrates that to `agent_teams.enabled: true` automatically; your behavior is preserved. If you were on the implicit v2.1.15 default, Agent Teams is now off — to re-enable, both of these must be true:

1. `agent_teams.enabled: true` in `.orchestray/config.json`
2. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your environment or `settings.json`

You will see this one-time stderr banner on your first session post-upgrade:

```
[orchestray] v2.1.16 R-AT-FLAG: enable_agent_teams renamed to agent_teams.enabled; default flipped to false.
[orchestray]   Existing `enable_agent_teams: true` is migrated to `agent_teams.enabled: true` automatically.
[orchestray]   To enable Agent Teams from a fresh default:
[orchestray]     1) set `"agent_teams": { "enabled": true }` in `.orchestray/config.json`
[orchestray]     2) set `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in your environment or settings.json
[orchestray]   Read `agents/pm-reference/agent-teams-decision.md` for the three use-case conditions.
```

Read `agents/pm-reference/agent-teams-decision.md` for the three use-case conditions before enabling.

### Not in this release (with triggers)

- **LLMLingua-2 prose compression** — defer on technical grounds. The `@atjsh/llmlingua-2` JS port ships once every 6–9 months and has no production deployments verifiable in 2026-Q1; residual headroom on top of v2.1.14 R-DELTA-HANDOFF is only ~2–4K tokens/orch. **Trigger:** `@atjsh/llmlingua-2` ships v3.x with documented production deployments, OR a measured hotspot emerges where agent-produced free-form prose dominates cost.
- **Local semantic cache for archetype matching** — defer on technical grounds. 2026-Q1 production hit-rates have been downrated from 60–70% to 20–45%; vCache (Feb 2026) shows similarity-distribution overlap between correct and incorrect hits. **Trigger:** archetype cache hit-rate telemetry (added in v2.1.17) shows ≤ 30% on the existing string-match path for 30+ days AND pattern corpus exceeds 200 patterns (currently ~80) AND a measured-savings analysis shows the embedded path beats the string path by ≥ 2K tokens/orch.
- **Anthropic-recipe contextual retrieval over KB / pattern store** — defer on technical grounds. Local OSS rerankers are now ONNX-deployable in Node, but the full pipeline is L-effort and the corpus is small enough that brute-force Grep+Read remains competitive. **Trigger:** KB artifact count exceeds 1,000 files OR `kb_search` recall-at-top-3 drops below 80% in a measured audit OR the pattern corpus exceeds 500.
- **Full Aider repo-map implementation (tree-sitter + PageRank)** — defer to v2.1.17. v2.1.16 ships only the recipe stub. **Trigger:** v2.1.17 architect spike (own design pass for tree-sitter integration, language-grammar bundling, graph cache invalidation, cross-platform native-dep testing).
- **Documenter spawn-frequency telemetry, archetype cache hit-rate telemetry** — defer to v2.1.17, paired with the reviewer-scoped-by-default measurement window. Together they let v2.1.17 close the loop on R-AUTODOC-OFF effectiveness and R-RV-DIMS phase 2.
- **Catalog mode default for the remaining 10 agents** — v2.1.16 covers the 5 busiest (pm, architect, developer, reviewer, debugger). **Trigger:** v2.1.16 measurement period shows the `pattern_read_warn_zero` event rate at 0 across 14 days on the first 5-agent rollout.
- **Reviewer scoped-by-default flip** — v2.1.16 ships back-compat default `"all"` for unspecified spawns. **Trigger:** ≥ 60% of v2.1.16 reviewer spawns carry an explicit `review_dimensions` field in delegation AND no correctness-class regression vs the v2.1.15 baseline.

### Tests

- **3851 tests / 3851 pass / 0 fail.** Net +58 tests across the release (R-RV-DIMS 11, R-PHASE-INJ 6, R-BUDGET 5, R-AT-FLAG 5, W12-fix regressions ~7, post-upgrade R-AT-FLAG migration 6, plus reviewer-dimension-routing and i-phase-gate extensions). No deletions.

---

## [2.1.15] - 2026-04-25

v2.1.15 turns Orchestray's v2.1.14 observability investment into active token savings. Three improvements land in parallel: the feature-demand gate — which observed quietly since v2.1.14 — now activates automatically and starts skipping unused feature protocols; the main orchestration reference file splits into phase-scoped slices so only the section relevant to your current work stage loads; and handoffs between agents shrink to a summary-plus-changes format instead of the full prior artifact. Together, these reduce the typical per-orchestration token ceiling from ~120,000 to a target of 70–80,000. Every change ships with a kill switch, an opt-out path, and an audit gate. 7 R-items shipped. 3793/3793 tests pass.

**Token savings summary:** ~28,000 tokens/orchestration from auto-quarantine (R-GATE-AUTO), ~16,800 from delta handoffs (R-DELTA-HANDOFF), ~21,000 per turn from phase slice loading (I-PHASE-GATE), ~8,600 per curator spawn from curator slice loading (R-CURATOR-SPLIT). Total projected ceiling: ~70K (down from ~120K in v2.1.14).

### Added

- **Automatic feature-protocol quarantine (R-GATE-AUTO).** Starting in v2.1.15, Orchestray automatically skips feature protocols that haven't been used on your repo in the past 14 days. You'll see a session-start banner naming any protocols that were skipped. To re-enable any one, run `/orchestray:feature wake <name>` for the current session or `/orchestray:feature wake --persist <name>` to keep it active across sessions. Saves ~28,000 tokens per orchestration on repos with multiple feature flags active. See migration note below.

- **Delta handoffs between agents (R-DELTA-HANDOFF).** When Orchestray re-delegates work to a developer after a reviewer pass, it now sends only the reviewer's summary, findings, and a diff of what changed — not the entire prior artifact. The full artifact stays in the knowledge base and any agent can fetch it on demand if needed. Saves ~16,800 tokens per medium-complexity orchestration. Kill switch: `delta_handoff.enabled: false` in `.orchestray/config.json`.

- **Per-role context-size budgets (R-BUDGET).** Before spawning any agent, Orchestray checks whether the total context it's about to send exceeds that role's budget. If it does, it shows a plain-language warning in the session log. The initial budgets cover all 15 agent roles and are soft-enforce only (warn, not block) for the first 14 days — they tighten automatically once telemetry accumulates. Hard-block mode opt-in: `budget_enforcement.hard_block: true`. Kill switch: `budget_enforcement.enabled: false`. Note: live size-hint wiring (the mechanism that makes the hook fire on every spawn) ships in v2.1.16 — until then, only spawns whose delegation context explicitly carries `context_size_hint` will generate warnings. The hook, schema, and 15 per-role budgets are all live in v2.1.15.

- **Centralized audit event gateway (R-SHDW-EMIT).** All of Orchestray's internal audit events now flow through a single writer (`bin/_lib/audit-event-writer.js`) that validates each event against the schema before it reaches the audit log. Any schema mismatch is caught at write time rather than discovered later. Closes the validator-wiring gap noted in v2.1.14.

- **Phase-scoped orchestration reference loading (I-PHASE-GATE).** The main orchestration reference — 2,282 lines covering how Orchestray plans, executes, verifies, and closes work — is now split into four phase-specific files plus a small always-loaded contract file. Only the section relevant to the current phase of your orchestration loads per turn, saving ~21,000 tokens per turn. The full content remains accessible on demand. Kill switch: `phase_slice_loading.enabled: false` in `.orchestray/config.json`, or `ORCHESTRAY_DISABLE_PHASE_SLICES=1`. The legacy file is preserved as `tier1-orchestration.md.legacy` for one release.

- **Phase-scoped curator reference loading (R-CURATOR-SPLIT).** The curator agent's decision reference (~940 lines) now loads in stage-scoped slices matching the active curator phase, saving ~8,600 tokens per curator spawn. Same pattern and kill switch as I-PHASE-GATE: `curator_slice_loading.enabled: false`.

- **Telemetry wiring for 6 remaining feature protocols (R-TGATE-PM).** The six optional protocols that couldn't emit "was this protocol used?" events (drift detection, consequence forecasting, replay analysis, auto-documenter, disagreement protocol, and cognitive backpressure) now emit those events. This completes the demand-measurement signal that R-GATE-AUTO needs to make accurate quarantine decisions across all protocols.

### Changed

- **`feature_demand_gate.shadow_mode` default changed from `true` to `false`.** Auto-quarantine is now on by default. See migration note below.

### Under the hood — hardening / observability

- Four new audit event types: `feature_demand_gate_migrated` (one-time aggressive-default migration record), `delta_handoff_fallback` (full-artifact fetch from delta mode), `budget_warn` (per-role context budget exceeded), `phase_slice_fallback` (fallback when phase cannot be determined). Schemas in `agents/pm-reference/event-schemas.md`. Note: per-turn `phase_slice_injected` events are deferred to v2.1.16 — only `phase_slice_fallback` ships in v2.1.15.
- Delta-handoff trigger evaluation order: `force_full` (kill switch) → `hedged_summary` → `cross_orch_scope` → `issue_gap`. First matching trigger sets `reason` in the emitted `delta_handoff_fallback` event. Documented in `agents/pm-reference/delegation-templates.md` §12.
- 15 per-role initial budget defaults (conservative): pm: 80K, architect: 70K, developer: 60K, refactorer: 60K, reviewer: 50K, debugger: 50K, tester: 50K, documenter: 40K, inventor: 70K, researcher: 50K, security-engineer: 50K, release-manager: 40K, ux-critic: 40K, project-intent: 20K, platform-oracle: 30K. Budget calibration script (`bin/calibrate-role-budgets.js`) ships but runs as a v2.1.16 actor.
- `bin/generate-handoff-delta.js` — new script that produces delta payloads from reviewer artifacts.
- `bin/inject-active-phase-slice.js` — registered `UserPromptSubmit` hook; emits a small file-pointer string (well under the 10K `additionalContext` cap); Phase Oracle audit (W12) confirmed GO-WITH-RISK.
- `bin/inject-active-curator-stage.js` — curator stage injector; NOT registered in hooks.json because curator is manually invoked, not session-auto-spawned. PM loads curator stages via Read at spawn time.
- `bin/preflight-spawn-budget.js` — registered `PreToolUse:Agent` hook; soft-warn on budget breach; hard-block opt-in.
- `bin/_lib/audit-event-writer.js` — central gateway for all audit event writes; schema-validated; PreToolUse validator blocks malformed events at write time.
- `agents/pm-reference/tier1-orchestration.md` split into `phase-contract.md`, `phase-decomp.md`, `phase-execute.md`, `phase-verify.md`, `phase-close.md`. Legacy file preserved as `tier1-orchestration.md.legacy` for one release. All 83 cross-phase references mechanically resolved (validate-refs exit 0).
- Event-schemas shadow regenerated: 81 event types, 3,966 bytes (up from 78/3,835 in v2.1.14).

### Migration notes

**R-GATE-AUTO — aggressive default flip (action required if you opted out in v2.1.14)**

Starting in v2.1.15, Orchestray automatically quarantines feature gates that haven't fired on your repo for 14 days. **If you explicitly set `feature_demand_gate.shadow_mode: true` in v2.1.14 to opt out, that setting was OVERRIDDEN on your first session under v2.1.15.** You will see the following one-time banner when this happens:

```
[orchestray] v2.1.15 R-GATE-AUTO: feature_demand_gate.shadow_mode flipped from true to false.
[orchestray]   Your explicit `shadow_mode: true` setting was OVERRIDDEN by the aggressive-default migration.
[orchestray]   Starting now, Orchestray automatically quarantines feature gates that haven't fired
[orchestray]   on your repo for 14 days. You'll see a session-start banner naming any quarantined
[orchestray]   features. Re-enable any one with `/orchestray:feature wake <name>` (session) or
[orchestray]   `/orchestray:feature wake --persist <name>` (across sessions).
[orchestray]   To fully restore v2.1.14 behavior — two steps required:
[orchestray]   Step 1: set `feature_demand_gate.shadow_mode: true` in `.orchestray/config.json`.
[orchestray]   Step 2: for each quarantined feature listed above, run:
[orchestray]           /orchestray:feature wake --persist <name>
[orchestray]   Skipping Step 2 leaves the feature quarantined even after Step 1.
```

To restore v2.1.14 observe-only behavior, two steps are required:
1. Set `feature_demand_gate.shadow_mode: true` in `.orchestray/config.json`.
2. For each protocol that was quarantined during your first v2.1.15 session, run `/orchestray:feature wake --persist <name>`. Skipping Step 2 leaves those protocols quarantined even after Step 1.

Note: a flag set to `true` in your config does not auto-wake any quarantined feature. Setting `shadow_mode: true` in v2.1.14 no longer survives an upgrade.

**I-PHASE-GATE — orchestration reference restructure (action required only if you edited the file directly)**

Internal restructure of the main orchestration reference file. No action needed unless you've edited `agents/pm-reference/tier1-orchestration.md` directly — those edits will not carry over to the new phase slice files. The legacy file is preserved as `tier1-orchestration.md.legacy` for one release. To revert to the old file: set `phase_slice_loading.enabled: false` in `.orchestray/config.json`.

### Not in this release (with triggers)

- **R-PIN cache_control wiring** — waiting on Claude Code's `additionalContext` hook payload supporting `cache_control` markers. Platform Oracle audit (W12) confirmed no pending change is documented. Monitored via platform watch.
- **R-BUDGET live size-hint wiring** — `bin/preflight-spawn-budget.js` is live and the 15 per-role budgets are configured, but the PM delegation templates do not yet populate `context_size_hint` on every spawn. Warnings fire only on spawns that explicitly carry the hint. Full wiring is a v2.1.16 item — trigger: first orchestration regression where a spawned agent's context measurably exceeds its budget.
- **Per-turn `phase_slice_injected` telemetry** — deferred to v2.1.16. Only `phase_slice_fallback` events ship in v2.1.15. Trigger: a v2.1.16 audit pass measures `phase_slice_fallback` event count > 0 from any production install OR I-PHASE-GATE measured savings drop below 80% of the 21K projection over 14 days. Until then, the fallback variant alone is sufficient telemetry.
- **R-ORACLE-2 (explicit file-pointer pattern relies on PM prompt compliance, not platform enforcement)** — W12 platform-oracle audit rated this medium risk, non-blocking. v2.1.15 W14 pre-ship pass added an explicit pointer-handling rule to `agents/pm.md` Section Loading Protocol (Branch (a) reading order) that names the pointer string format and instructs the PM to Read the named slice. The cross-phase flow is also encoded at file scope in `phase-verify.md §16 → phase-decomp.md §13` and mechanically verified by `bin/_tools/phase-split-validate-refs.js` exit 0 (83/83 references). The audit event log does not track `Read` tool calls, so live runtime evidence is unavailable in v2.1.15; this is accepted as the W12 GO-WITH-RISK basis. Trigger for v2.1.16 escalation to BLOCK: any user report of a PM that loads `phase-contract.md` but never reads any phase slice in an orchestration spanning ≥3 phases, OR a v2.1.16 audit-event addition that tracks `Read` calls and shows zero slice Reads across 5 dogfood orchestrations.
- **R-ORACLE-3 (`inject-active-curator-stage.js` emits no `additionalContext`)** — W12 flagged this as medium risk. The curator uses an alternative Read-based discovery path. Verify in W14 that no context injection gap exists. Trigger: curator orchestration where a stage's content is not loaded despite the hook running.
- **R-CAT agent-default adoption**, **LLMLingua-2**, **semantic cache**, **contextual retrieval**, **Aider repo map**, **Agent Teams bulk adoption**, **`auto_document` default-off**, **reviewer dimension scoping** — all carry over from v2.1.14 with their existing triggers.

### Tests

- **3793 tests / 3793 pass / 0 fail.** Net +112 tests across Phase 2 (R-DELTA-HANDOFF +35, R-BUDGET +16, R-GATE-AUTO +5, I-PHASE-GATE +24, R-CURATOR-SPLIT +21, adjustments +11). No deletions.

---

## [2.1.14] - 2026-04-25

v2.1.14 is the "cheaper orchestrations, same accuracy" release. It ships observability foundations (R-TGATE), structural improvements (R-EMERGE, R-PFX, R-HCAP, R-FLAGS), the groundwork for measurement-driven feature quarantine and zone-pinned caching (R-GATE, R-PIN, R-SHDW), and a P3 stretch: pattern catalog mode (R-CAT). 9 R-items shipped. The pre-existing test baseline (16 failures) was eliminated as part of this release — 3682/3682 pass.

### Added

- **Compact MCP responses from agent prompts (R-PFX).** Orchestray now asks specialist agents to request compact MCP responses by default, so most pattern and knowledge-base lookups return a small index instead of full text. Agents fetch detail only when they decide it matters, cutting token use on long orchestrations without any setup from you.

- **Handoff artifact body cap (R-HCAP).** Review and design artifacts from orchestrated agents are now capped at roughly 2,000 tokens of core content, with longer detail linked as a separate artifact the next agent fetches only if needed. You keep full audit detail in the linked files; orchestrations get lighter hand-offs. The cap is soft in v2.1.14 (warn at 2,500 tokens, block only above 5,000 without a `detail_artifact` pointer). Hard-block mode opt-in: `"handoff_body_cap.hard_block": true` in `.orchestray/config.json`.

- **Merged pattern-extraction protocol (R-EMERGE).** The post-orchestration pattern-learning step now loads a single merged protocol file instead of two overlapping ones, trimming one Tier-2 file load from every completed orchestration without changing what patterns get extracted.

- **Orchestration telemetry (R-TGATE).** Orchestray now records which Tier-2 protocol files, feature gates, and MCP tool projections are actually exercised on each orchestration. This data surfaces in `/orchestray:analytics` under three new rollups (A: tier-2 load rate per protocol, B: gate evaluation outcomes, C: MCP projection compliance). It powers the demand-measured feature controls introduced in the same release and sets the stage for more precise token-budget tuning in v2.1.15+. Note: 2 of 8 protocols are wired for `tier2_invoked` telemetry in v2.1.14 (`pattern_extraction`, `archetype_cache`); the remaining 6 are wired in v2.1.15 (R-TGATE-PM).

- **Migration note — drift-sentinel is now off by default (R-FLAGS).** If you rely on drift-sentinel output, add `"enable_drift_sentinel": true` to `.orchestray/config.json` before your next orchestration — the default has changed from on to off. Drift-sentinel is now off by default on new repositories because it seldom produces actionable output on typical Orchestray workloads, and turning it off removes one Tier-2 protocol file from every orchestration. Existing repos with an explicit `true` in their config are unaffected. A one-time post-upgrade notice reminds upgrading users of this change. A new `bin/audit-default-true-flags.js` script lists every default-`true` flag with its 30-day demand count — run it with `node bin/audit-default-true-flags.js` to audit your own install.

- **Event-schema shadow index (R-SHDW).** Orchestray now keeps a ~3.8 KB event-type shadow index covering 78 event types that the orchestrator consults before touching the full 150 KB schema file, loading the full file only when it encounters an unknown event type. A validator library (`bin/_lib/schema-emit-validator.js`) is available for future emitter-side enforcement. A 3-strike auto-disable falls back to full-schema loading if the shadow falls out of sync. Note: validator wiring to actual emit sites is planned for v2.1.15, once Claude Code exposes a suitable hook surface.

- **Block A zone discipline for prompt caching (R-PIN).** Orchestray's per-session PM context is now assembled from three explicit zones — Zone 1 (frozen: CLAUDE.md, handoff contract, schema shadow), Zone 2 (per-orchestration header), Zone 3 (mutable turn content) — with zone boundary markers and hash tracking. A cache-invariant validator detects unexpected Zone 1 mutations and emits `cache_invariant_broken` events. A manual invalidation CLI (`bin/invalidate-block-a-zone1.js`) lets you reset the zone cleanly on deliberate changes. Note: actual prompt-cache savings (the "10% of normal input cost" model) require Claude Code's `additionalContext` hook payload to support `cache_control` breakpoints, which is not available in v2.1.14. This release ships the zone discipline, invariant validator, and invalidation CLI as the prerequisite groundwork; actual cache savings activate when the hook surface is extended in a future Claude Code release.

- **Demand-measured feature quarantine (R-GATE).** Orchestray now tracks which of its optional protocols actually run on your repo. For the first two weeks after upgrading, it observes demand in the background and logs quarantine candidates without changing any behavior. After that window, you can list specific protocols in `feature_demand_gate.quarantine_candidates` in `.orchestray/config.json` to skip loading them. Use `/orchestray:feature status` to see demand data, and `/orchestray:feature wake <name>` to re-enable any quarantined protocol instantly. Session wake (`/orchestray:feature wake <name>`) persists until the session ends or is overwritten; 30-day pin (`/orchestray:feature wake --persist <name>`) persists across sessions. Auto-quarantine (no config edit required) is planned for v2.1.15 once the observation window has accumulated data on your repo.

- **Pattern catalog mode (R-CAT, P3 stretch).** `pattern_find` now accepts `mode=catalog`, which returns a compact TOON-formatted headline list with a Haiku-generated `context_hook` per pattern instead of full bodies. A new `pattern_read(slug)` MCP tool fetches any pattern's full body on demand. Agents adopt `mode=catalog` by default in v2.1.15 once `fields_used` compliance reaches 70%+; in v2.1.14, the feature ships and is available for early adoption.

### Changed

- **`enable_drift_sentinel` default changed from `true` to `false`.** See migration note above under R-FLAGS. Affects new repos and existing repos on implicit defaults. Restore with `"enable_drift_sentinel": true` in `.orchestray/config.json`.

### Fixed

- **Test suite is now fully green.** Removed `tests/bundle-ux-gate-routing-hint.test.js` (22.7 KB, testing the v2.1.8 hard-deny routing-hint contract that v2.1.11 R-DX1 deliberately replaced with soft auto-resolve; replacement coverage exists in `tests/agent-spawn-auto-resolve.test.js`). Loosened `statusline-render.test.js` performance budget 50 ms → 200 ms (Node child-process cold-start variance under parallel test load). Suite is now 3682/3682 pass / 0 fail (down from 16 documented baseline failures).

### Under the hood — hardening / observability

- Four new audit event categories ship in v2.1.14: R-TGATE events (`tier2_invoked`, `feature_gate_eval`, `mcp_checkpoint_recorded.fields_used`); R-PIN events (`block_a_zone_composed`, `cache_invariant_broken`, `block_a_zone1_invalidated`); R-GATE events (`feature_quarantine_candidate`, `feature_quarantine_active`, `feature_wake`, `feature_wake_auto`); R-SHDW events (`schema_shadow_hit`, `schema_shadow_miss`, `schema_shadow_validation_block`, `schema_shadow_stale`). All carry `version: 1` per R-EVENT-NAMING conventions. Schemas in `agents/pm-reference/event-schemas.md`.
- Nine new hooks: `compose-block-a.js` (UserPromptSubmit), `validate-cache-invariant.js` (PreToolUse), `feature-quarantine-advisor.js` (UserPromptSubmit), `feature-auto-release.js` (PostToolUse), `feature-quarantine-banner.js` (SessionStart), `inject-schema-shadow.js` (UserPromptSubmit), `regen-schema-shadow-hook.js` (PostToolUse:Edit on `event-schemas.md`), `validate-schema-emit.js` (library), `gate-telemetry.js` (UserPromptSubmit, extended). All hooks wrap I/O in try/catch; non-fatal.
- `bin/audit-default-true-flags.js` — new one-shot script that audits all top-level boolean flags whose install default is `true`, querying 30 days of events for demand evidence. Run with `node bin/audit-default-true-flags.js`.
- `bin/feature-wake.js`, `bin/feature-gate-status.js`, `bin/feature-quarantine-advisor.js` — R-GATE demand-tracking and wake CLI. Registered as `/orchestray:feature` slash command.
- `agents/pm-reference/extraction-protocol.md` — merged from `auto-extraction.md` + `pattern-extraction.md`. Both originals retired. Dispatch table updated to single trigger condition.
- `agents/pm-reference/event-schemas.md` shadow at `agents/pm-reference/event-schemas.shadow.json` (3,513 bytes, 71 event types).
- No new runtime dependencies (verified: `git diff aff2ec0..HEAD -- package.json` empty).

### Not in this release (with triggers)

- **R-TGATE-PM (PM-prompt edits to wire `tier2_invoked` for the 6 prompt-only protocols):** Deferred to v2.1.15. **Trigger:** triggered now (Phase 1 audit, 2026-04-25). v2.1.14 ships R-TGATE wired for 2 hook-eligible protocols (`pattern_extraction`, `archetype_cache`). The remaining 6 (`drift_sentinel`, `consequence_forecast`, `replay_analysis`, `auto_documenter`, `disagreement_protocol`, `cognitive_backpressure`) need PM-prompt section edits to call `bin/_lib/tier2-invoked-emitter.js` from their primary-action sites.

- **R-GATE-AUTO (automatic feature quarantine after 14-day observation window):** Deferred to v2.1.15. **Trigger:** triggered now. v2.1.14 ships shadow mode + opt-in; the 14-day auto-activation is intentionally not enabled because no install has yet accumulated the observation data needed for safe automatic action.

- **R-PIN cache_control wiring:** Deferred. **Trigger:** Claude Code's `additionalContext` hook payload begins supporting `cache_control: {type:"ephemeral", ttl:"1h"}` markers. The 3-zone discipline, invariant validator, and invalidation CLI ship in v2.1.14; actual prompt-cache savings activate when the hook surface is extended.

- **R-SHDW PreToolUse emit-validator wiring:** Deferred. **Trigger:** Claude Code exposes an `emit_event` tool surface OR Orchestray adds a centralized `bin/_lib/audit-event-writer.js` precheck. The shadow itself, library validator, and 3-strike auto-disable ship in v2.1.14.

- **I-PHASE-GATE** (split `tier1-orchestration.md` into phase slices), **R-CAT agent-default adoption**, **LLMLingua-2**, **semantic cache**, **contextual retrieval**, **Aider repo map**, **Agent Teams bulk adoption**, **`auto_document` default-off**, **reviewer dimension scoping**, **`curator.md` split** — all carry over from v2.1.13 with their existing triggers.

### Tests

- **3682 tests / 3682 pass / 0 fail. Baseline failures eliminated.**

---

## [2.1.13] - 2026-04-24

v2.1.13 is an ergonomics and hardening patch. Repo context is now read once per session by a dedicated Haiku agent instead of inline inside the PM's turn. Docs you keep pasting become reusable skill packs. Pattern search understands common synonyms. Config mistakes become loud at boot with "did you mean…?" suggestions. Seven coordinated improvements, one carryover closed (event-field naming consistency), zero new runtime dependencies.

### Added

- **New `project-intent` agent.** The first time Orchestray sees a repo in a session, a lightweight Haiku agent briefly reads your `README.md`, `CLAUDE.md`, and (new) `AGENTS.md`, and stages a project-intent block that every downstream agent receives for free. In v2.1.12 this ran inline inside the PM's turn; in v2.1.13 it is a dedicated agent so your PM's turn budget goes to the actual task. Cost per fresh-repo invocation stays under $0.03. Requires a Claude Code session restart after upgrade — the post-upgrade reminder now names `project-intent-agent` specifically so you know what is waiting.

- **`AGENTS.md` is read alongside `CLAUDE.md`.** If your repo has an `AGENTS.md` (the open convention adopted by 60,000+ projects, see https://agents.md), Orchestray agents now receive its Build/Run, Testing, and Architecture sections as context — same as `CLAUDE.md`. Graceful skip when the file is absent.

- **`/orchestray:learn-doc <url>` — turn a doc page into a reusable skill pack.** Hand a URL you keep pasting into prompts, and Orchestray distills it into a concise, always-available knowledge pack that future agent sessions read automatically. Source-aware expiry keeps packs fresh: Claude Code docs refresh every 14 days, Anthropic Platform every 30 days, other sources every 90 days. Cost per run: under $0.03. The shorter alias `/orchestray:distill <url>` is registered and routes to the same flow.

- **Per-pattern `sharing: local-only` flag.** A pattern with `sharing: local-only` in its frontmatter stays on this machine regardless of project-level federation settings. Use it for patterns that reference private business context. Honored on both the read path (pattern search excludes local-only patterns from cross-install views) and the write path (shared-tier promotion refuses local-only patterns with a clear message). Forward-compatible: when cross-machine federation sync ships in a future release, these patterns will continue to stay local. To pin a pattern today, edit its frontmatter directly in `.orchestray/patterns/<slug>.md`.

### Changed — smarter pattern ranking

- **Pattern search understands common synonyms.** Search for "bug fix" and you will also see patterns tagged "debug," "defect," "correction." The list is conservative (~44 equivalence classes); every expansion is auditable via the response's `match_reasons` field and one config flip disables the whole feature (`retrieval.synonyms_enabled: false`).

- **Usage-aware ranking is now opt-in.** Three scorer variants are now selectable via `retrieval.scorer_variant` in `.orchestray/config.json`: `skip-down` (patterns you skip rank lower), `local-success` (patterns that worked in your project rank higher), `composite` (both signals combined), or the unchanged default `baseline`. Default behaviour is unchanged in this release — a default flip is planned for v2.2.0 once there is enough cross-install shadow data.

### Under the hood — hardening

- **Config and pattern files are now validated against a structured schema at boot.** Typos and invalid values produce clear, pointed error messages ("Invalid enum value. Expected …, got …") instead of silent fallbacks. Three declarative schemas cover `.orchestray/config.json`, pattern frontmatter, and specialist templates. The validator is a 300-line handwritten module shipped in-tree (no new runtime dependencies).

- **Config typos become loud at boot with "did you mean…?" suggestions.** Unknown top-level keys produce a boot-time warning that suggests the nearest valid key (Levenshtein distance ≤ 2). Intentional custom keys can be silenced via `config_drift_silence: ["my_key"]`. Warnings are warnings (exit 0), not errors.

- **Event-field naming consistency pass.** Fields in `.orchestray/audit/events.jsonl` are now uniformly `type` + `timestamp` across every emitter. Older `events.jsonl` files that mixed `event` + `ts` continue to read cleanly — a read-side normaliser handles back-compat. `agents/pm-reference/event-schemas.md` documents both historical and canonical names.

- **New audit event `project_intent_fallback_no_agent`.** Fires when the PM dispatches to the `project-intent` agent but the agent is unavailable (pre-restart state, spawn error, or missing agent file) and the PM falls back to the in-process mechanical generator. Schema entry in `agents/pm-reference/event-schemas.md`.

- **Post-upgrade restart reminder now names the features waiting on the restart.** When you upgrade Orchestray while a Claude Code session is open, the one-time stderr nudge reads "…RESTART to load new agents (this message won't repeat). New in this upgrade: project-intent-agent." so you know what specifically is dormant until you reload.

### Not in this release (with triggers)

- **Cross-machine federation sync** — still under internal test. Ships when internal soak passes, conflict-resolution has 30+ days of dogfood data, and the Windows git-over-SSH environment probe lands. No target version yet, to avoid another carryover-label.
- **Usage-aware ranking as default** — deferred to v2.2.0, gated on ≥30 orchestrations of shadow-log telemetry showing tau-b divergence ≥0.15 between `baseline` and `composite`.
- **Full 4-option RAG decision** (trigram FTS / vector DB / preflight retriever / skill packs) — deferred to v2.2.0, gated on Signal A/B/C measurement. `/orchestray:learn-doc` in v2.1.13 addresses Option 1 (skill packs) as a low-risk additive.
- **Auto-apply curator suggestions** — **retired**; the human-gate is a permanent design principle.
- **Federation team tier** — deferred to post-federation-sync-GA + security review + ≥3 peer installs × 30 days.

### Tests

- **+122 net new tests; baseline preserved.** 3456/3471 pass. The 15 failures are the pre-existing master baseline (4 routing-hint subtests + 11 post-upgrade-sweep subtests) and were not introduced by any v2.1.13 change. Two baseline failures that existed on master (compression-telemetry event tests, isolation-omitted event test) are now fixed by the field-naming unification pass.

## [2.1.12] - 2026-04-24

v2.1.12 closes the kill-switch rollback gap introduced in v2.1.11, adds cached project-intent injection so downstream agents receive your project's goal without re-deriving it each time, and surfaces three new post-orchestration signals: Tier-2 dispatch frequency, model auto-resolve counts, and MCP field-projection usage. MCP field projection now covers four tools (up from two). 3299/3299 tests green.

### Fixed

- **Kill-switch rollback is now guaranteed, not advisory.** The three v2.1.11 rollback switches (`ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1`, `ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1`, `ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1`) previously relied on the PM model noticing the env-var clause in the dispatch table — meaning rollback could silently fail if the model skipped the dispatch rule. The env vars now trigger a hook (`bin/inject-archetype-advisory.js`) that mechanically injects the corresponding file content into PM context on the next turn. Setting any of the three vars guarantees the legacy file is loaded, regardless of how the PM interprets the dispatch rule.

- **Recovered two delegation-template sections dropped during v2.1.10's file split.** The "Confidence Checkpoint Instructions" injectable block and the "Section 11: KB + Diff Handoff Flow" 5-step protocol were present in the pre-split `delegation-templates.md` but absent from both the lean and detailed halves produced in v2.1.10. Both sections are now restored to `delegation-templates-detailed.md`.

### Added

- **Cached project-intent block injected into every orchestration's delegation prompts.** On first run (or when `README.md` or the repo structure changes), the PM generates a `project-intent.md` file under `.orchestray/kb/facts/` with five fields: Domain, Primary user problem, Key architectural constraint, Tech stack summary, and Entry points. Downstream agents receive this block in their delegation context — they no longer need to re-read `README.md` or `CLAUDE.md` to understand what the project is for. Gate: if `README.md` is missing or too short, the block is marked `low_confidence` and omitted from delegation prompts to avoid injecting noise. Disable with `enable_goal_inference: false` in `.orchestray/config.json`.

- **Post-orchestration rollup now shows Tier-2 dispatch frequency, model auto-resolve counts, and MCP field-projection usage.** After each orchestration, the summary now includes: which conditional PM-reference files were loaded (and how often), how many agent spawns required model auto-resolution (and at which fallback stage), and how often the PM used `fields` projection on MCP tool calls. These three signals make the v2.1.11 cost-saving features observable without digging into raw event logs.

- **MCP field projection extended to `routing_lookup` and `metrics_query`.** Both tools now accept an optional `fields` parameter (same backward-compatible contract as `pattern_find` and `kb_search` introduced in v2.1.11). Field projection is now available on the four highest-traffic MCP tools.

- **`/orchestray:config` now lists `ox_telemetry_enabled` as a discoverable toggle.** Previously this key could only be set by hand-editing `.orchestray/config.json`. It now appears in `/orchestray:config` output with a description ("Enable ox.jsonl telemetry log. Default false. Opt-in only.").

### Under the hood

- New hook `collectKillSwitchContent()` added to `bin/inject-archetype-advisory.js`; reads three env vars per turn and injects the corresponding file when set. New test file: `tests/kill-switch-injection.test.js` (7 tests). New event `tier2_load` emitted by `bin/emit-tier2-load.js` (PostToolUse:Read) whenever a conditional PM-reference file is loaded; schema in `agents/pm-reference/event-schemas.md §v2.1.12`. New lib `bin/_lib/project-intent.js` implements the goal-inference pass and staleness detection. New tests: `tests/kill-switch-injection.test.js`, `tests/tier2-load-hook.test.js`, `tests/model-auto-resolve-rollup.test.js`, `tests/fields-projected-metric.test.js`, `tests/project-intent-generation.test.js`, `bin/mcp-server/tools/__tests__/routing_lookup.test.js`, `bin/mcp-server/tools/__tests__/metrics_query.test.js`. Net +79 tests (3220 → 3299). 0 failing.

## [2.1.11] - 2026-04-24

v2.1.11 ships seven bundles: the PM now loads ~162 KB less prompt on every orchestration by conditionally gating the event-schema reference and splitting two large tier-1 files into always-on and on-demand halves; a new `ox` CLI helper replaces verbose multi-line bash in PM workflows with six named verbs; `pattern_find` and `kb_search` now accept a `fields` parameter that cuts response size by up to 80%; the recurring "Agent() missing model" spawn-block is eliminated by auto-resolve; agents that must produce written artifacts can no longer silently skip them; the event-schema validator now hard-blocks unknown event types; and the installer no longer overwrites your shell PATH. 3220/3220 tests green.

### Added

- **~162 KB prompt reduction on every orchestration.** The PM's always-loaded bundle is now leaner by default: `event-schemas.md` (138 KB) is gated to Tier-2 and loaded only when the PM is about to write a novel audit event type; `tier1-orchestration.md` sheds its rarely-used sections (consequence-forecast, drift-sentinel, orchestration-threads, adaptive-persona blocks) into a new sibling file `tier1-orchestration-rare.md` that loads on-demand; `delegation-templates.md` splits into a lean spawn-time core and a detailed on-demand extension. Measured ceiling: ~56 K tokens saved on the PM's first orchestration turn. Kill switches available if you need the legacy always-load behaviour: `ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1`, `ORCHESTRAY_TIER1_RARE_ALWAYS_LOAD=1`, `ORCHESTRAY_DELEGATION_TEMPLATES_MERGE=1`.

- **`ox` helper — six verbs for routine PM operations.** A new `ox` command is installed on your PATH when you run `npx orchestray --global`. It covers the six most common PM bash one-liners: `ox state init`, `ox state complete`, `ox state pause`, `ox state peek`, `ox routing add`, and `ox events append`. Each verb writes or reads the orchestration state directory atomically, enforces a 2048-byte per-entry cap, and blocks reserved key names. Protocol reference: `agents/pm-reference/ox-protocol.md`. Run `ox --help` for usage.

- **MCP response projection for `pattern_find` and `kb_search`.** Both tools now accept an optional `fields` parameter: a comma-separated list of top-level keys to return. A query returning 50 KB of pattern data can be reduced to under 10 KB by requesting only the fields the PM actually needs (`slug,approach,confidence`). Backward compatible — omit `fields` for the full legacy response. Documented in `agents/pm-reference/ox-protocol.md` §MCP projection.

### Fixed

- **"Agent() missing model" spawn-block eliminated.** Every session used to start with one guaranteed Agent() rejection — the PM forgot to pass `model` on the first spawn of an orchestration, the gate blocked it, and the PM retried. This is now resolved at the gate: missing `model` is auto-resolved via routing.jsonl lookup, then agent frontmatter default, then a global `sonnet` fallback. A `model_auto_resolved` warning event is emitted so the PM still gets a visible signal. If you want the old hard-block back: `ORCHESTRAY_STRICT_MODEL_REQUIRED=1`.

- **Agents can no longer silently skip required artifact files.** Agents whose contract is to produce a written findings, design, or report file (architect, reviewer, debugger, researcher, security-engineer, ux-critic, documenter, inventor) now carry an explicit artifact-writing clause in their system prompt that overrides Claude Code's default "don't write .md files" rule. The T15 validator hook rejects placeholder path values and verifies the artifact exists on disk before the agent can stop. Kill switch: `ORCHESTRAY_ARTIFACT_PATH_ENFORCEMENT=warn` downgrades to a warning.

- **Audit-event schema validator now hard-blocks unknown event types.** The validator hook (bin/validate-task-completion.js) now exits 2 — blocking the emission — when an audit event carries an event type that is not in the known-event-types set extracted from event-schemas.md. This catches novel-type events that would otherwise slip silently into events.jsonl with no schema. Kill switch: `ORCHESTRAY_EVENT_SCHEMAS_ALWAYS_LOAD=1` (which also ensures the full schema is loaded, making false-positive blocks impossible).

- **Installer no longer overwrites your shell PATH.** A bug introduced during v2.1.11 development caused the install script to overwrite `process.env.PATH` rather than prepend to it, which could strip existing PATH entries. Fixed: the ox bin directory is now prepended to the existing PATH. If you installed a pre-release build of v2.1.11, reinstall with `npx orchestray --global` to fix your shell config.

### Under the hood

- New files: `bin/ox.js` (ox CLI binary, 24 KB), `bin/mcp-server/lib/field-projection.js` (projection helper), `agents/pm-reference/ox-protocol.md` (protocol reference), `agents/pm-reference/tier1-orchestration-rare.md` (rare-path tier1 extract, 28 KB), `agents/pm-reference/delegation-templates-detailed.md` (detailed delegation templates, 23 KB). Test additions: `tests/ox.smoke.test.js`, `tests/install-ox.test.js`, `tests/kill-switches.test.js`, `bin/mcp-server/tools/__tests__/field-projection.test.js`, `tests/agent-spawn-auto-resolve.test.js`. Net +74 tests (3146 → 3220). 0 failing.

## [2.1.10] - 2026-04-24

v2.1.10 ships five bundles: post-compaction state recovery is now delivered via Claude Code's native context envelope instead of a fenced markdown block in your prompt; compaction is blocked when state serialization fails mid-orchestration so recovery is guaranteed; the 1-hour prompt cache TTL is now on by default for measurably cheaper long orchestrations; the v2.1.8 context-compression paths (CiteCache, SpecSketch, RepoMapDelta) now emit telemetry proving they fired; and worktree isolation is now declared directly on write-capable agent frontmatter so the PM cannot silently skip it. One latent bug from v2.1.9 is also fixed: a crash in the post-compaction dossier injection that left the PM with no recovery context after a long orchestration.

### Added

- **Post-compaction state recovery is now native context, not a prompt fence.** After `/compact` or a session resume, the PM's resilience dossier is delivered via Claude Code's native `additionalContext` envelope — invisible to you in the terminal and outside your prompt token budget. This removes ~200–600 tokens per recovery turn that were previously spent on the fence markers and CLAUDE.md preamble, and collapses the prior defensive 3-injection-per-compaction approach down to a single `SessionStart` delivery. Estimated 15–30% token reduction on post-compact recovery. The dossier is still written to `.orchestray/state/resilience-dossier.json` and the PM will fall back to reading that file if the envelope is absent. Roll back to the prior fenced-markdown path at any time with `ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED=1`.

- **Compaction is blocked when state serialization fails during an active orchestration.** If Orchestray cannot write the resilience dossier to disk while an orchestration is running, the `PreCompact` hook now refuses compaction (exit 2) and prints an actionable stderr message explaining which orchestration is in flight and what to do. Once the write succeeds, compaction proceeds normally. If your orchestration has already completed or was aborted, a failed write is non-blocking. Prefer warn-only behavior? Set `ORCHESTRAY_RESILIENCE_BLOCK_DISABLED=1` or `resilience.block_on_write_failure: false` in `.orchestray/config.json` — no restart required.

- **1-hour prompt cache TTL is now the default for Orchestray orchestrations (Claude Code ≥2.1.108).** `ENABLE_PROMPT_CACHING_1H=1` is now set in the plugin's `settings.json`. For a representative 10-turn, 30-minute orchestration with a 50 K-token cacheable PM prefix, the 1-hour TTL reduces input tokens by ~77% on the cacheable portion compared to paying the 5-minute write penalty on every turn (break-even is at just 2 turns within the hour; Orchestray orchestrations routinely exceed this). If you prefer the 5-minute TTL — or are on a tight cost budget where the higher write cost outweighs the read savings — set `FORCE_PROMPT_CACHING_5M=1` in your environment to revert without any code change.

- **Compression telemetry — CiteCache, SpecSketch, and RepoMapDelta now emit audit events.** The context-compression paths that shipped in v2.1.8 had no runtime observability: config was on, code existed, but there was no way to verify they fired during actual orchestrations. A new `SubagentStart` hook now emits `cite_cache_hit`, `spec_sketch_generated`, and `repo_map_delta_injected` events whenever each path is detected in a delegation prompt. You can see per-orchestration counts in `/orchestray:analytics`. The hook is non-blocking — if it cannot detect a marker, the orchestration continues and no event is emitted. Disable with `ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1` or `context_compression_v218.telemetry_enabled: false`.

- **Worktree isolation is now declared on agent frontmatter; a new advisory warns when a write-capable spawn skips it.** The six write-capable agents (architect, developer, refactorer, tester, security-engineer, inventor) now carry `isolation: worktree` directly in their frontmatter, closing a long-standing gap where the PM had to remember to pass the flag on every spawn. If a custom specialist omits the frontmatter and is spawned without isolation, an `isolation_omitted_warn` advisory event is emitted — visible in `/orchestray:analytics` — so the gap is discoverable. Read-only agents (reviewer, debugger, researcher, documenter, ux-critic, platform-oracle) are intentionally excluded to avoid wasting disk on read-only worktrees. Disable the advisory with `ORCHESTRAY_ISOLATION_WARN_DISABLED=1` or `worktree_isolation.warn_on_omission: false`.

### Fixed

- **Dossier injection no longer silently drops recovery context on long orchestrations.** When the serialized resilience dossier exceeded the 10 KB `additionalContext` cap, a latent `ReferenceError` in the truncation path caused the hook to crash — and the PM received no dossier at all after compaction of any orchestration where the state grew large. The truncation path is now correct: oversized dossiers are trimmed with a truncation marker and delivered reliably. A `dossier_truncated` event is emitted when trimming occurs.

### Under the hood

- Eight new event types in `agents/pm-reference/event-schemas.md` §Section 24: `cite_cache_hit`, `spec_sketch_generated`, `repo_map_delta_injected`, `dossier_truncated`, `resilience_block_triggered`, `resilience_block_suppressed_inactive`, `resilience_block_suppressed`, `isolation_omitted_warn`. New hook scripts: `bin/emit-compression-telemetry.js` (SubagentStart, non-blocking) and `bin/warn-isolation-omitted.js` (PreToolUse[Agent], advisory-only). `bin/pre-compact-archive.js` hardened with the blocking semantics. `bin/inject-resilience-dossier.js` migrated to native-envelope output. 20 new tests added (3126 total, 0 failing). Known pre-existing inconsistency in event field naming (`event` vs `type` on older rows) is not normalized in this release — a consistency pass is scheduled for a future release.

## [2.1.9] - 2026-04-20

v2.1.9 ships across five areas: auto-learning now triggers automatically when an orchestration finishes (not only on manual `/orchestray:learn`); every agent now enforces a common Structured Result schema before it can stop; three new specialists round out the shipped library; the installer wires all five specialists so they are callable by name from a fresh install; and a set of hardening fixes eliminates a curator log storm, a pattern-seen-set crash path, and an agent-registry race that was inflating stderr noise.

### Added

- **Auto-learning fires on orchestration completion.** When `auto_learning.extract_on_complete.enabled: true`, the Stop hook now triggers pattern extraction as soon as an orchestration finishes — not only when context compacts. The Haiku extraction backend's output parser now accepts fenced JSON blocks (previously rejected them), and the default extraction timeout is 180 s so long orchestrations don't time out mid-extraction. The ROI aggregator and KB-refs sweep also run on `SessionStart` so their cadence is decoupled from active orchestration. `auto_extract_staged` events now carry a `stop_hook_triggered` field.

- **Three new shipped specialists.** The installer now includes three additional specialist templates alongside Translator and UI/UX Designer:
  - **database-migration** (opus/high) — plans zero-downtime schema migrations for Prisma, Knex, Flyway, Liquibase, Alembic, Rails, TypeORM, sqlx, and goose. Emits staged migrations (nullable add → backfill → constraint add), monitoring checkpoints, and rollback triggers.
  - **api-contract-designer** (sonnet/high) — designs REST/GraphQL/gRPC contracts using OpenAPI 3.1 or AsyncAPI 3, with versioning discipline, JSON Schema evolution, and backward-compat impact analysis.
  - **error-message-writer** (sonnet/medium) — polishes user-facing error messages and CLI output for clarity, tone, and actionability without touching error codes or i18n keys.
  All five specialists are now symlinked (or copied on Windows) into `~/.claude/agents/` by the installer and callable via `Agent(subagent_type=…)`.

- **Universal Structured Result schema (T15 quality gate).** Every core agent and specialist now emits a common set of base fields (`status`, `summary`, `files_changed`, `files_read`, `issues`, `assumptions`). A new `SubagentStop` / `TaskCompleted` hook validates these fields before an agent can stop — hard-blocking for architect, developer, reviewer, and release-manager; warn-only for others. Set `PRE_DONE_ENFORCEMENT=warn` to downgrade all blocks to warnings without restarting. Reference schema is in `agents/pm-reference/agent-common-protocol.md`; handoff contract spec in `agents/pm-reference/handoff-contract.md`.

- **Architect Acceptance Rubric.** Architect-produced designs now include an explicit Acceptance Rubric listing testable criteria. Downstream agents (developer, reviewer) score themselves against the rubric with mandatory evidence. Reference: `agents/pm-reference/rubric-format.md`.

- **Structural quality score in analytics.** Each agent spawn now records a `structural_score` field in `.orchestray/metrics/agent_metrics.jsonl` — a deterministic 0.0–1.0 score measuring Structured Result well-formedness. Surfaces in `/orchestray:analytics` rollups. No additional model cost.

- **`task_subject` check on every Agent() spawn.** The `PreToolUse[Agent]` gate now verifies that every spawn carries a meaningful description or `task_subject:` line. Spawns without one are blocked with an actionable error message.

- **Reviewer-scope warning.** When a reviewer agent is delegated without an explicit file list, the `PreToolUse` gate emits a `reviewer_scope_warn` advisory to stderr and events.jsonl. The review proceeds but the event surfaces in `/orchestray:analytics` so scope drift is visible.

- **Release-phase no-deferral enforcement.** In release-phase orchestrations, phrases like "deferred to next release", "TODO later", or "will fix in vX" in agent output cause `SubagentStop` to block with exit 2. Set `PRE_DONE_ENFORCEMENT=warn` to downgrade to warning.

### Fixed

- **Curator log storm eliminated.** A corrupt cursor in `curate --diff` mode was emitting a `curator_cursor_reset` event on every turn — up to hundreds per session. The reset now fires at most once per session (one-signal-per-session gate). The cursor is restored to full-diff mode on the first detection and stays there. `agent_registry_stale` log spam (~90% reduction) addressed in the same bundle.

- **Pattern-seen-set crash paths closed.** The CiteCache seen-set now handles two previously crashing paths: files exceeding 10 MB are tail-truncated to ~5 MB before parse (emits `pattern_seen_set_oversize`), and any read or parse error triggers a fail-open recovery that emits `pattern_seen_set_recovered` and re-emits full pattern bodies for the rest of the orchestration. Neither condition blocks the orchestration.

### Under the hood

- New Tier-2 reference file `agents/pm-reference/handoff-contract.md` — canonical Structured Result schema and per-agent extension tables.
- New `agents/pm-reference/rubric-format.md` — Acceptance Rubric format for architect designs.
- Event schema additions: `task_subject_missing`, `reviewer_scope_warn`, `no_deferral_block`, `pre_done_checklist_failed`, `pre_done_checklist_warn`, `task_completion_warn`, `curator_cursor_reset`, `pattern_seen_set_recovered`, `pattern_seen_set_oversize`. See `agents/pm-reference/event-schemas.md` §v2.1.9.

## [2.1.8] - 2026-04-20

v2.1.8 ships four bundles: the first spawn of every orchestration session no longer fails on a missing model parameter; Opus 4.7 cost estimates are now accurate rather than running ~35% low; two specialist templates (Translator and UI/UX Designer) now ship with the plugin so they are available from a fresh install; and four context-compression mechanisms reduce per-orchestration input tokens for long-running orchestrations.

### Bundle UX — First-spawn model routing is now seamless

Previously, the very first `Agent()` spawn of every session during an orchestration would fail because the PM forgot to pass the required `model` parameter — the gate blocked the spawn, and the PM retried successfully. It was a one-time friction per session, but it was persistent.

v2.1.8 closes it two ways. A new pre-spawn reminder runs before the first spawn and reminds the PM exactly what model to pass for each task in the current orchestration, eliminating the failure at the source. If a spawn still reaches the gate without a model, the gate now reads your routing ledger and tells the PM the exact model to re-spawn with — so the retry is mechanical instead of requiring the PM to look it up.

### Bundle TOK — Opus 4.7 tokenizer calibration and xhigh effort level

Your `/orchestray:status` cost estimates were running approximately 35% low for any agent routed to Opus. Opus 4.7 uses a new tokenizer that consumes more tokens than the previous model for the same text — the per-token price didn't change, but the same prompt now costs more. We recalibrated the Opus multiplier in the cost model so new orchestrations will show accurate estimates. Historical rollups were not recalculated; they stay at the old value.

Claude Code 2.1.111 (released 2026-04-16) introduced a new effort level, `xhigh`, as the recommended default for Opus 4.7 on most coding and agentic tasks — sitting between `high` and `max`. v2.1.8 adopts it: Architect and Inventor agents now default to `xhigh` instead of `high`, aligning with Anthropic's own guidance that `max` can encourage overthinking. If you're on an older Claude Code, `xhigh` silently runs as `high` — nothing breaks, you just don't get the new level. `max` remains available as an explicit escalation path for the rare case that genuinely warrants it.

### Bundle S — Specialist templates now ship with the plugin

Two specialist templates are now included in every Orchestray install (at `specialists/` in the plugin root):

- **Translator** — makes apps multi-lingual: detects your i18n framework (i18next, FormatJS, Lingui, gettext, Flutter intl, iOS, Android, and more), extracts untranslated strings, produces locale-correct translations with ICU MessageFormat awareness, and runs five mandatory correctness checks (placeholder parity, CLDR plural-form count, length-ratio, RTL markers, source-language leak). No external API keys — Claude is the translation engine. Activates automatically when your task mentions translate, i18n, localize, locale, xliff, or similar keywords.

- **UI/UX Designer** — premium UI generation anchored to the shadcn/ui + Radix + Tailwind v4 stack, W3C DTCG 2025.10 design tokens, WCAG 2.2 AA accessibility (enforced via eslint-plugin-jsx-a11y + @axe-core/react), 4pt spacing grid, and sub-300ms motion budgets. Works from pasted design tokens, screenshots (Claude vision), or plain text descriptions. No external design-tool calls. Activates on keywords like premium UI, design system, design tokens, shadcn, WCAG, UX polish.

Both use Sonnet by default. The PM selects them automatically based on task keywords; you can also request them explicitly in your prompt.

**Overrides:** if you create a project-local specialist at `.orchestray/specialists/translator.md` or `.orchestray/specialists/ui-ux-designer.md`, that file replaces the shipped template for that project. Project-local specialists are gitignored and do not travel with the repo. Shipped templates update on `/orchestray:update`.

### Bundle CTX — Four context-compression mechanisms for long orchestrations

Token pressure accumulates across long orchestrations as pattern bodies, repo maps, and handoff specs are re-injected into each agent delegation. v2.1.8 introduces four opt-in mechanisms gated by `context_compression_v218.enabled` (default on) that cut repeated input without losing context fidelity.

- **CiteCache** — the second and subsequent times a pattern is injected into an orchestration, only its slug and a short hash are sent rather than the full body. The first injection always goes in full so the agent has the complete text once; repeats are elisions. If you see a cited pattern that you need to expand, it is always available in the knowledge base.
- **SpecSketch** — handoff skeletons between agents are now a compact YAML summary (file list, key symbols, changed signatures) instead of full prose when the handoff is structure-only. Agents that need design rationale (architect, inventor, debugger) still receive a `rationale:` field. If the YAML parse fails or the rendered skeleton is too large, the system falls back to full prose automatically.
- **RepoMapDelta** — after the first agent in an orchestration receives a full filtered repo map, subsequent agents receive only the delta since the last injection. The first-agent injection is always full so the PM and first agent have complete context; the rest get a compact pointer summary.
- **ArchetypeCache (advisory)** — when the current task matches a previously successful orchestration archetype (by Weighted-Jaccard signature), the PM receives an advisory fence with the prior decomposition plan as a starting hint. The PM decides whether to accept, adapt, or override it and records its reasoning in the `archetype_cache_advisory_served` audit event. This is advisory-only: the PM always has final say on decomposition. You can blacklist specific archetypes via `context_compression_v218.archetype_cache.blacklist` or disable the feature entirely with `context_compression_v218.archetype_cache.enabled: false`.

All four mechanisms have individual on/off config keys under `context_compression_v218`. Any mechanism that encounters an error (parse failure, disk write error) falls back gracefully and records a degraded-journal entry — nothing blocks the orchestration.

## [2.1.7] - 2026-04-19

When you run a long orchestration and Claude Code compacts its context mid-flight, Orchestray now writes a resilience dossier to disk before compaction happens, then re-injects a concise summary of orchestration state on your next message — so the PM picks up where it left off instead of starting blind. This is on by default. Everything else in this release is quality and hardening: the Haiku extraction backend that was stubbed in v2.1.6 is now wired and live, the KB bare-slug detector gets a two-signal algorithm that eliminates false positives, and the `max_per_task` MCP config keys that have been a backlog item since v2.1.5 are now fully schema-validated.

### What's new

- **Compaction resilience — on by default.** Before context compaction fires, Orchestray serializes a dossier of the active orchestration (phase, task list, group assignments, routing lookups, cost summary) to `.orchestray/state/resilience-dossier.json`. On your next message after compaction, the PM receives this snapshot as additional context and can resume without asking you to re-explain the task. A `/orchestray:doctor` probe (P9) now checks that the resilience surface is healthy. To opt out, set `resilience.enabled: false` in `.orchestray/config.json` or `ORCHESTRAY_RESILIENCE_DISABLED=1` in the environment. Note: `/clear` is a deliberate user reset and is never treated as compaction — clearing the context does not trigger re-injection.

- **Live Haiku extraction backend.** The auto-extraction pipeline introduced in v2.1.6 now makes a real Haiku model call via the `pattern-extractor` agent. Previously the backend was a stub; proposals could be queued but never populated. With the live backend enabled (`auto_learning.extract_on_complete.enabled: true`), completed orchestrations are analysed and proposals land in `.orchestray/proposed-patterns/` for your review. The kill switch, circuit breaker, input quarantine, and output-validation layers from v2.1.6 all apply unchanged.

- **Improved bare-slug detection in KB reference sweep.** The KB sweep's bare-slug detector now requires two independent signals before flagging a reference (a prefix phrase such as `see also:` or a markdown link context, plus a structural context such as a list item or table cell). The previous single-regex approach produced 33 false positives on English words like "pattern" and "checks"; the new approach surfaces 62 true-positive unregistered link references with zero false positives on the same corpus. Existing ignore-list entries remain honoured.

- **`max_per_task` MCP config keys are now validated.** The schema-validation TODO that has existed since v2.1.5 is retired. `loadMcpServerConfig` and `validateMcpServerConfig` enforce integer ranges (1–1000) for `ask_user`, `kb_write`, and `pattern_record_application` per-task caps. Out-of-range values fall back to the default and write a `mcp_server_max_per_task_out_of_range` degraded-journal entry; unrecognised tool names are passed through and write `mcp_server_max_per_task_unknown_tool`.

### Safety

- **Fence-escape guard on the resilience dossier.** Before the dossier is injected into your session context, the serializer scans for the closing fence marker that wraps the injected block. If a project file happened to contain that exact text and ended up in the dossier, it could break the fence boundary and leak dossier content outside the intended block. The guard detects this at serialization time: it clears the affected fields, adds a `fence_collision_cleared` flag, and emits a `rehydration_skipped_fence_collision` audit event. The injector also runs a defense-in-depth check on the raw dossier file at injection time. The dossier is never injected if any fence-escape path is triggered. Cyrillic and other Unicode lookalike characters do not bypass the check (NFKC normalization is applied before scanning).

- **Parse-failure journal no longer logs raw dossier bytes.** Previously, when a dossier file failed to parse, the first 100 raw bytes were written to the degraded journal. Those bytes could contain orchestration state that should not appear in logs. The journal entry now records a safe fingerprint (file length, first byte hex, SHA-256 prefix) with no recoverable content.

- **K7 path-exclusion check hardened against traversal.** The K7 filter that excludes resilience-dossier paths from auto-extraction input now uses canonical path resolution (`path.normalize` + `path.resolve`) and explicitly rejects `..` components after normalization, preventing crafted event paths from escaping the exclusion zone.

### Defaults

| Key | Default | Notes |
|-----|---------|-------|
| `resilience.enabled` | `true` | Live by default — resilience is active on fresh installs |
| `resilience.shadow_mode` | `false` | Not shadow by default — full injection on detected compaction |
| `resilience.inject_max_bytes` | `12288` | Max bytes injected into context (range 512–32768) |
| `resilience.max_inject_turns` | `3` | Max injection attempts per compaction event before suppression |
| `resilience.kill_switch` | `false` | Set `true` to disable resilience without touching `enabled` |

### Operator notes

- **Resilience is live by default.** Set `resilience.enabled: false` or `ORCHESTRAY_RESILIENCE_DISABLED=1` to opt out entirely. No restart needed — the config loader checks before each injection.
- **`/clear` is a clean reset.** Running `/clear` in Claude Code is recognized as a deliberate user reset (`source: "clear"`) and does not trigger dossier injection on the next message. Only `SessionStart` events with `source: "compact"` or `source: "resume"` activate re-injection.
- **Upgrading from v2.1.6.** The `bin/install.js` upgrade path now merges the required `## Compact Instructions` section into your project-level `CLAUDE.md` if it is absent. This section tells Claude Code's auto-compaction to preserve orchestration state markers. The merge is idempotent — if the section already exists, nothing changes.
- **Haiku extraction backend requires an active circuit breaker budget.** The rolling 24-hour cap (`auto_learning.safety.circuit_breaker.max_extractions_per_24h`, default 10) applies to the live backend as it did to the stub. Each orchestration counts as one attempt regardless of proposal count.
- **`max_per_task` validation is backward-compatible.** `readMaxPerTask(config, toolName)` remains the existing two-argument call signature; the new `(config, toolName, cwd)` form opts into validated loading. No config migration needed.

### Hardening (zero-deferral patch)

Pre-ship adversarial audit closed all previously-deferred items: path-field sanitiser now emits a `dossier_field_sanitised` journal entry when an adversarial path value is dropped, bounded fd-based file reads replace the stat-then-read pattern at all seven reader sites eliminating the TOCTOU race window, and a documentation sweep corrected stale references to `haiku-sdk`, the dossier schema version, and fence-scan NFKC coverage. All five items that earlier appeared in "Not in this release" (SEC-04, SEC-06, SEC-07, D3, and `haiku-sdk`/F4) are now included in this release.

### Not in this release

- **Auto-application of curator suggestions and auto-approval of proposed patterns.** Human-gated; not planned for v2.1.x.
- **Schema validation via `zod`, cross-machine federation sync, per-pattern privacy flag, team-scope federation.** Carried over to v2.2+.

## [2.1.6] - 2026-04-19

Orchestray can now learn from your orchestrations automatically, not just when you remember to run `/orchestray:learn`. Every feature in this release ships turned off by default and behind a single kill switch. Nothing applies to your project without you reviewing it first.

### What's new

- **Auto-extraction of patterns after orchestrations (opt-in, default off)** — when you enable `auto_learning.extract_on_complete.enabled: true`, Orchestray analyses each completed orchestration and stages pattern proposals in `.orchestray/proposed-patterns/` for your review. Nothing lands in your active pattern set automatically. Your first time? Set `shadow_mode: true` as well — you get the event trail and proposal count notification but no files are written.
- **Review workflow for staged proposals** — new subcommands on `/orchestray:learn`: `list --proposed` shows what has been staged, `accept <slug>` runs a full re-validation and shows you the body before moving anything to your active patterns, `reject <slug>` soft-deletes to a `rejected/` subfolder. The `accept` step warns you if the proposal contains unusual instruction-like content before you confirm.
- **Pattern ROI and calibration suggestions (opt-in, default off)** — enable `auto_learning.roi_aggregator.enabled: true` for a daily read-only scan that correlates your pattern applications with orchestration cost. Suggestions land in `.orchestray/kb/artifacts/` as advisory documents marked "SUGGESTED — NOT APPLIED"; they are never acted on automatically. `/orchestray:patterns` and `/orchestray:status` show a pending-count banner when suggestions are waiting.
- **KB reference sweep (opt-in, default off)** — enable `auto_learning.kb_refs_sweep.enabled: true` for a weekly dry-run scan that finds broken `@orchestray:kb://`, `@orchestray:pattern://`, and cross-reference links across your KB and patterns. The scan writes a report and never edits anything.
- **Updated observability surfaces** — `/orchestray:patterns` and `/orchestray:status` now show auto-learning state, kill-switch source, pending proposal count, and circuit-breaker status in a summary banner.
- **Single kill switch** — set `auto_learning.global_kill_switch: true` in `.orchestray/config.json`, or set the environment variable `ORCHESTRAY_AUTO_LEARNING_KILL_SWITCH=1`, to disable the entire auto-learning bundle instantly. No restart needed; the config loader checks it before any sub-feature runs.
- **Config repair** — `/orchestray:config repair` reinitialises a missing or malformed `auto_learning` block in your config without touching any other key.

### Safety

Three layers stand between an orchestration's raw audit events and your active pattern set:

- **Input quarantine** strips free-text and rationale fields from audit events before any model sees them, then drops events whose retained fields match known secret patterns (API keys, tokens, connection strings).
- **Output validation** rejects any proposal that contains instruction-like phrases, including variants that use lookalike characters from Cyrillic, Greek, fullwidth, and other scripts. Protected fields (`confidence`, `trigger_actions`, `deprecated`, `times_applied`, and others) can never be set by an auto-extracted proposal.
- **Human review** — you. Every proposal waits in `.orchestray/proposed-patterns/` until you run `/orchestray:learn accept <slug>` or `/orchestray:learn reject <slug>`. The accept step re-runs validation on the full file and shows a warning if any instruction-like content survived.

Additional safeguards: a concurrency-safe circuit breaker caps extraction attempts to 10 per 24 hours with a cross-process lock. Shadow mode still counts against the cap (the model cost is real). Curator reconcile's promote and unshare auto-repair paths now refuse to act on tombstones written before v2.1.6, and flag them for human recovery instead.

### Defaults (everything opt-in)

| Key | Default |
|-----|---------|
| `auto_learning.global_kill_switch` | `false` |
| `auto_learning.extract_on_complete.enabled` | `false` |
| `auto_learning.extract_on_complete.shadow_mode` | `false` |
| `auto_learning.roi_aggregator.enabled` | `false` |
| `auto_learning.kb_refs_sweep.enabled` | `false` |

No flag defaults to `true`. You must opt in to each feature explicitly.

### Operator notes

- `/orchestray:config repair` is safe to run at any time; if your `auto_learning` block is already valid, it is a no-op.
- The pattern-collision check in `share` now emits a warning when a slug you are promoting already exists in the shared tier with different content, before proceeding.
- Known residual: the bare-slug reference detector in the KB sweep uses a conservative regex that requires an explicit prefix ("see also", "ref", "refers to", "linked") before a slug. Sentences matching this pattern in normal prose can produce false positives — inspect the sweep report before acting on bare-slug findings.
- The Haiku extraction backend ships as a stub in this release. All pipeline plumbing (gates, quarantine, validation, file writing, audit events) is fully wired and tested; the live model call is a follow-on opt-in. Proposals in `proposed-patterns/` will appear once the backend is wired in a subsequent update.
- Auto-application of curator suggestions and auto-approval of proposed patterns remain human-gated and are not planned for v2.1.x.

## [2.1.5] - 2026-04-19

Quality and correctness pass for the `curate --diff` incremental mode that shipped in v2.1.4, plus a real-bug fix for a misleading health warning that every v2.1.4 install was journaling on boot. One new config knob. No breaking changes.

### Added

- **Efficiency panel in `/orchestray:patterns`.** After you run `/orchestray:learn curate --diff` a few times, the patterns dashboard now shows a new section that tells you whether the incremental mode is actually saving curator work — per-run corpus and dirty ratios, action counts, and (once at least three `--diff` runs have accumulated) an overall GOOD / OK / LOW efficiency tag. If you have never run `--diff`, the panel shows a one-line hint pointing at the command.
- **New config key `curator.diff_forced_full_every` in `.orchestray/config.json`.** `curate --diff` always runs a full sweep every Nth invocation as a self-healing safety net. `N` was hardcoded at 10 in v2.1.4; you can now tune it (integer 1..1000, default 10). Raise it if you run `--diff` very frequently and want fewer forced full sweeps; lower it if you want tighter staleness protection.

### Changed

- **`curate --diff` "nothing to do" now reports honestly.** When the dirty set is empty (every pattern has been curated recently and nothing has changed), the zero-work case now journals a distinct event instead of pretending a forced-full sweep fired. This was a v2.1.4 workaround — the dedicated signal did not exist yet. `/orchestray:doctor` analysis of forced-full events becomes unambiguous: it only shows up when a real forced sweep happened.

### Fixed

- **Phantom "install integrity drift" warning on every boot.** v2.1.4 installs journaled a fake health warning at every MCP server boot claiming 169 plugin files were missing and 2 had drifted. None of it was real — the integrity check was looking in the wrong directory. The warning is gone. Tests have been added to catch this class of regression if the install layout ever shifts again. No user action needed; the next `/orchestray:doctor --deep` run on a v2.1.5 install will report clean.
- **`curate --diff` design-doc corrections.** The internal design doc in the knowledge base had two drift issues: the default for `curator.diff_cutoff_days` was documented as `45` but shipped at `30`, and a degraded-journal signal was listed under its draft name `curator_diff_stamp_corrupt` instead of the shipped name `curator_diff_cursor_corrupt`. Both fixed — operators reading the design to understand the signals they see in `degraded.jsonl` will no longer chase phantom names. An inline code comment that mentioned "cursor" terminology has also been clarified (there is no cursor file; "cursor" refers to the body-hash field inside each pattern's stamp).
- **`curator_diff_forced_full_triggered` event-schema description.** The table entry in `event-schemas.md` still said the trigger was a hardcoded `% 10 === 0`. Now that the cadence is configurable via `curator.diff_forced_full_every`, the description reflects the variable-N formulation.

### Under the hood (quality)

These do not change what you see, but keep the project healthy:

- **Test-isolation hardening.** Six test files were silently environment-dependent — they exercised pattern lookup without opting out of the real `~/.orchestray/shared/` federation directory, so their pass/fail could drift based on what was in your personal shared tier. A new global test-setup hook now opts every test file out of the real shared directory, and a guard test fails loudly if the wiring is ever removed. This caught one real pre-existing test failure during v2.1.5 work and hardens all future tests.
- **Release-checklist correctness.** The release-manager agent's pre-publish checklist used to name `manifest.json` as the Claude Code plugin manifest file. The actual file is `.claude-plugin/plugin.json` — as a result, v2.1.4 shipped with that file one version behind `package.json` (a parity test was the only thing that caught it). The checklist now names the correct path and adds an explicit parity check as a hard block before commit. CHANGELOG style guidance in the agent now also requires user-readable prose — this entry is the first written under that rule.

### Not in this release

- **Config validation for per-task MCP limits (`max_per_task` keys).** Still a backlog item, targeted for v2.1.6 with its own small fix spec. Non-blocking — the default per-task limits continue to work correctly; this would only matter if you are overriding them in `.orchestray/config.json`.
- **Schema validation via `zod`.** Adding stricter validation for MCP enforcement config requires introducing a new runtime dependency. Patch releases do not add runtime dependencies; revisit in v2.2 if the dependency policy is relaxed.
- **Cross-machine federation sync, per-pattern privacy flag, team-scope federation.** Carried over from the v2.1.3 and v2.1.4 roadmap — these are v2.2 / v2.3 features. v2.1.x continues to share patterns across projects on a single machine only.

## [2.1.4] - 2026-04-19

**Researcher core agent, tombstone similarity fields, and `curate --diff` incremental mode.** A new read-only, web-enabled Researcher agent fills the gap between Architect (internal design) and Inventor (novel tools) by surveying existing external approaches before either is spawned. Tombstone merge records now carry the four MinHash constants reserved in v2.1.3, making pre-filter parameters reproducible. `curate --diff` ships as opt-in incremental curation — a dirty-set engine pre-filters patterns on five signals and cuts curator attention on stable libraries to near-zero; every 10th run forces a full sweep for self-healing.

### Added

- **Researcher core agent.** `agents/researcher.md` (337 LOC) — read-only, web-enabled agent that surveys existing external approaches for a stated goal and returns a decision-ready shortlist. Fills the gap between Architect (designs internal integration) and Inventor (builds novel tools from first principles); runs before either when outside-world knowledge is needed. PM routing: "best library / which approach / prior art" → Researcher; ambiguous → Researcher as safe default; "build our own / custom / novel / no deps" → Inventor. Mandatory handoff: if Researcher returns `verdict: recommend_build_custom` or `no_clear_fit`, PM injects the landscape table into the Inventor delegation so Inventor skips its Phase 2 landscape survey.
- **`research_summary` structured-result extension.** `agents/pm-reference/agent-common-protocol.md` gains the `research_summary` output field for Researcher results. `agents/pm-reference/delegation-templates.md` gains a Researcher Checklist section.
- **`curate --diff` incremental mode (H6).** Opt-in (`curator.diff_enabled: false` by default). On `/orchestray:learn curate --diff`, `bin/_lib/curator-diff.js` (~435 LOC) pre-filters patterns via five signals: stamp-absent, body-hash drift, stale-stamp (older than `curator.diff_cutoff_days`, default 30 days), rolled-back-action touched, and merge-lineage-dirty. Patterns outside the dirty set are skipped; curator agent only sees the dirty subset.
- **Forced-full self-healing cadence.** Every 10th `--diff` run is a forced full sweep regardless of stamp freshness, preventing silent stamp rot from accumulating. The `curator_diff_rollup` event's `forced_full_sweep` boolean signals when this fires.
- **Sixth stamp key `recently_curated_body_sha256`.** Added to `bin/_lib/curator-recently-curated.js`; stripped on federation share alongside the existing 5 stamp keys. Enables body-hash drift detection on subsequent `--diff` runs.
- **Two new config keys.** `curator.diff_enabled` (default `false` — opt-in) and `curator.diff_cutoff_days` (default `30`) added to `bin/_lib/config-schema.js`.
- **Three new degraded-journal KINDs.** `curator_diff_cursor_corrupt` (stamp present but `body_sha256` missing/malformed), `curator_diff_hash_compute_failed` (could not read/hash pattern body), `curator_diff_forced_full_triggered` (self-healing forced full sweep). All follow the v2.1.2 journal conventions.
- **`curator_diff_rollup` event.** Emitted to `events.jsonl` at end of each `curate --diff` run (after `curator_run_complete`). Carries `corpus_size`, `dirty_size`, `dirty_breakdown` (per-signal counts), `actions_applied`, `skipped_clean`, and `forced_full_sweep`. Schema documented in `agents/pm-reference/event-schemas.md §curator_diff_rollup`.
- **Fifth stamp action value `"evaluated"`.** Recorded in `recently_curated_action` for patterns the curator reviewed but took no action on during a `--diff` run.

### Changed

- **Tombstone similarity fields now populated.** `bin/_lib/curator-tombstone.js` fills the four fields reserved in v2.1.3 (`similarity_method`, `similarity_threshold`, `similarity_k`, `similarity_m`) on every merge tombstone, citing the MinHash constants exported from `bin/_lib/curator-duplicate-detect.js`. v2.1.3 tombstones without these fields remain valid and undoable.
- **Curator prompt gains `## Incremental Mode (--diff)` section.** Explains dirty-set scoping so the curator agent knows it is operating on a subset and should not treat absent patterns as candidates for deprecation.
- **`npm test` glob expanded.** The `test` script in `package.json` now includes `bin/_lib/__tests__/*.test.js`, pulling 300 previously-uncovered tests into `npm test`. All passing (7 pre-existing failures in `tests/pattern-find-decay.test.js` unchanged).

## [2.1.3] - 2026-04-19

**Intelligence — shadow scorers, duplicate pre-filter, recently_curated stamps, and install-integrity manifest + `/orchestray:doctor --deep`.** Three bundles ship together: a pluggable shadow-scorer seam that runs alternate ranking functions side-by-side with the baseline (without ever changing what `pattern_find` returns), a MinHash+Jaccard duplicate pre-filter that cuts curator attention cost from O(N²) to O(N+k), and a manifest-v2 installer that records per-file SHA-256 hashes so `/orchestray:doctor --deep` can verify install integrity at any time. A fourth addition — post-hoc `recently_curated_*` frontmatter stamps — closes the loop between curator actions and the patterns they touch, and federation's `share` command strips the stamps before writing to the shared tier so they never escape the project.

### Added

- **Shadow scorer seam — Bundle RS.** `bin/_lib/scorer-shadow.js` adds a pluggable rank-comparison seam to `pattern_find`. After the baseline result set is materialized and sliced, shadow scorers receive a clone of the candidates, re-rank them independently, and emit agreement telemetry (Kendall tau-b, top-K overlap, displacement) to `.orchestray/state/scorer-shadow.jsonl` (1 MB × 3-gen rotation). Shadow runs are fire-and-forget via `setImmediate`; the return value is never captured and cannot reach the MCP response. Baseline scoring is byte-identical to v2.1.2 at default config.
- **Skip-signal down-ranking scorer — Bundle RS.** `bin/_lib/scorer-skip-down.js` computes a Laplace-smoothed penalty from `contextual-mismatch` and `superseded` skip events. Ships shadow-only in v2.1.3; activate by adding `"skip-down"` to `retrieval.shadow_scorers` (default: `[]`).
- **Local success-rate boost scorer — Bundle RS.** `bin/_lib/scorer-local-success.js` applies a positive personalization boost from `pattern_record_application` events. Ships shadow-only in v2.1.3; activate by adding `"local-success"` to `retrieval.shadow_scorers`.
- **Shadow scorer dashboard — Bundle RS.** `/orchestray:patterns` gains a new Section 8 that aggregates `.orchestray/state/scorer-shadow.jsonl` telemetry: per-scorer tau-b distribution, mean displacement, and top-K overlap rate.
- **MinHash+Jaccard duplicate pre-filter — Bundle CI.** `bin/_lib/curator-duplicate-detect.js` detects near-duplicate pattern pairs (k=5 shingles, m=128 permutations, Jaccard threshold=0.6) before curator attention, reducing O(N²) comparisons to O(N+k). On detector failure the curator falls back to all-pairs with a `curator_duplicate_detect_failed` degraded-journal entry.
- **`recently_curated_*` frontmatter stamps — Bundle CI.** After every curator run the SKILL dispatcher calls `bin/curator-apply-stamps.js <runId>` to write 5 dotted-prefix keys (`recently_curated_at`, `recently_curated_action`, `recently_curated_action_id`, `recently_curated_run_id`, `recently_curated_why`) into each touched pattern's frontmatter. Stamps use REPLACE semantics on re-stamp. `curator undo` strips all 5 keys on rollback. `share` strips all 5 keys before the shared-tier write so stamps never leak to federation peers.
- **Manifest v2 with per-file hashes — Bundle II.** `bin/_lib/install-manifest.js` now writes `manifest_schema: 2` and a `files_hashes: { "<rel/path>": "<sha256>" }` map into `manifest.json` at install time. Additive — v1 consumers keep working. On MCP server boot, `verifyManifestOnBoot` checks hashes fail-open: drift is journaled as `install_integrity_drift` and boot continues; no exception is ever thrown.
- **`/orchestray:doctor --deep` flag — Bundle II.** The existing doctor skill gains an opt-in `--deep` flag that runs full manifest verification against `files_hashes`. Without `--deep`, v2.1.2 behavior is unchanged (8 probes, fast). With `--deep`, a ninth probe verifies every file hash and reports any drifted paths.
- **6 new degraded-journal KINDS.** `install_integrity_drift`, `manifest_v1_legacy`, `install_integrity_verify_slow`, `shadow_scorer_failed`, `curator_duplicate_detect_failed`, `curator_stamp_apply_failed`. All follow the v2.1.2 journal conventions (1-KB line cap, never throws).

### Changed

- **`retrieval.scorer_variant` config key.** Enum-locked to `"baseline"` in v2.1.3. The seam accepts alternate values but the resolver does not activate any non-baseline scorer via this key yet. Use `retrieval.shadow_scorers` to add shadow scorers without changing the live ranking path.

### Not in this release

Items held for v2.2+ after shadow telemetry has real data:

- **`curate --diff` incremental mode (H6, v2.2)** — changed-since-last-run cursor; needs H1 + rationale stable in the wild first.
- **Structured query expansion / synonym tables (H7, v2.2)** — benefits compound once shadow eval (H1) is in place.
- **Cross-machine federation sync (H8, v2.2)** — single-machine only; needs its own design doc.
- **Per-pattern privacy flag (H9, v2.2)** — `federation.sensitivity` remains per-project for now.
- **Team / multi-user federation (H10, v2.3+)** — blocked on security review.

v2.1.4 candidates (once shadow scorers accumulate real telemetry): promote `skip-down` or `local-success` from shadow to live ranking; wire `similarity_method`/`threshold`/`k`/`m` into merge tombstones.

## [2.1.2] - 2026-04-19

**Observability — you can now see federation tier, curator reasoning, retrieval matches, and silent fallbacks.** Four bundles ship together: federation tier badges on every pattern retrieval, curator `rationale` and `explain` for auditing curation decisions, per-term `match_reasons` so you know why a pattern surfaced, and a degraded-mode journal plus `/orchestray:doctor` to surface silent fallbacks before they cause confusion.

### Added

- **Federation tier badge in retrieval (Bundle F).** `pattern_find` matches now carry
  `promoted_from` and `promoted_is_own` fields. The PM's delegation prompt displays a
  bracketed badge (`[local]`, `[shared]`, or `[shared, own]`) next to each cited pattern,
  making the trust tier visible in every orchestration audit trail. The `pattern://` MCP
  resource banner also shows the tier. Citation format in `tier1-orchestration.md` §22b
  and `delegation-templates.md` tightened to require the badge — omitting it is now a
  protocol violation.
- **`/orchestray:federation status` skill (Bundle F).** Zero new JS — reads config and
  filesystem. Reports enabled/disabled/partial states, shared-dir contents, FTS5
  availability, and origin attribution for shared patterns. Run it when federation
  behaves unexpectedly.
- **`share --preview` flag on `/orchestray:learn share` (Bundle F).** Returns a
  sanitized before/after diff without writing anything. Useful for reviewing what
  path-stripping and header-downgrading will do to a pattern before committing the share.
- **Per-action `rationale` field in curator tombstones (Bundle C).** Every curator
  action now records the curator's full reasoning in the tombstone (`rationale.text`,
  `rationale.confidence`, `rationale.schema_version: 1`). Additive — old tombstones
  without `rationale` continue to work for undo, explain, and reconcile.
- **`/orchestray:learn explain <action-id>` subcommand (Bundle C).** Shows the curator's
  reasoning for a past action, pulled from the tombstone `rationale` field. Falls back
  gracefully to `action_summary` for pre-v2.1.2 tombstones without rationale.
- **Pattern health score in `/orchestray:patterns` (Bundle C).** Each pattern now shows
  a computed health score: `clamp(decayed_confidence × usage_boost × freshness_factor ×
  (1 - skip_penalty), 0, 1)`. Tiers: healthy ≥ 0.60 / stale 0.40–0.59 / needs-attention
  < 0.40. A new `### Needs attention` section surfaces patterns below 0.40 so stale or
  frequently-skipped patterns are easy to find and curate.
- **Per-term `match_reasons` via FTS5 `matchinfo()` / `highlight()` (Bundle R).**
  `pattern_find` results now include fine-grained match reasons like
  `"fts5:term=audit (in context, approach)"` instead of the flat `"fts5"` string.
  The keyword fallback path emits `"fallback: keyword"` explicitly. `match_reasons`
  stays `string[]` — no consumer breakage.
- **Degraded-mode journal at `.orchestray/state/degraded.jsonl` (Bundle D).** Versioned
  JSONL, 1 MB × 3-generation rotation, 1024-byte per-line cap, never throws. Nine
  silent-fallback sites are now instrumented: `fts5_fallback`, `fts5_backend_unavailable`,
  `flat_federation_keys_accepted`, `flat_curator_keys_accepted`, `shared_dir_create_failed`,
  `curator_reconcile_flagged`, `config_load_failed`, `hook_merge_noop`. Check
  `.orchestray/state/degraded.jsonl` whenever something is silently degraded.
- **`/orchestray:doctor` skill (Bundle D).** Runs 8 probes: migrations present, MCP
  tools/list, config keys, shared-dir writable, FTS5 loaded, better-sqlite3 ABI,
  journal tail, manifest/VERSION coherence. Emits a `doctor-result-code: 0|1|2` sentinel
  line on the last output line (0 = healthy, 1 = warnings, 2 = errors). Run it after
  upgrade or when the MCP server misbehaves.
- **`/orchestray:status` step 0 journal summary (Bundle D).** When
  `.orchestray/state/degraded.jsonl` is non-empty, `/orchestray:status` now surfaces a
  one-liner (e.g., "2 degraded events since last restart — run /orchestray:doctor") so
  silent fallbacks are visible without polling the journal directly.

### Changed

- **Citation format tightened (Bundle F).** The `[shared]` citation line in
  `tier1-orchestration.md` §22b now includes `applied Nx` to match the format mandated
  by `delegation-templates.md`. Operators relying on pattern-audit log parsing should
  expect `applied Nx` in all three tier variants (`[local]`, `[shared]`, `[shared, own]`).

### Fixed

- **Curator phantom-success (W1):** If an agent turn was truncated between the tombstone
  write and the actual file operation, the tombstone claimed success but the shared-tier
  file (for a promote) or the delete (for an unshare) never happened. `undo` became a
  silent no-op because rolling back a promote only restores the local source file, not
  the missing shared-tier destination. Two complementary fixes applied:

  **Option A (reordering):** `agents/curator.md` §5 now instructs the agent to execute
  the destructive file operation first, then write the tombstone in a try/finally. This
  eliminates the phantom-success row — if the action didn't happen, no tombstone is
  written. The failure mode inverts to "untracked success" (action happened, tombstone
  write crashed), which is detectable and safe to re-curate.

  **Option B (post-run reconciliation):** New `bin/_lib/curator-reconcile.js` module.
  After every `curate` run (non-dry-run), the `skills/orchestray:learn/SKILL.md` curate
  block calls `reconcile({ projectRoot, runId })`. For each tombstone in the most-recent
  run, reconciliation checks filesystem reality against what the tombstone claims:
    - `promote` — shared-tier file absent → auto-repaired (content_snapshot copied).
    - `unshare` — shared-tier file still present → auto-repaired (file deleted).
    - `merge`   — output file absent → flagged for user review (cannot auto-synthesise).
    - `deprecate` — file present without `deprecated: true` → flagged for user review.
  Already-rolled-back tombstones are skipped. Happy-path users see nothing different;
  a truncated run now surfaces a "Reconciliation: repaired N, flagged M" line in the
  summary instead of silently leaving state inconsistent.

  `skills/orchestray:learn/SKILL.md` unshare block updated to match the new ordering
  (delete first, tombstone second).

- **Silent regression (v2.1.0):** `federation.*` and `curator.*` config settings set via
  `/orchestray:config set` were silently ignored — the loaders read nested-object form
  while the documented default config and set command wrote flat dotted keys. Federation
  never activated and curator setting changes never persisted for any user who used the
  documented path. Loaders now accept both forms (nested wins on collision); set command
  now writes nested form; SKILL.md defaults block updated to canonical nested shape.
  Existing on-disk flat configs continue to work immediately — no migration step needed.
  A one-time deprecation warning is printed to stderr per process when flat keys are
  detected to guide organic migration.
- **First-spawn missing-model tax:** On almost every orchestration the PM's first `Agent()`
  call omitted the `model` parameter, causing `gate-agent-spawn.js` to block the spawn
  (exit 2) and forcing a re-spawn. Strengthened the model-required reminder in Section 19
  of `agents/pm.md` and `agents/pm-reference/tier1-orchestration.md` with explicit callout
  boxes and code examples at the delegation-template site so the model field is never
  omitted on first spawn.

### Not in this release

- **Retrieval shadow scorer (v2.1.3, H1)** — pluggable rank-comparison seam; needs
  `match_reasons` (this release) stable in the wild first.
- **Skip-signal down-ranking + local success-rate boost (v2.1.3, H2)** — ride H1 shadow
  mode before replacing baseline scoring.
- **Curator duplicate pre-filter / MinHash (v2.1.3, H3)** — similarity score wants to
  land inside the `rationale` field (this release) before adding the pre-filter step.
- **`recently_curated:` annotation (v2.1.3, H4)** — links to rationale; natural next step.
- **`/orchestray:doctor --deep` install-integrity checksums (v2.1.3/v2.2, H5)** — basic
  doctor lands here; deep checksum manifest is a separate design decision.
- **Cross-machine federation sync (v2.2, H8)** — federation is still single-machine only.
- **Per-pattern privacy flag (v2.2, H9)** — privacy remains per-project via
  `federation.sensitivity` for now.
- **Team / multi-user federation (v2.3+, H10)** — needs its own security review first.

## [2.1.1] - 2026-04-17

**Hotfix: MCP server failed to start after a v2.1.0 install because the FTS5 SQLite migration helpers never shipped.** Reinstall to pick up the fix.

### Fixed

- Installer now ships `bin/_lib/migrations/` alongside the rest of `_lib/`.
  The v2.1.0 installer only copied top-level `.js` files under `bin/_lib/`, so the
  `migrations/001-fts5-initial.js` module added for FTS5 was missing from the
  install target. The MCP server required it at startup via
  `pattern-index-sqlite.js` and crashed with `MODULE_NOT_FOUND`, which Claude Code
  surfaced as `/mcp` showing "Failed to reconnect to orchestray." Regression test
  added (`tests/install-lib-migrations.test.js`): asserts `migrations/` ships,
  `__tests__/` does not, and the MCP server emits its ready banner within 3s.

## [2.1.0] - 2026-04-17

**Your patterns can follow you across projects now, finding the right one works better, and Orchestray can tidy up your pattern library for you.**

### Added

- **Share patterns across projects on your machine.** Off by default. Turn it on with
  `/orchestray:config set federation.shared_dir_enabled true`, then use
  `/orchestray:learn share <slug>` to publish a pattern. Shared patterns live at
  `~/.orchestray/shared/` and show up in every project that has federation enabled.
  Nothing leaves your project unless you explicitly share it — sensitivity defaults
  to `private`.
- **Better pattern search.** Orchestray now uses full-text search with smarter
  ranking, so the patterns that surface for a task actually match the task. This
  replaces the old keyword-overlap scoring. Works automatically — no config needed.
  Adds one dependency (`better-sqlite3`); if it can't build on your machine,
  retrieval falls back to the old scoring with a warning.
- **AI curator for your pattern library.** Run `/orchestray:learn curate` when you
  want Orchestray to review your patterns and tidy up: share the ones ready to cross
  projects, merge duplicates, and retire the stale ones. You stay in control: every
  curator action is reversible with `/orchestray:learn undo-last` or
  `/orchestray:learn undo <id>`. The curator never touches patterns you created to
  correct past mistakes (`user-correction` category), and never shares anything
  marked private.

### Changed

- **Some commands got clearer names.** Old commands still work in v2.1.x with a
  deprecation warning, but please update your muscle memory:
  - `promote` → `share`
  - `list-shared` → `list --shared`
  - `revoke-shared` → `unshare`

### Not in this release

Features explicitly held back for later releases:

- Cross-machine sync (v2.2) — federation is currently single-machine only.
- Team/multi-user sharing (v2.3+) — needs its own security review first.
- Per-pattern privacy flag (v2.2) — for now, privacy is set per-project via
  `federation.sensitivity`.

## [2.0.23] - 2026-04-17

### Theme: "Prompt caching on by default, pattern-retrieval gate moves from silent to visible"

Prompt caching is now enabled for all installs by default, delivering an estimated
10–40% token reduction per orchestration (actual savings depend on orchestration
length and cache hit rate). The pattern-retrieval gate (`pattern_find` / `kb_search`
pre-spawn checkpoint) shifts from fail-open to warn-mode: if the PM skips retrieval
before the first spawn, Orchestray now emits a one-time advisory to stderr rather
than silently continuing — a visible signal before v2.0.24 makes it a hard block.

### Added

- **Prompt caching enabled by default** — `v2017_experiments.prompt_caching` default
  flipped from `"off"` to `"on"` in `bin/_lib/config-schema.js` and `bin/install.js`.
  Fresh installs now get the `cache-prefix-lock.js` Block A drift-detection hook
  active out of the box. Existing installs with an explicit `"off"` keep that value;
  only fresh installs receive `"on"`. Expected cost impact: ~10–40% reduction per
  orchestration (actual depends on orchestration length and cache hit rate).
  Emergency kill-switch: set `v2017_experiments.prompt_caching: "off"` in
  `.orchestray/config.json` to revert on any existing install without a session
  restart.
- **Pattern-retrieval gate warn-mode advisory** — `bin/gate-agent-spawn.js` §22b
  gate now emits a one-time `[orchestray v2.0.23] info:` advisory to stderr when the
  PM spawns without first calling `pattern_find`. The advisory fires at most once per
  orchestration (a sentinel file in `.orchestray/state/` gates re-emission). There
  is no config path to silence this advisory in v2.0.23 — it is unconditional. The
  spawn is never blocked (exit 0). v2.0.24 will convert this to a hard block (exit 2).
  The §22c post-decomp gate (`pattern_record_application`) remains at `hook-strict`
  (blocking) and is unaffected.
- **`22b-T5` dual-gate integration test** (`tests/gate-agent-spawn.test.js`) — covers
  the full §22b warn + §22c block two-spawn path: first spawn with no retrieval emits
  advisory (exit 0), second spawn with routing.jsonl but no `pattern_record_application`
  hard-blocks (exit 2); sentinel holds across both spawns.
- **No-config default-on test** (`tests/cache-prefix-lock.test.js`) — new test asserts
  that `.block-a-hash` is seeded when no `config.json` is present, exercising the
  newly-reachable default-`"on"` path.

### Fixed

- **Warn-mode advisory wording** — advisory message prefix changed from `advisory:` to
  `info:` for consistency with Orchestray's stderr log-level conventions. True-absence
  path now lists the missing tools, replaces "No impact on this orchestration" with
  "This orchestration continues normally. The PM agent will apply retrieval in future
  orchestrations. Subsequent gate (hook-strict) may still block if
  `pattern_record_application` is not called.", and appends "This notice will not
  repeat for this orchestration." Phase-mismatch path message updated to "retrieval
  checkpoint record is inconsistent" with the same per-orch cadence signal.
- **`mcp_checkpoint_missing` audit event deduplication** — the `atomicAppendJsonl`
  call that writes the `mcp_checkpoint_missing` event is now inside the
  `if (!alreadyWarned)` sentinel block, so the event is emitted at most once per
  orchestration regardless of how many spawns occur. The event carries
  `warn_mode: true` to distinguish advisory-mode occurrences from the future
  blocking-mode events in v2.0.24.
- **Stale `cache_choreography.enabled` references removed** —
  `agents/pm-reference/prompt-caching-protocol.md` §1, §4, and §8 previously
  referenced `cache_choreography.enabled` as a secondary activation condition. That
  key has never existed in the config schema. All three references removed; §8 rollback
  block now correctly shows `v2017_experiments.prompt_caching: "off"` as the disable
  mechanism; §4 prose updated to "With `v2017_experiments.prompt_caching` not `"on"`,
  the `cache-prefix-lock.js` hook exits 0 immediately".
- **`config-schema.js` stale default comment** — inline comment on line 1627 corrected
  from `default "off"` to `default "on"` to match the constant on line 1637 and
  `bin/install.js`.

### Changed

- **`v2017_experiments.prompt_caching` default** — `"off"` → `"on"`. Applies to
  fresh installs only (existing installs with an explicit value are not touched by
  `post-upgrade-sweep.js`). See "Prompt caching enabled by default" in Added above
  for the emergency kill-switch path.

## [2.0.22] - 2026-04-16

### Theme: "No more silent upgrade gaps — open sessions now prompt for restart; registry writes are race-free"

If you run `/orchestray:update`, open sessions will now receive a one-time restart
prompt on the next user message, so new agent definitions actually take effect.
Upgrade to v2.0.22 and restart any open Claude Code sessions; the sentinel-based
warning mechanism will confirm the restart requirement automatically. If you use
specialist agents heavily, the registry write path is now race-free and handles
case-variant filenames on macOS APFS.

### Added

- **`bin/_lib/session-detect.js`** — new shared helper that determines whether the
  current Claude Code session started before or after the most recent Orchestray
  install by comparing the session's transcript JSONL mtime against the sentinel's
  `installed_at_ms`. Used by `post-upgrade-sweep.js` to distinguish pre-install
  sessions (need restart warning) from post-install sessions (agents already loaded).
- **`tests/regression/v2022-upgrade-sweep.test.js`** — regression suite for the
  4-case upgrade-pending state machine (Cases A/B/C/D); covers TTL expiry, schema v1
  cleanup, and per-session dedup.
- **`tests/regression/v2022-gate-first-spawn.test.js`** — regression suite for the
  gate-agent-spawn.js first-spawn fix (current-orch scoping).
- **`tests/regression/v2022-tier1-no-inline-schemas.test.js`** — guardrail test that
  prevents future drift between `tier1-orchestration.md` inline schemas and
  `event-schemas.md`; asserts that no fenced JSON blocks with `type:` fields appear
  in tier1 for the 7 swept event types.
- **`tests/mcp-server/tools/specialist_save.test.js`** — test suite for the atomic
  write path, case-rename scan, and reserved-name error in `specialist_save.js`.
- **Sections 40–43 in `event-schemas.md`** — canonical schemas for
  `orchestration_start`, `orchestration_complete`, `replan`, and
  `dynamic_agent_cleanup` events extracted from `tier1-orchestration.md` into the
  shared schema reference. `tier1-orchestration.md` now carries pointers instead of
  duplicated inline JSON blocks.
- **`tests/unit/`** — new unit test directory for module-level coverage (added
  alongside v2.0.22 test expansion).

### Fixed

- **`post-upgrade-sweep.js` 4-case state machine** — the v2.0.21 implementation
  compared sentinel mtime against session start time using a heuristic. Replaced
  with an explicit comparison: `installed_at_ms` (written by install.js) vs
  `sessionStartMs` from `session-detect.js` reading the transcript JSONL mtime.
  Sessions that postdate the install are silently cleared (Case B); pre-install
  sessions get the one-time restart warning (Case C); stale or v1-schema sentinels
  are cleaned up silently (Case D). TTL extended from 2 h to 7 days.
- **`install.js` sentinel schema v2** — sentinel now carries `schema_version: 2`,
  `installed_at_ms` (millisecond epoch for precise ordering), and `previous_version`
  (populated only when upgrading from a prior version; omitted on fresh installs).
  `mkdirSync` with `recursive: true` guards against ENOENT on fresh-machine installs.
  Single `Date.now()` capture for both ISO string and ms fields (AR2-B6 fix).
- **`install.js` previous_version read-after-write** — `readPreviousVersion()` is
  now called before `VERSION` is overwritten; previously `previous_version` always
  equalled the new version string (R2-B-1 fix).
- **`gate-agent-spawn.js` first-spawn routing collision** — `currentOrchId` is now
  loaded before both the task_id and description-fallback match branches; prior
  placement inside the `if (spawnTaskId)` block left the description-fallback path
  unscoped, allowing stale prior-orchestration entries to trigger false
  model-routing-mismatch exits on the first spawn of a new orchestration.
- **`specialist_save.js` atomic-pair guard on snapshot read failure** — previously
  a snapshot read error during a case-rename scan could leave the registry in an
  inconsistent state; the pair write is now skipped entirely when the read fails (B-1).
- **`specialist_save.js` case-rename scan with macOS APFS inode check** — when
  saving a specialist under a name that differs only in case from an existing file,
  the old file is unlinked; on APFS (case-insensitive), the inode is checked first
  and the unlink is skipped when both names point to the same physical file,
  preventing silent deletion of the just-written content (B-2, R2-B-2).
- **`specialist_save.js` reserved-name error restructure** — error message now leads
  with the problem name, offers a concrete example alternative, and moves the full
  reserved-names list to the end; previously the list preceded any actionable text (U-4).
- **`audit-event.js` dynamic_agent_spawn emission** — `paired_with: 'agent_start'`
  field added to the emitted event, documenting its correlation with the SubagentStart
  `agent_start` event.
- **`capture-pm-turn.js` metrics kill-switch** — `logStopHookFire()` now honors the
  `ORCHESTRAY_METRICS_DISABLED=1` environment variable; previously the kill-switch
  suppressed agent metrics but not stop-hook fire records.
- **`subagent-janitor.js` STALE_MS export removed** — `STALE_MS` was exported from
  the module but never imported by any consumer; removed to prevent callers from
  depending on an internal constant that may change (D-1).
- **`MODEL_UNKNOWN` no longer carries `window_1m`** — unknown models now render with
  `~denominator` context in the statusline as before; no user-visible change.
  (A `window_1m: 1000000` default added in v2.0.21 was removed in the v2.0.22
  clean-up pass; `statusline.js` already guards against absent `window_1m`, so
  unrecognised models fall back to the observed-window path as before.)

### Changed

- **`tier1-orchestration.md` inline schemas replaced with pointers** — 7 event
  schemas (`dynamic_agent_spawn`, `orchestration_start`, `orchestration_complete`,
  `replan`, `dynamic_agent_cleanup`, `consequence_forecast`, and `pattern_applied`)
  previously duplicated inline as fenced JSON blocks are now pointers to canonical
  sections in `event-schemas.md`. The `v2022-tier1-no-inline-schemas` regression test
  enforces this going forward.
- **`tier1-orchestration.md` Section 13 archetype classifier** — the inline list of
  archetype names is removed; classifier now reads the canonical table from
  `pipeline-templates.md` as the sole authoritative source. Prevents silent drift
  when new archetypes are added.
- **`post-upgrade-sweep.js` upgrade-sentinel TTL** — extended from 2 hours to 7 days.
  Sentinels from brief update windows were expiring before users returned to an open
  session, silently missing the restart prompt.
- **`pm.md` description field deduplicated** — Block A hash regenerated after the
  deduplication pass; `tests/.block-a-hash-expected` updated accordingly.

## [2.0.21] - 2026-04-16

### Theme: "Three new agents + specialist registry fix + telemetry overhaul"

Extends the core agent roster from 10 to 13, fixes the specialist registry that had
never populated across 90+ orchestrations, overhauled telemetry to close multiple
dead code paths, and hardens the routing gate against cross-orchestration collisions.

### Added

- **`release-manager` agent** — owns the release commit gate: version bump, CHANGELOG,
  README sweep, event-schema sync, pre-publish verification, and tag prep. Prevents
  release surfaces from drifting between releases (addresses the `feedback_release_readme_sweep`
  pattern).
- **`ux-critic` agent** — adversarial read-only critique of user-facing surfaces (slash
  commands, error messages, statusLine output, README claims) for friction, discoverability,
  consistency, and surprise. Read-only; never modifies files.
- **`platform-oracle` agent** — authoritative answers to platform questions (Claude Code,
  Anthropic SDK/API, MCP) via WebFetch + cited URLs. Distinguishes stable primitives from
  experimental/community features. Prevents the PM from reasoning from stale or
  hallucinated platform knowledge.
- **`mcp__orchestray__specialist_save` MCP tool** (`bin/mcp-server/tools/specialist_save.js`)
  — atomic write path for saving dynamic agent definitions to `.orchestray/specialists/`.
  Previously the PM had to write files manually; the tool validates the schema and updates
  the registry index atomically.
- **`dynamic_agent_spawn` audit event** — auto-emitted by `bin/audit-event.js` on
  every non-canonical `agent_type` detection (via the `additionalEventsPicker` extension
  in `bin/_lib/audit-event-writer.js`), so the specialist registry has a verifiable
  audit trail for each dynamic agent ever spawned.
- **Shared janitor module** (`bin/_lib/subagent-janitor.js`) — extracted from
  `capture-pm-turn.js`, now called from both `capture-pm-turn.js` (Stop hook) and
  `collect-context-telemetry.js` (SubagentStop). Stale subagent rows are now reaped
  within ~60s of any subagent activity, not only on rare PM Stop fires.
- **`claude-opus-4-7` model entry** — added to `bin/_lib/models.js` MODELS table with
  1M context-window variant. `MODEL_UNKNOWN` now includes a `window_1m: 1000000` default
  so future model rollouts don't break statusline rendering.

### Fixed

- **Specialist registry never populated** — diagnosed root cause as a circular doc pointer
  between `agents/pm.md` §20 and `agents/pm-reference/specialist-protocol.md`: each file
  said the other had the save criteria; neither did. Also: PM never spawned dynamic agents
  because trigger examples were too abstract. Fixes: concrete save criteria added to
  `specialist-protocol.md`; concrete dynamic-agent trigger examples added to
  `tier1-orchestration.md` §17.
- **`collect-context-telemetry.js` post-spawn handler was a dead no-op** — rewritten with
  multi-strategy match: `event.agent_id` → `event.tool_response.agent_id` →
  `event.tool_use_id` → janitor sweep fallback. Prior implementation assumed
  `PostToolUse` payload carries `agent_id` at top level, which it does not.
- **Subagent rows missing `tool_use_id`** — subagent rows now record `tool_use_id` at
  `PreToolUse` time so the post-spawn handler can correlate via that field when agent_id
  is unavailable.
- **Subagent model resolution missing fallback** — added 4th fallback to parent's
  `cache.session.model`; previously `model: inherit` agents whose own model was not yet
  known at `SubagentStart` resolved to `null`.
- **MCP server crash on post-install layout** — `bin/mcp-server/server.js` no longer
  crashes on startup when `package.json` is absent (install layout). Reads version from
  `VERSION` first, falls back to `package.json` for source/dev runs.
- **Statusline impossible display for 1M-context models** — `[ctx 99%!! 264.4K/200K]`
  could render when context window resolved to the standard 200K ceiling. Fixed by
  resolving the 1M window for Opus 4.7 and similar models, producing correct fills
  like `[ctx 28% 283.3K/1M]`.
- **Cross-orchestration task_id collision in routing gate** — `bin/gate-agent-spawn.js`
  task_id matching is now scoped to current `orchestration_id` first, falls back to
  global only when no current-orchestration match is found. Prevents W2-as-opus retries
  caused by task_id overlap across separate orchestrations.
- **Stop-hook under-firing now measurable** — `bin/capture-pm-turn.js` appends to
  `.orchestray/state/stop-hook.jsonl` on every invocation with `success`/`no_transcript`/
  `disabled`/... outcome so the rate of Stop hook misfires is observable.

### Changed

- **Agent roster: 10 → 13 core agents** — all enumerations of "the 10 core agents" in
  `agents/pm.md`, `agents/pm-reference/`, `CLAUDE.md`, and tests updated to 13.
  Reserved-name blocklist updated in 4 locations to include `release-manager`,
  `ux-critic`, `platform-oracle`.
- **PM tools list extended** — `agents/pm.md` now lists `mcp__orchestray__specialist_save`
  as an available tool.

## [2.0.20] - 2026-04-16

### Theme: "v2.0.19 statusLine hotfix"

Surgical patch. No feature work. Fixes a plugin-scope `settings.json` mis-wiring shipped
in 2.0.19 that prevented the context status bar from rendering on fresh installs.

### Fixed

- **Plugin `settings.json` wiring** — replaced the dead `statusLine` block (silently
  ignored by Claude Code in plugin scope) with a `subagentStatusLine` block pointing
  at the same `bin/statusline.js` script. Plugin `settings.json` honors only `agent`
  and `subagentStatusLine`; the session-scope `statusLine` must live in user-scope
  `~/.claude/settings.json`. This change silently activates the subagent status bar
  for every install with no user action.
- **README post-install instructions** — added a "Post-install: enable context status
  bar" subsection under Install with a copy-pasteable `~/.claude/settings.json`
  snippet. Calls out that `${CLAUDE_PLUGIN_ROOT}` does NOT expand in user-scope
  settings and that the absolute path must be substituted.
- **SessionStart advisory hint** — `bin/reset-context-telemetry.js` now emits a
  one-line stderr hint when `~/.claude/settings.json` is missing a `statusLine`
  entry pointing at Orchestray's `statusline.js`. Advisory-only; never auto-modifies
  user settings. Silent on fresh installs where the file does not yet exist, on
  unreadable/malformed user settings, or when the entry already points at Orchestray.
- **`.claude-plugin/plugin.json` version drift** — bumped from `2.0.17` (stale since
  v2.0.18) to `2.0.20` to match `package.json`.
- **`bin/install.js` `mergeHooks()` dedup** — entry-level dedup silently dropped new
  hooks when any existing hook in the same (event, matcher) entry already matched.
  Every v2.0.18-or-earlier user who ran `/orchestray:update` to v2.0.19 lost the four
  `collect-context-telemetry.js` hooks (SubagentStart, SubagentStop, pre/post-spawn)
  without warning, which disabled the subagent status-bar segment. Rewritten to
  hook-level dedup that appends missing hooks to the existing entry; existing hooks
  are preserved verbatim.

### Unchanged

- `bin/statusline.js` is shape-agnostic — it reads only `session_id`, `model.id`,
  `model.display_name`, and `cwd` off stdin, fields that both `statusLine` and
  `subagentStatusLine` payload shapes provide. No script change required.

## [2.0.19] - 2026-04-16

### Theme: "Context status bar + six-angle context-saving bundle"

Two pillars shipped together. Pillar 1 surfaces live context consumption in the Claude Code
status line so operators can see subagent model tiers and token fill at a glance. Pillar 2
applies six coordinated context-saving techniques to agent prompts, netting an estimated ~7k–15k fewer
tokens per medium-complexity orchestration.

### Added

- **Context status bar** (`statusLine` integration) — live display of session context fill %,
  active subagent models + effort tier, and per-subagent token count in the Claude Code status
  line. Driven by `bin/collect-context-telemetry.js` on `PreToolUse` / `SubagentStart` /
  `SubagentStop` / `PostToolUse` hooks; rendered by `bin/statusline.js` (< 50 ms budget).
  New config block `context_statusbar` (toggle via `context_statusbar.enabled`, default `true`).
  See `.orchestray/kb/artifacts/2019-design-telemetry-statusbar.md` for design rationale.
  Diagnostic: run `echo '{}' | node bin/statusline.js --dump-stdin` to verify the
  statusLine stdin payload shape reaching the hook (useful when the status line
  renders blank or stale).
- **Shared `bin/_lib/` telemetry helpers** — `transcript-usage.js` (JSONL parsing),
  `path-containment.js` (safe path checks), `context-telemetry-cache.js` (concurrent-safe
  subagent state cache), `models.js` (model lookup + context-window resolution).
- **62 new telemetry tests** under `tests/telemetry/` covering all five modules (transcript
  parsing, model resolution, cache transitions, statusline render, collector subcommands).
  Test total: 1,478 → 1,540 (+62 tests). Ship-time tally: 1,540/1,540 after VF1 cleared the W5-inherited Block A hash failure.

### Changed

- **Six context-saving techniques** applied to agent prompts (an estimated ~7k–15k tokens saved per
  medium-complexity orchestration). See `.orchestray/kb/artifacts/2019-design-context-saving.md`:
  1. **Handoff shrinkage** — diff cap 500 → 300 lines (file-grouped), trace cap 1,000 → 600
     words, budget prelude (≤ 400 tokens) added before Context Handoff Template
     (`agents/pm-reference/delegation-templates.md`).
  2. **PM prompt slimming** — `agents/pm.md` −50 lines net; Sections 20 + 21 bodies and
     Steps 2 + 4 bodies collapsed to pointers into `tier1-orchestration.md`; three files
     moved from Always-Available to Tier-2 conditional dispatch.
  3. **Subagent output discipline** — new "Response Length Discipline" section in
     `agents/pm-reference/agent-common-protocol.md` caps agent response verbosity.
  4. **Read/Grep hygiene** — exploration-hygiene bullet added to all 9 per-agent delegation
     checklists and the boilerplate template in `delegation-templates.md`.
  5. **Prompt-cache preservation** — `agents/pm-reference/prompt-caching-protocol.md` §3
     rewritten as sentinel-based Block A boundary rule; §7.4 added as a hash-based
     pre-commit assertion.
  6. **Context telemetry integration** — effort tier surfaced on `Agent()` calls so the
     status bar can display it with no extra round-trips.
- **Block A boundary relocated.** `<!-- ORCHESTRAY_BLOCK_A_END -->` sentinel moved from
  line 1071 → line 909 in `agents/pm.md` (immediately before `## 15. Cost Tracking and
  Display`). Block A now covers Sections 0–14 (stable Tier-0 core). **One-time cache-prefix
  re-upload on first session after upgrade** (~15k tokens; amortised over weeks of use).
  Pinned hash `tests/.block-a-hash-expected` updated to `eabb8286b63251af`.
- **Section 15 ordering in `agents/pm-reference/tier1-orchestration.md`** — steps
  reordered to chronological 1 → 2 → 3 → 4 (Step 3 previously appeared after Step 4).

### Fixed

- **`bin/_lib/context-telemetry-cache.js`** — removed unlocked `last_error` recording path
  that could silently clobber a concurrent writer's successful cache write under rapid
  SubagentStart / SubagentStop interleaving (VF1).
- **`bin/collect-context-telemetry.js`** — hardened staging-key fallback for pre-spawn
  events without `tool_use_id` to include `pid` plus a monotonic counter, eliminating
  same-millisecond collisions that previously caused nondeterministic merge picks (VF2).
- **`bin/statusline.js`** — added an explicit `[statusline] stdin exceeded limit` stderr
  warning before the fail-open exit on stdin overrun, replacing the previous silent
  empty-line fallback while preserving fail-open exit-code semantics (VF2).

### Removed

- **Step 1.5 in `agents/pm-reference/tier1-orchestration.md`** — prescribed a *PM-emitted* `agent_start` event (on top of the existing `SubagentStart` hook emission). No downstream consumer reads the PM-emitted copy, so Step 1.5 was deleted. The hook-emitted `agent_start` event (from `bin/audit-event.js` via `SubagentStart`) is unchanged and still consumed by analytics and `history_query_events.js`.

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
  Respects `cancel_grace_seconds` config; exits 0 (allow) / 2 (block — cancel or pause; PM distinguishes by reading the sentinel file).
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

- **All 10 core agents**: `maxTurns` raised by +30 uniformly to prevent mid-task exhaustion
  on large W-items (observed root cause of W7 failure during v2.0.18 orchestration).
  Post-bump ceilings: 105 (architect, reviewer, documenter, security-engineer),
  115 (debugger, tester), 125 (developer, refactorer, inventor), 175 (pm).
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
  `.planning/phases/*/ACTUAL.md` is now added as a negation (`!.planning/phases/*/ACTUAL.md`)
  in `.gitignore` so retrospectives are version-tracked while `DESIGN.md` and `VECTORS.md`
  remain ignored.

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
