---
name: update
description: Update Orchestray to the latest version
disable-model-invocation: true
argument-hint: "[--check]"
---

# Update Orchestray

The user wants to check for or apply updates to their Orchestray installation.

## Protocol

1. **Parse arguments**: `$ARGUMENTS`
   - If `--check` is present: only check for updates, do not install.

2. **Detect installations**: Look for VERSION files at both candidate install paths.
   - Check `~/.claude/orchestray/VERSION` (global install).
   - Check `.claude/orchestray/VERSION` in the current working directory (local install).
   - Build a list `{installs}` of every install that exists, recording for each: `{scope}` (`--global` or `--local`), `{path}` (the VERSION file's parent directory), and `{current}` (the trimmed VERSION contents).
   - If `{installs}` is empty: report "Orchestray installation not found. Install with `npx orchestray --global` or `npx orchestray --local`." and stop.

3. **Check for updates**: Run `npm view orchestray version` to get `{latest}`.
   - If the command fails: report "Could not check npm registry. Check your internet connection." and stop.
   - For each install in `{installs}`, compare its `{current}` to `{latest}`. Build `{stale}` = the installs whose `{current}` differs from `{latest}`.
   - If `{stale}` is empty: report "Orchestray is up to date (v{latest}) — checked: <list of scopes>." and stop.
   - Otherwise: report each stale install on its own line — "Update available [<scope>]: v{current} -> v{latest}".
   - If `--check` flag was provided: stop here.

4. **Perform updates** — update EVERY stale install, not just the active one. Per project rule `feedback_update_both_installs.md`: when both installs exist, BOTH must be brought to the latest version. The "active" install is whichever Claude Code happens to load first; leaving the other behind silently regresses behavior on the next switch.
   - For each install in `{stale}` (sequentially, in order: `--global` first, then `--local`):
     - Run `npx orchestray@latest {scope}`.
     - If the command fails: report "Update failed for {scope}. Try manually: `npx orchestray@latest {scope}`" and continue with the next stale install (do not abort the whole sweep — partial success is better than no progress).
     - Read the corresponding VERSION file again to confirm `{new}`.
     - Record per-install result: success with `{new}`, or failure with reason.
   - After the sweep, report a one-line summary per install: "Updated [<scope>] from v{current} to v{new}." or "Failed [<scope>]: <reason>."

5. **Show changelog**: From the source repo if running inside the Orchestray source tree (`./CHANGELOG.md`), or from the install copy at `<path>/CHANGELOG.md` for the FIRST successfully-updated install in `{stale}`. The install bundle does not always include `CHANGELOG.md`; if the file is missing in every candidate location, report "Changelog not bundled in install. See https://github.com/palginpav/orchestray/blob/master/CHANGELOG.md" and continue.
   - If found: read and display only the section for version `{new}` (from `## [{new}]` or `## v{new}` heading to the next `## ` heading).
   - Always remind the user: "Restart Claude Code so the new agent registry and hook chain load."
