<!-- PM Reference: Loaded when enable_drift_sentinel is true -->

# Drift Sentinel: Architectural Invariant Enforcement

Detects when orchestration changes violate architectural invariants. Uses three invariant
sources that work from day one without any pre-populated decision registry.

---

## Invariant Sources

### Source 1: Architect Output (Auto-Extraction)

After an architect agent completes, scan its output for constraint-like statements.
Constraint indicators (case-insensitive):
- "must not", "should not", "never", "always"
- "X should not depend on Y", "all Z must go through W"
- "this module exposes only its public API"
- "no direct imports from internal/"
- "keep X isolated from Y"

**Extraction protocol:**

1. Parse the architect's full text output for sentences containing constraint indicators.
2. For each candidate constraint, extract:
   - `invariant`: The constraint text (one sentence, imperative form)
   - `files_affected`: Glob patterns inferred from the constraint context (e.g.,
     `["src/auth/**"]` if the constraint mentions the auth module)
   - `confidence`: 0.8 for explicit "must"/"never" statements, 0.6 for "should" statements
3. Present candidates to the user for confirmation:
   ```
   Extracted architectural invariants from architect output:
     [1] "No file outside src/auth/ imports from src/auth/internal/" (confidence: 0.8)
     [2] "All database queries must go through the repository layer" (confidence: 0.8)
   Confirm these as enforced invariants? (y/n/edit)
   ```
Invariant expiry: Auto-extracted invariants expire after 10 orchestrations or
30 days (whichever comes first) and must be re-confirmed. Add `expires_after_orchestrations: 10`
and `created_at: <ISO timestamp>` to each invariant's metadata.

Individual confirmation: Present each auto-extracted invariant individually to
the user (not as a batch) to increase scrutiny. Flag invariants that contain
negation patterns targeting security processes (e.g., "never...security",
"must not...review") with a warning label.

4. On confirmation, write each invariant to `.orchestray/kb/decisions/` using the
   decision format:
   ```markdown
   ---
   id: decision-{slug}
   type: architectural-constraint
   enforced: true
   source: architect-extraction
   files_affected: ["src/auth/**"]
   invariant: "No file outside src/auth/ imports from src/auth/internal/"
   created_at: "<ISO 8601>"
   confidence: 0.8
   ---
   ```
5. Log an `invariant_extracted` event to `.orchestray/audit/events.jsonl`
   (see event-schemas.md for the schema).

### Source 2: Static Rules (Built-in)

Conservative rules that apply to any project. Zero false positives is more important
than catching everything. Each rule can be disabled by the user.

| Rule ID | Invariant | Check Method |
|---------|-----------|-------------|
| `no-new-deps` | No new production dependencies added without explicit intent | Compare dependency manifest before/after via git diff. Check: `package.json` (dependencies, devDependencies), `requirements.txt`, `go.mod` (require block), `Cargo.toml` ([dependencies]) |
| `no-removed-exports` | Public API exports not removed without deprecation | Grep modified files for removed `export` statements in git diff (lines starting with `-export`) |
| `test-coverage-parity` | New source files in directories with existing tests should have test files | For each new file in git diff, check if sibling `*.test.*` or `*.spec.*` files exist in the same directory. If the directory already has test files but the new file does not, flag it |

**Static rule check protocol:**

1. Run `git diff --name-only` to get changed files.
2. Run `git diff` to get the full diff content.
3. For `no-new-deps`: Search the diff for added lines (`+`) in dependency manifest files.
   Match patterns like `+"dependency-name": "version"` in package.json, new lines in
   requirements.txt, new `require` entries in go.mod, new entries under `[dependencies]`
   in Cargo.toml. If found, flag as a warning (not error — dependencies may be intentional).
4. For `no-removed-exports`: Search the diff for removed lines starting with
   `-export ` or `-module.exports` in non-test files. If found, flag as a warning.
5. For `test-coverage-parity`: For each file in the diff with status "A" (added), check
   if the parent directory contains any `*.test.*` or `*.spec.*` files. If yes and the
   new file has no corresponding test file, flag as a warning.

### Source 3: Session Invariants (Same-Orchestration)

Decisions written to `.orchestray/kb/decisions/` EARLIER in the current orchestration
are checked against changes made LATER. This provides immediate value within a single
multi-step orchestration.

**Protocol:** Before each subsequent agent delegation, read `decisions/` entries where
`enforced: true` and `created_at` is within the current orchestration timeframe. Check
the task's `files_write` against each decision's `files_affected` patterns. If there is
overlap, inject the invariant as a constraint in the delegation prompt.

---

## Pre-Execution Check

Run AFTER task decomposition and BEFORE execution begins (alongside Section 39 Phase A).

1. **Load invariants**: Read all entries in `.orchestray/kb/decisions/` where
   `enforced: true` and `type: architectural-constraint`.
2. **Load static rules**: Apply the 3 built-in rules (unless individually disabled).
3. **Match against task graph**: For each invariant, check if any task's `files_write`
   overlaps with the invariant's `files_affected` patterns.
4. **Inject constraints**: For matched invariants, append constraint text to the
   delegation prompt of the relevant agent (see delegation-templates.md for format).
5. **Display**: Show pre-execution invariant summary:
   ```
   Drift sentinel: N invariants loaded (N extracted, N static, N session)
   ```

## Post-Execution Check

Run AFTER all agents complete, triggered from Section 15 step 7.6.

1. **Get actual changes**: Run `git diff` to get the full diff of all changes. Always
   exclude paths matching `.orchestray/**` from drift analysis — these are runtime state
   written by PM protocols (threads, probes, personas, patterns, KB entries), not project
   code, and should never count as architectural drift.
2. **Check extracted invariants**: For each enforced decision, verify the invariant
   was not violated by the changes. Use the `files_affected` patterns to scope the check,
   then grep the diff for violation patterns.
3. **Check static rules**: Run each static rule against the diff (per protocol above).
4. **Check session invariants**: Same as extracted invariants but scoped to decisions
   created during this orchestration.
5. **Log event**: Append a `drift_check` event to `.orchestray/audit/events.jsonl`
   (see event-schemas.md for the schema).

## Violation Surfacing

When a drift violation is detected, surface it to the user with this format:

```
Architectural drift detected:

Decision: {decision title} (from {source}, {orchestration id})
Invariant: "{invariant text}"
Violation: {violating_file} — {description of the violation}
  {evidence line from diff}

Options:
  [1] Fix now — spawn developer to address the violation
  [2] Update decision — this change is intentional, update the invariant
  [3] Acknowledge — note the drift but take no action now
```

**Severity classification:**
- `error`: Explicit "must not" / "never" invariants violated. Block completion until
  user chooses an option.
- `warning`: "should" invariants or static rule violations. Surface but do not block.

**User response handling:**
- `[1] Fix now`: Spawn a developer agent with the invariant and violation as context.
  After fix, re-run the post-execution check for that specific invariant.
- `[2] Update decision`: Set `enforced: false` on the decision entry. Log the update.
- `[3] Acknowledge`: Log the acknowledgment in the audit trail. Proceed without changes.
