#!/usr/bin/env node
'use strict';

/**
 * detect-oversized-input.js — UserPromptSubmit hook (W3 v2.3.14).
 *
 * Detects oversized inputs (large files/dirs referenced in the prompt, or pasted
 * text above token threshold) and injects an <oversized-input-advisory> block
 * into additionalContext so the PM enters Oversized-Input Mode.
 *
 * FAIL-OPEN: any error → emit {"continue":true}, exit 0. Never throws, never blocks.
 * FAST PATH: small prompt with no path-like tokens → no-op immediately.
 *
 * Kill switches (checked first):
 *   - loadOversizedInputConfig(cwd).enabled === false  → no-op
 *   - ORCHESTRAY_DISABLE_OVERSIZED_INPUT === '1'        → no-op
 *
 * Detection (first/largest match wins):
 *   (a) file ref: path token that resolves to an existing regular file
 *       whose size > threshold_bytes → trigger:'file'
 *   (b) dir ref: path token that resolves to an existing directory;
 *       sum immediate-children sizes (bounded); if total > threshold_bytes
 *       → trigger:'dir'
 *   (c) pasted text: prompt bytes > threshold_bytes OR
 *       estimateTokens(prompt) > threshold_tokens → trigger:'pasted'
 *
 * Input:  JSON on stdin (Claude Code UserPromptSubmit hook payload)
 * Output: exit 0 always; hookSpecificOutput JSON on stdout on detection
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');

const { MAX_INPUT_BYTES }          = require('./_lib/constants');
const { resolveSafeCwd }           = require('./_lib/resolve-project-cwd');
const { loadOversizedInputConfig } = require('./_lib/config-schema');
const { estimateTokens, planSlices, buildManifest } = require('./_lib/oversized-input');
const { writeEvent }               = require('./_lib/audit-event-writer');

const CONTINUE_RESPONSE = JSON.stringify({ continue: true });

// Bounded dir walk: inspect at most this many entries to guard against huge dirs.
const DIR_ENTRY_CAP = 500;

// Cap path-like tokens stat'd per prompt — this runs on EVERY UserPromptSubmit,
// so an adversarial paste with hundreds of paths must not fan out unbounded stats.
const MAX_PATH_TOKENS = 50;

// ─── Stdin reader ─────────────────────────────────────────────────────────────

let _input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.stdout.write(CONTINUE_RESPONSE + '\n'); process.exit(0); });
process.stdin.on('data', (chunk) => {
  _input += chunk;
  if (_input.length > MAX_INPUT_BYTES) {
    // Oversized stdin itself — fail-open (can't safely parse it)
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(_input);
    main(event);
  } catch (_e) {
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Compute first 12 hex chars of sha1(str). Deterministic corpus_id. */
function corpusIdFrom(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 12);
}

/**
 * Extract path-like tokens from prompt text.
 * Matches: absolute /…, ~/…, or ./… paths; also bare relative tokens
 * containing a path separator (e.g. "src/foo.js").
 *
 * Returns deduplicated array of candidate strings.
 * Fast bail: if text contains no '/' at all, returns [] immediately (O(n)).
 */
function extractPathTokens(text) {
  // Fast bail: no slash means no path token possible
  if (!text.includes('/')) return [];

  // Split on whitespace and filter tokens that look path-like.
  // This avoids catastrophic regex backtracking on large strings.
  const seen = new Set();
  const results = [];
  const words = text.split(/\s+/);
  for (const w of words) {
    if (!w) continue;
    // Must contain '/' to be path-like
    if (!w.includes('/')) continue;
    // Must start with a recognised prefix or contain internal slash
    if (
      w.startsWith('/') ||
      w.startsWith('~/') ||
      w.startsWith('./') ||
      w.startsWith('../') ||
      /^[\w.-]+\//.test(w)
    ) {
      if (!seen.has(w)) {
        seen.add(w);
        results.push(w);
        if (results.length >= MAX_PATH_TOKENS) break; // hot-path stat cap
      }
    }
  }
  return results;
}

/**
 * Sum byte sizes of immediate children of dir (bounded to DIR_ENTRY_CAP entries).
 * Returns { totalBytes, entryCount }.
 */
function sumDirChildren(dirPath) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch (_e) {
    return { totalBytes: 0, entryCount: 0 };
  }
  const capped = entries.sort().slice(0, DIR_ENTRY_CAP); // I2: sort before cap — matches extractSlices dir order
  let totalBytes = 0;
  for (const name of capped) {
    try {
      const st = fs.statSync(path.join(dirPath, name));
      if (st.isFile()) totalBytes += st.size;
    } catch (_e) { /* skip unreadable */ }
  }
  return { totalBytes, entryCount: capped.length };
}

/**
 * Try to resolve a candidate token to an absolute path under cwd.
 * Returns { abs, stat } for an existing path, or null if resolution fails or
 * the path does not exist. The stat is returned so callers avoid a second
 * statSync syscall on the same path (hot path).
 */
function resolveToken(tok, cwd) {
  try {
    let abs;
    if (tok.startsWith('/')) {
      abs = tok;
    } else if (tok.startsWith('~/')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      if (!home) return null; // cannot safely expand ~ without a home dir
      abs = path.join(home, tok.slice(2));
    } else {
      // Relative — must exist under cwd to be considered
      abs = path.resolve(cwd, tok);
    }
    // B2 (v2.3.15): reject filesystem-root or home-root paths — never a real
    // corpus, but a mistyped/misresolved token can land here (e.g. "/") and a
    // naive dir-children sum would report tens of GB.
    if (abs === path.parse(abs).root || abs === os.homedir()) return null;
    const stat = fs.statSync(abs); // throws if absent
    return { abs, stat };
  } catch (_e) {
    return null;
  }
}

// ─── Corpus directory ─────────────────────────────────────────────────────────

const CORPUS_STATE_REL = path.join('.orchestray', 'state', 'input-corpus');

function corpusDir(cwd, corpusId) {
  return path.join(cwd, CORPUS_STATE_REL, corpusId);
}

function manifestPath(cwd, corpusId) {
  return path.join(corpusDir(cwd, corpusId), 'manifest.json');
}

// ─── Main handler ─────────────────────────────────────────────────────────────

function main(event) {
  try {
    const cwd = resolveSafeCwd(event && event.cwd);

    // Kill switch: env var
    if (process.env.ORCHESTRAY_DISABLE_OVERSIZED_INPUT === '1') {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      return;
    }

    // Kill switch: config
    const cfg = loadOversizedInputConfig(cwd);
    if (cfg.enabled === false) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      return;
    }

    const { threshold_bytes, threshold_tokens, slice_chars, max_slices, hierarchical_reduce, max_corpus_bytes } = cfg;

    // Extract prompt text from event (Claude Code payload shape)
    const promptText = (event && typeof event.prompt === 'string') ? event.prompt : '';
    const promptBytes = Buffer.byteLength(promptText, 'utf8');

    // Fast path: small prompt with no path-like tokens — skip all stats
    const pathTokens = extractPathTokens(promptText);
    if (promptBytes < threshold_bytes && pathTokens.length === 0) {
      if (estimateTokens(promptText) <= threshold_tokens) {
        process.stdout.write(CONTINUE_RESPONSE + '\n');
        return;
      }
    }

    // Detection pass
    let detection = null; // { trigger, resolvedPath, totalBytes, totalChars, fileCount }

    // (a) + (b): file/dir references
    for (const tok of pathTokens) {
      const resolved = resolveToken(tok, cwd);
      if (!resolved) continue;
      const { abs, stat: st } = resolved; // reuse the stat from resolveToken

      if (st.isFile()) {
        if (st.size > threshold_bytes) {
          detection = {
            trigger: 'file',
            resolvedPath: abs,
            totalBytes: st.size,
            totalChars: st.size, // byte-level estimate for non-text files
            fileCount: 1,
          };
          break;
        }
      } else if (st.isDirectory()) {
        const { totalBytes } = sumDirChildren(abs);
        if (totalBytes > threshold_bytes) {
          detection = {
            trigger: 'dir',
            resolvedPath: abs,
            totalBytes,
            totalChars: totalBytes, // byte-level estimate
            fileCount: 0, // slicer computes real count from manifest
          };
          break;
        }
      }
    }

    // (c): pasted text — check if prompt itself is oversized.
    // Note: with default config (threshold_bytes 1.5MB > MAX_INPUT_BYTES stdin
    // cap of 1MB) the promptBytes leg is unreachable for ASCII; the effective
    // pasted trigger is threshold_tokens. The byte leg matters only when a user
    // lowers threshold_bytes below the stdin cap.
    if (!detection) {
      const estTok = estimateTokens(promptText);
      if (promptBytes > threshold_bytes || estTok > threshold_tokens) {
        detection = {
          trigger: 'pasted',
          resolvedPath: null,
          totalBytes: promptBytes,
          totalChars: promptText.length,
          fileCount: 1,
        };
      }
    }

    if (!detection) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      return;
    }

    // B1 (v2.3.15): size ceiling — a corpus this large is never a user document,
    // e.g. a path token that mis-resolved to a filesystem root (27 GB dogfooding
    // bug). Treat as no-detection rather than slicing or advising on it.
    if (detection.totalBytes > max_corpus_bytes) {
      process.stdout.write(CONTINUE_RESPONSE + '\n');
      return;
    }

    // Compute deterministic corpus_id
    const hashSource = detection.resolvedPath
      ? detection.resolvedPath + ':' + detection.totalBytes
      : promptText;
    const corpusId = corpusIdFrom(hashSource);

    const mfPath = manifestPath(cwd, corpusId);
    const isNewCorpus = !fs.existsSync(mfPath);

    // Build the manifest in memory FIRST so the advisory reflects the true
    // slice mode even if persistence fails (disk full / permissions). For a
    // pre-existing corpus we read the stored manifest instead.
    let manifest;
    if (isNewCorpus) {
      manifest = buildManifest({
        corpusId,
        totalBytes: detection.totalBytes,
        totalChars: detection.totalChars,
        fileCount: detection.fileCount,
        sliceChars: slice_chars,
        maxSlices: max_slices,
        hierarchicalReduce: hierarchical_reduce,
        now: new Date(),
        trigger: detection.trigger, // FIX-5: baked into manifest contract
      });
      if (detection.resolvedPath) manifest.sourcePath = detection.resolvedPath;

      // Best-effort persistence — failure here never affects the advisory.
      try {
        const dir = corpusDir(cwd, corpusId);
        fs.mkdirSync(dir, { recursive: true });
        // Pasted text: persist the corpus. File/dir refs: no copy (slicer reads original).
        if (detection.trigger === 'pasted') {
          try { fs.writeFileSync(path.join(dir, 'corpus.txt'), promptText, 'utf8'); } catch (_e) {}
        }
        fs.writeFileSync(mfPath, JSON.stringify(manifest, null, 2), 'utf8');
      } catch (_e) { /* persistence is best-effort; in-memory manifest drives the advisory */ }
    } else {
      manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch (_e) {}
    }

    const estTokens = estimateTokens(detection.totalChars);
    const { naturalCount } = planSlices({
      totalChars: detection.totalChars,
      sliceChars: slice_chars,
      maxSlices: max_slices,
    });
    const slicePlan = (manifest.slicePlan) || {};
    const mode = slicePlan.mode || 'direct';

    // Emit audit event only on first detection of a corpus — avoids re-emitting
    // the same event on every prompt that references the same oversized input.
    if (isNewCorpus) {
      try {
        writeEvent({
          type: 'oversized_input_detected',
          corpus_id: corpusId,
          trigger: detection.trigger,
          total_bytes: detection.totalBytes,
          est_tokens: estTokens,
          natural_slices: naturalCount,
          mode,
          threshold_bytes,
        }, { cwd });
      } catch (_e) { /* audit failure must never block */ }

      // W6.2: also emit refused_cap when the slice plan mode is refuse
      if (mode === 'refuse') {
        try {
          writeEvent({
            type: 'oversized_refused_cap',
            corpus_id: corpusId,
            trigger: detection.trigger,
            natural_slices: naturalCount,
            max_slices,
            threshold_bytes,
          }, { cwd });
        } catch (_e) { /* audit failure must never block */ }
      }
    }

    // Guidance depends on the slice mode: a 'refuse' plan means slicing is
    // disabled (over max_slices with hierarchical_reduce off), so the PM must
    // NOT be told to slice.
    const guidance = mode === 'refuse'
      ? [
          'Corpus is too large to slice under current config (mode=refuse:',
          'natural slices exceed max_slices and hierarchical_reduce is disabled).',
          'Do NOT slice. Ask the user to raise oversized_input.max_slices, enable',
          'hierarchical_reduce, or narrow the request.',
        ]
      : [
          'Oversized input detected — enter Oversized-Input Mode. Do NOT full-read the corpus;',
          'operate over slices (haiku-scout) per the oversized-input-mode protocol.',
        ];

    // Build advisory block
    const advisory = [
      '<oversized-input-advisory>',
      'corpus_id: ' + corpusId,
      'total_bytes: ' + detection.totalBytes,
      'est_tokens: ' + estTokens,
      'trigger: ' + detection.trigger,
      'slice_plan: naturalCount=' + naturalCount + ' mode=' + mode,
      '',
      ...guidance,
      'Manifest: ' + mfPath,
      '</oversized-input-advisory>',
    ].join('\n');

    const response = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: advisory,
      },
      continue: true,
    };

    process.stdout.write(JSON.stringify(response) + '\n');

  } catch (_e) {
    // Fail-open: any unhandled error must never block the user's prompt
    process.stdout.write(CONTINUE_RESPONSE + '\n');
    process.exit(0);
  }
}
