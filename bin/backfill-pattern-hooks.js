#!/usr/bin/env node
'use strict';

/**
 * bin/backfill-pattern-hooks.js (R-CAT v2.1.14)
 *
 * One-time backfill: reads every pattern in .orchestray/patterns/*.md and
 * writes a `context_hook` frontmatter field derived from the first sentence
 * of the `## Context` section (or the first non-empty body line as fallback).
 *
 * Rules:
 *   - Only updates files where `context_hook` is absent or empty.
 *   - Skips patterns where the extracted text is < 5 chars (too short to be useful).
 *   - Writes using frontmatter.rewriteField for atomic, round-trip-safe updates.
 *   - Prints a summary: processed / skipped / errors.
 *
 * Usage:
 *   node bin/backfill-pattern-hooks.js [--dry-run] [--dir <patterns-dir>]
 *
 * Options:
 *   --dry-run    Print what would be written without modifying files.
 *   --dir <d>    Use <d> as the patterns directory (default: .orchestray/patterns/).
 */

const fs   = require('node:fs');
const path = require('node:path');

// Try to load the frontmatter lib from two possible layouts:
//   1. Running from repo root (source / dev)
//   2. Running from installed path
let frontmatter;
try {
  frontmatter = require('./mcp-server/lib/frontmatter');
} catch (_e) {
  try {
    frontmatter = require(path.join(__dirname, 'mcp-server', 'lib', 'frontmatter'));
  } catch (e2) {
    process.stderr.write('backfill-pattern-hooks: cannot load frontmatter lib: ' + e2.message + '\n');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let dryRun = false;
let patternsDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    dryRun = true;
  } else if (args[i] === '--dir' && args[i + 1]) {
    patternsDir = args[++i];
  }
}

if (!patternsDir) {
  // Default: .orchestray/patterns/ relative to cwd.
  patternsDir = path.join(process.cwd(), '.orchestray', 'patterns');
}

// ---------------------------------------------------------------------------
// context_hook extraction
// ---------------------------------------------------------------------------

/**
 * Extract a context_hook string from a parsed pattern body.
 *
 * Strategy (highest-priority first):
 *   1. First sentence of the `## Context` section.
 *   2. First non-empty non-heading line of the body.
 *
 * Returns null when nothing useful can be extracted (< 5 chars).
 *
 * @param {string} body - Pattern body text (after frontmatter).
 * @returns {string|null}
 */
function extractContextHook(body) {
  if (typeof body !== 'string' || body.trim().length === 0) return null;

  // Look for a ## Context section.
  const contextMatch = body.match(/^##\s+Context\s*\n+([\s\S]*?)(?=^##|\Z)/m);
  if (contextMatch) {
    const sectionText = contextMatch[1].trim();
    if (sectionText.length > 0) {
      const hook = _firstSentence(sectionText);
      if (hook && hook.length >= 5) return hook;
    }
  }

  // Fallback: first non-empty, non-heading line of the body.
  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;   // heading
    if (trimmed.startsWith('---')) continue; // delimiter
    if (trimmed.startsWith('```')) continue; // code fence
    if (trimmed.length >= 5) return _cap(trimmed, 160);
  }

  return null;
}

/**
 * Return the first sentence from a text block (up to 160 chars).
 * A sentence ends at '. ', '! ', '? ', or end-of-string after at least 5 chars.
 *
 * @param {string} text
 * @returns {string}
 */
function _firstSentence(text) {
  // Collapse whitespace so multi-line paragraphs work.
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^(.{5,}?[.!?])(?:\s|$)/);
  if (m) return _cap(m[1], 160);
  // No sentence terminator — return up to 160 chars.
  return _cap(flat, 160);
}

function _cap(s, max) {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let mdFiles;
try {
  mdFiles = fs.readdirSync(patternsDir).filter((n) => n.endsWith('.md')).sort();
} catch (err) {
  process.stderr.write(
    'backfill-pattern-hooks: cannot read patterns dir "' + patternsDir + '": ' + err.message + '\n'
  );
  process.exit(1);
}

let processed = 0;
let skipped   = 0;
let errors    = 0;

for (const name of mdFiles) {
  const filepath = path.join(patternsDir, name);
  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8');
  } catch (err) {
    process.stderr.write('backfill-pattern-hooks: read error ' + name + ': ' + err.message + '\n');
    errors++;
    continue;
  }

  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) {
    // No frontmatter — skip (pattern_find already skips these).
    skipped++;
    continue;
  }

  const fm = parsed.frontmatter;

  // Skip if context_hook is already populated with a meaningful value.
  if (typeof fm.context_hook === 'string' && fm.context_hook.trim().length >= 5) {
    skipped++;
    continue;
  }

  const hook = extractContextHook(parsed.body);
  if (!hook) {
    process.stdout.write('SKIP (no extractable context): ' + name + '\n');
    skipped++;
    continue;
  }

  if (dryRun) {
    process.stdout.write('DRY-RUN would write context_hook to ' + name + ':\n  ' + hook + '\n');
    processed++;
    continue;
  }

  const result = frontmatter.rewriteField(filepath, 'context_hook', hook);
  if (!result.ok) {
    process.stderr.write('backfill-pattern-hooks: rewriteField failed for ' + name + ': ' + result.error + '\n');
    errors++;
    continue;
  }

  process.stdout.write('WROTE context_hook: ' + name + '\n  ' + hook + '\n');
  processed++;
}

process.stdout.write(
  '\nbackfill-pattern-hooks: done. ' +
  'processed=' + processed + ' skipped=' + skipped + ' errors=' + errors + '\n'
);
if (errors > 0) process.exit(1);
