---
name: specialists
description: List, view, edit, and remove persistent specialists
disable-model-invocation: true
argument-hint: list | view {name} | remove {name} | edit {name}
---

# Specialist Management

The user wants to manage persistent specialist agents.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If empty or "list": Show all specialists in table format
   - If starts with "view": Show full content of named specialist
   - If starts with "remove": Delete named specialist with confirmation
   - If starts with "edit": Allow user to modify named specialist

2. **Registry file**: `.orchestray/specialists/registry.json`. If the directory or file does not exist, report: "No specialist registry found. Specialists are created automatically during orchestration when dynamic agents succeed, or you can place custom .md files in `.orchestray/specialists/`."

### List Operation

Read `.orchestray/specialists/registry.json` and parse the `specialists` array. Display a table:

```
| Name | Source | Uses | Last Used | Description |
|------|--------|------|-----------|-------------|
| {name} | {source} | {times_used} | {last_used} | {description} |
```

Below the table, show: "{N} specialist(s) registered."

Then show usage hints:
- `view {name}` -- Show full specialist definition
- `remove {name}` -- Remove a specialist
- `edit {name}` -- Edit a specialist

If the `specialists` array is empty, show: "No specialists registered yet. Specialists are created automatically when the PM saves a successful dynamic agent during orchestration, or you can place custom .md files directly in `.orchestray/specialists/`."

### View Operation

Parse the specialist name from arguments (the word after "view"). Look up the name in the `specialists` array of `registry.json` to find the matching entry and its `file` field. If no match is found, report: "Specialist '{name}' not found. Use `/orchestray:specialists list` to see available specialists."

If found, read `.orchestray/specialists/{file}` and display:

```
## Specialist: {name}

**Source:** {source} | **Uses:** {times_used} | **Last Used:** {last_used} | **Created:** {created_at}

### Definition

{full contents of the .md file}
```

### Remove Operation

Parse the specialist name from arguments (the word after "remove"). Look up the name in the `specialists` array of `registry.json`. If no match is found, report: "Specialist '{name}' not found. Use `/orchestray:specialists list` to see available specialists."

If found, ask for confirmation: "Remove specialist '{name}' ({source}, used {times_used} times)? This cannot be undone. (yes/no)"

On confirmation:
1. Delete the .md file at `.orchestray/specialists/{file}`
2. Remove the entry from the `specialists` array in `registry.json`
3. Write the updated `registry.json`
4. Report: "Removed specialist '{name}'."

On decline: "Cancelled. Specialist '{name}' retained."

### Edit Operation

Parse the specialist name from arguments (the word after "edit"). Look up the name in the `specialists` array of `registry.json`. If no match is found, report: "Specialist '{name}' not found. Use `/orchestray:specialists list` to see available specialists."

If found, read `.orchestray/specialists/{file}` and display the current content. Ask the user what they want to change. Apply the requested changes to the .md file.

**Re-validate after every edit.** The specialist .md file must have valid YAML frontmatter containing:
- `name` (string, required)
- `description` (string, required)
- `tools` (comma-separated list, required; allowed values: `Read`, `Glob`, `Grep`, `Bash`, `Write`, `Edit`)

Reject the edit if any of these fields are missing or invalid. Also reject if `bypassPermissions` or `acceptEdits` fields are present -- these are security-sensitive fields that must not appear in specialist definitions.

If validation fails: revert the edit, report what is wrong, and ask the user to fix the issue. If validation passes: write the updated file. If the `description` changed, also update it in the corresponding `registry.json` entry. Report: "Updated specialist '{name}'."

### Note on Testing

This skill does NOT include test or dry-run functionality. Users inspect specialists via `view` and test them naturally during orchestration.
