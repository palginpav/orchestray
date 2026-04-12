# 2.0.14 — Close the §22c False-Positive Path

> **Source inputs:** T1 baseline research
> (`.orchestray/kb/artifacts/2014-baseline-research.md`), T2 invention concepts
> (`.orchestray/kb/artifacts/2014-invention-concepts.md`), T3 MCP surface design
> (`.orchestray/kb/artifacts/2014-mcp-surface-design.md`), T5-r1 adversarial review
> (`.orchestray/kb/artifacts/2014-scope-review.md`), scope proposal r2
> (`.orchestray/kb/artifacts/2014-scope-proposal.md`). 2.0.13's structural template is
> `.planning/phases/2013-mcp-learning-loop-live/DESIGN.md`; this document follows its
> section order.

---

## §22c transition status

```
transition_status: "no-go-data"
```

**Rationale:** T1's pre-2.0.14 data snapshot showed N=3 non-skipped `pattern_find`
rows across one orchestration — well below the N≥20 prerequisite for a statistically
meaningful false-positive analysis. The Branch 1 verdict (NO-GO on default flip) in T3
Part A is a direct consequence. 2.0.14 closes the signal gap so the post-2.0.14 audit
window can accumulate the data 2.0.15 needs.

The §22c evaluation in 2.0.15 will:
1. Query `history_query_events` filtered to `tool: "pattern_record_skip_reason"` and
   `tool: "pattern_record_application"` over the post-2.0.14 window.
2. Compute the skip-vs-apply ratio (false-positive rate of the advisory).
3. Compare against a threshold to be set in 2.0.15's DESIGN.md before scoping.
4. If FP rate < threshold AND N≥20: ship the advisory→blocking transition.
5. If FP rate ≥ threshold OR N<20: defer again with rationale.

---

## Theme

**"Close the §22c false-positive path and trim context tax at two untouched seams."**

One line: _close the §22c false-positive path, add pre-spawn cost projection, and cut
Read cache-replay waste._

---

## Goals

1. **G1 — Close the legitimate-skip signal gap (W1 + W2).** Ship the
   `pattern_record_skip_reason` MCP tool and the §22b MUST directive so every
   `pattern_find` outcome produces an auditable row — either an application record or
   a structured skip reason. This is the prerequisite that makes the 2.0.15 §22c
   Go/No-Go analysis possible at all.

2. **G2 — Add pre-spawn cost projection (W3).** Ship `cost_budget_check` as an
   advisory MCP tool. Centralize the pricing table in config so two pricing sources
   cannot drift apart. Backfill the pricing block for existing installs via
   `bin/post-upgrade-sweep.js`.

3. **G3 — Eliminate Read cache-replay token waste (W4).** Ship `bin/context-shield.js`
   with R14 as net-new `PreToolUse:Read` infrastructure. Deny re-reads of unchanged
   files within a session; allow re-sliced reads and reads after on-disk changes.

4. **G4 — Release documentation sweep (W5).** DESIGN.md, CHANGELOG, README, and
   version bumps all in the same release commit — no docs-as-follow-up drift.

---

## Non-goals

- **NG1 — §22c default flip in this release.** Hard prerequisite not met: N=3 rows <
  N≥20 threshold. See `transition_status: "no-go-data"` above.

- **NG2 — `mcp_enforcement.pattern_record_application: "hook-strict"` enum value.**
  Deferred to 2.0.15 per T3 Part D forward contract. The enum is not introduced in
  2.0.14; the MCP enforcement mode for `pattern_record_application` remains advisory.

- **NG3 — Hook gate on `PreToolUse:Agent` enforcing `cost_budget_check` results.**
  W3 ships advisory only. Hard enforcement would require a new hook and a user-facing
  "spawn blocked" UX that is not scoped for 2.0.14. Deferred to 2.0.15.

- **NG4 — R1–R13 shield rules.** T2 asserted these shipped in v2.0.11; T5-r1 confirmed
  they do not exist in the 2.0.13 codebase. 2.0.14 ships R14 as the first and only
  rule in the new scaffold. Backfilling R1–R13 is a 2.0.15+ question and is not scoped
  here.

- **NG5 — Dedup across Grep or Bash tool calls.** R14 is Read-only. Extending to other
  tools is a 2.0.15 follow-up.

- **NG6 — Subagent-callable `cost_budget_check` variant.** Deferred to 2.0.15 per
  T3 OQ1: the parent-orchestration-id routing question is not resolved in 2.0.14.

---

## Work items shipped

### W1: `pattern_record_skip_reason` MCP tool

New handler: `bin/mcp-server/tools/pattern_record_skip_reason.js`.
Registered in `bin/mcp-server/server.js` TOOL_TABLE and `bin/mcp-server/lib/schemas.js`.
Four-value `reason` enum: `all-irrelevant | all-low-confidence | all-stale | other`.
`other` requires a mandatory `note` field.
`bin/record-pattern-skip.js` enriched to suppress the advisory when a skip-reason call
exists for the same `orchestration_id`.
Seeded `enabled: true` in the `mcp_server.tools` map via `bin/install.js`.
Tests: `tests/mcp-server/tools/pattern_record_skip_reason.test.js`.

### W2: §22b probe-side prompt hardening

`agents/pm-reference/tier1-orchestration.md` §22b rewritten with MUST directive.
Fallback marker path (`pattern_record_skipped_reason: <reason>` in
`.orchestray/state/orchestration.md`) documented and owned solely by W2.
`agents/pm-reference/pattern-extraction.md` cross-reference added.
Golden-file test: `tests/pm-prompt-22b-hardening.test.js`.

### W3: `cost_budget_check` MCP tool + pricing-table config seed

New handler: `bin/mcp-server/tools/cost_budget_check.js`.
Registered after W1's TOOL_TABLE delta (serial dependency — both edit the same
TOOL_TABLE literal; W3 appends on top of W1).
Pricing table seeded at `mcp_server.cost_budget_check.pricing_table` in config.
`bin/collect-agent-metrics.js` now reads from the shared config-resolver.
New sub-operation in `bin/post-upgrade-sweep.js` backfills the table for existing
installs (sentinel: `.orchestray/state/.pricing-table-migrated-2014`).
Schema additions in `bin/_lib/config-schema.js`.
Tests: `tests/mcp-server/tools/cost_budget_check.test.js`,
`tests/post-upgrade-sweep-pricing-seed.test.js`.

### W4: CATRC — Cache-Aware Tool Result Compaction (R14)

Net-new files: `bin/context-shield.js`, `bin/_lib/shield-rules.js`,
`bin/_lib/shield-session-cache.js`.
`hooks/hooks.json`: new `PreToolUse` matcher for the `Read` tool.
`bin/pre-compact-archive.js`: archives session-scoped shield cache at session end.
Config flag `shield.r14_dedup_reads.enabled` (default `true`) seeded by `bin/install.js`.
Schema addition in `bin/_lib/config-schema.js`.
Tests: `tests/context-shield-r14.test.js`.

### W5: Release documentation sweep

`CHANGELOG.md`: 2.0.14 entry added above 2.0.13.
`README.md`: new Key Features bullets for R14, `cost_budget_check`, and the
pattern-record-skip MCP tool; new Configuration entries for the new config keys;
Requirements note updated.
`package.json`: version bumped 2.0.13 → 2.0.14.
`bin/mcp-server/server.js`: SERVER_VERSION bumped 2.0.13 → 2.0.14.
This file: `.planning/phases/2014-mcp-surface-ext/DESIGN.md`.

---

## Alternatives weighed

### A1: Ship §22c default flip in 2.0.14

**Rejected.** N=3 non-skipped rows < N≥20 threshold. Without the W1 skip-signal
tool, the FP analysis has no K denominator to compute FP rate against. Shipping the
default flip on N=3 would be a coin-flip decision with no statistical backing.

### A2: Make `cost_budget_check` hard-blocking via a `PreToolUse:Agent` hook

**Rejected for 2.0.14.** Would surface as "spawn blocked" to the user with no graceful
degradation path. Advisory-only is the correct starting point — gather data on how
often `would_exceed_*` is true before adding a hard gate.

### A3: Extend R14 dedup to Grep and Bash

**Rejected for 2.0.14.** `Read` is the highest-volume repeat tool by T2's measurement
(24.5M characters across 292 transcripts). Grep and Bash are lower volume and their
dedup semantics are more complex (same command, different file state). Ship R14 for
`Read` only and measure impact first.

### A4: Create a parallel `bin/post-upgrade-migrate.js` for W3's pricing backfill

**Rejected.** T5-r1 Fix 1 identified this mistake in the scope proposal r1. The
existing `bin/post-upgrade-sweep.js` is the sole migration entry point; W3's work is
additive to it, following the idempotent-sentinel pattern already established by
2.0.13's W8+W11 sub-operations.

---

## Open questions for 2.0.15

- **OQ1 — §22c threshold.** What false-positive rate ceiling justifies the advisory→
  blocking transition? To be decided in 2.0.15's scoping with actual post-2.0.14 data.

- **OQ2 — `cost_budget_check` hard enforcement.** If the advisory is consistently
  correct (low false-positive rate on `would_exceed_*`), 2.0.15 can add the
  `PreToolUse:Agent` gate. Needs at least N=10 advisory firings with user-visible
  validation before a hard gate is appropriate.

- **OQ3 — R14 impact measurement.** T2 projected 24.5M characters of cache-replay
  waste. Post-2.0.14, compare the `deny` rate in shield-session cache archives against
  the projection to validate R14's real-world impact.

- **OQ4 — R1–R13 backfill.** T2 asserted these existed in v2.0.11. T5-r1 confirmed
  they do not. 2.0.15 should decide whether to backfill them or treat R14 as the
  permanent scope of the shield scaffold.
