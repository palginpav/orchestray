<!-- PM Reference: Loaded by Section Loading Protocol when --workflow flag OR workflow trigger matches -->

## 35. Custom YAML Workflow Definitions

Users may define reusable, sequential orchestration workflows in `.orchestray/workflows/*.yaml` files. When a workflow is matched, it replaces the PM's normal task decomposition (Section 13, in tier1-orchestration.md) with the workflow-defined task graph.

### Detection

At the START of Section 13 decomposition (before step 1), check for a workflow reference using either method:

1. **Explicit flag:** Prompt contains `--workflow <name>` -- extract `<name>`, load `.orchestray/workflows/<name>.yaml`
2. **Auto-match:** Glob `.orchestray/workflows/*.yaml`. For each file, read its `trigger` field. If the trigger keyword or pattern appears in the user's prompt (case-insensitive substring), load that workflow. First match wins; if multiple trigger fields match, pick the most specific (longest trigger string).

If no workflow is referenced or matched, skip this section entirely.

### Workflow YAML Schema

```yaml
name: <workflow-name>           # required, kebab-case
description: <one-line>         # required
trigger: <keyword-or-pattern>   # optional, for auto-matching
steps:
  - id: step-1                  # required, unique within the file
    agent: architect             # required, valid agent type
    task: "task description"     # required
    model: opus                  # optional: haiku | sonnet | opus | inherit
    depends_on: []               # optional, list of step ids
```

### Validation Rules

Before executing, validate the loaded YAML. If the file cannot be parsed (YAML syntax
error), report the parse error with the file path and ask the user whether to proceed
without a workflow or fix the file. Do not attempt validation on unparseable files.

1. **Required fields:** `name`, `description`, and `steps` must be present and non-empty.
2. **Step count:** `steps` array must have 1-6 entries (matches Section 13 limit, in tier1-orchestration.md). Reject if exceeded.
3. **Step fields:** Each step must have `id` (string), `agent` (valid agent name), and `task` (non-empty string).
4. **Agent types:** Each step's `agent` must be a valid core agent (architect, developer, refactorer, inventor, reviewer, debugger, tester, documenter, security-engineer, release-manager, ux-critic, platform-oracle) or a registered specialist name (Section 21). Reject unknown agent types.
5. **Model values:** If `model` is specified, it must be `haiku`, `sonnet`, `opus`, or `inherit`. Reject invalid values. `inherit` means the PM's Section 19 routing determines the model.
6. **Dependency references:** Every id listed in `depends_on` must exist as a step `id` in the same file. Reject dangling references.
7. **No circular dependencies:** Build a dependency graph and check for cycles. Reject if any cycle is found.
8. **Unique step IDs:** No two steps may share the same `id`.

**On validation failure:** Report each error to the user with the file path and field name. Do NOT fall back to normal decomposition silently -- ask the user whether to fix the workflow or proceed without it.

### Conversion to Task Graph

Map the validated workflow to the standard task graph format (output of Section 13, in tier1-orchestration.md):

- Each step becomes one task entry
- `depends_on` maps directly to task graph dependency edges
- Steps with no `depends_on` (or empty list) form group 1 (parallel)
- Assign execution groups by topological sort: a step's group = max(group of dependencies) + 1
- If `model` is specified in the step, override the model routing from Section 20 for that task
- Set archetype to `"Workflow: <workflow-name>"` in the orchestration state

### Execution

Proceed to Section 14 (Execution, in tier1-orchestration.md) with the workflow-derived task graph. All other protocols (Section 20 model routing for steps without explicit model, Section 24 security integration (in security-integration.md), Section 30 correction patterns (in tier1-orchestration.md), Section 29 playbook injection (in tier1-orchestration.md)) apply normally unless the workflow step's `model` overrides them.

### Audit

Log a `workflow_loaded` event to `.orchestray/audit/events.jsonl`:
```json
{
  "timestamp": "<ISO 8601>",
  "type": "workflow_loaded",
  "orchestration_id": "<orch-id>",
  "workflow_name": "<name>",
  "source": "<explicit | auto-match>",
  "step_count": 4
}
```
