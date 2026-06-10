'use strict';

/**
 * Conservative synonym expansion table for pattern_find (R-RET-EXPAND, v2.1.13).
 *
 * Design principles:
 *   - HIGH-PRECISION PAIRS ONLY. A wrong synonym silently ranks the wrong pattern;
 *     a missing one only fails to help. Bias heavily toward precision.
 *   - ~40 equivalence classes (see acceptance criterion). Entries are lowercase,
 *     ASCII-only, no snake_case or hyphens — _tokenize() strips non-[a-z0-9]+
 *     anyway, so the lookup key is always a bare token.
 *   - Each class is a set of mutually-synonymous words; the exported map gives
 *     each word the OTHER words in its class as expansions (bidirectional).
 *
 * Kill switch: callers pass { enabled } to _expandSynonyms(). When enabled=false
 * the function returns the input tokens unchanged with an empty expansions list.
 *
 * Audit trail: _expandSynonyms() returns `expansions: [{from, to}]` so callers
 * can attach "synonym_expanded:{from}->{to}" entries to `match_reasons`.
 */

// ---------------------------------------------------------------------------
// Equivalence classes — ~40 entries, HIGH PRECISION only.
// Do NOT add speculative pairs. If you're not sure it's a true synonym in the
// context of a Claude Code / orchestration pattern corpus, leave it out.
// ---------------------------------------------------------------------------

const SYNONYM_CLASSES = [
  // --- Bugs / fixes ---
  ['bug', 'debug', 'defect', 'correction', 'fix'],
  ['error', 'failure', 'exception', 'crash'],

  // --- Performance ---
  ['performance', 'perf', 'optimization', 'speedup', 'slow'],
  ['latency', 'delay', 'slowness'],
  ['throughput', 'bandwidth'],

  // --- Security ---
  ['security', 'auth', 'vulnerability', 'breach'],
  ['authentication', 'login', 'signin'],
  ['authorization', 'permission', 'acl'],
  ['credential', 'credentials', 'secret', 'token'],

  // --- Testing ---
  ['test', 'spec', 'testing', 'coverage'],
  ['assertion', 'assert', 'expect'],
  ['mock', 'stub', 'fake'],

  // --- Config ---
  ['config', 'settings', 'configuration'],
  ['env', 'environment', 'envvar'],

  // --- Release / deploy ---
  ['deploy', 'release', 'ship', 'publish'],
  ['rollout', 'launch'],
  ['rollback', 'revert'],

  // --- Retry / resilience ---
  ['retry', 'backoff', 'reconnect'],
  ['resilience', 'resilient', 'robust'],
  ['timeout', 'expire', 'deadline'],
  ['circuit', 'breaker'],

  // --- Data / persistence ---
  ['database', 'db', 'schema'],
  ['migration', 'migrate'],
  ['cache', 'memoize', 'cached'],
  ['persist', 'persistence', 'persistent', 'durable'],

  // --- API / routing ---
  ['api', 'endpoint', 'route'],
  ['request', 'req'],
  ['response', 'resp', 'reply'],

  // --- Logs / observability ---
  ['log', 'logging', 'logs', 'audit'],
  ['trace', 'tracing', 'span'],
  ['metric', 'metrics', 'telemetry'],

  // --- Concurrency / queues ---
  ['queue', 'worker', 'job'],
  ['parallel', 'concurrent', 'concurrency'],
  ['async', 'asynchronous'],
  ['sync', 'synchronous', 'blocking'],

  // --- Refactor / quality ---
  ['refactor', 'cleanup', 'restructure'],
  ['rename', 'renaming'],
  ['delete', 'remove', 'removal'],

  // --- Docs ---
  ['doc', 'docs', 'documentation', 'readme'],

  // --- Versioning ---
  ['version', 'ver', 'semver'],
  ['upgrade', 'update', 'bump'],

  // --- Agent vocabulary (project-specific, still conservative) ---
  ['agent', 'subagent'],
  ['orchestration', 'orchestrate'],
  ['pattern', 'patterns'],
];

// ---------------------------------------------------------------------------
// Build the lookup map: word → Set<otherWordsInSameClass>.
// Frozen via Object.freeze for the outer object; each Set is intentionally
// mutable at construction time but never mutated after module init, and we
// don't hand the Sets to external callers (we iterate them internally).
// ---------------------------------------------------------------------------

const SYNONYM_MAP = Object.create(null);

for (const cls of SYNONYM_CLASSES) {
  for (const word of cls) {
    if (typeof word !== 'string' || word.length === 0) continue;
    const key = word.toLowerCase();
    if (!SYNONYM_MAP[key]) SYNONYM_MAP[key] = new Set();
    for (const other of cls) {
      if (other === word) continue;
      SYNONYM_MAP[key].add(other.toLowerCase());
    }
  }
}

Object.freeze(SYNONYM_MAP);

// Count of unique words across all classes (for diagnostics / test assertion).
const SYNONYM_WORD_COUNT = Object.keys(SYNONYM_MAP).length;
const SYNONYM_CLASS_COUNT = SYNONYM_CLASSES.length;

/**
 * Look up the synonyms of a single token.
 *
 * @param {string} token - lowercase token from _tokenize.
 * @returns {string[]}   - synonyms (empty array if none).
 */
function lookupSynonyms(token) {
  if (typeof token !== 'string') return [];
  const syns = SYNONYM_MAP[token.toLowerCase()];
  return syns ? Array.from(syns) : [];
}

/**
 * Expand a set of query tokens with their synonyms.
 *
 * @param {Iterable<string>|Set<string>} tokens - Original query tokens.
 * @param {{ enabled: boolean }} options
 * @returns {{ tokens: Set<string>, expansions: Array<{from: string, to: string}> }}
 *   - tokens:     union of original tokens and their synonyms.
 *   - expansions: list of (from, to) pairs that were added, in deterministic
 *                 order (sorted by from then to).
 *
 * When options.enabled === false, returns the input tokens unchanged with
 * an empty expansions list.
 */
function _expandSynonyms(tokens, options) {
  const inputSet = tokens instanceof Set ? tokens : new Set(tokens || []);

  if (!options || options.enabled !== true) {
    return { tokens: new Set(inputSet), expansions: [] };
  }

  const expanded = new Set(inputSet);
  const expansions = [];

  // Collect (from, to) pairs from synonym lookup.
  for (const tok of inputSet) {
    if (typeof tok !== 'string') continue;
    const syns = SYNONYM_MAP[tok.toLowerCase()];
    if (!syns) continue;
    for (const s of syns) {
      // Only count as an "expansion" if it wasn't already in the original query.
      // This keeps the audit trail focused on what the feature actually added.
      if (!inputSet.has(s) && !expanded.has(s)) {
        expanded.add(s);
        expansions.push({ from: tok, to: s });
      } else if (!inputSet.has(s)) {
        // Another token already added `s` as its synonym — still add a pair
        // to the audit trail so operators can see the multi-hop reach.
        expansions.push({ from: tok, to: s });
      }
    }
  }

  // Deterministic ordering for reproducible audit output.
  expansions.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return 0;
  });

  return { tokens: expanded, expansions };
}

module.exports = {
  SYNONYM_MAP,
  SYNONYM_CLASSES,
  SYNONYM_WORD_COUNT,
  SYNONYM_CLASS_COUNT,
  lookupSynonyms,
  _expandSynonyms,
};
