---
name: rollback
description: Roll back files to their pre-agent snapshots. List snapshots or restore a specific file.
disable-model-invocation: true
argument-hint: "[<path> [--spawn <spawn_id>]]"
---

# Workspace Snapshot Rollback

The user wants to list or restore pre-write file snapshots captured by the snapshot hook.

Snapshots live in `.orchestray/snapshots/<orchestration_id>/<spawn_id>/`.
Each snapshot file is named `<sanitized-path>.snapshot` where the original absolute
path has its `/` characters replaced with `__` and leading separators stripped.

## Protocol

### Step 1 — Locate the snapshot root

```bash
ls .orchestray/snapshots/
```

If `.orchestray/snapshots/` does not exist or is empty, report:
"No snapshots found. Snapshots are captured automatically when agents write files during an orchestration."
Then stop.

Determine the active orchestration ID:
- Read `.orchestray/audit/current-orchestration.json` → `orchestration_id`.
- If absent, use the most recently modified directory under `.orchestray/snapshots/`.

Set `ORCH_DIR=.orchestray/snapshots/<orchestration_id>`.

---

### No-argument invocation — List all snapshots

When the user runs `/orchestray:rollback` with no arguments:

1. Find all `.snapshot` files under `ORCH_DIR`:

```bash
find .orchestray/snapshots/<orchestration_id> -name "*.snapshot" -printf "%T@ %p\n" | sort -n
```

2. For each snapshot, derive the original path by reversing the sanitization:
   - Strip the `.snapshot` suffix from the filename
   - Replace `__` with `/`
   - Prepend `/` to restore the absolute path

3. Display a table:

```
## Workspace Snapshots — <orchestration_id>

| Spawn ID | Agent | Original Path | Snapshot Time |
|----------|-------|---------------|---------------|
| pid-1234 | developer | /home/user/project/src/foo.ts | 2026-04-28T13:45:00Z |
| pid-1234 | developer | /home/user/project/src/bar.ts | 2026-04-28T13:45:01Z |
```

Derive the agent type by reading the `spawn_id` directory name and, if available, the
`snapshot_captured` events in `.orchestray/audit/events.jsonl` for the same `spawn_id`.
Fall back to "unknown" if events are unavailable.

Derive snapshot time from the file mtime (use `stat -c %y <file>` or the `find -printf "%T@"` output).

4. End with:
"To restore a file: `/orchestray:rollback <original-path>`
To restore from a specific spawn: `/orchestray:rollback <original-path> --spawn <spawn_id>`"

---

### `/orchestray:rollback <path>` — Restore most recent snapshot for a path

Parse the user's argument as `<path>` (absolute or relative to project root).
Resolve to an absolute path.

1. Compute the sanitized filename:
   - Strip leading `/`
   - Replace `/` with `__`
   - Truncate to 200 chars if longer
   - Append `.snapshot`

2. Find all matching snapshots:

```bash
find .orchestray/snapshots/<orchestration_id> -name "<sanitized>.snapshot"
```

3. If no matches found, report:
"No snapshot found for `<path>` in the current orchestration (`<orchestration_id>`).
Snapshots are only kept for the duration of the orchestration. Run `/orchestray:rollback` to list available snapshots."
Then stop.

4. If multiple matches (from different spawns), select the most recently modified one
   (use `ls -t` or `find ... -printf "%T@ %p\n" | sort -rn | head -1`).

   To select a specific spawn's snapshot, use `--spawn <spawn_id>` — see below.

5. Confirm with the user before overwriting:

```
Restore `.orchestray/snapshots/<orchestration_id>/<spawn_id>/<sanitized>.snapshot`
  → `<original-path>`

Snapshot taken: <mtime>
Current file mtime: <current mtime>

Proceed? (yes/no)
```

6. On yes — restore the file:

```bash
cp .orchestray/snapshots/<orchestration_id>/<spawn_id>/<sanitized>.snapshot <original-path>
```

7. Emit a `rollback_applied` event by appending to `.orchestray/audit/events.jsonl`
   via the writeEvent gateway. Use `node bin/audit-event.js` or construct and append
   the JSON record directly:

```json
{
  "type": "rollback_applied",
  "version": 1,
  "schema_version": 1,
  "timestamp": "<ISO 8601>",
  "orchestration_id": "<orchestration_id>",
  "spawn_id": "<spawn_id>",
  "agent_type": "<agent_type>",
  "path": "<original-path>",
  "source": "user_skill"
}
```

   Simplest approach — append directly using node inline:

```bash
node -e "
const fs = require('fs');
const p = '.orchestray/audit/events.jsonl';
fs.mkdirSync('.orchestray/audit', { recursive: true });
const ev = {
  type: 'rollback_applied',
  version: 1,
  schema_version: 1,
  timestamp: new Date().toISOString(),
  orchestration_id: '<orchestration_id>',
  spawn_id: '<spawn_id>',
  agent_type: '<agent_type>',
  path: '<original-path>',
  source: 'user_skill'
};
fs.appendFileSync(p, JSON.stringify(ev) + '\n', 'utf8');
console.log('rollback_applied event written');
"
```

8. Report success:
"Restored `<original-path>` from snapshot (spawn `<spawn_id>`)."

---

### `/orchestray:rollback <path> --spawn <spawn_id>` — Restore specific spawn's snapshot

Same as above, but:
- Use `SPAWN_DIR=.orchestray/snapshots/<orchestration_id>/<spawn_id>/`
- Look for `<sanitized>.snapshot` directly in that directory.
- If not found, report: "No snapshot for `<path>` from spawn `<spawn_id>`."

---

## Kill-switch / Error cases

- If `ORCHESTRAY_DISABLE_SNAPSHOTS=1` is set in the environment, report:
  "Snapshots are disabled (`ORCHESTRAY_DISABLE_SNAPSHOTS=1`). No rollback available."

- If `.orchestray/config.json` has `snapshots.enabled: false`, report:
  "Snapshots are disabled in config (`snapshots.enabled: false`). No rollback available."

- If the snapshot file is missing (evicted by the 50 MB cap), report:
  "Snapshot for `<path>` was evicted (disk cap). The original file cannot be restored from snapshot."

- On any `cp` failure, report the error and do NOT emit the `rollback_applied` event.
