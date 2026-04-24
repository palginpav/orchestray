# ox Protocol — Orchestray User-Facing CLI v1

**Tier:** 2 (conditional load)
**Gate:** `enable_ox_cli: true` (default on)
**Loaded when:** PM is about to write routine state, routing, or audit ops.

---

## 1. Overview

`ox` is Orchestray's user-facing CLI (the thin layer the PM calls directly via
`Bash()`). It replaces verbose multi-line bash blocks with short, idempotent
commands. The underlying hook scripts remain unchanged — `ox` is a parallel
surface for agent use, not a hook replacement.

Git-analogy note: `ox` is the "porcelain" (user-facing CLI); the hook scripts
are the "plumbing" (machine-facing hooks). Use `ox` in agent `Bash()` calls;
use hooks via their Claude Code event wiring only.

**Token savings:** ~500–800 tokens per medium orchestration on the bash-generation
path alone (W2 §5.6 measurement against real routing.jsonl data).

---

## 2. Verb table

```
ox — Orchestray porcelain (user-facing CLI); v1 verbs for orchestration lifecycle.

  events append   --event-type=<t> [--extra=json]    —  append one audit event row
  routing add     <task> <agent> <model>              —  append one routing-decision row
  state complete  [--status=...]                      —  mark current orchestration complete
  state init      <orch-id> [--task=...]              —  initialise orchestration marker + log
  state pause     [--reason=...]                      —  write pause sentinel for resume
  state peek      [--json]                            —  emit current orchestration state
```

### Verb details

| Verb | Positional args | Key flags | English gloss |
|------|-----------------|-----------|---------------|
| `state init` | `<orch-id>` | `--task="..."` | Initialise orchestration marker and log for this orch-id |
| `state complete` | — | `--status=success\|partial\|failure` | Mark current orchestration complete with final status |
| `state pause` | — | `--reason="..."` | Pause current orchestration and write resume sentinel |
| `state peek` | — | `--json` | Read and display current orchestration state (read-only) |
| `routing add` | `<task-id> <agent> <model>` | `[effort] [score] --desc="..."` | Append one routing-decision row to routing.jsonl |
| `events append` | — | `--event-type=<t> --extra=json --task-id=...` | Append one audit event of the given type to events.jsonl |

### Usage examples

```bash
# Start a new orchestration
ox state init orch-1712345678 --task="v2.1.11 implementation"

# Record a routing decision before Agent() spawn
ox routing add task-1 architect opus high 8 --desc="design phase"

# Append a custom audit event
ox events append --event-type=replan_triggered --task-id=task-3

# Verify a mutation took effect (F-02 verify path)
ox state peek --json

# Pause for ship freeze
ox state pause --reason="release freeze 2026-04-30"

# Mark orchestration done
ox state complete --status=success
```

---

## 3. Conventions

### Silent-success
Mutating verbs (`state init`, `state complete`, `state pause`, `routing add`,
`events append`) write **nothing to stdout** on success. Exit 0 is the signal.
This saves ~5–10 tokens per call vs. confirmation messages.

### Idempotent no-ops
Re-running a mutating verb with identical args is always safe. When no action
is needed, stdout emits `{"noop":true,"reason":"..."}` and the exit code is 0.
**Never** add defensive `[[ -f ...]] || ox state init` guards — just call `ox`
directly.

### Verify affordance — `state peek --json`
To confirm a mutation took effect (F-02 closure), run:
```bash
ox state peek --json
```
Returns a canonical JSON object:
```json
{
  "orchestration_id": "orch-1712345678",
  "status": "active",
  "phase": null,
  "current_group": null,
  "groups": [],
  "last_event_ts": "2026-04-24T08:08:01Z",
  "marker_path": "/path/to/.orchestray/audit/current-orchestration.json"
}
```
`status` is one of: `active`, `paused`, `complete`, `none`.
When no orchestration is active, returns `status: "none"` with other fields null
— NOT an error.

### Fixed-shape errors
```
ox: <verb>: <reason>        # exit 1 — known error
ox: usage: <synopsis>       # exit 2 — bad args / unknown verb
```
The `ox:` prefix lets PM error-handling key off a consistent prefix.

### --dry-run
All mutating verbs accept `--dry-run`. When set, the verb describes what WOULD
be written to stdout and exits 0 without touching disk. Use for debugging.

### Quoting discipline
All `--flag=value` arguments that derive from external content (user task
descriptions, GitHub issue titles, etc.) MUST be double-quoted in the Bash()
call:
```bash
ox state init orch-123 --task="$TASK_DESCRIPTION"
```

---

## 4. Error contract

| Exit | Meaning | Stdout | Stderr |
|------|---------|--------|--------|
| 0 | success | empty (mutating) OR data (peek) | empty |
| 1 | known error (conflict, IO, missing orch) | empty | `ox: <verb>: <reason>` |
| 2 | usage error (bad args, unknown verb) | empty | `ox: usage: <synopsis>` |

All JSONL writes use `atomicAppendJsonl` from `bin/_lib/atomic-append.js` (S05).
No `fs.appendFileSync` in production paths.

### S03 — events append security constraints
`--extra` JSON payload:
- Parsed as a JSON object; arrays and primitives are rejected.
- Reserved top-level keys `orchestration_id`, `event`, `ts`, `type` are
  **rejected with exit 2**. The `orchestration_id` is always forced from the
  current-orchestration.json marker — never from `--extra`.
- Capped at 2048 bytes (reject with exit 2 if exceeded).

---

## 5. ox vs. MCP decision rule

**Use MCP tools** when the op needs a structured response the PM will reason
over: pattern search, KB lookup, routing lookup, budget check.

**Use `ox`** when the op is a routine write (init, add, append, complete) or a
simple peek where terse output is sufficient. These are process-automation ops,
not reasoning inputs.

`ox` does NOT duplicate any existing MCP tool in v1. Future verbs (`ox kb read`,
`ox events tail`) will be additive, not replacements.

---

## 6. Install and PATH

After `npx orchestray --global` (or `--local`):

- `ox.js` is installed to `<target>/orchestray/bin/ox.js`.
- A shim `<target>/orchestray/bin/ox` (no `.js` extension) is created with
  executable permissions.
- `<target>/orchestray/bin` is prepended to `PATH` in `settings.json` `env`.
- Bare `ox help` resolves in any agent `Bash()` call without specifying the
  full path.

**Fallback:** if the PATH install fails, invoke via:
```bash
node "$CLAUDE_PLUGIN_ROOT/orchestray/bin/ox.js" <verb> ...
```
Set `ORCHESTRAY_OX_FALLBACK=node-path` in env to document this is in use.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ox: command not found` | PATH not updated or session not restarted | Restart Claude Code; check `settings.json` `env.PATH` includes the bin dir |
| `ox: state init: orchestration_id must start with 'orch-'` | Bad orch-id format | Use `orch-<alphanumerics>` e.g. `orch-1712345678` |
| `ox: state init: active orchestration X exists` | Conflict with a live orchestration | Run `ox state complete` or `ox state pause` first |
| `ox: events append: --extra contains reserved key` | Tried to override `orchestration_id` in `--extra` | Remove the reserved key from `--extra`; ox forces it from the marker |
| `ox: routing add: no active orchestration` | Forgot to `ox state init` | Call `ox state init <orch-id>` before routing ops |
| `ox: usage: --extra value exceeds 2048-byte cap` | `--extra` payload too large | Trim the extra payload; only pass fields the event actually needs |

**OX_CWD env var:** This is a test-only override that redirects all file
operations to a sandbox directory. Hooks must never set `OX_CWD` in production.
