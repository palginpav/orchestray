---
name: run
description: Trigger multi-agent orchestration on a task
disable-model-invocation: true
argument-hint: "[--preview] [task description]"
---

# Orchestrate Task

You received this because the user invoked `/orchestray:run`. v2.2.4 fixes the
escalate-path topology: the slash command (depth 0) now dispatches directly.
pm-router handles solo-only path. PM is always spawned at depth 1 with full
Agent toolkit.

<!-- Strip "--preview" from the raw arguments to get the actual task description. -->

## Task

$ARGUMENTS

## Routing Protocol

### Step 1 — Read config

Read `.orchestray/config.json` if it exists. Extract:
- `pm_router.enabled` (default `true`)
- env var `ORCHESTRAY_DISABLE_PM_ROUTER`

### Step 2 — Bypass check

If `pm_router.enabled === false` OR env `ORCHESTRAY_DISABLE_PM_ROUTER=1`:
skip to **Direct Escalation** below.

### Step 3 — Compute routing decision via predicate helper

Run:

```bash
echo "$ARGUMENTS" | node "${CLAUDE_PLUGIN_ROOT}/bin/_lib/pm-router-cli.js"
```

This prints one JSON line: `{"decision":"solo"|"escalate"|"decline", "reason":"...", "lite_score":N}`.

If the Bash call fails (non-zero exit, no output, or malformed JSON): treat as
`{"decision":"escalate","reason":"parse_error_fail_safe","lite_score":0}`.

Note: `--preview` in `$ARGUMENTS` always forces `decision: "escalate"` (handled
inside `decideRoute()`).

After parsing the JSON output, set these variables for use in Step 4:
- `ROUTE_DECISION` = the `decision` field from JSON
- `ROUTE_REASON` = the `reason` field from JSON
- `LITE_SCORE` = the `lite_score` field from JSON

When substituting these into Bash commands below, inline the resolved values
directly — do not pass unresolved shell variable names (the model emits the Bash
call as a string; substitute the actual values inline).

### Step 4 — Branch on decision

**`decline`:**
Print: `Router: declined — <reason>. No action taken.`
Stop. No agent spawn.

**`solo`:**
Spawn pm-router for solo execution:

```
Agent(
  subagent_type="pm-router",
  model="haiku",
  effort="low",
  description="Route /orchestray:run task solo (haiku/low)",
  prompt=$ARGUMENTS
)
```

Return pm-router's output verbatim. The router's solo path handles the task and
emits `pm_router_solo_complete` via SubagentStop hook.

**`escalate`** (or bypass path):
Spawn PM directly at depth 1:

```
Agent(
  subagent_type="pm",
  model="opus",
  effort="high",
  description="Orchestrate /orchestray:run task (opus/high)",
  prompt=$ARGUMENTS
)
```

After the PM agent completes, emit audit event by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/_lib/emit-slash-escalation.js" \
  --reason "$ROUTE_REASON" \
  --lite-score "$LITE_SCORE" \
  --task "$ARGUMENTS"
```

(See §Audit Events below for `emit-slash-escalation.js` design.)

Return PM's output verbatim.

### Direct Escalation (bypass path)

When router is disabled (Step 2 short-circuits), spawn PM directly — same call
as `escalate` above. No predicate run, no pm-router spawn.

Because Step 3 was skipped, set these values before emitting the audit event:
- `ROUTE_REASON` = `"router_disabled"`
- `LITE_SCORE` = `0`

Then emit the audit event after PM completes, using those hardcoded values
substituted inline into the Bash invocation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/_lib/emit-slash-escalation.js" \
  --reason "router_disabled" \
  --lite-score 0 \
  --task "$ARGUMENTS"
```

### Other slash commands unchanged

`/orchestray:resume`, `/orchestray:redo`, `/orchestray:issue`, `/orchestray:review-pr`,
`/orchestray:feature`, `/orchestray:learn`, `/orchestray:learn-doc` continue
to invoke `pm` directly. Only `/orchestray:run` uses this dispatch logic.

## Output

Return spawned agent output verbatim.

---

<!-- PREVIEW MODE — if "--preview" appeared in $ARGUMENTS, the predicate forces
escalate, so the PM handles preview rendering per pm.md §PREVIEW section.
No special handling here beyond stripping "--preview" from the prompt before
passing to the PM — the predicate does this stripping. -->
