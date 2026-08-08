'use strict';

/**
 * pattern-citation-render.js — CiteCache rendering helper.
 *
 * Given a list of pattern_find match objects and the target agent type, returns
 * the formatted citation block for inclusion in a delegation prompt.
 *
 * Rules:
 *   - EVERY citation carries the pattern body. Subagents do not share a
 *     context window, so a bodyless citation hands the receiving agent a dead
 *     link — the defect recorded in
 *     `.orchestray/kb/decisions/pattern-citation-uri-without-body.md`, where a
 *     tester filed a sincere `patterns_rejected` entry ("pattern file not
 *     found") for a pattern that exists in two tiers.
 *   - First cite in an orchestration: body with [local]/[team]/[shared] label.
 *     Records the slug in pattern-seen-set.jsonl.
 *   - Subsequent cites in the same orchestration: body PLUS a
 *     "[CACHED — loaded by {firstAgent}, hash {h6}]" annotation. The marker is
 *     now informational (who else in this orchestration holds this pattern),
 *     not a substitute for the body.
 *   - Reviewer exception: reviewers never get the [CACHED] annotation at all.
 *   - Config opt-out: if cite_cache === false, no seen-set I/O and no marker.
 *   - Every citation carries an explicit `slug: <exact>` line. Agents echo an
 *     identifier they can see; when only a URI is visible inside prose they
 *     reach for the pattern file's own frontmatter `name:` instead (live
 *     evidence: `anti-pattern-regex-false-positives.md` declares
 *     `name: regex-false-positive-check`, and that is verbatim what the ack
 *     carried). The `slug:` line is the one string the ack contract accepts.
 *
 * @module pattern-citation-render
 */

const { recordSeen, isSeenInOrch } = require('./pattern-seen-set');

/**
 * Derive the bracket label for a pattern citation.
 * @param {object} match  A pattern_find match object.
 * @returns {string}
 */
function _label(match) {
  if (!match) return '[local]';
  if (match.source === 'team') return '[team]';
  if (match.source !== 'shared') return '[local]';
  if (match.promoted_is_own) return '[shared, own]';
  return '[shared]';
}

/**
 * Build the suffix line for a pattern citation (conf + applied + from).
 * @param {object} match
 * @returns {string}
 */
function _suffix(match) {
  const conf    = match.confidence != null ? match.confidence : '?';
  const applied = match.times_applied != null ? match.times_applied + 'x' : '0x';
  let suffix = `conf ${conf}, applied ${applied}`;
  if (match.source === 'shared' && match.promoted_from) {
    suffix += `, from ${match.promoted_from}`;
    if (match.promoted_is_own) suffix += ' (this project)';
  }
  return suffix;
}

/**
 * Header lines for a citation: the URI label, then the exact slug on its own
 * line (Gap B — the only string `patterns_used` matching accepts), then the
 * resolved file when the caller supplied one (an agent that wants to verify,
 * or that hit a truncated body, has somewhere to go).
 *
 * @param {object} match
 * @returns {string}
 */
function _head(match) {
  const lines = [
    `- @orchestray:pattern://${match.slug}     ${_label(match)}     ${_suffix(match)}`,
    `  slug: ${match.slug}`,
  ];
  if (match.file_rel) lines.push(`  source_file: ${match.file_rel}`);
  return lines.join('\n');
}

/**
 * @param {object} match
 * @returns {string}
 */
function _body(match) {
  return match.body || match.description || '(no body available)';
}

/**
 * Render a single pattern citation. Always includes the body — see the module
 * header for why no branch may omit it.
 *
 * @param {object} match        A pattern_find match object with at minimum
 *                              { slug, body, source, confidence, times_applied }.
 *                              Optional `file_rel` renders a source_file line.
 * @param {string} agentType    The target agent type (e.g. 'reviewer', 'developer').
 * @param {string} orchId       Current orchestration id.
 * @param {boolean} citeCache   Whether CiteCache is enabled (default true).
 * @param {string} [projectRoot]
 * @returns {string}  The formatted citation string for this pattern.
 */
function renderCitation(match, agentType, orchId, citeCache, projectRoot) {
  if (!match || !match.slug) return '';

  const head = _head(match);
  const body = _body(match);

  // P1-08 (v2.2.15): reviewers never see the [CACHED] annotation. Explicit
  // early return before any cache look-up so the cached branch is unreachable
  // for reviewer agents regardless of citeCache state.
  if (agentType === 'reviewer') {
    if (orchId && citeCache) {
      // Still record so subsequent non-reviewer agents get the cached annotation.
      recordSeen(orchId, match.slug, body, agentType, projectRoot);
    }
    return `${head}\n\n${body}`;
  }

  // CiteCache disabled — no seen-set I/O, no annotation.
  if (!citeCache) return `${head}\n\n${body}`;

  const { seen, firstAgent, hashShort } = isSeenInOrch(orchId, match.slug, projectRoot);

  if (seen && firstAgent) {
    // Cached cite — annotate provenance, still ship the body. This agent has
    // its own context window and never saw the first agent's copy.
    return `${head}\n  [CACHED — loaded by ${firstAgent}, hash ${hashShort}]\n\n${body}`;
  }

  recordSeen(orchId, match.slug, body, agentType, projectRoot);
  return `${head}\n\n${body}`;
}

// Gap B: the echo instruction sits with the citations, not in a distant
// protocol file, and names the frontmatter `name:` trap explicitly.
const ECHO_INSTRUCTION = [
  'Each entry below is a pattern offered for this task, followed by its full text.',
  'Copy the `slug:` value **verbatim** into `patterns_used` / `patterns_rejected` in',
  'your Structured Result — a shortened, re-worded, or re-derived slug scores as no',
  'acknowledgement. If a pattern\'s own text declares a different `name:`, ignore it;',
  'the `slug:` line above the body is the identifier.',
].join('\n');

/**
 * Render the full ## Patterns Applied block for a delegation prompt.
 *
 * @param {Array<object>} matches   Array of pattern_find match objects.
 * @param {string} agentType        Target agent type.
 * @param {string} orchId           Current orchestration id.
 * @param {boolean} [citeCache=true] Whether CiteCache is enabled.
 * @param {string} [projectRoot]
 * @returns {string}  Full section text, or '' if matches is empty.
 */
function renderPatternsApplied(matches, agentType, orchId, citeCache = true, projectRoot) {
  if (!matches || matches.length === 0) return '';

  const lines = ['## Patterns Applied', '', ECHO_INSTRUCTION, ''];
  const rendered = [];
  for (const match of matches) {
    const citation = renderCitation(match, agentType, orchId, citeCache, projectRoot);
    if (citation) { lines.push(citation, ''); rendered.push(match.slug); }
  }
  if (rendered.length === 0) return '';
  // Bodies push the header instruction far up the prompt; repeat it last, where
  // this block sits at the very end of the delegation prompt.
  lines.push(
    'Reminder — echo these slugs verbatim in `patterns_used` / `patterns_rejected`: ' +
      rendered.join(', '),
    ''
  );
  return lines.join('\n');
}

module.exports = { renderCitation, renderPatternsApplied, ECHO_INSTRUCTION };
