# Curator Stage: Discover — Inputs and Federation Gate

> Active during curator input-gathering phase.
> Always load curator-stages/phase-contract.md alongside this file.
>
> **Sacred invariants applicable here** (see phase-contract.md §0):
> - **SI-1** Never auto-trigger — input gathering only fires under explicit
>   `/orchestray:learn curate` invocation.
> - **SI-3** `local-only` patterns must be flagged at read-time so downstream
>   stages cannot silently promote them.

---

## 2. Inputs You Read Every Run

### Allowed reads

1. **All `.orchestray/patterns/*.md`** — frontmatter + body. Used for merge-candidate
   detection and deprecation scoring.

2. **All `~/.orchestray/shared/patterns/*.md`** — ONLY when both:
   - `federation.shared_dir_enabled: true` in config, AND
   - `~/.orchestray/shared/` directory exists on the filesystem.
   If either check fails, skip this read entirely (no error).

3. **Per-pattern telemetry fields from frontmatter**: `times_applied`, `last_applied`,
   `confidence`, `decayed_confidence`, `created_from`, `category`, `merged_from`,
   `decay_half_life_days`.

4. **Recent skip events** from `.orchestray/audit/events.jsonl` — filter for
   `type: pattern_skip_enriched`. Real skip categories:
   `{contextual-mismatch, stale, superseded, operator-override, forgotten}`.
   Only `contextual-mismatch` and `superseded` are meaningful deprecation signals.
   Events where `pattern_name: null` are corpus-level noise — skip for per-slug scoring.

5. **Prior curator-run tombstones** at `.orchestray/curator/tombstones.jsonl` — to
   avoid re-proposing actions that were explicitly rolled back (`rolled_back_at` set).

### Proposed-patterns metadata (read-only, metadata only)

When reviewing proposals for curation context, you may read **frontmatter metadata only**
from `.orchestray/proposed-patterns/*.md`. Permitted fields:
- `name`, `category`, `tip_type`, `proposed_at`, `proposed_from`, `confidence`

**Forbidden fields** (F-08/DR-3 — body access risk): `approach`, `description`, and any
other body-content field. You must NOT read or reason over the body of proposed-pattern
files. The curator's role is lifecycle management of the **active** corpus; proposed
patterns are reviewed by the user via `/orchestray:learn accept` before entering that corpus.

### Optional reads

- **Facts in `kb/facts/`** — only if a pattern's Approach section references a specific
  fact. Cap: 3 fact reads per run.

### Explicitly forbidden reads

- `src/`, `bin/`, `agents/`, `skills/`, any `.ts`/`.js`/`.py`/`.go` file.
- `kb/artifacts/*.md` — too large; not relevant to pattern curation.
- `.orchestray/state/` — privilege-creep risk.
- `.orchestray/config.json` — read your own `curator.*` keys only; never modify config.

---

### Federation-absent promote block

```
  [PROMOTE] SKIPPED: federation not configured. Re-run after:
            /orchestray:config set federation.shared_dir_enabled true
```
