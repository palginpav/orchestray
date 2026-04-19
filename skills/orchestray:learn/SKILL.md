---
name: learn
description: Extract learning patterns from a completed orchestration
disable-model-invocation: true
argument-hint: "[orchestration-id] | share <slug> | unshare <slug> | list [--shared|--all] | curate [--dry-run] | undo-last | undo <action-id> | explain <action-id>"
---

# Pattern Extraction

> **Scope note:** v2.1.0 shares patterns across projects on THIS machine only. Cross-machine
> sync is planned for v2.2. To manually sync to another machine today:
> `/orchestray:learn export all` → copy the export dir → `/orchestray:learn import <path>`. To inspect federation state (enabled/disabled, shared tier contents, collisions): `/orchestray:federation status`.

The user wants to extract reusable patterns from a completed orchestration.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If the first argument is `share`: go to the **share** command below.
   - If the first argument is `unshare`: go to the **unshare** command below.
   - If the first argument is `list`: go to the **list** command below.
   - If the first argument is `promote`: emit deprecation warning, then go to the **share** command below (treating remaining arguments identically).
   - If the first argument is `list-shared`: emit deprecation warning, then go to the **list** command below appending `--shared` to arguments.
   - If the first argument is `revoke-shared`: emit deprecation warning, then go to the **unshare** command below (treating remaining arguments identically).
   - If the first argument is `correct`: go to the **correct** command below.
   - If the first argument is `export`: go to the **export** command below.
   - If the first argument is `import`: go to the **import** command below.
   - If the first argument is `validate`: go to the **validate** command below.
   - If the first argument is `curate`: go to the **curate** command below.
   - If the first argument is `undo-last`: go to the **undo-last** command below.
   - If the first argument is `undo`: go to the **undo** command below.
   - If the first argument is `explain`: go to the **explain** command below.
   - If the first argument is `clear-tombstones`: go to the **clear-tombstones** command below.
   - If the first argument is `list-tombstones`: go to the **list-tombstones** command below.
   - If an orchestration ID is provided (e.g., `orch-1712345678`): use it directly as `{orch-id}`.
   - If empty: find the most recent orchestration by listing directories in `.orchestray/history/`, sorting by name (which contains a timestamp), and picking the last one. Report: "Using most recent orchestration: {orch-id}"

2. **Validate:** Check that `.orchestray/history/{orch-id}/events.jsonl` exists using the Read tool.
   - If not found: report "No audit trail found for orchestration '{orch-id}'." Then list available orchestrations from `.orchestray/history/` directory. If the directory is empty or missing: "No orchestration history found. Run an orchestration first, then use `/orchestray:learn` to extract patterns."

3. **Read the audit trail:** Read `.orchestray/history/{orch-id}/events.jsonl` line by line. Also read `.orchestray/history/{orch-id}/state/task-graph.md` if it exists (for decomposition context).

4. **Extract patterns** across four categories (plus one correction category) using the same logic as PM Section 22a:

   - **decomposition:** Task breakdown strategies from task-graph.md combined with orchestration outcome. Success with zero re-plans = positive pattern. Re-plans present = examine what changed for potential anti-pattern.
   - **routing:** Look for `routing_outcome` events where the chosen model completed without escalation = routing pattern. Escalation needed = anti-pattern.
   - **specialization:** Look for `dynamic_agent_spawn` + `specialist_saved` events where the agent succeeded = specialization pattern.
   - **anti-pattern:** Look for `replan` events, `verify_fix_fail` events, `escalation` events = what went wrong and why.
   - **user-correction:** Direct user corrections captured during or after orchestration, or via manual `/orchestray:learn correct` command.

   **Skip extraction when:**
   - Orchestration was simple (2-3 tasks, standard architect->developer->reviewer flow with no novel insight), OR
   - An equivalent pattern already exists in `.orchestray/patterns/` with higher confidence (update the existing pattern's Evidence section instead of creating a duplicate).

   **Check for duplicates:** Before writing a new pattern, glob `.orchestray/patterns/*.md` and check if a substantially similar pattern already exists. Update existing rather than duplicate.

5. **Show preview** -- display extracted patterns in a table BEFORE writing any files:

   ```
   | # | Pattern Name | Category | Confidence | Summary |
   |---|-------------|----------|------------|---------|
   | 1 | {name}      | {cat}    | {conf}     | {desc}  |
   ```

   If no patterns identified: "No novel patterns identified from orchestration {orch-id}. The orchestration followed standard patterns already captured or was too straightforward to extract insights from."

   If patterns were identified, proceed to step 6.

6. **Write pattern files:** Create `.orchestray/patterns/` directory if it does not exist. For each pattern, write `.orchestray/patterns/{category}-{name}.md` using this template:

   ```markdown
   ---
   name: {kebab-case-name}
   category: {decomposition|routing|specialization|anti-pattern|user-correction}
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

7. **Run pruning** if pattern count > 50: glob all `.md` files in `.orchestray/patterns/`. If count exceeds 50, compute `score = confidence * times_applied` for each pattern (read frontmatter). Sort ascending. Remove patterns with the lowest scores until count = 50. Report pruned patterns: "Pruned {M} low-value pattern(s): {names}"

8. **Report:** "{N} pattern(s) extracted from orchestration {orch-id}." If patterns were pruned, also report: "Pruned {M} low-value patterns to stay within the 50-pattern cap."

### list [--shared|--all]

List patterns. Default (no flag): lists local patterns only.

**Arguments:**
- `--shared` — list shared-tier patterns from `~/.orchestray/shared/patterns/` only.
- `--all` — list both local and shared patterns; adds a `source` column.

**Steps:**

1. **Determine scope** from flags:
   - No flag or unrecognized flag: local only (`.orchestray/patterns/*.md`).
   - `--shared`: shared only (`~/.orchestray/shared/patterns/*.md`). If the shared dir is absent or `federation.shared_dir_enabled` is false in `.orchestray/config.json`, report: "Can't list shared patterns: federation is not enabled. Enable it with `/orchestray:config set federation.shared_dir_enabled true`."
   - `--all`: both tiers.

2. **Read pattern files**: For each `.md` file in scope, parse frontmatter to extract `name`, `category`, `confidence`, `times_applied`. If frontmatter is missing or unparseable for a file, skip it and note "1 file skipped (invalid frontmatter)".

3. **Display as table**:
   - Local-only or shared-only: `| slug | category | confidence | times_applied |`
   - `--all`: `| slug | category | confidence | times_applied | source |` where source is `local` or `shared`.
   - Sort by `category` then `slug` (alphabetical).
   - If no patterns found: "No patterns found. Run `/orchestray:learn [orchestration-id]` to extract patterns."

**Example (no flag):**
```
/orchestray:learn list
```
```
Local patterns (12):
| slug                          | category      | confidence | times_applied |
|-------------------------------|---------------|------------|---------------|
| anti-pattern-escape-hatches   | anti-pattern  | 0.85       | 3             |
| routing-prefer-haiku          | routing       | 0.72       | 5             |
...
```

**Example (--all):**
```
/orchestray:learn list --all
```
```
All patterns (15 total: 12 local, 3 shared):
| slug                          | category      | confidence | times_applied | source |
|-------------------------------|---------------|------------|---------------|--------|
| anti-pattern-escape-hatches   | anti-pattern  | 0.85       | 3             | local  |
| routing-prefer-haiku          | routing       | 0.72       | 5             | shared |
...
```

---

### share <slug> [--dry-run] [--preview] | share --all [--category <cat>]

Publish a local pattern (or all eligible local patterns) to the shared tier at `~/.orchestray/shared/patterns/`.

**Arguments:**
- `<slug>` — slug of the local pattern to share (e.g., `anti-pattern-escape-hatches`).
- `--dry-run` — run all sanitization stages and report pass/fail without writing. Non-zero exit on any failure. Useful for CI gates and batch pre-checks.
- `--preview` — run all sanitization stages and print a human-readable before/after diff without writing. Always exits zero (sensitivity gate bypassed). Use for interactive "what will leave my project?" checks.
- `--all` — batch mode: share all eligible local patterns.
- `--category <cat>` — with `--all`, limit to patterns in the given category (e.g., `--category decomposition`).
- `--force` — overwrite an existing shared pattern with the same slug without prompting.

**`--dry-run` vs `--preview`:**

| Flag | Exit | Output | Use when |
|------|------|--------|----------|
| `--dry-run` | non-zero on any sanitization failure | pass/fail line only, parseable by scripts | CI gate, batch pre-check with `share --all --dry-run` |
| `--preview` | always zero (sensitivity-gate bypassed) | human-readable before/after diff | Interactive first-time share; "what will leave my project?" check |

**Prerequisites:**
1. `federation.shared_dir_enabled` must be `true` in `.orchestray/config.json`. If not: "Can't share: federation is not enabled. Enable it with `/orchestray:config set federation.shared_dir_enabled true`."
2. `federation.sensitivity` for this project must be `"shareable"`. If not: "Can't share '<slug>': this project's sensitivity is 'private'. To allow sharing from this project: `/orchestray:config set federation.sensitivity shareable`" (Keep it 'private' for NDA work, client projects, or personal data.) **Note: `--preview` bypasses this check** — you can preview at any sensitivity level.

**Single-pattern share steps:**

1. Check `.orchestray/patterns/<slug>.md` exists. If not: "Can't share '<slug>': pattern not found locally. Available patterns: {list from glob .orchestray/patterns/*.md}" 

2. Run the sanitization pipeline (`bin/_lib/shared-promote.js`, passing `{ preview: true }` when `--preview` is set):
   - Stage 3 — secret scan. On failure (default `block` mode): "Can't share '<slug>': potential <kind> on line <N> (<section> section). Remove it before sharing, or suppress with `<!-- secret-scan: allow -->` on the same line." For high-entropy hex: "Can't share '<slug>': high-entropy hex string on line <N> (<section> section) — looks like a key or hash. If it's a known false positive (e.g., a commit SHA), add `<!-- secret-scan: allow -->` on the same line and re-run."
   - Stage 6 — size check. On failure: "Can't share '<slug>': pattern body is {X} KB (limit: 8 KB, overage: {Y} KB). To fix: trim the body (remove project-specific examples), or split into multiple patterns. Note: the Evidence section (if present) is stripped before sharing and does not count against the limit."
   - Other stage failures use the same shape: "Can't share '<slug>': {specific reason}. {recovery action}."
   - If `--dry-run`: print the sanitized pattern diff and any issues found, then stop without writing.

2a. **If `--preview`:** render the `PreviewReport` returned by `promotePattern(slug, { preview: true, cwd })` in this format:

```
Preview of shared-tier output for '<slug>':

Sensitivity gate: <PASS (shareable) | BLOCKED (private) — but preview is read-only and proceeds anyway>

<If blocking_stage is set>
*** WOULD BE BLOCKED BY STAGE: <blocking_stage> ***
    Reason: <blocking_reason>
    Recovery: remove the issue and re-run, or see the reason above.

(No further sanitized output — preview halts at the first blocking stage.)
<End if blocking_stage>

<If no blocking_stage>
Frontmatter changes:
  removed:  <removed fields, comma-separated, or "(none)">
  added:
    origin:         shared
    promoted_at:    <value>
    promoted_from:  <value>

Body changes (<N> lines<, M sections stripped>):
  line <N>:  "<before>"  ->  "<after>"   (<reason>)
  ...
  <if more_changes > 0>... and <more_changes> more (run share --dry-run for full list)

Size after sanitization: <X> KB / 8 KB limit   (<PASS|FAIL>)

Secrets scan: <clean (no matches) | BLOCKED: <note>>

To commit:  /orchestray:learn share <slug>
To abort:   (no action needed — nothing was written)
<End if no blocking_stage>
```

Stop here without writing anything.

3. Check for slug collision in `~/.orchestray/shared/patterns/`:
   - If a same-slug file exists and `--force` is not set: "Can't share '<slug>': a shared pattern with this slug already exists (promoted on {date}). Options: (a) rename your local file and re-share: `mv .orchestray/patterns/<slug>.md .orchestray/patterns/<new-slug>.md` then `/orchestray:learn share <new-slug>`; (b) overwrite the shared copy (your local copy is unchanged): `/orchestray:learn share <slug> --force`."
   - If `--force`: proceed, overwriting.

4. Write the sanitized copy to `~/.orchestray/shared/patterns/<slug>.md`.

5. Report: "Pattern '<slug>' shared to `~/.orchestray/shared/patterns/`. Your local copy in `.orchestray/patterns/<slug>.md` is unchanged."

**Batch mode (`share --all`) steps:**

1. Glob `.orchestray/patterns/*.md`. If `--category <cat>` is set, filter to patterns where frontmatter `category == <cat>`.

2. For each pattern, run single-pattern sanitization silently. Track per-pattern result:
   - `[shareable]` — would succeed.
   - `[already shared]` — slug exists in shared tier (skip unless `--force`).
   - `[skipped: <reason>]` — sanitization failure (e.g., secret detected on line N, size exceeded, etc.).

3. If `--dry-run`: print the summary table below without writing anything. Stop here.

4. Unless `--force` is set, show preview and prompt for confirmation:
   ```
   share --all would share {N} patterns: {comma-separated list of slugs}. Proceed? [y/N]
   ```
   If the user answers anything other than `y` or `yes` (case-insensitive): "Cancelled."

5. Write all `[shareable]` patterns. Print per-pattern status:
   ```
   Sharing {N} patterns to ~/.orchestray/shared/patterns/...
     [shared]  anti-pattern-escape-hatches
     [shared]  routing-prefer-haiku
     [skipped: secret detected on line 34 — run 'share decomposition-large-feature --dry-run' for details]  decomposition-large-feature
     [already shared — use --force to overwrite]  anti-pattern-nested-agents
   Shared {X}, skipped {Y}.
   ```

**Example:**
```
/orchestray:learn share anti-pattern-escape-hatches
/orchestray:learn share anti-pattern-escape-hatches --preview
/orchestray:learn share anti-pattern-escape-hatches --dry-run
/orchestray:learn share --all
/orchestray:learn share --all --category decomposition
/orchestray:learn share --all --dry-run
```

---

### unshare <slug>

Remove a pattern from the shared tier. Your local copy is preserved.

**Arguments:**
- `<slug>` — slug of the shared pattern to remove.
- `--force` — skip the confirmation prompt.

**Steps:**

1. Check `~/.orchestray/shared/patterns/<slug>.md` exists. If not: "Can't unshare '<slug>': pattern not found in shared tier. Run `/orchestray:learn list --shared` to see shared patterns."

2. If `--force` is not set, prompt for confirmation:
   ```
   Unshare '<slug>'? This removes it from ~/.orchestray/shared/patterns/. Your local copy is kept. [y/N]
   ```
   If user answers anything other than `y` or `yes` (case-insensitive): "Cancelled."

3. Note: a `start_run` call is required before writing the tombstone — call `mcp__orchestray__curator_tombstone({ "action": "start_run" })` first and save the returned `run_id`.

4. Delete `~/.orchestray/shared/patterns/<slug>.md`.

5. Call `mcp__orchestray__curator_tombstone` to write a tombstone AFTER the delete
   succeeds (W1 ordering: action first, tombstone second). This makes the `unshare`
   reversible via `undo <action-id>`:
   ```json
   mcp__orchestray__curator_tombstone({
     "action": "write",
     "run_id": "<run_id>",
     "tombstone": "{\"action\": \"unshare\", \"inputs\": [{\"slug\": \"<slug>\", \"path\": \"~/.orchestray/shared/patterns/<slug>.md\", \"content_snapshot\": \"<full file content>\"}], \"output\": {\"path\": \"deleted\", \"action_summary\": \"User unshared <slug>\"}}"
   })
   ```

6. Report: "Unshared '<slug>' — your local copy is still at `.orchestray/patterns/<slug>.md`. Re-run `/orchestray:learn share <slug>` to publish again. To undo: `/orchestray:learn undo-last`."

**Example:**
```
/orchestray:learn unshare anti-pattern-escape-hatches
/orchestray:learn unshare anti-pattern-escape-hatches --force
```

---

### promote <slug> [--dry-run] _(deprecated — use `share`)_

> Warning: 'promote' is deprecated and will be removed in v2.2. Use 'share' instead.

This command is an alias for `share`. All arguments are forwarded to the `share` command unchanged. The deprecation warning is emitted once, then execution proceeds normally.

**What changed:** In v2.0, `promote` copied patterns to `.orchestray/team-patterns/` and deleted the local copy. In v2.1.0, sharing copies patterns to `~/.orchestray/shared/patterns/` and the local copy is preserved. If you relied on the delete-local behavior, manually remove `.orchestray/patterns/<slug>.md` after sharing.

**Example:**
```
/orchestray:learn promote anti-pattern-escape-hatches
# same as: /orchestray:learn share anti-pattern-escape-hatches
# emits: Warning: 'promote' is deprecated and will be removed in v2.2. Use 'share' instead.
```

---

### list-shared _(deprecated — use `list --shared`)_

> Warning: 'list-shared' is deprecated; use 'list --shared' instead. This alias will be removed in v2.2.

This command is an alias for `list --shared`. The deprecation warning is emitted once, then execution proceeds normally as `list --shared`.

**Example:**
```
/orchestray:learn list-shared
# same as: /orchestray:learn list --shared
# emits: Warning: 'list-shared' is deprecated; use 'list --shared' instead. This alias will be removed in v2.2.
```

---

### revoke-shared <slug> _(deprecated — use `unshare`)_

> Warning: 'revoke-shared' is deprecated; use 'unshare' instead. This alias will be removed in v2.2.

This command is an alias for `unshare`. All arguments are forwarded to `unshare` unchanged. The deprecation warning is emitted once, then execution proceeds normally.

**Example:**
```
/orchestray:learn revoke-shared anti-pattern-escape-hatches
# same as: /orchestray:learn unshare anti-pattern-escape-hatches
# emits: Warning: 'revoke-shared' is deprecated; use 'unshare' instead. This alias will be removed in v2.2.
```

### correct [description]

Manually capture a user correction as a pattern.

1. **Parse arguments**: `$ARGUMENTS` after the `correct` keyword.
   - If a description is provided: use it directly as the correction description.
   - If empty: prompt the user: "Describe what the orchestration got wrong and what the correct approach should be."

2. **Find context**: Check for the most recent orchestration:
   - List `.orchestray/history/` directories, pick the most recent as `{orch-id}`
   - If no history exists: use `"manual"` as the `created_from` value

3. **Extract structured fields** from the user's description:
   - `what_was_wrong`: What the system did incorrectly
   - `correct_approach`: What should happen instead
   - `applies_to`: Infer file patterns and task types from the description. If not inferable, ask: "What kinds of tasks should this correction apply to? (e.g., file patterns like `**/*.ts`, task types like `API development`)"

4. **Deduplication**: Check existing patterns per Section 34e rules.

5. **Write pattern file**: Create `.orchestray/patterns/user-correction-{slug}.md` using the Section 34d template. Set `source: manual`.

6. **Confirm**: "Correction pattern saved: `user-correction-{slug}.md` (confidence: 0.8). This will be applied as a warning in future orchestrations that match."

### export [pattern-name|all]

Export one or all patterns for use in another project.

1. **Parse arguments**: The word after `export`.
   - If a specific pattern name is provided (e.g., `export routing-prefer-haiku`): export that single pattern.
   - If `all` or empty: export all patterns.

2. **Single pattern export** (`export <pattern-name>`):
   - Find `.orchestray/patterns/<pattern-name>.md`. If not found, glob `.orchestray/patterns/*.md` and show available patterns: "Pattern '{pattern-name}' not found. Available: {list}"
   - Strip orchestration-specific data: remove `created_from` frontmatter field and replace any orchestration IDs (matching `orch-\d+`) in the Evidence section with `<redacted>`.
   - Print the cleaned file contents to stdout as a fenced markdown block.
   - Display: "Pattern '{pattern-name}' exported above. Copy the content to share it."

3. **Bulk export** (`export all`):
   - Glob `.orchestray/patterns/*.md`. If no patterns found: "No patterns found in `.orchestray/patterns/`. Run an orchestration and use `/orchestray:learn` first."
   - Filter out patterns with `confidence < 0.5` (read frontmatter to check). These are too low-quality to export.
   - Create `.orchestray/exports/` directory if it does not exist.
   - Create a dated export directory: `.orchestray/exports/patterns-export-{YYYY-MM-DD}/`
   - For each included pattern:
     - Read the file.
     - Strip orchestration-specific data: remove `created_from` frontmatter field, replace all `orch-\d+` references in the Evidence section with `<redacted>`.
     - Write the cleaned copy to `.orchestray/exports/patterns-export-{YYYY-MM-DD}/{filename}`.
   - Display: "Exported {N} patterns to `.orchestray/exports/patterns-export-{YYYY-MM-DD}/` ({M} skipped with confidence < 0.5)"

### import <path>

Import patterns from a file or directory exported by another project.

1. **Parse arguments**: The word after `import` is the path to import from.
   - If no path provided: "Usage: `/orchestray:learn import <path>` — path to a pattern .md file or an exported patterns directory."

2. **Resolve source**:
   - If path points to a single `.md` file: treat as a list of one file.
   - If path points to a directory: glob `{path}/*.md` to get all pattern files.
   - If neither exists: "Path '{path}' not found. Provide a path to a pattern .md file or a patterns-export directory."

3. **For each pattern file**:
   a. **Validate frontmatter**: Read the file. Parse YAML frontmatter. Required fields: `name` (string), `category` (one of: decomposition, routing, specialization, anti-pattern, user-correction), `confidence` (number 0.0–1.0). If any required field is missing or invalid: skip and add to skipped list with reason.
   b. **Check for name conflict**: Check if `.orchestray/patterns/{category}-{name}.md` already exists.
      - If no conflict: proceed to copy.
      - If conflict: read both files and display a summary comparison:
        ```
        Conflict: pattern '{name}' already exists.
        Existing: confidence={X}, times_applied={N}, created_from={id}
        Incoming: confidence={X}, times_applied={M}
        Keep which? (existing / incoming / skip)
        ```
        Wait for user response. If "existing": skip. If "incoming": overwrite. If "skip": skip.
   c. **Write the imported pattern**: Copy to `.orchestray/patterns/{category}-{name}.md` with these modifications:
      - Add `imported: true` to frontmatter.
      - Reset `times_applied: 0` (the pattern hasn't been tested in this project).
      - Reset `last_applied: null`.
      - Preserve all other fields including `confidence`.

4. **Create `.orchestray/patterns/` directory** if it does not exist before writing.

5. **Report**: "Imported {N} patterns ({M} skipped — {breakdown of skip reasons})."
   - Example: "Imported 4 patterns (2 skipped — 1 invalid schema, 1 conflict kept existing)."

### validate

Manually trigger validation of all pending outcome probes.

1. **Check config**: Read `.orchestray/config.json`. If `enable_outcome_tracking` is false
   or missing, report: "Outcome tracking is disabled. Enable it with
   `/orchestray:config set enable_outcome_tracking true`." Stop here.

2. **Find pending probes**: Glob `.orchestray/probes/probe-*.md`. Read frontmatter of each.
   Filter for `status: pending`.
   - If no pending probes found: "No pending outcome probes found. Probes are created
     automatically after orchestrations when `enable_outcome_tracking` is enabled."
     Stop here.

3. **Validate each pending probe**: For each probe, run the validation protocol from
   Section 41b (in outcome-tracking.md), but WITHOUT the file-overlap filter — validate
   ALL pending probes regardless of whether the current prompt references their files.

4. **Display results** in a table:

   ```
   | Probe | Created | Files | Outcome | Details |
   |-------|---------|-------|---------|---------|
   | probe-orch-XXX | 2026-04-07 | 3 files | positive | All checks pass |
   | probe-orch-YYY | 2026-04-05 | 2 files | negative | Auth tests failing |
   ```

5. **Apply outcome-to-pattern feedback**: Per Section 41c (in outcome-tracking.md), update
   pattern confidence based on validation outcomes. Positive: +0.15 (cap 1.0). Negative:
   -0.3 (floor 0.0) + extract anti-pattern. Neutral: no change.

6. **Report summary**: "Validated {N} probes: {P} positive, {Q} negative, {R} neutral.
   Pattern confidence updated for {M} patterns."

---

## Curator (v2.1.0)

The curator is an Orchestray specialist agent that maintains pattern-corpus hygiene. It
is **invoked manually only** — there is no scheduler and no automatic trigger. Default
mode is auto-apply with tombstone + rollback: decisions take effect immediately and are
reversible via `undo-last` or `undo <action-id>`.

**Subcommand grouping reference:**

| Group | Subcommands |
|-------|-------------|
| Curation | `curate [--dry-run] [--only ...]`, `curate --apply <proposals-file>` |
| Sharing | `share`, `unshare`, `list` (see B2 sections above) |
| Recovery | `undo-last`, `undo <action-id>`, `explain <action-id>` |
| Maintenance | `clear-tombstones` |

---

### curate [--dry-run] [--only promote|merge|deprecate]

Run the curator agent against the local pattern corpus (and the shared tier if
federation is enabled).

**Arguments:**
- _(no flags)_ — auto-apply all approved actions; print summary.
- `--dry-run` — analyze only; write proposals to `.orchestray/curator/proposals-<ISO>.md`
  without applying. Follow up with `curate --apply <proposals-file>` to commit.
- `--apply <proposals-file>` — apply a previously-written proposals file. Re-hashes
  current pattern content and skips any action whose input pattern has changed since
  proposal generation (uses `content_sha256` from the proposals file for staleness check).
- `--only promote` — restrict this run to promote actions only.
- `--only merge` — restrict this run to merge actions only.
- `--only deprecate` — restrict this run to deprecate actions only.
- `--only <a>,<b>` — restrict to multiple action types (comma-separated).

**Prerequisites:**
- `curator.enabled` must be `true` in `.orchestray/config.json` (default: true).
- To check: `/orchestray:config show curator`.

**Steps:**

1. **Check config gate:** Read `.orchestray/config.json`. If `curator.enabled` is
   `false`: report "Curator is disabled. Enable with `/orchestray:config set curator.enabled true`." Stop.

2. **Check corpus:** Glob `.orchestray/patterns/*.md`. If none found: report
   "No patterns to curate. Run `/orchestray:learn [orchestration-id]` to extract patterns first."
   Stop.

3. **Start a tombstone run:** Call `mcp__orchestray__curator_tombstone({ "action": "start_run" })` to
   archive any prior tombstone run beyond the retention window and obtain a `run_id`.

3b. **H3 pre-filter (v2.1.3):** Before spawning the curator agent, run the MinHash
    duplicate pre-filter to build a similarity shortlist:

    ```javascript
    const { buildShortlistForDispatch, writeFallbackShortlist } = require('./bin/_lib/curator-duplicate-detect.js');
    const { recordDegradation } = require('./bin/_lib/degraded-journal.js');
    const shortlistPath = `.orchestray/curator/similarity-${runId}.json`;
    const patternsDir   = `.orchestray/patterns`;
    try {
      buildShortlistForDispatch({ patternsDir, outputPath: shortlistPath, runId });
    } catch (err) {
      writeFallbackShortlist(shortlistPath, runId);
      recordDegradation({
        kind:   'curator_duplicate_detect_failed',
        detail: { error: String(err && err.message), run_id: runId },
      });
    }
    ```

    Pass `shortlistPath` into the curator agent's context so it knows which file
    to read (see `agents/curator.md` §4.2). If the pre-filter fails, the fallback
    writes an empty shortlist with `"method": "fallback-all-pairs"` and the
    curator proceeds with legacy all-pairs clustering — no curate run is blocked.

4. **Spawn the curator agent** using the `Agent()` mechanism (same as other slash
   commands). Pass the following context to the curator agent's system prompt:
   - `runId` (from step 3)
   - `--dry-run` flag (if set)
   - `--only` constraint (if set)
   - Project root path
   - Path to active tombstones file

   The curator agent's decision logic (promote / merge / deprecate criteria, safety
   invariants, adversarial re-read for merges, federation-absent graceful degradation,
   etc.) lives entirely in `agents/curator.md`. This CLI layer does NOT implement
   curation logic; it provides infrastructure and dispatches to the agent.

4b. **Post-run reconciliation** (W1 atomicity fix — skip for dry-run): after the
    curator agent returns, call `require('./bin/_lib/curator-reconcile').reconcile({ projectRoot })` (Node.js).
    This detects tombstones whose file operations were not applied (truncated agent turn)
    and auto-repairs promote and unshare mismatches. Merge and deprecate mismatches are
    flagged for user review. If any items were repaired or flagged, append to the summary:
    ```
    Reconciliation: repaired N, flagged M.
      [REPAIRED] <slug> — <detail>
      [FLAGGED]  <slug> — <detail>  (manual action required)
    ```
    If reconciliation itself errors, surface: "Warning: post-run reconciliation failed:
    <error>. Run `/orchestray:learn list-tombstones` and verify actions manually."

4c. **H4 stamp-apply** (skip for dry-run): after reconciliation, run:
    ```
    node bin/curator-apply-stamps.js <runId> [projectRoot]
    ```
    This applies `recently_curated_*` frontmatter stamps to patterns touched by the run.
    Failures are non-fatal and journaled to `.orchestray/state/degraded.jsonl`.
    Include in the final report: "Stamps: N applied, M skipped, K failed."

5. **Print summary** from the curator agent's structured result. Required format:
   ```
   Curator run complete (run_id: <run_id>):
     [PROMOTE]   <slug>   -> shared tier    (action_id: <action_id>)
     [MERGE]     <slug-a> + <slug-b> -> <merged-slug>   (action_id: <action_id>)
     [DEPRECATE] <slug>   (low-value: score N)   (action_id: <action_id>)
     [SKIP]      <slug>   (<reason>)

   Summary: promoted N, merged M into 1 (now 1 pattern), deprecated K.
   To undo this entire run: /orchestray:learn undo-last
   To undo a single action: /orchestray:learn undo <action-id>  (IDs shown above)
   Older runs reversible via 'undo': <prior run_ids if any>
   ```
   If all counts are zero: "Curator run complete: no actions taken."
   If federation absent: "[PROMOTE] SKIPPED: federation not configured. Re-run after: `/orchestray:config set federation.shared_dir_enabled true`"

**Error surfaces:**
- **Empty state:** "No patterns to curate." (see step 2).
- **Sanitization gate blocked a promote:** "[PROMOTE] SKIPPED for <slug>: potential
  secret detected on line N — run `/orchestray:learn share <slug> --dry-run` for details.
  Which pattern and why it was blocked are logged to `.orchestray/curator/proposals-<runId>.md`."
- **User-correction sacred rule violation (deprecate attempt):** Silently skipped;
  logged in the run summary as "[SKIP] <slug> — user-correction patterns are never
  auto-deprecated."

**Example:**
```
/orchestray:learn curate
/orchestray:learn curate --dry-run
/orchestray:learn curate --only merge
/orchestray:learn curate --only promote,deprecate
/orchestray:learn curate --apply .orchestray/curator/proposals-2026-04-17T143500Z.md
```

**Example output (auto-apply, success):**
```
Curator run complete (run_id: curator-20260417T153000Z):
  [PROMOTE]   anti-pattern-ledger-writer-reader-trace   -> shared tier    (action_id: curator-20260417T153000Z-a001)
  [MERGE]     decomposition-ci-cd + decomposition-pipeline -> decomposition-ci-cd    (action_id: curator-20260417T153000Z-a002)
              (confidence 0.80 [weighted-mean * 0.95], inherits 7 applications)
  [DEPRECATE] routing-prefer-opus-for-architecture       (low-value: score 1.8)    (action_id: curator-20260417T153000Z-a003)
  [DEPRECATE] anti-pattern-find-replace-artifacts        (low-value: score 1.5)    (action_id: curator-20260417T153000Z-a004)
  [SKIP]      anti-pattern-half-shipped-enum             (sanitization block: line 34 matches key pattern)

Summary: promoted 1, merged 2 into 1 (now 1 pattern), deprecated 2.
To undo this entire run: /orchestray:learn undo-last
To undo a single action: /orchestray:learn undo <action-id>  (IDs shown above)
Older runs reversible via 'undo': curator-20260416T110000Z, curator-20260415T094500Z
```

**Example output (dry-run):**
```
Curator dry-run complete. Proposals written to .orchestray/curator/proposals-2026-04-17T153000Z.md
To apply: /orchestray:learn curate --apply .orchestray/curator/proposals-2026-04-17T153000Z.md
```

---

### undo-last

Reverse all actions from the most-recent curator run. This includes actions of ALL types:
promote, merge, deprecate, and unshare. Tombstone rows are NOT deleted — rollback history
is preserved for audit purposes.

Reads the active tombstones at `.orchestray/curator/tombstones.jsonl`, finds the
most-recent run (by `orch_id`), restores every affected pattern file from its
`content_snapshot`, and marks each tombstone row as `rolled_back_by: "undo-last"`.

**Steps:**

1. Read `.orchestray/curator/tombstones.jsonl`. If absent or empty: report
   "No curator runs in undo window. Nothing to revert."

2. Find the most-recent `orch_id` (lexicographically highest — timestamp format
   ensures correct ordering).

3. For each tombstone row belonging to that `orch_id`, in reverse order:
   - Restore `content_snapshot` to the pattern file at `inputs[].path` (atomic write).
   - Mark row `rolled_back_at: <now>`, `rolled_back_by: "undo-last"`.

4. Rewrite `tombstones.jsonl` with the updated rows (atomic write).

5. Report: "Reverted {N} actions from run {run-id}. Cleared `recently_curated`
   stamps from {M} files." (M = total count of `inputs[]` entries across all
   rolled-back rows; the stamp strip is handled automatically by `applyRollback()`
   inside the tombstone library — no extra step needed here.)

**Example:**
```
/orchestray:learn undo-last
```
```
Reverted 4 actions from run curator-20260417T153000Z.
```

---

### undo <action-id>

Reverse a single curator action by its action ID.

Works across the last N runs' tombstones (where N = `curator.tombstone_retention_runs`,
default 3). Searches the active `tombstones.jsonl` first, then archive files in
`.orchestray/curator/tombstones-archive/`. If found, restores the pattern file from
the `content_snapshot` and marks the tombstone as rolled back. Does NOT delete the
tombstone row.

**Arguments:**
- `<action-id>` — the action ID to reverse (format: `curator-<ISO>-a<NNN>`, e.g.,
  `curator-20260417T153000Z-a002`). Action IDs appear in the `curate` run summary output
  on each action line. To list all reversible actions from recent runs:
  `/orchestray:learn list-tombstones`.

**Steps:**

1. Parse `<action-id>` from `$ARGUMENTS` (word after `undo`). If absent or blank:
   report "Usage: `/orchestray:learn undo <action-id>`." Stop.

2. Search active tombstones then archives (most-recent archive first).
   If not found in any of the last N runs: report "Action '{action-id}' not found in
   the last {N} curator runs. Check `.orchestray/curator/tombstones-archive/` for
   older runs (manual recovery required)."

3. Restore `content_snapshot` for all `inputs[]` entries of the matching tombstone
   (atomic write per file). If the action was already rolled back (`rolled_back_at`
   is set), still apply the restore and update the timestamp (idempotent rollback).

4. Mark the tombstone row `rolled_back_at: <now>`, `rolled_back_by: "undo"`.

5. Report: "Reverted action {action-id} ({action-type} of {slug})."
   If the tombstone has a `rationale` field, append one line:
   "This action's rationale: {rationale.one_line} (run `/orchestray:learn explain <action-id>` for full detail)."

**Example:**
```
/orchestray:learn undo curator-20260417T153000Z-a002
```
```
Reverted action curator-20260417T153000Z-a002 (deprecate of routing-prefer-opus-for-architecture).
This action's rationale: Deprecated — 67d unused + 3 contextual-mismatch skips, score 2.3 > 2.0 floor. (run `/orchestray:learn explain curator-20260417T153000Z-a002` for full detail)
```

---

### explain <action-id>

Show the full structured rationale for a curator action.

**Arguments:**
- `<action-id>` — the action ID to explain (e.g., `curator-20260417T153000Z-a003`).
  To list available action IDs: `/orchestray:learn list-tombstones`.

**Steps:**

1. Parse `<action-id>` from `$ARGUMENTS` (word after `explain`). If absent or blank:
   report `Usage: /orchestray:learn explain <action-id>. To list action IDs: /orchestray:learn list-tombstones.`
   Stop.

2. Call `mcp__orchestray__curator_tombstone({ "action": "list" })`. Search the returned
   `rows` for the row where `action_id === <action-id>`. If not found:
   report `Action '<action-id>' not found in the last N curator runs (N = curator.tombstone_retention_runs).
Archives older than the retention window are pruned; see .orchestray/curator/tombstones-archive/ for any manually-preserved files.`
   Stop.

3. If `row.rationale` is present (v2.1.2+ tombstone): render the full structured output:
   ```
   Action: {action_id}
   Type:   {action}
   Status: {if rolled_back_at: "rolled back at <rolled_back_at> by <rolled_back_by>" else "applied (not rolled back)"}
   When:   {ts}
   Pattern: {inputs[0].slug}

   Summary:
     {rationale.one_line}

   Signals:
     confidence            {rationale.signals.confidence}
     decayed_confidence    {rationale.signals.decayed_confidence}
     times_applied         {rationale.signals.times_applied}
     age_days              {rationale.signals.age_days}
     category              {rationale.signals.category}
     {if rationale.signals.deprecation_score != null: "deprecation_score     {rationale.signals.deprecation_score}"}
     {if rationale.signals.skip_penalty != null: "skip_penalty          {rationale.signals.skip_penalty}"}
     {if rationale.signals.similarity_score != null: "similarity_score      {rationale.signals.similarity_score}"}

   Guardrails checked:
     {for each entry in rationale.guardrails_checked: "  - {entry}"}
     {if empty: "  (none recorded)"}

   Considered alternatives:
     {for each entry in rationale.considered_alternatives: "  - {entry}"}
     {if empty: "  (none)"}

   Adversarial re-read: {if rationale.adversarial_re_read: "passed={passed}, missing={missing}, contradicted={contradicted}" else "n/a ({action} action)"}

   Notes:
     {rationale.notes or "(none)"}

   ---
   To reverse: /orchestray:learn undo {action_id}
   ```

4. If `row.rationale` is absent (pre-v2.1.2 tombstone): render the fallback output:
   ```
   Action: {action_id}
   Type:   {action}
   Status: {if rolled_back_at: "rolled back at <rolled_back_at> by <rolled_back_by>" else "applied (not rolled back)"}
   When:   {ts}
   Pattern: {inputs[0].slug}

   Summary (from action_summary):
     {output.action_summary}

   No structured rationale available — this action was recorded before v2.1.2.
   For future actions, rationale will include signals, considered alternatives,
   and guardrail checks.

   ---
   To reverse: /orchestray:learn undo {action_id}
   ```

5. If `row.rolled_back_at` is set, the Status line already shows the rolled-back info
   (rendered in steps 3 or 4 above). No additional step required.

**Error cases:**

| Input | Output |
|-------|--------|
| `explain` with no arg | `Usage: /orchestray:learn explain <action-id>. To list action IDs: /orchestray:learn list-tombstones.` |
| `explain <id>` where id not found | `Action '<id>' not found in the last N curator runs (N = curator.tombstone_retention_runs). Archives older than the retention window are pruned; see .orchestray/curator/tombstones-archive/ for any manually-preserved files.` |

**Example (full rationale):**
```
/orchestray:learn explain curator-20260417T153000Z-a003
```
```
Action: curator-20260417T153000Z-a003
Type:   deprecate
Status: applied (not rolled back)
When:   2026-04-17T15:30:04.231Z
Pattern: routing-prefer-opus-for-architecture

Summary:
  Deprecated — 67d unused + 3 contextual-mismatch skips, score 2.3 > 2.0 floor.

Signals:
  confidence            0.90
  decayed_confidence    0.42
  times_applied         0
  age_days              67
  category              routing
  deprecation_score     2.30
  skip_penalty          6.00

Guardrails checked:
  - G1-user-correction-exempt (n/a, category is routing)
  - G13-min-3-per-category (routing retained 5 patterns after action)

Considered alternatives:
  - Merge with routing-prefer-haiku (rejected: approach contradicts on model tier)

Adversarial re-read: n/a (deprecate action)

Notes:
  LLM-generated rationale, not a formal proof.

---
To reverse: /orchestray:learn undo curator-20260417T153000Z-a003
```

**Example (fallback — old tombstone):**
```
/orchestray:learn explain curator-20260410T080000Z-a001
```
```
Action: curator-20260410T080000Z-a001
Type:   promote
Status: applied (not rolled back)
When:   2026-04-10T08:00:12.415Z
Pattern: anti-pattern-escape-hatches

Summary (from action_summary):
  Promoted to shared tier.

No structured rationale available — this action was recorded before v2.1.2.
For future actions, rationale will include signals, considered alternatives,
and guardrail checks.

---
To reverse: /orchestray:learn undo curator-20260410T080000Z-a001
```

---

### clear-tombstones

Remove all current tombstones (active file + all archives).

This is a hard reset of the rollback history. After clearing, `undo-last` and
`undo <action-id>` will report nothing to revert. Use this after you have reviewed
and confirmed a curator run and want to free up the tombstone tracking.

**Steps:**

1. Prompt for confirmation:
   ```
   Clear all tombstone history? This removes .orchestray/curator/tombstones.jsonl
   and all files in .orchestray/curator/tombstones-archive/. Existing curator actions
   cannot be undone after clearing. [y/N]
   ```
   If the user answers anything other than `y` or `yes` (case-insensitive): "Cancelled."

2. Delete `.orchestray/curator/tombstones.jsonl` (if it exists).

3. Delete all files in `.orchestray/curator/tombstones-archive/` (if the directory exists).

4. Report: "Tombstone history cleared. {N} file(s) removed."

**Example:**
```
/orchestray:learn clear-tombstones
```
```
Clear all tombstone history? ... [y/N] y
Tombstone history cleared. 4 file(s) removed.
```

---

### list-tombstones

List active tombstones with action IDs, for use with `undo <action-id>`.

**Steps:**

1. Call `mcp__orchestray__curator_tombstone({ "action": "list" })`. If the tool returns an
   empty result or the file does not exist: report "No tombstones found. Nothing to undo."

2. Display tombstones grouped by run, most recent first:
   ```
   Active tombstones (last 3 runs):

   Run: curator-20260417T153000Z  (3 actions)
     curator-20260417T153000Z-a001  promote    anti-pattern-ledger-writer-reader-trace
     curator-20260417T153000Z-a002  merge      decomposition-ci-cd + decomposition-pipeline
     curator-20260417T153000Z-a003  deprecate  routing-prefer-opus-for-architecture

   Run: curator-20260416T110000Z  (2 actions)
     curator-20260416T110000Z-a001  promote    routing-prefer-haiku
     curator-20260416T110000Z-a002  deprecate  anti-pattern-find-replace-artifacts

   To undo a single action: /orchestray:learn undo <action-id>
   To undo the most recent run: /orchestray:learn undo-last
   ```

3. Mark any tombstone where `rolled_back_at` is set with `[reverted]` to indicate
   it has already been rolled back.

**Example:**
```
/orchestray:learn list-tombstones
```
