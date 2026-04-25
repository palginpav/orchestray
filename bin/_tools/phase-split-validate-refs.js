#!/usr/bin/env node
'use strict';

/**
 * phase-split-validate-refs.js — W8 BLOCK gate (W5 F-02 fix, v2.1.15).
 *
 * Reads traceability.json + the actual phase slice files; resolves every
 * outgoing_refs entry to a real heading in the target file.
 *
 * Exit code 0 = 100% references resolve (BLOCK gate satisfied).
 * Exit code non-zero = at least one reference is dead. Prints the failures.
 *
 * The W10 reviewer cites this script's exit code in the Phase 2 audit; this
 * is NOT a 20%-sample audit — it's mechanical and exhaustive.
 *
 * Usage:
 *   node bin/_tools/phase-split-validate-refs.js \
 *     --traceability .orchestray/state/phase-split/traceability.json \
 *     --slices-dir agents/pm-reference \
 *     [--strict-headings]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { traceability: null, slicesDir: null, strictHeadings: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--traceability')       { args.traceability  = argv[++i]; }
    else if (a === '--slices-dir')    { args.slicesDir     = argv[++i]; }
    else if (a === '--strict-headings') { args.strictHeadings = true; }
  }
  return args;
}

/**
 * Extract heading lines from a markdown file.
 * Returns Set of normalized heading texts (lowercased, leading '##' stripped).
 */
function readHeadings(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const headings = new Set();
  for (const line of content.split('\n')) {
    const m = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (!m) continue;
    headings.add(m[1].trim());
    // Also add the bare section number for quick anchor matching.
    const numMatch = m[1].match(/^§?(\d+(?:\.[\dA-Za-z]+)?)/);
    if (numMatch) headings.add(numMatch[1]);
  }
  return headings;
}

/**
 * Check whether a target heading or section-number is present in the
 * extracted headings set. Tolerates "section-13.X" → "13.X" mapping.
 */
function headingResolves(headings, target) {
  if (!headings) return false;
  // Strip "section-" prefix and try direct match.
  const normalized = target.replace(/^section-/, '');
  if (headings.has(normalized)) return true;
  // Try matching by inclusion (heading text containing the section number).
  for (const h of headings) {
    if (h.startsWith(normalized + '.') || h.startsWith(normalized + ' ') ||
        h === normalized || h.startsWith('§' + normalized)) {
      return true;
    }
    // Also match "13. Task Decomposition Protocol" form
    const m = h.match(/^§?(\d+(?:\.[\dA-Za-z]+)?)/);
    if (m && m[1] === normalized) return true;
  }
  return false;
}

function main() {
  const args = parseArgs(process.argv);
  const traceabilityPath = path.resolve(
    args.traceability || '.orchestray/state/phase-split/traceability.json'
  );
  const slicesDir = path.resolve(args.slicesDir || 'agents/pm-reference');

  if (!fs.existsSync(traceabilityPath)) {
    process.stderr.write(`error: traceability.json not found at ${traceabilityPath}\n`);
    process.exit(2);
  }

  const traceability = JSON.parse(fs.readFileSync(traceabilityPath, 'utf8'));

  // Cache headings per file
  const headingsCache = {};
  function getHeadings(file) {
    if (!(file in headingsCache)) {
      headingsCache[file] = readHeadings(path.join(slicesDir, file));
    }
    return headingsCache[file];
  }

  const failures = [];
  let totalChecked = 0;

  // Check section_map outgoing_refs
  for (const sec of traceability.section_map || []) {
    for (const ref of sec.outgoing_refs || []) {
      totalChecked++;
      const [file, anchor] = ref.split('#');
      const headings = getHeadings(file);
      if (!headings) {
        failures.push({
          source_section: sec.source_section,
          ref,
          reason: `target file not found: ${file}`,
        });
        continue;
      }
      const target = (anchor || '').replace(/^#/, '');
      if (!headingResolves(headings, target)) {
        failures.push({
          source_section: sec.source_section,
          ref,
          reason: `heading not present in ${file}`,
        });
      }
    }
  }

  // Check rewritten_references targets
  for (const r of traceability.rewritten_references || []) {
    totalChecked++;
    const headings = getHeadings(r.target_file);
    if (!headings) {
      failures.push({
        source_section: r.source_section,
        ref: r.target_file + '#' + r.target_section,
        reason: `target file not found: ${r.target_file}`,
      });
      continue;
    }
    if (!headingResolves(headings, r.target_section)) {
      failures.push({
        source_section: r.source_section,
        ref: r.target_file + '#' + r.target_section,
        reason: `rewritten ref's target heading not present in ${r.target_file}`,
      });
    }
  }

  const summary = {
    total_checked: totalChecked,
    failures: failures.length,
    pass_rate: totalChecked === 0 ? 1 : (totalChecked - failures.length) / totalChecked,
  };

  if (failures.length > 0) {
    process.stderr.write('phase-split-validate-refs: FAIL\n');
    process.stderr.write(JSON.stringify({ summary, failures: failures.slice(0, 20) }, null, 2) + '\n');
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ summary, status: 'pass' }) + '\n');
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { readHeadings, headingResolves };
