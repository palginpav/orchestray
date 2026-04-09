<!-- PM Reference: Loaded by Section Loading Protocol when monorepo detected (pnpm-workspace.yaml, lerna.json, etc.) -->

## 37. Monorepo Awareness

Detect monorepo structures before complexity scoring and scope agent file ownership to the packages affected by the task.

### Detection (during Section 12 pre-scan, before complexity scoring)

Check for monorepo markers at the project root (run once per orchestration, cache result in orchestration state):

1. **Config files:** Check if ANY of these exist: `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`
2. **Multiple package.json:** Glob `packages/*/package.json` and `apps/*/package.json`. If either glob returns 2 or more matches, it is a monorepo.
3. **Workspace directories:** Check if `packages/` or `apps/` exists as a directory with at least 2 subdirectories each containing a `package.json`.

If NONE of the above are true, this section is fully skipped (zero overhead for non-monorepos).

### Package Identification

When a monorepo is detected, identify which packages are affected by the current task:

1. **From explicit paths:** If the task prompt mentions specific file paths or directory names, extract the package name from the path (e.g., `packages/api/src/routes.ts` -> package `api`).
2. **From task keywords:** Match task description keywords against package names and their `description` fields in `package.json`. Read `packages/*/package.json` for `name` and `description` fields.
3. **Default (ambiguous task):** If affected packages cannot be determined, include all packages but note the ambiguity in the orchestration summary. Do not block on this.

### Scoping Agent Delegation

For each affected package identified:

1. **File ownership (Section 13, in tier1-orchestration.md):** Constrain `files_owned` for each subtask to paths within the affected package directories. Do not assign cross-package file ownership unless the task explicitly spans multiple packages.
2. **Delegation prompt context:** Prepend to every agent delegation prompt:
   ```
   ## Monorepo Context
   This is a monorepo. You are working in package `<name>` at `<path>`.
   Other packages exist but are outside your scope for this task.
   Do not modify files outside `<path>` unless the task description explicitly requires it.
   ```
3. If the task spans multiple packages (explicitly confirmed), include all affected packages in the context block and assign each agent to a specific package.

### Orchestration State

Set `monorepo: true` and `affected_packages: ["<name>", ...]` in `.orchestray/state/orchestration.md` frontmatter. This is used in the audit trail and orchestration summary.

### Transparency

When a monorepo is detected, briefly note it before decomposition:
`Monorepo detected. Scoping to package(s): <names>`
