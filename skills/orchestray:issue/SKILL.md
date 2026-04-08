---
name: issue
description: Orchestrate implementation from a GitHub issue
disable-model-invocation: true
argument-hint: <issue-number or GitHub URL>
---

# Issue-to-Orchestration

You are receiving this because the user invoked `/orchestray:issue`. Orchestrate work from a GitHub issue.

## Arguments

$ARGUMENTS

## Protocol

Follow these steps in order:

1. **Parse arguments**:
   - If a URL like `https://github.com/<owner>/<repo>/issues/<number>`: extract the issue number
   - If a plain number like `123` or `#123`: use as issue number directly
   - If empty: show usage help ("Usage: `/orchestray:issue <number>` or `/orchestray:issue <GitHub issue URL>`") and stop

2. **Check gh CLI availability**:
   - Run `gh --version` via Bash
   - If not available: report "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/ to use issue integration." and stop

3. **Fetch issue context**:
   - Run `gh issue view <number> --json title,body,labels,comments`
   - If the command fails (issue not found, auth issue): report the error clearly and stop
   - Parse the JSON response

4. **Prepare orchestration context**:
   - Format the issue as a task description:
     ```
     ## GitHub Issue #<number>: <title>

     <body>

     Labels: <comma-separated labels>
     ```
   - If issue has comments, include the last 2 comments as additional context under a "### Recent Discussion" heading

5. **Create working branch**:
   - Check for uncommitted changes: run `git status --porcelain`. If dirty, warn the user and ask whether to stash, continue, or abort.
   - Generate a branch name: `orchestray/<number>-<slug>` where slug is the title lowercased, spaces replaced with hyphens, non-alphanumeric characters (except hyphens) removed, consecutive hyphens collapsed, truncated to 40 chars
   - Run `git checkout -b orchestray/<number>-<slug>`
   - If the branch already exists: run `git checkout orchestray/<number>-<slug>` instead

6. **Trigger orchestration**:
   - Now act as the PM agent and orchestrate the task using the prepared issue context as the task description
   - Follow the same orchestration protocol as `/orchestray:run` (complexity scoring, decomposition, execution, state management)
   - Include the full issue context in the orchestration

7. **Post-orchestration** (if config `post_to_issue` is true in `.orchestray/config.json`):
   - Format a summary comment:
     - What was implemented
     - Files changed
     - Tests added/modified
     - Cost summary
   - Post via stdin to avoid shell injection: `echo "<summary>" | gh issue comment <number> --body-file -`

## Output

After orchestration completes:
- Summarize what each agent did and the outcome
- List all files changed across all agents
- Report any issues or warnings from agents
- Mention the working branch name created for this issue
- Archive orchestration state to `.orchestray/history/{timestamp}-orchestration/`
