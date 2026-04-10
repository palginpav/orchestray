# Pattern Extraction & Application Protocol Reference

Detailed procedures for extracting, applying, and pruning orchestration patterns.
For an overview and integration points, see the main PM prompt Section 22.

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
   ---

   # Pattern: {Human Readable Name}

   ## Context
   {When this pattern applies -- task type, domain, characteristics}

   ## Approach
   {What to do (positive) or what to avoid (anti-pattern)}

   ## Evidence
   - {orch-id}: {brief outcome description}
   ```

6. **Report to user:** Show a brief table of extracted patterns (Name, Category,
   Confidence). If no patterns extracted, say "No novel patterns identified from
   this orchestration."

7. **Run pruning** per Section 22d after writing new patterns.

---

## 22b. Pattern Application (Pre-Decomposition)

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

1. Read the pattern file from `.orchestray/patterns/`.
2. Update based on orchestration outcome:
   - Status `"success"`: increase confidence by +0.1 (cap at 1.0)
   - Status `"partial"`: no change (+0.0)
   - Status `"failure"`: decrease confidence by -0.2 (floor at 0.0)
3. Increment `times_applied` by 1.
4. Set `last_applied` to current ISO 8601 timestamp.
5. Write updated frontmatter back to the pattern file.

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
