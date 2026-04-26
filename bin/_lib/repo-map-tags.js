'use strict';

/**
 * repo-map-tags.js — per-language tag extraction via tree-sitter (web-tree-sitter
 * 0.26.8). Implements step 1 of W4 §3 algorithm.
 *
 * Public API:
 *   loadGrammar(lang, repoRoot)         -> Promise<Language|null>
 *   extractTagsFromSource(lang, repoRoot, source) -> Promise<Tag[]>
 *   extName(filename) -> 'js'|'ts'|'py'|'go'|'rs'|'sh'|null
 *   LANGUAGES                           -> string[]  (six canonical langs)
 *
 * Tag shape: { name: string, kind: 'def'|'ref', file: string, line: number }
 *
 * Lazy loads parsers + queries; first use of a language pays the cold-load
 * cost, subsequent calls reuse the module-level cache.
 *
 * Never throws — on grammar load failure returns null. Per-file parse
 * failure is the caller's concern (it gets back null tags or an empty
 * array via the higher-level wrapper in repo-map.js).
 */

const fs   = require('fs');
const path = require('path');

const LANGUAGES = ['js', 'ts', 'py', 'go', 'rs', 'sh'];

const EXT_TO_LANG = {
  '.js':   'js',
  '.mjs':  'js',
  '.cjs':  'js',
  '.jsx':  'js',
  '.ts':   'ts',
  '.tsx':  'ts',
  '.py':   'py',
  '.go':   'go',
  '.rs':   'rs',
  '.sh':   'sh',
  '.bash': 'sh',
};

const LANG_TO_QUERY_FILE = {
  js: 'javascript.scm',
  ts: 'typescript.scm',
  py: 'python.scm',
  go: 'go.scm',
  rs: 'rust.scm',
  sh: 'bash.scm',
};

const LANG_TO_WASM = {
  js: 'tree-sitter-javascript.wasm',
  ts: 'tree-sitter-typescript.wasm',
  py: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rs: 'tree-sitter-rust.wasm',
  sh: 'tree-sitter-bash.wasm',
};

// ---------------------------------------------------------------------------
// Cached parser/query handles, keyed by language. Module-level — survives
// for the lifetime of the Node process.
// ---------------------------------------------------------------------------

let _Parser              = null; // class from web-tree-sitter
let _Language            = null;
let _Query               = null;
let _initPromise         = null; // Parser.init() resolves once per process
const _languageCache     = new Map();   // lang -> Language
const _queryCache        = new Map();   // lang -> Query
const _failedLanguages   = new Set();   // lang -> grammar load failed

function _resetForTests() {
  _Parser = null;
  _Language = null;
  _Query = null;
  _initPromise = null;
  _languageCache.clear();
  _queryCache.clear();
  _failedLanguages.clear();
}

function extName(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXT_TO_LANG[ext] || null;
}

async function _ensureInit() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const ts = require('web-tree-sitter');
    _Parser   = ts.Parser;
    _Language = ts.Language;
    _Query    = ts.Query;
    await _Parser.init();
  })();
  return _initPromise;
}

/**
 * Load a language by code ('js'|'ts'|'py'|'go'|'rs'|'sh'). Returns Language
 * on success, null on failure. Never throws.
 */
async function loadGrammar(lang, repoRoot) {
  if (_languageCache.has(lang)) return _languageCache.get(lang);
  if (_failedLanguages.has(lang)) return null;
  const wasmName = LANG_TO_WASM[lang];
  if (!wasmName) {
    _failedLanguages.add(lang);
    return null;
  }
  try {
    await _ensureInit();
    const wasmPath = path.join(repoRoot, 'bin', '_lib', 'repo-map-grammars', wasmName);
    const buf = fs.readFileSync(wasmPath);
    const language = await _Language.load(new Uint8Array(buf));
    _languageCache.set(lang, language);
    return language;
  } catch (_e) {
    _failedLanguages.add(lang);
    return null;
  }
}

/**
 * Load + cache the per-language Query object.
 */
function _loadQuery(lang, repoRoot, language) {
  if (_queryCache.has(lang)) return _queryCache.get(lang);
  const queryFile = LANG_TO_QUERY_FILE[lang];
  if (!queryFile) return null;
  const queryPath = path.join(repoRoot, 'bin', '_lib', 'repo-map-grammars', 'queries', queryFile);
  const src = fs.readFileSync(queryPath, 'utf8');
  const query = new _Query(language, src);
  _queryCache.set(lang, query);
  return query;
}

/**
 * Convert a tree-sitter capture name into our Tag.kind.
 *   "name.definition.*"   -> "def"
 *   "name.reference.*"    -> "ref"
 *   anything else          -> null  (skipped)
 */
function _captureKind(captureName) {
  if (!captureName) return null;
  if (captureName.startsWith('name.definition.')) return 'def';
  if (captureName.startsWith('name.reference.'))  return 'ref';
  return null;
}

/**
 * Extract tags from in-memory source. Returns an array of Tag objects.
 * `relPath` is the repository-relative path placed in `tag.file`.
 *
 * Throws on parse error so the caller can emit `repo_map_parse_failed`.
 */
async function extractTagsFromSource(lang, repoRoot, source, relPath) {
  const language = await loadGrammar(lang, repoRoot);
  if (!language) {
    const err = new Error('grammar_load_failed:' + lang);
    err.code = 'grammar_load_failed';
    throw err;
  }
  const parser = new _Parser();
  parser.setLanguage(language);
  let tree;
  try {
    tree = parser.parse(source);
    if (!tree) throw new Error('parser returned null');

    const query = _loadQuery(lang, repoRoot, language);
    if (!query) return [];

    const captures = query.captures(tree.rootNode);
    const tags = [];
    for (const cap of captures) {
      const kind = _captureKind(cap.name);
      if (!kind) continue;
      const node = cap.node;
      const name = node.text;
      // Reject empty/whitespace names (defensive).
      if (!name || !name.trim()) continue;
      tags.push({
        name: name,
        kind: kind,
        file: relPath,
        line: (node.startPosition.row | 0) + 1,
      });
    }
    return tags;
  } finally {
    try { if (tree) tree.delete(); } catch (_e) { /* ignore */ }
    try { parser.delete(); } catch (_e) { /* ignore */ }
  }
}

module.exports = {
  LANGUAGES,
  EXT_TO_LANG,
  extName,
  loadGrammar,
  extractTagsFromSource,
  _resetForTests,
};
