---
name: state
description: Inspect and manage Orchestray runtime state
disable-model-invocation: true
argument-hint: "peek"
---

# Orchestray State Management

The user wants to inspect or manage Orchestray runtime state.

## Protocol

### Step 1 — Parse subcommand

Parse `$ARGUMENTS`. The first whitespace-separated token is the subcommand.

| Subcommand | Status |
|------------|--------|
| `peek`     | Implemented — read-only state inspection |
| `gc`       | Implemented — archive or discard leaked state |
| `pause`    | Not yet implemented (coming in v2.0.18 W7) |
| `cancel`   | Not yet implemented (coming in v2.0.18 W7) |

If the subcommand is empty, treat it as `peek` (default).

If the subcommand is not in the table above or is not yet implemented:
- Emit: "Subcommand '<name>' not yet implemented (coming in v2.0.18 W5/W7)"
- Stop.

<!-- W7-INSERT: add `pause` and `cancel` branches here -->

---

### Step 2 — `gc` branch (archive or discard leaked state)

For the `gc` subcommand, invoke `bin/state-gc.js` with any flags passed after the
subcommand. Supported flags:

- `--dry-run` — list leaked dirs without mutating. Default behaviour when no
  `--mode` flag is given.
- `--mode=archive` — rename each leaked `orch-*/` dir to `orch-*-abandoned/`.
  Idempotent.
- `--mode=discard` — `rm -rf` each leaked dir. Emits a `state_gc_discarded`
  audit event per directory. Explicit opt-in only.
- `--keep-days=<N>` — only consider dirs leaked if their latest event is
  older than N days. Default 7.

A dir is "leaked" when its `events.jsonl` exists, contains no
`orchestration_complete` event, and its latest timestamp is older than
`--keep-days`. Completed orchestrations are never gc'd regardless of age.

After mutating, `state-gc.js` emits a `state_gc_run` audit summary event.

Invoke via Bash:

```
node bin/state-gc.js [flags...]
```

Display the output as-is.

---

### Step 3 — `peek` branch (read-only)

Run `bin/state-peek.js` from the project root with no arguments. This script reads the
current `.orchestray/` state and prints a human-readable markdown report to stdout.

Invoke it via Bash:

```
node bin/state-peek.js
```

Display the output as-is. Do not modify or reformat it.

**Strict read-only constraint**: Do not write any files, run git commands, or make
network calls. `peek` is purely observational.

If `bin/state-peek.js` does not exist or exits non-zero, report:
"Error running state-peek: <stderr output>. Ensure Orchestray is correctly installed."
