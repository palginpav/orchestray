'use strict';

/**
 * curator-recently-curated.js — Stamp writer/reader/stripper for the H4
 * `recently_curated_*` frontmatter annotation on pattern files.
 *
 * Design: v2.1.3 Bundle CI (H4), see
 *   .orchestray/kb/decisions/v213-bundle-CI-design.md §4 + §5
 *
 * The stamp is SIX flat dotted-prefix keys appended to existing frontmatter:
 *
 *   recently_curated_at           ISO 8601 UTC timestamp
 *   recently_curated_action       "promote" | "merge" | "deprecate" | "unshare" | "evaluated"
 *   recently_curated_action_id    full action_id from the tombstone (or run_id for "evaluated")
 *   recently_curated_run_id       curator run orch_id
 *   recently_curated_why          first line of rationale.one_line, ≤120 chars
 *   recently_curated_body_sha256  SHA-256 hex of the body (frontmatter-stripped) at stamp time
 *                                 H6 (v2.1.4): used by curate --diff incremental-mode dirty-set
 *
 * The flat-YAML parser (bin/mcp-server/lib/frontmatter.js) does NOT support
 * nested objects — these keys MUST be flat scalars.
 *
 * Semantics:
 *   - REPLACE on re-stamp (§4.4): writeStamp calls stripRecentlyCurated first.
 *   - Strip is idempotent: no-op on files without stamp keys.
 *   - All writes are atomic (tmp + rename).
 *
 * No new npm dependencies — stdlib only.
 */

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAMP_KEYS = [
  'recently_curated_at',
  'recently_curated_action',
  'recently_curated_action_id',
  'recently_curated_run_id',
  'recently_curated_why',
  'recently_curated_body_sha256',   // H6 (v2.1.4): incremental-mode hash
];

const MAX_WHY_LENGTH = 120;

// ---------------------------------------------------------------------------
// Helpers: lazy-require frontmatter module (avoids circular deps at load time)
// ---------------------------------------------------------------------------

function _fm() {
  return require('../mcp-server/lib/frontmatter.js');
}

// ---------------------------------------------------------------------------
// `why` field normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise the `why` value for frontmatter storage:
 * - Take only the first line.
 * - Truncate to MAX_WHY_LENGTH characters (append "..." if truncated).
 * - Strip trailing whitespace.
 *
 * @param {string} raw
 * @returns {string}
 */
function normaliseWhy(raw) {
  if (typeof raw !== 'string') raw = String(raw || '');
  // First line only (handles CRLF and LF).
  const firstLine = raw.split(/\r?\n/)[0] || '';
  const trimmed   = firstLine.trimEnd();
  if (trimmed.length <= MAX_WHY_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_WHY_LENGTH) + '...';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write (or overwrite) the 6-key `recently_curated_*` stamp on a pattern file.
 *
 * Internally calls stripRecentlyCurated first to enforce REPLACE semantics
 * (§4.4): only the most-recent curator touch is preserved.
 *
 * @param {string} absPath
 * @param {{
 *   at:          string,   // ISO 8601 UTC
 *   action:      "promote"|"merge"|"deprecate"|"unshare"|"evaluated",
 *   action_id:   string,
 *   run_id:      string,
 *   why:         string,   // will be normalised to ≤120 chars, first line
 *   body_sha256: string,   // H6 (v2.1.4): SHA-256 hex of the body at stamp time
 * }} stamp
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function writeStamp(absPath, stamp) {
  try {
    if (!absPath || typeof absPath !== 'string') {
      return { ok: false, error: 'absPath must be a non-empty string' };
    }
    if (!stamp || typeof stamp !== 'object') {
      return { ok: false, error: 'stamp must be an object' };
    }

    // Step 1: read the file.
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      return { ok: false, error: (err && err.code) || 'read_failed' };
    }

    // Step 2: parse.
    const fm = _fm();
    const parsed = fm.parse(content);
    if (!parsed.hasFrontmatter) {
      return { ok: false, error: 'no_frontmatter' };
    }

    // Step 3: REPLACE semantics — remove existing stamp keys first.
    const newFm = Object.assign({}, parsed.frontmatter);
    for (const k of STAMP_KEYS) {
      delete newFm[k];
    }

    // Step 4: append the 6 stamp keys (after all existing fields).
    newFm.recently_curated_at           = String(stamp.at || '');
    newFm.recently_curated_action       = String(stamp.action || '');
    newFm.recently_curated_action_id    = String(stamp.action_id || '');
    newFm.recently_curated_run_id       = String(stamp.run_id || '');
    newFm.recently_curated_why          = normaliseWhy(stamp.why || '');
    newFm.recently_curated_body_sha256  = String(stamp.body_sha256 || '');

    // Step 5: stringify and write atomically.
    const next = fm.stringify({ frontmatter: newFm, body: parsed.body });
    const tmp  = absPath + '.stamp.tmp';
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, absPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return { ok: false, error: (err && err.code) || 'write_failed' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'unexpected_error' };
  }
}

/**
 * Read the stamp from a pattern file.
 * Returns null if the file has no stamp keys (pre-v2.1.3 pattern or not stamped).
 *
 * @param {string} absPath
 * @returns {{
 *   at:          string,
 *   action:      string,
 *   action_id:   string,
 *   run_id:      string,
 *   why:         string,
 *   body_sha256: string|null,  // H6 (v2.1.4): null on pre-v2.1.4 stamps
 * } | null}
 */
function readStamp(absPath) {
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    const fm = _fm();
    const parsed = fm.parse(content);
    if (!parsed.hasFrontmatter) return null;

    const f = parsed.frontmatter;
    // Only return a stamp if at least the primary key is present.
    if (!f.recently_curated_at && !f.recently_curated_action_id) return null;

    return {
      at:          f.recently_curated_at          != null ? String(f.recently_curated_at)          : null,
      action:      f.recently_curated_action      != null ? String(f.recently_curated_action)      : null,
      action_id:   f.recently_curated_action_id   != null ? String(f.recently_curated_action_id)   : null,
      run_id:      f.recently_curated_run_id      != null ? String(f.recently_curated_run_id)      : null,
      why:         f.recently_curated_why         != null ? String(f.recently_curated_why)         : null,
      body_sha256: f.recently_curated_body_sha256 != null ? String(f.recently_curated_body_sha256) : null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Remove all 5 stamp keys from the pattern file. Idempotent.
 *
 * @param {string} absPath
 * @returns {boolean} true if any key was present and removed, false otherwise.
 */
function stripRecentlyCurated(absPath) {
  try {
    let content;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch (err) {
      // File missing or unreadable — nothing to strip.
      return false;
    }

    const fm = _fm();
    const parsed = fm.parse(content);
    if (!parsed.hasFrontmatter) return false;

    // Check if any stamp key is present.
    const hasSomeKey = STAMP_KEYS.some(k => parsed.frontmatter[k] != null);
    if (!hasSomeKey) return false;

    // Build new frontmatter without stamp keys.
    const newFm = Object.assign({}, parsed.frontmatter);
    for (const k of STAMP_KEYS) {
      delete newFm[k];
    }

    // Stringify and write atomically.
    const next = fm.stringify({ frontmatter: newFm, body: parsed.body });
    const tmp  = absPath + '.strip.tmp';
    try {
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, absPath);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return false;
    }

    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Apply recently_curated_* stamps to every pattern touched in `runId`.
 * Reads tombstones for the run, resolves the pattern file for each action per
 * §4.5, calls writeStamp(). Non-fatal on individual failures: logs a journal
 * entry (kind 'curator_stamp_apply_failed') and continues.
 *
 * Stamp-apply table (§4.5):
 *   promote   → .orchestray/patterns/{inputs[0].slug}.md
 *   merge     → .orchestray/patterns/{inputs[0].slug}.md  (lead / surviving pattern)
 *   deprecate → .orchestray/patterns/{inputs[0].slug}.md  (still present, deprecated: true)
 *   unshare   → SKIP (no local stamp)
 *   rolled-back rows → SKIP
 *
 * H6 (v2.1.4) extensions:
 *   - body_sha256 is now computed and written on every stamp.
 *   - If options.evaluatedSlugs is provided, patterns in that list that were NOT
 *     already stamped by a tombstone action receive an action: "evaluated" stamp.
 *     This ensures the next --diff run sees them as clean (not stamp-absent).
 *
 * @param {string} runId
 * @param {{
 *   projectRoot?:    string,
 *   evaluatedSlugs?: string[],  // H6: slugs the curator evaluated but did not act on
 * }} [options]
 * @returns {{ stamped: string[], skipped: string[], failed: Array<{action_id: string, slug: string, error: string}> }}
 */
function applyStampsForRun(runId, options) {
  const stamped  = [];
  const skipped  = [];
  const failed   = [];

  if (!runId || typeof runId !== 'string') {
    return { stamped, skipped, failed };
  }

  // Lazy-require to avoid circular deps.
  let listTombstones;
  try {
    listTombstones = require('./curator-tombstone.js').listTombstones;
  } catch (err) {
    return { stamped, skipped, failed };
  }

  let recordDegradation;
  try {
    recordDegradation = require('./degraded-journal.js').recordDegradation;
  } catch (_) {
    recordDegradation = null;
  }

  let computeBodyHash;
  try {
    computeBodyHash = require('./curator-diff.js').computeBodyHash;
  } catch (_) {
    computeBodyHash = null;
  }

  const projectRoot = (options && options.projectRoot) || process.cwd();
  const patternsDir = path.join(projectRoot, '.orchestray', 'patterns');

  // Resolve a slug to its on-disk file. Pattern files are named
  // `{category}-{slug}.md` in the current corpus convention; older patterns
  // were named bare `{slug}.md`. Prefer an exact match first, then scan for
  // any `*-{slug}.md` suffix. Returns the direct slug-only path on miss so
  // the downstream ENOENT message stays predictable.
  function resolvePatternPath(slug) {
    const direct = path.join(patternsDir, slug + '.md');
    if (fs.existsSync(direct)) return direct;
    try {
      const suffix = '-' + slug + '.md';
      const match = fs.readdirSync(patternsDir).find(f => f.endsWith(suffix));
      if (match) return path.join(patternsDir, match);
    } catch (_) {}
    return direct;
  }

  let rows;
  try {
    const result = listTombstones({ only_run_id: runId, projectRoot, include_archive: false });
    rows = result.rows;
  } catch (err) {
    return { stamped, skipped, failed };
  }

  // Track which slugs were stamped by tombstone actions (for the evaluated-slug pass).
  const tombstoneSlugs = new Set();

  for (const t of rows) {
    const actionId = t.action_id || '?';

    // Skip rolled-back tombstones.
    if (t.rolled_back_at) {
      skipped.push(actionId);
      continue;
    }

    // Skip unshare — no local stamp per §4.5.
    if (t.action === 'unshare') {
      skipped.push(actionId);
      continue;
    }

    // Only stamp promote / merge / deprecate.
    if (t.action !== 'promote' && t.action !== 'merge' && t.action !== 'deprecate') {
      skipped.push(actionId);
      continue;
    }

    // Resolve slug: use inputs[0].slug (lead/surviving pattern for merge, local for others).
    const slug = t.inputs && t.inputs[0] && t.inputs[0].slug;
    if (!slug) {
      skipped.push(actionId);
      continue;
    }

    // Prefer the tombstone's recorded path (always present in v2.1.0+ writes
    // and authoritative for the actual filename, which carries a category prefix).
    // Honour absolute paths verbatim; resolve project-relative paths against
    // projectRoot. Fall back to the slug-suffix resolver if no path was recorded.
    const inputPath = t.inputs && t.inputs[0] && t.inputs[0].path;
    let absPath;
    if (inputPath) {
      absPath = path.isAbsolute(inputPath) ? inputPath : path.join(projectRoot, inputPath);
    } else {
      absPath = resolvePatternPath(slug);
    }

    // Compute body hash for this pattern file (H6).
    let bodyHash = '';
    if (computeBodyHash) {
      try {
        bodyHash = computeBodyHash(absPath) || '';
      } catch (_) {}
    }

    const stamp = {
      at:          t.ts || new Date().toISOString(),
      action:      t.action,
      action_id:   actionId,
      run_id:      runId,
      why:         (t.rationale && t.rationale.one_line) || t.output && t.output.action_summary || '',
      body_sha256: bodyHash,
    };

    const result = writeStamp(absPath, stamp);
    if (result.ok) {
      stamped.push(actionId);
      tombstoneSlugs.add(slug);
    } else {
      failed.push({ action_id: actionId, slug, error: result.error });
      if (recordDegradation) {
        try {
          recordDegradation({
            kind:        'curator_stamp_apply_failed',
            detail:      { action_id: actionId, slug, error: result.error, run_id: runId },
            projectRoot,
          });
        } catch (_) {}
      }
    }
  }

  // H6: second pass — stamp evaluated-but-no-op patterns with action: "evaluated".
  // These are patterns the curator reasoned over but did not promote / merge / deprecate.
  // Writing this stamp prevents the next --diff run from seeing them as stamp-absent.
  const evaluatedSlugs = options && Array.isArray(options.evaluatedSlugs)
    ? options.evaluatedSlugs
    : [];

  for (const slug of evaluatedSlugs) {
    if (tombstoneSlugs.has(slug)) {
      // Already stamped by a tombstone action — skip the evaluated stamp.
      skipped.push('evaluated:' + slug);
      continue;
    }

    const absPath = resolvePatternPath(slug);

    let bodyHash = '';
    if (computeBodyHash) {
      try {
        bodyHash = computeBodyHash(absPath) || '';
      } catch (_) {}
    }

    const stamp = {
      at:          new Date().toISOString(),
      action:      'evaluated',
      action_id:   runId,   // No tombstone action_id for evaluated; use run_id.
      run_id:      runId,
      why:         'no-op',
      body_sha256: bodyHash,
    };

    const evalResult = writeStamp(absPath, stamp);
    if (evalResult.ok) {
      stamped.push('evaluated:' + slug);
    } else {
      failed.push({ action_id: 'evaluated:' + slug, slug, error: evalResult.error });
      if (recordDegradation) {
        try {
          recordDegradation({
            kind:        'curator_stamp_apply_failed',
            detail:      { action_id: 'evaluated:' + slug, slug, error: evalResult.error, run_id: runId },
            projectRoot,
          });
        } catch (_) {}
      }
    }
  }

  return { stamped, skipped, failed };
}

module.exports = {
  writeStamp,
  readStamp,
  stripRecentlyCurated,
  applyStampsForRun,
  // Exported for tests.
  _internal: {
    normaliseWhy,
    STAMP_KEYS,
    MAX_WHY_LENGTH,
  },
};
