'use strict';

/**
 * dedup-plugin-hooks.js — Remove duplicate tokenwright hook registrations (W4 §B3).
 *
 * The installer writes hook entries to settings.json files (global and local) while
 * hooks/hooks.json (the plugin manifest) also registers them. This causes double-firing.
 *
 * This module reads the plugin manifest, identifies which hook scripts are managed
 * by the plugin, and removes any matching entries from both settings.json files.
 *
 * Idempotent: re-running when entries are already absent is a no-op.
 * Non-orchestray hooks (custom user hooks) are preserved untouched.
 *
 * Fail-safe: all I/O wrapped in try/catch. Returns a safe zero-removal result on error.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

// Resolve plugin root relative to this file (bin/_lib/dedup-plugin-hooks.js → ../..)
const PKG_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Read and parse a JSON file, returning null on any error.
 *
 * @param {string} filePath
 * @returns {object|null}
 */
function readJson(filePath) {
  try {
    const expanded = filePath.replace(/^~/, os.homedir());
    return JSON.parse(fs.readFileSync(expanded, 'utf8'));
  } catch (_e) {
    return null;
  }
}

/**
 * Write an object as pretty-printed JSON to a file.
 * Returns true on success, false on error.
 *
 * @param {string} filePath
 * @param {object} data
 * @returns {boolean}
 */
function writeJson(filePath, data) {
  try {
    const expanded = filePath.replace(/^~/, os.homedir());
    fs.writeFileSync(expanded, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Expand path variables: ~ → home dir.
 *
 * @param {string} p
 * @returns {string}
 */
function expandPath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/^~/, os.homedir());
}

/**
 * Tokenwright scripts known to double-fire when registered in BOTH the
 * plugin manifest (`hooks/hooks.json`) AND settings.json. v2.2.6 narrowly
 * removes ONLY these duplicates — it intentionally does NOT touch other
 * Orchestray hooks, because install.js continues to manage them in
 * settings.json. Broadening the dedup to all manifest-declared scripts
 * would require a separate architectural change in install.js that
 * v2.2.6 deliberately defers.
 */
const TOKENWRIGHT_DEDUP_ALLOWLIST = new Set([
  'inject-tokenwright.js',
  'capture-tokenwright-realized.js',
]);

/**
 * Return the set of tokenwright script basenames that v2.2.6 dedups against
 * settings.json. The manifest is consulted only as a sanity check — if it
 * does not declare these scripts, return an empty set (defensive).
 *
 * @param {object} manifest — parsed hooks.json
 * @returns {Set<string>}
 */
function extractManifestScripts(manifest) {
  const declaredInManifest = new Set();
  try {
    const hooksBlock = manifest && (manifest.hooks || manifest);
    if (hooksBlock && typeof hooksBlock === 'object') {
      for (const groups of Object.values(hooksBlock)) {
        if (!Array.isArray(groups)) continue;
        for (const group of groups) {
          const hookList = group && Array.isArray(group.hooks) ? group.hooks : [];
          if (group && typeof group.command === 'string') {
            const basename = path.basename(group.command.replace(/\$\{[^}]+\}/g, '').trim());
            if (basename) declaredInManifest.add(basename);
          }
          for (const h of hookList) {
            if (h && typeof h.command === 'string') {
              const cmdClean = h.command.replace(/\$\{[^}]+\}/g, '').trim();
              const basename = path.basename(cmdClean);
              if (basename) declaredInManifest.add(basename);
            }
          }
        }
      }
    }
  } catch (_e) { /* ignore */ }

  // Intersection: only return scripts that are BOTH on the allowlist AND in the manifest.
  const result = new Set();
  for (const name of TOKENWRIGHT_DEDUP_ALLOWLIST) {
    if (declaredInManifest.has(name)) result.add(name);
  }
  return result;
}

/**
 * Extract the script basename from a hook command string.
 * Handles both quoted and unquoted forms:
 *   node "/abs/path/orchestray/bin/inject-tokenwright.js"
 *   node /abs/path/orchestray/bin/inject-tokenwright.js
 *   node bin/inject-tokenwright.js
 *   /usr/bin/env node "/path/script.js"
 *
 * @param {string} command
 * @returns {string}
 */
function extractScriptBasename(command) {
  if (typeof command !== 'string') return '';
  // Strip variable expansions first
  let s = command.replace(/\$\{[^}]+\}/g, '').trim();
  // Find all tokens that look like a path ending in .js, .cjs, .mjs, or .sh
  const m = s.match(/[^\s"']+\.(?:c?js|mjs|sh)/g);
  if (m && m.length > 0) {
    // Use the last matching token (the script argument, not the interpreter)
    return path.basename(m[m.length - 1]);
  }
  // Fallback: strip quotes and take basename of the whole string
  return path.basename(s.replace(/["']/g, ''));
}

/**
 * Check if a hook command string is managed by orchestray.
 * A command is orchestray-managed if:
 *   1. Its basename matches one of the manifest scripts AND
 *   2. The command path contains "/orchestray/bin/"
 *
 * @param {string} command
 * @param {Set<string>} manifestScripts
 * @returns {boolean}
 */
function isOrchestrayManagedHook(command, manifestScripts) {
  if (typeof command !== 'string') return false;
  const baseName = extractScriptBasename(command);
  const isManifestScript = manifestScripts.has(baseName);
  const isOrchestrayPath = command.includes('/orchestray/bin/') ||
                           command.includes('\\orchestray\\bin\\');
  return isManifestScript && isOrchestrayPath;
}

/**
 * Remove orchestray-managed hook entries from a parsed settings.json object.
 * Returns { modified: boolean, removedPaths: string[], updatedSettings: object }.
 *
 * @param {object}    settings        — parsed settings.json
 * @param {Set<string>} manifestScripts — basenames to match
 * @returns {{ modified: boolean, removedPaths: string[], updatedSettings: object }}
 */
function deduplicateSettings(settings, manifestScripts) {
  const removedPaths = [];
  let modified = false;

  if (!settings || typeof settings !== 'object') {
    return { modified: false, removedPaths: [], updatedSettings: settings };
  }

  const updated = Object.assign({}, settings);
  const hooksObj = updated.hooks;

  if (!hooksObj || typeof hooksObj !== 'object') {
    return { modified: false, removedPaths: [], updatedSettings: updated };
  }

  const newHooks = {};

  for (const [eventName, groups] of Object.entries(hooksObj)) {
    if (!Array.isArray(groups)) {
      newHooks[eventName] = groups;
      continue;
    }

    const filteredGroups = [];
    for (const group of groups) {
      if (!group || typeof group !== 'object') {
        filteredGroups.push(group);
        continue;
      }

      // Handle flat command form
      if (typeof group.command === 'string') {
        if (isOrchestrayManagedHook(group.command, manifestScripts)) {
          removedPaths.push(group.command);
          modified = true;
        } else {
          filteredGroups.push(group);
        }
        continue;
      }

      // Handle group with hooks array
      if (Array.isArray(group.hooks)) {
        const filteredHooks = group.hooks.filter(h => {
          if (!h || typeof h.command !== 'string') return true;
          if (isOrchestrayManagedHook(h.command, manifestScripts)) {
            removedPaths.push(h.command);
            modified = true;
            return false;
          }
          return true;
        });

        if (filteredHooks.length === 0) {
          // Drop the entire group if all its hooks were removed
          // (only if the group had no other properties beyond hooks/matcher)
          if (Object.keys(group).every(k => ['hooks', 'matcher', 'type'].includes(k))) {
            // empty group — drop it
            continue;
          }
        }

        filteredGroups.push(Object.assign({}, group, { hooks: filteredHooks }));
      } else {
        filteredGroups.push(group);
      }
    }

    newHooks[eventName] = filteredGroups;
  }

  if (modified) {
    updated.hooks = newHooks;
  }

  return { modified, removedPaths, updatedSettings: updated };
}

/**
 * Remove plugin-managed hook entries from both global and project settings.json files.
 *
 * @param {object} [params]
 * @param {string} [params.globalSettingsPath]   — default: ~/.claude/settings.json
 * @param {string} [params.projectSettingsPath]  — default: <pkgRoot>/.claude/settings.json
 * @param {string} [params.pluginManifestPath]   — default: <pkgRoot>/hooks/hooks.json
 * @returns {{
 *   globalEntriesRemoved:  number,
 *   projectEntriesRemoved: number,
 *   removedPaths:          string[]
 * }}
 */
function dedupPluginHooks(params) {
  try {
    params = params || {};
    const globalSettingsPath  = expandPath(params.globalSettingsPath  || path.join(os.homedir(), '.claude', 'settings.json'));
    const projectSettingsPath = expandPath(params.projectSettingsPath || path.join(PKG_ROOT, '.claude', 'settings.json'));
    const pluginManifestPath  = expandPath(params.pluginManifestPath  || path.join(PKG_ROOT, 'hooks', 'hooks.json'));

    // Load the plugin manifest to determine which scripts it manages
    const manifest = readJson(pluginManifestPath);
    if (!manifest) {
      // Cannot determine managed scripts — do nothing
      return { globalEntriesRemoved: 0, projectEntriesRemoved: 0, removedPaths: [] };
    }

    const manifestScripts = extractManifestScripts(manifest);
    if (manifestScripts.size === 0) {
      return { globalEntriesRemoved: 0, projectEntriesRemoved: 0, removedPaths: [] };
    }

    const allRemovedPaths = [];

    // Process global settings
    let globalEntriesRemoved = 0;
    {
      const globalSettings = readJson(globalSettingsPath);
      if (globalSettings) {
        const { modified, removedPaths, updatedSettings } =
          deduplicateSettings(globalSettings, manifestScripts);
        if (modified) {
          writeJson(globalSettingsPath, updatedSettings);
          globalEntriesRemoved = removedPaths.length;
          allRemovedPaths.push(...removedPaths);
        }
      }
    }

    // Process project settings
    let projectEntriesRemoved = 0;
    {
      const projectSettings = readJson(projectSettingsPath);
      if (projectSettings) {
        const { modified, removedPaths, updatedSettings } =
          deduplicateSettings(projectSettings, manifestScripts);
        if (modified) {
          writeJson(projectSettingsPath, updatedSettings);
          projectEntriesRemoved = removedPaths.length;
          allRemovedPaths.push(...removedPaths);
        }
      }
    }

    return {
      globalEntriesRemoved,
      projectEntriesRemoved,
      removedPaths: allRemovedPaths,
    };
  } catch (_e) {
    return { globalEntriesRemoved: 0, projectEntriesRemoved: 0, removedPaths: [] };
  }
}

module.exports = { dedupPluginHooks };
