# Pattern Extraction & Application Protocol Reference

Detailed procedures for extracting, applying, and pruning orchestration patterns.
For an overview and integration points, see the main PM prompt Section 22.

> **Read-path counterpart.** This file documents how patterns are *written*
> (extracted, scored, pruned). The corresponding *read* path is the MCP tool
> `mcp__orchestray__pattern_find`, invoked from Section 22b. Extraction writes
> are unchanged -- the MCP server reads the same `.orchestray/patterns/*.md`
> files this protocol produces. If you change the frontmatter schema here, you
> must update `bin/mcp-server/lib/frontmatter.js` and
> `bin/mcp-server/tools/pattern_find.js` in lockstep.
>
> **Application record (MUST, post-find):** after `pattern_find` returns, call EITHER
> `mcp__orchestray__pattern_record_application` (one or more times, if patterns shaped
> the decomposition) OR `mcp__orchestray__pattern_record_skip_reason` (exactly once, if
> none shaped it). See §22b in tier1-orchestration.md for the full directive. Calling
> neither is a protocol violation.

---

## 22a. Automatic Pattern Extraction (Post-Orchestration)

Run AFTER Section 15 step 3 completes (audit trail archived, cleanup done, cost
reported, confidence feedback applied via Section 22c).

1. **Read archived events:** Load `.orchestray/history/<orch-id>/events.jsonl` from the
   just-archived orchestration. Also read `.orchestray/history/<orch-id>/state/task-graph.md`
   if it exists (for decomposition context).

2. **Identify extractable patterns** across four categories:
   - **decomposition:** Task breakdown strategies that led to success (zero re-plans, zero
     verify-fix failures). Record the decomposition approach from the task graph.
   - **routing:** Model routing decisions that proved correct -- `routing_outcome` events
     where the chosen model completed without escalation.
   - **specialization:** Dynamic agents saved as specialists (`specialist_saved` events) or
     specialist reuses that succeeded.
   - **anti-pattern:** Re-plan triggers (`replan` events), verify-fix failures
     (`verify_fix_fail`), escalations (`escalation` events). Record what went wrong and why.
   - **user-correction:** Direct user corrections captured during or after orchestration
     (Section 34), or via manual `/orchestray:learn correct` command. These carry high
     initial confidence (0.8) because the user explicitly stated the correct approach.
     Stored as `user-correction-{slug}.md` files, matched during delegation (Section 34f).

3. **Skip extraction when:**
   - Orchestration was simple (2-3 tasks, standard architect->developer->reviewer flow
     with no novel insight), OR
   - An equivalent pattern already exists in `.orchestray/patterns/` with higher confidence
     (update the existing pattern's Evidence section instead of creating a duplicate).

4. **Check for duplicates:** Before writing a new pattern, glob `.orchestray/patterns/*.md`
   and check if a substantially similar pattern already exists. Update existing rather
   than duplicate. Note: exclude files with `category: replay` from this duplicate check —
   replay patterns are owned by §43c and must not be modified by §22a.

5. **Write pattern files** to `.orchestray/patterns/{category}-{name}.md` using this template:

   ```markdown
   ---
   name: {kebab-case-name}
   category: {decomposition|routing|specialization|anti-pattern}
   confidence: {0.5 for positive patterns, 0.6 for anti-patterns}
   times_applied: 0
   last_applied: null
   created_from: {orch-id}
   description: {one-line description for matching}
   # trigger_actions (anti-patterns only, W12 LL3): list of substring triggers.
   # When present, gate-agent-spawn.js matches incoming Agent() descriptions
   # against these strings (case-insensitive substring). Anti-patterns without
   # this field will NOT fire advisory injections. Omit for positive patterns.
   trigger_actions:
     - {keyword or short phrase from the anti-pattern's context}
   ---

   # Pattern: {Human Readable Name}

   ## Context
   {When this pattern applies -- task type, domain, characteristics}

   ## Approach
   {What to do (positive) or what to avoid (anti-pattern)}

   ## Evidence
   - {orch-id}: {brief outcome description}
   ```

   **`trigger_actions` guidance (anti-patterns only):**
   - Add 2–8 short substrings that appear in typical Agent() spawn descriptions
     that would trigger this anti-pattern (e.g., `"whole codebase"`, `"full audit"`,
     `"review entire"`).
   - Matching is case-insensitive substring. No regex — keep triggers simple.
   - Without `trigger_actions`, the pattern is still used by `pattern_find` for
     the PM's pre-decomposition consultation but will NOT emit advisory injections
     to spawned agents. This is intentional (safe fallback, not an error).

6. **Report to user:** Show a brief table of extracted patterns (Name, Category,
   Confidence). If no patterns extracted, say "No novel patterns identified from
   this orchestration."

7. **Run pruning** per Section 22d after writing new patterns.

---

## 22b-pre. Structured Skip-Recording Contract (W11 LL1)

When `pattern_find` returns N patterns and the PM does NOT apply one or more of them, it
MUST call `mcp__orchestray__pattern_record_skip_reason` for each unapplied pattern.

### Required fields (W11)

| Field | Values | Guidance |
|-------|--------|----------|
| `pattern_name` | The pattern's `slug` from the `pattern_find` result | MUST be provided. Omitting it writes `pattern_name: null` to the `pattern_skip_enriched` audit event, making the skip_penalty term in the curator's deprecation formula always zero. |
| `match_quality` | `strong-match`, `weak-match`, `edge-case` | How well the pattern's context predicate matched the current task |
| `skip_category` | See table below | The primary reason this pattern was skipped |

### skip_category taxonomy

| Category | When to use |
|----------|-------------|
| `contextual-mismatch` | Pattern matched the surface criteria but key context differs (e.g., pattern is for "parallel file-exclusive updates", current task is cross-cutting) |
| `stale` | Pattern's `decayed_confidence` was below the threshold the PM would normally act on. **Use this when `decayed_confidence < 0.4`** (per §22d-pre decay guidance) |
| `superseded` | Another pattern in the result set supersedes this one — pass its name in `superseded_by` |
| `operator-override` | User explicitly directed a different approach |
| `forgotten` | **Fallback only** — use when no other category fits. Choosing `forgotten` logs a stderr warning when its rate exceeds 30% over the last 25 skips for the current orchestration. Prefer an explicit category. |

### Optional fields

| Field | Guidance |
|-------|----------|
| `cited_confidence` | The `decayed_confidence` value from `pattern_find` results seen at decision time. Provide this whenever available — it lets retrospective analysis see whether skips cluster around specific decay thresholds. |
| `superseded_by` | Name of the superseding pattern. Required when `skip_category: superseded`; must be omitted otherwise. |
| `skip_reason` | Free-form prose (1–3 sentences) explaining the skip. Complements the structured `skip_category`. |

### Stale threshold rule

If `pattern_find` returns a pattern with `decayed_confidence < 0.4` AND you decide to
skip it, `skip_category` SHOULD be `stale` (unless another category is more precisely
correct). Pass `cited_confidence: <value>` so the threshold can be verified in analysis.

### Forgotten-rate guard

The MCP tool counts `pattern_skip_enriched` events for the current orchestration over a
rolling window of the last 25 calls. If `forgotten` category exceeds **30%** of that
window, it emits a stderr warning:

```
pattern skip enrichment: <X>% forgotten over last <N> skips — consider explicit categorisation
```

If the PM observes this warning repeated across multiple orchestrations, it should pause
at the next pre-decomposition check and be more deliberate about skip-recording categories.

### Backward compatibility

The legacy `reason` field (`all-irrelevant`, `all-low-confidence`, `all-stale`, `other`)
is preserved and still required. It is now the high-level prose companion to the
structured `skip_category`. Map the categories approximately:
- `skip_category: stale` → `reason: all-stale`
- `skip_category: contextual-mismatch` → `reason: all-irrelevant`
- `skip_category: superseded` → `reason: all-irrelevant`
- `skip_category: operator-override` → `reason: other` (with `note` explaining)
- `skip_category: forgotten` → `reason: other` (with `note: "pattern seen but not explicitly weighed"`)

---

## 22b. Pattern Application (Pre-Decomposition)

**Read path has moved to MCP.** The live procedure is in `tier1-orchestration.md`
§22b; it calls `mcp__orchestray__pattern_find` and injects
`@orchestray:pattern://<slug>` URIs into the decomposition prompt. See the
top-of-file blockquote for the lockstep requirement when changing pattern
frontmatter.

The manual Glob-based procedure below is retained ONLY as a fallback for the
case where the MCP server is unavailable (e.g. transport error, `mcp_server.
tools.pattern_find.enabled = false`). Normal operation uses the MCP path.

### 22b (fallback) — manual pattern application when MCP unavailable

Before running Section 13 (Task Decomposition Protocol), check stored patterns for
relevant strategies.

1. **Glob** `.orchestray/patterns/*.md`. If the directory is missing or empty, skip to
   Section 13 immediately.
2. **Read frontmatter** of each pattern file. Extract: name, category, confidence,
   description.
3. **Match patterns** against the current task description using reasoning. Consider:
   - Does the task domain overlap with the pattern's description?
   - Is the pattern category relevant? (decomposition patterns most relevant at
     decomposition stage; routing patterns inform Section 19; anti-patterns warn
     against specific approaches)
   - Prefer patterns with higher confidence scores.
4. **If relevant patterns found:**
   - Note in decomposition reasoning: "Applying pattern '{name}' (confidence {conf})
     -- {brief strategy}"
   - Track which patterns were applied (for Section 22c confidence feedback after
     orchestration completes).
5. **If no relevant patterns found:** Proceed with Section 13 normally.
6. Patterns are **ADVISORY** -- they inform decomposition but do not override PM
   judgment. If context differs from the pattern's documented context, ignore the
   pattern.

**Replay pattern integration (Section 43d):** When matching patterns, also include
patterns with `category: replay` from `.orchestray/patterns/replay-*.md`. Replay patterns
serve as advisory counter-evidence: if the PM is about to make a decomposition decision
that matches a replay pattern's `decision` field, surface the `alternative` as a
consideration with a caution note: "Note: A previous orchestration using this approach
experienced friction ({friction_signals}). Consider alternative: {alternative}."
Cap: maximum 1 replay pattern injected per decomposition (most relevant by keyword match
and recency). Replay patterns do NOT override PM judgment.

---

## 22c. Confidence Feedback Loop

Run AFTER orchestration completes but BEFORE extracting new patterns (Section 22a).
This runs as step 5 in Section 15 step 3 (post-orchestration).

**Dual-writer note**: `§41c` (in outcome-tracking.md) is a parallel feedback loop that
also adjusts pattern confidence, using different deltas (+0.15/-0.3 from probe
validation outcomes, vs §22c's +0.1/-0.2 from orchestration outcomes). §41c runs
lazily at session start before orchestration begins; §22c runs at orchestration
completion. When both fire in the same session, §41c runs first. Both loops write to
the same pattern files via last-write-wins.

For each pattern noted as "applied" during Section 22b in this orchestration:

1. Call `mcp__orchestray__pattern_record_application` with `slug` (the pattern's slug),
   `orchestration_id`, and `outcome` set to `"applied-success"` (on orchestration success)
   or `"applied-failure"` (on failure). This atomically increments `times_applied` and
   sets `last_applied` via the MCP tool. Do NOT manually write `times_applied` or
   `last_applied` — the MCP tool is the single authoritative writer for those fields.
2. Read the pattern file from `.orchestray/patterns/`.
3. Update `confidence` based on orchestration outcome (direct frontmatter write — the MCP
   tool does not manage `confidence`):
   - Status `"success"`: increase confidence by +0.1 (cap at 1.0)
   - Status `"partial"`: no change (+0.0)
   - Status `"failure"`: decrease confidence by -0.2 (floor at 0.0)
4. Write the updated `confidence` value back to the pattern file (frontmatter only).

---

## 22d-pre. Confidence Decay Model (W9 v2.0.18)

`pattern_find` returns two confidence fields for every match:

- **`confidence`** — raw value stored in the pattern file frontmatter (0.0–1.0). This
  is the historically-accumulated score maintained by §22c and §41c feedback loops.
  Use it for **human curation only** (e.g., deciding whether to promote or prune a
  pattern manually).
- **`decayed_confidence`** — time-weighted value computed on each read. This is what
  the PM should use for **ranking and automatic pruning decisions**.

### Formula

```
age_days          = (now − reference_timestamp) / 86 400 000 ms
decayed_confidence = confidence × 0.5 ^ (age_days / half_life)
```

`reference_timestamp` is `last_applied` (set by §22c when a pattern is applied) if
present and parseable; otherwise the pattern file's mtime.

### Half-life configuration

The half-life defaults to **90 days** (`pattern_decay.default_half_life_days` in
`.orchestray/config.json`). Operators can override this value (range 1–3650 days).

**Fallback precedence** (highest → lowest priority):

1. Per-pattern frontmatter `decay_half_life_days` — set directly in the `.md` file to
   give a specific pattern a custom half-life (useful for patterns known to stay
   relevant longer, such as security anti-patterns).
2. `pattern_decay.category_overrides[category]` in config — e.g. `{"anti-pattern": 180}`
   gives all anti-patterns a 180-day half-life.
3. `pattern_decay.default_half_life_days` — global default (90 days).

### Interpretation guide

| `decayed_confidence` vs `confidence` | Meaning |
|--------------------------------------|---------|
| ≥ 90% of raw | Recently applied or freshly created — treat as fully active. |
| 50–89% of raw | Aging; the pattern is becoming less predictive. Consider running a task that would exercise it to reset the clock. |
| < 50% of raw | Stale; the pattern has not been applied in more than one half-life. Weight it conservatively in decomposition decisions. |
| → 0 | Effectively expired; the pruning score `decayed_confidence × times_applied` will be near zero and this pattern is a candidate for automatic removal. |

> **Note:** 18 of 20 initial patterns have `times_applied: 0`, making the legacy pruning
> score (`confidence × times_applied`) zero for all of them — effectively random. Using
> `decayed_confidence` in the sort key makes ranking honest even for unapplied patterns
> by penalising old unapplied ones relative to fresh ones.

---

## 22d. Pruning

Run AFTER writing new patterns in Section 22a step 7.

1. Count all `.md` files in `.orchestray/patterns/`.
2. If count > 50: compute `score = confidence * times_applied` for each pattern.
   **Exclude replay patterns**: Before computing scores, filter the pattern list to
   exclude files with `category: replay` in their frontmatter. Replay patterns are
   owned by §43c and have their own pruning lifecycle.
3. Sort ascending. Remove patterns with the lowest scores until count = 50.
4. Log: "Pruned {N} low-value patterns: {names}"
5. Append `pattern_pruned` event(s) to the current audit trail (if still active)
   or note in output.

---

## 22e. Anti-Pattern Pre-Spawn Advisory Gate (W12 LL3)

The pre-spawn advisory gate (`bin/gate-agent-spawn.js`) automatically injects
anti-pattern advisories into the context of spawned agents when a high-confidence
match is detected. This is a **passive, advisory-only** gate — it never blocks spawns.

### How it works (OQ-TB-1 choice)

1. On every `Agent()` spawn, the hook reads all `anti-pattern-*.md` files from
   `.orchestray/patterns/`.
2. For each anti-pattern that has a `trigger_actions` field, it performs a
   **case-insensitive substring match** against the spawn's `description` string.
3. Matching patterns are filtered by `decayed_confidence >= 0.65` (config-tunable
   via `anti_pattern_gate.min_decayed_confidence`).
4. Patterns suppressed by a recent `pattern_skip_enriched` event with
   `skip_category: contextual-mismatch` for the same orchestration are excluded.
5. The **top 1** match (by `decayed_confidence × trigger_specificity`) emits an
   `additionalContext` hook response — Claude Code injects this into the spawned
   agent's context transparently.
6. An `anti_pattern_advisory_shown` audit event is emitted for every advisory.

### Advisory format (what the spawned agent sees)

```
[Anti-pattern advisory] The following anti-pattern applies to this task:

<pattern-name>: <description>

Why it matched: trigger "<trigger>" matched in spawn description (decayed_confidence=<N>)

Mitigation: <approach field from the pattern>
```

Spawned agents should check for this marker and take it into account when planning.
See `agent-common-protocol.md §Anti-pattern Advisory` for the agent-side contract.

### Kill flag

Set `anti_pattern_gate.enabled: false` in `.orchestray/config.json` to disable the
entire gate. All other gate-agent-spawn.js logic continues unchanged. Default: `true`.

### Config keys

| Key | Default | Description |
|-----|---------|-------------|
| `anti_pattern_gate.enabled` | `true` | Kill flag for the entire advisory gate |
| `anti_pattern_gate.min_decayed_confidence` | `0.65` | Minimum threshold for advisory emission |
| `anti_pattern_gate.max_advisories_per_spawn` | `1` | Hard cap per spawn (do not raise) |

### Suppression via skip_enriched

If the PM records `pattern_record_skip_reason` with `skip_category: contextual-mismatch`
for a pattern in the current orchestration, that pattern's advisory will be suppressed
on subsequent spawns within the same orchestration. This prevents the gate from
re-advising on patterns the PM has already explicitly evaluated and dismissed.
