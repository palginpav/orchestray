'use strict';

/**
 * custom-agents.js — public API for custom-agent discovery and validation.
 *
 * v2.3.1: drop-in custom agents at ~/.claude/orchestray/custom-agents/<name>.md.
 *
 * Design contract (§4):
 *   - Pure module: no I/O at import time.
 *   - No function ever throws across the API boundary.
 *   - All fs.* calls wrapped in try/catch.
 *   - Error results use the reason enum from §3.1.
 *   - Fail-soft: validation failures return {ok:false}; cache failures return empty payload.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { CANONICAL_AGENTS } = require('./canonical-agents');

// v2.3.1: pre-compute NFKD-normalized canonical names once per module load.
const NORMALIZED_CANONICAL_NAMES = new Set(
  [...CANONICAL_AGENTS].map(s => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]/g, ''))
);

// ---------------------------------------------------------------------------
// Allowed tool tokens for custom agents (§3.1)
// ---------------------------------------------------------------------------

/** @type {Set<string>} */
const ALLOWED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit']);

/** @type {Set<string>} */
const ALLOWED_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** @type {Set<string>} */
const ALLOWED_MEMORY = new Set(['user', 'project', 'local']);

/** @type {Set<string>} */
const ALLOWED_MODEL_SHORT = new Set(['haiku', 'sonnet', 'opus', 'inherit']);

/**
 * Full model IDs from ox.js VALID_MODELS (mirrored here — do not import ox.js
 * to avoid pulling in its heavy CLI dependencies).
 * @type {Set<string>}
 */
const ALLOWED_MODEL_FULL = new Set([
  'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7',
  'claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20250922',
]);

/** Max file body size (200 KB). */
const MAX_FILE_BYTES = 200 * 1024;

/** Max number of files to process per directory. */
const MAX_DIR_FILES = 100;

/** Max name length (chars, per regex upper bound). */
const MAX_NAME_LEN = 48;

/** Name regex: starts with lowercase letter, [a-z0-9-], 2–48 chars total. */
const NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;

// ---------------------------------------------------------------------------
// Frontmatter parser (reuses pattern from gate-agent-spawn.js L618)
// ---------------------------------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Parse YAML-style frontmatter from a markdown string.
 * Returns the parsed key-value map or throws on malformed input.
 * Only supports simple scalar values (string, boolean, number).
 * @param {string} content
 * @returns {Record<string, unknown>}
 */
function parseFrontmatter(content) {
  const m = FM_RE.exec(content);
  if (!m) throw new Error('no frontmatter block found');
  const block = m[1];
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    // Parse booleans
    if (rawVal === 'true')  { result[key] = true;  continue; }
    if (rawVal === 'false') { result[key] = false; continue; }
    // Parse integers
    if (/^-?\d+$/.test(rawVal)) {
      result[key] = parseInt(rawVal, 10);
      continue;
    }
    // Remove surrounding quotes if present
    if ((rawVal.startsWith('"') && rawVal.endsWith('"')) ||
        (rawVal.startsWith("'") && rawVal.endsWith("'"))) {
      result[key] = rawVal.slice(1, -1);
      continue;
    }
    result[key] = rawVal;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Resolve the global custom-agents source directory.
 * Honours $ORCHESTRAY_CUSTOM_AGENTS_DIR for tests; otherwise
 * path.join(os.homedir(), '.claude', 'orchestray', 'custom-agents').
 * @returns {string}
 */
function resolveCustomAgentsDir() {
  if (process.env.ORCHESTRAY_CUSTOM_AGENTS_DIR) {
    return process.env.ORCHESTRAY_CUSTOM_AGENTS_DIR;
  }
  return path.join(os.homedir(), '.claude', 'orchestray', 'custom-agents');
}

/**
 * Parse and validate one .md file. Never throws.
 *
 * @param {string} absPath - Absolute path to the file.
 * @param {{ reservedNames: Set<string>, shippedSpecialistNames: Set<string> }} options
 * @returns {{ ok: true, record: object } | { ok: false, name: string|null, reason: string }}
 */
function validateCustomAgentFile(absPath, options) {
  const reservedNames        = (options && options.reservedNames)        || new Set();
  const shippedSpecialistNames = (options && options.shippedSpecialistNames) || new Set();

  try {
    // §16.1: symlink defense — lstat first; reject symlinks.
    let lstats;
    try {
      lstats = fs.lstatSync(absPath);
    } catch (e) {
      return { ok: false, name: null, reason: 'internal_error' };
    }
    if (lstats.isSymbolicLink()) {
      return { ok: false, name: null, reason: 'internal_error' };
    }

    // §3.1: file size cap (200 KB).
    if (lstats.size > MAX_FILE_BYTES) {
      return { ok: false, name: null, reason: 'file_too_large' };
    }

    // Read file body.
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      return { ok: false, name: null, reason: 'internal_error' };
    }

    // Parse frontmatter.
    let fm;
    try {
      fm = parseFrontmatter(content);
    } catch (_) {
      return { ok: false, name: null, reason: 'frontmatter_malformed' };
    }

    // Forbidden fields (security — before name extraction so we fail early).
    if ('bypassPermissions' in fm) {
      return { ok: false, name: null, reason: 'forbidden_field_bypass_permissions' };
    }
    if ('acceptEdits' in fm) {
      return { ok: false, name: null, reason: 'forbidden_field_accept_edits' };
    }

    // Name: required, ASCII-only regex, must match filename basename.
    // Cyrillic-homoglyph names (e.g. 'reviewеr', U+0435) reject as 'name_invalid'
    // here before the NFKD check below — by design (NFKD strips non-ASCII to
    // 'reviewr', not 'reviewer', so collision wouldn't fire anyway).
    const nameField = fm.name;
    if (typeof nameField !== 'string' || !NAME_RE.test(nameField)) {
      return { ok: false, name: null, reason: 'name_invalid' };
    }
    const basename = path.basename(absPath, '.md');
    if (nameField !== basename) {
      return { ok: false, name: nameField, reason: 'name_filename_mismatch' };
    }

    // Reserved-name collision: NFKD-normalize and compare.
    const normalizedName = nfkdLowerAscii(nameField);

    // Check canonical collision (using module-hoisted normalized set).
    if (NORMALIZED_CANONICAL_NAMES.has(normalizedName)) {
      return { ok: false, name: nameField, reason: 'canonical_collision' };
    }

    // Check shipped specialist collision.
    const normalizedSpecialistsSet = new Set([...shippedSpecialistNames].map(nfkdLowerAscii));
    if (normalizedSpecialistsSet.has(normalizedName)) {
      return { ok: false, name: nameField, reason: 'shipped_specialist_collision' };
    }

    // Check general reserved-names set (passed by caller, already NFKD-normalized).
    if (reservedNames.has(normalizedName)) {
      return { ok: false, name: nameField, reason: 'reserved_name_collision' };
    }

    // Description: required, 1–500 chars, no newlines.
    const desc = fm.description;
    if (typeof desc !== 'string') {
      return { ok: false, name: nameField, reason: 'description_invalid' };
    }
    const trimmedDesc = desc.trim();
    if (trimmedDesc.length === 0 || trimmedDesc.length > 500 || /\n/.test(trimmedDesc)) {
      return { ok: false, name: nameField, reason: 'description_invalid' };
    }

    // Tools: required, comma-separated, each must be in ALLOWED_TOOLS.
    const toolsField = fm.tools;
    if (typeof toolsField !== 'string' || !toolsField.trim()) {
      return { ok: false, name: nameField, reason: 'forbidden_tool' };
    }
    const toolTokens = toolsField.split(',').map(t => t.trim()).filter(Boolean);
    if (toolTokens.length === 0) {
      return { ok: false, name: nameField, reason: 'forbidden_tool' };
    }
    for (const token of toolTokens) {
      if (!ALLOWED_TOOLS.has(token)) {
        return { ok: false, name: nameField, reason: 'forbidden_tool: ' + token };
      }
    }

    // Optional: model validation.
    if (fm.model !== undefined) {
      const model = String(fm.model).trim();
      if (!ALLOWED_MODEL_SHORT.has(model) && !ALLOWED_MODEL_FULL.has(model)) {
        return { ok: false, name: nameField, reason: 'model_invalid' };
      }
    }

    // Optional: effort validation.
    if (fm.effort !== undefined) {
      if (!ALLOWED_EFFORT.has(String(fm.effort).trim())) {
        return { ok: false, name: nameField, reason: 'effort_invalid' };
      }
    }

    // Optional: memory validation.
    if (fm.memory !== undefined) {
      if (!ALLOWED_MEMORY.has(String(fm.memory).trim())) {
        return { ok: false, name: nameField, reason: 'memory_invalid' };
      }
    }

    // Optional: maxTurns validation.
    if (fm.maxTurns !== undefined) {
      const mt = fm.maxTurns;
      if (!Number.isInteger(mt) || mt <= 0 || mt > 200) {
        return { ok: false, name: nameField, reason: 'maxturns_invalid' };
      }
    }

    // Build the record.
    /** @type {Record<string, unknown>} */
    const record = {
      name:        nameField,
      description: trimmedDesc,
      tools:       toolsField.trim(),
      source_path: absPath,
    };
    if (fm.model   !== undefined) record.model   = String(fm.model).trim();
    if (fm.effort  !== undefined) record.effort  = String(fm.effort).trim();
    if (fm.color   !== undefined) record.color   = String(fm.color);
    if (fm.memory  !== undefined) record.memory  = String(fm.memory).trim();
    if (fm.maxTurns !== undefined) record.maxTurns = fm.maxTurns;

    return { ok: true, record };
  } catch (_err) {
    return { ok: false, name: null, reason: 'internal_error' };
  }
}

/**
 * Atomically write the custom-agents cache.
 *
 * @param {string} cwd - Project root directory.
 * @param {{ version: 1, discovered_at: string, source_dir: string, agents: object[] }} payload
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function writeCache(cwd, payload) {
  try {
    const stateDir  = path.join(cwd, '.orchestray', 'state');
    const finalPath = path.join(stateDir, 'custom-agents-cache.json');
    const tmpPath   = finalPath + '.tmp.' + process.pid;

    try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_) { /* may already exist */ }

    const json = JSON.stringify(payload, null, 2) + '\n';
    try {
      fs.writeFileSync(tmpPath, json, { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      return { ok: false, reason: String(e && e.code ? e.code : e.message || e) };
    }

    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (e) {
      // Clean up tmp on failure; best-effort.
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      return { ok: false, reason: String(e && e.code ? e.code : e.message || e) };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

/**
 * Read the custom-agents cache. Fail-soft: returns empty payload on any error.
 *
 * @param {string} cwd - Project root directory.
 * @returns {{ version: number, discovered_at: string|null, source_dir: string|null, agents: object[] }}
 */
function readCache(cwd) {
  const empty = { version: 1, discovered_at: null, source_dir: null, agents: [] };
  try {
    const cachePath = path.join(cwd, '.orchestray', 'state', 'custom-agents-cache.json');
    let raw;
    try {
      raw = fs.readFileSync(cachePath, 'utf8');
    } catch (_) {
      return empty;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return empty;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return empty;
    }

    const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
    return {
      version:       typeof parsed.version === 'number' ? parsed.version : 1,
      discovered_at: typeof parsed.discovered_at === 'string' ? parsed.discovered_at : null,
      source_dir:    typeof parsed.source_dir === 'string' ? parsed.source_dir : null,
      agents,
    };
  } catch (_) {
    return empty;
  }
}

/**
 * NFKD-normalize a string to lowercase ASCII (no combining marks, no special chars).
 * Used for reserved-name collision detection.
 *
 * @param {string} s
 * @returns {string}
 */
function nfkdLowerAscii(s) {
  return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * Read shipped-specialist names from <pluginRoot>/specialists/*.md.
 * Returns a Set of basename strings (without .md extension).
 * Fail-soft: returns empty Set on any error.
 *
 * @param {string} pluginRoot - Root of the installed plugin (dirname of dirname(__filename) for hooks).
 * @returns {Set<string>}
 */
function loadShippedSpecialistNames(pluginRoot) {
  try {
    const specDir = path.join(pluginRoot, 'specialists');
    let files;
    try {
      files = fs.readdirSync(specDir);
    } catch (_) {
      return new Set();
    }
    const names = files
      .filter(f => f.endsWith('.md'))
      .map(f => path.basename(f, '.md'));
    return new Set(names);
  } catch (_) {
    return new Set();
  }
}

module.exports = {
  resolveCustomAgentsDir,
  validateCustomAgentFile,
  writeCache,
  readCache,
  nfkdLowerAscii,
  loadShippedSpecialistNames,
  // Expose constants for tests
  ALLOWED_TOOLS,
  MAX_DIR_FILES,
  MAX_FILE_BYTES,
};
