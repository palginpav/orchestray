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
 * v2.2.21 G3-W3-T9 extension: when `--scan-pm` is passed, ALSO scan
 * `agents/pm.md` for inline cross-references of the form
 *   "Section N (in <file>.md)"  /  "Section N, in <file>.md"
 * and verify the heading exists in the target file. The same heading-resolver
 * used for traceability is reused. This catches the cross-reference rot
 * cataloged in v2.2.21 T1 (E-CO-1 through E-CO-3) without requiring the rot
 * to be authored into traceability.json first.
 *
 * Usage:
 *   node bin/_tools/phase-split-validate-refs.js \
 *     --traceability .orchestray/state/phase-split/traceability.json \
 *     --slices-dir agents/pm-reference \
 *     [--strict-headings] [--scan-pm] [--pm-path agents/pm.md]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    traceability: null,
    slicesDir: null,
    strictHeadings: false,
    scanPm: false,
    pmPath: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--traceability')         { args.traceability  = argv[++i]; }
    else if (a === '--slices-dir')      { args.slicesDir     = argv[++i]; }
    else if (a === '--strict-headings') { args.strictHeadings = true; }
    else if (a === '--scan-pm')         { args.scanPm = true; }
    else if (a === '--pm-path')         { args.pmPath = argv[++i]; }
  }
  return args;
}

/**
 * Scan pm.md (or any markdown body) for inline section cross-references and
 * verify each anchor resolves in the named target file.
 *
 * Recognized forms (covers both pointer styles flagged by W-CO-4):
 *   - "Section 14 (in phase-execute.md)"
 *   - "Section 14, in phase-execute.md"
 *   - "Section 14 (Parallel Execution Protocol, in phase-execute.md)"
 *   - "Section 24 (in security-integration.md)"
 *
 * Returns an array of failure objects: `{line, ref, reason}`. Empty array
 * means every reference resolves.
 */
function scanInlineSectionRefs(pmContent, slicesDir, getHeadingsForFile) {
  const failures = [];
  // Match "Section <num>(.alpha)?" followed by an "in <file>.md" clause.
  // Group 1 = section number/letter, Group 2 = target filename.
  const RE = /Section\s+(\d+(?:\.[\dA-Za-z]+)?[a-z]?)\s*[(,][^()]*?in\s+([A-Za-z][A-Za-z0-9_-]*\.md)\b/g;
  const lines = pmContent.split('\n');
  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(line)) !== null) {
      const sectionNum = m[1];
      const targetFile = m[2];
      const headings = getHeadingsForFile(targetFile);
      if (!headings) {
        failures.push({
          line: lineNum + 1,
          ref: `Section ${sectionNum} (in ${targetFile})`,
          reason: `target file not found in slices dir`,
        });
        continue;
      }
      if (!headingResolves(headings, sectionNum)) {
        failures.push({
          line: lineNum + 1,
          ref: `Section ${sectionNum} (in ${targetFile})`,
          reason: `heading not present in ${targetFile}`,
        });
      }
    }
  }
  return failures;
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
    // Match BOTH `13.X` (period suffix) and `40b` / `22a` (alpha suffix) forms.
    const numMatch = m[1].match(/^§?(\d+(?:\.[\dA-Za-z]+)?[a-z]?)/);
    if (numMatch) headings.add(numMatch[1]);
    // Also strip a "Section N:" prefix so input "43" resolves against
    // "## Section 43: Friction Detection..." headings.
    const sectionMatch = m[1].match(/^Section\s+(\d+(?:\.[\dA-Za-z]+)?[a-z]?):/);
    if (sectionMatch) headings.add(sectionMatch[1]);
  }
  return headings;
}

/**
 * Check whether a target heading or section-number is present in the
 * extracted headings set. Tolerates "section-13.X" → "13.X" mapping
 * AND alphanumeric suffixes like "40b", "22a", "43c" so headings of the
 * form `## 40b: Thread Matching` resolve when the cross-ref says
 * `Section 40b (in orchestration-threads.md)`.
 */
function headingResolves(headings, target) {
  if (!headings) return false;
  // Strip "section-" prefix and try direct match.
  const normalized = target.replace(/^section-/, '');
  if (headings.has(normalized)) return true;
  // Try matching by inclusion (heading text containing the section number).
  for (const h of headings) {
    if (h.startsWith(normalized + '.') || h.startsWith(normalized + ' ') ||
        h.startsWith(normalized + ':') || h.startsWith(normalized + ',') ||
        h === normalized || h.startsWith('§' + normalized) ||
        h.startsWith('Section ' + normalized + ':') ||
        h.startsWith('Section ' + normalized + ' ')) {
      return true;
    }
    // Also match "13. Task Decomposition Protocol" form OR "40b: Thread Matching".
    const m = h.match(/^§?(\d+(?:\.[\dA-Za-z]+)?[a-z]?)/);
    if (m && m[1] === normalized) return true;
  }
  return false;
}

function main() {
  const args = parseArgs(process.argv);
  const slicesDir = path.resolve(args.slicesDir || 'agents/pm-reference');

  // Cache headings per file
  const headingsCache = {};
  function getHeadings(file) {
    if (!(file in headingsCache)) {
      headingsCache[file] = readHeadings(path.join(slicesDir, file));
    }
    return headingsCache[file];
  }

  // --scan-pm: standalone mode. Scan agents/pm.md (or --pm-path) for inline
  // "Section N (in <file>.md)" cross-references. Skips the traceability check
  // entirely so the gate can run when traceability.json is absent. Combine
  // with the default mode by running the script twice in CI.
  if (args.scanPm) {
    const pmPath = path.resolve(args.pmPath || 'agents/pm.md');
    if (!fs.existsSync(pmPath)) {
      process.stderr.write(`error: pm.md not found at ${pmPath}\n`);
      process.exit(2);
    }
    const pmContent = fs.readFileSync(pmPath, 'utf8');
    const inlineFailures = scanInlineSectionRefs(pmContent, slicesDir, getHeadings);
    const summary = {
      mode: 'scan-pm',
      pm_path: pmPath,
      total_failures: inlineFailures.length,
    };
    if (inlineFailures.length > 0) {
      process.stderr.write('phase-split-validate-refs (scan-pm): FAIL\n');
      process.stderr.write(JSON.stringify({ summary, failures: inlineFailures.slice(0, 50) }, null, 2) + '\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ summary, status: 'pass' }) + '\n');
    process.exit(0);
  }

  const traceabilityPath = path.resolve(
    args.traceability || '.orchestray/state/phase-split/traceability.json'
  );

  if (!fs.existsSync(traceabilityPath)) {
    process.stderr.write(`error: traceability.json not found at ${traceabilityPath}\n`);
    process.exit(2);
  }

  const traceability = JSON.parse(fs.readFileSync(traceabilityPath, 'utf8'));

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

module.exports = { readHeadings, headingResolves, scanInlineSectionRefs };
