#!/usr/bin/env node
'use strict';

/**
 * kb-decision-health.js — doctor --json surface for KB decision staleness
 * (P9d).
 *
 * Why this exists
 * ----------------
 * Three files in `.orchestray/kb/decisions/` sat titled `# OPEN: ...` (one
 * `**Status: OPEN, blocking.**`) for hours after the work they described was
 * already fixed. A reader trusting the KB believed three blockers were
 * outstanding. This script makes that drift mechanically detectable instead
 * of relying on a human noticing.
 *
 * Two counts, kept separate on purpose
 * -------------------------------------
 * `openCount` (files whose `**Status:` line says OPEN/BLOCKING) and
 * `withoutStatus` (files with no `**Status:` line at all — most of this
 * corpus predates the convention). Reporting only `openCount === 0` would be
 * indistinguishable from "nothing to see here" when most files are actually
 * unclassifiable. Both numbers travel together always.
 *
 * Status-line convention detected
 * --------------------------------
 * A line starting with `**Status` (bold, case-insensitive), e.g.
 * `**Status: RESOLVED 2026-08-08.**` or `**Status:** design`. This is the
 * convention 8 of 32 files in this repo's real corpus already use (measured
 * 2026-08-08). Anything else — no status line, a plain `Status:`, a
 * differently-worded lead-in like `**Final status:`  — falls into
 * `withoutStatus`. This is intentional: inventing a looser match would
 * misclassify files that were never meant to carry this convention.
 *
 * Title/status contradiction
 * ----------------------------
 * A title starting with `OPEN` whose status says RESOLVED/CLOSED/FIXED/DONE
 * (or the reverse: a RESOLVED/CLOSED title whose status says OPEN/BLOCKING)
 * is self-contradictory — exactly the shape of the drift that prompted this
 * probe. Reported separately in `contradictions[]` so doctor can fail loudly
 * on it rather than folding it into a count.
 *
 * Fail-open contract
 * -------------------
 * Advisory only, like every other doctor probe. Missing directory, unreadable
 * files, or a malformed decision are skipped/zeroed rather than thrown.
 */

const fs = require('fs');
const path = require('path');

const { resolveSafeCwd } = require('./resolve-project-cwd');

// Marker text stops at the first '.', '*', or newline — the rest of the
// line is often free prose ("Reproduced, diagnosed...") that must not leak
// into keyword matching (a stray "done" in unrelated prose was a false
// positive here during testing).
const STATUS_MARKER_RE = /^\*\*Status[:*\s]*([^.*\n]*)/im;
const TITLE_LINE_RE = /^#\s+(.+)$/m;

const OPEN_STATUS_RE = /\b(open|blocking|pending|unresolved)\b/i;
const RESOLVED_STATUS_RE = /\b(resolved|closed|fixed|done|implemented)\b/i;
// "not yet fixed" / "not resolved" must not read as resolved.
const NEGATION_PREFIX_RE = /\bnot\s+(yet\s+)?$/i;

const OPEN_TITLE_RE = /^open\b/i;
const RESOLVED_TITLE_RE = /^(resolved|closed|fixed)\b/i;

/** True if RESOLVED_STATUS_RE matches and the match isn't negated ("not (yet) fixed"). */
function hasResolvedMarker(statusText) {
  const m = RESOLVED_STATUS_RE.exec(statusText);
  if (!m) return false;
  const prefix = statusText.slice(Math.max(0, m.index - 15), m.index);
  return !NEGATION_PREFIX_RE.test(prefix);
}

/**
 * Scan `.orchestray/kb/decisions/*.md` and classify each file.
 *
 * @param {string} cwd project root
 * @returns {{
 *   total: number, withStatus: number, withoutStatus: number,
 *   openCount: number,
 *   openDecisions: Array<{file:string, title:string, statusText:string, ageHours:number}>,
 *   contradictions: Array<{file:string, title:string, statusText:string}>,
 * }}
 */
function scanDecisions(cwd) {
  const EMPTY = { total: 0, withStatus: 0, withoutStatus: 0, openCount: 0, openDecisions: [], contradictions: [] };

  const dir = path.join(cwd, '.orchestray', 'kb', 'decisions');
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (_e) {
    return EMPTY; // no decisions dir yet — nothing to report
  }

  const result = { total: 0, withStatus: 0, withoutStatus: 0, openCount: 0, openDecisions: [], contradictions: [] };
  const nowMs = Date.now();

  for (const name of entries) {
    const filePath = path.join(dir, name);
    let raw;
    let mtimeMs;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
      mtimeMs = fs.statSync(filePath).mtimeMs;
    } catch (_e) {
      continue; // unreadable — skip, don't crash the whole probe
    }

    result.total += 1;

    const titleMatch = raw.match(TITLE_LINE_RE);
    const title = titleMatch ? titleMatch[1].trim() : name;

    const statusMatch = raw.match(STATUS_MARKER_RE);
    if (!statusMatch) {
      result.withoutStatus += 1;
      continue;
    }
    result.withStatus += 1;
    const statusText = statusMatch[1].trim();

    const isOpenStatus = OPEN_STATUS_RE.test(statusText);
    const isResolvedStatus = hasResolvedMarker(statusText);
    const isOpenTitle = OPEN_TITLE_RE.test(title);
    const isResolvedTitle = RESOLVED_TITLE_RE.test(title);

    if (isOpenStatus) {
      result.openCount += 1;
      result.openDecisions.push({
        file: name,
        title,
        statusText,
        ageHours: Math.round(((nowMs - mtimeMs) / 3600000) * 10) / 10,
      });
    }

    const contradicts =
      (isOpenTitle && isResolvedStatus && !isOpenStatus) ||
      (isResolvedTitle && isOpenStatus && !isResolvedStatus);
    if (contradicts) {
      result.contradictions.push({ file: name, title, statusText });
    }
  }

  result.openDecisions.sort((a, b) => b.ageHours - a.ageHours);

  return result;
}

// ---------------------------------------------------------------------------
// --json CLI mode (for /orchestray:doctor)
// ---------------------------------------------------------------------------

function runJsonMode(argv) {
  let cwd = process.cwd();
  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx !== -1 && argv[cwdIdx + 1]) cwd = argv[cwdIdx + 1];
  const result = scanDecisions(resolveSafeCwd(cwd));
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--json')) {
    try {
      runJsonMode(argv);
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
    }
  } else {
    process.stdout.write('kb-decision-health.js: use --json --cwd <path>\n');
  }
}

module.exports = { scanDecisions };
