#!/usr/bin/env node
'use strict';

/**
 * changelog-event-name-check.js — CHANGELOG↔shadow naming firewall (v2.2.9 F3 part 2).
 *
 * Why this exists
 * ---------------
 * v2.2.8's CHANGELOG L20 referenced `loop_complete` (the actual event is
 * `loop_completed`) and `snapshot_taken` (the actual event is
 * `snapshot_captured`). Both shipped as documented bugs that no human or hook
 * caught at release time. Per `feedback_mechanical_over_prose.md`, telling the
 * release-manager "check that names match" fails 4/5 times. This script makes
 * the failure mechanical: backtick-quoted event-name tokens in the unreleased
 * (or topmost) CHANGELOG section are diffed against the keys of
 * `agents/pm-reference/event-schemas.shadow.json`. Any name in CHANGELOG that
 * is NOT in shadow → exit 2 with the offending names listed.
 *
 * Token recognition
 * -----------------
 * The script extracts every backtick-quoted run of text inside the CHANGELOG
 * section and keeps tokens that match BOTH:
 *
 *   /^[a-z][a-z0-9_]+$/   — event-name pattern (lowercase, alnum, underscores)
 *   contains at least one underscore
 *
 * The underscore filter excludes incidental backtick prose (`null`, `true`,
 * `event-schemas.md`, single-word identifiers). Event names by convention
 * always contain an underscore (`agent_stop`, `routing_outcome`, ...).
 *
 * Section detection
 * -----------------
 * The script reads the unreleased / topmost version section by scanning for
 * the first level-2 heading line matching:
 *
 *   ^## \[<version>\] - <date>
 *   ^## \[Unreleased\]
 *
 * Tokens in the body of that section (up to the next `## ` heading or EOF)
 * are extracted. A CHANGELOG with NO unreleased section AND no top-level
 * version section → exits 0 (nothing to check).
 *
 * Exit codes
 * ----------
 *   0 — no drift (or nothing to check, or kill-switch on for non-release commit)
 *   2 — drift detected; offending tokens printed to stderr
 *
 * Default-on contract
 * -------------------
 * Per `feedback_default_on_shipping.md`. Kill switch
 * `ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED=1` honored ONLY for non-release
 * commits. Release commits (subject starting `release:`) cannot opt out;
 * `--release` flag forces strict mode regardless of env.
 *
 * Telemetry
 * ---------
 * On drift, emits `changelog_naming_drift_detected` BEFORE exiting 2 so
 * `/orchestray:analytics` sees the drift even when CI blocks the commit.
 */

const fs   = require('node:fs');
const path = require('node:path');

const { resolveSafeCwd } = require('../_lib/resolve-project-cwd');
const { writeEvent }     = require('../_lib/audit-event-writer');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    cwd:           null,
    changelogPath: null,
    shadowPath:    null,
    release:       false,
    quiet:         false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd' && argv[i + 1])           { out.cwd = argv[++i];           continue; }
    if (a === '--changelog' && argv[i + 1])     { out.changelogPath = argv[++i]; continue; }
    if (a === '--shadow' && argv[i + 1])        { out.shadowPath    = argv[++i]; continue; }
    if (a === '--release')                      { out.release = true;            continue; }
    if (a === '--quiet')                        { out.quiet = true;              continue; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section + token extraction
// ---------------------------------------------------------------------------

const SECTION_HEADING_RE = /^## \[([^\]]+)\][^\n]*$/;
const TOKEN_RE           = /`([^`\n]+)`/g;
const EVENT_NAME_RE      = /^[a-z][a-z0-9_]+$/;

/**
 * Slice the unreleased/topmost section out of CHANGELOG content.
 * Returns `{ header: string|null, body: string }`. Empty body when no section.
 */
function extractTopSection(content) {
  const lines = content.split('\n');
  let startIdx = -1;
  let header   = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_HEADING_RE);
    if (m) {
      startIdx = i;
      header   = lines[i].slice(3).trim();
      break;
    }
  }
  if (startIdx === -1) return { header: null, body: '' };
  // Find next ## heading (any level-2; not just version).
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const body = lines.slice(startIdx + 1, endIdx).join('\n');
  return { header, body };
}

/**
 * Extract every backtick-quoted token in `text` that looks like an
 * event-name. Returns a Set<string>.
 */
function extractEventNameTokens(text) {
  const out = new Set();
  if (typeof text !== 'string' || text.length === 0) return out;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const inner = m[1];
    // Multi-token-line guard: tokens like `foo, bar` are unusual but possible.
    // Trim and discard empty.
    const candidate = inner.trim();
    if (candidate.length === 0) continue;
    if (!EVENT_NAME_RE.test(candidate)) continue;
    if (candidate.indexOf('_') === -1) continue; // no underscore = filter
    // Filter MCP-tool-name pattern: `mcp__<server>__<tool>` is never an
    // event-type. Conventional event names have at most single underscores
    // (`agent_stop`, `routing_outcome`); MCP tool names use double-underscore
    // segments. Filtering double-underscore tokens removes the entire MCP
    // class without false-negatives on real events.
    if (candidate.indexOf('__') !== -1) continue;
    out.add(candidate);
  }
  return out;
}

/**
 * Load the shadow keys (excluding `_meta`).
 */
function loadShadowKeys(shadowPath) {
  let raw;
  try {
    raw = fs.readFileSync(shadowPath, 'utf8');
  } catch (e) {
    throw new Error(`changelog-event-name-check: read shadow failed: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`changelog-event-name-check: parse shadow failed: ${e.message}`);
  }
  const keys = new Set();
  for (const k of Object.keys(parsed)) {
    if (k === '_meta') continue;
    keys.add(k);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run(opts) {
  opts = opts || {};
  const cwd           = resolveSafeCwd(opts.cwd);
  const changelogPath = opts.changelogPath || path.join(cwd, 'CHANGELOG.md');
  const shadowPath    = opts.shadowPath    || path.join(cwd, 'agents', 'pm-reference', 'event-schemas.shadow.json');

  // Kill-switch (only honored for non-release commits)
  const killSwitch = process.env.ORCHESTRAY_CHANGELOG_FIREWALL_DISABLED === '1';
  if (killSwitch && !opts.release) {
    return { exitCode: 0, missing: [], header: null, reason: 'kill_switch' };
  }

  let changelogContent;
  try {
    changelogContent = fs.readFileSync(changelogPath, 'utf8');
  } catch (e) {
    // No CHANGELOG → nothing to check. Exit 0.
    if (e && e.code === 'ENOENT') {
      return { exitCode: 0, missing: [], header: null, reason: 'changelog_missing' };
    }
    process.stderr.write(`changelog-event-name-check: read CHANGELOG failed: ${e.message}\n`);
    return { exitCode: 0, missing: [], header: null, reason: 'changelog_read_error' };
  }

  let shadowKeys;
  try {
    shadowKeys = loadShadowKeys(shadowPath);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return { exitCode: 0, missing: [], header: null, reason: 'shadow_read_error' };
  }

  const { header, body } = extractTopSection(changelogContent);
  if (!header) {
    return { exitCode: 0, missing: [], header: null, reason: 'no_section' };
  }

  const tokens = extractEventNameTokens(body);
  const missing = [];
  for (const t of tokens) {
    if (!shadowKeys.has(t)) missing.push(t);
  }
  missing.sort();

  if (missing.length === 0) {
    return { exitCode: 0, missing: [], header, reason: 'no_drift' };
  }

  // Drift detected. Emit telemetry BEFORE returning 2.
  try {
    writeEvent({
      type:               'changelog_naming_drift_detected',
      version:            1,
      missing_tokens:     missing.slice(),
      changelog_section:  header,
    }, { cwd });
  } catch (e) {
    process.stderr.write(`changelog-event-name-check: emit telemetry failed: ${e.message}\n`);
  }

  return { exitCode: 2, missing, header, reason: 'drift_detected' };
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = run(opts);
  } catch (e) {
    process.stderr.write(`changelog-event-name-check: top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0); // fail-open at top-level
  }
  if (result.exitCode === 2 && !opts.quiet) {
    process.stderr.write(
      `\n[changelog-event-name-check] CHANGELOG section "${result.header}" references ` +
      `${result.missing.length} event-name token(s) NOT present in ` +
      `agents/pm-reference/event-schemas.shadow.json:\n`
    );
    for (const t of result.missing) {
      process.stderr.write(`  - \`${t}\`\n`);
    }
    process.stderr.write(
      `\nFix: rename to the canonical schema name OR add the event-type to ` +
      `agents/pm-reference/event-schemas.md and re-run \`node bin/regen-schema-shadow.js\`.\n`
    );
  }
  process.exit(result.exitCode);
}

module.exports = {
  run,
  extractTopSection,
  extractEventNameTokens,
  loadShadowKeys,
};
