'use strict';

/**
 * security-sensitive-paths.js — canonical SECURITY_SENSITIVE_PATHS list.
 *
 * Single source of truth for path patterns that trigger security-sensitive
 * review scoping in classify-review-dimensions.js and pm.md §3.RV.
 *
 * Both consumers MUST derive from this export. Adding a pattern here
 * automatically propagates to the PM's reviewer dimension classifier.
 * Do NOT maintain a separate list in either caller.
 *
 * Pattern semantics: each entry is a RegExp tested against a repo-relative
 * file path string. A match signals that the changed file is security-sensitive.
 */

const SECURITY_SENSITIVE_PATHS = [
  /(^|\/)auth\//i,
  /(^|\/)crypto\//i,
  /secrets?/i,
  /(^|\/)bin\/validate-/i,
  /(^|\/)hooks\/hooks\.json$/,
  /(^|\/)\.claude\/settings\.json$/,
  /(^|\/)mcp-server\//,
  /permission/i,
  /token/i,
  /password/i,
  /(^|\/|[^a-z])key([^a-z]|$)/i,
];

module.exports = { SECURITY_SENSITIVE_PATHS };
