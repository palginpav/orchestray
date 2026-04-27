# Curator Stage: Decide — Decision Protocol

> Active during curator decision-making phase (promote, merge, deprecate evaluation).
> Always load curator-stages/phase-contract.md alongside this file.
> Input gathering described in (see phase-decomp.md §"2. Inputs You Read Every Run").
>
> **Sacred invariants applicable here** (see phase-contract.md §0):
> - **SI-2** `user-correction` patterns are never auto-promoted (§4.1 step 3) and
>   never auto-deprecated (§4.3 user-correction exempt clause).
> - **SI-3** `local-only` patterns are never promoted, regardless of confidence
>   or `times_applied`. Add this check ahead of §4.1 step 4 ("not already in
>   shared tier") so the floor is enforced before tier-presence logic runs.

---

## 4. Decision Protocol

### 4.1 Promote (local → shared)

**Step 0 — Federation gate (check first, before evaluating any candidates).**

Before evaluating promote candidates, check BOTH:
1. `federation.shared_dir_enabled` is `true` in config, AND
2. `~/.orchestray/shared/` directory exists on the filesystem.

If EITHER check fails, **promote is disabled for this run.** Surface:
"Promote disabled: federation not configured. Re-run after enabling via
`/orchestray:config set federation.shared_dir_enabled true`."
Merge and deprecate proceed normally.

**Promote candidate criteria.** A pattern qualifies for promotion when ALL of these hold:

1. **Confidence ≥ 0.7.** Below 0.7 is not trusted enough to impose on other projects.

2. **`times_applied ≥ 1`.** Must have at least one confirmed field use. (Lowered from
   v1's ≥ 3 threshold per design W2 F01.)

   **Fallback (until A2 deployed to production):** if the majority of patterns show
   `times_applied: 0` — indicating the plumbing fix is not yet active — use
   `decayed_confidence ≥ 0.65` as the field-use proxy signal instead. Surface the
   advisory: "skip_penalty and times_applied signals are unavailable: A2 plumbing fix
   has not yet been deployed."

3. **`category ∈ {decomposition, routing, specialization, anti-pattern}`.** These are
   cross-project-relevant. `user-correction` patterns are project-user-specific by
   definition; never auto-promote them.

4. **Not already in shared tier.** If the slug exists in
   `~/.orchestray/shared/patterns/`, skip. Surface as "supersede-proposal" in
   dry-run output; do not auto-overwrite.

5. **Project-level `sensitivity: private` is NOT set.** This is the sole per-project
   privacy gate in v2.1.0. (Per-pattern `private: true` is deferred to v2.2.)

**First-run calibration advisory.** On the first `curate` invocation in a project
(detected by absence of prior tombstones at `.orchestray/curator/tombstones.jsonl`),
always emit a calibration table showing the top-N promote candidates by
`decayed_confidence`, with per-candidate reasoning regardless of whether they qualify.

**Pre-commit sanitization gate.** Before writing to the shared tier, run the
sanitization pipeline via `bin/_lib/shared-promote.js`: secret scan → Evidence strip
→ path/prefix strip → frontmatter rewrite → schema validate → length cap → write.
Gate failure → skip the promote, log reason, surface in summary. Leave local file
untouched.

**Output of a promote action:**
- New file at `~/.orchestray/shared/patterns/<slug>.md` (sanitized copy).
- Local file left in place, unchanged.
- Tombstone row written AFTER the copy succeeds (see phase-close.md §"5. Tombstone Protocol").
- Before calling `curator_tombstone`, assemble a `rationale` object per §5.x.
  For promote, `signals` MUST include `confidence`, `decayed_confidence`,
  `times_applied`, `age_days`, `category`, and `skip_penalty` (0 if suppressed
  per §4.3).

### 4.2 Merge (N patterns → 1)

**`merged_from:` block invariant.** Before assembling any cluster, check each
candidate's frontmatter. A pattern whose frontmatter contains `merged_from:` **cannot
be a merge candidate** in this run. This blocks compounding merge loops. Re-merging
a previously-merged pattern requires an explicit user request (future subcommand).

**Candidate detection.** Before clustering, read the deterministic similarity
shortlist at `.orchestray/curator/similarity-<runId>.json` (written by the SKILL
dispatcher before your spawn). Its `shortlist[]` array lists every pair whose
MinHash Jaccard ≥ 0.6 — these are the ONLY pairs worth evaluating as merge
candidates. If the file is absent, empty, or contains
`"method": "fallback-all-pairs"`, revert to the legacy read-all-then-cluster
approach over the full corpus.

**Constraints:**
- Same-category-only. Cross-category merges are unconditionally forbidden.
- `user-correction` merges are only allowed between two `user-correction` patterns
  with confidence within ±0.1 AND overlapping Evidence sections.
- If Approach sections contradict, do not merge; surface as a conflict in the summary.
- No cross-tier merges (local + shared) in v2.1.0.
- A cluster of size 1 is not a merge.

**Merge synthesis steps:**

1. Select the lead slug (highest `decayed_confidence`; ties broken by most-recent
   `last_applied`).

2. Produce a merged pattern file (same tier as inputs):
   - `name`: lead slug's name
   - `category`: shared category (guaranteed same by same-category constraint)
   - `confidence`: weighted mean by `times_applied`, then × 0.95 merge-decay
   - `times_applied`: `sum(times_applied_i)`
   - `last_applied`: `max(last_applied_i)`
   - `merged_from`: array of all N input slugs (blocks future merge candidacy)

2b. **Adversarial re-read (mandatory before committing any merge).** Issue a second
   prompt with the N source patterns' Approach sections and the merged Approach.
   If `passed == false`: do not commit the merge. No tombstone. No files modified.

3. Write the merged pattern file.
4. Delete the non-lead original files from their tier.
5. Write tombstone rows for all N input patterns (full content snapshots) AFTER
   steps 3–4 succeed (see phase-close.md §"5. Tombstone Protocol").

### 4.3 Deprecate (mark low-value patterns)

**Deprecation mechanism.** Call `mcp__orchestray__pattern_deprecate` with:
- `pattern_name`: the slug
- `reason`: one of `low-confidence | superseded | user-rejected | other`
- `by: "curator"` (B8 extends the tool to accept this field)

**Low-value score formula:**

```
deprecation_score = (1.0 - confidence) * age_days / (1 + times_applied)
                    + skip_penalty
```

**Skip-penalty suppression.** If you observe zero per-slug skip rows in the last
30 days, suppress the `skip_penalty` term entirely.

**Deprecation threshold — explicit lower bound:**

- **If `corpus_size < 0.8 × cap`:** Propose zero deprecations UNLESS all three
  conditions hold: `deprecation_score > 2.0` AND `times_applied == 0` AND `age_days > 60`.
- **If `corpus_size ≥ 0.8 × cap`:** Apply adaptive threshold (top-N percentile),
  capped at 8 deprecates per run.

**User-correction exempt.** `user-correction` category patterns are NEVER
auto-deprecated. Skip them silently.

---

### Adversarial re-read skip

```
  [MERGE]   <slug-a> + <slug-b> SKIPPED — adversarial re-read found N issue(s):
            missing: [...], contradicted: [...]
            Review manually or adjust patterns before re-running.
```
