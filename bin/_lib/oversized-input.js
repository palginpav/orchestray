'use strict';

/**
 * oversized-input.js — Pure helper functions for the Oversized-Input Environment Mode.
 *
 * Planning functions (estimateTokens, planSlices, enforceSliceCap, buildManifest):
 * no filesystem side-effects; accept plain values, return plain values.
 *
 * extractSlices: reads the corpus source and writes per-slice files under the
 * corpus dir. No event emission (the PM emits protocol events). Fail-soft.
 *
 * Token estimate: 4 chars/token heuristic, consistent with spec-sketch.js line 24.
 */

const fs   = require('fs');
const path = require('path');

// Bounded dir walk cap — mirrors the hook's DIR_ENTRY_CAP constant.
const DIR_ENTRY_CAP = 500;
const CORPUS_STATE_REL = path.join('.orchestray', 'state', 'input-corpus');

// FIX-1: safety cap for full-source reads (64M chars). Streaming is future work
// for corpora beyond this limit; we return corpus_too_large for honest failure.
const MAX_SOURCE_CHARS = 64 * 1024 * 1024;

/** @type {number} Chars per token — matches spec-sketch.js "4 chars/token heuristic". */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from a string or raw char count.
 *
 * @param {string|number} input - Source string or number of characters.
 * @returns {number} Integer token estimate (ceil).
 */
function estimateTokens(input) {
  const chars = typeof input === 'string' ? input.length : input;
  if (chars === 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Plan slice windows for a corpus of the given total character size.
 *
 * @param {{ totalChars: number, sliceChars: number, maxSlices: number }} params
 * @returns {{ slices: Array<{index: number, start: number, end: number}>, naturalCount: number, capped: boolean }}
 */
function planSlices({ totalChars, sliceChars, maxSlices }) {
  const naturalCount = Math.ceil(totalChars / sliceChars);
  const capped = naturalCount > maxSlices;
  const count = capped ? maxSlices : naturalCount;

  const slices = [];
  for (let i = 0; i < count; i++) {
    const start = i * sliceChars;
    // Last natural slice ends at totalChars, not at the next boundary
    const isLastNatural = (i === naturalCount - 1);
    const end = isLastNatural ? totalChars : Math.min(start + sliceChars, totalChars);
    slices.push({ index: i, start, end });
  }

  return { slices, naturalCount, capped };
}

/**
 * Determine reduction mode based on whether natural slice count exceeds the cap.
 *
 * @param {{ naturalCount: number, maxSlices: number, hierarchicalReduce: boolean }} params
 * @returns {{ mode: 'direct'|'hierarchical'|'refuse', batches?: number, reason?: string }}
 */
function enforceSliceCap({ naturalCount, maxSlices, hierarchicalReduce }) {
  if (naturalCount <= maxSlices) {
    return { mode: 'direct' };
  }
  if (hierarchicalReduce) {
    return { mode: 'hierarchical', batches: Math.ceil(naturalCount / maxSlices) };
  }
  return {
    mode: 'refuse',
    reason: `Corpus requires ${naturalCount} slices which exceeds max_slices=${maxSlices}. ` +
      `Increase max_slices or enable hierarchical_reduce in oversized_input config.`,
  };
}

/**
 * Build a planning manifest describing the corpus and its slice strategy.
 *
 * @param {{ corpusId: string, totalBytes: number, totalChars: number, fileCount: number,
 *           sliceChars: number, maxSlices: number, hierarchicalReduce?: boolean,
 *           now?: string|Date, trigger?: string }} params
 * @returns {object} Plain manifest object.
 */
function buildManifest({ corpusId, totalBytes, totalChars, fileCount, sliceChars, maxSlices, hierarchicalReduce, now, trigger }) {
  // Default true so existing callers that omit the param remain unchanged.
  const doHierarchical = hierarchicalReduce !== false;
  const estTokens = estimateTokens(totalChars);
  const { naturalCount, capped } = planSlices({ totalChars, sliceChars, maxSlices });
  const { mode } = enforceSliceCap({ naturalCount, maxSlices, hierarchicalReduce: doHierarchical });

  let createdAt;
  if (now === undefined || now === null) {
    createdAt = new Date().toISOString();
  } else if (now instanceof Date) {
    createdAt = now.toISOString();
  } else {
    createdAt = now;
  }

  const result = {
    corpusId,
    totalBytes,
    estTokens,
    totalChars,
    fileCount,
    slicePlan: { naturalCount, capped, mode },
    createdAt,
  };
  // FIX-5: include trigger when provided (backward compatible — existing callers
  // that omit it get no field; detection hook callers get it baked in).
  if (trigger !== undefined) result.trigger = trigger;
  return result;
}

/**
 * Extract slice files for a corpus from its manifest.
 *
 * Reads the corpus source (pasted→corpus.txt, file→sourcePath, dir→children concat),
 * writes slice-<i>.txt files into the corpus dir, and returns metadata.
 *
 * Idempotent: skips writing a slice file only when existing content exactly matches
 * the expected content (FIX-4 — prevents stale slices on same-size mutations).
 * Fail-soft: returns {error, sliceFiles:[]} on missing manifest or unreadable source.
 * Write failures are non-fatal: entries get a writeError:true marker and are skipped
 * from the written count (FIX-3).
 * No event emission — the PM emits `oversized_map_dispatched` etc.
 *
 * FIX-1: no readCap truncation; supports any batch index via arithmetic boundaries.
 * W3: computes naturalCount and mode from TRUE source.length after source read,
 * not from manifest.totalChars (which overestimates for multibyte/binary content).
 *
 * @param {{ cwd: string, corpusId: string, config: object, maxOut?: number, batchStart?: number }} params
 * @returns {{ sliceFiles: Array<{index,path,start,end,chars,writeError?}>, naturalCount: number,
 *             mode: string, written: number, error: string|null }}
 */
function extractSlices({ cwd, corpusId, config, maxOut, batchStart = 0 }) {
  const corpusDir = path.join(cwd, CORPUS_STATE_REL, corpusId);
  const mfPath    = path.join(corpusDir, 'manifest.json');

  // 1. Read manifest
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  } catch (_e) {
    return { error: 'manifest_unreadable', sliceFiles: [] };
  }

  const sliceChars = (config && config.slice_chars) || 6000;
  const maxSlices  = (config && config.max_slices)  || 64;
  const trigger    = manifest.trigger;

  // 2. Conservative estimate from manifest (bytes-as-chars for file/dir; exact for pasted).
  // Used only for the early-exit guard below; W3 corrects both values after source read.
  const totalCharsEst = manifest.totalChars;
  let naturalCount    = Math.ceil(totalCharsEst / sliceChars);
  let mode            = (manifest.slicePlan && manifest.slicePlan.mode) ||
    enforceSliceCap({
      naturalCount,
      maxSlices,
      hierarchicalReduce: (config && config.hierarchical_reduce) !== false,
    }).mode;

  // 3. Conservative early-exit: manifest estimate >= real char count, so this is safe.
  const startIdx = Math.max(0, batchStart); // clamp: negative indices would corrupt slice windows
  if (startIdx >= naturalCount) {
    return { sliceFiles: [], naturalCount, mode, written: 0, error: null };
  }

  // 4. Read full source (bounded by MAX_SOURCE_CHARS).
  // This helper reads the corpus for slicing — not LLM context ingestion. The PM
  // never reads the whole corpus; it operates over the small slice files we produce.
  let source;
  try {
    if (trigger === 'pasted') {
      // Pasted corpora are stored as corpus.txt in the corpus dir
      const raw = fs.readFileSync(path.join(corpusDir, 'corpus.txt'), 'utf8');
      if (raw.length > MAX_SOURCE_CHARS) return { error: 'corpus_too_large', sliceFiles: [] };
      source = raw;
    } else if (trigger === 'file') {
      const src = manifest.sourcePath;
      if (!src) return { error: 'manifest_unreadable', sliceFiles: [] };
      const raw = fs.readFileSync(src, 'utf8');
      if (raw.length > MAX_SOURCE_CHARS) return { error: 'corpus_too_large', sliceFiles: [] };
      source = raw;
    } else if (trigger === 'dir') {
      const src = manifest.sourcePath;
      if (!src) return { error: 'manifest_unreadable', sliceFiles: [] };
      // Concatenate immediate children in sorted order (matches hook's sumDirChildren pattern)
      let entries;
      try { entries = fs.readdirSync(src).sort(); } catch (_e) { entries = []; }
      const capped = entries.slice(0, DIR_ENTRY_CAP);
      let concat = '';
      for (const name of capped) {
        const childPath = path.join(src, name);
        try {
          const st = fs.statSync(childPath);
          if (!st.isFile()) continue;
          const chunk = fs.readFileSync(childPath, 'utf8');
          concat += chunk;
          if (concat.length > MAX_SOURCE_CHARS) return { error: 'corpus_too_large', sliceFiles: [] };
        } catch (_e) { /* skip unreadable */ }
      }
      source = concat;
    } else {
      return { error: 'manifest_unreadable', sliceFiles: [] };
    }
  } catch (_e) {
    return { error: 'manifest_unreadable', sliceFiles: [] };
  }

  // W3: recompute naturalCount and mode from TRUE source.length, not manifest.totalChars.
  // Eliminates empty trailing slices for multibyte/binary corpora (bytes > chars).
  naturalCount = Math.ceil(source.length / sliceChars);
  mode = enforceSliceCap({
    naturalCount,
    maxSlices,
    hierarchicalReduce: (config && config.hierarchical_reduce) !== false,
  }).mode;

  // True beyond-batch check after source read (handles batchStart between estimate and real count)
  if (startIdx >= naturalCount) {
    return { sliceFiles: [], naturalCount, mode, written: 0, error: null };
  }

  // 5. Compute output window and write slice files.
  // Boundaries computed arithmetically for any batch index (no planSlices cap array).
  const endIdx = maxOut != null ? Math.min(startIdx + maxOut, naturalCount) : naturalCount;
  const sliceFiles = [];
  let written = 0;
  for (let i = startIdx; i < endIdx; i++) {
    const start    = i * sliceChars;
    const end      = Math.min((i + 1) * sliceChars, source.length); // W3: real length
    const slicePath = path.join(corpusDir, `slice-${i}.txt`);
    const content   = source.slice(start, end);

    // FIX-4: idempotency by content, not size — prevents stale slices on same-size mutations
    let skip = false;
    try {
      const existing = fs.readFileSync(slicePath, 'utf8');
      if (existing === content) skip = true;
    } catch (_e) { /* does not exist — write it */ }

    if (!skip) {
      // FIX-3: fail-soft write — never throw; mark failures and continue
      try {
        fs.writeFileSync(slicePath, content, 'utf8');
        written++;
      } catch (_e) {
        sliceFiles.push({ index: i, path: slicePath, start, end, chars: content.length, writeError: true });
        continue;
      }
    }

    sliceFiles.push({ index: i, path: slicePath, start, end, chars: content.length });
  }

  return { sliceFiles, naturalCount, mode, written, error: null };
}

module.exports = {
  estimateTokens,
  planSlices,
  enforceSliceCap,
  buildManifest,
  extractSlices,
};
