#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, invoked by skills/orchestray:plugin/SKILL.md.
'use strict';

/**
 * bin/orchestray-plugin-cli.js — /orchestray:plugin slash-command handler.
 *
 * W-CLI-1 (Wave 4): list / approve / disable / reload / status subcommands.
 * W-CLI-2 (Wave 4): consent prompt UX — renders capabilities + fingerprint + tools.
 * W-SEC-22 (Wave 3): fingerprint re-verification on reload subcommand.
 *
 * Depends on bin/_lib/plugin-loader.js (createLoader, _writeConsent).
 * The CLI is a trusted internal caller; it taps loader._internals._writeConsent
 * when a bound loader instance is used (avoids duplicating projectRoot resolution).
 *
 * Usage:
 *   node bin/orchestray-plugin-cli.js <subcommand> [args...]
 *   node bin/orchestray-plugin-cli.js list
 *   node bin/orchestray-plugin-cli.js approve <plugin-name>
 *   node bin/orchestray-plugin-cli.js disable <plugin-name>
 *   node bin/orchestray-plugin-cli.js reload  <plugin-name>
 *   node bin/orchestray-plugin-cli.js status  [<plugin-name>]
 *
 * Exit codes:
 *   0  — success or informational output
 *   1  — user-facing error (bad args, plugin not found, user declined)
 *   2  — internal error (I/O failure)
 */

const fs       = require('node:fs');
const os       = require('node:os');
const path     = require('node:path');
const readline = require('node:readline');

const { createLoader, _computeFingerprint: computeFingerprint } = require('./_lib/plugin-loader');

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

/**
 * Walk upward from cwd looking for a .orchestray directory.
 * Falls back to cwd if none found.
 */
function resolveProjectRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, '.orchestray'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const PROJECT_ROOT = resolveProjectRoot();
const loader       = createLoader({
  projectRoot: PROJECT_ROOT,
  // CLI does not write audit events from the bringup path; pass a no-op
  // sink so the loader does not log against an undefined writer when the
  // CLI runs outside the MCP server context.
  audit: () => {},
});

/**
 * Discover all plugins by running the loader's scan(). Augments each entry
 * with a `fingerprint` field computed from manifest+entrypoint so callers
 * can display and compare fingerprints without re-importing plugin-loader
 * internals.
 *
 * Returns: Array<{plugin_name, scan_path, manifest, rootDir, fingerprint}>
 */
async function discoverPlugins() {
  try {
    const results = await loader.scan();
    return results.map((p) => {
      let fingerprint = '';
      try {
        const entrypointAbs = path.join(p.rootDir, p.manifest.entrypoint);
        fingerprint = computeFingerprint(p.manifest, entrypointAbs);
      } catch (_e) {
        // Non-fatal — fingerprint remains '' if entrypoint unreadable.
      }
      return Object.assign({}, p, { fingerprint });
    });
  } catch (err) {
    process.stderr.write('plugin scan failed: ' + (err && err.message) + '\n');
    return [];
  }
}

/**
 * Find a single plugin by name from the most recent discovery pass.
 */
async function findPlugin(name) {
  const all = await discoverPlugins();
  return all.find((p) => p.plugin_name === name) || null;
}

/**
 * Read the bulk consent record. The consent file is managed by plugin-loader.js
 * at ~/.orchestray/state/plugin-consents.json (or opts.consentFile if overridden).
 * When missing, returns {}.
 */
function loadConsents() {
  try {
    const home = process.env.HOME || os.homedir();
    const consentPath = home
      ? path.join(home, '.orchestray', 'state', 'plugin-consents.json')
      : path.join(PROJECT_ROOT, '.orchestray', 'state', 'plugin-consents.json');
    if (!fs.existsSync(consentPath)) return {};
    const raw = fs.readFileSync(consentPath, 'utf-8');
    return JSON.parse(raw) || {};
  } catch (err) {
    process.stderr.write('plugin-consents read failed: ' + (err && err.message) + '\n');
    return {};
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const HELP = `
orchestray-plugin — manage Orchestray plugins

SUBCOMMANDS

  list
    Show all discovered plugins with consent state.

  approve <plugin-name>
    Show plugin capabilities and prompt for consent.
    Requires interactive terminal (TTY). Writes consent record on approval.

  disable <plugin-name>
    Revoke consent for a plugin. Plugin will not load until re-approved.

  reload <plugin-name>
    Re-scan plugin, recompute fingerprint, verify against stored consent.
    Refuses and prompts re-approve when fingerprint has changed (W-SEC-22).

  status [<plugin-name>]
    Show lifecycle state, consent record, and audit events for one or all plugins.

OPTIONS

  --cwd <path>    Override project root detection (default: nearest .orchestray ancestor)
  --help, -h      Print this help text

EXAMPLES

  /orchestray:plugin list
  /orchestray:plugin approve my-plugin
  /orchestray:plugin disable my-plugin
  /orchestray:plugin reload  my-plugin
  /orchestray:plugin status
  /orchestray:plugin status  my-plugin
`.trimStart();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args    = argv.slice(2);
  const opts    = { subcommand: null, pluginName: null, cwd: null };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { opts.help = true; }
    else if (a === '--cwd' && args[i + 1]) { opts.cwd = args[++i]; }
    else { positional.push(a); }
  }

  opts.subcommand = positional[0] || null;
  opts.pluginName = positional[1] || null;
  return opts;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Pad string to width (left-align).
 */
function pad(str, width) {
  const s = String(str || '');
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Print a simple ASCII table.
 * @param {string[]}   headers
 * @param {string[][]} rows
 */
function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => String(r[i] || '').length))
  );
  const sep = widths.map(w => '-'.repeat(w)).join('-+-');
  const fmt = (row) => row.map((c, i) => pad(c, widths[i])).join(' | ');

  console.log(fmt(headers));
  console.log(sep);
  for (const row of rows) console.log(fmt(row));
}

/**
 * Truncate fingerprint to N hex chars.
 */
function shortFp(fp, len) {
  if (!fp) return '(none)';
  return fp.slice(0, len);
}

// ---------------------------------------------------------------------------
// Consent prompt renderer (W-CLI-2)
// ---------------------------------------------------------------------------

/**
 * Render the consent prompt body to stdout.
 */
function renderConsentPrompt(manifest, rootDir, fingerprint) {
  console.log('');
  console.log(`PLUGIN: ${manifest.name} v${manifest.version || 'unknown'}`);
  console.log(`FINGERPRINT: ${shortFp(fingerprint, 16)}...`);
  console.log('');

  console.log('DECLARED CAPABILITIES:');
  const caps = manifest.capabilities || {};
  if (Object.keys(caps).length === 0) {
    console.log('  (none declared)');
  } else {
    for (const [key, val] of Object.entries(caps)) {
      console.log(`  ${key}: ${val}`);
    }
  }

  console.log('');
  console.log('DECLARED TOOLS:');
  const tools = manifest.tools || [];
  if (tools.length === 0) {
    console.log('  (none declared)');
  } else {
    for (const tool of tools) {
      const desc = tool.description ? `: ${tool.description}` : '';
      console.log(`  - ${tool.name}${desc}`);
    }
  }

  console.log('');
  console.log('WARNING: This plugin runs UNSANDBOXED with the same filesystem/network');
  console.log(`         access as Orchestray itself.`);
  console.log(`         Review source code at: ${rootDir}`);
  console.log('         before approving.');
  console.log('');
}

/**
 * Prompt user for yes/no via readline.
 * Rejects if stdin is not a TTY.
 * Returns Promise<boolean>.
 */
function promptYesNo(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('stdin is not a TTY — approve requires interactive terminal'));
      return;
    }

    const rl = readline.createInterface({
      input : process.stdin,
      output: process.stdout,
    });

    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === 'yes' || trimmed === 'y');
    });
  });
}

// ---------------------------------------------------------------------------
// Audit event helpers
// ---------------------------------------------------------------------------

/**
 * Read plugin-related audit events from .orchestray/state/events.jsonl.
 * Returns array of event objects matching the plugin name.
 */
function readPluginAuditEvents(pluginName) {
  const eventsPath = path.join(PROJECT_ROOT, '.orchestray', 'state', 'events.jsonl');
  try {
    const content = fs.readFileSync(eventsPath, 'utf8');
    return content
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(e => e && e.plugin === pluginName);
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function cmdList() {
  const plugins  = await discoverPlugins();
  const consents = loadConsents();

  if (plugins.length === 0) {
    console.log('No plugins discovered.');
    console.log('');
    console.log('Plugin search paths:');
    const scanPaths = [
      path.join(process.env.HOME || '~', '.claude', 'orchestray-plugins'),
      path.join(process.env.HOME || '~', '.orchestray', 'plugins'),
    ];
    for (const p of scanPaths) console.log(`  ${p}`);
    return;
  }

  const headers = ['NAME', 'VERSION', 'FINGERPRINT', 'STATE', 'CONSENTED?'];
  const rows = plugins.map(({ manifest, rootDir, fingerprint }) => {
    const name    = manifest.name;
    const version = manifest.version || '-';
    const fp      = shortFp(fingerprint, 8);
    const consent = consents[name];
    let state     = 'discovered';
    let consented = 'no';

    if (consent) {
      if (consent.revoked) {
        state     = 'revoked';
        consented = 'no (revoked)';
      } else if (consent.fingerprint === fingerprint) {
        state     = 'approved';
        consented = 'yes';
      } else {
        state     = 'stale';
        consented = 'no (fp mismatch)';
      }
    }

    return [name, version, fp, state, consented];
  });

  printTable(headers, rows);
}

// ---------------------------------------------------------------------------
// Subcommand: approve
// ---------------------------------------------------------------------------

async function cmdApprove(pluginName) {
  if (!pluginName) {
    console.error('Error: approve requires <plugin-name>');
    process.exit(1);
  }

  const plugin = await findPlugin(pluginName);
  if (!plugin) {
    console.error(`Error: plugin "${pluginName}" not found in any scan path`);
    process.exit(1);
  }

  const { manifest, rootDir, fingerprint } = plugin;

  renderConsentPrompt(manifest, rootDir, fingerprint);

  let approved;
  try {
    approved = await promptYesNo('Approve this plugin? (yes / no): ');
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (!approved) {
    console.log('Approval declined. Plugin consent not recorded.');
    process.exit(0);
  }

  loader._internals._writeConsent(pluginName, fingerprint, { manifest, rootDir });
  console.log(`Plugin "${pluginName}" approved (fingerprint: ${shortFp(fingerprint, 16)}...)`);
}

// ---------------------------------------------------------------------------
// Subcommand: disable
// ---------------------------------------------------------------------------

async function cmdDisable(pluginName) {
  if (!pluginName) {
    console.error('Error: disable requires <plugin-name>');
    process.exit(1);
  }

  const consents = loadConsents();
  if (!consents[pluginName]) {
    console.error(`Error: no consent record for "${pluginName}" — nothing to disable`);
    process.exit(1);
  }

  if (consents[pluginName].revoked) {
    console.log(`Plugin "${pluginName}" is already disabled.`);
    return;
  }

  // Find current manifest to pass rootDir through.
  const plugin = await findPlugin(pluginName);
  const disableOpts = {
    revoked : true,
    manifest: plugin?.manifest,
    rootDir : plugin?.rootDir || consents[pluginName].rootDir,
  };
  const fp = consents[pluginName].fingerprint || '';
  loader._internals._writeConsent(pluginName, fp, disableOpts);
  console.log(`Plugin "${pluginName}" disabled (consent revoked).`);
}

// ---------------------------------------------------------------------------
// Subcommand: reload (W-SEC-22 fingerprint re-verify)
// ---------------------------------------------------------------------------

async function cmdReload(pluginName) {
  if (!pluginName) {
    console.error('Error: reload requires <plugin-name>');
    process.exit(1);
  }

  const plugin = await findPlugin(pluginName);
  if (!plugin) {
    console.error(`Error: plugin "${pluginName}" not found in any scan path`);
    process.exit(1);
  }

  const { manifest, rootDir, fingerprint: newFp } = plugin;
  const consents = loadConsents();
  const consent  = consents[pluginName];

  if (!consent || consent.revoked) {
    console.error(`Error: plugin "${pluginName}" has no active consent — use approve first`);
    process.exit(1);
  }

  if (consent.fingerprint !== newFp) {
    console.error(`SECURITY: Plugin "${pluginName}" fingerprint has changed.`);
    console.error(`  Stored:  ${shortFp(consent.fingerprint, 16)}...`);
    console.error(`  Current: ${shortFp(newFp, 16)}...`);
    console.error('');
    console.error('Plugin source has changed since last approval. Run:');
    console.error(`  /orchestray:plugin approve ${pluginName}`);
    console.error('to review and re-approve the updated plugin.');
    process.exit(1);
  }

  console.log(`Plugin "${pluginName}" reload OK — fingerprint verified (${shortFp(newFp, 8)}).`);
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

async function cmdStatus(pluginName) {
  const consents = loadConsents();
  const plugins  = await discoverPlugins();

  // Merge discovered + consent-only records.
  const names = new Set([
    ...plugins.map(p => p.manifest.name),
    ...Object.keys(consents),
  ]);

  if (pluginName) {
    if (!names.has(pluginName)) {
      console.error(`Error: plugin "${pluginName}" not found`);
      process.exit(1);
    }
    printPluginStatus(pluginName, plugins, consents);
  } else {
    if (names.size === 0) {
      console.log('No plugins discovered and no consent records found.');
      return;
    }
    for (const name of names) {
      printPluginStatus(name, plugins, consents);
      console.log('');
    }
  }
}

function printPluginStatus(name, plugins, consents) {
  const discovered = plugins.find(p => p.manifest.name === name);
  const consent    = consents[name];
  const events     = readPluginAuditEvents(name);

  console.log(`## ${name}`);

  if (discovered) {
    const { manifest, rootDir, fingerprint } = discovered;
    console.log(`  version    : ${manifest.version || 'unknown'}`);
    console.log(`  rootDir    : ${rootDir}`);
    console.log(`  fingerprint: ${shortFp(fingerprint, 16)}...`);
  } else {
    console.log('  (not found in scan paths — may have been removed)');
  }

  if (consent) {
    const state = consent.revoked ? 'REVOKED' :
      (discovered && discovered.fingerprint !== consent.fingerprint ? 'STALE (fp mismatch)' : 'APPROVED');
    console.log(`  consent    : ${state}`);
    console.log(`  approvedAt : ${consent.approvedAt || '-'}`);
    if (consent.revoked) console.log(`  revokedAt  : ${consent.revokedAt || '-'}`);
  } else {
    console.log('  consent    : NONE');
  }

  console.log(`  audit events: ${events.length}`);
  if (events.length > 0) {
    const recent = events.slice(-3);
    for (const ev of recent) {
      console.log(`    [${ev.ts || '?'}] ${ev.type || '?'} ${ev.detail || ''}`);
    }
    if (events.length > 3) console.log(`    ... and ${events.length - 3} earlier event(s)`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || !opts.subcommand) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  switch (opts.subcommand) {
    case 'list':
      await cmdList();
      break;

    case 'approve':
      await cmdApprove(opts.pluginName);
      break;

    case 'disable':
      await cmdDisable(opts.pluginName);
      break;

    case 'reload':
      await cmdReload(opts.pluginName);
      break;

    case 'status':
      await cmdStatus(opts.pluginName);
      break;

    default:
      console.error(`Error: unknown subcommand "${opts.subcommand}"`);
      console.error('Run with --help for usage.');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(2);
});
