'use strict';

/**
 * mcp-tool-allowlist-derive.js — C-02 mechanisation (v2.2.15 P1-02).
 *
 * Mechanises anti-pattern `mcp-tool-pm-allowlist-cross-cut`. Every MCP tool
 * registered in `bin/mcp-server/server.js` TOOL_TABLE that PM is expected to
 * call MUST appear in `agents/pm.md` frontmatter `tools:` field as
 * `mcp__orchestray__<slug>`. Drift here produces silent regressions: PM cannot
 * call a freshly-registered tool because Claude Code blocks it pre-tool.
 *
 * This library derives the canonical sets from source so a CI test (see
 * `bin/__tests__/anti-pattern-mcp-allowlist-parity.test.js`) can diff them.
 *
 * NOT-FOR-PM exclusion list: a small set of tools registered in TOOL_TABLE but
 * intentionally NOT in PM's allowlist. They are owned by other agents
 * (curator) or invoked indirectly (system spawn paths). Each entry MUST be
 * justified inline. New entries require a code review approval.
 *
 * Kill switch: `ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED=1`. Default-on.
 *
 * Exports:
 *   isDisabled()
 *   parseToolTable(serverSrc)        — keys of TOOL_TABLE as Set
 *   parseSchemasToolNames(schemasSrc) — names declared in lib/schemas.js as Set
 *   parsePmAllowlist(pmMdSrc)        — slugs from `mcp__orchestray__<slug>` in pm.md as Set
 *   diffAllowlist({tools, pmTools, exclusions}) — { missing[], stale[] }
 *   NOT_FOR_PM                       — frozen exclusion set (justified)
 */

function isDisabled() {
  return process.env.ORCHESTRAY_LINT_MCP_ALLOWLIST_PARITY_DISABLED === '1';
}

/**
 * Tools registered in `server.js` TOOL_TABLE but intentionally absent from
 * `agents/pm.md` `tools:`. Each entry must justify why PM does not need
 * direct access. Adding to this list is a deliberate cross-cut requiring
 * code review.
 */
const NOT_FOR_PM = Object.freeze({
  // Curator agent owns tombstone writes (see agents/curator.md.legacy and
  // agents/curator-stages/phase-close.md). PM never tombstones directly.
  curator_tombstone:  'owned-by-curator',

  // Internal: schema_get is consumed via the schema-redirect pipeline
  // (bin/_lib/schema-redirect.js) and the chunked schema-load shield, not
  // by PM frontmatter delegation.
  schema_get:         'internal-schema-redirect',

  // System spawn path: bin/_lib/spawn-runner.js + Agent() tool. PM uses the
  // native `Agent()` shape, not the raw MCP tool.
  spawn_agent:        'internal-spawn-runner',

  // PM never calls metrics_query directly; the analytics slash-command and
  // post-orchestration extract paths invoke it.
  metrics_query:      'analytics-only',

  // pattern_read is auto-fetched by architect/developer/reviewer/debugger
  // agents per their MCP grounding protocol; PM consumes pattern_find and
  // pattern_record_application/_skip_reason for orchestration decisions.
  pattern_read:       'specialist-only',

  // cost_budget_check is consumed by the gate-agent-spawn cost shield, not
  // by PM frontmatter delegation. PM uses cost_budget_reserve.
  cost_budget_check:  'internal-spawn-shield',
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Extract TOOL_TABLE keys from `bin/mcp-server/server.js`.
 *
 * Heuristic: locate `const TOOL_TABLE = Object.freeze({` and the matching
 * closing `});`. Within that block, every top-level key matching
 * `^\s*([a-z][a-z0-9_]*)\s*:` is a tool slug.
 *
 * Tolerates handler-only or definition-only entries; nested braces are
 * tracked so inner literals don't pollute the slug list.
 */
function parseToolTable(serverSrc) {
  const slugs = new Set();
  if (typeof serverSrc !== 'string') return slugs;

  const startMatch = serverSrc.match(/const\s+TOOL_TABLE\s*=\s*Object\.freeze\s*\(\s*\{/);
  if (!startMatch) return slugs;
  const startIdx = startMatch.index + startMatch[0].length;

  // Walk forward tracking brace depth until we see the closing `});`.
  let depth = 1;
  let i = startIdx;
  while (i < serverSrc.length && depth > 0) {
    const ch = serverSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0) return slugs;

  const block = serverSrc.slice(startIdx, i);

  // Extract top-level keys only: track depth within the block.
  const KEY_RE = /^\s*([a-z][a-z0-9_]*)\s*:/mg;
  let depthInner = 0;
  let cursor = 0;
  const lines = block.split('\n');
  let lineOffset = 0;
  for (const line of lines) {
    // Update depth tally first so a `key:` after a `{` on the same line is
    // still treated as nested.
    let preDepth = depthInner;
    for (const ch of line) {
      if (ch === '{') depthInner++;
      else if (ch === '}') depthInner--;
    }
    if (preDepth === 0) {
      const m = KEY_RE.exec(line);
      if (m) slugs.add(m[1]);
      KEY_RE.lastIndex = 0;
    }
    cursor += line.length + 1;
    lineOffset++;
  }

  return slugs;
}

/**
 * Extract tool definition names from `bin/mcp-server/lib/schemas.js`.
 *
 * Today schemas.js declares only ASK_USER_TOOL_DEFINITION inline. New tool
 * definitions live in `bin/mcp-server/tools/<slug>.js` modules and reach
 * the server via the slug as TOOL_TABLE key. We still parse schemas.js for
 * any inline `name: '<slug>'` strings as a defensive parity check.
 */
function parseSchemasToolNames(schemasSrc) {
  const names = new Set();
  if (typeof schemasSrc !== 'string') return names;
  const RE = /name\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g;
  let m;
  while ((m = RE.exec(schemasSrc)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/**
 * Extract `mcp__orchestray__<slug>` tokens from `agents/pm.md` frontmatter
 * `tools:` field. Returns the set of slugs (without prefix).
 *
 * Case-sensitive: `MCP__orchestray__foo` does NOT count.
 */
function parsePmAllowlist(pmMdSrc) {
  const slugs = new Set();
  if (typeof pmMdSrc !== 'string') return slugs;

  // Locate frontmatter block: leading `---\n` ... trailing `\n---`.
  const fmMatch = pmMdSrc.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return slugs;
  const frontmatter = fmMatch[1];

  // Find the `tools:` line (may continue onto multiple lines, so capture
  // until the next top-level YAML key or end of frontmatter).
  const toolsMatch = frontmatter.match(/(^|\n)tools:\s*([\s\S]*?)(?=\n[a-zA-Z_][\w-]*\s*:|$)/);
  if (!toolsMatch) return slugs;
  const toolsBlock = toolsMatch[2];

  // Extract case-sensitive `mcp__orchestray__<slug>` tokens.
  const RE = /mcp__orchestray__([a-z][a-z0-9_]*)/g;
  let m;
  while ((m = RE.exec(toolsBlock)) !== null) {
    slugs.add(m[1]);
  }
  return slugs;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/**
 * Compute the parity diff.
 *
 * @param {Object} args
 * @param {Set<string>} args.tools       — TOOL_TABLE slugs
 * @param {Set<string>} args.pmTools     — pm.md allowlisted slugs
 * @param {Object} [args.exclusions]     — { slug: justification } map of
 *                                         tools intentionally not in pm.md.
 *                                         Defaults to NOT_FOR_PM.
 * @returns {{ missing: string[], stale: string[] }}
 *   missing — tools registered but absent from pm.md AND not in exclusions
 *             (HARD-BLOCK)
 *   stale   — tools in pm.md but absent from TOOL_TABLE
 *             (WARN — `mcp_allowlist_stale_entry_warn`)
 */
function diffAllowlist({ tools, pmTools, exclusions } = {}) {
  const exc = exclusions || NOT_FOR_PM;
  const missing = [];
  const stale = [];
  for (const slug of tools) {
    if (pmTools.has(slug)) continue;
    if (Object.prototype.hasOwnProperty.call(exc, slug)) continue;
    missing.push(slug);
  }
  for (const slug of pmTools) {
    if (tools.has(slug)) continue;
    stale.push(slug);
  }
  missing.sort();
  stale.sort();
  return { missing, stale };
}

module.exports = {
  isDisabled,
  NOT_FOR_PM,
  parseToolTable,
  parseSchemasToolNames,
  parsePmAllowlist,
  diffAllowlist,
};
