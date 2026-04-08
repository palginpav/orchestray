---
name: kb
description: View and manage the knowledge base
disable-model-invocation: true
argument-hint: "[list|view ID|add CATEGORY TOPIC|clean|stats]"
---

# Knowledge Base Management

The user wants to view or manage the Orchestray knowledge base.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If empty or `list`: List all KB entries.
   - If starts with `view`: View full content of a specific KB entry by ID.
   - If starts with `add`: Create a new KB entry with the given category and topic.
   - If `clean`: Remove all stale entries past their TTL.
   - If `stats`: Show KB statistics.

2. **Read index**: Read `.orchestray/kb/index.json`. If the file or directory does not exist, report: "No knowledge base found. The KB is populated automatically during orchestrations when agents write findings." and stop.

### List Operation

Parse the `entries` array from `.orchestray/kb/index.json`. For each entry, determine staleness: an entry is stale if today's date exceeds `created_at` + `ttl_days`.

Display as a table:

```
## Knowledge Base

| ID | Category | Topic | Source Agent | Created | Stale? |
|----|----------|-------|-------------|---------|--------|
| {id} | {category} | {topic} | {source_agent} | {created_at} | {Yes/No} |
...
```

Below the table: "{N} entries total, {S} stale."

Show usage hints:
- `view {id}` -- Show full entry content
- `add {category} {topic}` -- Add a new entry
- `clean` -- Remove stale entries
- `stats` -- Show KB statistics

If the `entries` array is empty: "Knowledge base is empty. Entries are created automatically during orchestrations when agents store findings, or you can add entries manually with `add {category} {topic}`."

### View Operation

Parse the entry ID from arguments (the word after "view"). Look up the ID in the `entries` array of `index.json`. If not found: "KB entry '{id}' not found. Use `/orchestray:kb list` to see available entries."

If found, read the entry's content file using the `file` field from the index entry at
`.orchestray/kb/{entry.file}` (e.g., `.orchestray/kb/facts/auth-module-structure.md`).
Display:

```
## KB Entry: {id}

**Category:** {category} | **Topic:** {topic} | **Source:** {source_agent}
**Created:** {created_at} | **TTL:** {ttl_days} days | **Stale:** {Yes/No}

### Content

{full contents of the .md file}
```

### Add Operation

Parse category and topic from arguments (words after "add", first word = category, remaining = topic). If either is missing: "Usage: `/orchestray:kb add {category} {topic}`. Example: `/orchestray:kb add convention naming-patterns`"

Ask the user for the content of the new KB entry. Once provided:

1. Generate a slug from the topic: lowercase, hyphens, no special characters.
2. Generate an ID: `{category}-{slug}` (e.g., `fact-auth-module-structure`).
3. Write the content to `.orchestray/kb/{category}/{slug}.md` (e.g., `.orchestray/kb/facts/auth-module-structure.md`).
4. Add an entry to `index.json`:
   ```json
   {
     "id": "{category}-{slug}",
     "category": "{category}",
     "topic": "{topic}",
     "source_agent": "user",
     "created_at": "{ISO 8601 today}",
     "updated_at": "{ISO 8601 today}",
     "ttl_days": 90,
     "stale": false,
     "file": "{category}/{slug}.md",
     "summary": "{first 50 tokens of content}"
   }
   ```
5. Write the updated `index.json`.
6. Report: "Created KB entry '{id}' in category '{category}'."

### Clean Operation

Read all entries from `index.json`. For each entry, calculate expiry: `created_at` + `ttl_days`. If today's date (2026-04-08 or current) exceeds the expiry, the entry is stale.

For each stale entry:
1. Delete `.orchestray/kb/{entry.file}` if it exists (using the `file` field from the index entry).
2. Remove the entry from the `entries` array.

Write the updated `index.json`. Report: "Removed {N} stale KB entries." with a list of removed IDs. If no stale entries: "No stale entries found. All {total} entries are within their TTL."

### Stats Operation

Read `index.json` and compute:

```
## KB Statistics

| Metric | Value |
|--------|-------|
| Total entries | {count} |
| Stale entries | {stale_count} |
| Categories | {unique category count} |
| Oldest entry | {id} ({created_at}) |
| Newest entry | {id} ({created_at}) |

## Entries by Category
| Category | Count |
|----------|-------|
| {category} | {count} |
...
```

If no entries: "Knowledge base is empty."
