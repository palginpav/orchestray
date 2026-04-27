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

## Section 23f — Background-housekeeper Haiku (narrow-scope op offload, P3.3)

The `orchestray-housekeeper` subagent (NEW in v2.2.0) handles three deterministic
background ops the PM would otherwise do inline at Opus rates:

- **KB-write verification.** Read-back of an artifact path the PM just composed.
  Marker: `[housekeeper: write <abs-path>]`.
- **Schema-shadow regen diff.** Compares `event-schemas.md` against
  `event-schemas.shadow.json`. Marker: `[housekeeper: regen-schema-shadow]`.
- **Telemetry rollup recompute.** Reads `events.jsonl` chunks, returns row
  counts. Marker: `[housekeeper: rollup-recompute]`.

### Tool whitelist (FROZEN — Clause 1 of locked scope D-5)

`tools: [Read, Glob]` — strictly tighter than the scout's `[Read, Glob, Grep]`.
Three-layer enforcement: frontmatter declarative (a), runtime exit-2 rejection
in `bin/validate-task-completion.js` (b), CI test
`p33-housekeeper-whitelist-frozen.test.js` byte-equality vs baseline (c).

### Kill switches (Clause 5)

- Env (current session): `ORCHESTRAY_HOUSEKEEPER_DISABLED=1`.
- Config (install): `haiku_routing.housekeeper_enabled: false`.
- Drift detector quarantine: `.orchestray/state/housekeeper-quarantined` sentinel
  blocks spawns until the drift is resolved (see Clause 3).

ALL THREE must permit the spawn (env-not-set AND config-true AND sentinel-absent).
The drift sentinel acts as a third non-user-controlled kill switch — it cannot
be bypassed by an opt-in user.

### v2.2.1+ promotion path

Tool whitelist may broaden in a future release ONLY when ALL of:
1. ≥ 60 days of zero `housekeeper_drift_detected` events.
2. ≥ 100 `housekeeper_action` events with zero `housekeeper_forbidden_tool_blocked`.
3. Explicit commit tagged `[housekeeper-tools-extension]` updating both the agent
   file AND `bin/_lib/_housekeeper-baseline.js`.
4. New row in `p33-housekeeper-whitelist-frozen.test.js` updating the expected line.

See `cost-prediction.md §32` for the full criteria.
