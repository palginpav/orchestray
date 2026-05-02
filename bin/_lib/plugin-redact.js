'use strict';

/**
 * plugin-redact.js — argument redactor for plugin_tool_invoked audit events.
 *
 * Redaction-rule priority order (applied in this order):
 *   1. Sensitive fieldname  — key matches password/secret/token/etc. regex
 *   2. Sensitive path       — value is a path under ~/.ssh, ~/.gnupg, .env, id_rsa, etc.
 *   3. Secret pattern       — value matches JWT, GitHub PAT, AWS key, hex, Bearer regex
 *   4. Long string          — value length > opts.maxStringLength (default 200)
 *   5. Safe passthrough     — keys in SAFE_PASSTHROUGH_KEYS skip all rules above
 *   6. Recursion            — objects/arrays recurse; depth capped at 6 levels
 *
 * Path-shaped value patterns (private-key locations, .env files, etc.) — see
 * SENSITIVE_PATH_PATTERNS below. Wave 1 reviewer dropped the
 * SECURITY_SENSITIVE_PATHS spread because its repo-path patterns
 * (e.g. /token/i, /permission/i) over-redacted arbitrary prose values.
 * for file-path-matching patterns (those regexes test repo-relative paths, not
 * arbitrary string values). For value-level path detection we use the more
 * specific set: ~/.ssh/, ~/.gnupg/, .env, id_rsa, id_ed25519.
 *
 * Pure function — no IO, no side effects. Safe to call in any hook context.
 */

// SECURITY_SENSITIVE_PATHS removed in Wave 1 closeout — see comment block
// below SENSITIVE_PATH_PATTERNS. The require is preserved as a doc-link only.
// const { SECURITY_SENSITIVE_PATHS } = require('./security-sensitive-paths');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STRING_LENGTH = 200;
const TRUNCATE_PREFIX_LENGTH = 80;
const MAX_RECURSION_DEPTH = 6;

/**
 * Keys whose values are always passed through unredacted (project identifiers,
 * not secrets). Generic-hex rule (#3d) is also suppressed for these keys.
 *
 * Exception: 'path' key uses conditional passthrough — only relative project-local
 * paths are safe. Absolute paths (starting with / or ~) are still subject to the
 * sensitive-path rule.
 */
const SAFE_PASSTHROUGH_KEYS = new Set([
  'id',
  'uuid',
  'task_id',
  'orchestration_id',
  'agent_type',
  'model',
  'effort',
  'name',
  'version',
]);

// 'path' key gets conditional passthrough (relative-only). Checked separately.
const CONDITIONAL_PASSTHROUGH_KEYS = new Set(['path']);

/**
 * Keys whose string values must be fully redacted regardless of content
 * (fieldname rule — rule #1).
 */
const SENSITIVE_FIELDNAME_RE = /^(password|secret|api_?key|token|auth|credential|authorization|cookie|session)$/i;

/**
 * Value-level path patterns that indicate sensitive filesystem locations
 * (rule #2). Value-specific patterns ONLY — `~/.ssh/`, `~/.gnupg/`, `.env`
 * files, private key filenames.
 *
 * Wave 1 reviewer (W-SEC-14) finding: SECURITY_SENSITIVE_PATHS contains
 * substring patterns like /token/i and /permission/i designed to match
 * repo-relative file paths (e.g. detecting that a code path is
 * security-sensitive). When applied as value-content patterns those
 * substrings match arbitrary prose like "token validation failed",
 * causing false-positive [REDACTED:path] entries in audit logs.
 *
 * Resolution: drop the SECURITY_SENSITIVE_PATHS spread. Path-content
 * detection now relies SOLELY on the value-specific path-shaped patterns
 * below (private-key locations, .env files, etc.). Sensitive-fieldname
 * (rule #1) and secret-pattern (rule #3 + GENERIC_HEX_RE) cover token /
 * password / api_key keys and values.
 */
const SENSITIVE_PATH_PATTERNS = [
  // Value-specific: common private key / credential paths
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
  /[/\\]\.env(\b|$)/i,   // .env, .env.local, .env.production, etc.
  /\bid_rsa\b/i,
  /\bid_ed25519\b/i,
];

/**
 * Secret-pattern regexes (rule #3). Applied only to non-safe-passthrough keys.
 */
const SECRET_PATTERNS = [
  // JWT-like: three base64url segments
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  // GitHub PAT (classic + fine-grained: gho_, ghp_, ghu_, ghs_, ghr_)
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  // AWS access key ID
  /\bAKIA[A-Z0-9]{16}\b/,
  // Bearer token in header values
  /\bBearer\s+[A-Za-z0-9_.-]{16,}\b/i,
  // Generic 32+ hex string — applied only when key NOT in SAFE_PASSTHROUGH_KEYS
  // (handled separately below so we can check the key context)
];

// Separate regex for generic hex so we can gate it on key context
const GENERIC_HEX_RE = /\b[a-f0-9]{32,}\b/i;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a string value looks like an absolute path (/...) or
 * home-relative path (~...). Used to implement conditional passthrough for
 * the 'path' key: only relative project-local paths are safe.
 * @param {string} v
 * @returns {boolean}
 */
function _isAbsolutePath(v) {
  return v.startsWith('/') || v.startsWith('~');
}

// ---------------------------------------------------------------------------
// classifyArg
// ---------------------------------------------------------------------------

/**
 * Classify a single key/value pair to determine redaction reason.
 *
 * @param {string} key
 * @param {*} value
 * @returns {'safe'|'long-string'|'secret-pattern'|'sensitive-fieldname'|'sensitive-path'}
 */
function classifyArg(key, value) {
  // Safe-passthrough keys bypass all classification
  if (SAFE_PASSTHROUGH_KEYS.has(key)) {
    return 'safe';
  }

  // Conditional passthrough: 'path' key only safe for relative paths
  if (CONDITIONAL_PASSTHROUGH_KEYS.has(key) && typeof value === 'string') {
    if (!_isAbsolutePath(value)) {
      return 'safe';
    }
    // Fall through — absolute path still subject to rules 2+
  }

  // Rule 1: sensitive fieldname
  if (SENSITIVE_FIELDNAME_RE.test(key)) {
    return 'sensitive-fieldname';
  }

  if (typeof value === 'string') {
    // Rule 2: sensitive path
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(value)) {
        return 'sensitive-path';
      }
    }

    // Rule 3: secret patterns (excluding generic hex — handled below)
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) {
        return 'secret-pattern';
      }
    }

    // Rule 4: long string — checked BEFORE generic hex so large blobs
    // are truncated rather than misidentified as secrets
    if (value.length > DEFAULT_MAX_STRING_LENGTH) {
      return 'long-string';
    }

    // Rule 3d: generic hex (only for non-safe-passthrough keys)
    if (GENERIC_HEX_RE.test(value)) {
      return 'secret-pattern';
    }
  }

  return 'safe';
}

// ---------------------------------------------------------------------------
// Internal recursive worker
// ---------------------------------------------------------------------------

/**
 * @param {*} value
 * @param {string|null} key  — parent key (null for array elements / root)
 * @param {number} depth
 * @param {number} maxStringLength
 * @returns {*}
 */
function _redactValue(value, key, depth, maxStringLength) {
  if (depth > MAX_RECURSION_DEPTH) {
    return '[REDACTED:depth-exceeded]';
  }

  // Recurse into arrays (key context is not meaningful for elements)
  if (Array.isArray(value)) {
    return value.map(el => _redactValue(el, null, depth + 1, maxStringLength));
  }

  // Recurse into plain objects.
  //
  // Wave 1 reviewer (W-SEC-10) finding: skip __proto__ / prototype /
  // constructor own-keys. Mirrors plugin-manifest-schema.js#scrubPrototype.
  // Without this guard, an attacker-controlled args object created via
  // JSON.parse('{"__proto__":{...}}') could copy a poisonous own-key into the
  // redacted output. Output uses plain {} (Object.prototype) to preserve
  // deepStrictEqual semantics for callers; security comes from skipping
  // dangerous keys during iteration, not from the prototype chain.
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
      out[k] = _redactValue(v, k, depth + 1, maxStringLength);
    }
    return out;
  }

  // Non-string primitives pass through (numbers, booleans, null, undefined)
  if (typeof value !== 'string') {
    return value;
  }

  // String redaction — only meaningful when we have a key context
  const effectiveKey = key !== null ? key : '';

  // Safe-passthrough: skip all rules
  if (SAFE_PASSTHROUGH_KEYS.has(effectiveKey)) {
    return value;
  }

  // Conditional passthrough: 'path' key safe only for relative paths
  if (CONDITIONAL_PASSTHROUGH_KEYS.has(effectiveKey)) {
    if (!_isAbsolutePath(value)) {
      return value;
    }
    // Fall through — absolute path subject to rules 2+
  }

  // Rule 1: sensitive fieldname
  if (effectiveKey && SENSITIVE_FIELDNAME_RE.test(effectiveKey)) {
    return '[REDACTED:fieldname]';
  }

  // Rule 2: sensitive path
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(value)) {
      return '[REDACTED:path]';
    }
  }

  // Rule 3: secret patterns (non-generic-hex)
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      return '[REDACTED:secret]';
    }
  }

  // Rule 4: long string — checked BEFORE generic hex so large blobs
  // are truncated rather than misidentified as secrets
  if (value.length > maxStringLength) {
    const prefix = value.slice(0, TRUNCATE_PREFIX_LENGTH);
    return `${prefix}... [TRUNCATED ${value.length} chars]`;
  }

  // Rule 3d: generic hex (after long-string so truncation wins on large blobs)
  if (GENERIC_HEX_RE.test(value)) {
    return '[REDACTED:secret]';
  }

  return value;
}

// ---------------------------------------------------------------------------
// redactArgs (public)
// ---------------------------------------------------------------------------

/**
 * Deep-copy and redact a tool-argument value before audit-event persistence.
 *
 * @param {*} args — any JSON-serializable value (typically an object)
 * @param {{ maxStringLength?: number }} [opts]
 * @returns {*} redacted copy
 */
function redactArgs(args, opts = {}) {
  const maxStringLength =
    typeof opts.maxStringLength === 'number' && opts.maxStringLength > 0
      ? opts.maxStringLength
      : DEFAULT_MAX_STRING_LENGTH;

  return _redactValue(args, null, 0, maxStringLength);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { redactArgs, classifyArg };
