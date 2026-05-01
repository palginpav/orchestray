---
name: state
description: Inspect and manage Orchestray runtime state
disable-model-invocation: true
argument-hint: "[peek] | gc | pause [--reason=<msg>] | pause --resume | cancel"
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
| `pause`    | Implemented — pause or resume an active orchestration (v2.0.18 W7) |
| `cancel`   | Implemented — request cancellation of an active orchestration (v2.0.18 W7) |

If the subcommand is empty, treat it as `peek` (default).

If the subcommand is not in the table above:
- Emit: "Unknown subcommand '<name>'. Available: peek, gc, pause, cancel."
- Stop.

<!-- W7-INSERT: add `pause` and `cancel` branches here -->

---

### Step 2 — `pause` branch (pause or resume)

For the `pause` subcommand, invoke `bin/state-pause.js` with any flags passed after
the subcommand. Supported flags:

- `--resume` — remove the pause sentinel, resuming the orchestration. Idempotent.
- `--reason=<msg>` — optional human-readable reason stored in the sentinel.

**First call (no `--resume`):** creates `.orchestray/state/pause.sentinel` with the
current `orchestration_id`, optional reason, and `paused_at` timestamp. Emits a
`state_pause_set` audit event. Idempotent — if the sentinel already exists, reports
"already paused" and exits without changes.

**With `--resume`:** deletes the sentinel if present, emits `state_pause_resumed`.
Idempotent — if no sentinel exists, exits silently.

**Effect:** the PreToolUse:Agent hook (`bin/check-pause-sentinel.js`) blocks further
Agent() spawns with exit code 2 while the sentinel is present. The sentinel persists
across session restarts; `/orchestray:resume` honours it.

Invoke via Bash:

```
node bin/state-pause.js [--resume] [--reason=<msg>]
```

Display the output as-is.

---

### Step 3 — `cancel` branch (request cancellation)

For the `cancel` subcommand, invoke `bin/state-cancel.js` with any flags passed after
the subcommand. Supported flags:

- `--force` — overwrite an existing cancel sentinel (resets `requested_at` timestamp).
- `--reason=<msg>` — optional human-readable reason stored in the sentinel.

**Effect:** creates `.orchestray/state/cancel.sentinel` with `orchestration_id`,
optional reason, and `requested_at`. Emits `state_cancel_requested`. Idempotent.

The clean-abort sequence:
1. The PM's next group-boundary Agent() spawn is intercepted by the PreToolUse:Agent
   sentinel hook (`bin/check-pause-sentinel.js`), which exits 1 after the grace window.
2. The PM detects the block and reads the cancel sentinel.
3. The PM moves `.orchestray/state/` to
   `.orchestray/history/orch-<id>-cancelled/` (preserving `events.jsonl`).
4. The PM emits `state_cancel_aborted` and reports cancellation to the user.

Invoke via Bash:

```
node bin/state-cancel.js [--force] [--reason=<msg>]
```

Display the output as-is.

---

### Step 4 — `gc` branch (archive or discard leaked state)

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

### Step 5 — `peek` branch (read-only)

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
