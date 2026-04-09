---
name: review-pr
description: Review a GitHub pull request using the Orchestray reviewer agent
disable-model-invocation: true
argument-hint: "<PR-URL-or-number> [--post-comments]"
---

# PR Review

You are receiving this because the user invoked `/orchestray:review-pr`. Review a GitHub pull request using the Orchestray reviewer agent.

## Arguments

$ARGUMENTS

## Protocol

Follow these steps in order:

1. **Parse arguments**:
   - Check if `--post-comments` flag is anywhere in `$ARGUMENTS`. If present, set `POST_COMMENTS=true` and strip the flag before further parsing.
   - Read `.orchestray/config.json` if it exists. If `post_pr_comments` is `true`, set `POST_COMMENTS=true`.
   - If the remaining argument is empty: run `gh pr view --json number` to auto-detect the current branch's open PR. If none found, show usage ("Usage: `/orchestray:review-pr <number>`, `/orchestray:review-pr <GitHub PR URL>`, or `/orchestray:review-pr` on a branch with an open PR") and stop.
   - If the argument starts with `https://`: extract the PR number from the URL path (the segment after `/pull/`).
   - If the argument is a bare number or `#<number>`: strip the leading `#` and use as the PR number directly.
   - Store the resolved PR number as `PR_NUMBER`.

2. **Check gh CLI availability**:
   - Run `gh --version` via Bash.
   - If not available: report "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ to use PR review." and stop.

3. **Fetch PR metadata**:
   - Run: `gh pr view <PR_NUMBER> --json number,title,body,baseRefName,headRefName,author,state,labels,reviewDecision`
   - If the command fails (PR not found, auth issue, no repo context): report the error clearly and stop.
   - Parse the JSON response. Note: `author` is an object with a `login` field.
   - Show progress: `> Fetching PR #<PR_NUMBER> (<title>)...`

4. **Fetch PR diff**:
   - Run: `gh pr diff <PR_NUMBER>`
   - If the command fails: report the error and stop.
   - If the diff output exceeds 500 KB (roughly 500,000 characters): truncate to 500 KB and warn: "Diff exceeds 500 KB. Reviewer will see a truncated diff. Consider reviewing individual files with `gh pr view <PR_NUMBER> --patch`."
   - Show progress: `> Reading diff (<N> files, <M> lines)...`

5. **Fetch changed file list and existing review comments**:
   - Run: `gh pr view <PR_NUMBER> --json files` to get the list of changed files with addition/deletion counts.
   - Run: `gh pr view <PR_NUMBER> --json reviews,comments` to get existing review threads and inline comments.
   - From the reviews and comments, extract the most recent 5 review comments to include as context (so the reviewer avoids duplicating already-raised issues).

6. **Read local file context**:
   - From the changed file list, sort files by total line changes (additions + deletions), largest first.
   - For each of the top 20 files (by change size):
     - If the file exists locally and was not deleted: read it and include as full file context.
     - Skip files that were deleted (they no longer exist locally).
   - Show progress: `> Reading file context (<N> files)...`

7. **Assemble review context block**:
   - Build the following block to pass to the reviewer agent:
     ```
     ## PR Review Context

     **PR:** #<number> — <title>
     **Author:** <author.login>
     **Base:** <baseRefName> → <headRefName>
     **State:** <state>
     **Labels:** <comma-separated label names, or "none">

     ### PR Description
     <body, or "No description provided.">

     ### Existing Review Comments (last 5)
     <formatted recent review comments, or "No existing review comments.">

     ### Diff
     <diff output, truncated if needed>

     ### Full File Context
     <for each of the top-20 changed files that exist locally:>
     #### <filepath>
     <file contents>
     ```

8. **Invoke reviewer agent**:
   - Show progress: `> Delegating to reviewer agent...`
   - Invoke the reviewer agent (agents/reviewer.md) directly — no PM layer — with this delegation prompt:

     ```
     You are reviewing a GitHub pull request. The PR context is provided below.

     Your task:
     1. Read the PR description to understand the author's intent.
     2. Review the diff and file context across all 7 dimensions.
     3. Focus your findings on the CHANGED LINES and their immediate context.
     4. Do NOT raise issues about unchanged code unless the changed code directly interacts
        with a problem in the unchanged code.
     5. Note: This is a diff-based review. Local tests cannot run. If CI status is visible
        in the PR metadata, reference it in your assessment.
     6. Apply your standard severity classification: error (must fix before merge),
        warning (should fix), info (nice to have).

     <pr-review-context>
     [assembled context block from step 7]
     </pr-review-context>

     Produce your standard structured result format at the end.
     ```

9. **Parse reviewer result and render terminal output**:
   - Parse the reviewer's structured JSON result.
   - Count issues by severity: errors, warnings, info (suggestions).
   - Map verdict:
     - `status: failure` (errors found) → **CHANGES REQUESTED**
     - `status: success` with warnings → **APPROVED WITH SUGGESTIONS**
     - `status: success` with no warnings (info only or none) → **APPROVED**
     - `status: partial` → **PARTIAL REVIEW — reviewer could not complete**
   - Render the following terminal output:

     ```
     ## PR Review: #<number> — <title>

     **Verdict:** <VERDICT>
     **Files reviewed:** <count from files field>
     **Issues found:** <error_count> errors, <warning_count> warnings, <info_count> suggestions

     ### Errors (must fix before merge)
     | Location | Issue |
     |----------|-------|
     | <file:line> | <issue text> |

     ### Warnings (should fix)
     | Location | Issue |
     |----------|-------|
     | <file:line> | <issue text> |

     ### Suggestions
     | Location | Suggestion |
     |----------|------------|
     | <file:line> | <suggestion text> |

     ### Recommendations
     <bullet list of recommendations>

     ---
     *Review generated by Orchestray reviewer agent*
     *To post these findings to the PR: `/orchestray:review-pr <PR_NUMBER> --post-comments`*   ← only include this line if POST_COMMENTS is not already true
     ```
   - Omit any section (Errors, Warnings, Suggestions) that has no items.
   - For issue descriptions formatted as `file:line -- description`, split on ` -- ` to populate the File/Line and Issue columns. If no file:line prefix is present, leave File and Line blank and put the full text in the Issue column.

10. **Post review to GitHub** (only if `POST_COMMENTS=true`):
    - If `POST_COMMENTS` is not true, skip this step.
    - Check `gh auth status`. If not authenticated, report "gh is not authenticated. Run `gh auth login` before posting review comments." and stop. Do not cache auth status — check each time.
    - Format the review body as a markdown string. Strip any backtick characters (`` ` ``) from issue descriptions to prevent heredoc breakage.
    - Map review type:
      - `status: failure` → `--request-changes`
      - `status: success` → `--approve`
      - `status: partial` → `--comment`
    - Post the review using a heredoc to prevent shell injection from PR content:
      ```bash
      gh pr review <PR_NUMBER> \
        <--request-changes | --approve | --comment per mapping above> \
        --body "$(cat <<'REVIEW_BODY'
      ## Orchestray Code Review

      **Verdict:** <VERDICT>
      **Issues:** <error_count> errors, <warning_count> warnings, <info_count> suggestions

      ### Errors (must fix before merge)

      <**file:line** — description for each error>

      ### Warnings (should fix)

      <**file:line** — description for each warning>

      ### Suggestions

      <**file:line** — description for each info item>

      ### Recommendations

      <bullet list>

      ---
      *Generated by [Orchestray](https://github.com/palginpav/orchestray) reviewer agent*
      REVIEW_BODY
      )"
      ```
    - Report success: "Review posted to PR #<PR_NUMBER>." or the error if posting fails.

## Output

After the review completes, the terminal output from step 9 is the primary result. If `--post-comments` was used, also confirm whether the review was posted successfully.
