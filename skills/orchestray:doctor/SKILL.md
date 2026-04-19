---
name: doctor
description: Run a battery of health probes for the Orchestray plugin and print a one-screen summary
disable-model-invocation: true
argument-hint: "[--verbose|-v]"
---

# Orchestray Doctor

Run 8 probes against the current Orchestray installation and print a structured health report.
If `$ARGUMENTS` contains `--verbose` or `-v`, emit a `## Detail` section after the summary.

## Setup

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

## Output format

After running all 8 probes, print:

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

{N_total} probes, {N_warn} warning(s), {N_fail} failure(s).{suffix}
doctor-result-code: {code}
```

Where:
- `{suffix}` is ` Run with --verbose for details.` when `N_warn + N_fail > 0` and
  the `--verbose` flag is NOT present; otherwise empty.
- `{code}` is:
  - `0` — all OK
  - `1` — at least one WARN, zero FAIL
  - `2` — at least one FAIL

If `N_fail > 0`, add a `Next steps:` block enumerating copy-pasteable remediation
commands for each failing probe (use the remediations listed in the probe specs above).

Example all-green output:
```
Orchestray v2.1.2 — health check
──────────────────────────────────
[OK]    migrations present (1/1)
[OK]    MCP responding (pattern_find roundtrip OK)
[OK]    config keys resolve (no legacy flat keys)
[OK]    shared dir (federation disabled; skipped)
[OK]    FTS5 backend loaded (node:sqlite or better-sqlite3)
[OK]    better-sqlite3 (not in use; node:sqlite active)
[OK]    degraded journal clean (0 entries in last 24h)
[OK]    plugin install coherent (v2.1.2, 158 files tracked)

8 probes, 0 warning(s), 0 failure(s).
doctor-result-code: 0
```

## `--verbose` detail section

When `--verbose` or `-v` is present, append a `## Detail` section after the summary:

- **P3 flat keys**: full list of flat keys found (no truncation).
- **P7 journal**: last 10 journal rows, one per line:
  `{ts}  {kind}  severity={severity}  {JSON.stringify(detail).slice(0, 200)}`
- **Any FAIL probe**: the raw error message and, if available, the first 5 lines of the
  stack trace.

## Special case: no `.orchestray/` directory

If `$PROJECT_ROOT/.orchestray/` does not exist at all, emit before the probe list:
```
[WARN]  no .orchestray/ directory — run from a project root or run /orchestray:run first
```
Then skip P3, P4, P7 (project-scoped probes) and run P1, P2, P5, P6, P8 only.
Adjust totals accordingly.
