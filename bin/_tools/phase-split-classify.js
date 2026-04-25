#!/usr/bin/env node
'use strict';

/**
 * phase-split-classify.js — Dev-time tool (W8, v2.1.15, I-PHASE-GATE).
 *
 * Pass 1 + Pass 2 + Pass 3 of P-PHASE-SPLIT-RECONCILE (W4 prototype):
 *   - Pass 1: anchor extraction (regex-extract H2/H3 headings + line ranges)
 *   - Pass 2: reference graph (find outgoing references from each anchor)
 *   - Pass 3: keyword phase classification + in-degree>=2 promotion to contract
 *
 * Rule-driven: accepts --rules <json> argument so the W9 R-CURATOR-SPLIT can
 * reuse this same tool with curator-stages.json. Default rules = built-in
 * tier1 keyword sets if --rules absent.
 *
 * Output: writes traceability.json, anchors.json, graph.json to
 *   .orchestray/state/phase-split/ (or override dir via --out-dir).
 *
 * Usage:
 *   node bin/_tools/phase-split-classify.js \
 *     --source agents/pm-reference/tier1-orchestration.md \
 *     [--rules bin/_tools/phase-split-rules.tier1.json] \
 *     [--out-dir .orchestray/state/phase-split]
 *
 * No external deps. Node stdlib + zod-free (validation lives in the rule file shape).
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Built-in rule sets
// ---------------------------------------------------------------------------

/**
 * Tier1 (I-PHASE-GATE) default classification rules.
 * Each phase has a list of section-number patterns and keyword regexes.
 * If a section's number or heading matches, it goes to that phase.
 *
 * Promoted-to-contract: in-degree >= 2 across distinct phases auto-promotes,
 * but the explicit `contract` rule takes precedence (anchors that are
 * inherently shared infrastructure).
 */
const TIER1_RULES = {
  name: 'tier1-orchestration',
  source_file: 'agents/pm-reference/tier1-orchestration.md',
  phases: ['contract', 'decomp', 'execute', 'verify', 'close'],
  classification: {
    contract: {
      // State persistence, KB, context handoff — referenced by every phase.
      sections: ['7', '10', '11'],
      keywords: [
        'State Persistence',
        'Knowledge Base Protocol',
        'Context Handoff',
      ],
    },
    decomp: {
      // Task decomposition, contract generation, playbook loading,
      // pattern application (pre-decomp), trace injection.
      sections: ['13', '13.X', '22b', '22b-federation', '22b.R', '29', '11.Y'],
      keywords: [
        'Task Decomposition',
        'Contract Generation',
        'Pre-Conditions',
        'Playbook Loading',
        'Pattern Application',
        'Pre-Decomposition',
        'Trace Injection for Downstream',
      ],
    },
    execute: {
      // Parallel execution, spawning, dynamic agents, model routing,
      // correction-pattern application (delegation-time).
      sections: ['14', '14.X', '14.Y', '14.Z', '17', '19', '19.Z', '19.R', '19.C', '30.application', '34f'],
      keywords: [
        'Parallel Execution',
        'Sequential Merge',
        'Pre-Condition Validation',
        'Dynamic Agent Spawning',
        'Mid-task Ambiguity',
        'Inter-Group Confidence',
        'Model Routing',
        'Routing Outcome Logging',
        'routing_lookup',
        'cost_budget_reserve',
        'Confidence-Triggered Escalation',
      ],
    },
    verify: {
      // Re-planning, disagreement detection, verify-fix loop.
      sections: ['16', '18', '18.D'],
      keywords: [
        'Adaptive Re-Planning',
        'Disagreement Detection',
        'Verify-Fix Loop',
        'Distinguishing Re-Plan from Verify-Fix',
        'Regression Prevention',
        'User Escalation',
      ],
    },
    close: {
      // Cost tracking step 3+, ROI scorecard, pattern extraction (post-orch),
      // correction memory extraction, user correction (post-orch detection).
      sections: ['15', '15.Z', '22', '22a', '22c', '22d', '22.Y', '22.D', '22.f', '30', '34', '34a', '34b', '34c', '34d', '34e'],
      keywords: [
        'Cost Tracking',
        'Audit Initialization',
        'Orchestration Completion Event',
        'Threshold Calibration',
        'ROI Scorecard',
        'Pattern Extraction',
        'Confidence Feedback Loop',
        'Pruning',
        'Trace-Aware Pattern Extraction',
        'Design-Preference Pattern Learning',
        'Auto-extraction first-run notice',
        'Correction Memory Protocol',
        'User Correction Protocol',
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Argument parsing (no external dep)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { source: null, rules: null, outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source')        { args.source = argv[++i]; }
    else if (a === '--rules')    { args.rules  = argv[++i]; }
    else if (a === '--out-dir')  { args.outDir = argv[++i]; }
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: phase-split-classify.js --source <md-file> [--rules <json>] [--out-dir <dir>]\n'
      );
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Pass 1 — anchor extraction
// ---------------------------------------------------------------------------

/**
 * Extract H2 and H3 anchors from markdown source.
 * Returns array of { heading, level, line_start, line_end, section_number, text }.
 */
function extractAnchors(source) {
  const lines = source.split('\n');
  const anchors = [];
  // Match H2 (`## N. Foo` or `## §N.X Foo`) and H3 (`### N.X Foo`).
  const headingRe = /^(#{2,3})\s+(.+?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (!m) continue;
    const level = m[1].length;
    const text  = m[2].trim();
    // Section number: prefix up to first non-digit/non-dot/non-letter (e.g. "13.X")
    const numMatch = text.match(/^§?(\d+(?:\.[\dA-Za-z]+)?)/);
    const section_number = numMatch ? numMatch[1] : null;
    anchors.push({
      heading: text,
      level,
      line_start: i + 1, // 1-indexed
      line_end: -1,      // patched below
      section_number,
    });
  }

  // Patch line_end for each anchor (line before next anchor, or EOF).
  for (let i = 0; i < anchors.length; i++) {
    anchors[i].line_end = (i + 1 < anchors.length)
      ? anchors[i + 1].line_start - 1
      : lines.length;
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Pass 2 — reference graph
// ---------------------------------------------------------------------------

/**
 * Find all outgoing references from each anchor's body.
 * Reference patterns:
 *   - "Section N" / "§N" / "Section N.X" / "(see Section 13.X)"
 *   - cross-file references like "see delegation-templates.md §..."
 * Returns array of { source_section, target_section, line, text }.
 */
function buildReferenceGraph(source, anchors) {
  const lines = source.split('\n');
  const refs = [];
  // Reference regex: catches "Section 13", "§13.X", "section 22b"
  const refRe = /\b(?:Section|§|section|see)\s+§?(\d+(?:\.[\dA-Za-z]+)?)/g;

  for (const anchor of anchors) {
    const bodyLines = lines.slice(anchor.line_start, anchor.line_end);
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      let m;
      // Reset regex state for each line
      refRe.lastIndex = 0;
      while ((m = refRe.exec(line)) !== null) {
        const target = m[1];
        // Skip self-refs (anchor referring to itself)
        if (anchor.section_number === target) continue;
        refs.push({
          source_section: anchor.section_number,
          source_heading: anchor.heading,
          target_section: target,
          line: anchor.line_start + i,
          text: line.trim().slice(0, 200),
        });
      }
    }
  }
  return refs;
}

/**
 * Compute in-degree per section: how many distinct *other* sections refer to it.
 */
function computeInDegree(refs) {
  const inDeg = {};
  const seen = {}; // target -> Set of source sections (for distinct count)
  for (const r of refs) {
    if (!r.target_section || !r.source_section) continue;
    if (!seen[r.target_section]) seen[r.target_section] = new Set();
    seen[r.target_section].add(r.source_section);
  }
  for (const target of Object.keys(seen)) {
    inDeg[target] = seen[target].size;
  }
  return inDeg;
}

// ---------------------------------------------------------------------------
// Pass 3 — phase classification
// ---------------------------------------------------------------------------

/**
 * Classify each anchor into a phase using rules.
 * Order: explicit contract sections > explicit phase sections > keyword match
 *        > in-degree >= 2 promotion (cross-phase) > default 'close'.
 */
function classifyAnchors(anchors, rules, refs) {
  const inDeg = computeInDegree(refs);
  const classified = [];

  for (const anchor of anchors) {
    let phase = null;
    let reason = null;

    // 1. Explicit section number match — first phase wins.
    for (const ph of rules.phases) {
      const r = rules.classification[ph];
      if (!r) continue;
      if (r.sections && anchor.section_number && r.sections.includes(anchor.section_number)) {
        phase = ph;
        reason = `explicit_section_match:${anchor.section_number}`;
        break;
      }
    }

    // 2. Keyword match (case-insensitive substring) — first phase wins.
    if (!phase) {
      const headingLower = anchor.heading.toLowerCase();
      for (const ph of rules.phases) {
        const r = rules.classification[ph];
        if (!r || !r.keywords) continue;
        const hit = r.keywords.find((k) => headingLower.includes(k.toLowerCase()));
        if (hit) {
          phase = ph;
          reason = `keyword_match:${hit}`;
          break;
        }
      }
    }

    // 3. In-degree >= 2 from distinct sections → promote to contract.
    //    (Only if not already classified.)
    if (!phase && anchor.section_number && (inDeg[anchor.section_number] || 0) >= 2) {
      phase = 'contract';
      reason = `in_degree_promotion:${inDeg[anchor.section_number]}`;
    }

    // 4. Default: close (post-orchestration / catch-all).
    if (!phase) {
      phase = 'close';
      reason = 'default_fallback';
    }

    classified.push({
      ...anchor,
      phase,
      classification_reason: reason,
      in_degree: inDeg[anchor.section_number] || 0,
    });
  }

  return classified;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  if (!args.source) {
    process.stderr.write('error: --source <md-file> is required\n');
    process.exit(2);
  }

  const sourcePath = path.resolve(args.source);
  if (!fs.existsSync(sourcePath)) {
    process.stderr.write(`error: source file not found: ${sourcePath}\n`);
    process.exit(2);
  }

  // Load rules: --rules JSON file overrides built-in tier1 default.
  let rules;
  if (args.rules) {
    const rulesPath = path.resolve(args.rules);
    rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  } else {
    rules = TIER1_RULES;
  }

  // Validate rules shape (minimal — phases array + classification map).
  if (!Array.isArray(rules.phases) || !rules.classification) {
    process.stderr.write('error: rules JSON must have { phases: [], classification: {} }\n');
    process.exit(2);
  }

  const source = fs.readFileSync(sourcePath, 'utf8');
  const anchors = extractAnchors(source);
  const refs = buildReferenceGraph(source, anchors);
  const classified = classifyAnchors(anchors, rules, refs);

  const outDir = path.resolve(args.outDir || '.orchestray/state/phase-split');
  fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(
    path.join(outDir, 'anchors.json'),
    JSON.stringify({ version: 1, source_file: args.source, anchors: classified }, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, 'graph.json'),
    JSON.stringify({ version: 1, refs, in_degree: computeInDegree(refs) }, null, 2)
  );

  // Summary to stdout
  const phaseCounts = {};
  for (const a of classified) {
    phaseCounts[a.phase] = (phaseCounts[a.phase] || 0) + 1;
  }
  process.stdout.write(JSON.stringify({
    source: args.source,
    rules_name: rules.name || 'inline',
    anchor_count: classified.length,
    ref_count: refs.length,
    phase_counts: phaseCounts,
    out_dir: outDir,
  }) + '\n');
}

// Module-vs-script guard (W6 pattern — avoid hang-on-test-import).
if (require.main === module) {
  main();
}

module.exports = {
  extractAnchors,
  buildReferenceGraph,
  computeInDegree,
  classifyAnchors,
  TIER1_RULES,
};
