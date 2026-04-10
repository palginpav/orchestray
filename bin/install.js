#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = require('../package.json').version;
const REPO = 'https://github.com/palginpav/orchestray';

// Parse arguments
const args = process.argv.slice(2);
const flags = {
  global: args.includes('--global') || args.includes('-g'),
  local: args.includes('--local') || args.includes('-l'),
  uninstall: args.includes('--uninstall') || args.includes('-u'),
  help: args.includes('--help') || args.includes('-h'),
};

if (flags.help) {
  console.log(`
  Orchestray v${VERSION}
  Multi-agent orchestration plugin for Claude Code

  Usage: npx orchestray [options]

  Options:
    -g, --global     Install globally (to ~/.claude/)
    -l, --local      Install locally (to ./.claude/)
    -u, --uninstall  Remove Orchestray files
    -h, --help       Show this help

  Examples:
    npx orchestray --global     # Install for all projects
    npx orchestray --local      # Install for current project only
    npx orchestray --uninstall  # Remove Orchestray
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
  //   - orchestray/settings.json                        (default agent config)
  //   - orchestray/CLAUDE.md                            (reference doc)
  //   - orchestray/VERSION, orchestray/manifest.json    (install tracking)
  //   - settings.json (merged)                          (hook wiring)
  //
  // NOT COPIED (intentional):
  //   - .claude-plugin/plugin.json: Claude Code's plugin manager reads this
  //     from the npm package root, not from the install target. Copying it
  //     into <targetDir>/ would be a no-op and could confuse users who
  //     expect edits there to take effect. If this assumption is ever
  //     invalidated, this is the place to add the copy.
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

  // 4. Merge hooks into existing hooks.json (don't overwrite user's hooks)
  mergeHooks(targetDir);
  console.log(`  \x1b[32m✓\x1b[0m Configured hooks`);

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

  // 8. Write manifest for clean uninstall
  const manifest = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    scope: flags.local ? 'local' : 'global',
    agents: agentFiles,
    agentSubdirs: agentSubdirs,
    skills: skillDirs,
    hooks: binFiles,
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
      // Check for existing orchestray hooks by looking for 'orchestray' in commands
      const existingCmds = settings.hooks[event]
        .flatMap(e => (e.hooks || []).map(h => h.command || ''));

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
        const alreadyInstalled = scriptBasenames.some(name =>
          existingCmds.some(ec => ec.includes('orchestray') && ec.includes(name))
        );
        if (!alreadyInstalled) {
          settings.hooks[event].push(entry);
        }
      }
    }
  }

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
}

function uninstall(targetDir) {
  const manifestFile = path.join(targetDir, 'orchestray', 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.log('  Orchestray not found at ' + targetDir);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

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
