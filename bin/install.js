#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { recordDegradation } = require('./_lib/degraded-journal');
const { computeManifest }  = require('./_lib/install-manifest');

const VERSION = require('../package.json').version;
const REPO = 'https://github.com/palginpav/orchestray';

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
// Per v2018 W12: enabled by default, threshold 0.65, max 1 advisory per spawn.
const FRESH_INSTALL_ANTI_PATTERN_GATE = {
  enabled: true,
  min_decayed_confidence: 0.65,
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

console.log('');
console.log('  Orchestray v' + VERSION);
console.log('  Multi-agent orchestration for Claude Code');
console.log('');
console.log(`  Installing ${flags.local ? 'locally' : 'globally'} to ${configDir}`);
console.log('');

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

    // Tilde expansion.
    if (sharedDirPath === '~' || sharedDirPath.startsWith('~/') || sharedDirPath.startsWith('~\\')) {
      sharedDirPath = path.join(os.homedir(), sharedDirPath.slice(sharedDirPath.startsWith('~\\') ? 2 : 2));
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
      console.log(`  \x1b[32m✓\x1b[0m Created shared federation directories at ${sharedRoot}`);
    }
  } catch (err) {
    // Non-fatal — federation dirs can be created on first promote if install fails here.
    console.log(`  \x1b[33m⚠\x1b[0m Could not create shared federation directories: ${err.message}`);
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
      console.log('  \x1b[32m✓\x1b[0m Created CLAUDE.md with ## Compact Instructions section');
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
      console.log('  \x1b[32m✓\x1b[0m Updated CLAUDE.md ## Compact Instructions with resilience paragraph');
    } else {
      // Case (b): section entirely absent — append.
      const appended = existing.trimEnd() + '\n\n' + sectionText + '\n';
      fs.writeFileSync(userClaudeMdPath, appended, { encoding: 'utf8' });
      console.log('  \x1b[32m✓\x1b[0m Appended ## Compact Instructions to CLAUDE.md');
    }
  } catch (err) {
    // Non-fatal: log a warning but do not abort the install.
    console.log(
      '  \x1b[33m⚠\x1b[0m Could not merge ## Compact Instructions into CLAUDE.md: ' +
      String(err && err.message || err).slice(0, 200)
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
  console.log(`  \x1b[32m✓\x1b[0m Installed ${agentFiles.length} agents + ${refCount} reference files`);

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
        console.log(
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
        console.log(
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
              console.log(
                '  \x1b[33m⚠\x1b[0m Symlink permission denied; copied specialists into agents/. ' +
                'Edits to copied files will not survive /orchestray:update. ' +
                'Enable Developer Mode or run as admin for durable symlinks.'
              );
              windowsFallbackWarned = true;
            }
          } catch (copyErr) {
            console.log(
              '  \x1b[33m⚠\x1b[0m Could not install specialist ' + specFile + ' (' + copyErr.message + ')'
            );
          }
        } else {
          console.log(
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
      console.log('  \x1b[32m✓\x1b[0m Installed ' + totalInstalled + ' specialists (' + how + ')');
    }
    if (specialistSkippedCount > 0) {
      console.log(
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
  console.log(`  \x1b[32m✓\x1b[0m Installed ${skillDirs.length} skills`);

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
  console.log(`  \x1b[32m✓\x1b[0m Installed ${binFiles.length} hook scripts`);

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
      console.log('  \x1b[33m⚠\x1b[0m ox.js not found in bin/; skipping ox shim install');
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
      console.log('  \x1b[32m✓\x1b[0m Installed `ox` shim; bare `ox help` is now available');
    }
  } catch (oxErr) {
    console.log(
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
    console.log(`  \x1b[32m✓\x1b[0m Installed MCP server (${mcpFileCount} files)`);
  }

  // 4. Merge hooks into existing hooks.json (don't overwrite user's hooks)
  mergeHooks(targetDir);
  console.log(`  \x1b[32m✓\x1b[0m Configured hooks`);

  // 4b. Register MCP servers with Claude Code (global: ~/.claude.json,
  // local: ./.mcp.json). Tracks names in manifest for clean uninstall.
  const mcpServerNames = mergeMcpServers(pluginJson, targetDir, flags.local);
  if (mcpServerNames.length > 0) {
    console.log(`  \x1b[32m✓\x1b[0m Registered MCP server${mcpServerNames.length > 1 ? 's' : ''}: ${mcpServerNames.join(', ')}`);
    console.log(`    \x1b[33mNote:\x1b[0m restart Claude Code for the MCP server to load.`);
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
    };
    try {
      fs.mkdirSync(orchStateDir, { recursive: true });
      fs.writeFileSync(freshConfigPath, JSON.stringify(freshConfig, null, 2) + '\n');
      console.log(`  \x1b[32m✓\x1b[0m Seeded .orchestray/config.json with default MCP tool map and pricing table`);
    } catch (_e) {
      // Non-fatal: the config defaults via fail-open loaders if the write fails.
      console.log(`  \x1b[33m⚠\x1b[0m Could not seed .orchestray/config.json (will use built-in defaults)`);
    }
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

  console.log(`  \x1b[32m✓\x1b[0m Wrote VERSION (${VERSION})`);

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
    const tmp = settingsFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, settingsFile);
  } catch (err) {
    console.log('  \x1b[33m⚠\x1b[0m Could not update settings.json PATH for ox: ' + err.message);
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

  let srcData = {};
  if (fs.existsSync(srcHooksFile)) {
    try { srcData = JSON.parse(fs.readFileSync(srcHooksFile, 'utf8')); } catch {}
  }
  // Source format: { hooks: { Event: [{hooks:[...]}] } }
  const orchestrayHooks = srcData.hooks || srcData;

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
        const installedBasenames = new Set();
        for (const existing of settings.hooks[event]) {
          if (existing.matcher !== entryMatcher) continue;
          for (const h of existing.hooks || []) {
            if (!h.command || !h.command.includes('orchestray')) continue;
            const name = hookBasename(h);
            if (name) installedBasenames.add(name);
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

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

// Recursively copy every .js file under `src` into `dst`, preserving the
// subdir layout. Returns the list of destination-relative paths that were
// written, so the caller can track them on the manifest. `.js` filter is
// intentional — we don't want stray editor backup files or READMEs.
// skipDir(name) — optional predicate; when it returns true for a directory
// entry name that directory is not descended into and not copied.
function copyJsTree(src, dst, skipDir = () => false) {
  const copied = [];
  const walk = (srcSub, dstSub, relPrefix) => {
    fs.mkdirSync(dstSub, { recursive: true });
    for (const entry of fs.readdirSync(srcSub, { withFileTypes: true })) {
      const srcPath = path.join(srcSub, entry.name);
      const dstPath = path.join(dstSub, entry.name);
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        walk(srcPath, dstPath, rel);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
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
    console.log('  Orchestray not found at ' + targetDir);
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
    console.log(`  \x1b[32m✓\x1b[0m Removed installed files (${manifest.files.length})`);
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
    console.log(`  \x1b[32m✓\x1b[0m Removed agents`);

    // Remove skill directories
    for (const dir of manifest.skills || []) {
      const p = path.join(targetDir, 'skills', dir);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    }
    console.log(`  \x1b[32m✓\x1b[0m Removed skills`);
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
  console.log(orchDirRemoved
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
        fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
      }
    } catch {}
  }
  console.log(`  \x1b[32m✓\x1b[0m Cleaned hooks`);

  console.log('');
  console.log('  \x1b[32mOrchestray uninstalled.\x1b[0m');
  console.log('');
}
