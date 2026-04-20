'use strict';

/**
 * pattern-citation-render.js — CiteCache rendering helper.
 *
 * Given a list of pattern_find match objects and the target agent type, returns
 * the formatted citation block for inclusion in a delegation prompt.
 *
 * Rules:
 *   - First cite in an orchestration: full body with [local]/[shared] label.
 *     Records the slug in pattern-seen-set.jsonl.
 *   - Subsequent cites in the same orchestration: one-line cached reference
 *     "[CACHED — loaded by {firstAgent}, hash {h6}]".
 *   - Reviewer exception: reviewers ALWAYS receive full bodies regardless of
 *     cache state. A reviewer seeing a [CACHED] cite is a bug.
 *   - Config opt-out: if cite_cache === false, always emit full bodies.
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
  if (!match || match.source !== 'shared') return '[local]';
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
 * Render a single pattern citation (either full body or cached reference).
 *
 * @param {object} match        A pattern_find match object with at minimum
 *                              { slug, body, source, confidence, times_applied }.
 * @param {string} agentType    The target agent type (e.g. 'reviewer', 'developer').
 * @param {string} orchId       Current orchestration id.
 * @param {boolean} citeCache   Whether CiteCache is enabled (default true).
 * @param {string} [projectRoot]
 * @returns {string}  The formatted citation string for this pattern.
 */
function renderCitation(match, agentType, orchId, citeCache, projectRoot) {
  if (!match || !match.slug) return '';

  const label = _label(match);
  const suffix = _suffix(match);

  // Reviewer always gets full body regardless of cache state.
  const isReviewer = agentType === 'reviewer';

  // If CiteCache is disabled or agent is reviewer, always emit full body.
  if (!citeCache || isReviewer) {
    const body = match.body || match.description || '(no body available)';
    if (orchId && citeCache) {
      // Still record so subsequent non-reviewer agents get cached cite.
      recordSeen(orchId, match.slug, body, agentType, projectRoot);
    }
    return `- @orchestray:pattern://${match.slug}     ${label}     ${suffix}\n\n${body}`;
  }

  // Check if already seen in this orchestration.
  const { seen, firstAgent, hashShort } = isSeenInOrch(orchId, match.slug, projectRoot);

  if (seen && firstAgent) {
    // Cached cite — emit one-line reference only.
    return (
      `- @orchestray:pattern://${match.slug}     ${label}     ${suffix}\n` +
      `  [CACHED — loaded by ${firstAgent}, hash ${hashShort}]`
    );
  }

  // First cite — emit full body and record in seen-set.
  const body = match.body || match.description || '(no body available)';
  recordSeen(orchId, match.slug, body, agentType, projectRoot);
  return `- @orchestray:pattern://${match.slug}     ${label}     ${suffix}\n\n${body}`;
}

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

  const lines = ['## Patterns Applied', ''];
  for (const match of matches) {
    const citation = renderCitation(match, agentType, orchId, citeCache, projectRoot);
    if (citation) lines.push(citation, '');
  }
  return lines.join('\n');
}

module.exports = { renderCitation, renderPatternsApplied };
