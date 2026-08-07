'use strict';

/**
 * pattern-file-resolve.js — three-tier pattern-file resolution shared by the
 * evidence committer, the epoch migration, and the counter-revert CLI.
 *
 * Mirrors the tier order bin/record-pattern-offers.js uses when deciding a
 * slug is offer-eligible (local `.orchestray/patterns` > `.orchestray/team-patterns`
 * > the federation shared dir). RV-1 E6: the committer resolved only the local
 * tier, so every team/shared-tier slug that was legitimately offered emitted a
 * phantom pattern_application_recorded{before:0, after:0} and its counters
 * never moved. Offer-eligible and counter-writable must be the same set.
 *
 * Read-only helpers — callers do their own locking around writes.
 */

const fs   = require('node:fs');
const path = require('node:path');

const paths = require('../mcp-server/lib/paths');

/**
 * Tier dirs in resolution order. Missing dirs are included — callers probe
 * existence per slug.
 *
 * @param {string} cwd project root
 * @returns {Array<{tier: 'local'|'team'|'shared', dir: string}>}
 */
function patternTierDirs(cwd) {
  const dirs = [];
  try { dirs.push({ tier: 'local', dir: paths.getPatternsDir(cwd) }); } catch (_e) { /* ignore */ }
  dirs.push({ tier: 'team', dir: path.join(cwd, '.orchestray', 'team-patterns') });
  try {
    const shared = paths.getSharedPatternsDir();
    if (shared) dirs.push({ tier: 'shared', dir: shared });
  } catch (_e) { /* federation off or unavailable */ }
  return dirs;
}

/** Containment-checked join; null when the slug escapes its tier root. */
function safeJoin(dir, slug) {
  const rootAbs = path.resolve(dir);
  const file = path.resolve(path.join(dir, slug + '.md'));
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) return null;
  return file;
}

/**
 * First existing file for `slug` across the three tiers.
 *
 * @param {string} cwd
 * @param {string} slug
 * @param {string} [preferTier] tier recorded on a journal row — probed first
 *   so a revert restores the same file the commit mutated.
 * @returns {{ file: string, tier: string } | null}
 */
function resolvePatternEntry(cwd, slug, preferTier) {
  try {
    paths.assertSafeSegment(slug);
  } catch (_e) {
    return null;
  }
  const tiers = patternTierDirs(cwd);
  const ordered = preferTier
    ? [...tiers.filter((t) => t.tier === preferTier), ...tiers.filter((t) => t.tier !== preferTier)]
    : tiers;
  for (const { tier, dir } of ordered) {
    const file = safeJoin(dir, slug);
    if (!file) continue;
    try {
      if (fs.existsSync(file)) return { file, tier };
    } catch (_e) { /* unreadable tier — try the next */ }
  }
  return null;
}

/**
 * @param {string} cwd
 * @param {string} slug
 * @param {string} [preferTier]
 * @returns {string|null} absolute path, or null when the slug exists nowhere.
 */
function resolvePatternFile(cwd, slug, preferTier) {
  const entry = resolvePatternEntry(cwd, slug, preferTier);
  return entry ? entry.file : null;
}

/**
 * Every pattern file across the three tiers, deduped by slug with the
 * higher-precedence tier winning — the same file resolvePatternFile would pick.
 *
 * @param {string} cwd
 * @returns {Array<{ slug: string, file: string, tier: string }>}
 */
function listPatternFiles(cwd) {
  const bySlug = new Map();
  for (const { tier, dir } of patternTierDirs(cwd)) {
    let entries;
    try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); }
    catch (_e) { continue; }
    for (const f of entries) {
      const slug = f.slice(0, -3);
      if (bySlug.has(slug)) continue; // earlier tier wins
      const file = safeJoin(dir, slug);
      if (file) bySlug.set(slug, { slug, file, tier });
    }
  }
  return Array.from(bySlug.values());
}

module.exports = { patternTierDirs, resolvePatternEntry, resolvePatternFile, listPatternFiles };
