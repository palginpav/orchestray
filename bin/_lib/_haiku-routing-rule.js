'use strict';

const path = require('path');

/**
 * _haiku-routing-rule.js — Pure decision helper for the PM Section 23
 * inline-vs-scout rule (P2.2, v2.2.0).
 *
 * Extracted from the prose pseudocode in `agents/pm.md` Section 23 so the
 * decision logic is directly testable without spawning a subagent.
 *
 * Inputs (caller-supplied):
 *   args.op_kind      : 'Read' | 'Glob' | 'Grep' | 'Edit' | 'Write' | 'Bash' | ...
 *   args.target_path  : absolute path string or null
 *   args.target_bytes : non-negative integer (0 if N/A)
 *   args.class_hint   : 'A' | 'B' | 'C' | 'D'
 *
 *   config.haiku_routing.enabled            : boolean
 *   config.haiku_routing.scout_min_bytes    : positive integer (default 12288)
 *   config.haiku_routing.scout_blocked_ops  : string[] (default [Edit, Write, Bash])
 *   config.haiku_routing.scout_blocked_paths: string[] glob patterns
 *
 *   env.ORCHESTRAY_HAIKU_ROUTING_DISABLED   : '1' acts as session kill switch
 *
 * Returns boolean — true if the PM should spawn `haiku-scout` for this op.
 *
 * Design note: this function is pure (no fs, no spawn, no audit emit). The
 * PM emits the `[routing: <class>/<inline_or_scout>]` marker AROUND the call
 * to this rule; `bin/capture-pm-turn.js` parses the marker into the schema_v2
 * pm_turn fields. Decoupling rule from emit keeps tests trivially fast.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  scout_min_bytes: 12288,
  scout_blocked_ops: Object.freeze(['Edit', 'Write', 'Bash']),
  scout_blocked_paths: Object.freeze([
    '.orchestray/state/*',
    '.orchestray/audit/*',
    'bin/_lib/_haiku-routing-rule.js',
    '.git/**',
    'node_modules/**',
  ]),
});

/**
 * Minimal fnmatch-style glob matcher covering the path patterns the rule
 * actually ships with. Supports `**` (any depth incl. zero), `*` (one
 * segment) and exact substring fallback. Sufficient for the v2.2.0 default
 * patterns; intentionally NOT a full POSIX glob.
 *
 * @param {string} pathStr
 * @param {string} pattern
 * @returns {boolean}
 */
function _globMatch(pathStr, pattern) {
  if (typeof pathStr !== 'string' || typeof pattern !== 'string') return false;
  // Build a regex from the pattern. Escape regex metas, then translate `**`
  // and `*` into appropriate regex fragments.
  const re = pattern
    .split('')
    .reduce((acc, ch, i, src) => {
      if (ch === '*' && src[i + 1] === '*') {
        // Marker for `**` — the second `*` is consumed by the next iteration
        // returning the empty string via the marker we plant here.
        if (src[i - 1] === '*') return acc + '';
        return acc + '__GLOBSTAR__';
      }
      if (ch === '*') {
        if (src[i - 1] === '*') return acc + ''; // consumed by the marker
        return acc + '__SINGLESTAR__';
      }
      if (/[.+^${}()|[\]\\]/.test(ch)) return acc + '\\' + ch;
      if (ch === '?') return acc + '.';
      return acc + ch;
    }, '');
  const regexSource = '^' + re
    .replace(/__GLOBSTAR__/g, '.*')
    .replace(/__SINGLESTAR__/g, '[^/]*') + '$';
  let regex;
  try { regex = new RegExp(regexSource); } catch (_e) { return false; }
  if (regex.test(pathStr)) return true;
  // Suffix-match fallback for patterns that look relative (no leading slash):
  // a pattern like `agents/**` should match `/abs/path/to/agents/foo.md`.
  if (!pattern.startsWith('/')) {
    const suffixRegex = new RegExp('(?:^|/)' + regexSource.slice(1));
    if (suffixRegex.test(pathStr)) return true;
  }
  return false;
}

/**
 * Resolve effective config: caller's haiku_routing block overlaid on defaults.
 * @param {object|undefined} config - { haiku_routing: {...} } or {} or undefined.
 * @returns {{enabled: boolean, scout_min_bytes: number, scout_blocked_ops: string[], scout_blocked_paths: string[]}}
 */
function _resolveConfig(config) {
  const c = (config && config.haiku_routing) || {};
  return {
    enabled: c.enabled !== false ? (c.enabled !== undefined ? !!c.enabled : DEFAULTS.enabled) : false,
    scout_min_bytes: Number.isInteger(c.scout_min_bytes) && c.scout_min_bytes > 0
      ? c.scout_min_bytes
      : DEFAULTS.scout_min_bytes,
    scout_blocked_ops: Array.isArray(c.scout_blocked_ops)
      ? c.scout_blocked_ops.slice()
      : DEFAULTS.scout_blocked_ops.slice(),
    scout_blocked_paths: Array.isArray(c.scout_blocked_paths)
      ? c.scout_blocked_paths.slice()
      : DEFAULTS.scout_blocked_paths.slice(),
  };
}

/**
 * Decide whether the PM should spawn a haiku-scout for this op.
 *
 * @param {object} input
 * @param {object} [input.config]   - { haiku_routing: {...} }
 * @param {object} [input.env]      - Environment variables map.
 * @param {object} input.args       - { op_kind, target_path, target_bytes, class_hint }
 * @returns {boolean}
 */
function shouldSpawnScout(input) {
  if (!input || typeof input !== 'object') return false;
  const args = input.args || {};
  const env = input.env || {};
  const cfg = _resolveConfig(input.config);

  // Layer 1: kill switches.
  if (!cfg.enabled) return false;
  if (env.ORCHESTRAY_HAIKU_ROUTING_DISABLED === '1') return false;

  // Layer 2: class gate.
  const cls = args.class_hint;
  if (cls === 'A' || cls === 'C' || cls === 'D') return false;
  if (cls !== 'B') return false; // unknown / null class is fail-safe inline.

  // Layer 3: blocked ops (writes never delegate, regardless of size).
  const op = args.op_kind;
  if (!op || typeof op !== 'string') return false;
  if (cfg.scout_blocked_ops.indexOf(op) !== -1) return false;
  if (op !== 'Read' && op !== 'Glob' && op !== 'Grep') return false;

  // Layer 4: blocked paths (PM-trusted paths stay inline).
  // S-002 (v2.2.0 fix-pass): path.resolve normalizes `.` / `..` segments and
  // any embedded relative path before glob-matching. This blocks the
  // symlink-alias / case-sensitive bypass surveyed in the W7 audit
  // (CWE-22). We do NOT call fs.realpathSync — symlink dereference is
  // outside the threat model for Linux deployments and adds an fs hit per
  // call. Caller-supplied absolute paths are unaffected.
  const rawPath = args.target_path;
  if (typeof rawPath === 'string' && rawPath.length > 0) {
    let resolved;
    try {
      resolved = path.resolve(rawPath);
    } catch (_e) {
      resolved = rawPath;
    }
    for (const pat of cfg.scout_blocked_paths) {
      if (_globMatch(resolved, pat)) return false;
      // Also check the raw path so callers passing pre-relative strings
      // (the test suite, e.g., target_path = 'agents/pm.md') still match
      // the relative-pattern suffix-match path in _globMatch.
      if (_globMatch(rawPath, pat)) return false;
    }
  }

  // Layer 5: byte threshold (inclusive lower bound at scout_min_bytes).
  const bytes = Number(args.target_bytes);
  if (!Number.isFinite(bytes) || bytes < cfg.scout_min_bytes) return false;

  return true;
}

module.exports = {
  shouldSpawnScout,
  DEFAULTS,
  _globMatch, // exported for direct testing
  _resolveConfig,
};
