# Kill switches

Reference for every Orchestray feature-level kill switch: ~80 entries across 10 categories.
Set in `.orchestray/config.json` or as env vars. **No session restart required for any of them.**

When to use a kill switch:

- **Emergency rollback** — a v2.2.x default flip is causing a regression on your repo; flip the switch back to the prior behavior while you wait for the next patch.
- **Selective opt-out** — a feature is irrelevant to your workflow (e.g., compaction resilience on a single-session-only setup).
- **Triage** — you suspect a hook is the source of a bug; disable it temporarily to confirm.

Within each category, entries are sorted alphabetically by feature name.

## Table of contents

- [1. Orchestration core](#1-orchestration-core)
- [2. Hooks & gates](#2-hooks--gates)
- [3. Reviewer-specific](#3-reviewer-specific)
- [4. Tokenwright & compression](#4-tokenwright--compression)
- [5. Dossier & resilience](#5-dossier--resilience)
- [6. Telemetry & audit](#6-telemetry--audit)
- [7. MCP](#7-mcp)
- [8. Install & upgrade](#8-install--upgrade)
- [9. Lints & static checks](#9-lints--static-checks)
- [10. Worktree, spawning & primitives](#10-worktree-spawning--primitives)

## 1. Orchestration core

| Feature | Config key | Env var |
|---------|-----------|---------|
| Compaction resilience | `resilience.enabled: false` | `ORCHESTRAY_RESILIENCE_DISABLED=1` |
| `orchestration_start` + `orchestration_complete` lifecycle emits (v2.2.13) | — | `ORCHESTRAY_ORCH_LIFECYCLE_EMIT_DISABLED=1` |
| Orchestration auto-trigger | `complexity_threshold: 99` | — |
| Per-orch boundary trigger for governance audits | — | `ORCHESTRAY_ORCH_BOUNDARY_TRIGGER_DISABLED=1` (re-enables Stop fallback) |
| Reactive agent spawning | — | `ORCHESTRAY_DISABLE_REACTIVE_SPAWN=1` |
| Replan budget guard | — | `ORCHESTRAY_REPLAN_BUDGET_GUARD_DISABLED=1` |
| Strict `model:` field required on `Agent()` calls (v2.2.9 default hard-block) | — | `ORCHESTRAY_STRICT_MODEL_REQUIRED=0` (the only opt-out — restores legacy auto-resolve cascade) |

## 2. Hooks & gates

| Feature | Config key | Env var |
|---------|-----------|---------|
| Architect pattern-ack check | — | `ORCHESTRAY_PATTERN_ACK_CHECK_DISABLED=1` |
| Commit handoff validator | — | `ORCHESTRAY_COMMIT_HANDOFF_CHECK_DISABLED=1` |
| Commit-body `## Handoff` warn-then-block ramp (v2.2.15) | — | `ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED=1` (downgrades to warn); `ORCHESTRAY_COMMIT_HANDOFF_RAMP_THRESHOLD=N` (default 3) |
| Context size hint inline prompt-body parser (v2.2.13) | — | `ORCHESTRAY_CONTEXT_SIZE_HINT_INLINE_PARSE_DISABLED=1` |
| Context size hint missing warn (warn event only) | — | `ORCHESTRAY_CONTEXT_SIZE_HINT_WARN_DISABLED=1` |
| Context-size-hint warn-then-block ramp (v2.2.15) | — | `ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED=1` (full bypass); `ORCHESTRAY_CONTEXT_SIZE_HINT_RAMP_THRESHOLD=N` (default 3 spawns/orch before exit 2) |
| Contracts missing-contracts warn | — | `ORCHESTRAY_CONTRACTS_MISSING_WARN_DISABLED=1` |
| Contracts postcondition silent-skip audit emit (v2.2.13) | — | `ORCHESTRAY_CONTRACTS_RUNPOST_AUDIT_DISABLED=1` |
| Contracts task-YAML validator | — | `ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED=1` |
| Contracts validation hard-fail (v2.2.12, reverts to warn) | — | `ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED=1` |
| Developer git-action gate | — | `ORCHESTRAY_GIT_GATE_DISABLED=1` |
| Hook double-fire skip + SessionStart dual-install version-mismatch surfacing (v2.2.15) | — | `ORCHESTRAY_DOUBLE_FIRE_SKIP_GATE_DISABLED=1` |
| KB slug path-traversal hard-block | — | `ORCHESTRAY_KB_SLUG_VALIDATION_DISABLED=1` |
| Pattern-application acknowledgement exit-2 (v2.2.17, was warn in v2.2.15) | — | `ORCHESTRAY_PATTERN_APPLICATION_GATE_DISABLED=1`; soft-warn: `ORCHESTRAY_PATTERN_APPLICATION_RAMP_THRESHOLD=N` |
| Per-role hard-tier handoff schema | — | `ORCHESTRAY_T15_<ROLE>_HARD_DISABLED=1` (per role: `DEVELOPER`, `RESEARCHER`, etc.) |
| Per-role write-path gate | — | `ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1` |
| Schema-get self-call on shadow cache miss | — | `ORCHESTRAY_SCHEMA_GET_SELF_CALL_DISABLED=1` |
| Schema-shadow safety net (event-type validation) | — | `ORCHESTRAY_DISABLE_SCHEMA_SHADOW=1` |
| SessionStart hook-chain drift validator (v2.2.13) | — | `ORCHESTRAY_HOOK_ORDER_VALIDATION_DISABLED=1` |

## 3. Reviewer-specific

| Feature | Config key | Env var |
|---------|-----------|---------|
| Multiple `## Structured Result` blocks (v2.2.15 warn → v2.2.17 exit-2) | — | `ORCHESTRAY_MULTI_STRUCTURED_RESULT_GATE_DISABLED=1` |
| Reviewer dimensions missing warn | — | `ORCHESTRAY_REVIEWER_DIMENSIONS_WARN_DISABLED=1` |
| Reviewer `## Dimensions to Apply` auto-inject on spawn (v2.2.19) | — | `ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1` (downgrades inject+block to warn) |
| Reviewer git-diff section check | — | `ORCHESTRAY_REVIEWER_GIT_DIFF_CHECK_DISABLED=1` |
| Reviewer hard-block on missing `## Dimensions to Apply` (v2.2.15) | — | `ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1` |
| Reviewer hard-block on missing `## Git Diff` (v2.2.15) | — | `ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1` (downgrades to warn-only; legacy `_CHECK_DISABLED` still bypasses entirely) |

## 4. Tokenwright & compression

| Feature | Config key | Env var |
|---------|-----------|---------|
| L1 prompt compression (v2.2.19, default-off) | `tokenwright.l1_compression_enabled: true` | — (re-enable only; compression is off by default in v2.2.19) |
| Prompt compression (Tokenwright) | `compression.enabled: false` | `ORCHESTRAY_DISABLE_COMPRESSION=1` |
| Rolling-median token estimate bootstrapper (v2.2.18) | `tokenwright.bootstrap_enabled: false` | `ORCHESTRAY_TOKENWRIGHT_BOOTSTRAP_DISABLED=1` |

## 5. Dossier & resilience

| Feature | Config key | Env var |
|---------|-----------|---------|
| Dossier-orphan threshold escalator (v2.2.13) | — | `ORCHESTRAY_DOSSIER_ORPHAN_THRESHOLD_DISABLED=1` |
| Dossier orphan compensation at SessionStart (v2.2.18) | `dossier_compensation.enabled: false` | `ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED=1` |

## 6. Telemetry & audit

| Feature | Config key | Env var |
|---------|-----------|---------|
| Archive must-copy checklist validator | — | `ORCHESTRAY_ARCHIVE_VALIDATION_DISABLED=1` |
| Archive validation success-path emit (v2.2.12) | — | `ORCHESTRAY_ARCHIVE_VALIDATION_SUCCESS_EMIT_DISABLED=1` |
| Autofill-threshold fail-loud | — | `ORCHESTRAY_AUTOFILL_THRESHOLD_DISABLED=1` |
| Decision-recorder: agent spawn (v2.2.11) | — | `ORCHESTRAY_DR_AGENT_SPAWN_DISABLED=1` |
| Decision-recorder: ask_user calls (v2.2.11) | — | `ORCHESTRAY_DR_ASK_USER_DISABLED=1` |
| Decision-recorder: curator tombstone (v2.2.11) | — | `ORCHESTRAY_DR_CURATOR_TOMBSTONE_DISABLED=1` |
| Decision-recorder: pattern deprecation (v2.2.11) | — | `ORCHESTRAY_DR_PATTERN_DEPRECATE_DISABLED=1` |
| `*_failed` deprecation stderr warn (v2.2.12) | — | `ORCHESTRAY_DEPRECATED_NAME_WARN_DISABLED=1` |
| `*_failed` rename-cycle alias emit (v2.2.11) | — | `ORCHESTRAY_RENAME_CYCLE_ALIAS_DISABLED=1` |
| Loop-kind taxonomy disambiguation (v2.2.11) | — | `ORCHESTRAY_LOOP_KIND_DISAMBIGUATION_DISABLED=1` |
| Nightly self-firing activation audit | — | `ORCHESTRAY_FIRING_AUDIT_DISABLED=1` |
| Orchestration ROI auto-emit at close (v2.2.12) | — | `ORCHESTRAY_ORCHESTRATION_ROI_AUTO_EMIT_DISABLED=1` |
| Orchestration ROI missing dedup guard | — | `ORCHESTRAY_ROI_WATCHED_DEDUP_DISABLED=1` |
| Orchestration ROI missing warn | — | `ORCHESTRAY_ROI_WATCHED_DISABLED=1` |
| Per-orch activation ratio KPI emit | — | `ORCHESTRAY_ACTIVATION_RATIO_EMIT_DISABLED=1` |
| Sentinel probe per-session dedup | — | `ORCHESTRAY_SENTINEL_DEDUP_DISABLED=1` |
| Tier2 protocol watcher auto-emit | — | `ORCHESTRAY_TIER2_WATCHER_DISABLED=1` |
| Verify-fix watcher auto-emit | — | `ORCHESTRAY_VERIFY_FIX_WATCHER_DISABLED=1` |

## 7. MCP

| Feature | Config key | Env var |
|---------|-----------|---------|
| KB write auto-index update (v2.2.12) | — | `ORCHESTRAY_KB_INDEX_AUTO_DISABLED=1` |
| KB write redirect to MCP (Phase 1 transparent-pass) | — | `ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED=1` |
| MCP enforcement gate | `mcp_enforcement.global_kill_switch: true` | — |
| MCP grounding hard-reject gate | — | `ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED=1` |
| MCP handler-entry instrumentation (v2.2.11) | — | `ORCHESTRAY_MCP_ENTRY_INSTRUMENTATION_DISABLED=1` |
| Orch-complete MCP fanout (metrics/routing/pattern) | — | `ORCHESTRAY_ORCH_COMPLETE_MCP_FANOUT_DISABLED=1` |
| Server-side MCP grounding prefetch | — | `ORCHESTRAY_MCP_PREFETCH_DISABLED=1` |

## 8. Install & upgrade

| Feature | Config key | Env var |
|---------|-----------|---------|
| Cross-install stale hook-path pruning (v2.2.17) | — | `ORCHESTRAY_INSTALL_CROSS_INSTALL_DEDUP_DISABLED=1` |
| Drainer-tombstone self-check probe (v2.2.18) | — | `ORCHESTRAY_TOMBSTONE_PROBE_DISABLED=1` |
| Dual-install divergence auto-heal (v2.2.18) | `dual_install.autoheal_enabled: false` | `ORCHESTRAY_DUAL_INSTALL_AUTOHEAL_DISABLED=1` |
| Install-time hook reorder auto-fix (v2.2.13) | — | `ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED=1` |
| Schema mtime-based cache invalidation (v2.2.18) | — | `ORCHESTRAY_SCHEMA_CACHE_INVALIDATION_DISABLED=1` |

## 9. Lints & static checks

| Feature | Config key | Env var |
|---------|-----------|---------|
| `assert.doesNotThrow` orphan-test lint (v2.2.15 warn → v2.2.17 exit-2) | — | `ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED=1` |
| `EVENT_TYPES`↔schema-declares enum parity (v2.2.15) | — | `ORCHESTRAY_LINT_EVENT_TYPES_ENUM_PARITY_DISABLED=1` |
| MCP server↔pm.md tool-allowlist parity (v2.2.15) | — | `ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED=1` |

## 10. Worktree, spawning & primitives

| Feature | Config key | Env var |
|---------|-----------|---------|
| CHANGELOG↔shadow naming firewall | — | `ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED=1` (non-release commits only — release commits cannot opt out) |
| Haiku scout (file ops) | `haiku_routing.enabled: false` | — |
| Housekeeper auto-spawn | — | `ORCHESTRAY_HOUSEKEEPER_AUTO_SPAWN_DISABLED=1` |
| Loop primitive | — | `ORCHESTRAY_DISABLE_LOOP=1` |
| Master-tree auto-commit on PM Stop (v2.2.18) | `master_auto_commit.enabled: false` | `ORCHESTRAY_MASTER_AUTO_COMMIT_DISABLED=1` |
| Spawn-approved drainer (housekeeper E2E) | — | `ORCHESTRAY_SPAWN_DRAINER_DISABLED=1` |
| Workspace snapshots | — | `ORCHESTRAY_DISABLE_SNAPSHOTS=1` |
| Worktree auto-commit on SubagentStop (v2.2.18) | `worktree_auto_commit.enabled: false` | `ORCHESTRAY_WORKTREE_AUTO_COMMIT_DISABLED=1` |
| Archetype cache cold-cache seeder (v2.2.20) | `context_compression_v218.archetype_cache.seeder_disabled: true` | `ORCHESTRAY_ARCHETYPE_SEEDER_DISABLED=1` |
| Repo-map cross-process sentinel (v2.2.20) | `repo_map.sentinel_enabled: false` | `ORCHESTRAY_REPO_MAP_SENTINEL_DISABLED=1` |
