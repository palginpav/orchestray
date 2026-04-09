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
const configDir = flags.local
  ? path.resolve('.claude')
  : path.join(process.env.HOME || process.env.USERPROFILE, '.claude');

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
  // Ensure target directories exist
  const dirs = ['agents', 'skills', 'hooks', 'orchestray', 'orchestray/bin'];
  for (const d of dirs) {
    fs.mkdirSync(path.join(targetDir, d), { recursive: true });
  }

  // 1. Copy agents
  const agentsDir = path.join(pkgRoot, 'agents');
  const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  for (const file of agentFiles) {
    fs.copyFileSync(
      path.join(agentsDir, file),
      path.join(targetDir, 'agents', file)
    );
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
  }

  // 6. Copy CLAUDE.md to orchestray/ for reference
  const claudeMdSrc = path.join(pkgRoot, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(targetDir, 'orchestray', 'CLAUDE.md'));
  }

  // 7. Write version file
  fs.writeFileSync(path.join(targetDir, 'orchestray', 'VERSION'), VERSION + '\n');

  // 8. Write manifest for clean uninstall
  const manifest = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    scope: flags.local ? 'local' : 'global',
    agents: agentFiles,
    agentSubdirs: agentSubdirs,
    skills: skillDirs,
    hooks: binFiles,
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
    try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
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

    // Rewrite command paths and build new hook entries
    const newEntries = entries.map(entry => {
      const rewritten = JSON.parse(JSON.stringify(entry));
      if (rewritten.hooks) {
        for (const hook of rewritten.hooks) {
          if (hook.command) {
            // Extract script name and args from the template command
            const parts = hook.command.replace('${CLAUDE_PLUGIN_ROOT}/', '').split(' ');
            const scriptPath = parts[0].replace('bin/', '');
            const extraArgs = parts.slice(1).join(' ');
            hook.command = `node "${path.join(binPrefix, scriptPath)}"${extraArgs ? ' ' + extraArgs : ''}`;
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
        const cmds = (entry.hooks || []).map(h => h.command || '');
        const alreadyInstalled = cmds.some(c =>
          existingCmds.some(ec => ec.includes('orchestray'))
            && existingCmds.some(ec => {
              const scriptName = path.basename(c.split('"').pop().split(' ')[0]);
              return ec.includes(scriptName);
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

function uninstall(targetDir) {
  const manifestFile = path.join(targetDir, 'orchestray', 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    console.log('  Orchestray not found at ' + targetDir);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // Remove agents
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

  // Remove orchestray directory
  const orchDir = path.join(targetDir, 'orchestray');
  if (fs.existsSync(orchDir)) fs.rmSync(orchDir, { recursive: true });
  console.log(`  \x1b[32m✓\x1b[0m Removed orchestray/`);

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
