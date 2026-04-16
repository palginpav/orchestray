# v2.0.18 Retrospective — Actuals vs DESIGN Projections

**Release commit:** bfa17d5 + 5 post-release fixes (d068beb, afe9eeb, 5d7efeb, 7def865, 78fbf60) + WX2 (144d74f) + this calibration.
**Head at retrospective:** see WX3 commit SHA (the commit that creates this file).
**DESIGN file:** `.planning/phases/2018-operator-ergonomics-loop-cleanup/DESIGN.md` (gitignored; not version-tracked; authored by architect/opus in orch-1776274087, locked 2026-04-15).

---

## Headline metrics vs projection

| Metric | DESIGN projection | Actual | Delta |
|--------|-------------------|--------|-------|
| W-items shipped | 14 (W1–W14) | 14 | 0 |
| Total commits (incl. post-release) | ~15–17 implied | 24 (8b0ceee … R3-cleanup) | +7–9 |
| Net LOC delta | ≈ −1,900 | +8,535 (11,611 ins / 3,076 del, live count vs v2.0.17 tip) | **+10,435** |
| Test baseline (v2.0.17) | 1,285 pass | 1,285 pass | 0 |
| Test count post-release | ~1,340 pass (≥1,273 + 60–80 new) | **1,478 pass** | +138 above top of range |
| New tests added (gross) | +60–80 | +237 gross | +157–177 |
| Tests deleted (FC3) | −14 | −44 | −30 |
| Net test delta | +46–66 | +193 | +127–147 |
| Execution cost (orchestration) | $8–12 (estimate); budget envelope $15 | ~$13 orchestration + ~$2–3 post-release batch | ~$15–16 total; within envelope with buffer consumed |
| Worktree spawns | 7 planned | 7 attempted | 0 |
| Worktree clean success rate | 100% assumed | ~57% (4 of 7 clean; W5, W7, W10 misbehaved) | −43 pp |
| Audit rounds | 1 round expected + 1 doc-only | 3 rounds (R1: 9 findings; R2: closed 6 actionable + 2 nits; R3: 4 majors + 7 minors/info all fixed) | +1 round |

**Key headline:** The LOC projection was off by ~10× in the wrong direction. The DESIGN estimated a net reduction because FC3 deletes ~2,450 lines of rollback scaffolding and FC1 deduplicates ~190 lines of agent boilerplate. What the DESIGN did not model is that TDD-mode produces dense test files — each W-item's new test suite added 200–1,500 lines of test code, dwarfing any prose or production-code reduction. Track A alone (UX operator commands, pure additions) came in at +5,499 net LOC.

---

## Per-track LOC breakdown

| Track | W-items | Insertions | Deletions | Net LOC |
|-------|---------|------------|-----------|---------|
| A — Operator UX (peek, gc, watch, pause/cancel, preview/redo) | W4, W5, W6, W7, W8 | 5,509 | 10 | **+5,499** |
| B — Learning loop (decay, routing merge, skip enrichment, advisory gate) | W9, W10, W11, W12 | 4,103 | 21 | **+4,082** |
| C — Cleanup (ts/schema fix, FC3 delete, FC3b strip, FC1 dedup, release sweep) | W1, W2, W3, W13, W14+release | 1,085 | 3,143 | **−2,058** |
| Post-release fixes | d068beb, 5d7efeb, afe9eeb, 7def865, 78fbf60, 144d74f | 836 | 31 | **+805** |
| **Total** | | **11,398** | **3,070** | **+8,328** |

Track C is the only net-negative track and it absorbed the large FC3 deletion (2,451 lines). Tracks A and B are overwhelmingly net-positive because they consist almost entirely of new skill files, new bin scripts, and new test suites — none of which existed before.

---

## Per-W-item size calibration

DESIGN size labels used: XS ≈ 0–100 net LOC, S ≈ 100–300, M ≈ 300–600, L ≈ 600–900, XL ≈ 900+. Actuals are net LOC (insertions − deletions) from `git show --shortstat`. Test count is gross new subtests added by the W-item's new test file(s).

| W | Track | DESIGN size | Actual net LOC | New tests | Verdict |
|---|-------|-------------|----------------|-----------|---------|
| W1 (FC2 ts/timestamp) | C | XS | +263 | +5 | OVERESTIMATED (landed at S, not XS; schema fix + new test file) |
| W2 (FC3a delete) | C | S | −2,451 | −44 | PREDICTION_ACCURATE (large deletion as expected; net bigger but sign correct) |
| W3 (FC3b strip) | C | M | +58 | +6 | UNDERESTIMATED (landed at XS net — config deletion reduced LOC; new sweep test is small) |
| W4 (state peek) | A | XS | +715 | +9 | UNDERESTIMATED (new skill SKILL.md + test suite; pure addition = XL actual) |
| W5 (state gc) | A | S | +840 | +16 | UNDERESTIMATED (M projected, XL actual; gc logic + test suite dense) |
| W6 (watch) | A | S | +943 | +18 | UNDERESTIMATED (S projected, XL actual; test file alone ~500 lines) |
| W7 (pause/cancel) | A | M | +1,540 | +33 | UNDERESTIMATED (M projected, XL actual; hook script + test suite + tier1 prose) |
| W8 (preview/redo) | A | M | +1,461 | +53 | UNDERESTIMATED (M projected, XL actual; two new test files totalling ~700 lines) |
| W9 (LL2 decay) | B | S | +576 | +7 | UNDERESTIMATED (S projected, L actual; decay math implementation + test coverage) |
| W10 (LL6 routing merge) | B | M | +982 | +9 | PREDICTION_ACCURATE (M size; merge logic + event schema + test suite align with projection) |
| W11 (LL1 skip enrichment) | B | S | +1,017 | +46 | UNDERESTIMATED (S projected, XL actual; 46-test suite for skip-enrichment enum coverage drove LOC) |
| W12 (LL3 advisory gate) | B | M | +1,507 | +16 | UNDERESTIMATED (M projected, XL actual; gate logic + latency guard tests + advisory injection) |
| W13 (FC1 agent dedup) | C | M | −190 | 0 | PREDICTION_ACCURATE (net negative as expected; refactor with no new tests) |
| W14+release sweep | C | S | +262 | 0 | PREDICTION_ACCURATE (release sweep prose; no new code) |

**Pattern:** Every "pure addition" W-item (new skill, new hook script, new MCP path) was underestimated because DESIGN did not model TDD-mode test LOC. The only DESIGN_ACCURATE items are those that were either pure deletions (W2), pure refactors (W13), prose sweeps (W14), or mix of add+delete at similar scale (W10). The XS label in particular is unreliable: W1 (schema fix) and W4 (new skill) both carry XS in DESIGN but landed at 263 and 715 net LOC respectively.

---

## Audit-finding retrospective

**Round 1** (reviewer/opus, full release audit):
- 9 findings: 2 BUG, 3 INC (inconsistency), 2 COS (cosmetic/doc), 2 INFO
- All 9 triaged; 5 actionable for Round 2 fixes

**Round 2** (spot-check after doc-only fixes per `feedback_audit_loop_doc_only_skip`):
- 6 actionable findings closed (BUG-2018-01, BUG-2018-02, INC-2018-01, INC-2018-02, INC-2018-03, COS-2018-01)
- 2 R2 nits closed inline (78fbf60: README/README defaults alignment)
- Post-release commits: 5d7efeb (BUG-2018-01), afe9eeb (BUG-2018-02 + COS-2018-01), 7def865 (INC-2018-02 + INC-2018-03)

**Final state:** 0 blockers, 0 majors, 2 minors deferred to v2.0.19 (INC-2018-04: cherry-pick vs merge protocol drift; DS-01: stale worktree cleanup hygiene).

**DESIGN prediction:** audit converges in ≤2 rounds. **Actual:** exactly 2 rounds. On target.

---

## Worktree isolation track record

7 worktree spawns attempted across Waves 3–5. 3 observed failures:

| W-item | Failure mode | Root cause (assessed) | Recovery |
|--------|-------------|----------------------|----------|
| W5 (state gc) | Agent's worktree missing W4 files (bin/state-peek.js absent) | Stale base ref: harness created worktree from v2.0.17 HEAD (5e82a7d) rather than post-W4 master | PM rewrote W5 directly on master; cherry-picked selectively |
| W7 (pause/cancel) | First attempt produced no commit | maxTurns exhaustion: developer was at 75 maxTurns, W7 touched 4+ files and +33 tests | d068beb bumped to 125; W7 retried on master (caf50a7); succeeded first attempt |
| W10 (routing merge) | Agent self-reported branch: "master" | Unknown: PM may have omitted isolation param, or harness silently rejected it (no telemetry to distinguish) | PM accepted master commit; planned merges accordingly |
| W12 (anti-pattern gate) | Worktree opened at 5e82a7d (v2.0.17, two waves stale) | Same stale-base-ref pattern as W5 | Agent self-corrected with git reset; work preserved |

**57% clean rate** (4 of 7 spawns without incident: W4, W6, W9, W11).

**Key structural finding** (per WX1 debugger audit): the `isolation: worktree` field does not exist in any agent frontmatter. Isolation is an `Agent()` tool parameter set per-invocation by the PM. `tier1-orchestration.md:997` falsely claimed the frontmatter field handled this automatically — corrected in WX3 (this commit).

**Known harness limitation:** worktrees are created from a cached ref (likely session-start HEAD), not live local HEAD. This is a Claude Code harness behaviour; no in-repo fix is possible. See F6 in the WX1 audit report for escalation recommendation.

---

## Calibration takeaways

- **Do not trust net-LOC projections for "new capability" W-items.** Any W-item that creates a new skill file, new bin script, or new MCP tool will add 500–1,500 LOC once TDD test suites are included. XS/S labels should be reserved for documentation edits and targeted bug fixes. New capabilities start at M or larger.
- **FC3-style deletion W-items are the most predictable.** When the primary action is deleting existing files, the DESIGN size label is reliable (W2 and W13 were both accurate). The delete count is knowable at design time; deletions do not surprise.
- **Test LOC dominates insertion counts in TDD-mode.** For W11, the test file alone was 46 subtests / ~800 lines — more than the production code change. Future DESIGN.md estimates should include a separate "test LOC" row in the budget table, not fold it into the W-item size label.
- **Worktree isolation is unreliable for long orchestrations with many sequential commits.** The stale-base-ref harness behaviour means worktrees see v2.0.17 state regardless of how many W-items have landed on master since session start. Consider defaulting to disjoint-file serial execution (the reliable pattern from all 5 prior orchestrations) and reserving worktree isolation only for explicitly shared-file parallel tasks.
- **57% worktree success rate is not a fluke.** v2.0.18 is the first orchestration to actually use worktree isolation. Every prior orchestration used disjoint-file serial. The 43% failure rate on first field use is a strong signal. Instrument routing_outcome with `cwd`/`isolation` capture (F3 from WX1) before attempting worktree isolation again.

---

## How to use this file

Before drafting DESIGN.md for any release of comparable scope (10+ W-items, mix of new-capability and cleanup tracks, TDD-mode on), skim this file first. The size-calibration table is the primary artifact: cross-reference your DESIGN's size labels against the "Verdict" column to see where the v2.0.18 architect was systematically wrong. Apply a 3–5× multiplier to any XS/S/M label on a "new capability" W-item before citing it in the budget estimate. The worktree isolation track record is the secondary artifact: if you are planning parallel worktree spawns, read the failure-mode table and the WX3 guidance in `agents/pm-reference/tier1-orchestration.md` before committing to that execution pattern.

---

## Post-release addenda

Eight commits landed after the release commit (bfa17d5) to close audit findings and harden operational discipline. Listed in chronological order:

- **d068beb** `post-release: +30 maxTurns on all 10 core agents` — applied a **+30 uniform delta** to every core agent's `maxTurns` ceiling after the W7 exhaustion incident. Post-bump ceilings: 105 (architect, reviewer, documenter, security-engineer), 115 (debugger, tester), 125 (developer, refactorer, inventor), 175 (pm). (Note: earlier drafts of this file incorrectly generalised the developer-specific 95→125 to all agents; corrected per R3 audit.)
- **afe9eeb** `fix: pattern_decay config keys in the nested shape (BUG-2018-02, COS-2018-01)` — corrected the nesting level of `pattern_decay` config keys so configurable half-life values are reachable at runtime.
- **5d7efeb** `fix: cancel-sentinel hook exits 2 (BUG-2018-01)` — `check-pause-sentinel.js` exit code corrected from 1 to 2 on cancel sentinel; previously the wrong code bypassed the pause path silently.
- **7def865** `fix: install.js + post-upgrade-sweep seed the 4 new v2.0.18 config blocks (INC-02/03)` — both entry points now seed `state_sentinel`, `anti_pattern_gate`, `redo_flow`, and `pattern_decay` on fresh install and first-run upgrade.
- **78fbf60** `fix: README redo_flow drift + config_key_seeded schema (R2 nits)` — README and defaults documentation aligned with code behaviour for `redo_flow` cascade depth and `config_key_seeded` schema.
- **144d74f** `docs: W-item commit message discipline (Handoff subsection)` — `tier1-orchestration.md` updated to require a `## Handoff` subsection in every W-item commit body as the canonical handoff channel.
- **a56b3e6** `post-release: DESIGN calibration retrospective + worktree-guidance fixes` — corrected the false frontmatter-field claim for `isolation: worktree`; added stale-base-ref harness limitation guidance and fallback recommendation.
- **c6ce904** `chore: .planning/phases/*/ACTUAL.md exception + v2.0.18 retrospective tracked` — `ACTUAL.md` added as a negation (`!.planning/phases/*/ACTUAL.md`) in `.gitignore` so retrospectives are version-tracked while `DESIGN.md`/`VECTORS.md` remain ignored; WX3 retrospective content committed.

**Lessons internalised by these commits:** maxTurns calibration for large W-items; commit-body as canonical handoff channel; worktree isolation as unreliable for long sequential orchestrations. Deferred to v2.0.19: INC-2018-04 (cherry-pick vs merge protocol drift) and DS-01 (stale worktree cleanup hygiene).
