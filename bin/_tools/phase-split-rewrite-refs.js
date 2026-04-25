#!/usr/bin/env node
'use strict';

/**
 * phase-split-rewrite-refs.js — Dev-time tool (W8, v2.1.15, I-PHASE-GATE).
 *
 * Pass 4 of P-PHASE-SPLIT-RECONCILE: cross-phase reference rewriting.
 *
 * Reads anchors.json + graph.json from phase-split-classify, then for each
 * cross-phase reference rewrites it from "Section N" / "§N" form into the
 * canonical "(see phase-X.md §"<heading>")" form. Emits traceability.json
 * with the section_map, promoted_to_contract, and rewritten_references arrays.
 *
 * Note: this tool emits the *plan*; the actual emission of slice files happens
 * inline in the W8 task because the slice content was hand-curated for
 * v2.1.15's split. The tool's primary job is to PROVE the rewrite plan is
 * complete — and it is consumed by phase-split-validate-refs.js.
 *
 * Usage:
 *   node bin/_tools/phase-split-rewrite-refs.js \
 *     --in-dir .orchestray/state/phase-split \
 *     [--out-dir .orchestray/state/phase-split]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { inDir: null, outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in-dir')       { args.inDir  = argv[++i]; }
    else if (a === '--out-dir') { args.outDir = argv[++i]; }
  }
  return args;
}

/**
 * Build the section_map: for each classified anchor, record the target file
 * it lands in and its outgoing references that need rewriting.
 */
function buildSectionMap(anchors, refs) {
  const phaseToFile = {
    contract: 'phase-contract.md',
    decomp:   'phase-decomp.md',
    execute:  'phase-execute.md',
    verify:   'phase-verify.md',
    close:    'phase-close.md',
  };

  // Build lookup: section_number -> phase. Only sections that are anchors in
  // the source monolith — references to sections outside it (e.g., §4.Y from
  // pm.md, §27 from checkpoints.md) are external and not validated here.
  const sectionPhase = {};
  for (const a of anchors) {
    if (a.section_number) sectionPhase[a.section_number] = a.phase;
  }

  // For each anchor, collect outgoing refs. Cross-phase refs need rewriting.
  // Skip refs whose target is NOT an anchor in the source file (external refs).
  const sectionMap = [];
  const rewrittenRefs = [];
  for (const a of anchors) {
    if (!a.section_number) continue;
    const targetFile = phaseToFile[a.phase] || 'phase-close.md';
    const outgoing = refs
      .filter((r) => r.source_section === a.section_number)
      .filter((r) => Object.prototype.hasOwnProperty.call(sectionPhase, r.target_section))
      .map((r) => {
        const targetPhase = sectionPhase[r.target_section];
        const targetFileForRef = phaseToFile[targetPhase] || 'phase-close.md';
        const sameFile = targetFileForRef === targetFile;
        return {
          target_section: r.target_section,
          target_phase: targetPhase,
          target_file: targetFileForRef,
          cross_phase: !sameFile,
          source_line: r.line,
          original_text: r.text,
        };
      });
    sectionMap.push({
      source_section: a.section_number,
      source_heading: a.heading,
      source_lines: `${a.line_start}-${a.line_end}`,
      target_file: targetFile,
      target_phase: a.phase,
      outgoing_refs: outgoing.map((o) =>
        `${o.target_file}#section-${o.target_section}`
      ),
      cross_phase_refs: outgoing.filter((o) => o.cross_phase).length,
    });

    // Record cross-phase rewrites
    for (const o of outgoing) {
      if (!o.cross_phase) continue;
      rewrittenRefs.push({
        source_section: a.section_number,
        source_line: o.source_line,
        target_section: o.target_section,
        target_file: o.target_file,
        target_phase: o.target_phase,
        rewrite_form: `(see ${o.target_file} §"section-${o.target_section}")`,
      });
    }
  }

  return { sectionMap, rewrittenRefs, phaseToFile };
}

/**
 * Identify anchors promoted to contract due to in-degree >= 2 cross-phase
 * (already classified, this just records the rationale).
 */
function buildPromotionList(anchors) {
  return anchors
    .filter((a) => a.phase === 'contract')
    .map((a) => ({
      source_section: a.section_number,
      source_heading: a.heading,
      reason: a.classification_reason,
      in_degree: a.in_degree,
    }));
}

function main() {
  const args = parseArgs(process.argv);
  const inDir  = path.resolve(args.inDir  || '.orchestray/state/phase-split');
  const outDir = path.resolve(args.outDir || inDir);

  const anchorsJson = JSON.parse(fs.readFileSync(path.join(inDir, 'anchors.json'), 'utf8'));
  const graphJson   = JSON.parse(fs.readFileSync(path.join(inDir, 'graph.json'),   'utf8'));

  const { sectionMap, rewrittenRefs, phaseToFile } = buildSectionMap(
    anchorsJson.anchors,
    graphJson.refs
  );
  const promoted = buildPromotionList(anchorsJson.anchors);

  fs.mkdirSync(outDir, { recursive: true });

  const traceability = {
    version: 1,
    source_file: anchorsJson.source_file,
    phase_to_file: phaseToFile,
    section_map: sectionMap,
    promoted_to_contract: promoted,
    rewritten_references: rewrittenRefs,
  };

  fs.writeFileSync(
    path.join(outDir, 'traceability.json'),
    JSON.stringify(traceability, null, 2)
  );

  process.stdout.write(JSON.stringify({
    section_count: sectionMap.length,
    rewritten_count: rewrittenRefs.length,
    promoted_count: promoted.length,
    out_file: path.join(outDir, 'traceability.json'),
  }) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = { buildSectionMap, buildPromotionList };
