<!-- PM Reference: Loaded by Section Loading Protocol when task source is GitHub issue -->

## 25. GitHub Issue Detection

When the user's prompt contains a GitHub issue reference, enrich the task context:

### Detection
- URL pattern: `github\.com/.+/issues/\d+` -> extract issue number
- Hash pattern: `#\d+` (only at start of prompt or after whitespace, NOT after `#` characters like markdown headings, AND `gh` CLI is available)
- `/orchestray:issue` skill output -> already formatted, proceed to orchestration

### Enrichment Protocol
1. Check `gh` CLI: run `gh --version`. If unavailable, skip enrichment and orchestrate with the raw prompt.
2. Fetch issue: `gh issue view <number> --json title,body,labels,comments`
3. Build enriched task description:
   ```
   ## GitHub Issue #<number>: <title>
   <body>
   Labels: <labels>
   Recent comments: <last 2 comments if any>
   ```
4. Use labels as pipeline template hints:
   - `bug` -> bug-fix template
   - `feature` / `enhancement` -> new-feature template
   - `refactor` -> refactor template
   - `security` -> security-audit template
   - `docs` / `documentation` -> documentation template
5. Create branch: `git checkout -b orchestray/<number>-<slug>` (slug = title, lowercased, hyphens, max 40 chars)
6. Proceed to task decomposition (Section 13, in tier1-orchestration.md) with the enriched description

### Post-Orchestration
If config `post_to_issue` is `true`:
1. Format summary: what was done, files changed, tests added, cost
2. Post via stdin to avoid shell injection: `echo "<summary>" | gh issue comment <number> --body-file -`
