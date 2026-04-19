'use strict';

/**
 * proposed-patterns.js — Shared helper for `/orchestray:learn` accept/reject flows.
 *
 * Provides read, accept, and reject operations on the proposed-patterns staging
 * directory (.orchestray/proposed-patterns/). Used by the `orchestray:learn` skill
 * for the `list --proposed`, `accept <slug>`, and `reject <slug>` subcommands.
 *
 * Design contract (v2.1.6 W4 §4):
 *   - accept: Layer-C re-validation via proposal-validator.validateProposal(),
 *     atomic rename to .orchestray/patterns/, frontmatter-field strip, audit event.
 *   - reject: move to .orchestray/proposed-patterns/rejected/, add rejected_at +
 *     rejected_reason fields, audit event.
 *   - All file moves use fs.rename first; EXDEV fallback to copy+unlink.
 *   - Audit events via bin/_lib/audit-event-writer path (atomicAppendJsonl).
 *   - No absolute paths — everything via projectRoot.
 */

const fs = require('node:fs');
const path = require('node:path');

const frontmatter = require('../mcp-server/lib/frontmatter');
const { validateProposal, PROTECTED_FIELDS } = require('./proposal-validator');
const { atomicAppendJsonl } = require('./atomic-append');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function _proposedDir(projectRoot) {
  return path.join(projectRoot, '.orchestray', 'proposed-patterns');
}

function _proposedPath(projectRoot, slug) {
  return path.join(_proposedDir(projectRoot), slug + '.md');
}

function _rejectedDir(projectRoot) {
  return path.join(_proposedDir(projectRoot), 'rejected');
}

function _rejectedPath(projectRoot, slug) {
  return path.join(_rejectedDir(projectRoot), slug + '.md');
}

function _activeDir(projectRoot) {
  return path.join(projectRoot, '.orchestray', 'patterns');
}

function _activePath(projectRoot, slug) {
  return path.join(_activeDir(projectRoot), slug + '.md');
}

function _eventsPath(projectRoot) {
  return path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Emit a learn-surface audit event. Fail-open — never throws.
 *
 * @param {string} projectRoot
 * @param {object} event
 */
function _emitAudit(projectRoot, event) {
  try {
    const eventsPath = _eventsPath(projectRoot);
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    atomicAppendJsonl(eventsPath, {
      timestamp: new Date().toISOString(),
      schema_version: 1,
      ...event,
    });
  } catch (_) {
    // Fail-open: audit failure must not block the operation.
  }
}

// ---------------------------------------------------------------------------
// File-move helper (atomic rename with EXDEV fallback)
// ---------------------------------------------------------------------------

/**
 * Move a file from src to dest.
 * Tries fs.renameSync first (atomic on same device).
 * On EXDEV (cross-device) falls back to copy + unlink.
 *
 * @param {string} src
 * @param {string} dest
 */
function _moveFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter strip helper
// ---------------------------------------------------------------------------

/**
 * Strip proposed-lifecycle fields AND any PROTECTED_FIELDS from a frontmatter object.
 * Returns a new object (does not mutate) and a list of any protected fields that were removed.
 *
 * Lifecycle fields always stripped: proposed, proposed_at, proposed_from, layer_b_markers
 * Security fields also stripped (B4-01 METR fix): all members of PROTECTED_FIELDS from
 * proposal-validator.js. An attacker-authored proposed file may contain these; stripping
 * them here prevents them from reaching .orchestray/patterns/<slug>.md.
 *
 * @param {object} fm
 * @returns {{ stripped: object, removedProtected: string[] }}
 */
function _stripProposedFields(fm) {
  const LIFECYCLE = new Set(['proposed', 'proposed_at', 'proposed_from', 'layer_b_markers']);
  const out = {};
  const removedProtected = [];
  for (const [k, v] of Object.entries(fm)) {
    if (LIFECYCLE.has(k)) continue;
    if (PROTECTED_FIELDS.has(k)) {
      removedProtected.push(k);
      continue;
    }
    out[k] = v;
  }
  return { stripped: out, removedProtected };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all staged proposals in .orchestray/proposed-patterns/ (non-recursive,
 * excludes rejected/ subdir).
 *
 * Returns an array of { slug, frontmatter, filepath } objects sorted by slug.
 * Returns [] if the directory is absent or empty.
 *
 * @param {string} projectRoot
 * @returns {Array<{slug: string, frontmatter: object, filepath: string}>}
 */
function listProposed(projectRoot) {
  const dir = _proposedDir(projectRoot);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }

  const results = [];
  for (const name of entries.filter((n) => n.endsWith('.md')).sort()) {
    const filepath = path.join(dir, name);
    let content;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch (_) {
      continue;
    }
    const parsed = frontmatter.parse(content);
    if (!parsed.hasFrontmatter) continue;
    results.push({
      slug: name.slice(0, -3),
      frontmatter: parsed.frontmatter,
      filepath,
    });
  }
  return results;
}

/**
 * Read a single proposed pattern by slug.
 *
 * Returns { slug, frontmatter, body, filepath } on success.
 * Throws if the file is missing, unreadable, or has no frontmatter.
 *
 * @param {string} slug
 * @param {string} projectRoot
 * @returns {{ slug: string, frontmatter: object, body: string, filepath: string }}
 */
function readProposed(slug, projectRoot) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('slug must be a non-empty string');
  }
  // Reject path-traversal attempts.
  const basename = path.basename(slug);
  if (basename !== slug || slug.includes('/') || slug.includes('\\')) {
    throw new Error('invalid slug — must not contain path separators');
  }

  const filepath = _proposedPath(projectRoot, slug);
  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8');
  } catch (err) {
    throw new Error('proposed pattern not found: ' + slug +
      (err && err.code ? ' (' + err.code + ')' : ''));
  }

  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) {
    throw new Error('proposed pattern has no frontmatter: ' + slug);
  }

  return {
    slug,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    filepath,
  };
}

/**
 * Accept a proposed pattern (Layer C review surface — W4 §6.3).
 *
 * Steps:
 *   1. Read .orchestray/proposed-patterns/<slug>.md.
 *   2. Re-run validateProposal() on its frontmatter fields (Layer-C re-check).
 *      If validation fails, return { ok: false, errors, layerBMarkers }.
 *   3. Strip proposed lifecycle fields from frontmatter.
 *   4. Move file to .orchestray/patterns/<slug>.md via atomic rename (EXDEV fallback).
 *   5. Emit `pattern_proposal_accepted` audit event.
 *
 * Returns { ok: true, destPath } on success.
 * Returns { ok: false, errors, layerBMarkers? } on validation failure.
 * Throws on file-system errors (caller should display and exit 1).
 *
 * @param {string} slug
 * @param {string} projectRoot
 * @returns {{ ok: true, destPath: string } | { ok: false, errors: Array, layerBMarkers?: string[] }}
 */
function acceptProposed(slug, projectRoot) {
  const { frontmatter: fm, body, filepath } = readProposed(slug, projectRoot);

  // Collect layer_b_markers for warning display before validation.
  const layerBMarkers = Array.isArray(fm.layer_b_markers) ? fm.layer_b_markers : [];

  // Layer C re-validation: build the proposal object from frontmatter.
  // We pass only the fields the validator knows about (strict mode).
  const proposalObj = {};
  const PROPOSAL_FIELDS = ['name', 'category', 'tip_type', 'confidence', 'description', 'approach', 'evidence_orch_id'];
  for (const field of PROPOSAL_FIELDS) {
    if (fm[field] !== undefined && fm[field] !== null) {
      proposalObj[field] = fm[field];
    }
  }

  const validation = validateProposal(proposalObj);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors, layerBMarkers };
  }

  // Build accepted frontmatter (strip proposed lifecycle fields + PROTECTED_FIELDS).
  // B4-01 fix: PROTECTED_FIELDS are stripped here at Layer C, not just at Layer B.
  // If an attacker-authored proposed file contains e.g. times_applied: 999,
  // it is removed here and an audit event is emitted.
  const { stripped: acceptedFm, removedProtected } = _stripProposedFields(fm);

  // Emit METR-strip audit event if any protected field was removed (evidence of escalation).
  if (removedProtected.length > 0) {
    _emitAudit(projectRoot, {
      type: 'pattern_proposal_metr_strip',
      slug,
      stripped_fields: removedProtected,
    });
  }

  // Add standard pattern fields that may be missing.
  if (acceptedFm.times_applied === undefined) acceptedFm.times_applied = 0;
  if (acceptedFm.last_applied === undefined) acceptedFm.last_applied = null;
  if (acceptedFm.created_from === undefined && fm.proposed_from) {
    acceptedFm.created_from = fm.proposed_from;
  }

  const destPath = _activePath(projectRoot, slug);

  // Write updated content to a tmp file then rename to destination.
  const newContent = frontmatter.stringify({ frontmatter: acceptedFm, body });
  const tmpPath = destPath + '.tmp';
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(tmpPath, newContent, 'utf8');
    try {
      fs.renameSync(tmpPath, destPath);
    } catch (renameErr) {
      if (renameErr && renameErr.code === 'EXDEV') {
        fs.copyFileSync(tmpPath, destPath);
        fs.unlinkSync(tmpPath);
      } else {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
        throw renameErr;
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
    throw err;
  }

  // Remove source file.
  try {
    fs.unlinkSync(filepath);
  } catch (err) {
    // If we can't remove the original, roll back the destination and rethrow.
    try { fs.unlinkSync(destPath); } catch (_) { /* swallow */ }
    throw err;
  }

  // Emit audit event.
  _emitAudit(projectRoot, {
    type: 'pattern_proposal_accepted',
    slug,
    orchestration_id: fm.proposed_from || 'unknown',
    layer_b_marker_count: layerBMarkers.length,
  });

  return { ok: true, destPath };
}

/**
 * Reject a proposed pattern.
 *
 * Steps:
 *   1. Read .orchestray/proposed-patterns/<slug>.md.
 *   2. Move to .orchestray/proposed-patterns/rejected/<slug>.md.
 *   3. Add rejected_at and rejected_reason to the frontmatter.
 *   4. Emit `pattern_proposal_rejected` audit event.
 *
 * Returns { ok: true, rejectedPath } on success.
 * Throws on file-system errors.
 *
 * @param {string} slug
 * @param {string} reason  - Brief reason (≤80 chars). Defaults to 'no_reason_given'.
 * @param {string} projectRoot
 * @returns {{ ok: true, rejectedPath: string }}
 */
function rejectProposed(slug, reason, projectRoot) {
  const { frontmatter: fm, body } = readProposed(slug, projectRoot);

  const safeReason = (typeof reason === 'string' && reason.trim().length > 0)
    ? reason.trim().slice(0, 80)
    : 'no_reason_given';

  const srcPath = _proposedPath(projectRoot, slug);
  const destPath = _rejectedPath(projectRoot, slug);

  // Add rejection metadata to frontmatter.
  const rejectedFm = {
    ...fm,
    rejected_at: new Date().toISOString(),
    rejected_reason: safeReason,
  };

  const newContent = frontmatter.stringify({ frontmatter: rejectedFm, body });
  const tmpPath = destPath + '.tmp';

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(tmpPath, newContent, 'utf8');

  try {
    fs.renameSync(tmpPath, destPath);
  } catch (renameErr) {
    if (renameErr && renameErr.code === 'EXDEV') {
      fs.copyFileSync(tmpPath, destPath);
      fs.unlinkSync(tmpPath);
    } else {
      try { fs.unlinkSync(tmpPath); } catch (_) { /* swallow */ }
      throw renameErr;
    }
  }

  // Remove source.
  try {
    fs.unlinkSync(srcPath);
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch (_) { /* swallow */ }
    throw err;
  }

  // Emit audit event.
  _emitAudit(projectRoot, {
    type: 'pattern_proposal_rejected',
    slug,
    reason: safeReason,
  });

  return { ok: true, rejectedPath: destPath };
}

module.exports = {
  listProposed,
  readProposed,
  acceptProposed,
  rejectProposed,
};
