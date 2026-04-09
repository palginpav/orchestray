---
name: workflows
description: Manage custom YAML workflow definitions for orchestration
disable-model-invocation: true
argument-hint: "list | create <name> | validate <name> | delete <name> | <name>"
---

# Workflow Management

The user wants to manage custom workflow definitions that describe multi-step orchestration sequences.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If empty or "list": Show all workflows in table format
   - If starts with "create": Create a new workflow interactively
   - If starts with "validate": Validate a named workflow file
   - If starts with "delete": Delete a named workflow with confirmation
   - Otherwise: treat as a workflow name and show its details

### List Operation

Glob `.orchestray/workflows/*.yaml`. If the directory does not exist or no files are found, report: "No workflows found. Use `/orchestray:workflows create <name>` to define one."

For each file found, read the top-level `name`, `description`, and count the `steps` array. Display a table:

```
| Name | Description | Steps | Created |
|------|-------------|-------|---------|
| {name} | {description} | {N} | {created_at} |
```

Below the table, show: "{N} workflow(s) found."

Then show usage hints:
- `create <name>` -- Define a new workflow
- `<name>` -- Show full workflow details
- `validate <name>` -- Check a workflow for errors
- `delete <name>` -- Remove a workflow

### Show Operation

Parse the workflow name from arguments. Look for `.orchestray/workflows/{name}.yaml`. If neither exists, glob `.orchestray/workflows/` and suggest alternatives: "Workflow '{name}' not found. Available: {list}." If no workflows exist: "Workflow '{name}' not found. No workflows defined yet. Use `/orchestray:workflows create {name}` to create one."

If found, display:

```
## Workflow: {name}

**Description:** {description}
**Created:** {created_at}
**Steps:** {N}

### Steps

| # | Agent | Task | Depends On | Model |
|---|-------|------|------------|-------|
| 1 | {agent} | {task} | - | {model or inherit} |
| 2 | {agent} | {task} | step-1 | {model or inherit} |

### Raw YAML

{full file contents in a yaml code block}
```

### Create Operation

Parse the workflow name from arguments (the word after "create"). If no name is provided, ask the user for one. The name must be kebab-case and contain only letters, digits, and hyphens.

Create `.orchestray/workflows/` directory if it does not exist.

Check if `.orchestray/workflows/<name>.yaml` already exists. If so, report: "Workflow '{name}' already exists. Use `/orchestray:workflows {name}` to inspect it or `/orchestray:workflows delete {name}` to remove it first."

Ask the user for each piece of information interactively:

1. **Description**: "What does this workflow do? (one-line description)"
2. **Trigger** (optional): "Trigger keyword for auto-matching (optional — leave blank to require `--workflow <name>` explicitly):"
3. **Steps**: "How many steps does this workflow have? (max 6)"
   - For each step, ask:
     - "Step {N} agent: (architect | developer | reviewer | tester | documenter | debugger | refactorer | security-engineer)"
     - "Step {N} task: (brief description of what this agent should do)"
     - "Step {N} depends on: (comma-separated step numbers, or leave blank for none)"
     - "Step {N} model: (haiku | sonnet | opus | inherit — default: inherit)"

Validate inputs as they are collected (see Validation Rules below). If any input is invalid, ask again with an explanation.

Write the workflow file at `.orchestray/workflows/<name>.yaml`:

```yaml
name: <name>
description: <description>
trigger: <keyword or blank>   # optional, for auto-matching
created_at: <ISO timestamp>
steps:
  - id: step-1
    agent: <agent>
    task: <task description>
    depends_on: []
    model: inherit
  - id: step-2
    agent: <agent>
    task: <task description>
    depends_on:
      - step-1
    model: inherit  # or haiku | sonnet | opus to override routing
```

After writing, run validation automatically. If validation fails, show errors and offer to fix them. If it passes, report: "Created workflow '{name}' at `.orchestray/workflows/{name}.yaml`."

### Validate Operation

Parse the workflow name from arguments (the word after "validate"). Read `.orchestray/workflows/<name>.yaml`. If not found, report: "Workflow '{name}' not found."

Apply all Validation Rules (see below). Display results:

If valid:
```
Workflow '{name}': VALID

  Steps: {N}
  Agents: {list of unique agents used}
  Execution order: {step-1 -> step-2 -> [step-3, step-4] -> step-5}
  (Parallel groups shown in brackets)
```

If invalid:
```
Workflow '{name}': INVALID — {N} error(s) found

  Error 1: {description}
  Error 2: {description}
```

### Delete Operation

Parse the workflow name from arguments (the word after "delete"). Check if `.orchestray/workflows/<name>.yaml` exists. If not found, report: "Workflow '{name}' not found. Use `/orchestray:workflows list` to see available workflows."

If found, ask for confirmation: "Delete workflow '{name}'? This cannot be undone. (yes/no)"

On confirmation:
1. Delete the workflow file.
2. Report: "Deleted workflow '{name}'."

On decline: "Cancelled. Workflow '{name}' retained."

## Validation Rules

Apply these checks when validating a workflow file. Report ALL errors found, not just the first one.

1. **Required top-level fields**: `name`, `description`, `steps` must be present and non-empty.
2. **Step count**: `steps` array must have 1–6 entries. More than 6 steps is disallowed to keep workflows focused.
3. **Step fields**: Each step must have `id` (string, unique within the workflow), `agent` (valid agent name), and `task` (non-empty string).
4. **Valid agents**: The `agent` field must be one of: `architect`, `developer`, `reviewer`, `tester`, `documenter`, `debugger`, `refactorer`, `inventor`, `security-engineer`.
5. **Valid models**: The `model` field, if present, must be one of: `haiku`, `sonnet`, `opus`, `inherit`. Defaults to `inherit` if absent.
6. **depends_on references**: Each step ID listed in `depends_on` must exist in the workflow's `steps` array. Forward references are allowed (a later step can be referenced by an earlier one only if the dependency graph remains acyclic — see rule 7).
7. **No circular dependencies**: The dependency graph must be a DAG (directed acyclic graph). A cycle means step A depends on step B which depends back on step A (directly or transitively). Report the cycle path: "Circular dependency detected: step-1 -> step-2 -> step-1"
8. **Unique step IDs**: No two steps may share the same `id`.

## YAML Schema Reference

```yaml
# Workflow schema
name: string          # kebab-case identifier, required
description: string   # one-line summary, required
trigger: string       # keyword/pattern for auto-matching, optional
created_at: string    # ISO 8601 timestamp, set on creation
steps:                # 1–6 steps, required
  - id: string        # unique step ID within this workflow (e.g., step-1), required
    agent: string     # one of the valid agent names, required
    task: string      # what this agent should do, required
    depends_on:       # list of step IDs this step waits for, optional (default: [])
      - string
    model: string     # haiku | sonnet | opus | inherit, optional (default: inherit)
```

## Example Workflows

### Sequential review pipeline

```yaml
name: review-pipeline
description: Architect designs, developer implements, reviewer checks
trigger: review pipeline
created_at: 2026-04-09T00:00:00Z
steps:
  - id: step-1
    agent: architect
    task: Design the solution and produce a design document
    depends_on: []
    model: opus
  - id: step-2
    agent: developer
    task: Implement the design from step-1
    depends_on:
      - step-1
    model: sonnet
  - id: step-3
    agent: reviewer
    task: Review the implementation from step-2 for correctness and quality
    depends_on:
      - step-2
    model: sonnet
```

### Parallel security + test pass

```yaml
name: quality-gate
description: Run security audit and test coverage check in parallel, then review
trigger: quality gate
created_at: 2026-04-09T00:00:00Z
steps:
  - id: step-1
    agent: security-engineer
    task: Audit the codebase for vulnerabilities
    depends_on: []
    model: opus
  - id: step-2
    agent: tester
    task: Analyse test coverage and write missing tests
    depends_on: []
    model: sonnet
  - id: step-3
    agent: reviewer
    task: Review findings from the security audit and test pass
    depends_on:
      - step-1
      - step-2
    model: sonnet
```

### Note on Testing

This skill does NOT include a dry-run mode. Use `/orchestray:workflows validate <name>` to check a workflow before using it in an orchestration.
