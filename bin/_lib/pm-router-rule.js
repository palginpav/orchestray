'use strict';

/**
 * pm-router-rule.js — Pure decision helper for the v2.2.3 P4 A3 PM-router.
 *
 * Mirrors the predicate documented in
 * `.orchestray/kb/artifacts/v223-p4-a3-router-design.md` §2 so the routing
 * decision can be exercised by tests + the parallel-emit hook without
 * spawning an actual `pm-router` agent.
 *
 * Inputs:
 *   args.task_text : raw user prompt (untrusted; treated as data only)
 *   args.config    : { pm_router: {...}, complexity_threshold: int }
 *   args.env       : { ORCHESTRAY_DISABLE_PM_ROUTER: '1'|... }
 *
 * Returns:
 *   { decision: 'solo' | 'escalate' | 'decline',
 *     reason:   '<enum>',
 *     lite_score: 0..12 }
 *
 * Failure mode: any internal error → { decision: 'escalate',
 * reason: 'parse_error_fail_safe' }. Never throws.
 */

const DEFAULTS = Object.freeze({
  enabled: true,
  solo_max_files: 1,
  solo_max_words: 60,
  solo_complexity_threshold_offset: 0,
});

const HARD_DECLINE_KEYWORDS = [
  'stop',
  'abort',
  'cancel',
  'ignore previous',
  'kill orchestray',
];

const ESCALATE_KEYWORDS = [
  'refactor', 'migrate', 'audit', 'investigate', 'diagnose',
  // 'debug' replaced with phrase forms (W3-FP-1): bare 'debug' matched
  // "debug log statement" as a FP. Phrase forms require an action-target word
  // that confirms the user wants investigation, not a code change.
  'debug the', 'debug why', 'debug this', 'debug a', 'debug an',
  'review', 'security', 'redesign', 'rewrite', 'architect', 'design',
  'release', 'ship', 'phase ', 'orchestrate', 'decompose',
  'multi-file', 'cross-cutting', 'implement feature',
  'check why', 'look at', 'figure out', 'find where', 'identify', 'why did', "why didn't",
  // Orchestration-prompt phrases — noun form "orchestration" alone is too
  // broad (e.g., "orchestration logic" should solo). Phrase "orchestration
  // prompt" anchors to prompt-editing tasks specifically.
  'orchestration prompt',
  // Agent/prompt-file phrases (bare "agent" is too broad; use phrases only).
  'prompt file', 'prompt files',
  'agent definition', 'agent definitions',
  'agent prompt', 'agent prompts',
  'agent template', 'agent templates',
  // "prompt for X" patterns — added R3 NEW-1. Bare "prompt for" risks false
  // positives ("prompt for password"). Using multi-word context phrases that
  // require a role/component word adjacent to the phrase keeps FP rate near
  // zero for /orchestray:run usage where "prompt for the orchestrator/pm/agent"
  // always refers to an agent system prompt, not a UI interaction.
  'prompt for the orchestrator', 'prompt for the pm',
  'prompt for the developer', 'prompt for the router',
  'prompt for the agent', 'prompt for the subagent',
  'prompt for the architect', 'prompt for the reviewer',
  // Short aliases / synonyms — added R4 W3-FP-2.
  'prompt for the dev', 'prompt for the qa', 'prompt for the engineer',
  // "instructions for X" phrases — "instructions for the user" is NOT included
  // (user is not an agent role), keeping FP rate near zero.
  'instructions for the orchestrator', 'instructions for the developer',
  'instructions for the architect', 'instructions for the reviewer',
  'instructions for the agent', 'instructions for the pm',
  'instructions for the router', 'instructions for the subagent',
  'instructions for the dev', 'instructions for the tester',
  'instructions for the qa',
];

const PATH_FLOOR_PREFIXES = [
  'agents/', 'agents/pm-reference/', 'bin/', 'hooks/', 'skills/', '.claude/',
];

// Known filenames that belong to protected directories.
// Extend as new agent/bin files are added.
// "router" matches router.md, pm-router.md, etc.
// "SKILL" matches SKILL.md (skills directory protected file).
// "CLAUDE" matches CLAUDE.md (project-root orchestration config) — added R3 NEW-2.
const PATH_FLOOR_FILENAMES = /\b(?:CLAUDE|pm|pm-router|router|phase-decomp|phase-close|phase-verify|tier1-orchestration|scoring-rubrics|event-schemas|handoff-contract|hooks|install|gate-[a-z-]+|validate-[a-z-]+|capture-[a-z-]+|inject-[a-z-]+|emit-[a-z-]+|SKILL)\.(md|js|json)\b/;

const CROSS_CUTTING_TOKENS = [
  'api', 'db', 'auth', 'frontend', 'backend', 'tests', 'docs',
  'ci', 'security',
];

const KEYWORD_PATTERN_TABLE = [
  { score: 3, words: ['migrate', 'refactor', 'redesign', 'rewrite'] },
  { score: 2, words: ['change', 'extend', 'replace'] },
  { score: 1, words: ['add', 'update', 'introduce'] },
  { score: 0, words: ['fix', 'typo'] },
];

/**
 * Resolve effective config: caller's pm_router block overlaid on defaults.
 * @param {object|undefined} config
 * @returns {{enabled: boolean, solo_max_files: number, solo_max_words: number, solo_complexity_threshold_offset: number}}
 */
function _resolveConfig(config) {
  const c = (config && config.pm_router) || {};
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULTS.enabled,
    solo_max_files: Number.isInteger(c.solo_max_files) && c.solo_max_files > 0
      ? c.solo_max_files
      : DEFAULTS.solo_max_files,
    solo_max_words: Number.isInteger(c.solo_max_words) && c.solo_max_words > 0
      ? c.solo_max_words
      : DEFAULTS.solo_max_words,
    solo_complexity_threshold_offset: Number.isInteger(c.solo_complexity_threshold_offset)
      ? c.solo_complexity_threshold_offset
      : DEFAULTS.solo_complexity_threshold_offset,
  };
}

/**
 * Extract path-shaped tokens from task text. Conservative regex: tokens with
 * at least one slash AND a file extension, or bare tokens that look like
 * relative file paths with extensions.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractPathTokens(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  const basenamesFromSlashed = new Set();
  // Match path-shaped runs: chars (no whitespace), at least one '/' or a
  // bare filename with extension.
  const slashRe = /\b[\w@./\-]*\/[\w./\-]+\.\w{1,8}\b/g;
  const m1 = text.match(slashRe);
  if (m1) {
    for (const t of m1) {
      found.add(t);
      // Track basenames so the bare-filename pass below does not
      // double-count the same path.
      const lastSlash = t.lastIndexOf('/');
      if (lastSlash !== -1) basenamesFromSlashed.add(t.slice(lastSlash + 1));
    }
  }
  // Bare filenames with extension (no slash) — e.g., "README.md".
  const bareRe = /\b[\w-]+\.(?:md|js|ts|tsx|jsx|json|jsonl|yml|yaml|py|go|rs|sh|html|css|txt|sql)\b/g;
  const m2 = text.match(bareRe);
  if (m2) {
    for (const t of m2) {
      if (basenamesFromSlashed.has(t)) continue;
      found.add(t);
    }
  }
  return Array.from(found);
}

/**
 * Count multi-step imperative markers (numbered lists, bullet markers,
 * sequence words). Used by the structural complexity gate.
 *
 * @param {string} text
 * @returns {number}
 */
function countMultiStepImperatives(text) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  // Numbered list markers like "1." "2." "3." at line/clause boundaries.
  const numbered = text.match(/(?:^|[\s.])(\d+\.\s+)/g);
  if (numbered) count += numbered.length;
  // Dash bullets at line start.
  const bullets = text.match(/(?:^|\n)\s*-\s+\w/g);
  if (bullets) count += bullets.length;
  // Sequence words.
  if (/\bthen\b/i.test(text)) count++;
  if (/\bafter that\b/i.test(text)) count++;
  if (/\bfirst\b.*\bsecond\b/i.test(text)) count += 2;
  return count;
}

/**
 * Compute the lite-complexity surrogate score (0..12) used when no other
 * signal forces escalation. Mirrors Section 12 dimensions but uses regex /
 * token-count heuristics only — no exploration tools.
 *
 * @param {string} text
 * @param {string[]} paths
 * @returns {number}
 */
function liteComplexityScore(text, paths) {
  if (typeof text !== 'string') return 0;
  const lower = text.toLowerCase();

  // (1) File/module count 0..3.
  const fileScore = Math.min(3, paths.length);

  // (2) Cross-cutting concerns 0..3.
  let crossHits = 0;
  const seen = new Set();
  for (const tok of CROSS_CUTTING_TOKENS) {
    const re = new RegExp('\\b' + tok + '\\b', 'i');
    if (re.test(lower) && !seen.has(tok)) {
      seen.add(tok);
      crossHits++;
    }
  }
  const crossScore = Math.min(3, crossHits);

  // (3) Description length 0..3.
  const wc = text.trim() ? text.trim().split(/\s+/).length : 0;
  let lengthScore = 0;
  if (wc <= 25) lengthScore = 0;
  else if (wc <= 60) lengthScore = 1;
  else if (wc <= 120) lengthScore = 2;
  else lengthScore = 3;

  // (4) Keyword pattern 0..3 — pick the highest-scoring pattern that matches.
  let keywordScore = 0;
  for (const row of KEYWORD_PATTERN_TABLE) {
    if (row.words.some((w) => new RegExp('\\b' + w + '\\b', 'i').test(lower))) {
      keywordScore = Math.max(keywordScore, row.score);
    }
  }

  return fileScore + crossScore + lengthScore + keywordScore;
}

/**
 * Decide router routing for the given task text + config + env. Pure.
 *
 * @param {{task_text: string, config?: object, env?: object}} input
 * @returns {{decision: string, reason: string, lite_score: number}}
 */
function decideRoute(input) {
  try {
    if (!input || typeof input !== 'object') {
      return { decision: 'escalate', reason: 'parse_error_fail_safe', lite_score: 0 };
    }
    const text = typeof input.task_text === 'string' ? input.task_text : '';
    const env = input.env || {};
    const cfg = _resolveConfig(input.config);

    // Kill switches first.
    if (cfg.enabled === false) {
      return { decision: 'escalate', reason: 'router_disabled', lite_score: 0 };
    }
    if (env.ORCHESTRAY_DISABLE_PM_ROUTER === '1') {
      return { decision: 'escalate', reason: 'router_disabled', lite_score: 0 };
    }

    if (!text || !text.trim()) {
      return { decision: 'escalate', reason: 'parse_error_fail_safe', lite_score: 0 };
    }

    const lower = text.toLowerCase();

    // 1. Hard-decline (control-flow / injection attempts).
    for (const k of HARD_DECLINE_KEYWORDS) {
      if (new RegExp('(^|[^a-z0-9_])' + k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '([^a-z0-9_]|$)', 'i').test(text)) {
        return { decision: 'decline', reason: 'control_flow_keyword', lite_score: 0 };
      }
    }

    // --preview ALWAYS escalates (preview rendering lives in pm.md).
    if (/--preview\b/.test(text)) {
      return { decision: 'escalate', reason: 'preview_mode_forced', lite_score: 0 };
    }

    // PATH FLOOR: any mention of protected dir paths or filenames → escalate immediately.
    const lowerText = text.toLowerCase();
    for (const prefix of PATH_FLOOR_PREFIXES) {
      if (lowerText.includes(prefix)) {
        return { decision: 'escalate', reason: 'keyword_denylist_hit', lite_score: 0, path_floor_triggered: true };
      }
    }
    // Filename-in-prose for protected file types.
    if (PATH_FLOOR_FILENAMES.test(text)) {
      return { decision: 'escalate', reason: 'keyword_denylist_hit', lite_score: 0, path_floor_triggered: true };
    }

    // 2. Hard-escalate keyword denylist.
    for (const k of ESCALATE_KEYWORDS) {
      if (lower.indexOf(k) !== -1) {
        return { decision: 'escalate', reason: 'keyword_denylist_hit', lite_score: 0 };
      }
    }

    // 3. File-count heuristic.
    const paths = extractPathTokens(text);
    if (paths.length > cfg.solo_max_files) {
      return { decision: 'escalate', reason: 'file_count_over_threshold', lite_score: 0 };
    }

    // 4. Length / structural complexity gate.
    const wc = text.trim().split(/\s+/).length;
    if (wc > cfg.solo_max_words) {
      return { decision: 'escalate', reason: 'task_too_long', lite_score: 0 };
    }

    if (countMultiStepImperatives(text) >= 3) {
      return { decision: 'escalate', reason: 'multi_step_imperative', lite_score: 0 };
    }

    // 5. Lite complexity score.
    const score = liteComplexityScore(text, paths);
    const baseThreshold =
      Number.isInteger(input.config && input.config.complexity_threshold)
        ? input.config.complexity_threshold
        : 4;
    const effectiveThreshold = baseThreshold + cfg.solo_complexity_threshold_offset;
    if (score >= effectiveThreshold) {
      return { decision: 'escalate', reason: 'lite_score_over_threshold', lite_score: score };
    }

    // 6. All signals simple → solo.
    return { decision: 'solo', reason: 'all_signals_simple', lite_score: score };
  } catch (_e) {
    return { decision: 'escalate', reason: 'parse_error_fail_safe', lite_score: 0 };
  }
}

module.exports = {
  decideRoute,
  extractPathTokens,
  countMultiStepImperatives,
  liteComplexityScore,
  DEFAULTS,
  HARD_DECLINE_KEYWORDS,
  ESCALATE_KEYWORDS,
  PATH_FLOOR_PREFIXES,
  PATH_FLOOR_FILENAMES,
};
