#!/usr/bin/env node
// NOT_A_HOOK
// FN-59 (v2.2.15): CLI-only tool. install.js is the npm install entry point —
// invoked by `npx orchestray --global|--local`, never by Claude Code as a hook.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordDegradation } = require('./_lib/degraded-journal');
const { computeManifest }  = require('./_lib/install-manifest');

const VERSION = require('../package.json').version;
const REPO = 'https://github.com/palginpav/orchestray';

// FN-23 (v2.2.15): tiny stderr-writer for advisory output. Per G-02 sibling
// discipline, all install advisories ("✓ Installed N agents", "✓ Configured
// hooks", etc.) write to stderr — leaving stdout reserved for the final
// "Done!" ceremony and the help/usage text. This prevents install.js stdout
// from polluting any pipe consumer that expects machine-readable output.
function say(msg) {
  process.stderr.write(String(msg) + '\n');
}

// Default MCP tool enable map for fresh installs.
// When new MCP tools are added, append their key here with `true` so they are
// enabled by default. This constant is the single source of truth consulted
// when seeding `.orchestray/config.json` in a project that has no prior config.
// Per 2014-scope-proposal.md §W1 AC4(d).
// Note: ask_user is budget-gated in elicit/, not enable-gated — do not add it here.
const FRESH_INSTALL_MCP_TOOLS_ENABLED = {
  pattern_find: true,
  pattern_record_application: true,
  pattern_record_skip_reason: true,
  // v2.0.16 D1: pattern_deprecate tool
  pattern_deprecate: true,
  cost_budget_check: true,
  history_query_events: true,
  history_find_similar_tasks: true,
  kb_search: true,
  kb_write: true,
  // v2.0.16 new tools (W3/W4)
  routing_lookup: true,
  cost_budget_reserve: true,
  // v2.0.17 T5: metrics_query telemetry tool
  metrics_query: true,
  // v2.1.14 R-CAT: pattern_read JIT tool (catalog companion to pattern_find)
  pattern_read: true,
};

// Default v2017_experiments block for fresh installs.
// prompt_caching defaults on as of v2.0.23. Per v2017-design.md §4.1 T4.
// (pm_prose_strip removed in v2.0.18 — FC3b cleanup)
const FRESH_INSTALL_V2017_EXPERIMENTS = {
  __schema_version: 1,
  global_kill_switch: false,
  prompt_caching: 'on',
  adaptive_verbosity: 'off',
};

// Default cache_choreography block for fresh installs.
// pre_commit_guard_enabled defaults off (opt-in only). Per T12.
const FRESH_INSTALL_CACHE_CHOREOGRAPHY = {
  pre_commit_guard_enabled: false,
  drift_warn_threshold_hex_changes: 1,
};

// Default adaptive_verbosity block for fresh installs.
// enabled defaults off (opt-in, also requires v2017_experiments.adaptive_verbosity='on'). Per T22.
const FRESH_INSTALL_ADAPTIVE_VERBOSITY = {
  enabled: false,
  base_response_tokens: 2000,
  reducer_on_late_phase: 0.4,
};

// Default pattern_decay block for fresh installs.
// Uses canonical defaults from DEFAULT_PATTERN_DECAY in config-schema.js.
// Per v2018 W9: global half-life 90 days, no per-category overrides.
const FRESH_INSTALL_PATTERN_DECAY = {
  default_half_life_days: 90,
  category_overrides: {},
};

// Default anti_pattern_gate block for fresh installs.
// Uses canonical defaults from DEFAULT_ANTI_PATTERN_GATE in config-schema.js.
// Per v2018 W12: enabled by default, threshold 0.55 (lowered from 0.65 in v2.2.17), max 1 advisory per spawn.
const FRESH_INSTALL_ANTI_PATTERN_GATE = {
  enabled: true,
  min_decayed_confidence: 0.55,
  max_advisories_per_spawn: 1,
};

// Default state_sentinel block for fresh installs.
// Uses canonical defaults from DEFAULT_STATE_SENTINEL in config-schema.js.
// Per v2018 W7: pause check enabled, 5-second cancel grace window.
const FRESH_INSTALL_STATE_SENTINEL = {
  pause_check_enabled: true,
  cancel_grace_seconds: 5,
};

// Default redo_flow block for fresh installs.
// Uses canonical defaults from DEFAULT_REDO_FLOW in config-schema.js.
// Per v2018 W8: max cascade depth 10, commit prefix "redo".
const FRESH_INSTALL_REDO_FLOW = {
  max_cascade_depth: 10,
  commit_prefix: 'redo',
};

// R-AIDER-FULL (v2.1.17): Aider-style tree-sitter + PageRank repo-map seed.
// `enabled: true` ships the feature on by default for fresh installs because
// the PM agent's delegation pipeline (agents/pm.md Section 3) prepends a
// repo map block to code-touching spawns when this flag is true. To soft-
// launch (skip the inline map until PM behaviour is observed in the wild),
// flip this to false in your project's .orchestray/config.json. The 6
// languages mirror schemas/config.schema.js repoMapSchema; cache_dir under
// .orchestray/state keeps build artifacts gitignored. v2.1.17 W9-fix F-005.
const FRESH_INSTALL_REPO_MAP = {
  enabled: true,
  languages: ['js', 'ts', 'py', 'go', 'rs', 'sh'],
  cache_dir: '.orchestray/state/repo-map-cache',
  cold_init_async: true,
};

// Default cost_budget_check config block for fresh installs.
// Pricing values mirror bin/collect-agent-metrics.js PRICING constant.
// Per 2014-scope-proposal.md §W3 AC4.
const FRESH_INSTALL_COST_BUDGET_CHECK = {
  pricing_table: {
    haiku:  { input_per_1m: 1.00,  output_per_1m: 5.00  },
    sonnet: { input_per_1m: 3.00,  output_per_1m: 15.00 },
    opus:   { input_per_1m: 5.00,  output_per_1m: 25.00 },
  },
  last_verified: '2026-04-11',
};

// Parse arguments
const args = process.argv.slice(2);
const flags = {
  global: args.includes('--global') || args.includes('-g'),
  local: args.includes('--local') || args.includes('-l'),
  uninstall: args.includes('--uninstall') || args.includes('-u'),
  help: args.includes('--help') || args.includes('-h'),
  preCommitGuard: args.includes('--pre-commit-guard'),
};

if (flags.help) {
  // Help text on stdout (user-facing primary output of --help).
  console.log(`
  Orchestray v${VERSION}
  Multi-agent orchestration plugin for Claude Code

  Usage: npx orchestray [options]

  Options:
    -g, --global          Install globally (to ~/.claude/)
    -l, --local           Install locally (to ./.claude/)
    -u, --uninstall       Remove Orchestray files
    -h, --help            Show this help
        --pre-commit-guard  Install the Block A pre-commit guard hook (opt-in;
                            requires cache_choreography.pre_commit_guard_enabled=true)

  Examples:
    npx orchestray --global               # Install for all projects
    npx orchestray --local                # Install for current project only
    npx orchestray --uninstall            # Remove Orchestray
    npx orchestray --pre-commit-guard     # Install pre-commit guard (opt-in)
`);
  process.exit(0);
}

// Determine install target
const homeDir = process.env.HOME || process.env.USERPROFILE;
if (!flags.local && flags.global && !homeDir) {
  console.error(
    '  \x1b[31m✗\x1b[0m Cannot install globally: neither HOME nor USERPROFILE is set.\n' +
    '    Use --local to install into the current directory instead.'
  );
  process.exit(1);
}
const configDir = flags.local
  ? path.resolve('.claude')
  : path.join(homeDir || '', '.claude');

if (!flags.global && !flags.local) {
  // Interactive disambiguation prompt on stdout (no-args invocation).
  console.log(`
  Orchestray v${VERSION}
  Multi-agent orchestration for Claude Code

  Where do you want to install?

    npx orchestray --global     ~/.claude/ (all projects)
    npx orchestray --local      ./.claude/ (this project only)
`);
  process.exit(0);
}

// Source directory (where this script lives relative to the package)
const pkgRoot = path.resolve(__dirname, '..');

if (flags.uninstall) {
  uninstall(configDir);
  process.exit(0);
}

// --pre-commit-guard: invoke bin/install-pre-commit-guard.sh.
// This is handled after the normal install flag checks so that
// --global/--local context is already resolved above.
if (flags.preCommitGuard) {
  const { execFileSync } = require('child_process');
  const guardScript = path.join(__dirname, 'install-pre-commit-guard.sh');
  try {
    execFileSync('bash', [guardScript], { stdio: 'inherit' });
  } catch (e) {
    // execFileSync exits non-zero on failure; stderr is already printed.
    process.exit(1);
  }
  process.exit(0);
}

say('');
say('  Orchestray v' + VERSION);
say('  Multi-agent orchestration for Claude Code');
say('');
say(`  Installing ${flags.local ? 'locally' : 'globally'} to ${configDir}`);
say('');

install(configDir);

// =============================================================================
// v2.1.0 UPGRADE NOTES (v2.0.x → v2.1.0 migration)
// =============================================================================
//
// These notes apply to any install that is upgrading FROM a v2.0.x release.
// New installs (no prior VERSION file) are unaffected — the defaults already
// reflect the v2.1.0 posture.
//
// 1. FEDERATION (opt-in — no behavior change for existing users)
//    `federation.shared_dir_enabled` defaults to `false` in fresh configs and
//    is never set to `true` by the installer. Users who do not explicitly run
//    `/orchestray:config set federation.shared_dir_enabled true` will see zero
//    change in behavior after upgrading.
//
//    CROSS-PROJECT SIDE EFFECT: when `federation.shared_dir_enabled` is set to
//    `true` in ANY project on this machine, that project reads and writes the
//    machine-wide shared directory (`~/.orchestray/shared/` by default). ALL
//    Orchestray projects on this machine that also have federation enabled will
//    read patterns from that same shared directory. This is intentional — it is
//    the federation feature — but users must understand the machine-wide scope
//    before enabling. See `/orchestray:config show federation` for per-project
//    visibility. Use `/orchestray:config federation disable-global` to disable
//    federation across all projects at once.
//
// 2. FTS5 INDEX (lazy build — no migration required)
//    A SQLite FTS5 index is built lazily at `.orchestray/patterns.db` on the
//    first `pattern_find` call after upgrade. Existing `.orchestray/patterns/`
//    markdown files remain the authoritative source of truth; the `.db` file is
//    a derived cache and can be safely deleted at any time (it will be rebuilt
//    on next use). If `better-sqlite3` fails to load (native build mismatch),
//    `pattern_find` falls back to the pre-v2.1.0 Jaccard scorer automatically.
//
//    The `better-sqlite3` postinstall step may log a native-build warning
//    during `npm install`. This is non-fatal — the Jaccard fallback is active
//    until the native build succeeds.
//
// 3. CURATOR AGENT (opt-in — not auto-invoked)
//    The pattern curator agent (`agents/curator.md`) ships in v2.1.0 but is
//    never invoked automatically. Existing PM nag behavior is off by default
//    (`curator.pm_recommendation_enabled: true`, but the nag fires at most
//    once per session after the first curator run, not before it). Users who
//    want curator analysis must explicitly run `/orchestray:learn curate`.
//
// 4. ROLLBACK GUIDANCE (v2.1.0 → v2.0.x)
//    To roll back to v2.0.x:
//    a. Run `npx orchestray@2.0.x --global` (or --local) to reinstall.
//    b. `~/.orchestray/shared/` is NOT automatically removed. If you wish to
//       fully remove the shared directory: `rm -rf ~/.orchestray/shared/`
//       (user data only; v2.0.x will not create or read this path).
//    c. `.orchestray/patterns.db` (FTS5 index) is ignored by v2.0.x and can
//       be deleted safely: `rm -f .orchestray/patterns.db`
//    d. Rollback does NOT require any config changes — federation defaults to
//       disabled, so v2.0.x simply ignores all federation config keys.
//
// =============================================================================

/**
 * B1 (v2.1.0): Create shared federation directories if federation is enabled
 * in the project config at `projectRoot/.orchestray/config.json`.
 *
 * Directories created (if they do not already exist):
 *   ~/.orchestray/shared/patterns/
 *   ~/.orchestray/shared/kb/
 *   ~/.orchestray/shared/meta/       (tombstones + promote-log)
 *
 * This function:
 *   - Only creates directories when federation.shared_dir_enabled === true.
 *   - Is idempotent: if all dirs exist, does nothing.
 *   - Uses mode 0o700 (user-only) per the federation security model.
 *   - Never throws — all errors are best-effort logged to stderr.
 *
 * CROSS-PROJECT SIDE EFFECT: the shared directory is machine-wide. Enabling
 * federation in ANY project causes that project's patterns (when shared) to be
 * readable by ALL other Orchestray projects on this machine that also have
 * federation enabled. This is intentional; see v2.1.0 upgrade notes above.
 *
 * @param {string} projectRoot - Absolute path to project root (contains .orchestray/).
 */
function _maybeCreateSharedFederationDirs(projectRoot) {
  try {
    const configFilePath = path.join(projectRoot, '.orchestray', 'config.json');
    if (!fs.existsSync(configFilePath)) {
      // No config yet — federation is disabled by default; nothing to create.
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
    } catch (_e) {
      return; // Malformed config — skip quietly.
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const fed = parsed.federation;
    if (!fed || typeof fed !== 'object' || Array.isArray(fed)) return;
    if (fed.shared_dir_enabled !== true) return;

    // Resolve shared_dir_path (default ~/.orchestray/shared).
    let sharedDirPath = (typeof fed.shared_dir_path === 'string' && fed.shared_dir_path.trim().length > 0)
      ? fed.shared_dir_path.trim()
      : '~/.orchestray/shared';

    // Tilde + $HOME expansion (FN-22 v2.2.15: accept $HOME alongside ~/).
    // FN-21: collapsed dead `slice(...?2:2)` ternary to `slice(2)` — both
    // branches yielded the same offset for `~/` and `~\` prefixes.
    if (sharedDirPath === '~' || sharedDirPath.startsWith('~/') || sharedDirPath.startsWith('~\\')) {
      sharedDirPath = path.join(os.homedir(), sharedDirPath.slice(2));
    } else if (sharedDirPath === '$HOME' || sharedDirPath.startsWith('$HOME/') || sharedDirPath.startsWith('$HOME\\')) {
      sharedDirPath = path.join(os.homedir(), sharedDirPath.slice('$HOME'.length).replace(/^[\/\\]/, ''));
    } else if (sharedDirPath.startsWith('${HOME}/') || sharedDirPath.startsWith('${HOME}\\') || sharedDirPath === '${HOME}') {
      sharedDirPath = path.join(os.homedir(), sharedDirPath.slice('${HOME}'.length).replace(/^[\/\\]/, ''));
    }
    const sharedRoot = path.resolve(sharedDirPath);

    const dirsToCreate = [
      path.join(sharedRoot, 'patterns'),
      path.join(sharedRoot, 'kb'),
      path.join(sharedRoot, 'meta'),
    ];

    let anyCreated = false;
    for (const dir of dirsToCreate) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        anyCreated = true;
      }
    }

    if (anyCreated) {
      say(`  \x1b[32m✓\x1b[0m Created shared federation directories at ${sharedRoot}`);
    }
  } catch (err) {
    // Non-fatal — federation dirs can be created on first promote if install fails here.
    say(`  \x1b[33m⚠\x1b[0m Could not create shared federation directories: ${err.message}`);
    recordDegradation({
      kind: 'shared_dir_create_failed',
      severity: 'warn',
      projectRoot,
      detail: {
        path: null,
        error_code: (err && err.code) || null,
        error_message: (err && err.message) ? String(err.message).slice(0, 200) : 'unknown',
        dedup_key: 'shared_dir_create_failed',
      },
    });
  }
}

/**
 * SB2 fix: Idempotently merge the ## Compact Instructions section from the
 * package CLAUDE.md into the user's project-level CLAUDE.md.
 *
 * Idempotency marker: `**Authoritative post-compact recovery source:**`
 * If that string already appears in the user's CLAUDE.md, this is a no-op.
 *
 * Cases handled:
 *   (a) No user CLAUDE.md → create one containing only the section.
 *   (b) User CLAUDE.md without the marker → append the section.
 *   (c) User CLAUDE.md already has the marker → do nothing.
 *
 * @param {string} pkgClaudeMdPath  Absolute path to the package's CLAUDE.md.
 * @param {string} projectRoot      The user's project root (process.cwd()).
 */
function _mergeCompactInstructionsIntoCLAUDEmd(pkgClaudeMdPath, projectRoot) {
  const IDEMPOTENCY_MARKER = '**Authoritative post-compact recovery source:**';

  try {
    // Read the source section from the package CLAUDE.md.
    if (!fs.existsSync(pkgClaudeMdPath)) {
      // Package CLAUDE.md absent (edge case during development). Nothing to merge.
      return;
    }
    const pkgContent = fs.readFileSync(pkgClaudeMdPath, 'utf8');

    // Extract the ## Compact Instructions section.
    const sectionMatch = pkgContent.match(
      /(## Compact Instructions[\s\S]*?)(?=\n## |\n<!-- |$)/
    );
    if (!sectionMatch) {
      // Section not found in package CLAUDE.md; skip silently.
      return;
    }
    const sectionText = sectionMatch[1].trimEnd();

    const userClaudeMdPath = path.join(projectRoot, 'CLAUDE.md');
    const exists = fs.existsSync(userClaudeMdPath);

    if (!exists) {
      // Case (a): create a minimal CLAUDE.md with just this section.
      fs.writeFileSync(userClaudeMdPath, sectionText + '\n', { encoding: 'utf8' });
      // FN-23: this function is eval-extracted by tests/install/claude-md-merge
      // and runs in a Function-eval scope without `say` in scope. Use raw
      // process.stderr.write here instead of the say() helper.
      process.stderr.write('  \x1b[32m✓\x1b[0m Created CLAUDE.md with ## Compact Instructions section\n');
      return;
    }

    const existing = fs.readFileSync(userClaudeMdPath, 'utf8');

    if (existing.includes(IDEMPOTENCY_MARKER)) {
      // Case (c): already present — no-op.
      return;
    }

    if (existing.includes('## Compact Instructions')) {
      // Section header exists but missing the load-bearing paragraph.
      // Append the full section after the existing file to avoid partial merges.
      // The duplicate header is harmless; it will be deduplicated by readers.
      const appended = existing.trimEnd() + '\n\n' + sectionText + '\n';
      fs.writeFileSync(userClaudeMdPath, appended, { encoding: 'utf8' });
      process.stderr.write('  \x1b[32m✓\x1b[0m Updated CLAUDE.md ## Compact Instructions with resilience paragraph\n');
    } else {
      // Case (b): section entirely absent — append.
      const appended = existing.trimEnd() + '\n\n' + sectionText + '\n';
      fs.writeFileSync(userClaudeMdPath, appended, { encoding: 'utf8' });
      process.stderr.write('  \x1b[32m✓\x1b[0m Appended ## Compact Instructions to CLAUDE.md\n');
    }
  } catch (err) {
    // Non-fatal: log a warning but do not abort the install.
    process.stderr.write(
      '  \x1b[33m⚠\x1b[0m Could not merge ## Compact Instructions into CLAUDE.md: ' +
      String(err && err.message || err).slice(0, 200) + '\n'
    );
  }
}

/**
 * Read the previously-installed Orchestray version string from
 * `<targetDir>/orchestray/VERSION`. Must be called BEFORE the new VERSION
 * file is written — otherwise it will read the newly-written value, not the
 * prior one (R2-B-1 fix).
 *
 * @param {string} targetDir  The Claude config directory (e.g. ~/.claude).
 * @returns {string|null}     Trimmed version string, or null on any error.
 */
function readPreviousVersion(targetDir) {
  try {
    return fs.readFileSync(
      path.join(targetDir, 'orchestray', 'VERSION'), 'utf8'
    ).trim() || null;
  } catch (_e) {
    // File absent on fresh installs — not an error.
    return null;
  }
}

function install(targetDir) {
  // -------------------------------------------------------------------------
  // DEF-6: install footprint — verification comment
  //
  // COPIED into <targetDir>/:
  //   - agents/*.md and agents/<subdir>/*               (agent definitions)
  //   - skills/<skill>/SKILL.md and skill subdirs       (skill library)
  //   - orchestray/bin/*.js (excluding install.js)      (hook scripts)
  //   - orchestray/bin/mcp-server/** (recursive)        (MCP server sources)
  //   - orchestray/.claude-plugin/plugin.json           (required by mcp-server
  //                                                      lib/paths.js walk-up;
  //                                                      do not remove)
  //   - orchestray/settings.json                        (default agent config)
  //   - orchestray/CLAUDE.md                            (reference doc)
  //   - orchestray/VERSION, orchestray/manifest.json    (install tracking)
  //   - settings.json (merged)                          (hook wiring)
  //
  // REGISTERED outside <targetDir>/:
  //   - mcpServers entries from .claude-plugin/plugin.json are written to
  //     either ~/.claude.json (global) or ./.mcp.json (local) so Claude Code
  //     loads the MCP server at session start. manifest.mcpServers lists the
  //     registered names for clean uninstall.
  // -------------------------------------------------------------------------

  // Ensure target directories exist
  const dirs = ['agents', 'skills', 'hooks', 'orchestray', 'orchestray/bin'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(targetDir, d), { recursive: true });
  }

  // DEF-5: track every file we copy as a target-relative path so uninstall
  // can remove ONLY what we installed. Old manifests used agentSubdirs +
  // skills + hooks and called rmSync(dir, {recursive:true}) which would
  // delete user files accidentally mixed into those dirs.
  const trackedFiles = [];
  const track = (targetRelPath) => trackedFiles.push(targetRelPath);

  // 1. Copy agents
  const agentsDir = path.join(pkgRoot, 'agents');
  const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  for (const file of agentFiles) {
    fs.copyFileSync(
      path.join(agentsDir, file),
      path.join(targetDir, 'agents', file)
    );
    track(path.join('agents', file));
  }
  // Copy subdirectories within agents/ (e.g., pm-reference/)
  const agentSubdirs = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  for (const dir of agentSubdirs) {
    const srcSub = path.join(agentsDir, dir);
    const dstSub = path.join(targetDir, 'agents', dir);
    fs.mkdirSync(dstSub, { recursive: true });
    for (const file of fs.readdirSync(srcSub)) {
      fs.copyFileSync(path.join(srcSub, file), path.join(dstSub, file));
      track(path.join('agents', dir, file));
    }
  }
  const refCount = agentSubdirs.reduce((n, dir) => n + fs.readdirSync(path.join(agentsDir, dir)).length, 0);
  say(`  \x1b[32m✓\x1b[0m Installed ${agentFiles.length} agents + ${refCount} reference files`);

  // 1b. v2.1.9 I-13: install specialists and symlink into agents/ so
  // Claude Code's Agent() tool can resolve `subagent_type: <name>` for
  // shipped specialists.
  //
  // Without this step, `Agent(subagent_type="translator")` errors with
  // "unknown subagent_type" on a fresh install because only the 13 built-in
  // agents are registered. The fix copies specialists into the installed
  // tier and creates a symlink per specialist in agents/.
  //
  // Windows fallback: if symlink creation fails with EPERM, fall back to
  // fs.copyFileSync and warn once. Copied files will NOT survive
  // /orchestray:update — users on Windows need admin or Developer Mode for
  // durable symlink support.
  const specialistsDir = path.join(pkgRoot, 'specialists');
  let specialistSymlinkedCount = 0;
  let specialistCopiedCount = 0;
  let specialistSkippedCount = 0;
  let windowsFallbackWarned = false;
  if (fs.existsSync(specialistsDir) && fs.statSync(specialistsDir).isDirectory()) {
    const specFiles = fs.readdirSync(specialistsDir).filter(f => f.endsWith('.md'));
    const installedSpecDir = path.join(targetDir, 'orchestray', 'specialists');
    if (specFiles.length > 0) {
      fs.mkdirSync(installedSpecDir, { recursive: true });
    }
    for (const specFile of specFiles) {
      const srcPath = path.join(specialistsDir, specFile);
      const installedPath = path.join(installedSpecDir, specFile);
      const symlinkPath = path.join(targetDir, 'agents', specFile);
      const expectedTarget = installedPath;

      // 1) Copy specialist body into the installed tier so uninstall knows
      // where it lives and /orchestray:update can refresh it.
      try {
        fs.copyFileSync(srcPath, installedPath);
        track(path.join('orchestray', 'specialists', specFile));
      } catch (err) {
        say(
          '  \x1b[33m⚠\x1b[0m Could not copy specialist ' + specFile + ': ' + err.message
        );
        continue;
      }

      // 2) Create a symlink agents/<name>.md -> orchestray/specialists/<name>.md
      // so Claude Code's subagent registry picks it up. Idempotent: if the
      // symlink already points where we expect, keep it; otherwise skip
      // (user customization takes precedence).
      let existingIsCorrect = false;
      let existingConflict = false;
      try {
        const lstat = fs.lstatSync(symlinkPath);
        if (lstat.isSymbolicLink()) {
          try {
            const currentTarget = fs.readlinkSync(symlinkPath);
            const resolved = path.isAbsolute(currentTarget)
              ? currentTarget
              : path.resolve(path.dirname(symlinkPath), currentTarget);
            if (resolved === expectedTarget) {
              existingIsCorrect = true;
            } else {
              existingConflict = true;
            }
          } catch (_) {
            existingConflict = true;
          }
        } else {
          // Regular file or directory; treat as user customization.
          existingConflict = true;
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          existingConflict = true;
        }
      }

      if (existingConflict) {
        say(
          '  \x1b[33m⚠\x1b[0m Skipping specialist symlink ' + path.join('agents', specFile) +
          ' (existing file not managed by this installer)'
        );
        specialistSkippedCount++;
        continue;
      }

      if (existingIsCorrect) {
        track(path.join('agents', specFile));
        specialistSymlinkedCount++;
        continue;
      }

      // Create fresh symlink.
      try {
        fs.symlinkSync(expectedTarget, symlinkPath, 'file');
        track(path.join('agents', specFile));
        specialistSymlinkedCount++;
      } catch (err) {
        if (err && err.code === 'EPERM') {
          // Windows without admin / Developer Mode. Fall back to copy.
          try {
            fs.copyFileSync(installedPath, symlinkPath);
            track(path.join('agents', specFile));
            specialistCopiedCount++;
            if (!windowsFallbackWarned) {
              say(
                '  \x1b[33m⚠\x1b[0m Symlink permission denied; copied specialists into agents/. ' +
                'Edits to copied files will not survive /orchestray:update. ' +
                'Enable Developer Mode or run as admin for durable symlinks.'
              );
              windowsFallbackWarned = true;
            }
          } catch (copyErr) {
            say(
              '  \x1b[33m⚠\x1b[0m Could not install specialist ' + specFile + ' (' + copyErr.message + ')'
            );
          }
        } else {
          say(
            '  \x1b[33m⚠\x1b[0m Could not symlink specialist ' + specFile + ' (' + err.message + ')'
          );
        }
      }
    }

    const totalInstalled = specialistSymlinkedCount + specialistCopiedCount;
    if (totalInstalled > 0) {
      const how = specialistCopiedCount > 0
        ? 'symlinked ' + specialistSymlinkedCount + ', copied ' + specialistCopiedCount
        : 'symlinked into agents/';
      say('  \x1b[32m✓\x1b[0m Installed ' + totalInstalled + ' specialists (' + how + ')');
    }
    if (specialistSkippedCount > 0) {
      say(
        '  \x1b[33m⚠\x1b[0m Skipped ' + specialistSkippedCount +
        ' specialist(s) due to user-managed files in agents/'
      );
    }
  }

  // 2. Copy skills (each is a directory with SKILL.md)
  const skillsDir = path.join(pkgRoot, 'skills');
  const skillDirs = fs.readdirSync(skillsDir).filter(f => {
    const fullPath = path.join(skillsDir, f);
    return fs.statSync(fullPath).isDirectory();
  });
  for (const dir of skillDirs) {
    const targetSkillDir = path.join(targetDir, 'skills', dir);
    fs.mkdirSync(targetSkillDir, { recursive: true });
    const skillFile = path.join(skillsDir, dir, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      fs.copyFileSync(skillFile, path.join(targetSkillDir, 'SKILL.md'));
      track(path.join('skills', dir, 'SKILL.md'));
    }
    // Copy subdirectories within each skill (e.g., templates/)
    const subDirs = fs.readdirSync(path.join(skillsDir, dir), { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const sub of subDirs) {
      const srcSub = path.join(skillsDir, dir, sub.name);
      const dstSub = path.join(targetSkillDir, sub.name);
      fs.mkdirSync(dstSub, { recursive: true });
      for (const file of fs.readdirSync(srcSub)) {
        fs.copyFileSync(path.join(srcSub, file), path.join(dstSub, file));
        track(path.join('skills', dir, sub.name, file));
      }
    }
  }
  say(`  \x1b[32m✓\x1b[0m Installed ${skillDirs.length} skills`);

  // 3. Copy bin scripts to orchestray/bin/
  const binDir = path.join(pkgRoot, 'bin');
  const binFiles = fs.readdirSync(binDir).filter(f => f.endsWith('.js') && f !== 'install.js');
  for (const file of binFiles) {
    fs.copyFileSync(
      path.join(binDir, file),
      path.join(targetDir, 'orchestray', 'bin', file)
    );
    track(path.join('orchestray', 'bin', file));
  }
  // Installed hook scripts `require('./_lib/...')` relative to their own directory,
  // so the _lib/ subtree must be copied alongside them or every hook will throw
  // MODULE_NOT_FOUND on first fire. Runtime subdirs (e.g. migrations/) are
  // included; test fixtures (__tests__/) are excluded via skipDir.
  const libDir = path.join(binDir, '_lib');
  if (fs.existsSync(libDir) && fs.statSync(libDir).isDirectory()) {
    const dstLibDir = path.join(targetDir, 'orchestray', 'bin', '_lib');
    const libFiles = copyJsTree(libDir, dstLibDir, name => name === '__tests__');
    for (const rel of libFiles) {
      track(path.join('orchestray', 'bin', '_lib', rel));
    }
  }
  // Copy any named subdirectories that contain hook scripts (e.g. release-manager/).
  // These are NOT covered by the top-level binFiles loop above (which only reads
  // immediate .js files) and NOT covered by _lib/ (which is a shared library dir).
  // Without this, hooks.json entries that reference bin/release-manager/*.js are
  // installed as hook registrations but the scripts themselves are never copied —
  // causing the pruning pass on the next install to remove those entries (because
  // the scripts don't exist), then re-add them merged into the wrong entry.
  const BIN_SUBDIRS = ['release-manager'];
  for (const subName of BIN_SUBDIRS) {
    const subSrc = path.join(binDir, subName);
    if (fs.existsSync(subSrc) && fs.statSync(subSrc).isDirectory()) {
      const subDst = path.join(targetDir, 'orchestray', 'bin', subName);
      const subFiles = copyJsTree(subSrc, subDst);
      for (const rel of subFiles) {
        track(path.join('orchestray', 'bin', subName, rel));
      }
    }
  }
  say(`  \x1b[32m✓\x1b[0m Installed ${binFiles.length} hook scripts`);

  // 3a. F-04 closure: install `ox` as a bare command so agents can invoke
  // `ox <verb>` without specifying the full path.
  //
  // Approach: create a wrapper shim `<targetDir>/orchestray/bin/ox` (no .js
  // extension) with executable permissions, then prepend the bin directory
  // to PATH in settings.json `env.PATH`.
  //
  // Windows note: .js shebangs don't work natively; we fall back to a .cmd
  // wrapper on Windows (detected via process.platform === 'win32').
  try {
    const oxSrcPath = path.join(targetDir, 'orchestray', 'bin', 'ox.js');
    const oxBinDir  = path.join(targetDir, 'orchestray', 'bin');
    const isWindows = process.platform === 'win32';
    const shimPath  = path.join(oxBinDir, isWindows ? 'ox.cmd' : 'ox');

    if (!fs.existsSync(oxSrcPath)) {
      say('  \x1b[33m⚠\x1b[0m ox.js not found in bin/; skipping ox shim install');
    } else {
      if (isWindows) {
        const cmdContent = `@echo off\nnode "%~dp0ox.js" %*\n`;
        fs.writeFileSync(shimPath, cmdContent, { encoding: 'utf8' });
        track(path.join('orchestray', 'bin', 'ox.cmd'));
      } else {
        const shimContent = `#!/bin/sh\nexec node "$(dirname "$0")/ox.js" "$@"\n`;
        fs.writeFileSync(shimPath, shimContent, { encoding: 'utf8', mode: 0o755 });
        try { fs.chmodSync(shimPath, 0o755); } catch (_e) {}
        track(path.join('orchestray', 'bin', 'ox'));
      }
      _prependOxBinToPath(targetDir, oxBinDir);
      say('  \x1b[32m✓\x1b[0m Installed `ox` shim; bare `ox help` is now available');
    }
  } catch (oxErr) {
    say(
      '  \x1b[33m⚠\x1b[0m ox shim install failed (' + oxErr.message + '). ' +
      'Use `node <install-dir>/orchestray/bin/ox.js` as fallback.'
    );
  }

  // 3b. Copy MCP server tree (recursive, .js only) to orchestray/bin/mcp-server/
  const mcpSrcDir = path.join(binDir, 'mcp-server');
  let mcpFileCount = 0;
  if (fs.existsSync(mcpSrcDir) && fs.statSync(mcpSrcDir).isDirectory()) {
    const mcpDstDir = path.join(targetDir, 'orchestray', 'bin', 'mcp-server');
    const copied = copyJsTree(mcpSrcDir, mcpDstDir);
    for (const rel of copied) {
      track(path.join('orchestray', 'bin', 'mcp-server', rel));
    }
    mcpFileCount = copied.length;
  }

  // 3c. Copy .claude-plugin/plugin.json into the install so mcp-server's
  // lib/paths.js getPluginRoot() walk-up succeeds at runtime. Without this
  // the MCP server throws 'plugin root not found' on startup.
  const pluginJsonSrc = path.join(pkgRoot, '.claude-plugin', 'plugin.json');
  let pluginJson = null;
  if (fs.existsSync(pluginJsonSrc)) {
    const dstPluginDir = path.join(targetDir, 'orchestray', '.claude-plugin');
    fs.mkdirSync(dstPluginDir, { recursive: true });
    fs.copyFileSync(pluginJsonSrc, path.join(dstPluginDir, 'plugin.json'));
    track(path.join('orchestray', '.claude-plugin', 'plugin.json'));
    try {
      pluginJson = JSON.parse(fs.readFileSync(pluginJsonSrc, 'utf8'));
    } catch (_e) { /* ignore — MCP registration will be skipped */ }
  }
  if (mcpFileCount > 0) {
    say(`  \x1b[32m✓\x1b[0m Installed MCP server (${mcpFileCount} files)`);
  }

  // 3d. Copy schemas/ directory to orchestray/schemas/ (sibling of bin/).
  // validate-config.js does require('../schemas') — it must live at the
  // orchestray root level, NOT under bin/. Without this, every global-install
  // SessionStart hook throws node:fs:1012 (ENOENT) because validate-config.js
  // cannot find the module. Latent since v2.2.9 B-7 introduced schemas/.
  const schemasSrc = path.join(pkgRoot, 'schemas');
  let schemasFileCount = 0;
  if (fs.existsSync(schemasSrc) && fs.statSync(schemasSrc).isDirectory()) {
    const schemasDst = path.join(targetDir, 'orchestray', 'schemas');
    const schemasFiles = copyJsTree(schemasSrc, schemasDst);
    for (const rel of schemasFiles) {
      track(path.join('orchestray', 'schemas', rel));
    }
    schemasFileCount = schemasFiles.length;
    say(`  \x1b[32m✓\x1b[0m Installed schemas/ (${schemasFileCount} files)`);
  } else {
    say('  \x1b[33m⚠\x1b[0m schemas/ not found in source; skipping');
  }

  // 3d-zod (v2.2.15 P1-11 install fix): bin/_lib/config-schema.js requires
  // 'zod' at module-load. Without copying node_modules/zod into the install
  // target, MCP server boots with MODULE_NOT_FOUND on every session. zod 4.x
  // has zero transitive deps so a single-package copy is sufficient.
  // Use fs.cpSync (not copyJsTree) because zod's CommonJS entry point is
  // index.cjs which copyJsTree's .js-only filter excludes. cpSync also
  // preserves the package.json + .d.ts files needed by editor tooling.
  const zodSrc = path.join(pkgRoot, 'node_modules', 'zod');
  if (fs.existsSync(zodSrc) && fs.statSync(zodSrc).isDirectory()) {
    const zodDst = path.join(targetDir, 'orchestray', 'node_modules', 'zod');
    fs.cpSync(zodSrc, zodDst, {
      recursive: true,
      // Skip src/ (TypeScript source — runtime uses index.cjs / index.js) and
      // locales/ (~MB of i18n strings; v2.2.15 only uses zod's English errors).
      filter: (s) => {
        // Skip src/ (TypeScript source — runtime uses index.cjs/index.js).
        // KEEP locales/ — zod's index.cjs requires '../locales/index.cjs' even
        // when only English errors are surfaced (v2.2.15 P1-11 install fix).
        const base = path.basename(s);
        if (base === 'src') return false;
        return true;
      },
    });
    let zodFileCount = 0;
    const countWalk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) countWalk(path.join(dir, e.name));
        else if (e.isFile()) { zodFileCount++; track(path.relative(targetDir, path.join(dir, e.name))); }
      }
    };
    countWalk(zodDst);
    say(`  \x1b[32m✓\x1b[0m Installed node_modules/zod (${zodFileCount} files)`);
  } else {
    say('  \x1b[33m⚠\x1b[0m node_modules/zod not found in source; mcp-server boot will fail');
  }

  // 3d post-install verification (FN-20 v2.2.15): fork validate-config.js
  // against a tmp fixture. The prior bare `require.resolve('../schemas')`
  // confirmed the path resolved but never exercised require()'d submodules
  // (config-schema.js etc.); a missing transitive require would still throw
  // node:fs:1012 on first SessionStart fire. The dry-run probe loads the full
  // module graph in a child process and reports a clear error if anything is
  // missing. Best-effort: warn-only — never abort the install.
  try {
    const installedValidator = path.join(targetDir, 'orchestray', 'bin', 'validate-config.js');
    if (fs.existsSync(installedValidator)) {
      const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-validate-probe-'));
      try {
        fs.mkdirSync(path.join(probeDir, '.orchestray'), { recursive: true });
        fs.writeFileSync(
          path.join(probeDir, '.orchestray', 'config.json'),
          JSON.stringify({ mcp_server: { tools: { pattern_find: true } } }, null, 2),
          'utf8'
        );
        const { spawnSync } = require('node:child_process');
        const probe = spawnSync(
          process.execPath,
          [installedValidator, '--json', '--cwd', probeDir],
          { encoding: 'utf8', timeout: 10_000 }
        );
        if (probe.status !== 0) {
          console.error(
            `  \x1b[31m✗\x1b[0m Post-install verification failed: validate-config.js exited ` +
            `${probe.status} when probed against a tmp fixture. ` +
            `SessionStart hook will likely throw node:fs:1012 or similar for all users.\n` +
            `    stdout: ${(probe.stdout || '').slice(0, 200)}\n` +
            `    stderr: ${(probe.stderr || '').slice(0, 200)}`
          );
        }
      } finally {
        try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (_e) {}
      }
    } else {
      // FN-20: fall back to bare resolve check when the validator isn't
      // installed (test fixtures, partial copies). Parity with prior check.
      require.resolve('../schemas', { paths: [path.join(targetDir, 'orchestray', 'bin')] });
    }
  } catch (resolveErr) {
    console.error(
      `  \x1b[31m✗\x1b[0m Post-install verification failed: ${resolveErr.message}`
    );
  }

  // 4. Merge hooks into existing hooks.json (don't overwrite user's hooks)
  mergeHooks(targetDir);
  say(`  \x1b[32m✓\x1b[0m Configured hooks`);

  // 4.1 FN-17 (v2.2.15): additively merge top-level non-hook keys from repo
  // settings.json into the user's active settings.json. Without this step,
  // repo-root settings.json keys like `agent: "pm"` and `subagentStatusLine`
  // never reach the user's active config — they only sit in
  // <install>/orchestray/settings.json which Claude Code does not read.
  // NEVER overwrites user values; only adds keys that are absent.
  // Kill switch (default OFF — gate is ON): ORCHESTRAY_INSTALL_TOPLEVEL_MERGE_GATE_DISABLED=1.
  if (process.env.ORCHESTRAY_INSTALL_TOPLEVEL_MERGE_GATE_DISABLED !== '1') {
    mergeTopLevelSettings(targetDir);
  }

  // 4a. (v2.2.7) The v2.2.6 auto-dedup pass was REMOVED here. Orchestray
  // does NOT copy `hooks/hooks.json` to the install location, so the user's
  // `~/.claude/settings.json` is the *only* place hook registrations live
  // in a working install. The v2.2.6 dedup compared settings.json against
  // the source-repo manifest, decided the entries were duplicates, and
  // removed them — leaving Tokenwright (and only Tokenwright) with nowhere
  // to fire. The helper at `bin/_lib/dedup-plugin-hooks.js` and the runtime
  // double-fire guard remain as utilities; users with a hand-edited duplicate
  // registration can run the helper directly. Auto-invocation at install
  // time is gone.

  // 4b. Register MCP servers with Claude Code (global: ~/.claude.json,
  // local: ./.mcp.json). Tracks names in manifest for clean uninstall.
  const mcpServerNames = mergeMcpServers(pluginJson, targetDir, flags.local);
  if (mcpServerNames.length > 0) {
    say(`  \x1b[32m✓\x1b[0m Registered MCP server${mcpServerNames.length > 1 ? 's' : ''}: ${mcpServerNames.join(', ')}`);
    say(`    \x1b[33mNote:\x1b[0m restart Claude Code for the MCP server to load.`);
  }

  // 5. Copy settings.json for default agent config
  const settingsSrc = path.join(pkgRoot, 'settings.json');
  const settingsDst = path.join(targetDir, 'orchestray', 'settings.json');
  if (fs.existsSync(settingsSrc)) {
    fs.copyFileSync(settingsSrc, settingsDst);
    track(path.join('orchestray', 'settings.json'));
  }

  // 6. Copy CLAUDE.md to orchestray/ for reference
  const claudeMdSrc = path.join(pkgRoot, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(targetDir, 'orchestray', 'CLAUDE.md'));
    track(path.join('orchestray', 'CLAUDE.md'));
  }

  // 6a. SB2: Merge the load-bearing ## Compact Instructions section from the
  // package CLAUDE.md into the user's project-level CLAUDE.md (process.cwd()/CLAUDE.md).
  // This is idempotent: skipped if the marker string is already present.
  // If no CLAUDE.md exists it is created with only this section.
  // CLAUDE.md is gitignored in this repo so it would never reach fresh installs
  // via npm — this step ensures the compaction-preserve paragraph is always present.
  _mergeCompactInstructionsIntoCLAUDEmd(claudeMdSrc, process.cwd());

  // 7. Write version file.
  // R2-B-1 fix: capture previous version BEFORE overwriting — readPreviousVersion
  // reads this same file, so it must be called first or it will return the new
  // VERSION value, making previous_version === version in the upgrade sentinel.
  const prevVersion = readPreviousVersion(targetDir);
  fs.writeFileSync(path.join(targetDir, 'orchestray', 'VERSION'), VERSION + '\n');
  track(path.join('orchestray', 'VERSION'));

  // 8a. Seed .orchestray/config.json with default MCP tool enable map and
  // cost_budget_check pricing table if no config file exists yet.
  // Only written for fresh installs (file absent) — never overwrites user edits.
  // The .orchestray/ directory is in the project root (process.cwd()), not in
  // targetDir (.claude/). Constants FRESH_INSTALL_MCP_TOOLS_ENABLED and
  // FRESH_INSTALL_COST_BUDGET_CHECK above are the single sources of truth for
  // these seeds. Per 2014-scope-proposal.md §W1 AC4(d) and §W3 AC4.

  // B1 (v2.1.0): create shared federation directories if federation is enabled
  // in the current project's config. Done BEFORE config seeding so the check
  // also applies to existing installs that have enabled federation.
  // Only creates dirs if they don't already exist (idempotent).
  // Uses 0700 permissions (user-only) per the federation design.
  _maybeCreateSharedFederationDirs(process.cwd());

  const orchStateDir = path.join(process.cwd(), '.orchestray');
  const freshConfigPath = path.join(orchStateDir, 'config.json');
  if (!fs.existsSync(freshConfigPath)) {
    const freshConfig = {
      mcp_server: {
        tools: FRESH_INSTALL_MCP_TOOLS_ENABLED,
        cost_budget_check: FRESH_INSTALL_COST_BUDGET_CHECK,
        // W6 (v2.0.16): per-task rate-limit seeds (OQ4: ask_user:20, kb_write:20, pra:20)
        max_per_task: {
          ask_user: 20,
          kb_write: 20,
          pattern_record_application: 20,
        },
        // D5 (v2.0.16 amendment): cost_budget_reserve TTL (discoverable default)
        cost_budget_reserve: { ttl_minutes: 30 },
      },
      // D3 (v2.0.16 amendment): cost_budget_enforcement with hard_block:true default.
      // enabled:false means the gate is opt-in; hard_block:true is the correct default
      // for operators who enable it (they expect hard blocking, not soft warn).
      cost_budget_enforcement: { enabled: false, hard_block: true },
      // D7 (v2.0.16 amendment): routing_gate.auto_seed_on_miss (discoverable default)
      routing_gate: { auto_seed_on_miss: true },
      // T4 (v2.0.17): v2017 experiment flags — all default off
      v2017_experiments: FRESH_INSTALL_V2017_EXPERIMENTS,
      // T12 (v2.0.17): cache_choreography — pre-commit guard opt-in + drift threshold
      cache_choreography: FRESH_INSTALL_CACHE_CHOREOGRAPHY,
      // T22 (v2.0.17): adaptive_verbosity — response-length budget (opt-in; also requires experiment flag)
      adaptive_verbosity: FRESH_INSTALL_ADAPTIVE_VERBOSITY,
      // W9 (v2.0.18): pattern_decay — confidence half-life for pattern matching
      pattern_decay: FRESH_INSTALL_PATTERN_DECAY,
      // W12 (v2.0.18): anti_pattern_gate — pre-spawn advisory gate config
      anti_pattern_gate: FRESH_INSTALL_ANTI_PATTERN_GATE,
      // W7 (v2.0.18): state_sentinel — pause/cancel sentinel config
      state_sentinel: FRESH_INSTALL_STATE_SENTINEL,
      // W8 (v2.0.18): redo_flow — cascade depth + commit prefix config
      redo_flow: FRESH_INSTALL_REDO_FLOW,
      // R-FLAGS (v2.1.14): drift sentinel off by default for new installs.
      // Seldom produces actionable output on typical workloads; users who rely
      // on it set `enable_drift_sentinel: true` in .orchestray/config.json.
      enable_drift_sentinel: false,
      // R-AIDER-FULL (v2.1.17): Aider-style repo-map seed. See
      // FRESH_INSTALL_REPO_MAP comment above.
      repo_map: FRESH_INSTALL_REPO_MAP,
    };
    try {
      fs.mkdirSync(orchStateDir, { recursive: true });
      fs.writeFileSync(freshConfigPath, JSON.stringify(freshConfig, null, 2) + '\n');
      say(`  \x1b[32m✓\x1b[0m Seeded .orchestray/config.json with default MCP tool map and pricing table`);
    } catch (_e) {
      // Non-fatal: the config defaults via fail-open loaders if the write fails.
      say(`  \x1b[33m⚠\x1b[0m Could not seed .orchestray/config.json (will use built-in defaults)`);
    }
  }

  // 8a (v2.2.1 W2). One-shot self-heal sweep — clears stale
  // `.block-a-zone-caching-disabled` and `housekeeper-quarantined` sentinels
  // from v2.2.0's false-positive era. Idempotent (writes
  // `.orchestray/state/.v221-self-heal-done`); fail-open at every step.
  try {
    const { runSelfHeal } = require('./v221-self-heal');
    const r = runSelfHeal(process.cwd());
    if (r && r.ran) {
      const cleared = [];
      if (r.cache_sentinel_cleared)         cleared.push('cache-disable sentinel');
      if (r.housekeeper_quarantine_cleared) cleared.push('housekeeper quarantine');
      if (cleared.length > 0) {
        say(`  \x1b[32m✓\x1b[0m v2.2.1 self-heal: cleared ${cleared.join(', ')}`);
      }
    }
  } catch (_e) {
    // Fail-open: never fail the install on self-heal errors.
  }

  // 8. Write manifest for clean uninstall.
  // Compute per-file SHA-256 hashes for all tracked files (manifest schema v2).
  // Excluded from hashing: manifest.json itself (cannot self-hash).
  // The EXCLUDED_FROM_HASH set is the forward-compat hook for paths that should
  // not be hashed (e.g., user-mutable settings). Currently empty — all
  // trackedFiles are hashed.
  const EXCLUDED_FROM_HASH = new Set([]);
  const hashableFiles = trackedFiles.filter(p => !EXCLUDED_FROM_HASH.has(p));

  let hashResult;
  try {
    hashResult = computeManifest(targetDir, hashableFiles);
  } catch (err) {
    console.error(
      `\n  \x1b[31m✗\x1b[0m Install integrity hash failed: ${err.message}\n` +
      `    This indicates a partial or corrupted copy. Re-run the installer.\n`
    );
    process.exit(1);
  }

  const manifest = {
    manifest_schema: 2,
    version: VERSION,
    installedAt: new Date().toISOString(),
    scope: flags.local ? 'local' : 'global',
    agents: agentFiles,
    agentSubdirs: agentSubdirs,
    skills: skillDirs,
    hooks: binFiles,
    mcpServers: mcpServerNames,
    files: trackedFiles, // DEF-5: per-file manifest for precise uninstall (array preserved for v1 compat)
    files_hashes:       hashResult.files_hashes,
    hash_algorithm:     hashResult.hash_algorithm,
    hash_normalization: hashResult.hash_normalization,
  };
  fs.writeFileSync(
    path.join(targetDir, 'orchestray', 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  say(`  \x1b[32m✓\x1b[0m Wrote VERSION (${VERSION})`);

  // v2.0.22: drop an upgrade-pending sentinel (schema v2) so the next
  // UserPromptSubmit in any still-open Claude Code session can warn the user
  // that a restart is required. The installer runs at user-scope and doesn't
  // know which projects are open, so the sentinel lives at ~/.claude/ (a path
  // post-upgrade-sweep can find regardless of project cwd). Best-effort —
  // never fail the install on sentinel-write errors.
  // B-8 fix: mkdirSync with recursive:true guards against fresh-machine ENOENT.
  try {
    const sentinelPath = path.join(os.homedir(), '.claude', '.orchestray-upgrade-pending');
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    const now = Date.now();
    const sentinelData = {
      schema_version: 2,
      installed_at: new Date(now).toISOString(),
      installed_at_ms: now,
      version: VERSION,
      // R-RCPT-V2 (v2.1.13): advertise features whose code path requires a
      // Claude Code restart to take effect (because agent registry is cached
      // at session start). Operators / downstream tools can read this list to
      // explain *what* specifically the restart unlocks instead of a generic
      // "restart required" nudge.
      restart_gated_features: ['project-intent-agent'],
    };
    // Only include previous_version when it differs from the new version
    // (avoids self-contradictory "was vX → now vX" on fresh installs where
    // VERSION already happened to match, or identity non-upgrades).
    if (prevVersion !== null && prevVersion !== VERSION) {
      sentinelData.previous_version = prevVersion;
    }
    fs.writeFileSync(sentinelPath, JSON.stringify(sentinelData) + '\n', 'utf8');
  } catch (_e) { /* fail-open */ }

  // v2.2.6: write a sentinel so the first UserPromptSubmit after this install
  // triggers the tokenwright self-probe (post-upgrade-sweep.js picks this up).
  // The sentinel lives in .orchestray/state/ which is project-local; stateDir
  // was already created above by the config seed step (mkdirSync recursive).
  try {
    const orchStateDir226 = path.join(process.cwd(), '.orchestray', 'state');
    fs.mkdirSync(orchStateDir226, { recursive: true });
    const selfProbeSentinel = path.join(orchStateDir226, 'tokenwright-self-probe-needed');
    const pkg = require('../package.json');
    fs.writeFileSync(
      selfProbeSentinel,
      JSON.stringify({ created: new Date().toISOString(), version: pkg.version }) + '\n',
      'utf8'
    );
  } catch (_e) { /* tolerate — probe is best-effort */ }

  // v2.1.0: emit a one-time advisory on first install of this major feature version.
  // Only fires when upgrading from v2.0.x (prevVersion starts with "2.0.") or on a
  // fresh install (prevVersion === null) onto a v2.1.0 package.
  // The message is informational and non-blocking; stderr keeps it out of pipe output.
  if (VERSION.startsWith('2.1.') && (prevVersion === null || (prevVersion && prevVersion.startsWith('2.0.')))) {
    process.stderr.write(
      '\n  [orchestray] v2.1.0 ships federation + FTS5 + curator. All are opt-in.\n' +
      '  See /orchestray:config show federation and /orchestray:learn --help for details.\n\n'
    );
  }

  // U-2 fix: RESTART reminder appears BEFORE "Done!" so it is not missed.
  // FN-23: final-ceremony block stays on stdout — this is the user-visible
  // success summary, not advisory chatter.
  console.log('');
  console.log('  \x1b[33m!\x1b[0m  RESTART required — Claude Code caches agent definitions at session');
  console.log('     start. Close and reopen any open session to pick up new agents.');
  console.log('     (The /agents UI reads but does not refresh the registry.)');
  console.log('');
  console.log('  \x1b[32mDone!\x1b[0m Orchestray v' + VERSION + ' installed.');
  console.log('');
  console.log('  The PM agent auto-detects complex tasks.');
  console.log('  Or run \x1b[36m/orchestray:run [task]\x1b[0m to trigger manually.');
  console.log('');
}

/**
 * F-04 closure: prepend <oxBinDir> to the PATH entry in settings.json `env` block
 * so that bare `ox` resolves without requiring the full path.
 *
 * Idempotent: if the directory is already present in the PATH value, does nothing.
 * Non-fatal: any failure is logged but does not abort the install.
 *
 * @param {string} targetDir - The Claude config directory (e.g. ~/.claude).
 * @param {string} oxBinDir  - The absolute path to the ox bin directory.
 */
function _prependOxBinToPath(targetDir, oxBinDir) {
  try {
    const settingsFile = path.join(targetDir, 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsFile)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      } catch (_e) {
        // Malformed settings.json — leave PATH alone to avoid corruption.
        return;
      }
    }
    if (!settings.env) settings.env = {};
    // Preserve existing PATH: read from settings.json first, fall back to the
    // process PATH so that system directories (/usr/bin, /bin) are never lost.
    // If neither exists (edge case), use a safe minimal PATH.
    const systemPath = process.env.PATH || '/usr/bin:/bin';
    const current = settings.env.PATH || systemPath;
    const separator = process.platform === 'win32' ? ';' : ':';
    const parts = current.split(separator);
    if (parts.includes(oxBinDir)) return;  // Already present — idempotent no-op.
    settings.env.PATH = [oxBinDir, current].join(separator);
    // FN-18 (v2.2.15): use the writeJsonAtomic helper for parity with every
    // other settings.json write site. Helper writes via openSync+fsyncSync+
    // rename and is the canonical durability path.
    writeJsonAtomic(settingsFile, settings);
  } catch (err) {
    say('  \x1b[33m⚠\x1b[0m Could not update settings.json PATH for ox: ' + err.message);
  }
}

function mergeHooks(targetDir) {
  // Claude Code reads hooks from settings.json under the "hooks" key.
  // Format: { hooks: { EventName: [{ hooks: [{ type, command, timeout }] }] } }
  const settingsFile = path.join(targetDir, 'settings.json');
  const srcHooksFile = path.join(pkgRoot, 'hooks', 'hooks.json');

  let settings = {};
  if (fs.existsSync(settingsFile)) {
    // Abort rather than silently overwriting: a malformed existing settings.json
    // almost certainly contains unrelated Claude Code config the user cares about
    // (agent selection, permissions, etc.). Falling back to {} here would destroy
    // that data on the final writeFileSync below.
    const raw = fs.readFileSync(settingsFile, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.error(
        `\n  \x1b[31m✗\x1b[0m Cannot install: ${settingsFile} is not valid JSON.\n` +
        `    Parser said: ${e.message}\n` +
        `    Fix or back up this file before re-running the installer.\n` +
        `    Orchestray refused to overwrite it to avoid destroying unrelated settings.\n`
      );
      process.exit(1);
    }
  }
  if (!settings.hooks) settings.hooks = {};

  // FN-19 (v2.2.15): canonical-source parse hoisted ABOVE the prune sweep so
  // FN-16's stale-hook prune can consult the canonical-basename allowlist when
  // deciding whether to drop a hook entry from settings.json. Prior order parsed
  // canonical AFTER prune, which prevented "drop entries no longer in canonical"
  // from ever knowing the canonical set.
  let srcData = {};
  if (fs.existsSync(srcHooksFile)) {
    // Fail-fast on malformed canonical hooks.json. Silent catch{} previously
    // left srcData={} which produced an install with zero canonical hook
    // entries — symptom looks like "install succeeded" but no Orchestray hook
    // ever fires. Better to surface the malformed file.
    try {
      srcData = JSON.parse(fs.readFileSync(srcHooksFile, 'utf8'));
    } catch (e) {
      console.error('orchestray: canonical hooks/hooks.json is malformed: ' + (e && e.message ? e.message : e));
      process.exit(1);
    }
  }
  // Source format: { hooks: { Event: [{hooks:[...]}] } }
  const orchestrayHooks = srcData.hooks || srcData;

  // Build a flat allowlist of every basename declared anywhere in canonical
  // hooks.json. Used by FN-14 (arg-update) and FN-16 (prune).
  const canonicalBasenames = new Set();
  // canonicalCommandByBasename: basename → canonical full command template
  // (with ${CLAUDE_PLUGIN_ROOT}/bin/ unexpanded — we expand per-install below).
  const canonicalCommandByBasename = new Map();
  for (const entries of Object.values(orchestrayHooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of (entry.hooks || [])) {
        const cmd = h.command || '';
        const m = cmd.match(/^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/(\S+)(.*)$/);
        if (!m) continue;
        const scriptName = m[1];
        const base = path.basename(scriptName);
        canonicalBasenames.add(base);
        if (!canonicalCommandByBasename.has(base)) {
          canonicalCommandByBasename.set(base, { scriptName, rest: m[2] });
        }
      }
    }
  }

  // FN-16 prune kill switch (v2.2.15): default ON; opt-out for users who hand-
  // edited their settings.json with extra Orchestray-namespaced hooks they do
  // NOT want auto-removed. Per W6 collision-avoidance: `_GATE_DISABLED` suffix.
  const installPruneDisabled =
    process.env.ORCHESTRAY_INSTALL_PRUNE_GATE_DISABLED === '1';

  // Forward-compat: prune hooks pointing at scripts THIS install would have
  // produced but does not ship now. Catches rollback / upgrade-removal: a
  // prior install registered hooks for scripts that the current install
  // does not ship; without this sweep every fire produces a non-blocking
  // MODULE_NOT_FOUND. Scoped to OUR install's target bin/ — hooks under
  // any other path (other plugins, other orchestray installs on the same
  // machine, fictitious test paths) are left untouched.
  //
  // FN-16 (v2.2.15): also prune entries whose basename is not in the
  // canonical-allowlist, AND delete the stale script file from the install dir.
  // This catches the W2-08 case where 3 deleted hook scripts (`observe-output-shape`,
  // `track-scout-decision`, `inject-context-size-hint`) were emitting 176
  // undeclared rows on the active machine because the script files persisted
  // across upgrades and settings.json never had its entries removed.
  if (!installPruneDisabled) {
    const ourBinPrefix = path.join(targetDir, 'orchestray', 'bin') + path.sep;
    let pruned = 0;
    let prunedFiles = 0;
    const prunedDetails = [];
    // Only enable the "no longer canonical" prune when the canonical-set is
    // non-empty. Empty canonical = test fixture or partial install; falling
    // back to the v2.2.14 "missing-file only" behaviour avoids pruning live
    // hooks the test harness intentionally registered against an empty
    // canonical set.
    const canonicalKnown = canonicalBasenames.size > 0;
    for (const [event, entries] of Object.entries(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!Array.isArray(entry.hooks)) continue;
        for (let j = entry.hooks.length - 1; j >= 0; j--) {
          const cmd = entry.hooks[j].command || '';
          const m = cmd.match(/"([^"]+\.js)"/);
          if (!m) continue;
          const scriptPath = m[1];
          if (!scriptPath.startsWith(ourBinPrefix)) continue;
          const base = path.basename(scriptPath);
          // Skip user-managed entries (FN-14 advisory: command_managed:true).
          if (entry.hooks[j].command_managed === true) continue;
          // Reason 1: file gone from disk.
          const fileMissing = !fs.existsSync(scriptPath);
          // Reason 2: file present but no longer in canonical hooks.json.
          // This catches scripts that were deleted from the package source but
          // whose copies persisted in the install dir across upgrades. Gated on
          // canonicalKnown so test fixtures with empty canonical hooks.json
          // can still drive missing-file-only assertions.
          const noLongerCanonical = canonicalKnown && !fileMissing && !canonicalBasenames.has(base);
          if (fileMissing || noLongerCanonical) {
            entry.hooks.splice(j, 1);
            pruned++;
            prunedDetails.push({ event, matcher: entry.matcher || null, basename: base, reason: fileMissing ? 'file_missing' : 'no_longer_canonical' });
            // Reason 2 only: also remove the stale script file from the install
            // dir so future SessionStart fires don't trip schema-shadow miss
            // counters via undeclared writeEvent calls.
            //
            // v2.2.16 hotfix: ONLY delete the install-target file when the
            // source `bin/` does NOT also ship the script. Some scripts
            // (archive-orch-events, audit-housekeeper-orphan, audit-pm-emit-coverage,
            // audit-promised-events, audit-round-archive-hook, scan-cite-labels)
            // are intentionally absent from canonical hooks.json (per v2.2.10 F1
            // they are invoked as subprocesses by audit-on-orch-complete.js, not
            // as hooks) but ARE shipped in source. The v2.2.15 prune wrongly
            // deleted them on every install, breaking subprocess invocation
            // and tripping the install integrity hash sweep.
            if (noLongerCanonical) {
              const srcBinPath = path.join(pkgRoot, 'bin', base);
              const shippedInSource = fs.existsSync(srcBinPath);
              if (!shippedInSource) {
                try {
                  fs.unlinkSync(scriptPath);
                  prunedFiles++;
                } catch (_e) { /* best effort */ }
              }
            }
          }
        }
        if (entry.hooks.length === 0) entries.splice(i, 1);
      }
      if (entries.length === 0) delete settings.hooks[event];
    }
    if (pruned > 0) {
      process.stderr.write(
        '  [orchestray] Pruned ' + pruned + ' stale hook' +
        (pruned === 1 ? '' : 's') + ' pointing to deleted/no-longer-canonical scripts.\n'
      );
      // Emit one degraded-journal event per pruned hook for telemetry.
      // FN-16 declared event-type: install_stale_hook_pruned (W8c FN-33).
      // Schema: {type, ts, schema_version:1, event, matcher|null, basename, reason, scope}.
      for (const d of prunedDetails) {
        try {
          recordDegradation({
            kind: 'install_stale_hook_pruned',
            severity: 'info',
            projectRoot: process.cwd(),
            detail: Object.assign({}, d, {
              schema_version: 1,
              dedup_key: 'install_stale_hook_pruned|' + d.event + '|' + (d.matcher || '') + '|' + d.basename,
            }),
          });
        } catch (_e) { /* fail-open */ }
      }
      if (prunedFiles > 0) {
        process.stderr.write(
          '  [orchestray] Removed ' + prunedFiles + ' stale script file' +
          (prunedFiles === 1 ? '' : 's') + ' from install dir.\n'
        );
      }
    }
  }

  const binPrefix = path.join(targetDir, 'orchestray', 'bin');

  for (const [event, entries] of Object.entries(orchestrayHooks)) {
    if (!Array.isArray(entries)) continue;

    // Rewrite command paths and build new hook entries.
    // DEF-4: use a regex to split the template command into
    //   (prefix)(script-path)(rest-of-command)
    // where prefix is `${CLAUDE_PLUGIN_ROOT}/bin/` and script-path is the
    // first whitespace-delimited token after it. This avoids the old
    // `.split(' ')` which broke on installed paths that contained spaces
    // (e.g. Windows "Program Files", macOS "iCloud Drive"). The full path
    // is then inserted via JSON.stringify to get a reliably shell-safe
    // double-quoted form. If the resolved path contains characters that
    // double quotes cannot safely escape (`"`, `$`, backtick), fail fast.
    const newEntries = entries.map(entry => {
      const rewritten = JSON.parse(JSON.stringify(entry));
      if (rewritten.matcher !== undefined && typeof rewritten.matcher !== 'string') {
        throw new Error(
          `hooks.json: invalid matcher on ${event} entry — expected string, got ${typeof rewritten.matcher}`
        );
      }
      if (rewritten.hooks) {
        for (const hook of rewritten.hooks) {
          if (hook.command) {
            const cmdTemplate = hook.command;
            const match = cmdTemplate.match(
              /^\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/(\S+)(.*)$/
            );
            if (!match) {
              // Template did not match the expected shape; leave command as-is.
              continue;
            }
            const scriptName = match[1];
            const rest = match[2]; // leading space preserved if any
            const fullPath = path.join(binPrefix, scriptName);
            if (/["$`]/.test(fullPath)) {
              throw new Error(
                'Orchestray install: refusing to write a hook command for a path ' +
                'containing a shell-unsafe character (" $ or `). Path: ' + fullPath
              );
            }
            const quotedPath = JSON.stringify(fullPath);
            hook.command = `node ${quotedPath}${rest}`;
          }
        }
      }
      return rewritten;
    });

    if (!settings.hooks[event]) {
      settings.hooks[event] = newEntries;
    } else {
      // Helper: extract the script basename from a hook command via the
      // `/bin/<script>` substring. Parsing whitespace would fail on install
      // paths containing spaces (macOS iCloud, Windows "Program Files").
      const hookBasename = (h) => {
        const m = (h.command || '').match(/\/bin\/([^\s"']+)/);
        return m ? path.basename(m[1]) : null;
      };

      // FN-14 (v2.2.15): arg-update pass. Walk every existing Orchestray hook
      // in settings.hooks[event]; for any whose basename matches a new entry's
      // canonical hook AND whose command differs (different args, different
      // timeout), REPLACE the command field with the canonical shape. This
      // closes the W3-2 / W3-3 hole where v2.2.14 G-03 added `--quiet` to
      // calibrate-role-budgets in canonical hooks.json but in-place upgrades
      // never propagated the new arg, so existing users still saw the stdout
      // dump every SessionStart.
      //
      // Skipped when entry has `command_managed:true` (user-edited hook).
      // Emits one stderr advisory line per actual update.
      for (const entry of (settings.hooks[event] || [])) {
        if (entry.matcher !== entry.matcher) continue; // (kept for static analysis; never trips)
        for (const existing of (entry.hooks || [])) {
          if (existing.command_managed === true) continue;
          const cmd = existing.command || '';
          if (!cmd.includes('orchestray')) continue;
          const base = hookBasename(existing);
          if (!base) continue;
          // Find the canonical command for this basename in any newEntries.
          let canonicalNewHook = null;
          for (const ne of newEntries) {
            if (ne.matcher !== entry.matcher) continue;
            for (const h of (ne.hooks || [])) {
              if (hookBasename(h) === base) { canonicalNewHook = h; break; }
            }
            if (canonicalNewHook) break;
          }
          if (!canonicalNewHook) continue;
          // Compare the args/timeout. The path component is install-specific
          // (different homedirs); the args are what we care about.
          const existingArgs = (cmd.match(/\.js"?(\s+.*)?$/) || [, ''])[1] || '';
          const canonicalArgs = ((canonicalNewHook.command || '').match(/\.js"?(\s+.*)?$/) || [, ''])[1] || '';
          const existingTimeout = existing.timeout;
          const canonicalTimeout = canonicalNewHook.timeout;
          if (existingArgs.trim() === canonicalArgs.trim() && existingTimeout === canonicalTimeout) continue;
          // Update — but preserve the user's existing PATH portion and only
          // swap the args tail. Replacing the full command would also rewrite
          // the install dir, which v2.0.20 regression tests assume is
          // user-managed (not installer-managed) when the prior install used a
          // different homedir. We swap `<path>.js<old args>` →
          // `<path>.js<canonical args>` only.
          const oldCmd = cmd;
          const argsTailRe = /(\.js"?)(\s+.*)?$/;
          if (!argsTailRe.test(cmd)) {
            // Cmd shape we cannot safely splice (no `.js` boundary). Refuse to
            // overwrite the full command — that would clobber the user's
            // `node <path>` prefix and break in-place upgrades that point at a
            // different homedir. Skip the update; emit a one-line advisory so
            // the user knows the args drift was detected but not auto-fixed.
            process.stderr.write(
              '  [orchestray] Skipped ' + base + ' arg-update (unrecognised command shape; ' +
              'add `command_managed:true` to silence this advisory).\n'
            );
            continue;
          }
          const newArgsTail = canonicalArgs ? ' ' + canonicalArgs : '';
          existing.command = cmd.replace(argsTailRe, '$1' + newArgsTail);
          if (canonicalTimeout !== undefined) existing.timeout = canonicalTimeout;
          process.stderr.write(
            '  [orchestray] Updated ' + base + ': ' +
            (existingArgs.trim() || '(no args)') + ' → ' + (canonicalArgs.trim() || '(no args)') +
            (existingTimeout !== canonicalTimeout ? ' (timeout ' + existingTimeout + ' → ' + canonicalTimeout + ')' : '') +
            '\n'
          );
          recordDegradation({
            kind: 'install_hook_args_updated',
            severity: 'info',
            projectRoot: process.cwd(),
            detail: {
              event,
              matcher: entry.matcher || null,
              basename: base,
              old_command: oldCmd.slice(0, 240),
              new_command: existing.command.slice(0, 240),
              schema_version: 1,
              dedup_key: 'install_hook_args_updated|' + event + '|' + (entry.matcher || '') + '|' + base,
            },
          });
        }
      }

      for (const entry of newEntries) {
        const entryMatcher = entry.matcher; // may be undefined
        // Hook-level dedup (v2.0.20): the prior entry-level dedup silently
        // dropped new hooks whenever any existing hook in the same
        // (event, matcher) entry already matched. Example: v2.0.19 added
        // `collect-context-telemetry.js` beside the existing `audit-event.js`
        // under SubagentStart — the entry-level check matched on
        // `audit-event.js` and short-circuited, dropping the new hook.
        //
        // Instead we compute the set of Orchestray-origin basenames already
        // installed under the same (event, matcher) pair, then filter the
        // new entry's hooks down to those NOT already installed. Non-
        // Orchestray hooks (no "orchestray" in the command) never block an
        // Orchestray install — another plugin's hook in the same matcher is
        // a peer, not a duplicate.
        //
        // v2.2.17 W7c (cross-install dedup): when a dual-install operator
        // upgrades both global and project-local installs, each install's
        // mergeHooks adds entries with its OWN absolute path, but the older
        // install's entries (with a DIFFERENT absolute path) remain in
        // settings.json. Both fire, producing the v2.2.15 FN-47 hook_double_fire_detected
        // signal (32 events seen on this dev box at v2.2.16). Fix: REPLACE
        // existing orchestray-shaped hooks whose path differs from THIS
        // install's binPrefix — collapses both registrations into one.
        //
        // Kill switch (W9 reviewer F-3): ORCHESTRAY_INSTALL_CROSS_INSTALL_DEDUP_DISABLED=1
        // restores the v2.2.15-and-earlier behaviour (cross-install entries are
        // treated as peers without the file-existence prune). Use when an
        // operator wants to keep multiple stale install paths in settings.json
        // for any reason.
        const crossInstallDedupDisabled =
          process.env.ORCHESTRAY_INSTALL_CROSS_INSTALL_DEDUP_DISABLED === '1';
        const installedBasenames = new Set();
        const ourBinPrefixCheck = path.join(targetDir, 'orchestray', 'bin') + path.sep;
        for (const existing of settings.hooks[event]) {
          if (existing.matcher !== entryMatcher) continue;
          for (let hi = (existing.hooks || []).length - 1; hi >= 0; hi--) {
            const h = existing.hooks[hi];
            if (!h.command || !h.command.includes('orchestray')) continue;
            const name = hookBasename(h);
            if (!name) continue;
            // Cross-install dedup: extract the script path from the command;
            // if it points at an orchestray bin/ that is NOT under our
            // binPrefix, drop the stale entry so this install's add re-registers
            // with the canonical path. Skip user-managed entries.
            if (h.command_managed === true) {
              installedBasenames.add(name);
              continue;
            }
            const pathMatch = h.command.match(/"([^"]+\/orchestray\/bin\/[^"]+\.js)"/);
            if (pathMatch && !pathMatch[1].startsWith(ourBinPrefixCheck)) {
              // The existing hook points at a different orchestray install on
              // this machine. Two cases:
              //   1. The OTHER install is real and still on disk — preserve it
              //      (legitimate dual-install user; v2.0.20 contract). Both fire,
              //      but they're both real registrations the user opted into.
              //   2. The OTHER install is gone (dir deleted, install moved) but
              //      its settings.json entry remains — a leftover. Drop it so
              //      this install can register cleanly under one path only.
              //
              // Kill switch (W9 reviewer F-3): when crossInstallDedupDisabled,
              // skip the file-existence prune entirely — preserve the stale
              // entry as a v2.0.20-style peer.
              if (crossInstallDedupDisabled) {
                installedBasenames.add(name);
                continue;
              }
              const otherFileExists = fs.existsSync(pathMatch[1]);
              if (!otherFileExists) {
                existing.hooks.splice(hi, 1);
                try {
                  recordDegradation({
                    kind: 'install_stale_hook_pruned',
                    severity: 'info',
                    projectRoot: process.cwd(),
                    detail: {
                      event,
                      matcher: entry.matcher || null,
                      basename: name,
                      reason: 'cross_install_path_missing',
                      schema_version: 1,
                      dedup_key: 'install_stale_hook_pruned|' + event + '|' + (entry.matcher || '') + '|' + name + '|cross_install_missing',
                    },
                  });
                } catch (_e) { /* fail-open */ }
                continue; // do NOT mark as installed; let this install re-add
              }
              // Other install exists on disk — preserve as a peer per v2.0.20.
            }
            installedBasenames.add(name);
          }
        }

        const newHooks = (entry.hooks || []).filter(h => {
          const name = hookBasename(h);
          // If basename is not derivable, treat it as new — the alternative
          // (silently skipping) is exactly the class of bug this rewrite fixes.
          return !name || !installedBasenames.has(name);
        });

        if (newHooks.length === 0) {
          recordDegradation({
            kind: 'hook_merge_noop',
            severity: 'info',
            projectRoot: process.cwd(),
            detail: {
              event,
              matcher: entryMatcher || null,
              reason: 'all hooks already installed by prior version',
              dedup_key: 'hook_merge_noop|' + event + '|' + (entryMatcher || ''),
            },
          });
          continue;
        }

        // Append to an existing entry with matching matcher when one exists;
        // otherwise push a new entry. Two hook blocks with the same script
        // but different matchers (e.g. "Agent" vs "Bash") remain distinct
        // entries and must both be installed.
        const matchingExisting = settings.hooks[event].find(
          existing => existing.matcher === entryMatcher
        );
        if (matchingExisting) {
          matchingExisting.hooks = (matchingExisting.hooks || []).concat(newHooks);
        } else {
          // Preserve matcher only when the source entry defined one —
          // avoid writing `"matcher": undefined` (JSON.stringify drops
          // undefined, but being explicit is clearer and survives any
          // future serializer swap). Order the keys matcher-before-hooks
          // to match the convention in hooks.json.
          const pushed = {};
          if (entryMatcher !== undefined) pushed.matcher = entryMatcher;
          pushed.hooks = newHooks;
          settings.hooks[event].push(pushed);
        }
      }
    }
  }

  // v2.2.13 W3 (G-04): deterministic hook-chain reordering per (event, matcher).
  // Append-only behaviour above this line preserved for backward compat; this
  // step runs AFTER append-and-dedup completes.
  {
    const crypto = require('node:crypto');
    // isOurs: any hook whose command path goes through an 'orchestray' directory.
    const isOurs = h => (h.command || '').includes('orchestray');
    // hookBasename2: re-declared here (hookBasename above is closure-scoped to the else block).
    const hookBasename2 = h => {
      const m = (h.command || '').match(/\/bin\/([^\s"']+)/);
      return m ? path.basename(m[1]) : null;
    };

    // Classify where peer (non-orchestray) hooks sit relative to ours in a live hooks array.
    // Returns 'none' | 'before' | 'after' | 'interleaved'.
    function classifyPeerLayout(hooks) {
      const withIndex = hooks.map((h, i) => ({ h, i }));
      const peerIdxs  = withIndex.filter(x => !isOurs(x.h)).map(x => x.i);
      const ourIdxs   = withIndex.filter(x =>  isOurs(x.h)).map(x => x.i);
      if (peerIdxs.length === 0) return 'none';
      if (ourIdxs.length === 0) return 'none'; // no ours at all — nothing to reorder
      const maxOurIdx  = Math.max(...ourIdxs);
      const minOurIdx  = Math.min(...ourIdxs);
      if (peerIdxs.every(i => i < minOurIdx)) return 'before';
      if (peerIdxs.every(i => i > maxOurIdx)) return 'after';
      return 'interleaved';
    }

    for (const event of Object.keys(orchestrayHooks)) {
      const liveEntries      = settings.hooks[event] || [];
      const canonicalEntries = orchestrayHooks[event] || [];
      for (const canEntry of canonicalEntries) {
        const liveEntry = liveEntries.find(e => e.matcher === canEntry.matcher);
        if (!liveEntry) continue;

        const canBasenames  = (canEntry.hooks || []).map(hookBasename2).filter(Boolean);
        const ourLive       = (liveEntry.hooks || []).filter(isOurs);
        const ourLiveNames  = ourLive.map(hookBasename2).filter(Boolean);
        // Already canonical — skip.
        if (JSON.stringify(canBasenames) === JSON.stringify(ourLiveNames)) continue;

        const layout        = classifyPeerLayout(liveEntry.hooks || []);
        const liveBasenames = (liveEntry.hooks || []).map(hookBasename2).filter(Boolean);
        const divergenceAt  = (() => {
          for (let i = 0; i < Math.min(canBasenames.length, ourLiveNames.length); i++) {
            if (canBasenames[i] !== ourLiveNames[i]) return i;
          }
          return canBasenames.length === ourLiveNames.length
            ? null
            : Math.min(canBasenames.length, ourLiveNames.length);
        })();

        if (layout === 'interleaved') {
          // Layout D — DO NOT reorder. Warn-only (informational; fires even with kill switch).
          recordDegradation({
            kind:        'install_hook_order_skipped_interleaved',
            severity:    'warn',
            projectRoot: process.cwd(),
            detail: {
              event,
              matcher:              canEntry.matcher || null,
              peer_basenames:       (liveEntry.hooks || []).filter(h => !isOurs(h)).map(hookBasename2).filter(Boolean),
              orchestray_basenames: ourLiveNames,
              live_basenames:       liveBasenames,
              schema_version:       1,
            },
          });
          process.stderr.write(
            `[orchestray:install] Cannot auto-reorder ${event}:${canEntry.matcher || '*'} hooks: ` +
            `your settings.json has non-orchestray hooks mixed between orchestray hooks, and ` +
            `auto-reorder could break that arrangement. Run '/orchestray:status hooks' to see ` +
            `the current vs. expected order, then move orchestray hooks to run before (or after) ` +
            `your other hooks as a block. Re-run '/orchestray:update' to apply.\n`
          );
          continue;
        }

        // Layouts A / B / C: skip reorder if kill switch set, but interleaved warn above still fires.
        if (process.env.ORCHESTRAY_INSTALL_HOOK_REORDER_DISABLED === '1') continue;

        // Auto-reorder: peers preserved at head (B), tail (C), or absent (A).
        // Orphaned live orchestray hooks (present in live but absent from canonical,
        // e.g. scripts from a prior version that weren't pruned yet) are preserved
        // at the end of the orchestray slice — reorder changes order, never drops.
        const before     = JSON.stringify(liveEntry.hooks);
        const peers      = (liveEntry.hooks || []).filter(h => !isOurs(h));
        const canNameSet = new Set(canBasenames);
        const canonicalOrdered = canBasenames
          .map(name => ourLive.find(h => hookBasename2(h) === name))
          .filter(Boolean);
        const orphanedLive = ourLive.filter(h => {
          const n = hookBasename2(h);
          return n && !canNameSet.has(n);
        });
        const reorderedOurs = [...canonicalOrdered, ...orphanedLive];
        liveEntry.hooks = layout === 'before'
          ? [...peers, ...reorderedOurs]
          : layout === 'after'
            ? [...reorderedOurs, ...peers]
            : reorderedOurs; // layout === 'none'

        const after = JSON.stringify(liveEntry.hooks);
        if (before !== after) {
          recordDegradation({
            kind:        'install_hook_order_corrected',
            severity:    'info',
            projectRoot: process.cwd(),
            detail: {
              event,
              matcher:             canEntry.matcher || null,
              before_hash:         crypto.createHash('sha256').update(before).digest('hex').slice(0, 12),
              after_hash:          crypto.createHash('sha256').update(after).digest('hex').slice(0, 12),
              before_basenames:    liveBasenames,
              after_basenames:     canBasenames,
              divergence_at_index: divergenceAt,
              peer_layout:         layout,
              schema_version:      1,
            },
          });
        }
      }
    }
  }

  // FN-18 (v2.2.15): atomic write — Ctrl-C mid-write previously corrupted
  // settings.json. tmp+fsync+rename on the same FS. Inlined (rather than
  // calling the writeJsonAtomic helper below) so test harnesses that
  // eval-extract only the mergeHooks function body still work.
  {
    const tmp = settingsFile + '.orchestray.tmp';
    const fd  = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(settings, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, settingsFile);
  }
}

/**
 * FN-17 (v2.2.15): additively merge top-level non-hook keys from repo
 * `settings.json` into the user's active `<targetDir>/settings.json`.
 *
 * Keys merged: `agent`, `subagentStatusLine`, `statusLine`, plus any env keys
 * whose name starts with `ORCHESTRAY_` or `CLAUDE_CODE_EXPERIMENTAL_` —
 * orchestray-namespaced env vars only. ALL other top-level keys are left
 * alone, and existing user values are NEVER overwritten.
 *
 * Behaviour:
 *   - Repo settings.json absent → no-op.
 *   - Active settings.json absent → write a new one with just our merged keys.
 *   - Active settings.json malformed → fail-fast (parity with mergeHooks above).
 *
 * Idempotent and append-only: re-running install on an already-merged file
 * produces no diff.
 */
function mergeTopLevelSettings(targetDir) {
  const repoSettingsFile   = path.join(pkgRoot, 'settings.json');
  const activeSettingsFile = path.join(targetDir, 'settings.json');

  if (!fs.existsSync(repoSettingsFile)) return;
  let repo;
  try {
    repo = JSON.parse(fs.readFileSync(repoSettingsFile, 'utf8'));
  } catch (e) {
    process.stderr.write(
      '  [orchestray] mergeTopLevelSettings: skipping — repo settings.json malformed: ' +
      (e && e.message ? e.message : e) + '\n'
    );
    return;
  }
  if (!repo || typeof repo !== 'object') return;

  let active = {};
  if (fs.existsSync(activeSettingsFile)) {
    try {
      active = JSON.parse(fs.readFileSync(activeSettingsFile, 'utf8'));
    } catch (e) {
      // Parity with mergeHooks: refuse to overwrite a malformed file.
      console.error(
        '\n  \x1b[31m✗\x1b[0m mergeTopLevelSettings: ' + activeSettingsFile +
        ' is not valid JSON. Parser said: ' + (e && e.message ? e.message : e) + '\n'
      );
      return;
    }
  }
  if (!active || typeof active !== 'object') active = {};

  const ORCH_ALLOWLIST = new Set(['agent', 'subagentStatusLine', 'statusLine']);
  let changed = false;
  const added = [];

  for (const key of ORCH_ALLOWLIST) {
    if (Object.prototype.hasOwnProperty.call(repo, key) &&
        !Object.prototype.hasOwnProperty.call(active, key)) {
      active[key] = repo[key];
      added.push(key);
      changed = true;
    }
  }

  // Env namespace: merge orchestray-prefixed env keys additively.
  if (repo.env && typeof repo.env === 'object' && !Array.isArray(repo.env)) {
    if (!active.env || typeof active.env !== 'object') active.env = {};
    for (const k of Object.keys(repo.env)) {
      if (!/^(ORCHESTRAY_|CLAUDE_CODE_EXPERIMENTAL_)/.test(k)) continue;
      if (Object.prototype.hasOwnProperty.call(active.env, k)) continue;
      active.env[k] = repo.env[k];
      added.push('env.' + k);
      changed = true;
    }
  }

  if (changed) {
    writeJsonAtomic(activeSettingsFile, active);
    process.stderr.write(
      '  [orchestray] mergeTopLevelSettings added ' + added.length + ' key' +
      (added.length === 1 ? '' : 's') + ': ' + added.join(', ') + '\n'
    );
  }
}

// Recursively copy every .js file under `src` into `dst`, preserving the
// subdir layout. Returns the list of destination-relative paths that were
// written, so the caller can track them on the manifest. `.js` filter is
// intentional — we don't want stray editor backup files or READMEs.
// skipDir(name) — optional predicate; when it returns true for a directory
// entry name that directory is not descended into and not copied.
function copyJsTree(src, dst, skipDir = () => false) {
  const copied = [];
  // v2.1.17 W8 R-AIDER-FULL: also copy .scm tree-sitter queries and
  // manifest.json under bin/_lib/repo-map-grammars/. Limit non-.js extensions
  // to the explicit allow-list so we don't accidentally bundle test fixtures
  // or build artifacts that happen to live under bin/_lib/.
  const ALLOW_NON_JS = /\.(scm|json|wasm)$/;
  const walk = (srcSub, dstSub, relPrefix) => {
    fs.mkdirSync(dstSub, { recursive: true });
    for (const entry of fs.readdirSync(srcSub, { withFileTypes: true })) {
      const srcPath = path.join(srcSub, entry.name);
      const dstPath = path.join(dstSub, entry.name);
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        walk(srcPath, dstPath, rel);
      } else if (entry.isFile() && (entry.name.endsWith('.js') || ALLOW_NON_JS.test(entry.name))) {
        fs.copyFileSync(srcPath, dstPath);
        copied.push(rel);
      }
    }
  };
  walk(src, dst, '');
  return copied;
}

// Replace ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA} placeholders in a
// string with absolute paths under the install target. These are the same
// vars Claude Code's plugin loader expands; we expand them ourselves because
// Orchestray installs via a custom script, not as a marketplace plugin.
function expandPluginVars(s, pluginRoot, pluginData) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, pluginData);
}

// Register each mcpServers entry from .claude-plugin/plugin.json with the
// appropriate config file so Claude Code picks it up at session start.
//   - global install → ~/.claude.json top-level `mcpServers`
//   - local install  → ./.mcp.json
// Writes are atomic (tmp + rename) to avoid corrupting ~/.claude.json if the
// process is killed mid-write. Returns the list of registered server names.
function mergeMcpServers(pluginJson, targetDir, isLocal) {
  if (!pluginJson || !pluginJson.mcpServers || typeof pluginJson.mcpServers !== 'object') {
    return [];
  }
  const pluginRoot = path.join(targetDir, 'orchestray');
  // Do not pre-create orchestray/data/: nothing reads ${CLAUDE_PLUGIN_DATA}
  // today, and leaving an empty dir behind would break uninstall's
  // "rmdir orchestray/ if empty" sweep. If a future consumer needs it, it
  // can mkdir lazily the first time it writes.
  const pluginData = path.join(targetDir, 'orchestray', 'data');

  const expanded = {};
  for (const [name, cfg] of Object.entries(pluginJson.mcpServers)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const out = { command: expandPluginVars(cfg.command, pluginRoot, pluginData) };
    if (Array.isArray(cfg.args)) {
      out.args = cfg.args.map(a => expandPluginVars(a, pluginRoot, pluginData));
    }
    if (cfg.env && typeof cfg.env === 'object') {
      out.env = {};
      for (const [k, v] of Object.entries(cfg.env)) {
        out.env[k] = expandPluginVars(v, pluginRoot, pluginData);
      }
    }
    expanded[name] = out;
  }
  const names = Object.keys(expanded);
  if (names.length === 0) return [];

  if (isLocal) {
    // Local install: write/merge project-scope .mcp.json in cwd.
    const mcpFile = path.resolve('.mcp.json');
    let data = { mcpServers: {} };
    if (fs.existsSync(mcpFile)) {
      try {
        data = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
        if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
      } catch (e) {
        console.error(
          `\n  \x1b[31m✗\x1b[0m Cannot register MCP servers: ${mcpFile} is not valid JSON.\n` +
          `    Parser said: ${e.message}\n`
        );
        return [];
      }
    }
    Object.assign(data.mcpServers, expanded);
    writeJsonAtomic(mcpFile, data);
  } else {
    // Global install: write/merge top-level mcpServers in ~/.claude.json.
    // This file can be large and holds critical state — never overwrite on
    // parse failure, never touch unrelated keys.
    const claudeJsonFile = path.join(homeDir, '.claude.json');
    let data = {};
    if (fs.existsSync(claudeJsonFile)) {
      try {
        data = JSON.parse(fs.readFileSync(claudeJsonFile, 'utf8'));
      } catch (e) {
        console.error(
          `\n  \x1b[31m✗\x1b[0m Cannot register MCP servers: ${claudeJsonFile} is not valid JSON.\n` +
          `    Parser said: ${e.message}\n    Fix the file and re-run the installer.\n`
        );
        return [];
      }
    }
    if (!data.mcpServers || typeof data.mcpServers !== 'object') data.mcpServers = {};
    Object.assign(data.mcpServers, expanded);
    writeJsonAtomic(claudeJsonFile, data);
  }
  return names;
}

// Remove orchestray MCP server entries from whichever config file the
// matching install recorded them in. Silent on missing files.
function unregisterMcpServers(mcpServerNames, isLocal) {
  if (!Array.isArray(mcpServerNames) || mcpServerNames.length === 0) return;
  const removeFrom = (file) => {
    if (!fs.existsSync(file)) return;
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return; }
    if (!data.mcpServers || typeof data.mcpServers !== 'object') return;
    let changed = false;
    for (const name of mcpServerNames) {
      if (Object.prototype.hasOwnProperty.call(data.mcpServers, name)) {
        delete data.mcpServers[name];
        changed = true;
      }
    }
    if (changed) writeJsonAtomic(file, data);
  };
  if (isLocal) {
    removeFrom(path.resolve('.mcp.json'));
  } else if (homeDir) {
    removeFrom(path.join(homeDir, '.claude.json'));
  }
}

// Atomic JSON write: serialize to a sibling tmp file on the same filesystem,
// fsync it, then rename over the target. Avoids leaving a half-written
// ~/.claude.json if the process is killed mid-write.
// Predictable `.orchestray.tmp` suffix is acceptable for a single-user local
// plugin: the settings file has the same trust boundary as the install process.
// If the plugin is ever used on a shared filesystem or multi-user system,
// replace with fs.mkdtempSync-based temp file creation. Per T14 audit.
function writeJsonAtomic(file, data) {
  const tmp = file + '.orchestray.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function uninstall(targetDir) {
  const manifestFile = path.join(targetDir, 'orchestray', 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    say('  Orchestray not found at ' + targetDir);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const wasLocal = manifest.scope === 'local';
  unregisterMcpServers(manifest.mcpServers, wasLocal);

  // DEF-5: prefer per-file manifest (new format). Fall back to the old
  // subdir-based removal if an older manifest is on disk so users upgrading
  // from a prior version are not stranded.
  if (Array.isArray(manifest.files)) {
    // 1. Remove every tracked file individually.
    //    v2.1.9: use lstatSync before unlink so symlinks (specialist entries
    //    in agents/) are removed without following to the target.
    //    fs.unlinkSync on a symlink already removes the link itself, but
    //    lstatSync-gated fs.existsSync gives us clear "this was a symlink"
    //    telemetry in the log if something goes wrong.
    const removedDirs = new Set();
    for (const rel of manifest.files) {
      const p = path.join(targetDir, rel);
      let exists = false;
      try {
        fs.lstatSync(p);
        exists = true;
      } catch (e) {
        if (e && e.code !== 'ENOENT') exists = true;
      }
      if (exists) {
        try {
          fs.unlinkSync(p);
        } catch (_e) {
          // best effort — symlinks, regular files, and broken links all
          // unlink identically; any failure here is safe to ignore.
        }
      }
      removedDirs.add(path.dirname(p));
    }
    // manifest.json itself is not tracked (it only exists to drive uninstall).
    // Remove it explicitly so the empty-dir walk below can collapse orchestray/.
    try {
      fs.unlinkSync(manifestFile);
    } catch (_e) { /* already gone */ }
    removedDirs.add(path.dirname(manifestFile));

    // 2. Walk parent dirs bottom-up (longest first) and rmdir any that
    //    are empty. This preserves unmanaged files (e.g., a user-added
    //    extra.md in agents/pm-reference/).
    const sorted = Array.from(removedDirs).sort((a, b) => b.length - a.length);
    // Also consider grandparents (agents/, skills/, skills/<skill>/).
    const allDirs = new Set(sorted);
    for (const d of sorted) {
      let parent = path.dirname(d);
      while (parent.startsWith(targetDir) && parent !== targetDir) {
        allDirs.add(parent);
        parent = path.dirname(parent);
      }
    }
    const sortedAll = Array.from(allDirs).sort((a, b) => b.length - a.length);
    for (const d of sortedAll) {
      try {
        if (fs.existsSync(d) && fs.readdirSync(d).length === 0) {
          fs.rmdirSync(d);
        }
      } catch (_e) {
        // non-empty or already gone; skip
      }
    }
    say(`  \x1b[32m✓\x1b[0m Removed installed files (${manifest.files.length})`);
  } else {
    // Legacy fallback for manifests written by older versions.
    for (const file of manifest.agents || []) {
      const p = path.join(targetDir, 'agents', file);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    for (const dir of manifest.agentSubdirs || []) {
      const p = path.join(targetDir, 'agents', dir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
    say(`  \x1b[32m✓\x1b[0m Removed agents`);

    // Remove skill directories
    for (const dir of manifest.skills || []) {
      const p = path.join(targetDir, 'skills', dir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
    say(`  \x1b[32m✓\x1b[0m Removed skills`);
  }

  // Try to rmdir orchestray/ only if it is now empty. Unconditional rmSync
  // here would defeat DEF-5 by destroying any user files placed inside
  // orchestray/ (e.g., overrides in orchestray/bin/, extra settings).
  const orchDir = path.join(targetDir, 'orchestray');
  let orchDirRemoved = false;
  try {
    if (fs.existsSync(orchDir) && fs.readdirSync(orchDir).length === 0) {
      fs.rmdirSync(orchDir);
      orchDirRemoved = true;
    }
  } catch (_e) { /* non-empty or already gone; skip */ }
  say(orchDirRemoved
    ? `  \x1b[32m✓\x1b[0m Removed orchestray/`
    : `  \x1b[33m⚠\x1b[0m Kept orchestray/ (contains user files)`);

  // Clean hooks from settings.json (remove orchestray entries)
  const settingsFile = path.join(targetDir, 'settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (settings.hooks) {
        for (const [event, entries] of Object.entries(settings.hooks)) {
          settings.hooks[event] = entries.filter(entry => {
            const cmds = (entry.hooks || []).map(h => h.command || '');
            return !cmds.some(c => c.includes('orchestray'));
          });
          if (settings.hooks[event].length === 0) delete settings.hooks[event];
        }
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
        // FN-18 (v2.2.15): atomic write via the writeJsonAtomic helper.
        writeJsonAtomic(settingsFile, settings);
      }
    } catch {}
  }
  say(`  \x1b[32m✓\x1b[0m Cleaned hooks`);

  // FN-23: final uninstall ceremony stays on stdout (user-visible summary).
  console.log('');
  console.log('  \x1b[32mOrchestray uninstalled.\x1b[0m');
  console.log('');
}
