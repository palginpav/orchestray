#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

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
// All flags default off; __schema_version: 1. Per v2017-design.md §4.1 T4.
// (pm_prose_strip removed in v2.0.18 — FC3b cleanup)
const FRESH_INSTALL_V2017_EXPERIMENTS = {
  __schema_version: 1,
  global_kill_switch: false,
  prompt_caching: 'off',
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
  // MODULE_NOT_FOUND on first fire.
  const libDir = path.join(binDir, '_lib');
  if (fs.existsSync(libDir) && fs.statSync(libDir).isDirectory()) {
    const dstLibDir = path.join(targetDir, 'orchestray', 'bin', '_lib');
    fs.mkdirSync(dstLibDir, { recursive: true });
    for (const file of fs.readdirSync(libDir).filter(f => f.endsWith('.js'))) {
      fs.copyFileSync(path.join(libDir, file), path.join(dstLibDir, file));
      track(path.join('orchestray', 'bin', '_lib', file));
    }
  }
  console.log(`  \x1b[32m✓\x1b[0m Installed ${binFiles.length} hook scripts`);

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

  // 7. Write version file
  fs.writeFileSync(path.join(targetDir, 'orchestray', 'VERSION'), VERSION + '\n');
  track(path.join('orchestray', 'VERSION'));

  // 8a. Seed .orchestray/config.json with default MCP tool enable map and
  // cost_budget_check pricing table if no config file exists yet.
  // Only written for fresh installs (file absent) — never overwrites user edits.
  // The .orchestray/ directory is in the project root (process.cwd()), not in
  // targetDir (.claude/). Constants FRESH_INSTALL_MCP_TOOLS_ENABLED and
  // FRESH_INSTALL_COST_BUDGET_CHECK above are the single sources of truth for
  // these seeds. Per 2014-scope-proposal.md §W1 AC4(d) and §W3 AC4.
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

  // 8. Write manifest for clean uninstall
  const manifest = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    scope: flags.local ? 'local' : 'global',
    agents: agentFiles,
    agentSubdirs: agentSubdirs,
    skills: skillDirs,
    hooks: binFiles,
    mcpServers: mcpServerNames,
    files: trackedFiles, // DEF-5: per-file manifest for precise uninstall
  };
  fs.writeFileSync(
    path.join(targetDir, 'orchestray', 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );

  console.log(`  \x1b[32m✓\x1b[0m Wrote VERSION (${VERSION})`);

  console.log('');
  console.log('  \x1b[32mDone!\x1b[0m Start Claude Code and Orchestray is ready.');
  console.log('');
  console.log('  The PM agent auto-detects complex tasks.');
  console.log('  Or run \x1b[36m/orchestray:run [task]\x1b[0m to trigger manually.');
  console.log('');
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
      for (const entry of newEntries) {
        // Extract the script basename via the `/bin/<script>` substring rather
        // than parsing whitespace: install paths may contain spaces (macOS
        // iCloud, Windows "Program Files"), and split(' ') would mis-identify
        // those commands as new and silently duplicate them on reinstall.
        const scriptBasenames = (entry.hooks || [])
          .map(h => {
            const m = (h.command || '').match(/\/bin\/([^\s"']+)/);
            return m ? path.basename(m[1]) : null;
          })
          .filter(Boolean);
        // M5 fix: include `entry.matcher` in the dedup key. Two hook blocks
        // with the same script but different matchers (e.g. "Agent" vs "Bash")
        // are distinct entries and must both be installed.
        const entryMatcher = entry.matcher;
        const alreadyInstalled = scriptBasenames.some(name =>
          settings.hooks[event].some(existing => {
            // matcher must match (both undefined, or same string value)
            if (existing.matcher !== entryMatcher) return false;
            return (existing.hooks || []).some(h =>
              h.command && h.command.includes('orchestray') && h.command.includes(name)
            );
          })
        );
        if (!alreadyInstalled) {
          settings.hooks[event].push(entry);
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
function copyJsTree(src, dst) {
  const copied = [];
  const walk = (srcSub, dstSub, relPrefix) => {
    fs.mkdirSync(dstSub, { recursive: true });
    for (const entry of fs.readdirSync(srcSub, { withFileTypes: true })) {
      const srcPath = path.join(srcSub, entry.name);
      const dstPath = path.join(dstSub, entry.name);
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
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
    const removedDirs = new Set();
    for (const rel of manifest.files) {
      const p = path.join(targetDir, rel);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (_e) {
          // best effort
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
