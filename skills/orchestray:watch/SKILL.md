---
name: watch
description: Live-tail the currently running orchestration (Ctrl-C to exit)
disable-model-invocation: true
argument-hint: 
---

# Orchestration Live-Tail

The user wants to watch live progress of an orchestration as it runs.

## Protocol

1. **Locate the events file**: The poller resolves this automatically.
   Priority order:
   - `.orchestray/audit/events.jsonl` (live, active orchestration)
   - Most recent `.orchestray/history/orch-*-*/events.jsonl` (last completed run)

2. **Start the background poller**: Use the `Bash` tool with `run_in_background: true`
   to launch the Node.js poller:

   ```bash
   node bin/watch-events.js
   ```

   The poller polls every 2 seconds (hard-coded; not configurable).

3. **Tell the user**: After spawning, inform them:

   ```
   Live-tailing orchestration events. Press Ctrl-C to stop.

   Each line is prefixed HH:MM:SS (local time). Event key:
     orchestration_start — shows orchestration id and task
     agent_start / agent_stop — shows agent type, wave id (if present), turns, cost
     routing_outcome — shows agent, model, token counts (error rows suppressed)
     wave_complete / w_item_complete — shows wave id and test delta
     orchestration_complete — shows final verdict and total cost, then exits
     unknown events — shows type and compact JSON
   ```

4. **Exit conditions** (handled automatically by the poller; no user action needed):
   - `orchestration_complete` event is encountered → poller exits 0
   - Events file disappears (orchestration archived) → poller exits 0
   - User presses Ctrl-C → Bash tool handles SIGINT → poller exits 0

5. **No active orchestration**: If `.orchestray/` does not exist at all, report:
   "No orchestration found. Use `/orchestray:run [task]` to start one, then run
   `/orchestray:watch` to tail its progress."

   If the directory exists but no `events.jsonl` is present anywhere (neither live
   nor in history), report:
   "No events file found yet. The poller will start and wait for the file to appear.
   Press Ctrl-C to cancel."
   Then proceed to spawn the poller anyway — it will wait silently until the file appears.
