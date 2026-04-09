---
name: learn
description: Extract learning patterns from a completed orchestration
disable-model-invocation: true
argument-hint: "[orchestration-id] | promote <pattern-name> | correct [description] | export [pattern-name|all] | import <path>"
---

# Pattern Extraction

The user wants to extract reusable patterns from a completed orchestration.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If the first argument is `promote`: go to the **promote** command below.
   - If the first argument is `correct`: go to the **correct** command below.
   - If the first argument is `export`: go to the **export** command below.
   - If the first argument is `import`: go to the **import** command below.
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

### promote <pattern-name>
- Promote a local pattern to team-shared:
  1. Check `.orchestray/patterns/<pattern-name>.md` exists. If not, show available local patterns.
  2. Create `.orchestray/team-patterns/` directory if it doesn't exist.
  3. Copy the pattern file from `.orchestray/patterns/<pattern-name>.md` to `.orchestray/team-patterns/<pattern-name>.md`
  4. Delete the local copy to avoid duplication
  5. Report: "Pattern '<pattern-name>' promoted to team-patterns/. It will be available to all team members after they pull."
- If the pattern already exists in `.orchestray/team-patterns/`: ask user whether to overwrite

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
