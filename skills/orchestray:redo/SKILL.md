---
name: redo
description: Re-run a W-item with an optional prompt override and cascade to dependents
disable-model-invocation: true
argument-hint: "<W-id> [--prompt=\"...\"] [--cascade]"
---

# Re-run a W-item

You are receiving this because the user invoked `/orchestray:redo`. This command
re-runs a single W-item in the currently active orchestration, with an optional
prompt override. Use `--cascade` to also re-run any downstream W-items that
depended on the redone one.

## Redo Protocol

### Argument Parsing

`$ARGUMENTS` has the form:

```
<W-id> [--prompt="<override text>"] [--cascade]
```

Examples:
- `W4`
- `W4 --cascade`
- `W4 --prompt="Focus only on the auth module"`
- `W4 --prompt="Focus only on the auth module" --cascade`

Parse rules:
1. **W-id** — first whitespace-delimited token (e.g. `W4`, `W12`). Required.
2. **`--prompt="..."`** — optional; value is everything between the first `"` after
   `--prompt=` and the closing `"`. May contain spaces.
3. **`--cascade`** — optional flag; triggers transitive dependent re-run.

### Invocation

Run the redo script:

```bash
node bin/redo-wave-item.js <W-id> [--prompt=<file>] [--cascade]
```

**Prompt override handling:** to avoid shell-quoting hazards, write the override
text to a temporary file and pass the path via `--prompt=<file>`:

```bash
TMPFILE=$(mktemp /tmp/redo-prompt-XXXXXX.txt)
printf '%s' "<override text>" > "$TMPFILE"
node bin/redo-wave-item.js <W-id> --prompt="$TMPFILE" [--cascade]
rm -f "$TMPFILE"
```

### Cascade Behaviour

When `--cascade` is supplied:
- The script reads `.orchestray/state/task-graph.md` to compute the transitive
  closure of downstream dependents.
- It prints the **full list** once upfront, then asks for a **single y/N
  confirmation** before taking any action.
- Batch-confirm once, not interactive per item.
- On `y`: writes `.orchestray/state/redo.pending` with the W-id list in
  dependency order and emits one `w_item_redo_requested` audit event per item.
- On `N` (or any other input): aborts cleanly with no state written.

Without `--cascade`:
- Prompts once: `Redo <W-id> only? [y/N]`
- On `y`: writes `redo.pending` with just the single W-id.

### Guard: No Active Orchestration

If `.orchestray/state/` does not exist or contains no `task-graph.md` and no
`tasks/<W-id>.md`, the script exits 1 with:

```
/orchestray:redo only works on the currently active orchestration.
Completed orchestrations are immutable (archived in .orchestray/history/).
```

Surface this message verbatim to the user and stop.

### PM Response

After `redo.pending` is written, the PM picks it up on its next tick and:
1. Reads the W-id list from `redo.pending`.
2. Respawns each listed W-item's developer in dependency order.
3. Deletes `redo.pending` after all items complete.
4. Each re-run produces a NEW commit prefixed `redo(<W-id>):` — never an amend.

See `agents/pm-reference/tier1-orchestration.md` §6.T for the full PM-side protocol.

## Output

After the redo script completes:
- Report what was queued for redo (the W-id list from `redo.pending`).
- If the user declined the confirmation, report that the redo was aborted.
- If no active orchestration was found, surface the guard message.

<!-- Implementation history:
  - W8 v2.0.18 (UX3): initial redo protocol (batch-confirm cascade, OQ-TA-2 design).
-->
