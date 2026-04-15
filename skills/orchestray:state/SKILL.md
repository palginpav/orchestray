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
| `gc`       | Not yet implemented (coming in v2.0.18 W5) |
| `pause`    | Not yet implemented (coming in v2.0.18 W7) |
| `cancel`   | Not yet implemented (coming in v2.0.18 W7) |

If the subcommand is empty, treat it as `peek` (default).

If the subcommand is not in the table above or is not yet implemented:
- Emit: "Subcommand '<name>' not yet implemented (coming in v2.0.18 W5/W7)"
- Stop.

<!-- W5-INSERT: add `gc` branch here (archive/discard leaked state) -->
<!-- W7-INSERT: add `pause` and `cancel` branches here -->

---

### Step 2 — `peek` branch (read-only)

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
