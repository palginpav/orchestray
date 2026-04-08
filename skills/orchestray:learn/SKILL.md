---
name: learn
description: Extract learning patterns from a completed orchestration
disable-model-invocation: true
argument-hint: "[orchestration-id] | promote <pattern-name>"
---

# Pattern Extraction

The user wants to extract reusable patterns from a completed orchestration.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If the first argument is `promote`: go to the **promote** command below.
   - If an orchestration ID is provided (e.g., `orch-1712345678`): use it directly as `{orch-id}`.
   - If empty: find the most recent orchestration by listing directories in `.orchestray/history/`, sorting by name (which contains a timestamp), and picking the last one. Report: "Using most recent orchestration: {orch-id}"

2. **Validate:** Check that `.orchestray/history/{orch-id}/events.jsonl` exists using the Read tool.
   - If not found: report "No audit trail found for orchestration '{orch-id}'." Then list available orchestrations from `.orchestray/history/` directory. If the directory is empty or missing: "No orchestration history found. Run an orchestration first, then use `/orchestray:learn` to extract patterns."

3. **Read the audit trail:** Read `.orchestray/history/{orch-id}/events.jsonl` line by line. Also read `.orchestray/history/{orch-id}/state/task-graph.md` if it exists (for decomposition context).

4. **Extract patterns** across four categories using the same logic as PM Section 22a:

   - **decomposition:** Task breakdown strategies from task-graph.md combined with orchestration outcome. Success with zero re-plans = positive pattern. Re-plans present = examine what changed for potential anti-pattern.
   - **routing:** Look for `routing_outcome` events where the chosen model completed without escalation = routing pattern. Escalation needed = anti-pattern.
   - **specialization:** Look for `dynamic_agent_spawn` + `specialist_saved` events where the agent succeeded = specialization pattern.
   - **anti-pattern:** Look for `replan` events, `verify_fix_fail` events, `escalation` events = what went wrong and why.

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
