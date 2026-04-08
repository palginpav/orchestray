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

2. **Detect current installation**: Look for a VERSION file to determine install type and current version.
   - Check `~/.claude/orchestray/VERSION` (global install).
   - Check `.claude/orchestray/VERSION` in the current working directory (local install).
   - If both exist: prefer local (it is the active installation for this project). Set `{scope}` to `--local` or `--global` accordingly.
   - If neither exists: report "Orchestray installation not found. Install with `npx orchestray --global` or `npx orchestray --local`." and stop.
   - Read the VERSION file to get `{current}` (trim whitespace).

3. **Check for updates**: Run `npm view orchestray version` to get `{latest}`.
   - If the command fails: report "Could not check npm registry. Check your internet connection." and stop.
   - If `{current}` equals `{latest}`: report "Orchestray is up to date (v{current})." and stop.
   - Otherwise: report "Update available: v{current} -> v{latest}"
   - If `--check` flag was provided: stop here.

4. **Perform update**: Run `npx orchestray@latest {scope}` where `{scope}` is `--global` or `--local` matching the detected install type.
   - If the command fails: report "Update failed. Try manually: `npx orchestray@latest {scope}`" and stop.
   - Read the VERSION file again to confirm the new version `{new}`.
   - Report: "Updated Orchestray from v{current} to v{new}."

5. **Show changelog**: Check if `.claude/orchestray/CHANGELOG.md` exists (using the same install path).
   - If it exists: read and display only the section for version `{new}` (from `## {new}` or `## v{new}` heading to the next `##` heading).
   - If it does not exist: report "Run `/orchestray:config` to see current settings."
