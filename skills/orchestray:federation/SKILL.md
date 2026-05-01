---
name: federation
description: Show federation status, shared tier contents, and recent activity
disable-model-invocation: true
argument-hint: "status"
---

# Federation Status

The user wants to check the federation state for this project.

## Protocol

### Step 0 — Parse arguments

`$ARGUMENTS` must be `status` (the only supported subcommand).

If `$ARGUMENTS` is empty or anything other than `status`, emit:

```
Usage: /orchestray:federation status
  status — show federation state, shared tier contents, and recent activity

To enable or disable federation, use:
  /orchestray:config set federation.shared_dir_enabled true   (or false)

To inspect the shared directory directly: ls ~/.orchestray/shared/patterns/
```

Then stop.

### Step 1 — Load federation config

```js
const { loadFederationConfig } = require('./bin/_lib/config-schema.js');
const fedCfg = loadFederationConfig(process.cwd());
// Fields: shared_dir_enabled (boolean), sensitivity (string), shared_dir_path (string|undefined)
```

### Step 2 — Branch on `shared_dir_enabled`

If `fedCfg.shared_dir_enabled === false` (the default), emit **State B** and stop:

```
Federation: DISABLED
  To enable:    /orchestray:config set federation.shared_dir_enabled true
  Shared-dir path (unused):  ~/.orchestray/shared/   (would be used if enabled)
  sensitivity:  <fedCfg.sensitivity>   (promotion blocked even if enabled)

No shared-tier data read.
```

Replace `<fedCfg.sensitivity>` with the actual value (default: `private`).

### Step 3 — Resolve shared dir path and check access

```js
const { getSharedPatternsDir } = require('./bin/mcp-server/lib/paths.js');
const fs = require('node:fs');
const nodePath = require('node:path');

const sharedPatternsDir = process.env.ORCHESTRAY_TEST_SHARED_DIR
  ? nodePath.join(process.env.ORCHESTRAY_TEST_SHARED_DIR, 'patterns')
  : getSharedPatternsDir();
```

Check whether `sharedPatternsDir` exists and is writable:

```js
let dirExists = false;
let dirWritable = false;
try {
  fs.accessSync(sharedPatternsDir, fs.constants.F_OK);
  dirExists = true;
  fs.accessSync(sharedPatternsDir, fs.constants.W_OK);
  dirWritable = true;
} catch (_) {}
```

If `!dirExists`, emit **State C** and stop:

```
Federation: ENABLED (partial — shared_dir not accessible)
  shared_dir:   ~/.orchestray/shared/   (does NOT exist — no shares have happened from this machine yet)
  sensitivity:  <fedCfg.sensitivity>
  project-id:   <projectHash>

To initialize:
  /orchestray:config set federation.sensitivity shareable
  /orchestray:learn share <some-local-slug>

(Sharing the first pattern creates the directory. Until then, pattern_find's shared tier
 is effectively empty — retrieval still works, it just returns local-tier only.)
```

### Step 4 — Compute project hash

```js
const { _projectHash } = require('./bin/_lib/shared-promote.js');
const projectHash = _projectHash(process.cwd());
```

### Step 5 — Glob and parse shared patterns

```js
const sharedFiles = fs.readdirSync(sharedPatternsDir)
  .filter(f => f.endsWith('.md'))
  .map(f => nodePath.join(sharedPatternsDir, f));
```

For each file, parse frontmatter to extract `promoted_from` and `promoted_at`.
Group patterns into two buckets:
- **this project**: `promoted_from === projectHash`
- **other projects**: group by `promoted_from`

Compute total size:
```js
const totalBytes = sharedFiles.reduce((acc, f) => acc + fs.statSync(f).size, 0);
const totalKb = Math.round(totalBytes / 1024);
```

### Step 6 — Collision scan

For each shared pattern file (slug = filename without `.md`), check whether
`.orchestray/patterns/<slug>.md` exists in the current project. If it does,
record a collision:

```js
const collisions = [];
for (const f of sharedFiles) {
  const slug = nodePath.basename(f, '.md');
  const localPath = nodePath.join(process.cwd(), '.orchestray', 'patterns', slug + '.md');
  if (fs.existsSync(localPath)) {
    const sharedFm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
    collisions.push({ slug, promoted_from: sharedFm.promoted_from || 'unknown' });
  }
}
```

Local patterns take precedence over shared patterns when slugs collide — this is the
`pattern_find` resolution order.

### Step 7 — FTS5 backend probe

Probe via the existing `searchPatterns` export:

```js
const { searchPatterns, UNAVAILABLE } = require('./bin/_lib/pattern-index-sqlite.js');
let fts5Status;
try {
  const probeResult = searchPatterns(' ', { projectRoot: process.cwd(), limit: 1 });
  if (probeResult === UNAVAILABLE || (Array.isArray(probeResult) && probeResult[0] === UNAVAILABLE)) {
    fts5Status = 'jaccard fallback';
  } else {
    fts5Status = 'loaded (node:sqlite or better-sqlite3)';
  }
} catch (e) {
  fts5Status = 'jaccard fallback (probe error: ' + e.message + ')';
}
```

Note: this may create `.orchestray/patterns.db` on first call — that is the expected
lazy-init side effect of any `pattern_find` run on this project and is acceptable.

### Step 8 — Recent activity

**Last promote:** Read last 1 KB of `~/.orchestray/shared/meta/promote-log.jsonl` (best-effort):

```js
const os = require('node:os');
const logPath = nodePath.join(os.homedir(), '.orchestray', 'shared', 'meta', 'promote-log.jsonl');
let lastPromote = null;
try {
  const logContent = fs.readFileSync(logPath, 'utf8');
  const lines = logContent.trim().split('\n').filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine) lastPromote = JSON.parse(lastLine);
} catch (_) {}
```

**Last pattern_find:** Scan `.orchestray/history/` for the most recent `events.jsonl`,
find the last event of type `mcp_tool_call` with tool `pattern_find` or event type
`pattern_find`:

```js
const historyDir = nodePath.join(process.cwd(), '.orchestray', 'history');
let lastPatternFind = null;
try {
  const orchDirs = fs.readdirSync(historyDir)
    .map(d => ({ name: d, mtime: fs.statSync(nodePath.join(historyDir, d)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (orchDirs.length > 0) {
    const eventsFile = nodePath.join(historyDir, orchDirs[0].name, 'events.jsonl');
    const eventsContent = fs.readFileSync(eventsFile, 'utf8');
    const events = eventsContent.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const pfEvents = events.filter(e =>
      e.type === 'pattern_find' ||
      (e.type === 'mcp_tool_call' && e.tool === 'pattern_find')
    );
    if (pfEvents.length > 0) lastPatternFind = pfEvents[pfEvents.length - 1];
  }
} catch (_) {}
```

Compute elapsed minutes:
```js
function _minutesAgo(isoStr) {
  const ms = Date.now() - new Date(isoStr).getTime();
  return Math.round(ms / 60000);
}
```

### Step 8.5 — Count local-only patterns (R-FED-PRIVACY, v2.1.13)

Patterns in `.orchestray/patterns/` tagged with `sharing: local-only` in
frontmatter will never leave this machine regardless of project-level
federation settings. Count them so the user can see how many patterns are
pinned local:

```js
const localPatternsDir = nodePath.join(process.cwd(), '.orchestray', 'patterns');
let localOnlyCount = 0;
try {
  const { parse: parseFm } = require('./bin/mcp-server/lib/frontmatter.js');
  const localFiles = fs.readdirSync(localPatternsDir).filter((f) => f.endsWith('.md'));
  for (const f of localFiles) {
    try {
      const content = fs.readFileSync(nodePath.join(localPatternsDir, f), 'utf8');
      const parsed = parseFm(content);
      if (parsed.hasFrontmatter && parsed.frontmatter.sharing === 'local-only') {
        localOnlyCount++;
      }
    } catch (_) { /* best-effort */ }
  }
} catch (_) { /* patterns dir missing — no local-only */ }
```

Absent `sharing` key is treated as `federated` (backward-compat) — only
explicit `sharing: local-only` is counted.

### Step 9 — Render State A

Emit the full status report:

```
Federation: ENABLED
  shared_dir:    ~/.orchestray/shared/  (<exists_writable>)
  sensitivity:   <sensitivity>   <sensitivity_note>
  project-id:    <projectHash>    (this project's stable hash)
  fts5 backend:  <fts5Status>
  local-only patterns: <localOnlyCount>   (pinned to this machine — never promoted)

Shared tier contents (<N> patterns, <totalKb> KB):
  Promoted by this project (<ownCount>):
    <slug>        promoted <date>
    ...
  Promoted by other projects (<otherCount>):
    from <hash>:  <N> patterns
    ...
  (No shared patterns yet.)       ← only when N=0

<Collisions block — omit entirely if collisions is empty>
Collisions (<count>):
  <slug>       local wins over shared copy (from <hash>)

Recent activity:
  Last promote:      <promoted_at>  (<slug>, <this project / from hash>)
  Last promote:      (none)         ← when promote-log is empty
  Last pattern_find: <N>m ago  (<shared_count> shared matches surfaced)
  Last pattern_find: (none recorded in recent history)
```

Notes for rendering:
- `<exists_writable>`: `(exists, writable)`, `(exists, NOT writable)`, or `(does NOT exist)`.
- `<sensitivity_note>`: for `shareable` add `(this project may promote)`;
  for `private` add `(promotion blocked)`.
- For `Promoted by this project`: list each slug + `promoted_at` date (YYYY-MM-DD).
- For `Promoted by other projects`: group by `promoted_from` hash, show count per origin.
- Omit the `Collisions` block entirely when there are no collisions.
- For `Last promote` from this project, note `(this project)`; otherwise note `(from <hash>)`.
- For `Last pattern_find` timing: use `<N>m ago` for < 60 min, `<H>h ago` for < 24 h,
  `<date>` for older. If no event found: `(none recorded in recent history)`.
- If any read step fails (file not found, JSON parse error), emit a single inline warning
  on that line and continue — the status command is read-only and best-effort.

---

_`enable`, `disable`, `check`, and `doctor` subcommands are not yet implemented. Use `/orchestray:config set federation.shared_dir_enabled true` to enable federation._
