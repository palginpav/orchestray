# Archetype Cache Protocol Reference (v2.1.8)

Tier-2 reference file. Loaded when
`context_compression_v218.archetype_cache.enabled` is not false.

This file is the canonical specification for ArchetypeCache in advisory-active
mode. The PM reads this to understand how signatures are computed, how the
advisory fence is interpreted, and how the six guardrails shape behavior.

---

## What ArchetypeCache does

ArchetypeCache stores materialized task graphs (agent set, file ownership,
contracts, routing decisions) keyed by a normalized task-shape signature. When
a new orchestration's task shape matches a prior one with sufficient confidence,
the PM receives the cached decomposition as an advisory hint — a non-binding
structural reference it can adopt, adapt, or discard.

**Advisory-active mode:** the PM remains the sole decision-maker. The cache
is informative, not prescriptive. No PM reasoning step is skipped.

---

## Signature Computation (Guardrail 3)

The signature is a deterministic 12-hex-char string derived from four required
components. Same inputs always produce the same signature; different inputs on
any single component produce a different signature.

### Component 1: Agent Set

Sorted, comma-joined list of subagent types the orchestration is expected to
use, derived from the PM's pre-decomposition scan. Example:
`architect,developer,reviewer`

Normalization rules:
- Sort alphabetically
- Lowercase agent type names
- Exclude the PM itself (it is always present)

### Component 2: File-Count Bucket

Number of files in the pre-decomposition file scan, mapped to:

| Count | Bucket |
|-------|--------|
| 1     | XS     |
| 2–4   | S      |
| 5–12  | M      |
| 13–40 | L      |
| 41+   | XL     |

### Component 3: Top-5 Keyword Cluster

Stop-word-removed tokenization of the user task description. Steps:
1. Lowercase the description
2. Replace non-alphanumeric characters with spaces
3. Split on whitespace
4. Remove words shorter than 3 characters
5. Remove English stop-words (a, an, the, and, or, in, on, at, to, for, of,
   with, is, it, be, by, as, are, was, were, has, have, had, do, does, did,
   will, would, could, should, may, might, can, this, that, these, those, etc.)
6. Count word frequencies
7. Take top 5 by frequency (tie-break: alphabetical)
8. Sort the 5 words alphabetically

Result: comma-joined alphabetically sorted string, e.g. `cache,context,inject,match,signature`

### Component 4: Complexity Score Bucket

The PM's Section 12 complexity score, rounded to the nearest integer. Example:
score 7.3 → bucket `7`.

### Hash Function

```
signature = sha256(agentSet || '||' || fileBucket || '||' || keywords || '||' || scoreBucket)
            .hex.slice(0, 12)
```

The `||` separator prevents component boundary ambiguity (e.g., `ab` + `c` vs
`a` + `bc`).

---

## Weighted-Jaccard Confidence Scoring

Confidence measures how well a stored archetype matches the query task across
the four components.

```
confidence =
  0.4 × agents_score  +
  0.2 × files_score   +
  0.2 × keywords_score +
  0.2 × score_score
```

Where:
- `agents_score` = 1.0 if agent sets are identical, 0.0 otherwise
- `files_score`  = 1.0 if file-count buckets match, 0.0 otherwise
- `keywords_score` = Jaccard similarity over the two keyword sets
  (`|intersection| / |union|`; both empty → 1.0)
- `score_score`  = 1.0 if score buckets are within ±1, 0.0 otherwise

---

## Six Guardrails (all mandatory)

### Guardrail 1: Minimum Prior Applications

`config: context_compression_v218.archetype_cache.min_prior_applications` (default: 3)

Archetypes with fewer than this many successful applications are recorded in
the cache state file but NEVER surfaced as advisory hints. They accumulate
evidence silently until the threshold is met.

**Effect when triggered:** no advisory fence injected, no event emitted.

### Guardrail 2: Confidence Floor

`config: context_compression_v218.archetype_cache.confidence_floor` (default: 0.85)

Only archetypes whose Weighted-Jaccard confidence meets or exceeds this value
are surfaced. Partial matches below this are logged to the state file for ROI
analysis but never shown to the PM.

**Effect when triggered:** no advisory fence injected, no event emitted.

### Guardrail 3: High-Fidelity Signature

All four components (agent set, file-count bucket, keyword cluster, score
bucket) are required. If any component is unavailable or errors during
computation, the signature computation fails and the hook falls back to
normal decomposition with no advisory. Logged to degraded.jsonl as
`archetype_cache_signature_failed`.

### Guardrail 4: Per-Archetype Blacklist (Kill Switch)

`config: context_compression_v218.archetype_cache.blacklist` (default: [])

Array of archetype IDs (12-hex strings) to mute. An archetype in the blacklist
is treated as a cache miss — no advisory is served even if confidence >= 0.85
and prior_applications_count >= 3.

**Telemetry:** a blacklist hit emits an `archetype_cache_blacklisted` degraded
entry to `.orchestray/state/degraded.jsonl` (kind: `archetype_cache_blacklisted`,
severity: info). This is NOT a blocking event.

**Management:** add IDs to the blacklist manually in `.orchestray/config.json`,
or via `/orchestray:config archetype-cache blacklist add <id>`.

### Guardrail 5: Global Kill Switch

`config: context_compression_v218.archetype_cache.enabled: false`

When false, the entire subsystem is disabled:
- No cache reads or writes
- No advisory fence injection
- No events or degraded entries
- No ROI telemetry

The global `context_compression_v218.enabled: false` also disables this
sub-feature as part of the master kill switch.

### Guardrail 6: Observability Surface

`/orchestray:patterns` displays an "Archetype cache (advisory)" section.
See the dashboard format below. This guardrail ensures the cache is never a
black box — operators can inspect hit rate, override rate, adaptation rate,
and top archetypes at any time.

---

## Advisory-Active Flow

1. **Hook fires** (`inject-archetype-advisory.js`) on `UserPromptSubmit`.
2. **Pre-decomposition check:** if routing.jsonl already has entries for this
   orchestration_id, advisory would be too late — skip.
3. **Signature computed** from task description, expected agent set, file count,
   and complexity score in `current-orchestration.json`.
4. **Cache lookup** via `findMatch()` — enforces guardrails 1, 2, 4, 5.
5. **On match:** archetype content read from
   `.orchestray/state/archetype-cache/{id}.md`; fence assembled and emitted as
   `additionalContext` on stdout.
6. **PM sees fence** in its next prompt turn and decides:
   - **accepted** — adopt prior decomposition verbatim
   - **adapted** — use as starting point, modify 1–3 details
   - **overridden** — ignore and decompose from scratch
7. **PM emits event** `archetype_cache_advisory_served` with `pm_decision` and
   `pm_reasoning_brief` (≤120 tokens, stored in event as ≤280 chars).
8. **On orchestration complete:** if successful, the PM calls
   `recordApplication(archetypeId, orchId, 'success')` to increment
   `prior_applications_count`. On failure or override, outcome is `'failure'`
   or `'overridden'`.

---

## Advisory Fence Format

```
<orchestray-archetype-advisory>
[orchestray] ArchetypeCache advisory — confidence {X}%, applied {N}x previously.
Archetype ID: {12-hex-id}
Signature components: agents=[{sorted agent list}], files={bucket},
  keywords=[{top5}], score={bucket}

The decomposition below comes from a prior orchestration with a matching task shape.
This is an advisory hint — you MUST still run Section 13 decomposition.
Decide: accepted (adopt verbatim) | adapted (modify 1-3 details) | overridden (start fresh).
Emit archetype_cache_advisory_served event with pm_decision and pm_reasoning_brief.

### Prior decomposition:

{Stored task graph markdown — agent set, file ownership, dependencies, contracts}
</orchestray-archetype-advisory>
```

---

## LRU Eviction and TTL

- **Max entries:** `context_compression_v218.archetype_cache.max_entries` (default: 30)
- **TTL:** `context_compression_v218.archetype_cache.ttl_days` (default: 30 days)

Eviction policy: when adding a new record would exceed `max_entries`, the
entry with the oldest `last_used_ts` is removed (Least Recently Used).

TTL filter: records whose `last_used_ts` is older than `ttl_days` are excluded
from lookups and overwritten on the next write.

State file: `.orchestray/state/archetype-cache.jsonl` — one JSON object per
line, append-then-rewrite discipline (full rewrite on each update to enforce
LRU and TTL).

---

## Cache Entry Format

Each line in `archetype-cache.jsonl`:

```jsonc
{
  "archetype_id": "a3f9c12e8b5d",      // 12-hex signature
  "prior_applications_count": 4,         // successful applications
  "failed_uses": 0,                      // failed/overridden applications
  "last_outcome": "success",             // last application outcome
  "last_used_ts": 1718000000000,         // ms since epoch (for LRU + TTL)
  "last_orch_id": "orch-2026-04-20-...", // last orchestration that used this
  "created_ts": 1716000000000,           // creation time
  "agentSet": "architect,developer,reviewer",
  "fileBucket": "M",
  "keywords": "cache,context,inject,match,signature",
  "scoreBucket": "7"
}
```

Task graph content lives in `.orchestray/state/archetype-cache/{signature}.md`.

---

## Blacklist Semantics

- IDs in `blacklist` are muted silently at lookup time.
- A `archetype_cache_blacklisted` degraded entry (kind, severity: info) is
  written to `.orchestray/state/degraded.jsonl` when a match is found but
  suppressed by the blacklist.
- The ROI signal (override rate high → candidate for blacklisting) is surfaced
  in `/orchestray:patterns` and informs manual blacklist management.
- Blacklisted entries are NOT deleted from the state file — they remain and
  continue accumulating `prior_applications_count` data (useful for un-blacklisting).

---

## Dashboard Data Source

The `/orchestray:patterns` "Archetype cache (advisory)" section reads data via
`bin/_lib/archetype-cache.js getDashboardStats()`.

Display format:

```markdown
## Archetype cache (advisory)

- **Hit rate:** {advisories_served} / {decompositions_attempted} = {pct}%
- **Override rate:** {overridden} / {advisories_served} = {pct}%
- **Adaptation rate:** {adapted} / {advisories_served} = {pct}%
- **Top-5 most-applied archetypes:**
  1. {archetype_id} — {N} applications
  2. ...
```

If `advisories_served == 0`:
```
No archetype advisory events recorded yet. The cache will begin serving
advisories once archetypes accumulate >= 3 successful applications.
```

---

## Degraded-Journal Entries Added by This Feature

| kind | severity | when |
|------|----------|------|
| `archetype_cache_signature_failed` | warn | Signature computation errored; PM decomposes normally |
| `archetype_cache_hint_write_failed` | warn | Hint file write errored; no advisory served |
| `archetype_cache_roi_write_failed` | warn | ROI JSONL write errored; advisory still served, telemetry lost |
| `archetype_cache_blacklisted` | info | Match found but archetype_id is in blacklist |

---

## Interaction with Other Bundle CTX Features

- **CiteCache / SpecSketch / RepoMapDelta:** ArchetypeCache is independent of
  these three. An archetype-advised decomposition still benefits from the other
  CTX features in subsequent delegations.
- **Pattern federation:** archetype signatures are project-local; they are not
  federated to `~/.orchestray/shared/`. Archetype reuse is per-project only.
- **Specialist registry:** archetype records may reference specialist agent types
  (e.g. `translator`). The PM must check the specialist is present before
  accepting an archetype that uses one.
