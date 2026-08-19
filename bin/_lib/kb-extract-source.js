'use strict';

/**
 * kb-extract-source.js — kb/-sourced pattern extraction, keyed on time not
 * orchestration_id (v2.3.30, Recommendation 2 of
 * .orchestray/kb/artifacts/v2330-learn-extraction-diagnosis.md).
 *
 * Both existing extraction paths (manual `/orchestray:learn` and the two
 * auto hooks) read exclusively from `.orchestray/history/` or
 * `.orchestray/audit/current-orchestration.json`. Neither exists for
 * direct-spawn / Simple-Task-Path work (agents/pm.md §Simple Task Path),
 * so lessons written to `.orchestray/kb/{facts,decisions,artifacts}/` are
 * structurally invisible to extraction (diagnosis F1/F2).
 *
 * `.orchestray/kb/index.json` entries carry no `orchestration_id` (F2), and
 * per the same diagnosis the index itself can drift from the filesystem
 * (see bin/mcp-server/tools/kb_write.js's own "index drift" note). So this
 * module reads `.orchestray/kb/{facts,decisions,artifacts}/*.md` directly
 * (same precedent as bin/mcp-server/tools/kb_search.js) and uses on-disk
 * file mtime as the "created_at" signal — the one thing that cannot drift
 * from what's actually on disk.
 *
 * Join key: a "since last learn run" timestamp, stored the same way the
 * curator's run-counter stamp is stored (small JSON state file, tmp+rename
 * atomic write) — see bin/_lib/curator-diff.js's incrementRunCounter().
 *
 * Scope boundary (per diagnosis Recommendation 2): kb entries are
 * per-agent findings, not per-orchestration audit trails. They carry
 * enough signal for `anti-pattern`, `user-correction`, and `specialization`
 * proposals. They do NOT carry task-graph.md or routing_outcome data, so
 * `decomposition` and `routing` proposals are never derived here — this
 * module has no code path that produces those two categories.
 *
 * No new npm dependencies — stdlib only.
 */

const fs   = require('node:fs');
const path = require('node:path');

const KB_BUCKETS = ['facts', 'decisions', 'artifacts'];

const STAMP_REL_PATH = path.join('.orchestray', 'state', 'kb-extract-last-run.json');

// Provenance marker written to every kb-sourced proposal's evidence_orch_id
// (must match ORCH_ID_REGEX /^orch-[a-z0-9-]+$/ in proposal-validator.js).
// The `kb-` infix is the visible, grep-able distinction from a real
// history-sourced orchestration id (shaped `orch-<uuid-or-slug>`) — same
// design as the `backfill-` prefix bin/_lib/curator-recently-curated.js
// uses to keep fabricated stamps from ever colliding with real ones.
const KB_EVIDENCE_ID_PREFIX = 'orch-kb-';

const NAME_MAX = 64;

// ---------------------------------------------------------------------------
// Lazy requires (avoid circular deps / load-order issues)
// ---------------------------------------------------------------------------

function _fm() {
  return require('../mcp-server/lib/frontmatter.js');
}

// ---------------------------------------------------------------------------
// Last-run stamp (join key)
// ---------------------------------------------------------------------------

function getStampPath(projectRoot) {
  return path.join(projectRoot, STAMP_REL_PATH);
}

/**
 * @param {string} projectRoot
 * @returns {string|null} ISO 8601 timestamp of the last completed kb-extract
 *   run, or null if this is the first run (or the stamp is missing/corrupt —
 *   treated as "scan everything", never as "scan nothing").
 */
function readLastRunStamp(projectRoot) {
  try {
    const raw  = fs.readFileSync(getStampPath(projectRoot), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.last_run_at === 'string' && data.last_run_at) {
      return data.last_run_at;
    }
  } catch (_e) {
    // Missing or corrupt — treat as first run.
  }
  return null;
}

/**
 * Atomically stamp "now" (or a caller-supplied ISO timestamp) as the last
 * completed kb-extract run. tmp+rename, fail-open on write error.
 *
 * @param {string} projectRoot
 * @param {string} [isoString] defaults to new Date().toISOString()
 * @returns {boolean} true on successful write
 */
function writeLastRunStamp(projectRoot, isoString) {
  const stampPath = getStampPath(projectRoot);
  const at = isoString || new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
  } catch (_e) { /* fall through to write attempt */ }
  const tmp = stampPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ last_run_at: at }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, stampPath);
    return true;
  } catch (_e) {
    try { fs.unlinkSync(tmp); } catch (_e2) {}
    return false;
  }
}

// ---------------------------------------------------------------------------
// kb/ collection
// ---------------------------------------------------------------------------

/**
 * Scan `.orchestray/kb/{facts,decisions,artifacts}/*.md` directly (bypasses
 * index.json — see module docstring) and return entries whose file mtime is
 * strictly newer than `sinceIso`. `sinceIso === null` returns every entry
 * (first run).
 *
 * @param {string} projectRoot
 * @param {string|null} sinceIso
 * @returns {Array<{
 *   slug: string, bucket: string, absPath: string, relPath: string,
 *   mtimeIso: string, frontmatter: object, body: string, title: string,
 * }>} sorted oldest-mtime-first
 */
function collectKbEntriesSince(projectRoot, sinceIso) {
  const kbDir  = path.join(projectRoot, '.orchestray', 'kb');
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const hasSince = sinceIso != null && !Number.isNaN(sinceMs);
  const out = [];

  for (const bucket of KB_BUCKETS) {
    const dir = path.join(kbDir, bucket);
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch (_e) {
      continue; // bucket dir absent — nothing to scan
    }

    for (const name of files) {
      const absPath = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(absPath);
      } catch (_e) {
        continue;
      }
      if (hasSince && stat.mtimeMs <= sinceMs) continue;

      let content;
      try {
        content = fs.readFileSync(absPath, 'utf8');
      } catch (_e) {
        continue;
      }

      let frontmatter = {};
      let body = content;
      try {
        const parsed = _fm().parse(content);
        if (parsed.hasFrontmatter) {
          frontmatter = parsed.frontmatter || {};
          body = parsed.body || '';
        }
      } catch (_e) {
        // Unparseable frontmatter — fall back to raw content as body.
      }

      const slug = name.slice(0, -3);
      const h1Match = body.match(/^#\s+(.+)$/m);
      const title = (h1Match && h1Match[1].trim())
        || (typeof frontmatter.title === 'string' && frontmatter.title)
        || slug;

      out.push({
        slug,
        bucket,
        absPath,
        relPath: path.relative(projectRoot, absPath).replace(/\\/g, '/'),
        mtimeIso: new Date(stat.mtimeMs).toISOString(),
        frontmatter,
        body,
        title,
      });
    }
  }

  out.sort((a, b) => (a.mtimeIso < b.mtimeIso ? -1 : a.mtimeIso > b.mtimeIso ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Category derivation — anti-pattern | user-correction | specialization ONLY
// ---------------------------------------------------------------------------
//
// kb entries carry no task-graph/routing data (diagnosis F2 structural
// finding), so `decomposition` and `routing` are never candidates here —
// there is no keyword list for them below, by design, not by omission.

const CATEGORY_KEYWORDS = {
  'anti-pattern': [
    'anti-pattern', 'antipattern', 'landmine', 'gotcha', 'pitfall',
    'never do', 'do not ', "don't ", 'avoid ', 'regression', 'root cause',
    'mistake', 'footgun',
  ],
  'user-correction': [
    'user corrected', 'user said', 'user pushback', 'user preference',
    'user explicitly', 'reporter', "user's own", 'user feedback',
    'user asked', 'user rejected', 'corrected the approach',
  ],
  'specialization': [
    'specialist', 'specialization', 'model routing', 'route to',
    'delegate to', 'agent role', 'best suited', 'assign to',
  ],
};

/**
 * @param {{title: string, frontmatter: object, body: string}} entry
 * @returns {'anti-pattern'|'user-correction'|'specialization'|null}
 *   null means "no confident category match" — the caller must skip the
 *   entry rather than fabricate a category (correctness-3).
 */
function deriveCategoryForEntry(entry) {
  const topic = (entry.frontmatter && typeof entry.frontmatter.topic === 'string')
    ? entry.frontmatter.topic
    : '';
  const haystack = [entry.title, topic, (entry.body || '').slice(0, 4000)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  let best = null;
  let bestScore = 0;
  for (const category of Object.keys(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of CATEGORY_KEYWORDS[category]) {
      if (haystack.includes(kw)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return bestScore > 0 ? best : null;
}

// ---------------------------------------------------------------------------
// Proposal construction
// ---------------------------------------------------------------------------

function _collapseWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function _truncate(s, min, max) {
  let out = _collapseWhitespace(s);
  if (out.length > max) out = out.slice(0, max);
  if (out.length < min) out = out.padEnd(min, '.');
  return out;
}

/** First non-empty, non-heading paragraph in a kb body — used as `approach`. */
function _firstParagraph(body) {
  const lines = String(body || '').split(/\r?\n/);
  const buf = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (buf.length) break;
      continue;
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    buf.push(trimmed);
  }
  return buf.join(' ');
}

function _slugSafeName(rawSlug) {
  let s = String(rawSlug || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // `kb-` prefix: visible provenance marker on the proposal's own name/slug,
  // in addition to the `provenance` frontmatter field (see buildKbProposal).
  const prefixed = 'kb-' + s;
  return prefixed.slice(0, NAME_MAX).replace(/-+$/g, '') || 'kb-entry';
}

/**
 * Build a validator-shaped proposal object from a kb entry + derived category.
 * Caller is responsible for running it through
 * `require('./proposal-validator').validateProposal()` before writing.
 *
 * @param {object} entry   see collectKbEntriesSince()
 * @param {string} category
 * @returns {object} proposal (name, category, confidence, description, approach, evidence_orch_id)
 */
function buildProposalFromKbEntry(entry, category) {
  const topic = (entry.frontmatter && typeof entry.frontmatter.topic === 'string')
    ? entry.frontmatter.topic
    : '';
  const description = _truncate(topic || entry.title, 10, 200);
  const approach = _truncate(_firstParagraph(entry.body) || entry.title, 20, 2000);

  // Deterministic, collision-resistant date-only stamp — visibly distinct
  // from a real orchestration id (`orch-<uuid-or-descriptive-slug>`).
  const datePart = entry.mtimeIso.slice(0, 10).replace(/-/g, '');

  return {
    name: _slugSafeName(entry.slug),
    category,
    confidence: 0.4, // conservative, within validator's [0.3, 0.7] band
    description,
    approach,
    evidence_orch_id: KB_EVIDENCE_ID_PREFIX + datePart,
  };
}

// ---------------------------------------------------------------------------
// Proposal file content (frontmatter) — kb-sourced provenance
// ---------------------------------------------------------------------------

/**
 * Build the frontmatter + body for a kb-sourced proposal file.
 *
 * Mirrors `_buildProposalContent()` in bin/post-orchestration-extract.js
 * (same schema_version: 2 shape) with two additions that make provenance
 * unambiguous:
 *   - `provenance: kb`            (history-sourced proposals carry `provenance: history`)
 *   - `kb_source_path` / `kb_source_bucket`   traceability back to the kb file
 *
 * @param {object} proposal  see buildProposalFromKbEntry()
 * @param {object} entry     see collectKbEntriesSince()
 * @returns {string}
 */
function buildKbProposalContent(proposal, entry) {
  const now = new Date().toISOString();
  const fm = [
    '---',
    `name: ${proposal.name}`,
    `category: ${proposal.category}`,
    `confidence: ${proposal.confidence}`,
    `description: ${JSON.stringify(proposal.description)}`,
    `approach: ${JSON.stringify(proposal.approach)}`,
    `evidence_orch_id: ${proposal.evidence_orch_id}`,
    `proposed: true`,
    `proposed_at: ${now}`,
    `proposed_from: ${proposal.evidence_orch_id}`,
    `provenance: kb`,
    `kb_source_path: ${entry.relPath}`,
    `kb_source_bucket: ${entry.bucket}`,
    `schema_version: 2`,
    `layer_b_markers: []`,
    '---',
    '',
  ].join('\n');
  return fm;
}

module.exports = {
  KB_BUCKETS,
  KB_EVIDENCE_ID_PREFIX,
  STAMP_REL_PATH,
  getStampPath,
  readLastRunStamp,
  writeLastRunStamp,
  collectKbEntriesSince,
  deriveCategoryForEntry,
  buildProposalFromKbEntry,
  buildKbProposalContent,
  // Exported for tests.
  _internal: { CATEGORY_KEYWORDS, _slugSafeName, _truncate, _firstParagraph },
};
