# Curator Stage: Commit — Tombstones, Guardrails, Output, Events, Config

> Active during curator commit/output phase.
> Always load curator-stages/phase-contract.md alongside this file.
> Decision protocol is in (see phase-execute.md §"4. Decision Protocol").
> Input gathering is in (see phase-decomp.md §"2. Inputs You Read Every Run").

---

## 5. Tombstone Protocol

Every destructive action requires a tombstone row recorded alongside it.
The tombstone file is the sole source of truth for rollback.

**You do NOT write tombstone rows directly via the `Write` tool.** All tombstone
operations go through `mcp__orchestray__curator_tombstone`.

### Atomicity ordering (W1 fix — action first, tombstone second)

> **CRITICAL ordering:** Perform the destructive file operation FIRST, then
> write the tombstone row in a try/finally block.

**Per-action protocol (must follow this order):**

1. Capture `content_snapshot` from the pattern file (read immediately before acting).
2. **Execute the destructive action** (file copy / merge write / file delete).
3. Call `mcp__orchestray__curator_tombstone` in a try/finally on success.
4. If the tombstone write fails after a successful action, log to stderr and continue.

### Run lifecycle

**At the very start of every run** (before any promote/merge/deprecate action):

```
mcp__orchestray__curator_tombstone({ "action": "start_run" })
```

Save the returned `run_id`. The tool also acquires the `run.lock`.

**After each destructive action** (on success only), call:

```
mcp__orchestray__curator_tombstone({
  "action": "write",
  "run_id": "<run_id from start_run>",
  "tombstone": "<JSON-serialised tombstone object>"
})
```

### Tombstone payload schema

```json
{
  "action": "promote | merge | deprecate | unshare",
  "inputs": [
    {
      "slug": "<kebab-case pattern slug>",
      "path": "<source path>",
      "content_sha256": "<sha256 hex>",
      "content_snapshot": "<full frontmatter + body>"
    }
  ],
  "output": {
    "path": "<destination path>",
    "action_summary": "<prose summary of what was done>"
  }
}
```

### 5.x Rationale field (optional, v2.1.2+)

When writing a tombstone, MUST include a `rationale` object:

```json
{
  "schema_version": 1,
  "one_line": "<one short sentence>",
  "signals": {
    "confidence": 0.82,
    "decayed_confidence": 0.74,
    "times_applied": 4,
    "age_days": 23,
    "category": "routing",
    "skip_penalty": 0.0,
    "deprecation_score": null,
    "similarity_score": null
  },
  "guardrails_checked": ["G3-same-category", "G19-merged-from"],
  "considered_alternatives": [],
  "adversarial_re_read": { "passed": true, "missing": [], "contradicted": [] },
  "notes": "LLM-generated rationale, not a formal proof."
}
```

### Retention

Keep-last-N rotation (default N=3) is handled automatically by `start_run`.

### Rollback commands (context for run summary output)

- `/orchestray:learn undo-last` — reverses ALL actions from the most recent run.
- `/orchestray:learn undo <action-id>` — reverses one specific action.
- `/orchestray:learn clear-tombstones` — drops all tombstone history (requires confirmation).

### `undo-last` via tool

```
mcp__orchestray__curator_tombstone({ "action": "undo_last" })
```

### `undo-by-id` via tool

```
mcp__orchestray__curator_tombstone({ "action": "undo_by_id", "action_id": "<action_id>" })
```

### `list` via tool

```
mcp__orchestray__curator_tombstone({ "action": "list" })
```

### Tombstone invariant

If `mcp__orchestray__curator_tombstone` returns `isError: true` for a `write` call,
**do not execute the corresponding action**.

---

## 6. Guardrails (Hard Invariants)

### Category safety

- **G1.** `user-correction` patterns are NEVER auto-deprecated.
- **G2.** `user-correction` merges require confidence within ±0.1 AND Evidence overlap.
- **G3.** Cross-category merges are forbidden unconditionally.

### Privacy and protection safety

- **G4.** If project-level `sensitivity: private` is set, disable all promotes.
- **G5.** Per-pattern `private: true` frontmatter is NOT part of v2.1.0.
- **G6.** `pinned: true` patterns are excluded from merge and deprecate.

### Gate-before-commit safety

- **G7.** Sanitization gate (`bin/_lib/shared-promote.js`) MUST run before any promote.
- **G8.** Destructive action MUST be attempted first; tombstone row written immediately after.
- **G9.** Merged pattern must pass frontmatter schema validation.
- **G9b.** Merged pattern must pass adversarial re-read (`passed: true`).

### Volume caps (hardcoded)

- **G10.** Maximum 3 promotes per run.
- **G11.** Maximum 3 merges per run.
- **G12.** Maximum 8 deprecates per run.
- **G13.** A category must retain at least 3 active patterns after the run.

### Rollback safety

- **G14.** Every tombstone row must include `user_rollback_command`.
- **G15.** `/orchestray:learn undo-last` operates only on the most-recent run's rows.
- **G16.** Rollback of a merge must reconstitute each input from its `content_snapshot`.

### Concurrency safety

- **G17.** A `run.lock` file at `.orchestray/curator/run.lock` prevents overlapping runs.

### Scope safety

- **G18.** Never read `src/`, `bin/`, `agents/`, `skills/`, or any file outside
  `.orchestray/` and the shared dir.

### Merge lineage safety

- **G19.** A pattern with `merged_from:` in its frontmatter cannot be proposed as a
  merge candidate.

---

## 7. Run Output Format

### Default path (auto-apply)

```
Curator run complete: N actions taken, M skipped.

  [PROMOTE]   <slug>   -> shared tier    (action_id: <action_id>)
              why: <rationale.one_line>
  [MERGE]     <slug-a> + <slug-b> -> <lead-slug>   (action_id: <action_id>)
              why: <rationale.one_line>
  [DEPRECATE] <slug>   (low-value: score X.X)   (action_id: <action_id>)
              why: <rationale.one_line>
  [SKIP]      <slug>   (<reason>)

Undo this run:  /orchestray:learn undo-last
```

### Dry-run output

Writes proposals to `.orchestray/curator/proposals-<ISO>.md` and exits without
applying any actions.

---

## 8. Event Emission

### Events emitted automatically by infrastructure tools

- `curator_run_start` — emitted by `mcp__orchestray__curator_tombstone` `action: "start_run"`.
- `curator_action_promoted` — emitted on `action: "write"` with `action: "promote"` tombstone.
- `curator_action_merged` — emitted on `action: "write"` with `action: "merge"` tombstone.
- `curator_action_deprecated` — emitted on `action: "write"` with `action: "deprecate"` tombstone.
- `pattern_deprecated` with `by: "curator"` — emitted by `mcp__orchestray__pattern_deprecate`.

### curator_run_complete (your responsibility — final action)

Your **last action** every run is to append a `curator_run_complete` event to
`.orchestray/audit/events.jsonl`.

```json
{
  "timestamp": "<ISO-8601-Z>",
  "type": "curator_run_complete",
  "orchestration_id": null,
  "run_id": "curator-<ISO-8601-with-seconds-Z>",
  "actions_applied": { "promote_n": 0, "merge_n": 0, "deprecate_n": 0 },
  "actions_skipped": { "promote_n": 0, "merge_n": 0, "deprecate_n": 0 },
  "tombstones_written_count": 0
}
```

---

## 9. Single-Pass Execution Model

You operate in **single-pass mode** within `maxTurns: 15`:

- **Turn 1:** Read all patterns + telemetry + skip events + tombstones.
- **Turns 2–13:** Apply actions one at a time (action → tombstone → event).
- **Turn 14:** Write `curator_run_complete` event.
- **Turn 15:** Emit final structured run summary.

### Self-escalation (optional, bounded)

You may escalate a borderline merge decision to opus/high. Cap: 3 escalations per run.
Controlled by `curator.self_escalation_enabled` config key (default: `true`).

---

## 10. `pattern_find` Closed-Loop Validation

After applying merges, call `mcp__orchestray__pattern_find` to verify the merged
pattern is retrievable and deprecated originals are not surfaced.

---

## 11. Configuration Keys

```yaml
curator:
  enabled: true
  self_escalation_enabled: true
  pm_recommendation_enabled: true
  tombstone_retention_runs: 3
```

If `curator.enabled: false`, exit immediately.

---

## 12. Dependency Notes for Implementers

### F1 (v2.1.0) — curator integration bridge (current)

- **`mcp__orchestray__curator_tombstone`** — bridge tool for all tombstone operations.
- **`mcp__orchestray__pattern_deprecate`** — call with `by: "curator"` for deprecations.
- **`bin/_lib/shared-promote.js`** — sanitization pipeline (invoked by SKILL layer).

### Your own reasoning (no external helper module needed)

- Deprecation score computed inline using the formula in §4.3.
- Pattern loading via `Glob` + `Read`.
- Adversarial re-read via self-directed second-pass reasoning.

### B9 (pattern_find curator integration, Wave 3)

Future: `include_deprecated: true` flag for `pattern_find`. Until then, curator reads
deprecated patterns directly via `Read`/`Glob`.

---

## Incremental Mode (--diff)

### When this section applies

Active only when SKILL dispatcher passes a `dirtySetPath` (i.e., `curate --diff`).
When absent, evaluate the full corpus as usual.

### What dirtySetPath contains

```json
{
  "mode": "diff",
  "run_id": "<runId>",
  "dirty": ["slug-a", "slug-b"],
  "corpus_size": 42,
  "breakdown": {},
  "forced_full": false
}
```

### Decision-scoping rules

When `dirtySetPath` present and `forced_full: false`:
- **Promote candidates:** evaluate only slugs in `dirty`.
- **Merge candidates:** use H3 shortlist filtered to pairs where at least one side is dirty.
- **Deprecate candidates:** evaluate only slugs in `dirty`.
- **Federation collision check:** ALWAYS read full shared tier regardless of dirty-set.

### `evaluated_slugs` — required in structured result

Include `evaluated_slugs: string[]` in your structured result JSON listing all slugs
you reasoned over this run.

### Zero-dirty short-circuit (handled by SKILL before spawn)

If dirty set is empty, SKILL exits before spawning you.

### Fallback: absent or empty dirtySetPath

If `dirtySetPath` cannot be read, treat as full sweep. Never throw — fail-open.
