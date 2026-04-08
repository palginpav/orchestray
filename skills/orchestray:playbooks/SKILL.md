---
name: playbooks
description: Manage project-specific playbook files
disable-model-invocation: true
argument-hint: [list|add|view|remove|help] [name]
---

# Playbook Management

The user wants to manage project-specific playbooks that customize how agents work in this project.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If empty or "list": Show all playbooks in table format
   - If starts with "add": Create a new playbook interactively
   - If starts with "view": Show full content of named playbook
   - If starts with "remove": Delete named playbook with confirmation
   - If "help": Show playbook format and examples

### List Operation

Glob `.orchestray/playbooks/*.md`. If the directory does not exist or no `.md` files are found, report: "No playbooks found. Use `/orchestray:playbooks add <name>` to create one."

For each file found, read the first line (`# Playbook: <name>`), the `## When` section, and the `## Applies To` section. Display a table:

```
| Name | Triggers | Applies To |
|------|----------|------------|
| {name} | {when summary, first line only} | {applies to or "all"} |
```

Below the table, show: "{N} playbook(s) found."

Then show usage hints:
- `add <name>` -- Create a new playbook
- `view <name>` -- Show full playbook contents
- `remove <name>` -- Remove a playbook
- `help` -- Show format and examples

### Add Operation

Parse the playbook name from arguments (the word after "add"). If no name is provided, ask the user for one.

Create `.orchestray/playbooks/` directory if it does not exist.

Check if `.orchestray/playbooks/<name>.md` already exists. If so, report: "Playbook '{name}' already exists. Use `/orchestray:playbooks view {name}` to inspect it or `/orchestray:playbooks remove {name}` to delete it first."

Ask the user for:
1. When should this playbook trigger? (file patterns, keywords, or descriptions)
2. What instructions should agents follow? (project-specific rules)
3. Which agents should receive these instructions? (comma-separated list, or "all")

Write the playbook file at `.orchestray/playbooks/<name>.md` using the schema:

```markdown
# Playbook: <name>

## When
<user's trigger conditions>

## Instructions
<user's instructions>

## Applies To
<user's agent list or "all">
```

Report: "Created playbook '{name}' at `.orchestray/playbooks/{name}.md`."

### View Operation

Parse the playbook name from arguments (the word after "view"). Read `.orchestray/playbooks/<name>.md` and display its full contents.

If not found, glob `.orchestray/playbooks/*.md` and suggest available playbooks: "Playbook '{name}' not found. Available playbooks: {list}." If no playbooks exist at all: "Playbook '{name}' not found. No playbooks exist yet. Use `/orchestray:playbooks add <name>` to create one."

### Remove Operation

Parse the playbook name from arguments (the word after "remove"). Check if `.orchestray/playbooks/<name>.md` exists. If not found, report: "Playbook '{name}' not found. Use `/orchestray:playbooks list` to see available playbooks."

If found, ask for confirmation: "Remove playbook '{name}'? This cannot be undone. (yes/no)"

On confirmation:
1. Delete `.orchestray/playbooks/<name>.md`
2. Report: "Removed playbook '{name}'."

On decline: "Cancelled. Playbook '{name}' retained."

### Help Operation

Display the playbook format and examples:

```
## Playbook Format

Playbooks are markdown files in `.orchestray/playbooks/` that inject project-specific
instructions into agent prompts during orchestration.

### Schema

# Playbook: <name>

## When
<trigger conditions: glob patterns, keywords, or descriptions>

## Instructions
<rules and commands for agents to follow>

## Applies To
<comma-separated agent names, or omit for all agents>

### Example Playbooks

**1. Protocol Buffer Changes**
# Playbook: protobuf

## When
- Files matching `**/*.proto`
- Tasks mentioning "protobuf" or "grpc"

## Instructions
- Always run `buf lint` after modifying .proto files
- Regenerate Go stubs with `buf generate`
- Update the proto documentation in docs/api/

## Applies To
developer, tester

**2. API Conventions**
# Playbook: api-conventions

## When
- Files matching `src/api/**`
- Tasks mentioning "endpoint" or "route"

## Instructions
- All new endpoints must have OpenAPI annotations
- Use the shared error response format from `src/api/errors.ts`
- Add rate limiting middleware for public endpoints

## Applies To
developer, architect

**3. Test Requirements**
# Playbook: test-standards

## When
- Tasks mentioning "test" or "coverage"
- Any task that modifies `src/` files

## Instructions
- Integration tests must use the test database, not mocks
- Minimum 80% line coverage for new code
- Include at least one negative test case per public function

## Applies To
tester, developer
```

### Note on Testing

This skill does NOT include test or dry-run functionality. Users inspect playbooks via `view` and test them naturally during orchestration.
