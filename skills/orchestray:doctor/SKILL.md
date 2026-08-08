---
name: doctor
description: Run a battery of health probes for the Orchestray plugin and print a one-screen summary
disable-model-invocation: true
argument-hint: "[--verbose|-v] [--deep]"
---

# Orchestray Doctor

Run 13 probes (14 with `--deep`) against the current Orchestray installation and print a
structured health report. If `$ARGUMENTS` contains `--verbose` or `-v`, emit a
`## Detail` section after the summary.

## Setup

If `$ARGUMENTS` contains `--deep`, set `DEEP=true`. The deep probe (P10) runs after P9c
and adds per-file install-integrity verification. Without `--deep`, P10 is skipped and
behavior is identical to v2.1.2.

Resolve the **plugin root** and **project root** as follows:

- Plugin root: the directory containing Orchestray's own source files. Try these in order:
  1. Walk up from the current working directory until you find a directory containing both
     `bin/install.js` and `package.json` with `"name": "orchestray"`.
  2. Fall back to `~/.claude/orchestray` (global install path).
  Store as `PLUGIN_ROOT`.

- Project root: the current working directory (where `.orchestray/` lives, if present).
  Store as `PROJECT_ROOT`.

Read the plugin version: `cat $PLUGIN_ROOT/VERSION` (trim whitespace).
If VERSION is unreadable, use `"unknown"`.

## Probes

Run each probe in order. For each probe, record:
- status: `OK`, `WARN`, or `FAIL`
- line: the formatted one-liner (see per-probe spec below)
- error: raw error detail (used only in `--verbose` output)

If a probe times out or the underlying operation takes more than 5 seconds, mark it
`WARN` with line `[WARN]  {probe name} timed out — result may be stale`.

---

### P1: Migrations present on disk

Check whether `$PLUGIN_ROOT/bin/_lib/migrations/001-fts5-initial.js` exists and is
readable.

- Read the file using the Read tool.
- **Pass**: file exists and content is non-empty.
  Line: `[OK]    migrations present (1/1)`
- **Warn**: file exists but appears to be empty or unreadable due to permissions.
  Line: `[WARN]  migrations file unreadable (EACCES on 001-fts5-initial.js)`
- **Fail**: file does not exist.
  Line: `[FAIL]  migrations missing (001-fts5-initial.js) — reinstall via npx orchestray@latest`

---

### P2: MCP `tools/list` responds

Call `mcp__orchestray__pattern_find` with `task_summary: "doctor-probe"` and
`agent_role: "developer"`.

- **Pass**: call returns a result object (even if `matches` is empty).
  Line: `[OK]    MCP responding (pattern_find roundtrip OK)`
- **Warn**: call returns but result contains an error field.
  Line: `[WARN]  MCP tool error: {result.error or result.message} — check /mcp`
- **Fail**: the tool call itself throws or the MCP transport fails.
  Line: `[FAIL]  MCP not responding — restart Claude Code`

---

### P3: Config keys resolve (nested, not flat)

Read `$PROJECT_ROOT/.orchestray/config.json` (if present).

- If file is absent: status=OK.
  Line: `[OK]    config keys resolve (no config.json present)`
- If file is present but malformed JSON: status=FAIL.
  Line: `[FAIL]  config.json malformed: {parse error message} — runtime is on defaults`
- If file is valid JSON: scan all top-level keys for strings matching `federation.*` or
  `curator.*` (dotted flat-key notation).
  - No flat keys found: status=OK.
    Line: `[OK]    config keys resolve (no legacy flat keys)`
  - Flat keys found: status=WARN.
    Line: `[WARN]  flat keys found: [{list}] — run /orchestray:config set federation.* to migrate`
    In `--verbose` mode, list all flat keys without truncation.

---

### P4: Shared dir writable (if federation on)

Read `$PROJECT_ROOT/.orchestray/config.json`. Check `federation.shared_dir_enabled`.

- If federation is disabled (or config absent): status=OK.
  Line: `[OK]    shared dir (federation disabled; skipped)`
- If federation is enabled: resolve `shared_dir_path` (default `~/.orchestray/shared`).
  For each of `patterns/`, `kb/`, `meta/` under that path:
  - If directory missing: status=FAIL.
    Line: `[FAIL]  shared dir missing: {path} — run npx orchestray@latest to recreate`
  - If directory present but not writable (attempt to create + delete
    `.doctor-probe-{pid}` file — catch EACCES): status=WARN.
    Line: `[WARN]  shared dir not writable: {path} ({EACCES})`
  - All dirs present and writable: status=OK.
    Line: `[OK]    shared dir writable ({path})`

---

### P5: FTS5 backend loaded

Run the following one-liner via Bash in `$PLUGIN_ROOT`:

```bash
node -e "
  try {
    const m = require('./bin/_lib/pattern-index-sqlite');
    process.stdout.write('ok\\n');
  } catch(e) {
    process.stdout.write('fail:' + e.message.slice(0,200) + '\\n');
  }
"
```

- Output starts with `ok`: status=OK.
  Line: `[OK]    FTS5 backend loaded (node:sqlite or better-sqlite3)`
- Output starts with `fail:`: status=FAIL.
  Line: `[FAIL]  FTS5 backend unavailable: {message} — pattern_find runs on Jaccard (degraded)`

---

### P6: `better-sqlite3` ABI match

Only run if P5 output indicates the module loaded. Run:

```bash
node -e "
  try {
    const bs3 = require('better-sqlite3');
    process.stdout.write('ok\\n');
  } catch(e) {
    if (e.message && e.message.includes('NODE_MODULE_VERSION')) {
      process.stdout.write('abi-mismatch:' + e.message.slice(0,200) + '\\n');
    } else if (e.message && (e.message.includes('Cannot find module') || e.message.includes('MODULE_NOT_FOUND'))) {
      process.stdout.write('not-installed\\n');
    } else {
      process.stdout.write('fail:' + e.message.slice(0,200) + '\\n');
    }
  }
" 2>&1
```
from `$PLUGIN_ROOT`.

- Output is `ok`: status=OK.
  Line: `[OK]    better-sqlite3 ABI matches Node {node version from process.versions.node}`
- Output is `not-installed`: P5 likely used `node:sqlite`; status=OK.
  Line: `[OK]    better-sqlite3 (not in use; node:sqlite active)`
- Output contains `abi-mismatch`: status=FAIL.
  Line: `[FAIL]  better-sqlite3 ABI mismatch — run: cd $PLUGIN_ROOT && npm rebuild better-sqlite3`
- Other failure: status=WARN.
  Line: `[WARN]  better-sqlite3 check inconclusive: {message}`

---

### P7: Degraded journal tail

Read `$PROJECT_ROOT/.orchestray/state/degraded.jsonl` (if present).

Parse the last 20 lines as JSONL. Count entries where `ts` is within the last 24 hours.

- File absent or zero recent entries: status=OK.
  Line: `[OK]    degraded journal clean (0 entries in last 24h)`
- One or more entries in last 24 h: status=WARN.
  Line: `[WARN]  {N} silent fallback(s) in last 24h — run /orchestray:doctor --verbose for details`

In `--verbose` mode, append the last 10 journal rows to the `## Detail` section,
formatted as:
```
{ts}  {kind}  severity={severity}  {JSON.stringify(detail).slice(0, 200)}
```

---

### P8: Plugin version matches manifest

- Read `$PLUGIN_ROOT/VERSION` (trim whitespace) → `version_file`
- Read `$PLUGIN_ROOT/manifest.json` → parse JSON → `manifest`
- If manifest.json is absent: status=WARN.
  Line: `[WARN]  manifest.json absent — reinstall recommended`
- If `manifest.version !== version_file`: status=FAIL.
  Line: `[FAIL]  manifest version {manifest.version} != VERSION {version_file} — reinstall via npx orchestray@latest`
- If `manifest.version === version_file` but `manifest.files` does not include any entry
  containing `migrations/`: status=WARN.
  Line: `[WARN]  manifest.files missing migrations entry — reinstall recommended`
- All checks pass: status=OK.
  Line: `[OK]    plugin install coherent (v{version_file}, {manifest.files.length} files tracked)`

---

---

### P9: Resilience dossier + re-hydration hook (v2.1.7 Bundle D)

Check `$PROJECT_ROOT/.orchestray/state/resilience-dossier.json` and the
UserPromptSubmit injection hook presence in `$PLUGIN_ROOT/hooks/hooks.json`.

Steps:
1. Read `$PROJECT_ROOT/.orchestray/config.json`. If `resilience.enabled === false` or
   `resilience.kill_switch === true`, or env var `ORCHESTRAY_RESILIENCE_DISABLED=1` is set:
   status=OK.
   Line: `[OK]    resilience dossier (disabled by config/env; skipped)`
2. Parse `$PLUGIN_ROOT/hooks/hooks.json` and check that `UserPromptSubmit` has an entry
   whose command ends in `inject-resilience-dossier.js`. If missing: status=FAIL.
   Line: `[FAIL]  resilience injector hook not registered — run /orchestray:update`
3. Stat `$PROJECT_ROOT/.orchestray/state/resilience-dossier.json`:
   - File absent AND no `orchestration.md` present: status=OK.
     Line: `[OK]    resilience dossier (no active orchestration; skipped)`
   - File absent AND `orchestration.md` has `status: in_progress`: status=FAIL.
     Line: `[FAIL]  resilience dossier missing for live orchestration — PM is flying blind`
   - File exists but mtime > 60 min ago AND orchestration `status: in_progress`: status=WARN.
     Line: `[WARN]  resilience dossier is {mins}m stale — recent PM Stop hook may have failed`
   - File exists and recent (≤ 60 min OR `status: completed`): status=OK.
     Line: `[OK]    resilience dossier fresh ({bytes}B, written {age}s ago)`
4. If the `degraded.jsonl` tail (last 24 h) contains ≥ 3 entries with kind matching
   `/^dossier_|^compact_signal_/`: downgrade the above status to WARN.
   Line: `[WARN]  resilience dossier: {N} degraded-journal entries in last 24h — run --verbose`

---

### P9b: BDG fixture-corpus coverage

The Behavior Diff Gate is only as good as its corpus. A script whose fixtures all
fail-open reports "no behavior change" forever — a false-negative machine that looks
green while testing nothing. This probe is what keeps that visible.

Skip when `$PROJECT_ROOT/.orchestray/` does not exist.

Run from `$PLUGIN_ROOT`:

```bash
CLAUDE_PROJECT_DIR="$PROJECT_ROOT" node bin/_tools/behavior-diff.js --coverage --json
```

Parse the stdout JSON: `{scripts_with_fixtures, covered_scripts, ratio, total_fixtures,
invalid_fixtures, uncovered[]}`. Output `{"disabled":true}` means the gate is switched off.

- `disabled: true`: status=OK.
  Line: `[OK]    BDG corpus (behavior diff gate disabled; skipped)`
- `scripts_with_fixtures == 0`: status=WARN.
  Line: `[WARN]  BDG corpus empty — harvest has not run yet; the gate cannot catch anything`
- `invalid_fixtures > 0`: status=WARN.
  Line: `[WARN]  BDG corpus: {invalid_fixtures} malformed fixture(s) — a fixture must be {stdin, state}`
- `ratio < 0.5`: status=WARN.
  Line: `[WARN]  BDG corpus thin: {covered_scripts}/{scripts_with_fixtures} scripts covered — uncovered: {first 3 of uncovered}`
- Otherwise: status=OK.
  Line: `[OK]    BDG corpus: {covered_scripts}/{scripts_with_fixtures} scripts covered ({total_fixtures} fixtures)`

In `--verbose` mode, list every entry of `uncovered[]` under `## Detail`.

P9b WARN increments `N_warn`. This probe never FAILs — an empty corpus is a
"not yet useful" state, not a broken install.

---

### P9c: Dark event types (declared, never fired)

`bin/audit-promised-events.js` already computes this signal — an
`event_promised_but_dark` row per event type that is 7+ days past its first
declaration in the schema shadow, not `feature_optional`, and has fired zero
times across the full audit history — but writes it only to events.jsonl. No
prior surface ever reported it to a human. This probe is that surface.

Skip when `$PROJECT_ROOT/.orchestray/` does not exist.

Run from `$PLUGIN_ROOT`:

```bash
node bin/dark-event-banner.js --json --cwd "$PROJECT_ROOT"
```

Parse the stdout JSON: `{darkTypes: [{event_type, days_dark, total_fire_count}, ...], totalDark}`.
An `{"error": ...}` shape means the probe itself failed to run.

- Output carries an `error` key: status=WARN.
  Line: `[WARN]  dark-event probe failed: {error} — advisory only, not a broken install`
- `totalDark == 0`: status=OK.
  Line: `[OK]    dark events (0 declared types have never fired)`
- `totalDark > 0`: status=WARN.
  Line: `[WARN]  {totalDark} declared event type(s) have never fired — worst: {top 3 darkTypes as "type (Nd)", comma-joined} — see /orchestray:doctor --verbose`

In `--verbose` mode, list up to 15 entries of `darkTypes[]` under `## Detail`, one per line:
`{event_type}  {days_dark}d dark, {total_fire_count} lifetime fires`
If more than 15, append `(+{N-15} more)`.

P9c WARN increments `N_warn`. This probe never FAILs — like P9b, a nonzero
count is "worth investigating", not a broken install: some declared types are
legitimately rare (crash-only paths, admin-triggered actions), and a fresh
project with no orchestration history yet will read `totalDark: 0` correctly
rather than false-alarming.

---

### P9c2: Misshapen audit rows (`event:` instead of `type:`)

`bin/audit-pm-emit-coverage.js`'s `scanMisshapenEmits()` catches audit rows
hand-written with a bare `event:` key instead of `type:` — invisible to every
consumer that keys on `evt.type`, including P9c above. It overwrites
`.orchestray/state/misshapen-emit-state.last-run.json` on every PM Stop and
folds the signal into the SAME `dark-event-banner.js --json` output P9c
already parses (no second subprocess call — reuse the JSON captured for P9c).

Skip when `$PROJECT_ROOT/.orchestray/` does not exist (same as P9c; this
reuses P9c's invocation).

Parse `misshapenEmits: {types: [{event_name, count}, ...], total}` from the
same stdout JSON.

- `misshapenEmits.total == 0`: status=OK.
  Line: `[OK]    misshapen audit rows (0 rows shaped "event:" instead of "type:")`
- `misshapenEmits.total > 0`: status=WARN.
  Line: `[WARN]  {misshapenEmits.total} audit row(s) shaped "event:" not "type:" across {misshapenEmits.types.length} type(s) — worst: {top 3 types as "event_name (Ncount)", comma-joined} — see /orchestray:doctor --verbose`

In `--verbose` mode, list every entry of `misshapenEmits.types[]` under
`## Detail`, one per line: `{event_name}  {count} misshapen row(s)`.

P9c2 WARN increments `N_warn`. This probe never FAILs — the rows are
historical evidence, not corruption; `scanMisshapenEmits()` never mutates or
deletes them (see `.orchestray/kb/decisions/bare-event-key-hand-appends.md`).

---

### P9d: KB decision staleness

`.orchestray/kb/decisions/` is the system of record for outstanding
blockers. Three files there once sat `**Status: OPEN**` (one `OPEN,
blocking`) — titled `# OPEN: ...` — for hours after the work was already
fixed, because nothing checked title against status. This probe is the
guard: it distinguishes "nothing is open" from "most of this corpus carries
no status line at all" (both numbers must always be visible — see below),
and it detects title/status self-contradiction directly.

Skip when `$PROJECT_ROOT/.orchestray/` does not exist.

Run from `$PLUGIN_ROOT`:

```bash
node bin/_lib/kb-decision-health.js --json --cwd "$PROJECT_ROOT"
```

Parse the stdout JSON: `{total, withStatus, withoutStatus, openCount,
openDecisions: [{file, title, statusText, ageHours}, ...],
contradictions: [{file, title, statusText}, ...]}`.

- `total === 0`: status=OK.
  Line: `[OK]    KB decisions (no decisions/ directory yet; skipped)`
- `contradictions.length > 0` (checked first — this is the loud failure):
  status=FAIL.
  Line: `[FAIL]  KB decision title/status mismatch: {contradictions[0].file} (title says "{contradictions[0].title}", status says "{contradictions[0].statusText}") — fix the file{, +{N-1} more such mismatch(es) if length > 1}`
- Else `openCount > 0`: status=WARN.
  Line: `[WARN]  {openCount} open/blocking KB decision(s) ({withoutStatus}/{total} carry no status line) — oldest: {openDecisions[0].file} ({openDecisions[0].ageHours}h since last edit)`
- Else (`openCount === 0` and no contradictions): status=OK.
  Line: `[OK]    KB decisions: 0 open/blocking ({withoutStatus}/{total} carry no status line — legacy, not a failure)`

The `{withoutStatus}/{total}` fragment appears in every non-skip branch,
including the all-clear one — a reader must never see a bare "0 open" and
assume the corpus was actually checked.

In `--verbose` mode, append up to 10 entries of `openDecisions[]` (file,
statusText, ageHours) and all entries of `contradictions[]` under
`## Detail`.

P9d WARN increments `N_warn`; P9d FAIL increments `N_fail`. Files without a
status line are never mass-edited or treated as an error — 24 of 32 files in
this repo's own corpus predate the `**Status:` convention and that is
expected, not a defect.

---

### P10: Install-integrity deep verify (only when `--deep`)

Skip this probe entirely when `DEEP` is not set.

Run the following Bash one-liner from any directory:

```bash
node -e "
  const { verifyManifest } = require('$PLUGIN_ROOT/bin/_lib/install-manifest');
  const fs = require('fs');
  const path = require('path');
  const manifestPath = path.join('$PLUGIN_ROOT', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ err: 'manifest_unreadable', msg: e.message }));
    process.exit(0);
  }
  const result = verifyManifest('$PLUGIN_ROOT', manifest);
  process.stdout.write(JSON.stringify(result));
"
```

Parse the stdout JSON. Let `total = drifted.length + missing.length + errors.length`.

Output lines:

- **Error present** (`err` key in output):
  Line: `[FAIL]  manifest unreadable: {msg} — reinstall via npx orchestray@latest`
- **`supported: false`** (legacy v1 manifest or absent `files_hashes`):
  Line: `[WARN]  install integrity: legacy v1 manifest (no hashes) — reinstall to enable deep verify`
- **`ok: true`**:
  Line: `[OK]    install integrity verified ({Object.keys(manifest.files_hashes).length} files)`
- **`ok: false, total <= 3`** (small drift — list all):
  Line: `[FAIL]  install integrity drift ({total} file(s)): {comma-joined paths of drifted+missing+errors}`
- **`ok: false, total > 3`** (large drift — truncate):
  Line: `[FAIL]  install integrity drift ({total} file(s)): {first 3 paths}, +{total-3} more`

In `--verbose --deep` mode, the `## Detail` section gains an `## Install Integrity` sub-section:

```
drifted:
  {path}
    expected: {expected}
    actual:   {actual}
  ...
missing:
  {path}
  ...
errors:
  {path} ({code})
  ...
```

If a category is empty, write `  (none)` beneath its heading.
Truncate to at most 20 entries per category; append `({N} more — see journal)` if exceeded.

P10 FAIL increments `N_fail`. P10 WARN increments `N_warn`.

---

## Output format

After running all probes (12 without `--deep`, 13 with `--deep`), print:

```
Orchestray v{VERSION} — health check
──────────────────────────────────
{P1 line}
{P2 line}
{P3 line}
{P4 line}
{P5 line}
{P6 line}
{P7 line}
{P8 line}
{P9 line}
{P9b line}
{P9c line}
{P9d line}
{P10 line — only when --deep}

{N_total} probes, {N_warn} warning(s), {N_fail} failure(s).{suffix}
doctor-result-code: {code}
```

`N_total` is 12 without `--deep`, 13 with `--deep`.

Where:
- `{suffix}` is ` Run with --verbose for details.` when `N_warn + N_fail > 0` and
  the `--verbose` flag is NOT present; otherwise empty.
- `{code}` is:
  - `0` — all OK
  - `1` — at least one WARN, zero FAIL
  - `2` — at least one FAIL

If `N_fail > 0`, add a `Next steps:` block enumerating copy-pasteable remediation
commands for each failing probe (use the remediations listed in the probe specs above).

Example all-green output (without `--deep`):
```
Orchestray v2.1.3 — health check
──────────────────────────────────
[OK]    migrations present (1/1)
[OK]    MCP responding (pattern_find roundtrip OK)
[OK]    config keys resolve (no legacy flat keys)
[OK]    shared dir (federation disabled; skipped)
[OK]    FTS5 backend loaded (node:sqlite or better-sqlite3)
[OK]    better-sqlite3 (not in use; node:sqlite active)
[OK]    degraded journal clean (0 entries in last 24h)
[OK]    plugin install coherent (v2.1.3, 162 files tracked)
[OK]    BDG corpus: 12/14 scripts covered (183 fixtures)
[OK]    dark events (0 declared types have never fired)
[OK]    KB decisions: 0 open/blocking (24/32 carry no status line — legacy, not a failure)

11 probes, 0 warning(s), 0 failure(s).
doctor-result-code: 0
```

Example all-green output (with `--deep`):
```
Orchestray v2.1.3 — health check
──────────────────────────────────
[OK]    migrations present (1/1)
[OK]    MCP responding (pattern_find roundtrip OK)
[OK]    config keys resolve (no legacy flat keys)
[OK]    shared dir (federation disabled; skipped)
[OK]    FTS5 backend loaded (node:sqlite or better-sqlite3)
[OK]    better-sqlite3 (not in use; node:sqlite active)
[OK]    degraded journal clean (0 entries in last 24h)
[OK]    plugin install coherent (v2.1.3, 162 files tracked)
[OK]    BDG corpus: 12/14 scripts covered (183 fixtures)
[OK]    dark events (0 declared types have never fired)
[OK]    KB decisions: 0 open/blocking (24/32 carry no status line — legacy, not a failure)
[OK]    install integrity verified (162 files)

12 probes, 0 warning(s), 0 failure(s).
doctor-result-code: 0
```

## `--verbose` detail section

When `--verbose` or `-v` is present, append a `## Detail` section after the summary:

- **P3 flat keys**: full list of flat keys found (no truncation).
- **P7 journal**: last 10 journal rows, one per line:
  `{ts}  {kind}  severity={severity}  {JSON.stringify(detail).slice(0, 200)}`
- **P9d open decisions + contradictions**: as described under P9d above.
- **Any FAIL probe**: the raw error message and, if available, the first 5 lines of the
  stack trace.

## Special case: no `.orchestray/` directory

If `$PROJECT_ROOT/.orchestray/` does not exist at all, emit before the probe list:
```
[WARN]  no .orchestray/ directory — run from a project root or run /orchestray:run first
```
Then skip P3, P4, P7, P9b, P9c, P9d (project-scoped probes) and run P1, P2, P5, P6, P8 only.
Adjust totals accordingly.
