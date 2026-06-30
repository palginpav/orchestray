#!/usr/bin/env node
'use strict';

/**
 * oversized-extract.js — CLI entrypoint for pre-extracting corpus slice files.
 *
 * Called by the PM in OI.4b before spawning haiku scouts (OI.5). Generates
 * slice-<i>.txt files under .orchestray/state/input-corpus/<corpus_id>/ so
 * each scout can do a plain whole-file Read without offset/limit arithmetic.
 *
 * Usage:
 *   node ${CLAUDE_PLUGIN_ROOT}/bin/oversized-extract.js \
 *     --cwd <path> --corpus <id> [--batch-start <N>] [--max-out <M>]
 *
 * Stdout: JSON { sliceFiles, naturalCount, mode, written, error }
 * Exit 0 on success (even if sliceFiles is empty for a beyond-batch call).
 * Exit 1 when result.error is set or an uncaught exception occurs.
 *
 * Never throws uncaught — all errors produce JSON + exit 1.
 */

const { loadOversizedInputConfig } = require('./_lib/config-schema');
const { extractSlices }            = require('./_lib/oversized-input');

// ─── Arg parser ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--cwd' && next)          { args.cwd = next;                     i++; }
    else if (a === '--corpus' && next)  { args.corpus = next;                  i++; }
    else if (a === '--batch-start' && next) { args.batchStart = parseInt(next, 10); i++; }
    else if (a === '--max-out' && next) { args.maxOut = parseInt(next, 10);    i++; }
  }
  return args;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args     = parseArgs(process.argv);
  const cwd      = args.cwd || process.cwd();
  const corpusId = args.corpus;

  if (!corpusId) {
    process.stdout.write(JSON.stringify({ error: '--corpus is required' }) + '\n');
    process.exit(1);
  }
  // Defense-in-depth: corpus_id is a 12-hex sha1 fragment. Reject anything else
  // so a crafted --corpus (e.g. containing `..` or `/`) cannot escape the corpus dir.
  if (!/^[0-9a-f]{12}$/.test(corpusId)) {
    process.stdout.write(JSON.stringify({ error: 'invalid corpus id' }) + '\n');
    process.exit(1);
  }

  let config;
  try {
    config = loadOversizedInputConfig(cwd);
  } catch (_e) {
    config = {}; // fail-open: use defaults inside extractSlices
  }

  // Reject negative / non-numeric batch windows — negative indices corrupt slice files.
  if (args.batchStart != null && (isNaN(args.batchStart) || args.batchStart < 0)) {
    process.stdout.write(JSON.stringify({ error: '--batch-start must be a non-negative integer' }) + '\n');
    process.exit(1);
  }
  if (args.maxOut != null && (isNaN(args.maxOut) || args.maxOut < 0)) {
    process.stdout.write(JSON.stringify({ error: '--max-out must be a non-negative integer' }) + '\n');
    process.exit(1);
  }

  const params = { cwd, corpusId, config };
  if (args.batchStart != null) params.batchStart = args.batchStart;
  if (args.maxOut     != null) params.maxOut     = args.maxOut;

  const result = extractSlices(params);
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.error ? 1 : 0);
}

try {
  main();
} catch (_e) {
  process.stdout.write(JSON.stringify({ error: String((_e && _e.message) || _e) }) + '\n');
  process.exit(1);
}
