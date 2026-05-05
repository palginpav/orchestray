# Orchestray

Multi-agent orchestration plugin for [Claude Code](https://claude.ai/code). Detects complex tasks automatically, decomposes them across specialized AI agents, and delivers fully audited results — no manual configuration needed.

Simple prompts pass straight through to normal Claude Code. Complex ones get decomposed, routed to the right agents, and reassembled with a full audit trail.

## Install

```bash
npx orchestray --global
```

Installs agents, skills, and hooks into `~/.claude/`. Restart Claude Code after install.

Project-local install:

```bash
npx orchestray --local
```

Uninstall:

```bash
npx orchestray --global --uninstall
```

## Quick start

```
/orchestray:run "add rate limiting to the API"
```

That's it. Orchestray scores complexity, decomposes the task, routes agents, runs verify-fix loops, and reports results. Use `--preview` to see the plan before anything runs.

## Key commands

| Command | What it does |
|---------|-------------|
| `/orchestray:run [task]` | Trigger orchestration; `--preview` shows plan first |
| `/orchestray:status` | Active orchestration state |
| `/orchestray:config` | View or change any of ~80 settings; `show federation` for federation state |
| `/orchestray:kb` | List, view, or add knowledge-base entries from past orchestrations |
| `/orchestray:review-pr <PR>` | Review a GitHub pull request with the reviewer agent |
| `/orchestray:learn-doc <url>` | Distill a URL into a reusable skill pack future agents auto-load |
| `/orchestray:federation status` | Show federation state and shared tier contents |
| `/orchestray:playbooks` | Manage project-specific playbooks that customize agent behavior |
| `/orchestray:resume` | Resume an interrupted orchestration |
| `/orchestray:loop` | Iterate-until primitive for tasks that need repeated adjustment |
| `/orchestray:rollback` | Restore workspace to a pre-spawn snapshot |
| `/orchestray:analytics` | Cost breakdown, pattern dashboard, health signals |
| `/orchestray:patterns` | Pattern effectiveness dashboard |
| `/orchestray:learn [id]` | Extract patterns; `curate` to AI-curate; `list --proposed` to review auto-proposals |
| `/orchestray:specialists` | Manage persistent specialist agents |
| `/orchestray:workflows` | Manage custom YAML workflow definitions |
| `/orchestray:update` | Update Orchestray to the latest version |
| `/orchestray:report` | Full audit report with cost breakdown |
| `/orchestray:issue [#/url]` | Orchestrate from a GitHub issue |
| `/orchestray:feature` | Inspect or wake quarantined feature gates |
| `/orchestray:plugin [status\|list\|approve\|disable\|reload]` | Manage MCP plugins: list discovered plugins, approve/disable one, check lifecycle state |
| `/orchestray:doctor` | Health probes; `--deep` for install-integrity check |

### Recovery / debugging

| Command | What it does |
|---------|-------------|
| `/orchestray:redo <task-id>` | Re-run a task; `--cascade` to update dependents |
| `/orchestray:watch` | Live-tail a running orchestration |
| `/orchestray:state` | Inspect (`peek`), pause, cancel, or gc orchestration state |

## Plugins

Plugins are optional MCP servers that extend Orchestray's tool surface with
domain-specific tools. Each plugin runs as a child process; tools are namespaced
under `mcp__orchestray__plugin_<plugin-name>_<tool-name>` and routed through the
broker. Manage plugins with the `/orchestray:plugin` slash command:

- `/orchestray:plugin list` — show discovered plugins and consent state
- `/orchestray:plugin approve <name>` — review capabilities + fingerprint and grant consent
- `/orchestray:plugin disable <name>` — revoke consent
- `/orchestray:plugin reload <name>` — re-fetch and re-verify the plugin manifest
- `/orchestray:plugin status [<name>]` — show lifecycle state for one or all plugins

For plugin authoring instructions, see [docs/plugin-authoring-guide.md](./docs/plugin-authoring-guide.md).

## No sandbox security model

Orchestray's plugin loader (introduced in v2.3.0) lets you install third-party
plugins that extend Orchestray's tool surface. **These plugins run with the
same filesystem and network access as Orchestray itself.** Specifically:

> 1. **No sandbox.** Claude Code does not sandbox plugins, and Orchestray does
>    not add one. A plugin you grant consent to can read any file your user
>    account can read, write any file your user account can write, and make
>    any network request your user account can make.
>
> 2. **Capability flags are advisory, not enforced.** A plugin's manifest
>    declares `capabilities.network`, `capabilities.filesystem_write`, and
>    `capabilities.spawn_subprocess`. These are the plugin author's stated
>    intent, **shown to you during consent**. Orchestray does not enforce them
>    at runtime in v2.3.0. A plugin that declares `network: false` and then
>    makes outbound HTTP calls is misbehaving but not blocked.
>
> 3. **No signature verification.** Orchestray does not verify plugin signatures
>    or provenance in v2.3.0. **You are responsible for trusting the source of
>    every plugin you grant consent to.** Treat plugin consent the same way you
>    treat installing arbitrary npm packages: only consent to plugins from
>    sources you trust.
>
> 4. **Re-consent on changes.** Orchestray re-prompts for consent when a plugin's
>    manifest OR entrypoint file changes. This protects you from a compromised
>    plugin pushing a malicious update silently. **It does not protect you from
>    the plugin's transitive dependencies changing** (e.g., `npm update` inside
>    the plugin directory).
>
> 5. **Plugin tools are not in `disallowedTools` defaults.** If you have
>    `disallowedTools: ["bash"]` configured in Claude Code to prevent shell
>    execution, be aware that a plugin tool with an internal name like
>    `execute_shell` is namespaced as
>    `mcp__orchestray__plugin_<name>_execute_shell` and is **not** automatically
>    included in `disallowedTools: ["bash"]`. Add specific plugin tool names to
>    `disallowedTools` if you want to block them.
>
> 6. **Plugin tool RESPONSES are untrusted text.** A malicious plugin can return
>    a response containing prompt-injection payloads aimed at the model. The
>    same caution that applies to web search results, scraped pages, and
>    upstream tool output applies to plugin responses.
>
> 7. **Kill switches.** You can disable the entire plugin loader with the env
>    var `ORCHESTRAY_PLUGIN_LOADER_DISABLED=1` or by setting
>    `plugin_loader.enabled: false` in `.orchestray/config.json`. You can
>    disable individual plugins with `/orchestray:plugin disable <name>` or
>    by setting `ORCHESTRAY_PLUGIN_DISABLE=name1,name2`.

## Agent roles

| Agent | Role |
|-------|------|
| **PM** | Orchestrator — decomposes tasks, assigns work, routes models |
| **Architect** | Design-only — produces design documents and technical decisions |
| **Developer** | Implements code changes |
| **Refactorer** | Code transformation without behavior change |
| **Reviewer** | Read-only review: correctness, quality, security, performance, docs, operability, API compatibility |
| **Debugger** | Bug investigation and root cause analysis (read-only) |
| **Tester** | Test writing, coverage analysis, and test strategy |
| **Documenter** | Documentation creation and maintenance |
| **Security Engineer** | Shift-left security — threat modeling and implementation audit (read-only) |
| **Researcher** | Surveys external approaches; returns decision-ready shortlist before Architect/Inventor |
| **Inventor** | First-principles creation of novel tools, DSLs, and custom solutions |
| **Release Manager** | Version bump, CHANGELOG, README sweep, event-schema sync, tag prep |
| **UX Critic** | Adversarial critique of user-facing surfaces for friction and consistency (read-only) |
| **Platform Oracle** | Authoritative answers to Claude Code / Anthropic SDK / API / MCP questions with cited sources |

Five specialist templates also ship: translator, ui-ux-designer, database-migration, api-contract-designer, error-message-writer. The PM activates them automatically on matching keywords; project-local overrides go in `.orchestray/specialists/`.

## How it works

- PM scores every prompt (0–12). Score below threshold → normal Claude Code. Score at or above threshold → orchestration.
- PM decomposes the task into tasks, routes each to the right agent (Haiku / Sonnet / Opus by complexity), and runs independent tasks in parallel.
- Each agent delivers a structured result. Reviewer failures route back to Developer with specific feedback (verify-fix loop).
- On close, Orchestray archives per-orchestration events, extracts patterns, and emits a cost rollup visible in `/orchestray:analytics`.
- Session resilience: if context compacts mid-orchestration, Orchestray writes a dossier before compaction and re-injects it on the next message.

## Configuration

Run `/orchestray:config` to view all settings. Most-used knobs:

| Key | Default | What it does |
|-----|---------|-------------|
| `complexity_threshold` | `4` | Score threshold for auto-orchestration |
| `auto_review` | `true` | Auto-spawn reviewer after developer |
| `model_floor` | `sonnet` | Minimum model tier: haiku / sonnet / opus |
| `confirm_before_execute` | `false` | Show preview before execution |
| `daily_cost_limit_usd` | `null` | Daily spending cap |

## Kill switches

Orchestray ships ~80 feature-level kill switches (config keys + env vars) for emergency rollback or selective opt-out. The full reference lives in [`KILL_SWITCHES.md`](./KILL_SWITCHES.md), grouped into 10 categories (orchestration core, hooks & gates, reviewer, tokenwright, dossier, telemetry, MCP, install, lints, worktree). No session restart required for any of them.

## Requirements

- [Claude Code](https://claude.ai/code) v2.0.0+; v2.1.59+ recommended
- Node.js 20 LTS

## Troubleshooting

**Agent registry changes don't take effect after `/orchestray:update`.**
Claude Code caches agent definitions at session start. Restart the session after every update.

**`mcp__orchestray__schema_get` returns `stale_index`.**
Run `node bin/regen-schema-shadow.js` followed by `node -e "require('./bin/_lib/tier2-index').buildIndex({cwd: process.cwd()})"`. The PostToolUse(Edit) hook normally handles this automatically.

**Gate blocks first spawn after upgrade.**
On the next user prompt, `bin/post-upgrade-sweep.js` repairs stale checkpoint rows automatically. If the gate still blocks, set `mcp_enforcement.global_kill_switch: true` (and a `kill_switch_reason`) in `.orchestray/config.json` to complete the in-flight orchestration, then clear both fields.

**Role agent blocked on first upgrade to v2.2.9** (`t15_role_schema_violation` — reviewer / researcher / inventor / security-engineer / ux-critic / platform-oracle)
Six previously warn-tier roles were promoted to hard-tier with no grace flag — every Structured Result missing the role-required fields now blocks the spawn. Update the agent's output to include the role contract from `bin/_lib/role-schemas.js`. For an emergency pin while you fix the upstream agent, set `ORCHESTRAY_T15_<ROLE>_HARD_DISABLED=1` (e.g. `ORCHESTRAY_T15_RESEARCHER_HARD_DISABLED=1`) — the role downgrades to warn-tier for that session only.

**Model not specified on Agent() call blocks spawn** (`agent_model_unspecified_blocked`)
v2.2.9 flipped the default for `ORCHESTRAY_STRICT_MODEL_REQUIRED` from "auto-resolve to sonnet" to "hard-block". Add explicit `model:` to every `Agent()` call (e.g. `Agent(subagent_type: "developer", model: "sonnet", …)`), or set `ORCHESTRAY_STRICT_MODEL_REQUIRED=0` for one release while you backfill. Per-agent `model:` frontmatter does not satisfy the gate — it must appear on the `Agent()` call itself.

**Write-path blocked for reviewer / tester / documenter / release-manager** (`role_write_path_blocked`)
Each write-capable specialist has a per-role allowlist defined in `bin/_lib/role-write-allowlists.js`. If you need a wider scope for a one-off task, set `ORCHESTRAY_ROLE_WRITE_GATE_DISABLED=1` in the spawning shell, or add the path to the allowlist (preferred — keeps the rest of the codebase protected).

**Task YAML Contracts section blocked at spawn** (`contracts_parse_failed`)
Since v2.2.12, Contracts validation is a hard-fail (exit 2). If a task YAML `## Contracts` section is malformed, the spawn is blocked and `contracts_parse_failed` is emitted. To revert to soft-warn, set `ORCHESTRAY_CONTRACTS_PARSE_GATE_DISABLED=1`. To disable the validator entirely, set `ORCHESTRAY_CONTRACTS_VALIDATOR_DISABLED=1` or `ORCHESTRAY_CONTRACTS_MISSING_WARN_DISABLED=1`.

**MCP grounding missing blocks pm / researcher / debugger / architect spawns** (`agent_mcp_grounding_missing`)
v2.2.10 promotes the MCP grounding gate from warning to hard-block (exit 2) for these four roles. The server-side prefetch hook normally satisfies the gate automatically before each spawn. If the gate fires unexpectedly (e.g. in a custom spawn path that bypasses the prefetch hook), verify that `bin/prefetch-mcp-grounding.js` is registered as `PreToolUse:Agent` in your hooks configuration. Set `ORCHESTRAY_MCP_GROUNDING_GATE_DISABLED=1` as an emergency bypass.

**Reviewer spawn blocked on missing `## Dimensions to Apply` or `## Git Diff` (v2.2.15+)** (`reviewer_dimensions_gate_blocked` / `reviewer_git_diff_check_failed`)
The PM must include both blocks in the reviewer delegation prompt. To downgrade to warn-only: `ORCHESTRAY_REVIEWER_DIMENSIONS_GATE_DISABLED=1`, `ORCHESTRAY_REVIEWER_GIT_DIFF_GATE_DISABLED=1`. See `agents/pm-reference/delegation-templates.md` for the canonical template.

**Spawn blocked after 3 missing `context_size_hint` lines (v2.2.15+)** (`context_size_hint_missing_after_ramp`)
Add `context_size_hint: system=N tier2=N handoff=N` to your delegation prompt. Threshold tunable: `ORCHESTRAY_CONTEXT_SIZE_HINT_RAMP_THRESHOLD=N`. Full bypass: `ORCHESTRAY_CONTEXT_SIZE_HINT_GATE_DISABLED=1`.

**Developer / release-manager success spawn blocked on missing `## Handoff` commit body (v2.2.15+)** (`commit_handoff_body_missing_after_ramp`)
Every developer/release-manager success commit needs `## Handoff` in the body. Auto-commits (worktree/master) are exempt. Bypass: `ORCHESTRAY_COMMIT_HANDOFF_GATE_DISABLED=1`.

**Worktree edits silently lost on agent exit (resolved in v2.2.18; restart Claude Code if upgrading)**
Resolved in v2.2.18. Agents now `wip(auto):` commit before teardown. If you are on v2.2.17 or earlier and have uncommitted worktree work, upgrade immediately. Pre-existing locked worktrees with no commits cannot be salvaged.

## License

MIT
