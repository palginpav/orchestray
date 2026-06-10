'use strict';

/**
 * inject-plugin-tools-into-pm.js — Enumerate every consented plugin's MCP
 * tools into the installed PM frontmatter `tools:` allowlist.
 *
 * Wildcards aren't honored by Claude Code's parser (verified v2.3.2); each
 * tool must appear explicitly. Source pm.md is never mutated — only the
 * installed copy. Re-run the installer after each plugin add/remove.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { buildNamespacedName } = require('./plugin-namespace');

const MCP_PREFIX = 'mcp__orchestray__';

// Refuse to write a tools: line larger than this; a corrupt consent file
// must not produce an unparseable frontmatter.
const MAX_TOOLS_LINE_BYTES = 16384;

/**
 * Read the consent file. Only HOME-canonical path is consulted.
 * cwd fallback is intentionally removed: an agent with Write-tool access
 * could forge a consent file in the cwd and have it honored here.
 *
 * For tests, pass opts.consentFile (absolute path) to redirect consent
 * lookup — that is the only supported override.
 *
 * @param {{home?: string, consentFile?: string}} [opts]
 * @returns {Record<string, any>}
 */
function readConsents(opts) {
  opts = opts || {};
  // Test-only explicit override (absolute path required).
  if (opts.consentFile && path.isAbsolute(opts.consentFile)) {
    try {
      const raw = fs.readFileSync(opts.consentFile, 'utf8');
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return obj;
    } catch (_e) { /* absent or unreadable */ }
    return {};
  }
  const home = opts.home || process.env.HOME || os.homedir() || '';
  if (!home) return {};
  const canonical = path.join(home, '.orchestray', 'state', 'plugin-consents.json');
  try {
    const raw = fs.readFileSync(canonical, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return obj;
  } catch (_e) { /* absent or unreadable */ }
  return {};
}

/**
 * Sorted list of namespaced tool names for every consented, non-revoked
 * plugin. Skips invalid kebab-case names (buildNamespacedName throws).
 *
 * @param {Record<string, any>} consents
 * @returns {string[]}
 */
function buildPluginToolNames(consents) {
  if (!consents || typeof consents !== 'object') return [];
  const out = [];
  for (const [pluginName, record] of Object.entries(consents)) {
    if (!record || record.revoked) continue;
    const tools = record.manifest && record.manifest.tools;
    if (!Array.isArray(tools)) continue;
    for (const t of tools) {
      if (!t || typeof t.name !== 'string') continue;
      try {
        out.push(MCP_PREFIX + buildNamespacedName(pluginName, t.name));
      } catch (_e) { /* loader would also reject; skip */ }
    }
  }
  return Array.from(new Set(out)).sort();
}

/**
 * Pure rewrite: strip any existing `mcp__orchestray__plugin_*` entries
 * (idempotent; also clears the dead wildcard from the v2.3.2 attempt),
 * then append `pluginToolNames` to the `tools:` line. Throws if no
 * frontmatter, no `tools:` line, or the resulting line exceeds
 * MAX_TOOLS_LINE_BYTES.
 *
 * @param {string} pmText
 * @param {string[]} pluginToolNames
 * @returns {string}
 */
function injectPluginTools(pmText, pluginToolNames) {
  if (typeof pmText !== 'string') throw new TypeError('pmText must be a string');
  if (!Array.isArray(pluginToolNames)) throw new TypeError('pluginToolNames must be an array');

  if (!pmText.startsWith('---\n')) {
    throw new Error('inject-plugin-tools: pm.md must start with YAML frontmatter (---)');
  }
  const fmEndIdx = pmText.indexOf('\n---\n', 4);
  if (fmEndIdx < 0) {
    throw new Error('inject-plugin-tools: pm.md frontmatter end (---) not found');
  }
  const fmText = pmText.slice(0, fmEndIdx + 5);
  const body   = pmText.slice(fmEndIdx + 5);

  const toolsLineRe = /^tools:[ \t]*(.*)$/m;
  const m = fmText.match(toolsLineRe);
  if (!m) {
    throw new Error('inject-plugin-tools: pm.md frontmatter has no `tools:` line');
  }

  // Strip prior plugin_* entries and the dead wildcard, then append fresh.
  const kept = m[1]
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .filter(s => !s.startsWith(MCP_PREFIX + 'plugin_') && s !== MCP_PREFIX + 'plugin_*');

  const newLine = 'tools: ' + kept.concat(pluginToolNames).join(', ');

  if (Buffer.byteLength(newLine, 'utf8') > MAX_TOOLS_LINE_BYTES) {
    throw new Error(
      `inject-plugin-tools: resulting tools: line is ${Buffer.byteLength(newLine, 'utf8')} bytes ` +
      `(limit ${MAX_TOOLS_LINE_BYTES}); refusing to write`
    );
  }

  if (newLine === m[0]) return pmText;

  const newFm = fmText.replace(toolsLineRe, newLine);
  return newFm + body;
}

/**
 * Read, inject, write atomically.
 *
 * @param {string} pmPath
 * @param {{consents?: Record<string, any>, home?: string, consentFile?: string}} [opts]
 * @returns {{changed: boolean, toolCount: number, pluginToolNames: string[]}}
 */
function injectIntoPmFile(pmPath, opts) {
  opts = opts || {};
  const consents = opts.consents || readConsents({ home: opts.home, consentFile: opts.consentFile });
  const pluginToolNames = buildPluginToolNames(consents);
  const before = fs.readFileSync(pmPath, 'utf8');
  const after  = injectPluginTools(before, pluginToolNames);
  if (after === before) {
    return { changed: false, toolCount: pluginToolNames.length, pluginToolNames };
  }
  const tmp = pmPath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, after, 'utf8');
  fs.renameSync(tmp, pmPath);
  return { changed: true, toolCount: pluginToolNames.length, pluginToolNames };
}

module.exports = {
  readConsents,
  buildPluginToolNames,
  injectPluginTools,
  injectIntoPmFile,
  MCP_PREFIX,
  MAX_TOOLS_LINE_BYTES,
};
