#!/usr/bin/env node
'use strict';

/**
 * repo-map.js — public entry for R-AIDER-FULL (v2.1.17). Implements the
 * Aider-style tree-sitter + PageRank repo-map per the W4 design
 * (`.orchestray/kb/artifacts/v2117-aider-design.md`).
 *
 * Public API:
 *   buildRepoMap({cwd, tokenBudget?, languages?, cacheDir?, coldInitAsync?})
 *       -> Promise<{ map: string, stats: {...} }>
 *
 *   clearRepoMapCache({cwd, cacheDir?}) -> Promise<void>
 *
 * Per-role default token budgets (W4 §5):
 *
 *   developer   1500
 *   refactorer  2500
 *   reviewer    1000
 *   debugger    1000
 *   (others)    0   (skip)
 *
 * Behavioural contracts:
 *   - tokenBudget === 0 returns immediately with empty map; no parsing.
 *   - On any failure path the promise resolves with {map: '', stats: {…}};
 *     never throws.
 *   - When `coldInitAsync: true` and the cache is cold, returns an empty
 *     map immediately and kicks off the rebuild in the background so
 *     subsequent spawns within the same session see the warm cache.
 *
 * Events (see `agents/pm-reference/event-schemas.md`):
 *   - repo_map_built              — every successful build
 *   - repo_map_parse_failed       — per-file parse error
 *   - repo_map_grammar_load_failed — per-language grammar load error
 *   - repo_map_cache_unavailable  — cache dir not writable, in-memory build
 */

const fs   = require('fs');
const path = require('path');

const cache  = require('./repo-map-cache');
const tags   = require('./repo-map-tags');
const graph  = require('./repo-map-graph');
const render = require('./repo-map-render');

const ROLE_BUDGETS = Object.freeze({
  developer:  1500,
  refactorer: 2500,
  reviewer:   1000,
  debugger:   1000,
});

const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB per W4 §3 step 1
const DEFAULT_LANGUAGES = ['js', 'ts', 'py', 'go', 'rs', 'sh'];
const DEFAULT_CACHE_DIR_REL = path.join('.orchestray', 'state', 'repo-map-cache');

// ---------------------------------------------------------------------------
// Lazy event emitter — never blocks if the audit gateway is unavailable.
// ---------------------------------------------------------------------------

let _writeEvent = undefined;
let _resolveOrchestrationId = undefined;
function emitEvent(eventPayload, cwd) {
  if (_writeEvent === undefined) {
    try {
      // eslint-disable-next-line global-require
      const mod = require('./audit-event-writer');
      _writeEvent = (mod && mod.writeEvent) || null;
      _resolveOrchestrationId = (mod && mod.resolveOrchestrationId) || null;
    } catch (_e) {
      _writeEvent = null;
      _resolveOrchestrationId = null;
    }
  }
  if (typeof _writeEvent !== 'function') return;
  // v2.2.17 W7a: populate timestamp + orchestration_id at emit (was autofilled 200×).
  const enriched = {
    timestamp:        new Date().toISOString(),
    orchestration_id: typeof _resolveOrchestrationId === 'function'
      ? _resolveOrchestrationId(cwd)
      : 'unknown',
    ...eventPayload,
  };
  try {
    _writeEvent(enriched, { cwd });
  } catch (_e) { /* fail-open */ }
}

// ---------------------------------------------------------------------------
// Empty-result helper
// ---------------------------------------------------------------------------

function emptyStats() {
  return {
    files_parsed:     0,
    symbols_ranked:   0,
    cache_hit:        false,
    ms:               0,
    token_count:      0,
    skipped_files:    0,
    skipped_grammars: [],
  };
}

// ---------------------------------------------------------------------------
// File discovery — git ls-files preferred, fs.readdir fallback.
// ---------------------------------------------------------------------------

function _scanFs(rootAbs) {
  // Light-weight recursive walk. Skips dotfiles + node_modules + huge dirs.
  const out = [];
  const SKIP_DIRS = new Set(['.git', 'node_modules', '.orchestray', 'dist', 'build', 'coverage', '.next', '.cache']);
  function walk(rel) {
    const abs = path.join(rootAbs, rel);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch (_e) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && !rel) continue;
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(childRel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        out.push(childRel.split(path.sep).join('/'));
      }
    }
  }
  walk('');
  return out;
}

function discoverFiles(cwd, allowedLanguages) {
  let candidates;
  if (cache.isGitRepo(cwd)) {
    candidates = cache.listTrackedFiles(cwd);
  } else {
    candidates = _scanFs(cwd);
  }
  if (!candidates) return [];
  const allowed = new Set(allowedLanguages);
  return candidates.filter((p) => {
    const lang = tags.extName(p);
    return lang && allowed.has(lang);
  });
}

// ---------------------------------------------------------------------------
// Per-file tag harvest — uses cache when blob_sha matches.
// ---------------------------------------------------------------------------

async function harvestTags({ cwd, files, cacheDir, cacheWritable, skippedGrammars }) {
  const tagsByFile = new Map();
  let skipped_files = 0;
  const fileMeta = {}; // for manifest

  for (const relPath of files) {
    const lang = tags.extName(relPath);
    if (!lang) continue;
    if (skippedGrammars.has(lang)) {
      // Grammar known to fail load — skip silently.
      continue;
    }

    const blobSha = cache.getBlobSha(cwd, relPath);
    if (!blobSha) continue;

    // Cache hit?
    let perFileTags = null;
    if (cacheWritable) {
      perFileTags = cache.readTagCache(cacheDir, blobSha);
    }

    if (perFileTags === null) {
      // Cache miss — parse.
      const abs = path.join(cwd, relPath);
      let stat;
      try { stat = fs.statSync(abs); }
      catch (_e) { continue; }
      if (stat.size > MAX_FILE_BYTES) {
        skipped_files++;
        emitEvent({
          version:     1,
          type:        'repo_map_parse_failed',
          cwd:         cwd,
          file:        relPath,
          error_class: 'file_too_large',
        }, cwd);
        continue;
      }
      let source;
      try { source = fs.readFileSync(abs, 'utf8'); }
      catch (_e) {
        skipped_files++;
        emitEvent({
          version:     1,
          type:        'repo_map_parse_failed',
          cwd:         cwd,
          file:        relPath,
          error_class: 'read_error',
        }, cwd);
        continue;
      }
      try {
        perFileTags = await tags.extractTagsFromSource(lang, cwd, source, relPath);
      } catch (e) {
        if (e && e.code === 'grammar_load_failed') {
          if (!skippedGrammars.has(lang)) {
            skippedGrammars.add(lang);
            emitEvent({
              version:     1,
              type:        'repo_map_grammar_load_failed',
              cwd:         cwd,
              language:    lang,
              error_class: String(e.message || 'grammar_load_failed'),
            }, cwd);
          }
        } else {
          skipped_files++;
          emitEvent({
            version:     1,
            type:        'repo_map_parse_failed',
            cwd:         cwd,
            file:        relPath,
            error_class: 'parse_error:' + String((e && e.message) || e).slice(0, 120),
          }, cwd);
        }
        continue;
      }
      if (cacheWritable) {
        cache.writeTagCache(cacheDir, blobSha, perFileTags);
      }
    }

    tagsByFile.set(relPath, perFileTags);
    fileMeta[relPath] = { blob_sha: blobSha, tag_cache: blobSha + '.json' };
  }

  return { tagsByFile, skipped_files, fileMeta };
}

// ---------------------------------------------------------------------------
// buildRepoMap
// ---------------------------------------------------------------------------

const _backgroundBuilds = new Map(); // cwd -> Promise

async function buildRepoMap(opts) {
  const t0 = process.hrtime.bigint();
  opts = opts || {};
  const cwd            = opts.cwd;
  const tokenBudget    = (typeof opts.tokenBudget === 'number') ? opts.tokenBudget : 1000;
  const languages      = Array.isArray(opts.languages) && opts.languages.length > 0
                          ? opts.languages.filter((l) => DEFAULT_LANGUAGES.includes(l))
                          : DEFAULT_LANGUAGES.slice();
  const cacheDir       = opts.cacheDir
                          ? (path.isAbsolute(opts.cacheDir) ? opts.cacheDir : path.join(cwd, opts.cacheDir))
                          : path.join(cwd, DEFAULT_CACHE_DIR_REL);
  const coldInitAsync  = opts.coldInitAsync !== false; // default true

  if (!cwd || typeof cwd !== 'string') {
    return { map: '', stats: emptyStats() };
  }

  // Hard-skip on disabled budget.
  if (tokenBudget === 0) {
    return { map: '', stats: emptyStats() };
  }

  // v2.1.17 W9-fix F-010: gate the git-cache reset behind a test-only opt
  // (`opts._testResetGitCache === true`). In production the per-cwd cache is
  // already keyed by cwd; back-to-back warm reads no longer pay the
  // `git ls-files -s` subprocess cost. Tests that mutate the same cwd
  // (e.g. cache hit/miss tests) must pass the flag explicitly.
  if (opts._testResetGitCache === true) {
    cache.resetGitCache();
  }

  const cacheWritable = cache.isCacheWritable(cacheDir);
  if (!cacheWritable) {
    emitEvent({
      version: 1,
      type:    'repo_map_cache_unavailable',
      cwd:     cwd,
      reason:  'cache_dir_not_writable',
    }, cwd);
  }

  const grammarManifestSha = cache.computeGrammarManifestSha(cwd);
  if (!grammarManifestSha) {
    // Defensive: no grammar manifest = treat as disabled. No event per W4 §10.
    return { map: '', stats: emptyStats() };
  }

  // Try cache hit before discovery.
  const existing = cacheWritable ? cache.loadManifest(cacheDir) : null;
  if (existing
      && existing.schema_version       === cache.SCHEMA_VERSION
      && existing.tree_sitter_runtime  === cache.TREE_SITTER_RUNTIME
      && existing.grammar_manifest_sha === grammarManifestSha) {
    // Re-evaluate aggregate against current files.
    const candidatePaths = discoverFiles(cwd, languages);
    const currentFiles = {};
    for (const p of candidatePaths) {
      const sha = cache.getBlobSha(cwd, p);
      if (sha) currentFiles[p] = { blob_sha: sha };
    }
    const currentAggregate = cache.computeAggregateSha(currentFiles);

    if (currentAggregate === existing.aggregate_sha) {
      // Aggregate match — render only.
      const cached = cache.readGraph(cacheDir);
      if (cached && cached.scores && cached.tagsByFile) {
        const tagsByFile = new Map();
        for (const [k, v] of Object.entries(cached.tagsByFile)) {
          tagsByFile.set(k, v);
        }
        const ranked = Object.entries(cached.scores)
          .sort((a, b) => b[1] - a[1])
          .map((e) => e[0]);
        const totalFiles = ranked.length;
        const { map, tokens } = render.binarySearchK(ranked, tagsByFile, totalFiles, tokenBudget);
        const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
        const stats = {
          files_parsed:    Object.keys(cached.tagsByFile).length,
          symbols_ranked:  Object.keys(cached.scores).length,
          cache_hit:       true,
          ms:              ms,
          token_count:     tokens,
          skipped_files:   0,
          skipped_grammars: [],
        };
        emitEvent({
          version:        1,
          type:           'repo_map_built',
          cwd:            cwd,
          files_parsed:   stats.files_parsed,
          symbols_ranked: stats.symbols_ranked,
          ms:             stats.ms,
          cache_hit:      true,
          token_count:    stats.token_count,
        }, cwd);
        return { map, stats };
      }
    }
  } else if (existing && cacheWritable) {
    // Grammar/runtime/schema bump → wipe and rebuild.
    cache.wipeCache(cacheDir);
    cache.ensureCacheDir(cacheDir);
  }

  // Cold path. If async-cold-init requested AND we have no graph cache,
  // kick off a background build and return empty immediately.
  if (coldInitAsync && cacheWritable) {
    if (!_backgroundBuilds.has(cwd)) {
      const promise = _doFullBuild({
        cwd, cacheDir, languages, tokenBudget,
        cacheWritable, grammarManifestSha, t0,
      }).finally(() => _backgroundBuilds.delete(cwd));
      _backgroundBuilds.set(cwd, promise);
      // Don't await — caller gets empty map, next call sees warm cache.
    }
    return { map: '', stats: emptyStats() };
  }

  // Synchronous cold build.
  return _doFullBuild({
    cwd, cacheDir, languages, tokenBudget,
    cacheWritable, grammarManifestSha, t0,
  });
}

async function _doFullBuild({ cwd, cacheDir, languages, tokenBudget, cacheWritable, grammarManifestSha, t0 }) {
  const skippedGrammars = new Set();
  const candidatePaths = discoverFiles(cwd, languages);

  const { tagsByFile, skipped_files, fileMeta } = await harvestTags({
    cwd, files: candidatePaths, cacheDir, cacheWritable, skippedGrammars,
  });

  const { graph: g } = graph.buildGraph(tagsByFile);
  const scoresMap = graph.runPageRank(g);

  const ranked = Array.from(scoresMap.keys());
  const totalFiles = ranked.length;
  const { map, tokens } = render.binarySearchK(ranked, tagsByFile, totalFiles, tokenBudget);

  // Persist.
  if (cacheWritable) {
    const tagsObj = {};
    for (const [k, v] of tagsByFile) tagsObj[k] = v;
    const aggregateSha = cache.computeAggregateSha(fileMeta);
    cache.writeManifest(cacheDir, {
      schema_version:       cache.SCHEMA_VERSION,
      grammar_manifest_sha: grammarManifestSha,
      tree_sitter_runtime:  cache.TREE_SITTER_RUNTIME,
      files:                fileMeta,
      aggregate_sha:        aggregateSha,
      built_at:             new Date().toISOString(),
    });
    const scoresPlain = {};
    for (const [k, v] of scoresMap) scoresPlain[k] = v;
    cache.writeGraph(cacheDir, {
      tagsByFile: tagsObj,
      scores:     scoresPlain,
    });
  }

  const ms = Number((process.hrtime.bigint() - t0) / 1000000n);
  const stats = {
    files_parsed:     tagsByFile.size,
    symbols_ranked:   scoresMap.size,
    cache_hit:        false,
    ms:               ms,
    token_count:      tokens,
    skipped_files:    skipped_files,
    skipped_grammars: Array.from(skippedGrammars),
  };
  emitEvent({
    version:        1,
    type:           'repo_map_built',
    cwd:            cwd,
    files_parsed:   stats.files_parsed,
    symbols_ranked: stats.symbols_ranked,
    ms:             stats.ms,
    cache_hit:      false,
    token_count:    stats.token_count,
  }, cwd);
  return { map, stats };
}

// ---------------------------------------------------------------------------
// clearRepoMapCache
// ---------------------------------------------------------------------------

async function clearRepoMapCache(opts) {
  opts = opts || {};
  const cwd = opts.cwd;
  if (!cwd) return;
  const cacheDir = opts.cacheDir
    ? (path.isAbsolute(opts.cacheDir) ? opts.cacheDir : path.join(cwd, opts.cacheDir))
    : path.join(cwd, DEFAULT_CACHE_DIR_REL);
  cache.wipeCache(cacheDir);
  cache.resetGitCache();
}

// ---------------------------------------------------------------------------
// CLI smoke entry: `node bin/_lib/repo-map.js --cwd . --budget 1000`
// ---------------------------------------------------------------------------

function _parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd')         out.cwd = argv[++i];
    else if (a === '--budget') out.tokenBudget = parseInt(argv[++i], 10) || 0;
    else if (a === '--sync')   out.coldInitAsync = false;
    else if (a === '--print-map') out.printMap = true;
  }
  return out;
}

if (require.main === module) {
  const args = _parseArgv(process.argv.slice(2));
  if (!args.cwd) args.cwd = process.cwd();
  if (typeof args.tokenBudget !== 'number') args.tokenBudget = 1000;
  if (args.coldInitAsync === undefined) args.coldInitAsync = false;
  buildRepoMap(args).then((result) => {
    process.stdout.write(JSON.stringify(result.stats, null, 2) + '\n');
    if (args.printMap) process.stdout.write('\n' + result.map);
  }).catch((e) => {
    process.stderr.write('repo-map: ' + (e && e.message || e) + '\n');
    process.exit(1);
  });
}

module.exports = {
  buildRepoMap,
  clearRepoMapCache,
  ROLE_BUDGETS,
  DEFAULT_LANGUAGES,
};
