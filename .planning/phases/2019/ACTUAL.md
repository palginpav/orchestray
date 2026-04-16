# v2.0.19 Retrospective — Actuals

**Release date:** 2026-04-16
**Orchestration ID:** orch-1776334271-v2019-context (`.orchestray/history/`)
**DESIGN files:** `.orchestray/kb/artifacts/2019-design-telemetry-statusbar.md` (W1),
                  `.orchestray/kb/artifacts/2019-design-context-saving.md` (W2)

---

## Plan Summary

Two pillars, 7 W-items + 2 VF/fix rounds:

| Pillar | Description |
|--------|-------------|
| **Pillar 1 — Context status bar** | Live Claude Code `statusLine` showing context fill %, subagent model/effort, per-agent token count. New bin scripts, new `_lib/` helpers, 62 new tests. |
| **Pillar 2 — Context-saving bundle** | Six prompt-engineering angles applied across pm.md, delegation-templates.md, agent-common-protocol.md, prompt-caching-protocol.md, tier1-orchestration.md. Target: ~7k–15k tokens/orchestration. |

| W-item | Agent | Description |
|--------|-------|-------------|
| W1 | architect | Design doc: statusbar telemetry architecture |
| W2 | architect | Design doc: six context-saving angles |
| W3 | developer | Implement statusbar (`bin/collect-context-telemetry.js`, `bin/statusline.js`, `bin/_lib/`) |
| W4 | developer | Apply six context-saving edits to agent prompts |
| W5 | tester | 62 telemetry tests under `tests/telemetry/` |
| W6 | reviewer | Full release audit (W3–W5 output) |
| W7 | documenter | CHANGELOG + README + ACTUAL.md |
| VF1 | developer | Verify-fix round 1: sentinel move, hash re-pin, Step 1.5 deletion, cache bug fix, tier1 reorder |
| VF2 | developer | Verify-fix round 2: `bin/` polish (Date.now fallback, statusline stderr warning) |

---

## Actual Outcome

| W-item | Status | Notes |
|--------|--------|-------|
| W1 | Shipped | Design doc at `.orchestray/kb/artifacts/2019-design-telemetry-statusbar.md` |
| W2 | Shipped | Design doc at `.orchestray/kb/artifacts/2019-design-context-saving.md`; Block A premise later found inaccurate (see Deviations) |
| W3 | Shipped | `bin/collect-context-telemetry.js`, `bin/statusline.js`, `bin/_lib/{transcript-usage,path-containment,context-telemetry-cache,models}.js` |
| W4 | Shipped | All 17 edits from W2 §G audit table applied; `agents/pm.md` −50 lines net; zero Block A hash change during W4 |
| W5 | Shipped | 62 tests, 5 test files; final tally pre-VF1: 1,539 pass / 1 pre-existing fail (Block A hash) |
| W6 | Shipped | 9 findings; 4 VF1-blocking, 2 deferred to VF2, 3 deferred to v2.0.20 |
| VF1 | Shipped | All 9 fixes applied; Block A hash re-pinned to `eabb8286b63251af`; tally: 1,540 pass / 0 fail |
| W7 | Shipped | This file; CHANGELOG, README, ACTUAL.md delivered |
| VF2 | Running in parallel | 2 `bin/` polish edits; not blocking W7 |

**Test tally at ship time:** 1,540 pass, 0 fail (from VF1 summary).

---

## Deviations

### Block A boundary contradiction (W2 premise vs. enforcement reality)

W2's design assumed Block A ended near line 1,800 and that all planned pm.md edits would
land safely below it. The enforcement reality (discovered by W6's audit) was:

- The sentinel `<!-- ORCHESTRAY_BLOCK_A_END -->` was at **line 1071** in pm.md, not ~1,800.
- W4's edits targeted lines 919–1,115 — several landed **inside** Block A.
- The Block A hash stability test therefore failed after W4 landed (the "pre-existing fail"
  in W5's tally was this test).

**VF1 remediation:**
1. Sentinel moved from line 1071 → **line 909** (before `## 15. Cost Tracking and Display`)
   so that Sections 0–14 are cleanly inside Block A and cost-tracking sections are outside.
2. Hash re-pinned to `eabb8286b63251af`.
3. Operators will see a one-time cache-prefix re-upload (~15k tokens) on first session after upgrade.

**Root cause:** W2 architect read the sentinel position from memory rather than verifying
it in the live file. The design document cited a line number that was ~750 lines off.
This is a design-vs-enforcement-drift failure: the architect's Block A mental model had
not been updated since a prior sentinel relocation.

### Step 1.5 (agent_start event) removed before shipping

W4 inserted Step 1.5 into tier1-orchestration.md prescribing a PM-emitted `agent_start`
event for the statusbar. W6 found no downstream consumer reads this event. VF1 deleted
Step 1.5 entirely rather than building a consumer — the statusbar gets subagent lifecycle
data from existing `SubagentStart`/`SubagentStop` hooks.

---

## Cost

Cost data not extractable from `events.jsonl` (rows use event-type fields without
`total_cost_usd`; per-spawn cost lives in `agent_metrics.jsonl` which is not aggregated
here). Estimated from agent count and model tiers:

| Phase | Agents | Model | Estimated cost |
|-------|--------|-------|---------------|
| W1–W2 (design) | 2 × architect/opus | Opus | ~$2–3 |
| W3–W4 (implementation) | 2 × developer/sonnet | Sonnet | ~$3–4 |
| W5 (tests) | 1 × tester/sonnet | Sonnet | ~$1–2 |
| W6 (review) | 1 × reviewer/opus | Opus | ~$2–3 |
| VF1 (fix) | 1 × developer/sonnet | Sonnet | ~$1 |
| W7 (docs) | 1 × documenter/sonnet | Sonnet | ~$0.5 |
| **Total estimated** | | | **~$10–14** |

---

## Tests

| Milestone | Pass | Fail |
|-----------|------|------|
| Pre-W5 baseline | 1,478 | 0 |
| Post-W5 (pre-VF1) | 1,539 | 1 (Block A hash — pre-existing after W4) |
| Post-VF1 (ship) | **1,540** | **0** |

New tests: +62 (`tests/telemetry/*.test.js`). Net gain from baseline: +62.

---

## Lessons Learned

1. **Design-vs-enforcement drift on Block A.** The W2 architect cited a Block A line number
   from memory that was 750 lines off from the live file. Any design that references a
   specific line number in a file that changes between orchestrations must re-read the file
   at design time, not rely on a prior mental model. A simple `grep -n ORCHESTRAY_BLOCK_A_END`
   before drafting the design doc would have prevented the VF1 round entirely.

2. **The verify-fix loop worked as designed.** W6 caught the Block A contradiction, the
   cache bug, the Step 1.5 dead event, and the tier1 ordering inversion in a single reviewer
   pass. VF1 cleared all four blockers cleanly with zero regressions. The adversarial audit
   protocol — reviewer/opus before release — is earning its cost.

3. **Context-saving work reduced tokens in the orchestration that built it.** The six-angle
   bundle applied to pm.md, delegation-templates.md, and tier1-orchestration.md produced
   measurable agent-output shrinkage in W3–W7 themselves (shorter handoffs, tighter traces,
   output-discipline compliance). The context-saving work is self-referential: the agents
   that built it were subject to the same prompt changes they were writing, and the outputs
   were noticeably more compact than prior orchestrations of comparable scope.

4. **Test LOC for new bin scripts is non-trivial.** W5 added 62 tests across 5 files to
   cover `bin/` and `bin/_lib/` code that W3 shipped. As with v2.0.18's Track A items, the
   test suite is often larger than the production code it covers. Future size estimates for
   "new bin script" W-items should budget 2–3× production LOC for test coverage.

5. **VF2 ran in parallel with W7's documenter, but required a post-hoc CHANGELOG amend because W7 finished before VF2 published its summary. For this pattern to ship cleanly without amends, W7 must wait for VF2's summary artifact before writing the CHANGELOG, OR the PM must reliably re-trigger the documenter after parallel fix-waves land.**

---

## v2.0.20 hotfix

**Release date:** 2026-04-16
**Trigger:** user-facing report — status bar never rendered after `npx orchestray --global`.
**Design doc:** `.orchestray/kb/artifacts/2019_1-bugfix-statusline-design.md`

**Root cause:** v2.0.19 wired `bin/statusline.js` via the plugin `settings.json`'s
`statusLine` key. Claude Code plugin `settings.json` honors only `agent` and
`subagentStatusLine` — the `statusLine` block was silently discarded. The session-scope
`statusLine` must live in user-scope `~/.claude/settings.json`, not the plugin bundle.

**Why 2.0.20 and not 2.0.19.1:** `2.0.19.1` is not valid semver and `npm publish` would
reject it. Per the design doc's Ambiguity #2, PM resolved to a standard patch bump
(2.0.20) so `npm install orchestray@latest` actually fetches the fix; the CHANGELOG
title captures the "v2.0.19 statusLine hotfix" narrative explicitly.

**Fixes shipped:**

| Fix | File(s) | Change |
|-----|---------|--------|
| A | `settings.json` | `statusLine` block → `subagentStatusLine` block |
| B | `README.md` | New "Post-install: enable context status bar" subsection |
| C | `bin/reset-context-telemetry.js` | SessionStart advisory when user-scope `statusLine` missing |
| Side | `.claude-plugin/plugin.json` | `2.0.17` → `2.0.20` (corrects v2.0.18-era drift) |

**Calibration note:** `bin/statusline.js` required zero code change. Both `statusLine`
and `subagentStatusLine` payload shapes provide the four fields it actually reads
(`session_id`, `model.id`, `model.display_name`, `cwd`). Future releases should
explicitly list the stdin fields consumed in any new hook/render contract so "which
payload shape does this work with?" is answerable without re-reading the source.

**Process note:** the v2.0.19 pre-ship audit loop did not include a manual smoke test
of "fresh install renders status bar." Adding a "plugin settings.json key coverage"
check to future release audits (grep `settings.json` for any key outside the
Claude Code plugin-scope allowlist) would have caught this.

**Tests:** new `tests/regression/v2019_1-statusline-wiring.test.js` pins the
`subagentStatusLine` shape and asserts version parity across `package.json` and
`.claude-plugin/plugin.json`.

**Mid-stream addition — installer `mergeHooks()` dedup fix.** After the statusLine
wiring landed, review of the upgrade path for v2.0.18 users uncovered a second bug
in the same release surface: `bin/install.js` line-541 used entry-level dedup —
for each new (event, matcher) entry from the source `hooks.json`, if ANY of that
entry's hook basenames was already present at the target the ENTIRE new entry was
skipped, silently losing any NEW hooks it also contained. The concrete casualty was
v2.0.19's `collect-context-telemetry.js`, which was added as a second hook inside
pre-existing entries under SubagentStart, SubagentStop, `PreToolUse(Agent|Explore|Task)`,
and `PostToolUse(Agent|Explore|Task)`. Every v2.0.18-or-earlier user who ran
`/orchestray:update` to v2.0.19 lost all four telemetry hooks without warning,
which disabled the subagent status-bar segment even after fix A reshaped the
settings.json block correctly. Rewritten to hook-level dedup: compute the set of
Orchestray-origin basenames already at `(event, matcher)`, filter the incoming
entry's hooks to those not yet present, and append survivors to the matching
existing entry (or push a new entry if no matcher match exists). Pinned by
`tests/regression/v2020-installer-hook-dedup.test.js` — five scenarios including
the silent-drop repro, partial dedup, full idempotency, different-matcher
distinctness, and non-Orchestray peer hook coexistence. Still v2.0.20 — no second
version bump.
