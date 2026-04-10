# Specialist Save & Reuse Protocol Reference

Detailed step-by-step procedures for saving and reusing dynamic agent specialists.
For decision criteria (when to save, when not to save), see the main PM prompt Sections 20-21.

---

## Save Process (Section 20)

1. Read `.orchestray/specialists/registry.json`. If the file or directory is missing,
   create `.orchestray/specialists/` directory and initialize `registry.json` with
   `{ "version": 1, "specialists": [] }`.

1.5. **Name collision check (hard reject):** Before the overlap check, verify the
   specialist name does not collide with a reserved builtin agent name or an existing
   specialist in the registry.

   - **Reserved names (builtin agents):** `pm`, `architect`, `developer`, `refactorer`,
     `inventor`, `reviewer`, `debugger`, `tester`, `documenter`, `security-engineer`.
   - **Normalize before comparison**: Before checking against the blocklist, normalize
     the candidate name by (a) converting to lowercase, and (b) stripping non-ASCII
     characters (apply Unicode NFKD normalization and filter to ASCII range). Then
     compare against the blocklist. This prevents bypass via `Reviewer` (capital) or
     `reviewеr` (Cyrillic е U+0435).
   - If the name matches any reserved builtin agent name, reject with error:
     "Specialist name collides with builtin agent — use a different name." Do not save.
   - If the name matches any existing specialist name in `registry.json`, reject with
     error: "Specialist name already in use or reserved." Do not save.
   - This is a hard reject; do not proceed to the description overlap check.

2. Check for overlapping specialists: compare the new agent's name and description
   against existing registry entries. If overlap is found, skip the save and note
   which existing specialist covers this domain. Consider updating that specialist's
   description if the new agent adds useful refinement.

3. Generalize the agent's prompt: remove task-specific file paths, variable names,
   and one-time context. Keep domain knowledge, output format instructions, tool
   patterns, KB protocol references, and scope boundaries.

4. Write the generalized agent definition to `.orchestray/specialists/{name}.md`
   using the same YAML frontmatter + markdown body format as Section 17 definitions.

5. Add a registry entry to `registry.json`:
   ```json
   {
     "name": "{name}",
     "description": "{one-line description}",
     "source": "auto",
     "file": "{name}.md",
     "times_used": 1,
     "last_used": "{ISO 8601 now}",
     "created_at": "{ISO 8601 now}"
   }
   ```

6. Delete the `agents/{name}.md` copy (as the normal lifecycle requires).

7. Log `specialist_saved` event to `.orchestray/audit/events.jsonl`.
   > Read `agents/pm-reference/event-schemas.md` for the exact JSON format.

8. Report to user: "Saved '{name}' specialist for future reuse."

### Soft Cap Warning

If `registry.specialists.length >= 20` after saving, warn the user:
"Specialist registry has {N} entries. Consider pruning with `/orchestray:specialists`."

Do NOT block the save. The cap is advisory, not enforced.

### Promotion Check

After incrementing `times_used` (on reuse, handled in Section 21) OR on initial save
if the specialist has already reached the threshold:

- If `times_used >= 5`: suggest to user: "'{name}' has been used {N} times. Promote
  to `.claude/agents/` for permanent availability? (requires confirmation)"
- On user confirmation:
  1. Copy `.orchestray/specialists/{name}.md` to `.claude/agents/{name}.md`.
  2. Remove the entry from `registry.json`.
  3. Delete `.orchestray/specialists/{name}.md`.
  4. Log `specialist_promoted` event to `.orchestray/audit/events.jsonl`.
     > Read `agents/pm-reference/event-schemas.md` for the exact JSON format.
  5. Report to user: "Promoted '{name}' to `.claude/agents/` for permanent availability."
- On decline: continue normally. Do not ask again until the next use increment.

---

## Registry Check (Section 21)

> **See also:** The reserved-name blocklist used in steps 2a and 4a below originates
> from the builtin agent set defined in `tier1-orchestration.md §17`. The 10 reserved
> names are: `pm`, `architect`, `developer`, `refactorer`, `inventor`, `reviewer`,
> `debugger`, `tester`, `documenter`, `security-engineer`.

1. **Read `.orchestray/specialists/registry.json`.**
   - If the file or directory is missing: no specialists are available. Proceed to
     Section 17 normal flow (create a new dynamic agent from scratch).

2. **File sync for user-created specialists:** Scan `.orchestray/specialists/` for
   `.md` files that are NOT present in `registry.json`. For each unregistered file:

   a. **Validate the file:** Read it and check that YAML frontmatter contains the
      required fields:
      - `name` (string, non-empty)
      - `description` (string, non-empty)
      - `tools` (comma-separated string; each tool name must be from the allowed set:
        `Read`, `Glob`, `Grep`, `Bash`, `Write`, `Edit`)

      **Reserved-name check (security — do this FIRST):** Before any other validation,
      check the `name` field from frontmatter against the reserved-name blocklist:
      `pm`, `architect`, `developer`, `refactorer`, `inventor`, `reviewer`, `debugger`,
      `tester`, `documenter`, `security-engineer`. **Normalize before comparison**:
      Before checking against the blocklist, normalize the candidate name by (a)
      converting to lowercase, and (b) stripping non-ASCII characters (apply Unicode
      NFKD normalization and filter to ASCII range). Then compare against the blocklist.
      This prevents bypass via `Reviewer` (capital) or `reviewеr` (Cyrillic е U+0435).
      If the name matches any reserved name, reject with error: "Specialist name
      collides with builtin agent — use a different name." Do not register, do not
      copy. Treat as invalid (go to step 2c).

      **Security:** Reject any file whose frontmatter contains `bypassPermissions` or
      `acceptEdits` fields. These fields could elevate agent privileges beyond what the
      PM intends.

   b. **If valid:** Auto-register with the following entry in `registry.json`:
      ```json
      {
        "name": "{from frontmatter}",
        "description": "{from frontmatter}",
        "source": "user",
        "file": "{filename}",
        "times_used": 0,
        "last_used": null,
        "created_at": "{ISO 8601 now}"
      }
      ```
      Write the updated `registry.json`.

   c. **If invalid:** Skip the file. Log a warning internally: "Skipped invalid
      specialist file: {filename} -- missing required fields or contains forbidden
      fields." Do NOT crash the orchestration. Continue processing remaining files.

3. **Match subtask against registry:** Compare the subtask's description and domain
   against specialist `name` and `description` fields in `registry.json`. Use reasoning
   to determine if a specialist is a good match for the subtask. Do NOT load full `.md`
   files during matching -- only read names and descriptions from `registry.json`.

   **Priority rule:** If both a `source: "user"` and `source: "auto"` specialist match
   the subtask, prefer the user-created one. User-created specialists take priority
   over auto-saved ones because users explicitly curated them for their project.

4. **If match found:**

   a. **Reserved-name check (security — do this FIRST):** Before copying, verify the
      matched specialist's name against the reserved-name blocklist: `pm`, `architect`,
      `developer`, `refactorer`, `inventor`, `reviewer`, `debugger`, `tester`,
      `documenter`, `security-engineer`. **Normalize before comparison**: Before
      checking against the blocklist, normalize the candidate name by (a) converting to
      lowercase, and (b) stripping non-ASCII characters (apply Unicode NFKD
      normalization and filter to ASCII range). Then compare against the blocklist.
      This prevents bypass via `Reviewer` (capital) or `reviewеr` (Cyrillic е U+0435).
      If the name matches any reserved name, reject with error: "Specialist name
      collides with builtin agent — use a different name." Do not register, do not
      copy. Proceed to Section 17 normal flow instead.

      Copy `.orchestray/specialists/{file}` to `agents/{name}.md`.

   b. Apply model routing from Section 19: read the specialist's frontmatter, override
      the `model:` field with the routed model for this subtask's complexity score.
      Write the updated file to `agents/{name}.md`.

   c. Proceed to Section 17 step 2 (spawn the agent).

   d. After completion (in Section 17 step 5): increment `times_used` and set
      `last_used` to the current ISO 8601 timestamp in `registry.json`. Check the
      promotion threshold per Section 20. Delete the `agents/{name}.md` copy.

   e. Log `specialist_reused` event to `.orchestray/audit/events.jsonl`.
      > Read `agents/pm-reference/event-schemas.md` for the exact JSON format.

5. **If no match:** Proceed to Section 17 normal flow (create a new dynamic agent
   from scratch at step 1).

### Selection Display

When announcing specialist reuse, format the announcement as:

```
Reusing specialist '{name}' ({model} -- score {N}/12)
```

This follows the same pattern as Section 19's routing transparency format.

### Staleness Warning

If a matched specialist has `last_used` older than 30 days, note internally that the
specialist may reference outdated APIs, file paths, or project patterns. Proceed with
reuse but monitor the output quality more carefully. If the specialist fails, consider
whether staleness was the cause and whether the specialist should be removed or updated.

### Allowed Tool Names for Validation

The following tool names are valid in specialist frontmatter `tools` fields:
`Read`, `Glob`, `Grep`, `Bash`, `Write`, `Edit`.

Any other tool name makes the specialist file invalid and it will be skipped during
file sync (step 2c above).
