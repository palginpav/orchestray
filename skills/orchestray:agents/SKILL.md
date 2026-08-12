---
name: agents
description: List agents from the lifecycle registry with resolved model, cost, and status
disable-model-invocation: true
argument-hint: "[--all] [N]"
---

# Orchestray Agents

Read-only listing of the agent lifecycle registry (`.orchestray/state/agent-registry.jsonl`,
introduced v2.3.26 W2/W4). This command surfaces two things that were previously invisible:
which model actually ran each agent, and whether that model/cost is **resolved** (captured
at spawn time from the real tool call) or **estimated** (a Sonnet-rate fallback guess because
attribution failed). There is no control surface here — no stop, dismiss, or restart. Those
tools (`TaskStop`, `SendMessage`, `ListAgents`) are unavailable to plugins in this
environment; do not imply otherwise in any output.

## Setup

Resolve `PLUGIN_ROOT` and `PROJECT_ROOT` exactly as `/orchestray:doctor` does:

- `PLUGIN_ROOT`: walk up from cwd until a directory contains both `bin/install.js` and a
  `package.json` with `"name": "orchestray"`; fall back to `~/.claude/orchestray`.
- `PROJECT_ROOT`: the current working directory.

## Parse arguments

`$ARGUMENTS`:
- `--all`: show every row in the registry (including terminal `dismissed`/`abandoned`
  states), no cap.
- A bare integer `N`: cap the listing at `N` rows (most recent first).
- Neither: default cap of 20 rows, most recent first, all statuses included (registry rows
  are typically few enough that hiding terminal states by default would just confuse "why
  isn't my agent here").
- Both may be combined (`--all 50` caps `--all` output at 50 instead of unlimited).

## Run

Execute the following from `PROJECT_ROOT`, substituting the resolved `PLUGIN_ROOT`:

```bash
node <<'EOF'
'use strict';
const fs = require('fs');
const path = require('path');

const PLUGIN_ROOT = process.env.ORCHESTRAY_PLUGIN_ROOT || '<PLUGIN_ROOT>';
const PROJECT_ROOT = process.cwd();

let readRegistry, deriveRosterName;
try {
  ({ readRegistry, deriveRosterName } = require(path.join(PLUGIN_ROOT, 'bin/_lib/agent-registry')));
} catch (e) {
  console.log(JSON.stringify({ error: 'agent-registry module unavailable: ' + e.message }));
  process.exit(0);
}

function readRawLines(p) {
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_e) { return []; }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean);
}

const registryPath = path.join(PROJECT_ROOT, '.orchestray', 'state', 'agent-registry.jsonl');
const registryExists = fs.existsSync(registryPath);

const { byId, pending, counts } = readRegistry(PROJECT_ROOT, {});

// The fold overwrites `ts` with the latest transition's timestamp, so recover
// the first `running` ts per agent_id from a raw scan to report a start time.
const startTs = new Map();
for (const line of readRawLines(registryPath)) {
  try {
    const row = JSON.parse(line);
    if (row && row.agent_id && row.event === 'running' && !startTs.has(row.agent_id)) {
      startTs.set(row.agent_id, row.ts || null);
    }
  } catch (_e) { /* skip malformed line */ }
}

// agent_metrics.jsonl is the ground truth for cost_confidence (resolved vs
// estimated) and model_used — the registry row only carries what was known
// at spawn time, the metrics row carries what was resolved at stop time.
const metricsPath = path.join(PROJECT_ROOT, '.orchestray', 'metrics', 'agent_metrics.jsonl');
const metricsByAgent = new Map();
for (const line of readRawLines(metricsPath)) {
  try {
    const row = JSON.parse(line);
    if (row && row.row_type === 'agent_spawn' && row.agent_id) {
      metricsByAgent.set(row.agent_id, row); // later rows win (file is append order)
    }
  } catch (_e) { /* skip malformed line */ }
}

const TERMINAL = new Set(['dismissed', 'abandoned']);

const rows = [];
for (const [agentId, row] of byId.entries()) {
  const metrics = metricsByAgent.get(agentId) || null;
  rows.push({
    agent_id: agentId,
    roster_name: row.roster_name || deriveRosterName(agentId),
    agent_type: row.agent_type || (metrics && metrics.agent_type) || null,
    task_id: row.task_id || null,
    model: (metrics && metrics.model_used) || row.model || null,
    status: row.event,
    start_ts: startTs.get(agentId) || null,
    stop_ts: (row.event === 'completed' || row.event === 'resumed' || TERMINAL.has(row.event)) ? row.ts : null,
    cost_confidence: metrics ? metrics.cost_confidence : null,
    cost_usd: metrics ? metrics.estimated_cost_usd : (row.estimated_cost_usd != null ? row.estimated_cost_usd : null),
    sort_ts: row.ts || startTs.get(agentId) || '',
  });
}
for (const [, row] of pending.entries()) {
  rows.push({
    agent_id: null,
    roster_name: null,
    agent_type: row.agent_type || null,
    task_id: row.task_id || null,
    model: row.model || null,
    status: 'registered (pending start)',
    start_ts: row.ts || null,
    stop_ts: null,
    cost_confidence: null,
    cost_usd: null,
    sort_ts: row.ts || '',
  });
}

rows.sort((a, b) => (b.sort_ts || '').localeCompare(a.sort_ts || ''));

console.log(JSON.stringify({ registryExists, counts, rows }));
EOF
```

Parse the single JSON line printed to stdout.

## Display

**If `registryExists` is `false` and `rows.length === 0`:**

```
## Agents

No agent lifecycle registry found at .orchestray/state/agent-registry.jsonl.
This is expected on a fresh install, or if no agent has spawned yet under this
project root, or if agent_lifecycle is disabled (ORCHESTRAY_DISABLE_AGENT_LIFECYCLE=1,
ORCHESTRAY_AGENT_REGISTRY_DISABLED=1, or agent_lifecycle.enabled: false in
.orchestray/config.json). Run an orchestration, then re-run /orchestray:agents.
```

Stop here — do not print an empty table.

**If `registryExists` is `true` but `rows.length === 0`:** same message, but drop
"No agent lifecycle registry found..." and replace with "Registry exists but is empty."

**Otherwise**, apply the requested cap (default 20, or `N` from arguments; `--all`
removes the cap) to the sorted `rows` array — most recent first — and render:

```
## Agents

{if capped and more rows exist: "Showing {shown} of {total} agent(s) (most recent first). Use --all to see everything."}

| Agent | Type | Task | Model | Cost | Status | Start | Stop |
|-------|------|------|-------|------|--------|-------|------|
| {roster_name or agent_id or "(pending)"} | {agent_type or "—"} | {task_id or "—"} | {model or "unresolved"} | {cost_usd formatted to 4dp, prefixed "~$", or "—" if null}{" (est.)" if cost_confidence !== "measured" and cost_usd is not null} | {status} | {start_ts or "—"} | {stop_ts or "—"} |
...

## Summary

| Metric | Value |
|--------|-------|
| Agents shown | {shown} |
| Agents in registry (all statuses) | {total} |
| Registered / running / completed / resumed / dismissed / abandoned | {counts.registered} / {counts.running} / {counts.completed} / {counts.resumed} / {counts.dismissed} / {counts.abandoned} |
| Total cost (shown rows) | ~${sum of cost_usd across shown rows, 4dp} |
| Resolved cost | ~${sum of cost_usd where cost_confidence === "measured", 4dp} ({pct of total cost, 1dp}%) |
| Estimated cost | ~${sum of cost_usd where cost_confidence !== "measured" (including null), 4dp} ({pct of total cost, 1dp}%) |
```

Compute the resolved/estimated cost split and percentages over `shown` rows (the same
set rendered in the table), not the full unfiltered registry — the two numbers must be
mutually consistent with what the user is looking at.

If every shown row has `cost_usd === null` (no `.orchestray/metrics/agent_metrics.jsonl`
data joined), omit the Total/Resolved/Estimated cost lines and add instead:
"No cost data joined (agent_metrics.jsonl absent or no matching agent_id rows)."

Do not add a "Next steps" or capability-suggesting footer (no stop/restart/dismiss
affordance exists). If a WARN is warranted, use `/orchestray:doctor` phrasing style,
but there is no failure mode defined for this command beyond the empty-registry case
above — this command reads and formats only.
