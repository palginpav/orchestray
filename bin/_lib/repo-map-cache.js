'use strict';

/**
 * repo-map-cache.js — per-file + per-repo SHA cache for the Aider-style
 * repo map (R-AIDER-FULL, v2.1.17).
 *
 * Layout (rooted at `cacheDir`):
 *   manifest.json              — aggregate state (see §4.2 of the W4 design)
 *   tags/<sha[0:2]>/<sha>.json — per-file tag arrays, sharded
 *   graph.json                 — serialized graph + pagerank scores (warm read)
 *
 * Per-file key is `git ls-files -s <path>` (column 2 = blob SHA). When a file
 * is untracked or `cwd` is not a git repo, fall back to
 * `mtime:<unix-ms>:<size>` from `fs.stat`. Mixed-mode coexists: SHA is hex,
 * fallback contains colons — they cannot collide.
 *
 * Aggregate key is `sha256` of the sorted-by-path concatenation of every
 * per-file `blob_sha`, joined by '\n'. HEAD movement that reorders files
 * (renames) changes this even when content is identical.
 *
 * Atomic writes: every persisted file lands as `*.tmp` first, then
 * `fs.renameSync` swaps it in. On failure the old cache is left intact.
 *
 * Never throws — all I/O is wrapped. Catastrophic write failures degrade to
 * an in-memory build per W4 §10.
 */

const fs           = require('fs');
const path         = require('path');
const crypto       = require('crypto');
const { execFileSync } = require('child_process');

const SCHEMA_VERSION       = 1;
const TREE_SITTER_RUNTIME  = '0.26.8';
const GRAMMAR_MANIFEST_REL = path.join('bin', '_lib', 'repo-map-grammars', 'manifest.json');

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function manifestPath(cacheDir) {
  return path.join(cacheDir, 'manifest.json');
}

function graphPath(cacheDir) {
  return path.join(cacheDir, 'graph.json');
}

function tagPath(cacheDir, blobSha) {
  // Shard: tags/<sha[0:2]>/<sha>.json
  // Fallback (mtime:...:size) — replace colons with underscores so the path
  // is still safe on every platform; first two chars of the resulting string
  // remain the shard.
  const safe = String(blobSha).replace(/[:/\\]/g, '_');
  const shard = safe.slice(0, 2) || '__';
  return path.join(cacheDir, 'tags', shard, safe + '.json');
}

// ---------------------------------------------------------------------------
// Per-file blob SHA via git, with mtime+size fallback.
// ---------------------------------------------------------------------------

let _gitLsFilesCache = null; // {cwd, sha => path}

function _populateGitBlobShas(cwd) {
  // git ls-files -s prints: <mode> <sha> <stage>\t<path>
  try {
    const out = execFileSync('git', ['ls-files', '-s'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const map = new Map();
    for (const line of out.split('\n')) {
      if (!line) continue;
      // <mode> <sha> <stage>\t<path>
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) continue;
      const meta = line.slice(0, tabIdx).split(/\s+/);
      if (meta.length < 3) continue;
      const sha = meta[1];
      const relPath = line.slice(tabIdx + 1);
      map.set(relPath, sha);
    }
    _gitLsFilesCache = { cwd, map };
    return map;
  } catch (_e) {
    _gitLsFilesCache = { cwd, map: null };
    return null;
  }
}

function getBlobSha(cwd, relPath) {
  if (!_gitLsFilesCache || _gitLsFilesCache.cwd !== cwd) {
    _populateGitBlobShas(cwd);
  }
  const m = _gitLsFilesCache && _gitLsFilesCache.map;
  if (m && m.has(relPath)) return m.get(relPath);

  // Fallback — fs.stat
  try {
    const st = fs.statSync(path.join(cwd, relPath));
    return 'mtime:' + Math.floor(st.mtimeMs) + ':' + st.size;
  } catch (_e) {
    // Best-effort sentinel — file disappeared mid-build
    return 'gone:' + relPath;
  }
}

function isGitRepo(cwd) {
  if (!_gitLsFilesCache || _gitLsFilesCache.cwd !== cwd) {
    _populateGitBlobShas(cwd);
  }
  return !!(_gitLsFilesCache && _gitLsFilesCache.map);
}

function listTrackedFiles(cwd) {
  if (!_gitLsFilesCache || _gitLsFilesCache.cwd !== cwd) {
    _populateGitBlobShas(cwd);
  }
  const m = _gitLsFilesCache && _gitLsFilesCache.map;
  return m ? Array.from(m.keys()) : null;
}

function resetGitCache() {
  _gitLsFilesCache = null;
}

// ---------------------------------------------------------------------------
// Aggregate SHA — sha256 of sorted-by-path concat of all per-file blob SHAs.
// ---------------------------------------------------------------------------

function computeAggregateSha(filesObj) {
  const paths = Object.keys(filesObj).sort();
  const lines = paths.map((p) => filesObj[p].blob_sha);
  const buf = lines.join('\n');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Grammar manifest SHA — sha256 of the literal bytes of grammars/manifest.json
// ---------------------------------------------------------------------------

function computeGrammarManifestSha(repoRoot) {
  try {
    const buf = fs.readFileSync(path.join(repoRoot, GRAMMAR_MANIFEST_REL));
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manifest read / write
// ---------------------------------------------------------------------------

function loadManifest(cacheDir) {
  try {
    const raw = fs.readFileSync(manifestPath(cacheDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

function ensureCacheDir(cacheDir) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(path.join(cacheDir, 'tags'), { recursive: true });
    return true;
  } catch (_e) {
    return false;
  }
}

function atomicWriteJson(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

function writeManifest(cacheDir, manifest) {
  try {
    atomicWriteJson(manifestPath(cacheDir), manifest);
    return true;
  } catch (_e) {
    return false;
  }
}

function writeTagCache(cacheDir, blobSha, tagsArray) {
  try {
    atomicWriteJson(tagPath(cacheDir, blobSha), tagsArray);
    return true;
  } catch (_e) {
    return false;
  }
}

function readTagCache(cacheDir, blobSha) {
  try {
    const raw = fs.readFileSync(tagPath(cacheDir, blobSha), 'utf8');
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function writeGraph(cacheDir, graphData) {
  try {
    atomicWriteJson(graphPath(cacheDir), graphData);
    return true;
  } catch (_e) {
    return false;
  }
}

function readGraph(cacheDir) {
  try {
    const raw = fs.readFileSync(graphPath(cacheDir), 'utf8');
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function wipeCache(cacheDir) {
  try {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Probe writability — used to detect cacheDir not writable.
// ---------------------------------------------------------------------------

function isCacheWritable(cacheDir) {
  try {
    if (!ensureCacheDir(cacheDir)) return false;
    const probe = path.join(cacheDir, '.write-probe');
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

// v2.1.17 W9-fix F-008: dropped graphPath/manifestPath/tagPath from public
// exports — no external consumer reads them, and the helpers are used only
// internally by writeGraph/readGraph/loadManifest. They remain as
// module-private functions.
module.exports = {
  SCHEMA_VERSION,
  TREE_SITTER_RUNTIME,
  // Git helpers
  getBlobSha,
  isGitRepo,
  listTrackedFiles,
  resetGitCache,
  // Aggregate / grammar SHAs
  computeAggregateSha,
  computeGrammarManifestSha,
  // Manifest I/O
  loadManifest,
  writeManifest,
  ensureCacheDir,
  // Tag cache
  writeTagCache,
  readTagCache,
  // Graph cache
  writeGraph,
  readGraph,
  // Maintenance
  wipeCache,
  isCacheWritable,
};
