'use strict';

/**
 * R-RV-DIMS reviewer dimension classifier (v2.1.16).
 *
 * Pure function that maps a developer's `files_changed` set + optional context
 * to a `review_dimensions` value. The PM calls this before every reviewer
 * `Agent()` spawn. The reviewer's core prompt always evaluates Correctness +
 * Security; this function only chooses the OPTIONAL additive dimensions.
 *
 * Design source: .orchestray/kb/artifacts/v2116-w6-rv-dims-design.md §4
 *
 * Allowed return values for `review_dimensions`:
 *   - "all"  — load all 5 optional fragments (default / fallback)
 *   - string[] subset of:
 *     ["code-quality", "performance", "documentation", "operability", "api-compat"]
 *
 * Invariant: "correctness" and "security" are NEVER returned in the array form;
 * they live in reviewer.md core and load on every spawn.
 */

const ALL_OPTIONAL = [
  'code-quality',
  'performance',
  'documentation',
  'operability',
  'api-compat',
];

const SECURITY_PATH_PATTERNS = [
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

function isDocPath(p) {
  // R-RV-DIMS F-001 fix (v2.1.16 W12-fix): exclude UI/CLI archetype paths from
  // the doc-only heuristic. `agents/*.md` are system-prompt code and
  // `skills/**/SKILL.md` are command surfaces — neither is documentation.
  // Without this exclusion, rule 4 (doc-only) wins over rule 5 (UI/CLI) for
  // lone agent-prompt diffs because both match — first-match-wins picks rule 4
  // and reviewers lose code-quality + operability scoping. See
  // .orchestray/kb/artifacts/v2116-w12-release-review.md F-001.
  if (/^agents\/[^/]+\.md$/.test(p)) return false;
  if (/^skills\/.+\/SKILL\.md$/.test(p)) return false;
  return /\.md$/i.test(p)
    || /^docs\//.test(p)
    || /(^|\/)docs\//.test(p)
    || /(^|\/)README/i.test(p)
    || /(^|\/)CHANGELOG/i.test(p);
}

function isUiCliPath(p) {
  // agents/*.md (top-level only — fragments under agents/foo/bar/baz.md don't qualify)
  if (/^agents\/[^/]+\.md$/.test(p)) return true;
  if (/^skills\/.+\/SKILL\.md$/.test(p)) return true;
  if (/(^|\/)bin\/[^/]*statusline[^/]*$/.test(p)) return true;
  if (/(^|\/)bin\/[^/]*config[^/]*$/.test(p)) return true;
  if (/(^|\/)lib\/messages/.test(p)) return true;
  if (/(^|\/)lib\/help/.test(p)) return true;
  return false;
}

function isBackendPath(p) {
  // bin/*.js excluding statusline/help/config (those are UI/CLI archetype)
  if (/^bin\/[^/]+\.js$/.test(p)
    && !/statusline/.test(p)
    && !/help/.test(p)
    && !/config/.test(p)) {
    return true;
  }
  if (/^mcp-server\//.test(p)) return true;
  if (/^bin\/validate-/.test(p)) return true;
  if (/^bin\/inject-/.test(p)) return true;
  if (/^bin\/preflight-/.test(p)) return true;
  if (p === 'agents/pm-reference/event-schemas.md') return true;
  return false;
}

function isConfigSchemaPath(p) {
  if (/^agents\/pm-reference\/.*-schemas\.md$/.test(p)) return true;
  if (/\.schema\.json$/.test(p)) return true;
  if (/\.orchestray\/config\.json$/.test(p)) return true;
  if (/(^|\/)schemas\/.+\.js$/.test(p)) return true;
  return false;
}

function isSecuritySensitive(p) {
  return SECURITY_PATH_PATTERNS.some((rx) => rx.test(p));
}

/**
 * Classify reviewer dimensions based on the diff/context.
 *
 * @param {Object} input
 * @param {string[]} input.files_changed - repo-relative paths from developer result
 * @param {string|null} [input.diff_text] - optional raw diff for keyword scan (unused today)
 * @param {string|null} [input.task_kind] - "doc"|"ui"|"backend-api"|"config"|"general"|null
 * @param {Object} [input.config] - { enabled: boolean }
 * @returns {{review_dimensions: ("all"|string[]), rationale: string}}
 */
function classifyReviewDimensions(input) {
  const files_changed = Array.isArray(input && input.files_changed)
    ? input.files_changed
    : [];
  const config = (input && input.config) || { enabled: true };

  // Rule 1 — kill switch
  if (config.enabled === false
    || process.env.ORCHESTRAY_DISABLE_REVIEWER_SCOPING === '1') {
    return {
      review_dimensions: 'all',
      rationale: 'review_dimension_scoping disabled (config or env)',
    };
  }

  // Rule 2 — empty diff
  if (files_changed.length === 0) {
    return {
      review_dimensions: 'all',
      rationale: 'empty diff — defensive fallback',
    };
  }

  // Rule 3 — security-sensitive paths win (security stays in core, optional set
  // is the surrounding-quality archetype)
  const securityHit = files_changed.find((p) => isSecuritySensitive(p));
  if (securityHit) {
    return {
      review_dimensions: ['code-quality', 'operability', 'api-compat'],
      rationale: `security-sensitive path: ${truncate(securityHit, 80)}`,
    };
  }

  // Rule 4 — doc-only diff (every path matches doc heuristic)
  if (files_changed.every((p) => isDocPath(p))) {
    return {
      review_dimensions: ['documentation'],
      rationale: `doc-only diff: ${exampleList(files_changed)}`,
    };
  }

  // Rule 5 — UI / CLI / message-string archetype
  if (files_changed.every((p) => isUiCliPath(p) || isDocPath(p))
    && files_changed.some((p) => isUiCliPath(p))) {
    return {
      review_dimensions: ['code-quality', 'documentation', 'operability'],
      rationale: `UI/CLI archetype: ${exampleList(files_changed)}`,
    };
  }

  // Rule 6 — Backend / data-path archetype
  if (files_changed.some((p) => isBackendPath(p))) {
    return {
      review_dimensions: ['code-quality', 'performance', 'operability', 'api-compat'],
      rationale: `backend/data-path archetype: ${exampleList(files_changed)}`,
    };
  }

  // Rule 7 — Config / schema archetype
  if (files_changed.every((p) => isConfigSchemaPath(p) || isDocPath(p))
    && files_changed.some((p) => isConfigSchemaPath(p))) {
    return {
      review_dimensions: ['api-compat', 'documentation', 'operability'],
      rationale: `config/schema archetype: ${exampleList(files_changed)}`,
    };
  }

  // Rule 8 — fallback
  return {
    review_dimensions: 'all',
    rationale: `unclassified — fallback to all: ${exampleList(files_changed)}`,
  };
}

function exampleList(files) {
  // Return up to 2 path examples, comma-joined
  return files.slice(0, 2).map((p) => truncate(p, 50)).join(', ');
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

module.exports = {
  classifyReviewDimensions,
  ALL_OPTIONAL,
};
