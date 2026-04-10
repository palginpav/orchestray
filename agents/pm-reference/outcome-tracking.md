# Section 41: Outcome Tracking

Deferred quality validation — probes are created after orchestration and lazily validated
when the user returns to relevant files in a future session.

---

## 41a. Probe Creation (Post-Orchestration)

**Integration point:** Section 15 step 3, after thread creation (step 7.1) and BEFORE
persona refresh check (step 7.3). Triggered as step 7.2.

**Trigger condition:** `enable_outcome_tracking` is true.

Protocol:

1. **Aggregate files_changed** from all agent results in this orchestration.

2. **Identify test files added**: Filter `files_changed` for paths matching
   `*.test.*`, `*.spec.*`, `test_*`, or `*_test.*`. These are `tests_added`.

3. **Determine patterns applied**: Read the list of patterns applied during Section 22b
   from the confidence feedback tracking in Section 22c. These are `patterns_applied`.

4. **Generate success conditions** (up to 3 condition types):
   - `files_unchanged`: For each non-test file delivered (core deliverables), one condition
     per file, cap at 5 total. Checks that the file is not reverted or heavily modified.
   - `tests_pass`: If tests were added AND the project has a known test command (from
     pre-approved command table), include one condition with a `command_index` referencing
     the test command (index 1-6 from the pre-approved table in Section 15). Only include
     if a known test command exists.
   - `git_log_clean`: For core deliverables, checks for revert commits. One condition per
     file, cap at 3 total.

5. **Write probe file** to `.orchestray/probes/probe-{orch-id}.md`. Before writing,
   ensure the parent directory exists — the Write tool auto-creates parent directories,
   but if writing via Bash run `mkdir -p .orchestray/probes` first.

   ```markdown
   ---
   id: probe-{orch-id}
   orchestration_id: {orch-id}
   created_at: "{ISO 8601}"
   files_delivered: ["{path1}", "{path2}"]
   tests_added: ["{test-path1}"]
   patterns_applied: ["{pattern-name1}", "{pattern-name2}"]
   success_conditions:
     - type: files_unchanged
       paths: ["{path1}", "{path2}"]
       description: "Core files not reverted or heavily modified"
     - type: tests_pass
       command_index: 1
       description: "Tests still pass"
     - type: git_log_clean
       paths: ["{path1}"]
       description: "No revert commits touching delivered files"
   status: pending
   checked_at: null
   outcome: null
   outcome_details: null
   ---
   ```

6. **Run probe lifecycle** per Section 41d (cap and expiry check).

7. **Log `probe_created` event** to `.orchestray/audit/events.jsonl`.

---

## 41b. Probe Validation (Session Start — Lazy Evaluation)

**Integration point:** Section 0 Silent Pre-Check, step 0.5. Runs on EVERY session start
AFTER the auto-trigger marker check (step 0) and BEFORE complexity scoring (step 2). This
runs on EVERY session, not just orchestrations.

**Trigger condition:** `enable_outcome_tracking` is true.

Protocol:

1. **Check directory**: If `.orchestray/probes/` does not exist, skip.

2. **Find pending probes**: Glob `.orchestray/probes/probe-*.md`. Read frontmatter of each.
   Filter for `status: pending`.

3. **File-overlap filter** (lazy evaluation):
   For each pending probe, read `files_delivered` from frontmatter. Compare against the
   current user prompt — does the prompt reference or involve any of the delivered files?
   Use keyword matching against file names and directory names. If NO overlap: skip this
   probe and move on. Only validate probes when the user returns to relevant code.

4. **For each probe with file overlap**, run validation checks:
   - **Path validation (security):** Before constructing ANY git command, validate each
     path from `files_delivered` and `success_conditions[].paths` against the regex
     `^[a-zA-Z0-9_./-]+$`. Additionally, reject any path that contains `..` as a path
     component (matches `(^|/)\.\.(/|$)`). Paths failing either check MUST be scored
     "inconclusive" and skipped. Never pass unvalidated paths to Bash. Log a warning
     for each skipped path.
   - `files_unchanged`: Run `git log --oneline --since="{probe.created_at}" -- {path}`
     (validated paths only).
     If output contains "Revert" commits: score "negative".
     If output contains commits not from orchestray: score "neutral" (modified).
     If no relevant commits: score "positive".
   - `tests_pass`: Resolve `command_index` to a command from the pre-approved table. Run
     via Bash. Enforce `test_timeout` from config (default 60s): check if `timeout`
     command is available (`command -v timeout`). On macOS, try `gtimeout` as fallback.
     If neither is available, skip this check and emit a one-time warning: "Note: `timeout`
     binary not found — tests_pass check skipped for this session." Pass = "positive".
     Fail touching delivered files = "negative". Fail on unrelated files = "neutral". Test
     infrastructure errors (command not found, timeout) = "inconclusive" — do not count
     toward outcome.
   - `git_log_clean`: Run `git log --oneline --since="{probe.created_at}" -- {path}`
     (validated paths only).
     Grep for "Revert". Found = "negative", not found = "positive".

5. **Aggregate outcome**:
   - All checks positive: outcome = "positive"
   - Any check negative: outcome = "negative"
   - Mixed neutral/positive (no negatives): outcome = "neutral"
   - All inconclusive: outcome = "neutral"

6. **Update probe file**: Set `status: validated`, `checked_at` (current ISO 8601
   timestamp), `outcome`, and `outcome_details` (array of per-check result objects with
   `type`, `result`, and `detail` fields).

7. **Apply outcome-to-pattern feedback** per Section 41c.

8. **Log `probe_validated` event** to `.orchestray/audit/events.jsonl`. Populate:
   `orchestration_id` as `session-{ISO8601-timestamp}` (synthetic session ID — no
   active orchestration exists at session-start validation; use a real orchestration ID
   when called from within an active orchestration), `probe_orchestration_id` (from the
   probe's frontmatter — the orchestration that created the probe), `probe_id`,
   `outcome`, `checks` (per-check results), `patterns_affected` (from
   `patterns_applied`), `confidence_adjustments` (from Section 41c).

**Constraints:**
- Tests are ONLY run when `enable_outcome_tracking` is true (user opted in to test execution).
- Test infrastructure failures (command not found, timeout) are marked "inconclusive" and
  do not affect outcome.
- Cap: validate at most 3 probes per session start to avoid startup latency.

---

## 41c. Outcome-to-Pattern Feedback

After probe validation produces an outcome, update pattern confidence.

1. **Read `patterns_applied`** from the probe's frontmatter.

   **Path validation (security):** Before using any `patterns_applied` entry as a file
   path, validate it against the regex `^[a-zA-Z0-9_-]+$`. Also reject any entry
   containing `..` or `/`. Entries failing validation must be skipped with a warning:
   "Skipped invalid patterns_applied entry: '{entry}' — failed path validation." Do not
   apply confidence adjustments for invalid entries.

2. **For each pattern in `patterns_applied`**, apply the outcome:

   - **Positive outcome**: Boost confidence by `+0.15` (cap at 1.0).
     - Read the pattern file from `.orchestray/patterns/`.
     - Increment `confidence` by 0.15 (capped at 1.0).
     - Write updated frontmatter.
     - Log: "Outcome validation positive for {pattern}: +0.15 confidence"

   - **Negative outcome**: Decrease confidence by `-0.3` (floor at 0.0). Also extract
     an anti-pattern.
     - Read the pattern file from `.orchestray/patterns/`.
     - Decrease `confidence` by 0.3 (floored at 0.0).
     - Write updated frontmatter.
     - Extract a new anti-pattern per Section 22a with:
       - `created_from: "outcome-{probe-id}"`
       - `confidence: 0.6`
       - Description noting what outcome was observed and which probe triggered it.
     - Log: "Outcome validation negative for {pattern}: -0.3 confidence, anti-pattern extracted"

   - **Neutral outcome**: No adjustment.

3. **Write updated pattern files** for any patterns that had their confidence changed.

---

## 41d. Probe Lifecycle

Run after probe creation (end of 41a) to enforce storage caps.

1. **Cap enforcement**: Glob `.orchestray/probes/probe-*.md`. Count all files.
   - If count > 15: read frontmatter of all probes. Sort by `created_at` ascending.
     Set oldest pending probes to `status: expired` (update their files) until count
     of `status: pending` probes <= 15.

2. **Age expiry**: For each pending probe, check `created_at`. If older than 60 days:
   set `status: expired` (update the probe file). No validation is performed on expired
   probes.

3. **Skip re-checking**: Probes with `status: validated` or `status: expired` are not
   re-checked during 41b validation.
