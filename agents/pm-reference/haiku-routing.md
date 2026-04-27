<!-- PM Reference: Loaded by Section Loading Protocol when Section 23
     decision rule encounters a Class-B candidate. See pm.md §23. -->

# Haiku Routing — Inline-vs-Scout Reference (P2.2, v2.2.0)

This file expands the four-class taxonomy and the worked examples that
back the compact decision rule in `agents/pm.md` §23. It is lazy-loaded
once per session the first time the PM evaluates a Class-B candidate.

---

## Section 23a — Four-Class Taxonomy (Detail)

### Class A — PM-only inline (stays on routed PM model)

Decomposition, complexity scoring, re-planning, audit-verdict synthesis,
delegation-prompt composition, multi-source decision synthesis. These
produce orchestration semantics, not content — routing them to a scout
returns content the PM must re-reason about (2× cost).

**Anti-pattern:** "the scout returned the file content; let me decide
whether to re-spawn the developer based on it." That decision is Class A;
the Read that fed it might have been Class B, but the *decision* is not.

### Class B — Haiku-eligible spawn (worth a scout)

- **Read of a large file by absolute path (≥ `scout_min_bytes`, 12288 default).**
  Primary target: 100-KB JSON dump, audit-log chunk, prior-agent report.
  Effective bytes is the on-disk size, not the offset/limit substring.
- **Multi-file Grep with `output_mode: files_with_matches`.** Small result
  list, large search corpus.
- **Glob of a deep directory tree.** Same shape.
- **Telemetry-blob summarization.** Scout returns a list; PM reasons about it.

**Anti-pattern:** "spawn scout to grep `agents/pm.md` for Section 19" — the
result is consumed for the PM's own routing decision (Class A in intent).
The rule's `scout_blocked_paths: ["agents/**"]` short-circuits to inline.

### Class C — Deterministic helper (no LLM)

File-exists, line-count, git-status, schema-validate, hash-compute. Handled
by P1.4 `bin/_lib/sentinel-probes.js`. The Section 23 rule short-circuits
to Class C BEFORE evaluating Class B — never a scout target.

### Class D — Existing subagent flow

Architect, developer, reviewer, refactorer, tester, debugger, etc. Routed
by Section 19 (Model Routing Protocol). The scout is **additive** to
Section 19, not a replacement.

---

## Section 23b — Worked examples

| op | target_path | target_bytes | class | decision | rationale |
|---|---|---|---|---|---|
| Read | `/tmp/reviewer-report.md` | 22000 | B | spawn scout | over 12 KB; not in blocked paths; class B |
| Read | `agents/pm.md` | 80000 | B | inline | path matches `agents/**` blocklist |
| Read | `/tmp/small.json` | 4000 | B | inline | below `scout_min_bytes` (12288) |
| Edit | `/tmp/anything.md` | 50000 | B | inline | `Edit` is in `scout_blocked_ops` |
| Read | `.orchestray/state/orchestration.md` | 30000 | B | inline | matches `.orchestray/state/*` |
| Glob | `(directory tree)` | n/a | B | spawn scout | Class B + non-blocked + not size-gated by file size |
| Read | `/tmp/log.jsonl` | 200000 | A | inline | PM uses content for its own decision |

---

## Section 23c — Kill switches and revert procedure

- **Config:** `haiku_routing.enabled: false` in `.orchestray/config.json`.
- **Env (current session):** `ORCHESTRAY_HAIKU_ROUTING_DISABLED=1`.
- **Telemetry effect:** `pm_turn.routing_class` still populated;
  `inline_or_scout` always `inline`. Analytics query "scouts off but
  Class-B ops available" surfaces forgone savings.

---

## Section 23d — Troubleshooting

- **"Scout returned empty / `files_changed` non-empty":** the validator
  hook (`bin/validate-task-completion.js`) rejected the transcript per the
  read-only contract. Check the latest `scout_forbidden_tool_blocked` /
  `scout_files_changed_blocked` audit row.
- **"Section 23 rule never fires":** grep `pm_turn` rows for
  `routing_class` distribution. If all rows are `null`, the marker-parser
  is not catching the announcement format. Check `bin/capture-pm-turn.js`
  for the regex.
- **"Estimated savings flat at $0":** `scout_estimated_savings_usd` is
  computed by the spawn-time PM math; if always $0, the per-call inline-
  Opus baseline isn't being computed. See `cost-prediction.md` §31a.

---

## Section 23e — v2.2.1 promotion telemetry gate

See `cost-prediction.md` §31a for the three binding criteria
(≥ 100 `scout_spawn` events, cache-read ratio ≥ 30%, mean savings > 0).
The architect — not the reviewer — owns this gate; reviewers confirm the
criteria are met before sign-off.

---

<!--
v2.2.3 P4 W2 Strip: §23f Background-housekeeper section removed. The
orchestray-housekeeper subagent shipped in v2.2.0 with a marker-based
delegation protocol but never fired (0 invocations across 7 post-v2.2.0
orchestrations) because the marker→spawn router was never wired. Cost
upside: ~$0.05/year. Re-introduction (if any) will use an explicit MCP
tool with verifiable cost telemetry, not marker prose. See
.orchestray/kb/artifacts/v223-p3-housekeeper-decision.md and
v223-p4-strip-and-a3-impl.md.
-->

