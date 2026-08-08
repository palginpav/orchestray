#!/usr/bin/env node
'use strict';

/**
 * render-pattern-citations.js — PreToolUse:Agent hook. Resolves every curated
 * `@orchestray:pattern://<slug>` citation in a delegation prompt into the
 * pattern's actual text before the spawned agent sees it.
 *
 * Why a hook and not PM prose: `@orchestray:pattern://<slug>` is inert text —
 * nothing in the runtime resolved it, so an agent handed one saw a dead link
 * and filed a sincere `patterns_rejected` entry for a pattern that exists
 * (`.orchestray/kb/decisions/pattern-citation-uri-without-body.md`). The
 * renderer that fixes this (`bin/_lib/pattern-citation-render.js`) shipped with
 * zero production callers. Making the PM call it is a prose obligation, and
 * prose-only enforcement in this repo has measured 1/5.
 *
 * Ordering (hooks.json, "Agent" block that also holds prefetch-mcp-grounding.js
 * and record-pattern-offers.js): this hook runs LAST, immediately AFTER
 * record-pattern-offers.js. That order is load-bearing:
 *   - The offer ledger keeps scanning the PM-authored text, so `shape_detected`
 *     and the curated/ambient split still describe what the PM wrote.
 *   - Pattern bodies contain arbitrary prose, including unbalanced double
 *     quotes. pattern-offer-scan.js#isInsideQuotedSpan drops a citation that
 *     sits inside an open quoted span; appending bodies BEFORE that scanner
 *     could silently drop later slugs from the ledger.
 *
 * The rendered set is derived from `scanOffers` itself (curated offers only),
 * so what gets a body is exactly what got recorded as offered — including the
 * quoted-span exclusion, so a slug the PM merely quoted from a prior agent's
 * output is not expanded either.
 *
 * Fail-open contract:
 *   - Any error, unreadable pattern, or missing file → `{ continue: true }`,
 *     prompt untouched. The agent gets the bare URI rather than no spawn.
 *   - Never blocks; exit code is always 0.
 *
 * Kill switches (default-on per feedback_default_on_shipping.md):
 *   ORCHESTRAY_PATTERN_CITATION_RENDER_DISABLED=1
 *   config.pattern_evidence.enabled: false   — same switch as the offer hook
 *   config.context_compression_v218.cite_cache: false — disables the [CACHED]
 *     annotation and its seen-set I/O only; bodies still ship.
 *
 * Input:  Claude Code PreToolUse:Agent JSON payload on stdin
 * Output: `{ hookSpecificOutput: { ..., updatedInput } }` when at least one
 *         citation was resolved, else `{ continue: true }`; exit 0 always.
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }      = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES }     = require('./_lib/constants');
const { readHookInputRaw }    = require('./_lib/hook-stdin');
const { peekOrchestrationId } = require('./_lib/peek-orchestration-id');
const { scanOffers }          = require('./_lib/pattern-offer-scan');
const { resolvePatternEntry } = require('./_lib/pattern-file-resolve');
const { parseFrontmatter }    = require('./_lib/frontmatter-parse');
const { renderPatternsApplied } = require('./_lib/pattern-citation-render');

// Bodies are inlined per spawn. The corpus averages ~4 KB; the cap trims only
// the outliers, and the source_file line carries the rest.
const MAX_BODY_CHARS = 8000;
// Refuse to expand a prompt without bound — a spawn citing 20 slugs is a PM
// bug, not a context strategy.
const MAX_RENDERED_PATTERNS = 8;

function emitContinue() {
  process.stdout.write(JSON.stringify({ continue: true }) + '\n');
}

function emitAllowWithUpdatedInput(updatedInput) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput,
    },
    continue: true,
  }) + '\n');
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readConfig(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8')) || {};
  } catch (_e) {
    return {}; // fail-open: defaults
  }
}

function renderEnabled(cfg) {
  if (process.env.ORCHESTRAY_PATTERN_CITATION_RENDER_DISABLED === '1') return false;
  if (process.env.ORCHESTRAY_PATTERN_EVIDENCE_DISABLED === '1') return false;
  return !(cfg.pattern_evidence && cfg.pattern_evidence.enabled === false);
}

function citeCacheEnabled(cfg) {
  const block = cfg.context_compression_v218;
  return !(block && block.cite_cache === false);
}

// ---------------------------------------------------------------------------
// Pattern loading
// ---------------------------------------------------------------------------

/**
 * Load a slug into a pattern_find-shaped match object. Frontmatter is stripped:
 * it carries a `name:` field that competes with the slug for the agent's
 * attention (see the ack-fidelity decision doc), and its metadata is already
 * rendered into the citation label.
 *
 * @param {string} cwd
 * @param {string} slug
 * @returns {object|null} match object, or null when unresolvable/unreadable
 */
function loadMatch(cwd, slug) {
  const entry = resolvePatternEntry(cwd, slug);
  if (!entry) return null;

  let raw;
  try {
    raw = fs.readFileSync(entry.file, 'utf8');
  } catch (_e) {
    return null;
  }

  const parsed = parseFrontmatter(raw);
  const fm = parsed ? parsed.frontmatter : {};
  let body = (parsed ? parsed.body : raw).trim();
  if (!body) return null;

  let fileRel;
  try {
    fileRel = path.relative(cwd, entry.file);
    if (fileRel.startsWith('..')) fileRel = entry.file; // shared tier lives outside the repo
  } catch (_e) {
    fileRel = entry.file;
  }

  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS).trimEnd() +
      `\n\n[truncated at ${MAX_BODY_CHARS} chars — full text: ${fileRel}]`;
  }

  return {
    slug,
    body,
    file_rel: fileRel,
    source: entry.tier === 'shared' ? 'shared' : (entry.tier === 'team' ? 'team' : 'local'),
    confidence: typeof fm.confidence === 'number' ? fm.confidence : null,
    times_applied: typeof fm.times_applied === 'number' ? fm.times_applied : null,
    promoted_from: typeof fm.promoted_from === 'string' ? fm.promoted_from : undefined,
    promoted_is_own: fm.promoted_is_own === true,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @returns {string|null} the appendix to add, or null when there is nothing to do
 */
function buildAppendix(prompt, agentType, cwd, cfg) {
  const exists = (slug) => resolvePatternEntry(cwd, slug) !== null;
  const scan = scanOffers(prompt, exists);

  const slugs = [];
  for (const offer of scan.offers) {
    if (offer.offer_kind !== 'curated') continue;
    // Already rendered (PM used the renderer itself, or this hook re-ran).
    if (prompt.includes(`\n  slug: ${offer.slug}`)) continue;
    if (slugs.indexOf(offer.slug) === -1) slugs.push(offer.slug);
    if (slugs.length >= MAX_RENDERED_PATTERNS) break;
  }
  if (slugs.length === 0) return null;

  const orchId = peekOrchestrationId(cwd);
  const citeCache = Boolean(orchId) && citeCacheEnabled(cfg);

  const matches = [];
  for (const slug of slugs) {
    const match = loadMatch(cwd, slug);
    if (match) matches.push(match);
  }
  if (matches.length === 0) return null;

  const block = renderPatternsApplied(matches, agentType, orchId, citeCache, cwd);
  return block ? '\n\n' + block : null;
}

function main() {
  const input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    emitContinue();
    process.exit(0);
    return;
  }

  let event;
  try {
    event = input.length > 0 ? JSON.parse(input) : {};
  } catch (_e) {
    emitContinue();
    process.exit(0);
    return;
  }

  const toolInput = event.tool_input || {};
  if (event.tool_name !== 'Agent' || typeof toolInput.prompt !== 'string') {
    emitContinue();
    process.exit(0);
    return;
  }

  let cwd;
  try {
    cwd = resolveSafeCwd(event.cwd);
  } catch (_e) {
    cwd = process.cwd();
  }

  let appendix = null;
  try {
    const cfg = readConfig(cwd);
    if (renderEnabled(cfg)) {
      const agentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : null;
      appendix = buildAppendix(toolInput.prompt, agentType, cwd, cfg);
    }
  } catch (_e) {
    appendix = null; // fail-open: bare URI beats a blocked spawn
  }

  if (!appendix) {
    emitContinue();
    process.exit(0);
    return;
  }

  emitAllowWithUpdatedInput(Object.assign({}, toolInput, { prompt: toolInput.prompt + appendix }));
  process.exit(0);
}

if (require.main === module) main();

module.exports = { buildAppendix, loadMatch, MAX_BODY_CHARS, MAX_RENDERED_PATTERNS };
