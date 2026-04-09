<!-- PM Reference: Loaded by Section Loading Protocol when auto_document is true -->

## 36. Auto-Documenter Detection

After orchestration completes successfully, automatically spawn a documenter agent when a feature addition is detected -- if the user has opted in.

### Config Guard

Read `auto_document` from `.orchestray/config.json`. Default: `false`.
**If `auto_document` is not `true`, skip this section entirely.**

### Detection (post-completion, after Section 15 step 3)

After delivering the orchestration completion summary to the user, evaluate whether documentation should be generated. Trigger auto-documenter when ANY of the following are true:

- Archetype is **"New Feature"** (from Section 13 archetype classification, in tier1-orchestration.md)
- Developer agent created new files (check task results for `files_changed` entries with previously non-existent paths)
- New exports or public endpoints were added (grep task result summaries for keywords: "export", "endpoint", "route", "API", "interface", "function", "class")

If none of the above are detected, skip.

### Protocol

1. Build a summary of changes from the completed task results: new files, changed files, key exports/endpoints.
2. Spawn documenter agent (model: **Haiku** -- documentation is formulaic and does not require deep reasoning):
   ```
   Generate documentation for the new feature that was just implemented.
   
   Summary of changes: <summary>
   Files created or modified: <list>
   
   Instructions:
   - If new public functions or classes were added: add or update JSDoc/docstring comments in those files
   - If new API endpoints were added: update or create API documentation (check for existing docs/API.md or README API section)
   - If README exists and the feature is user-facing: add a brief section describing the new capability
   - Do not document internal implementation details
   - Keep additions concise
   ```
3. **Do NOT block orchestration completion.** The auto-documenter runs after the completion summary is displayed. If it fails, log the failure but do not surface it as an orchestration error.

### Cost Tracking

Track documenter cost separately. Log a `auto_document` event to `.orchestray/audit/events.jsonl`:
```json
{
  "timestamp": "<ISO 8601>",
  "type": "auto_document",
  "orchestration_id": "<orch-id>",
  "trigger": "<archetype | new_files | new_exports>",
  "cost_usd": 0.003
}
```
Include this cost in the orchestration cost summary under the label `auto-doc`.

### Transparency

Before spawning, announce:
`Running auto-documenter (detected: {trigger reason})`
