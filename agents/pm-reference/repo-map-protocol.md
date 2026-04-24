# Repository Map Protocol

Comprehensive generation, maintenance, and filtering protocol for the repository map.
The PM reads this reference on demand during Step 2.7 (map generation) and Section 3
(map injection into delegation prompts).

---

## Map Format

The repository map has three sections: **Structure**, **Module Index**, and **Conventions**.
Each section is independently filterable for per-agent injection.

### Header

```markdown
# Repository Map
<!-- generated: {ISO timestamp} | hash: {first 7 chars of HEAD commit} | files: {source file count} -->
```

The `hash` field is used for staleness detection. The `files` count helps gauge project
size tier.

### Structure Section

Annotated file tree showing directories and key files with purpose and exports.

**Rules:**
- Only include directories and files that matter -- skip generated files (`dist/`, `build/`,
  `node_modules/`, `__pycache__/`, `target/`), lockfiles, IDE configs, build output.
- Each file gets a one-line annotation: purpose and key exports.
- Indent with 2 spaces per level.
- Maximum depth: 3 levels. Collapse deeper nesting into directory annotations.
- For directories with > 5 similar files, collapse into a directory annotation with count
  (e.g., `components/   # 12 React components`).

### Module Index Section

Table of the project's key modules.

```markdown
## Module Index
| Module | Entry | Key Exports | Used By |
|--------|-------|-------------|---------|
```

**Rules:**
- Maximum 20 rows.
- Sort by dependency centrality (most-depended-on modules first).
- Module name: short identifier (e.g., `api/users`, `models/task`).
- Entry: file path relative to project root.
- Key Exports: comma-separated list of the most important exports (max 4 per row).
- Used By: comma-separated list of consuming modules (max 3 per row, add `...` if more).

### Conventions Section

Bullet list of project-wide patterns every agent needs.

**Rules:**
- Maximum 10 bullets.
- Must include: language/version, framework, test framework, test command, build command.
- Should include: error handling pattern, naming conventions, API patterns, validation approach.
- Each bullet is one line with a bold label prefix.

---

## Full Map Example

```markdown
# Repository Map
<!-- generated: 2026-04-08T14:00:00Z | hash: a3f2b1c | files: 47 -->

## Structure
src/
  api/           # REST endpoints (Express routes)
    users.ts     # CRUD /api/users -- exports: router, validateUser
    tasks.ts     # CRUD /api/tasks -- exports: router, validateTask
    middleware/   # Auth, rate-limit, error-handler middleware
      auth.ts    # JWT verification -- exports: requireAuth, optionalAuth
  models/        # Sequelize models
    user.ts      # User model -- exports: User, UserAttributes
    task.ts      # Task model -- exports: Task, TaskStatus (enum)
  services/      # Business logic layer
    email.ts     # Email sending -- exports: sendWelcome, sendReset
  utils/         # Shared helpers
    errors.ts    # Custom error classes -- exports: AppError, NotFoundError
    validate.ts  # Zod schemas -- exports: userSchema, taskSchema
tests/
  api/           # Integration tests (supertest)
  models/        # Unit tests (vitest)
config/          # Environment configs
  default.ts     # Base config -- exports: config

## Module Index
| Module | Entry | Key Exports | Used By |
|--------|-------|-------------|---------|
| api/users | src/api/users.ts | router, validateUser | src/app.ts |
| api/tasks | src/api/tasks.ts | router, validateTask | src/app.ts |
| models/user | src/models/user.ts | User, UserAttributes | api/users, services/email |
| models/task | src/models/task.ts | Task, TaskStatus | api/tasks |
| middleware/auth | src/api/middleware/auth.ts | requireAuth | api/users, api/tasks |
| utils/errors | src/utils/errors.ts | AppError, NotFoundError | all api routes |

## Conventions
- **Language:** TypeScript 5.x, strict mode, ES modules
- **Framework:** Express 4.x with Sequelize 6.x ORM
- **Test framework:** Vitest, pattern: `tests/{module}/*.test.ts`
- **Test command:** `npm test`
- **Build command:** `npm run build` (tsc)
- **Error pattern:** Throw AppError subclasses, caught by error-handler middleware
- **Validation:** Zod schemas in utils/validate.ts, applied in route handlers
- **API pattern:** router -> validateInput -> handler -> response (see api/users.ts)
```

---

## Token Budget

| Project Size | Source Files | Token Target | Notes |
|-------------|-------------|-------------|-------|
| Small | < 20 | ~800 | Full map fits easily |
| Medium | 20-100 | ~1500 | Module Index may be truncated to top 15 entries |
| Large | 100+ | ~3000 | Collapse leaf files into directory summaries. Module Index top 20. Add `## Hotspots` section (5 most-changed files from `git log --name-only`) |

**Hard cap:** 4000 tokens. If the map exceeds this after all compression, truncate
Module Index rows from the bottom.

**Compression order** (apply in sequence until under budget):
1. Collapse leaf files into directory summaries for directories with > 5 similar files
2. Truncate Module Index to top 15 entries
3. Remove "Used By" column from Module Index
4. Collapse to directory-only annotations (no individual files)

---

## Language-Specific Adaptation

Determine the project language from the manifest file and adapt export extraction:

| Language | Manifest | Export Detection | Notes |
|----------|----------|-----------------|-------|
| JavaScript/TypeScript | `package.json` | `export` (ESM) or `module.exports` (CJS) | Detect CJS vs ESM from package.json `type` field |
| Python | `pyproject.toml` | Top-level `class`/`def` definitions | Note `__init__.py` re-exports |
| Go | `go.mod` | Capitalized functions/types (`func [A-Z]`, `type [A-Z]`) | Note `cmd/` vs `pkg/` layout |
| Rust | `Cargo.toml` | `pub` items from `mod.rs`/`lib.rs` | Note workspace crate structure |
| Other/mixed | `Makefile`, `CMakeLists.txt` | Generic: directory annotations only | No export detail |

---

## Generation Process

### Step 1: Detect project type and manifest (~2 turns)

Read the project manifest to determine language, framework, and dependencies:
- Try in order: `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `CMakeLists.txt`
- Extract: project name, language, framework, test framework, build command, test command
- Extract: key dependencies that signal architecture patterns (e.g., Express, Django, Actix, Gin)

### Step 2: Build directory structure (~2 turns)

Use Glob to discover the file tree:
- `Glob("**/*")` with appropriate exclusions (node_modules, .git, dist, build, __pycache__, target)
- Count source files to determine project size tier (small/medium/large)
- Classify directories by purpose:
  - `src/`, `lib/`, `app/` = source code
  - `tests/`, `test/`, `__tests__/`, `spec/` = tests
  - `docs/`, `doc/` = documentation
  - `config/`, `conf/` = configuration
  - `scripts/`, `bin/` = tooling
  - `public/`, `static/`, `assets/` = static files

### Step 3: Extract key exports (~3 turns)

For the top-level source directories, use Grep to find exports:
- **JS/TS**: `Grep("^export", type: "ts")` or `Grep("module\\.exports", type: "js")`
- **Python**: `Grep("^(class |def |__all__)", type: "py")`
- **Go**: `Grep("^func [A-Z]|^type [A-Z]", type: "go")`
- **Rust**: `Grep("^pub (fn|struct|enum|trait|mod)", type: "rust")`

For each source file with exports, record: file path, export names, one-line purpose
(inferred from file name and surrounding code).

**Limit:** Read at most 30 files for export extraction. For larger projects, prioritize
files in the top 2 directory levels and files imported most frequently.

### Step 4: Map dependencies (~2 turns)

Use Grep to find import/require statements and build a lightweight dependency graph:
- **JS/TS**: `Grep("^import .* from|require\\(", type: "ts")`
- **Python**: `Grep("^from .* import|^import ", type: "py")`
- **Go**: `Grep("\"[^\"]+\"", glob: "**/*.go")` inside import blocks
- **Rust**: `Grep("^use (crate|super)::", type: "rust")`

Build the "Used By" column for the Module Index by counting which files import each module.

### Step 5: Detect conventions (~1 turn)

From the files already read, extract recurring patterns:
- Error handling pattern (try/catch, Result type, error middleware)
- Naming conventions (camelCase, snake_case, file naming)
- Test patterns (test framework, file naming, setup/teardown)
- API patterns (routing, middleware, response format)
- Build and test commands from manifest scripts

### Step 6: Assemble and compress (~1 turn)

Compose the three sections into the final map format. Apply the token budget:
- Count approximate tokens (words * 1.3)
- If over budget, apply compression in order (see Token Budget section above)

Write the final map to `.orchestray/kb/facts/repo-map.md` and add/update the KB
index entry:
```json
{
  "id": "fact-repo-map",
  "category": "fact",
  "topic": "Repository map -- compact codebase structure, exports, and conventions",
  "source_agent": "pm",
  "ttl_days": 7,
  "file": "facts/repo-map.md",
  "summary": "Annotated file tree, module index with exports, project conventions"
}
```

**Total: ~11 turns maximum**, typically 6-8. One-time cost per project that saves 5-8
turns on every subsequent agent spawn.

### Migration Note

If `codebase-overview.md` already exists from a prior pre-scan, read it for seed data
(project name, language, framework) before generating the full map. The old file can
be left in place or deleted after map generation.

---

## Incremental Regeneration

When the map exists but is stale (5-15 files changed), only regenerate changed portions:

1. Run `git diff --name-only {old_hash}..HEAD` to get the list of changed files.
2. For each changed file, re-extract exports and update the relevant Module Index row.
3. For added/deleted files, update the Structure section.
4. For changed dependency imports, update the "Used By" column.
5. Update the header comment with new timestamp and hash.

This reduces regeneration from ~11 turns to ~3 turns.

---

## Staleness Detection

The map header contains `hash: {commit_hash}`. On each orchestration, the PM checks
staleness at Step 2.7:

1. Read the map header: extract `hash` and `files` count.
2. Run `git rev-parse HEAD` to get the current commit hash.
3. **Hashes match:** Map is fresh. Use cached map.
4. **Hashes differ:** Run `git diff --stat {old_hash}..HEAD` to count changed files.
   - < 5 files changed AND no new directories: update hash in header only, reuse map.
   - 5-15 files changed: trigger incremental regeneration.
   - > 15 files changed OR new directories added: trigger full regeneration.
5. If `old_hash` is not found in git history (e.g., after rebase): trigger full regeneration.

---

## Per-Agent Filtering Rules

| Agent Type | Structure | Module Index | Conventions | Notes |
|------------|-----------|--------------|-------------|-------|
| **architect** | Full | Full | Full | Broadest view needed |
| **developer** | Subtree only | Relevant rows (cap 10) | Full | Scoped to task files |
| **reviewer** | Subtree only | Relevant rows (cap 10) | Full | Same as developer |
| **debugger** | Full | Full | Full | Must trace across full codebase |
| **tester** | Subtree + test dirs | Relevant rows (cap 10) | Full | Files under test + test directories |
| **documenter** | Full | Omit | Full | Cares about organization, not imports |
| **security-engineer** | Full | Full | Full | Needs complete visibility |
| **dynamic agents** | Subtree only | Relevant rows (cap 10) | Full | Scoped to specialist's task |

---

## Filtering Algorithms

### Subtree Filtering (for developer, reviewer, tester, dynamic agents)

1. Take the task's "Files (read)" and "Files (write)" lists from the task graph.
2. Extract unique parent directories from these file paths.
3. Include those directories and their immediate children from the Structure section.
4. Include 1 level of sibling directories (same parent) as collapsed annotations
   (directory name + comment only, no file listing).

### Module Index Filtering

1. Take the same file lists from the task graph.
2. Include Module Index rows where the Entry column matches any file in the lists.
3. Include rows where the "Used By" column references any file in the lists.
4. Cap at 10 rows to keep delegation prompts tight.

---

## Project Intent (Step 2.7a)

Step 2.7a extends the repo-map pipeline with a goal-inference pass that writes
`.orchestray/kb/facts/project-intent.md` alongside `repo-map.md`. This pass is
**mechanical** (no separate LLM turn) — it reads README.md, package.json, and
CLAUDE.md via `bin/_lib/project-intent.js`.

### File Format (locked)

```markdown
# Project Intent
<!-- generated: {ISO ts} | repo-hash: {7-char} | readme-hash: {7-char} | low_confidence: {true|false} -->

**Domain:** <one phrase>
**Primary user problem:** <one sentence>
**Key architectural constraint:** <one sentence>
**Tech stack summary:** <language, framework, test runner>
**Entry points:** <comma-separated key files, max 3>
```

- `repo-hash`: first 7 chars of `git rev-parse HEAD` (same algorithm as repo-map header `hash`)
- `readme-hash`: sha256 hex of the first 50 lines of `README.md`, truncated to 7 chars
- `low_confidence`: `true` when the block should NOT be injected into delegation prompts

### When Step 2.7a Runs

Step 2.7a runs immediately after Step 2.7 in the orchestration setup phase. It is
skipped entirely when `enable_goal_inference: false` OR `enable_repo_map: false`
(coupled gate — AC-05). Defaults: `enable_goal_inference` inherits the value of
`enable_repo_map`, which defaults to `true`.

### Staleness Detection

The existing repo-map hash algorithm is **extended** with a second cache key:

| Key | Source | Invalidates when |
|-----|--------|-----------------|
| `repo-hash` | `git rev-parse HEAD` (7-char) | Code changes committed |
| `readme-hash` | sha256 of first 50 lines of README.md (7-char) | README description changes |

**Cache hit (AC-02):** Both `repo-hash` AND `readme-hash` match the stored values →
`project-intent.md` is used as-is. File mtime is NOT updated on a cache hit.

**Invalidation (AC-03):** Either hash differs → regenerate the intent block and
overwrite the file with a new timestamp.

### Low-Confidence Gate (AC-04)

When `README.md` is missing OR contains fewer than 100 words, the intent block is
written with `low_confidence: true` and all five fields are empty strings. The block
is **NOT injected** into delegation prompts — low-signal noise would degrade agent
output quality.

Condition summary:

| Condition | `low_confidence` | Fields | Injected? |
|-----------|-----------------|--------|-----------|
| README exists, ≥ 100 words | `false` | Populated | Yes |
| README exists, < 100 words | `true` | Empty strings | No |
| README missing | `true` | Empty strings | No |
| < 10 tracked files (AC-08) | `true` | Empty strings | No |

### Minimum Project Size Gate (AC-08)

If `git ls-files | wc -l` returns fewer than 10 files, Step 2.7a writes a stub with
`low_confidence: true` and skips field inference. This avoids burning inference logic
on trivially small or empty repos (e.g., fresh git init, demo directories).

### Delegation Prompt Injection (AC-06)

The intent block is injected via `injectProjectIntent()` from `bin/_lib/repo-map-delta.js`
(sibling to `injectRepoMap()`). Injection rules:

- `project-intent.md` exists AND `low_confidence: false` → inject `## Project Intent` block
- File missing OR `low_confidence: true` → return `''` (no injection, no error)
- Injection is additive: the intent block appears **alongside** the repo-map block,
  not instead of it. Upstream agents that ignore unknown sections are unaffected.

Example injected block shape (the exact content is project-specific):

```
## Project Intent

**Domain:** Multi-agent orchestration plugin for Claude Code
**Primary user problem:** Developers spend multiple turns re-exploring the same codebase context across agent sessions.
**Key architectural constraint:** Must work as a Claude Code plugin — cannot modify Claude Code internals.
**Tech stack summary:** Node.js/JavaScript, node:test
**Entry points:** bin/install.js
```
