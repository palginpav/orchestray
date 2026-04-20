'use strict';

/**
 * spec-sketch.js — SpecSketch handoff skeleton generator.
 *
 * Converts prior-agent output (files_changed + git diff text + KB entries) into
 * a compact YAML skeleton for use as the "Context from Previous Agent" block in
 * delegation prompts.
 *
 * Symbol-level deltas are extracted via git diff -U0 regex for JS/TS/Py/Go/Rust.
 * Unknown languages fall back to bare files_touched + lines_delta.
 *
 * Budget cap: if skeleton exceeds ~400 tokens (~1600 chars), truncate file list
 * and emit spec_sketch_budget_exceeded degraded entry.
 *
 * Contract: never throws. All errors cause fail-open (returns null → caller
 * falls back to prose template).
 *
 * @module spec-sketch
 */

const { recordDegradation } = require('./degraded-journal');

// Approx token budget: 400 tokens ≈ 1600 chars (4 chars/token heuristic).
const BUDGET_CHARS = 1600;

// Known-language symbol extractors: map of file extension → extraction function.
// Each function receives the unified diff text for that file and returns
// { added_exports, modified_functions, added_types, removed_exports }.
const LANG_EXTRACTORS = {
  '.js':   _extractJsTs,
  '.ts':   _extractJsTs,
  '.jsx':  _extractJsTs,
  '.tsx':  _extractJsTs,
  '.mjs':  _extractJsTs,
  '.cjs':  _extractJsTs,
  '.py':   _extractPy,
  '.go':   _extractGo,
  '.rs':   _extractRust,
};

// ---------------------------------------------------------------------------
// Language-specific symbol extractors
// ---------------------------------------------------------------------------

/**
 * Extract JS/TS symbol deltas from a unified diff chunk.
 * @param {string} diffText
 * @returns {{ added_exports: string[], modified_functions: string[], added_types: string[], removed_exports: string[] }}
 */
function _extractJsTs(diffText) {
  const added_exports    = [];
  const modified_functions = [];
  const added_types      = [];
  const removed_exports  = [];

  // Lines added in diff (start with +, not ++)
  const addedLines   = diffText.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const removedLines = diffText.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));

  // Capture line number context for modified functions (from @@ markers).
  const lineNumRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let currentLine = 0;

  for (const rawLine of diffText.split('\n')) {
    const lm = rawLine.match(lineNumRe);
    if (lm) { currentLine = parseInt(lm[1], 10); continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) currentLine++;
    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) continue;

    const line = rawLine.startsWith('+') ? rawLine.slice(1) : rawLine;

    // export function / export const / export class / export default
    const exportFnMatch = line.match(/^\s*export\s+(?:async\s+)?function\s+(\w+)/);
    if (exportFnMatch && rawLine.startsWith('+')) {
      added_exports.push(exportFnMatch[1]);
      continue;
    }

    const exportConstMatch = line.match(/^\s*export\s+(?:const|let|var)\s+(\w+)/);
    if (exportConstMatch && rawLine.startsWith('+')) {
      added_exports.push(exportConstMatch[1]);
      continue;
    }

    const exportClassMatch = line.match(/^\s*export\s+(?:default\s+)?class\s+(\w+)/);
    if (exportClassMatch && rawLine.startsWith('+')) {
      added_exports.push(exportClassMatch[1]);
      continue;
    }

    // export type / export interface (TS)
    const exportTypeMatch = line.match(/^\s*export\s+(?:type|interface)\s+(\w+)/);
    if (exportTypeMatch && rawLine.startsWith('+')) {
      added_types.push(exportTypeMatch[1]);
      continue;
    }

    // function modification (not export)
    const fnMatch = line.match(/^\s*(?:async\s+)?function\s+(\w+)/);
    if (fnMatch && rawLine.startsWith('+')) {
      modified_functions.push(fnMatch[1] + '@L' + currentLine);
      continue;
    }
  }

  // Removed exports from removed lines.
  for (const rl of removedLines) {
    const line = rl.slice(1);
    const m = line.match(/^\s*export\s+(?:(?:async\s+)?function|const|let|var|class|default\s+class)\s+(\w+)/);
    if (m) removed_exports.push(m[1]);
  }

  return { added_exports, modified_functions, added_types, removed_exports };
}

/**
 * Extract Python symbol deltas.
 * @param {string} diffText
 * @returns {{ added_exports: string[], modified_functions: string[], added_types: string[], removed_exports: string[] }}
 */
function _extractPy(diffText) {
  const added_exports    = [];
  const modified_functions = [];
  const added_types      = [];
  const removed_exports  = [];

  const lineNumRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let currentLine = 0;

  for (const rawLine of diffText.split('\n')) {
    const lm = rawLine.match(lineNumRe);
    if (lm) { currentLine = parseInt(lm[1], 10); continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) currentLine++;

    const line = rawLine.startsWith('+') ? rawLine.slice(1) : rawLine;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const defMatch = line.match(/^(?:async )?def (\w+)/);
      if (defMatch) { modified_functions.push(defMatch[1] + '@L' + currentLine); continue; }

      const classMatch = line.match(/^class (\w+)/);
      if (classMatch) { added_types.push(classMatch[1]); continue; }
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      const defMatch = line.match(/^(?:async )?def (\w+)/);
      if (defMatch) removed_exports.push(defMatch[1]);
    }
  }

  return { added_exports, modified_functions, added_types, removed_exports };
}

/**
 * Extract Go symbol deltas.
 * @param {string} diffText
 */
function _extractGo(diffText) {
  const added_exports    = [];
  const modified_functions = [];
  const added_types      = [];
  const removed_exports  = [];

  const lineNumRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let currentLine = 0;

  for (const rawLine of diffText.split('\n')) {
    const lm = rawLine.match(lineNumRe);
    if (lm) { currentLine = parseInt(lm[1], 10); continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) currentLine++;

    const line = rawLine.startsWith('+') ? rawLine.slice(1) : rawLine;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      // Exported function (capital letter)
      const fnMatch = line.match(/^func (\w+)/);
      if (fnMatch) {
        const name = fnMatch[1];
        if (/^[A-Z]/.test(name)) added_exports.push(name);
        else modified_functions.push(name + '@L' + currentLine);
        continue;
      }
      // type
      const typeMatch = line.match(/^type (\w+)/);
      if (typeMatch) added_types.push(typeMatch[1]);
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      const fnMatch = line.match(/^func (\w+)/);
      if (fnMatch && /^[A-Z]/.test(fnMatch[1])) removed_exports.push(fnMatch[1]);
    }
  }

  return { added_exports, modified_functions, added_types, removed_exports };
}

/**
 * Extract Rust symbol deltas.
 * @param {string} diffText
 */
function _extractRust(diffText) {
  const added_exports    = [];
  const modified_functions = [];
  const added_types      = [];
  const removed_exports  = [];

  const lineNumRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  let currentLine = 0;

  for (const rawLine of diffText.split('\n')) {
    const lm = rawLine.match(lineNumRe);
    if (lm) { currentLine = parseInt(lm[1], 10); continue; }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) currentLine++;

    const line = rawLine.startsWith('+') ? rawLine.slice(1) : rawLine;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const pubFnMatch = line.match(/^\s*pub\s+(?:async\s+)?fn\s+(\w+)/);
      if (pubFnMatch) { added_exports.push(pubFnMatch[1]); continue; }

      const fnMatch = line.match(/^\s*(?:async\s+)?fn\s+(\w+)/);
      if (fnMatch) { modified_functions.push(fnMatch[1] + '@L' + currentLine); continue; }

      const typeMatch = line.match(/^\s*pub\s+(?:struct|enum|trait|type)\s+(\w+)/);
      if (typeMatch) added_types.push(typeMatch[1]);
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      const pubFnMatch = line.match(/^\s*pub\s+(?:async\s+)?fn\s+(\w+)/);
      if (pubFnMatch) removed_exports.push(pubFnMatch[1]);
    }
  }

  return { added_exports, modified_functions, added_types, removed_exports };
}

// ---------------------------------------------------------------------------
// Diff splitting
// ---------------------------------------------------------------------------

/**
 * Split a unified diff into per-file sections.
 * @param {string} diffText
 * @returns {Array<{ filePath: string, diff: string, addedLines: number, removedLines: number }>}
 */
function _splitDiffByFile(diffText) {
  if (!diffText) return [];

  const files = [];
  let current = null;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('--- a/') || line.startsWith('+++ b/')) {
      const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
      if (newFileMatch) {
        if (current) files.push(current);
        current = { filePath: newFileMatch[1], diff: '', addedLines: 0, removedLines: 0 };
      }
      continue;
    }
    if (current) {
      current.diff += line + '\n';
      if (line.startsWith('+') && !line.startsWith('+++')) current.addedLines++;
      if (line.startsWith('-') && !line.startsWith('---')) current.removedLines++;
    }
  }
  if (current) files.push(current);
  return files;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a SpecSketch YAML skeleton for use in a delegation prompt.
 *
 * @param {object} params
 * @param {string[]} params.filesChanged    Array of file paths changed by prior agent.
 * @param {string}   params.diffText        Output of `git diff -U0` (or full diff).
 * @param {Array<{slug:string,summary:string}>} params.kbEntries  KB entries to cite.
 * @param {string}   params.agentType       Type of the prior agent.
 * @param {string}   params.taskId          Task ID of the prior agent.
 * @param {string[]} [params.contractsMet]  Contract verdict strings.
 * @param {string}   [params.rationale]     Optional rationale (≤60 tokens, for arch/inventor/debugger).
 * @param {string}   [params.projectRoot]
 * @returns {{ sketch: string|null, fallback: boolean, budgetExceeded: boolean }}
 *          sketch=null means caller should use prose template instead.
 */
function generateSketch(params) {
  try {
    const {
      filesChanged = [],
      diffText     = '',
      kbEntries    = [],
      agentType    = 'unknown',
      taskId       = 'unknown',
      contractsMet = [],
      rationale    = null,
      projectRoot,
    } = params || {};

    if (!filesChanged || filesChanged.length === 0) {
      return { sketch: null, fallback: true, budgetExceeded: false };
    }

    // Split diff by file for symbol extraction.
    let fileDiffs;
    try {
      fileDiffs = _splitDiffByFile(diffText);
    } catch (_) {
      recordDegradation({
        kind: 'spec_sketch_parse_failed',
        severity: 'warn',
        detail: { reason: 'diff split failed', agentType, taskId },
      });
      return { sketch: null, fallback: true, budgetExceeded: false };
    }

    // Build per-file diff lookup.
    const diffByFile = {};
    for (const fd of fileDiffs) {
      diffByFile[fd.filePath] = fd;
    }

    // Build YAML lines for each file.
    const fileLines = [];
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const filePath of filesChanged) {
      const ext = '.' + (filePath.split('.').pop() || '');
      const fd = diffByFile[filePath] || null;
      const added   = fd ? fd.addedLines   : 0;
      const removed = fd ? fd.removedLines : 0;
      totalAdded   += added;
      totalRemoved += removed;

      const extractor = LANG_EXTRACTORS[ext.toLowerCase()];
      if (extractor && fd && fd.diff) {
        let symbols;
        try {
          symbols = extractor(fd.diff);
        } catch (_) {
          symbols = null;
        }

        if (symbols) {
          const fileEntry = [`  ${filePath}:`];
          if (symbols.added_exports.length)
            fileEntry.push(`    added_exports: [${symbols.added_exports.join(', ')}]`);
          if (symbols.modified_functions.length)
            fileEntry.push(`    modified_functions: [${symbols.modified_functions.join(', ')}]`);
          if (symbols.added_types.length)
            fileEntry.push(`    added_types: [${symbols.added_types.join(', ')}]`);
          if (symbols.removed_exports.length)
            fileEntry.push(`    removed_exports: [${symbols.removed_exports.join(', ')}]`);
          fileEntry.push(`    lines_delta: +${added} -${removed}`);
          fileLines.push(fileEntry.join('\n'));
          continue;
        }
      }

      // Fallback for unknown language or no diff: bare lines_delta only.
      fileLines.push(`  ${filePath}:\n    lines_delta: +${added} -${removed}`);
    }

    // Build the YAML skeleton.
    const parts = [
      `## Previous: ${agentType} on task-${taskId}`,
      `files:`,
      fileLines.join('\n'),
    ];

    if (contractsMet.length > 0) {
      parts.push(`contracts_met: [${contractsMet.join(', ')}]`);
    }

    if (kbEntries.length > 0) {
      const refs = kbEntries.map(e => e.slug).join(', ');
      parts.push(`kb_refs: [${refs}]`);
    }

    if (rationale) {
      // Cap rationale to ~60 tokens (≈240 chars).
      const cappedRationale = rationale.slice(0, 240);
      parts.push(`rationale: |\n  ${cappedRationale.replace(/\n/g, '\n  ')}`);
    }

    let sketch = parts.join('\n');

    // Budget check.
    let budgetExceeded = false;
    if (sketch.length > BUDGET_CHARS && filesChanged.length > 1) {
      // Truncate to first N files that fit.
      budgetExceeded = true;
      const truncatedFileLines = [];
      let budget = BUDGET_CHARS - 200; // Reserve space for header + trailer.
      let count = 0;

      for (const fl of fileLines) {
        if (budget - fl.length < 0) break;
        truncatedFileLines.push(fl);
        budget -= fl.length;
        count++;
      }

      const omitted = fileLines.length - count;
      const truncatedParts = [
        `## Previous: ${agentType} on task-${taskId}`,
        `files:`,
        truncatedFileLines.join('\n'),
        `  ... ${omitted} more file(s) not listed`,
      ];
      if (contractsMet.length > 0) truncatedParts.push(`contracts_met: [${contractsMet.join(', ')}]`);
      if (kbEntries.length > 0)    truncatedParts.push(`kb_refs: [${kbEntries.map(e => e.slug).join(', ')}]`);
      if (rationale) truncatedParts.push(`rationale: |\n  ${rationale.slice(0, 240).replace(/\n/g, '\n  ')}`);

      sketch = truncatedParts.join('\n');

      recordDegradation({
        kind: 'spec_sketch_budget_exceeded',
        severity: 'warn',
        detail: {
          files_total: filesChanged.length,
          files_included: count,
          files_omitted: omitted,
          agentType,
          taskId,
          dedup_key: 'budget-' + taskId,
        },
        projectRoot,
      });
    }

    return { sketch, fallback: false, budgetExceeded };
  } catch (err) {
    // Fail-open: any unexpected error falls back to prose template.
    try {
      recordDegradation({
        kind: 'spec_sketch_parse_failed',
        severity: 'warn',
        detail: { message: err.message, dedup_key: 'sketch-error-' + (params && params.taskId) },
      });
    } catch (_) {}
    return { sketch: null, fallback: true, budgetExceeded: false };
  }
}

/**
 * Determine if SpecSketch should use the YAML skeleton or prose template
 * for a given downstream agent type.
 *
 * Architect, inventor, and debugger get prose template (they benefit from rationale).
 * All other agents get the YAML skeleton.
 *
 * @param {string} downstreamAgentType
 * @returns {boolean}  true = use YAML skeleton; false = use prose template
 */
function shouldUseSketch(downstreamAgentType) {
  const proseAgents = new Set(['architect', 'inventor', 'debugger']);
  return !proseAgents.has(downstreamAgentType);
}

module.exports = { generateSketch, shouldUseSketch };
