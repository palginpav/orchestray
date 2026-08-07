'use strict';

/**
 * claim-rules.js — the Claim–Evidence Ledger rule table (v2.3.18, CEL).
 *
 * Failure mode attacked: **Phantom Verification** — an agent reports work its
 * transcript shows it never did ("lint + tests green" with zero Bash calls).
 *
 * Everything here is data. Adding coverage is a table edit, not a new script.
 * That is the whole point: `bin/` accumulated six hand-written point-gates for
 * this one bug class, and any claim outside those six shapes went unchecked.
 *
 * Two tables:
 *   RULES          claim language  → required tool-call evidence
 *   SR_ASSERTIONS  Structured Result shape checks that are *not* claim→evidence
 *                  (ported verbatim from the retired point-gates so no
 *                  capability is lost — see the header on SR_ASSERTIONS)
 *
 * @typedef {Object} ClaimRule
 * @property {string}   id            stable id, e.g. 'tests-run'
 * @property {RegExp}   claim         matched against a single claim sentence
 * @property {string[]} roles         agent roles this applies to; ['*'] = all
 * @property {Object}   evidence
 * @property {string[]} evidence.tools   acceptable tool names (OR)
 * @property {RegExp=}  evidence.argRe   must match `toolName + ' ' + JSON.stringify(input)`
 * @property {string[]=} evidence.events audit event types that also satisfy the rule
 * @property {'block'|'warn'} severity
 * @property {string}   remedy        one-line instruction shown on failure
 * @property {string=}  ported_from   point-gate this rule replaces
 */

const { callHaystack } = require('./transcript-tools');

/**
 * Synthetic claim sentences are prefixed with this marker so they are
 * distinguishable from prose in the ledger and cannot be produced by accident.
 */
const SYNTHETIC_PREFIX = '[structured-result] ';

/** Roles that must ground their output in an MCP lookup (was F2_ALLOWLIST). */
const MCP_GROUNDING_ROLES = ['pm', 'researcher', 'debugger', 'architect'];

/**
 * Roles that actually execute verification (run the suite, the linter, the
 * build). Scoping the execution rules to these roles is the other half of the
 * rubric fix below: an architect cannot run `npm test`, so "restate the claim"
 * would be its only remedy — and for rubric text the architect is *required*
 * to emit, that remedy means deleting mandated output. A rule whose only
 * remedy is impossible is not a gate, it is a wedge.
 */
const EXECUTION_ROLES = ['developer', 'tester', 'refactorer', 'debugger'];

/** @type {ClaimRule[]} */
const RULES = [
  // --- ported from bin/validate-tester-runs-tests.js -----------------------
  {
    id: 'tests-run',
    claim: /\b(tests?|suite|spec)s?\s+(pass|passing|green|succeed)|\bran\s+the\s+tests?\b|\btest\s+suite\s+is\s+green\b/i,
    roles: EXECUTION_ROLES,
    evidence: { tools: ['Bash'], argRe: /npm\s+test|node\s+--test|yarn\s+test|pnpm\s+test|jest|vitest|mocha|pytest|go\s+test|cargo\s+test/ },
    severity: 'block',
    remedy: 'Run the test suite, or restate as "tests not run in this spawn".',
    ported_from: 'validate-tester-runs-tests.js',
  },
  {
    id: 'no-regressions',
    claim: /\bno\s+(regressions?|breakage|new\s+failures?)\b|\bnothing\s+(else\s+)?broke\b|\bsuite\s+still\s+green\b/i,
    roles: EXECUTION_ROLES,
    evidence: { tools: ['Bash'], argRe: /npm\s+test|node\s+--test|yarn\s+test|pnpm\s+test|jest|vitest|mocha|pytest|go\s+test|cargo\s+test/ },
    severity: 'block',
    remedy: 'Run the suite to establish there are no regressions, or drop the claim.',
  },

  // --- general execution claims -------------------------------------------
  {
    id: 'lint-run',
    claim: /\blint(ing)?\s+(is\s+)?(clean|green|pass\w*)|\bno\s+lint\s+errors?\b|\blinter\s+is\s+(clean|green)\b/i,
    roles: EXECUTION_ROLES,
    evidence: { tools: ['Bash'], argRe: /eslint|npm\s+run\s+lint|yarn\s+lint|standard\b|ruff|flake8|golangci/ },
    severity: 'block',
    remedy: 'Run the linter, or drop the lint claim.',
  },
  {
    id: 'build-clean',
    claim: /\b(build|compil\w+|type-?check\w*)\s+(is\s+)?(clean|green|pass\w*|succeed\w*)\b|\bcompiles\s+(cleanly|without\s+errors?)\b/i,
    roles: EXECUTION_ROLES,
    evidence: { tools: ['Bash'], argRe: /npm\s+run\s+build|tsc\b|node\s+--check|go\s+build|cargo\s+build|make\b/ },
    severity: 'block',
    remedy: 'Run the build/type-check, or restate as "not built in this spawn".',
  },
  {
    id: 'verified-behavior',
    claim: /\b(verified|confirmed)\s+(that\s+)?(it|this|the\s+[\w-]+)\s+(works|fires|runs|returns|exits|emits|blocks)/i,
    roles: ['*'],
    evidence: { tools: ['Bash'] },
    severity: 'block',
    remedy: 'Execute it, or restate as "inspected the code path".',
  },
  {
    id: 'all-call-sites',
    claim: /\b(all|every)\s+(call\s?sites?|usages?|references?|consumers?|occurrences?)\b/i,
    roles: ['developer', 'refactorer', 'reviewer', 'debugger', 'tester', 'documenter'],
    evidence: { tools: ['Grep', 'Bash'], argRe: /grep|rg\b|Grep|ripgrep/ },
    severity: 'block',
    remedy: 'Grep for the symbol before claiming exhaustive coverage, or say "call sites I found".',
  },
  {
    id: 'hook-registered',
    claim: /\bwired\s+(it\s+)?into\s+hooks\.json|\bregistered\s+the\s+hook\b|\badded\s+(the\s+)?hooks?\.json\s+entry\b/i,
    roles: ['developer', 'refactorer'],
    evidence: { tools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'], argRe: /hooks[\\/]+hooks\.json/ },
    severity: 'block',
    remedy: 'Edit hooks/hooks.json, or remove the registration claim.',
  },
  {
    id: 'docs-updated',
    claim: /\b(updated|swept|refreshed)\s+(the\s+)?(README|CHANGELOG|docs?|documentation)\b/i,
    roles: ['*'],
    evidence: { tools: ['Edit', 'Write', 'MultiEdit'], argRe: /README|CHANGELOG|\.md/i },
    severity: 'block',
    remedy: 'Edit the doc file, or restate as "docs update still pending".',
  },
  {
    id: 'measured-number',
    claim: /\b(measured|benchmark\w*|profiled)\b.*\b\d+\s*(ms|s|%|MB|KB|tokens?)\b/i,
    roles: ['*'],
    evidence: { tools: ['Bash'] },
    severity: 'warn',
    remedy: 'Produce the measurement command, or label the number as an estimate.',
  },

  // --- ported from bin/validate-reviewer-git-diff.js (evidence half only) ---
  // The retained script owns diff *provisioning* at PreToolUse; this rule only
  // checks that a reviewer who claims to have read the diff actually did.
  {
    id: 'diff-reviewed',
    claim: /\b(reviewed|read|walked|examined)\s+(through\s+)?(the\s+)?(git\s+)?diff\b/i,
    roles: ['reviewer', 'security-engineer', 'ux-critic'],
    evidence: { tools: ['Bash', 'Read', 'Grep'], argRe: /git\s+(diff|show|log)|\.diff\b|Git Diff/i },
    severity: 'warn',
    remedy: 'Run `git diff`, or restate as "reviewed the files as provided".',
    ported_from: 'validate-reviewer-git-diff.js (evidence half)',
  },

  // --- ported from bin/validate-pattern-application.js ----------------------
  {
    id: 'pattern-applied',
    claim: /\b(applied|apply(?:ing)?|followed|reused)\s+(the\s+)?pattern\b|\bpattern\s+guidance\s+applied\b|@orchestray:pattern:\/\//i,
    roles: ['*'],
    evidence: {
      tools: [
        'mcp__orchestray__pattern_record_application',
        'mcp__orchestray__pattern_record_skip_reason',
        'mcp__orchestray__pattern_read',
      ],
    },
    severity: 'block',
    remedy: 'Acknowledge the pattern via mcp__orchestray__pattern_record_application (or record a skip reason), or drop the "pattern applied" claim.',
    ported_from: 'validate-pattern-application.js',
  },

  // --- ported from bin/validate-researcher-citations.js (evidence half) -----
  {
    id: 'research-sourced',
    claim: /\b(shortlist|prior\s?art|surveyed|cited\s+sources?|research\s+verdict|decision-ready)\b/i,
    roles: ['researcher', 'platform-oracle', 'architect'],
    evidence: { tools: ['WebFetch', 'WebSearch', 'mcp__orchestray__kb_search', 'mcp__orchestray__pattern_find'] },
    severity: 'block',
    remedy: 'Fetch the sources you cite (WebFetch/WebSearch), or restate the shortlist as "from prior knowledge, unverified".',
    ported_from: 'validate-researcher-citations.js',
  },

  // --- ported from bin/validate-platform-oracle-grounding.js (evidence half) -
  {
    id: 'oracle-grounded',
    claim: /\b(stability[_\s]?tier|source_url|platform\s+claims?|per\s+the\s+(official\s+)?docs?)\b/i,
    roles: ['platform-oracle', 'researcher'],
    evidence: { tools: ['WebFetch', 'WebSearch'] },
    severity: 'block',
    remedy: 'Fetch the documentation URL you cite, or label the claim tier "community" with its actual provenance.',
    ported_from: 'validate-platform-oracle-grounding.js',
  },

  // --- ported from bin/validate-mcp-grounding.js ---------------------------
  // Role-critical: fires from a synthetic claim on every spawn of an
  // allowlisted role, matching the retired gate's unconditional check. There
  // is no claim to downgrade here — the obligation comes from the role — so
  // `role_critical` exempts it from the two-remedy contract. The retired gate
  // had no escape hatch at all, so this is not a regression.
  //
  // `evidence.events` restores the retired gate's actual semantics: it counted
  // `mcp_tool_call` *audit events*, which grounding may satisfy "via M1
  // prefetch or direct calls". A prefetch grounds the spawn on the agent's
  // behalf through `additionalContext` and leaves no transcript tool call at
  // all — so a transcript-only check would block every prefetch-grounded spawn.
  {
    id: 'mcp-grounded',
    claim: /\bgrounding-required\s+role\b/i,
    roles: MCP_GROUNDING_ROLES,
    evidence: {
      tools: [],
      argRe: /^mcp__/,
      events: ['mcp_grounding_prefetched', 'mcp_tool_call'],
    },
    severity: 'block',
    role_critical: true,
    remedy: 'Call at least one MCP grounding tool (mcp__orchestray__pattern_find / kb_search) before reporting.',
    ported_from: 'validate-mcp-grounding.js',
  },
];

/**
 * Structured-Result assertions.
 *
 * CEL's model is claim → tool-call evidence. Two of the retired point-gates
 * additionally asserted things about the *shape* of the Structured Result,
 * which no amount of transcript evidence can express. Rather than drop those
 * checks, they are carried here verbatim: same table-driven shape, same gate,
 * same ledger, no extra script.
 *
 * @typedef {Object} SrAssertion
 * @property {string}   id
 * @property {string[]} roles
 * @property {'block'|'warn'} severity
 * @property {string}   remedy
 * @property {function(object): string[]} check  → violation strings ([] = pass)
 * @property {string}   ported_from
 */

const VALID_STABILITY_TIERS = new Set(['stable', 'experimental', 'community']);
const MIN_RESEARCH_SOURCES = 3;

/** Count sources in a Structured Result (ported from validate-researcher-citations.js). */
function countSources(sr) {
  if (!sr || typeof sr !== 'object') return 0;
  if (Array.isArray(sr.sources)) return sr.sources.length;
  if (Array.isArray(sr.citations)) return sr.citations.length;
  if (Array.isArray(sr.shortlist)) return sr.shortlist.length;
  const text = typeof sr.summary === 'string' ? sr.summary : '';
  const urlMatches = text.match(/https?:\/\/\S+/g);
  return urlMatches ? urlMatches.length : 0;
}

/** A `no_clear_fit` verdict is a pass-through (ported from validate-researcher-citations.js). */
function isNoClearFit(sr) {
  if (!sr || typeof sr !== 'object') return true;
  const verdict = sr.verdict || sr.recommendation || sr.status || '';
  if (typeof verdict !== 'string') return true;
  return verdict.toLowerCase().replace(/[\s_-]/g, '') === 'noclearfit';
}

/** @type {SrAssertion[]} */
const SR_ASSERTIONS = [
  {
    id: 'researcher-min-sources',
    roles: ['researcher'],
    severity: 'block',
    remedy: 'Cite at least ' + MIN_RESEARCH_SOURCES + ' sources in the `sources` array, or return verdict "no_clear_fit".',
    ported_from: 'validate-researcher-citations.js',
    check(sr) {
      if (isNoClearFit(sr)) return [];
      const n = countSources(sr);
      if (n >= MIN_RESEARCH_SOURCES) return [];
      return ['only ' + n + ' source(s) cited (minimum: ' + MIN_RESEARCH_SOURCES + ')'];
    },
  },
  {
    id: 'oracle-claim-grounding',
    roles: ['platform-oracle'],
    severity: 'block',
    remedy: 'Give every claim a `stability_tier` (stable|experimental|community) and a non-empty `source_url`.',
    ported_from: 'validate-platform-oracle-grounding.js',
    check(sr) {
      const violations = [];
      const hasClaims = Array.isArray(sr.claims) && sr.claims.length > 0;
      const hasFindings = Array.isArray(sr.findings) && sr.findings.length > 0;

      const checkOne = (obj, label) => {
        const tier = obj.stability_tier;
        const url = obj.source_url;
        if (!tier || !VALID_STABILITY_TIERS.has(String(tier).toLowerCase())) {
          violations.push(label + 'stability_tier missing or invalid (got: ' +
            JSON.stringify(tier) + ', expected one of: ' + [...VALID_STABILITY_TIERS].join(', ') + ')');
        }
        if (!url || typeof url !== 'string' || !url.trim()) {
          violations.push(label + 'source_url missing or empty');
        }
      };

      if (!hasClaims && !hasFindings) {
        checkOne(sr, '');
        return violations;
      }
      const entries = hasClaims ? sr.claims : sr.findings;
      entries.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') {
          violations.push('entry[' + i + '] is not an object');
          return;
        }
        checkOne(entry, 'entry[' + i + '].');
      });
      return violations;
    },
  },
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Markdown sections whose bodies are specification or scoring text rather than
 * testimony about the author's own work.
 *
 * `agents/pm-reference/rubric-format.md` *mandates* both: an architect MUST
 * emit `## Acceptance Rubric` criteria such as "the existing suite passes with
 * the new logic", and a developer MUST emit `## Rubric Scoring` restating them.
 * Scanning that text for claims makes the two documented remedies mutually
 * exclusive — run a suite you have no tools for, or delete required output.
 */
const NON_TESTIMONY_SECTIONS = /^\s{0,3}#{1,6}\s*(acceptance\s+rubric|rubric\s+scoring)\b/im;

/** The Structured Result section — consumed as JSON, never re-read as prose. */
const STRUCTURED_RESULT_SECTION = /^\s{0,3}#{1,6}\s*structured\s+result\b/im;

const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;

/** A fence line for section scanning: marker run plus whatever follows it. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

/** A fence line, with its marker run and optional info string (```json). */
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)[ \t]*$/;

/**
 * Does `line`'s fence match close a block opened by `marker`?
 *
 * CommonMark's rule: same marker character, at least as long, no info string.
 * A ``` inside a ~~~ block is content, not a delimiter — tracking one shared
 * boolean instead desynced every strip that followed it.
 *
 * @param {string} marker  the run that opened the current fence
 * @param {RegExpMatchArray} m  a FENCE match on the candidate closing line
 */
function closesFence(marker, m) {
  return m[1][0] === marker[0] && m[1].length >= marker.length && !m[2].trim();
}

/** Info strings that declare the fenced payload to be JSON, not prose. */
const JSON_FENCE_INFO = /^(json|jsonc|json5)$/i;

/**
 * Field precedence for a spawn's raw text output — one definition, two callers.
 *
 * `extractStructuredResult` and `validate-claim-evidence.js:buildClaimText`
 * used to disagree on this order, and the divergence was not cosmetic: the
 * first decides *whether* a Structured Result exists, the second decides *which
 * text to strip it out of*. On a payload carrying both `result` and `output`
 * they picked different fields, so the strip ran against text that never held
 * the block and the raw JSON — `issues[]` and all — stayed in the claim corpus.
 */
const RAW_OUTPUT_FIELDS = ['result', 'output', 'agent_output'];

/**
 * The spawn's raw text output under the canonical field precedence.
 *
 * @param {object} event
 * @returns {string|null}
 */
function rawOutputText(event) {
  if (!event) return null;
  for (const field of RAW_OUTPUT_FIELDS) {
    const v = event[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Drop whole markdown sections (heading through the next heading) from prose.
 *
 * Fenced blocks are tracked so a YAML comment inside a rubric fence is not
 * mistaken for the heading that ends the section.
 *
 * @param {string} text
 * @param {RegExp} headingRe
 * @returns {string}
 */
function stripSections(text, headingRe) {
  const src = String(text || '');
  if (!headingRe.test(src)) return src;
  const kept = [];
  let skipping = false;
  // The marker run that opened the fence we are inside, null when outside.
  // A boolean cannot tell ``` from ~~~, so a ``` quoted inside a ~~~ block
  // used to "close" it and everything after read as prose.
  let openMarker = null;
  for (const line of src.split('\n')) {
    const f = line.match(FENCE);
    if (f) {
      if (openMarker === null) openMarker = f[1];
      else if (closesFence(openMarker, f)) openMarker = null;
    }
    const fenced = openMarker !== null;
    if (!fenced && headingRe.test(line)) { skipping = true; continue; }
    if (skipping) {
      if (fenced || !ANY_HEADING.test(line)) continue;
      skipping = false;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/** Drop `## Acceptance Rubric` / `## Rubric Scoring` sections. */
function stripNonTestimony(text) {
  return stripSections(text, NON_TESTIMONY_SECTIONS);
}

/**
 * Drop the `## Structured Result` section.
 *
 * Only safe once the block has been parsed: its prose fields are then already
 * in the corpus via `buildClaimText`, and leaving the raw fence in would
 * re-admit exactly the fields that were deliberately excluded from it.
 */
function stripStructuredResultSection(text) {
  return stripSections(text, STRUCTURED_RESULT_SECTION);
}

/**
 * True when a fenced block holds a JSON payload rather than prose.
 *
 * @param {string} info    the fence's info string ('json', '', …)
 * @param {string} body    the fenced lines
 * @param {boolean} closed whether a closing fence was found
 */
function isJsonPayloadFence(info, body, closed) {
  if (JSON_FENCE_INFO.test(info)) return true;   // declared JSON — never testimony
  if (!closed) return false;                     // an open-ended block cannot be judged
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return false;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch (_e) { return false; }
  return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, 'issues');
}

/**
 * Drop fenced JSON payloads from prose.
 *
 * The companion to `stripStructuredResultSection`, and the reason both exist:
 * the section strip is anchored on a `## Structured Result` heading, while
 * Structured Result *extraction* is not — it prefers the `structured_result` /
 * `agent_output_json` / `result_json` object fields, where no heading is
 * involved at all. A spawn that emits a headingless ```json fence therefore had
 * a parsed Structured Result (so the strip ran) and no heading to anchor on (so
 * the strip found nothing), and the raw JSON survived into the claim corpus —
 * re-admitting the `issues[]` E2 was written to keep out. Anchoring on the
 * fence instead of the heading closes that gap whatever shape the payload
 * arrives in.
 *
 * Only ever called once the block has parsed: its prose fields are in the
 * corpus by then, so nothing testimonial is lost.
 *
 * @param {string} text
 * @returns {string}
 */
function stripStructuredResultFences(text) {
  const src = String(text || '');
  if (src.indexOf('```') === -1 && src.indexOf('~~~') === -1) return src;
  const lines = src.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_LINE);
    if (!open) { kept.push(lines[i]); continue; }

    const marker = open[1];
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = lines[j].match(FENCE_LINE);
      // Same marker character, at least as long, and no info string — CommonMark's
      // closing-fence rule. Anything else is content, including a nested fence.
      if (close && close[1][0] === marker[0] && close[1].length >= marker.length && !close[2]) break;
      body.push(lines[j]);
    }
    const closed = j < lines.length;

    if (!isJsonPayloadFence(open[2] || '', body.join('\n'), closed)) {
      kept.push(lines[i]);
      for (const b of body) kept.push(b);
      if (closed) kept.push(lines[j]);
    }
    // An unclosed JSON fence swallows the rest of the document by definition,
    // so falling out of the loop with i = lines.length drops exactly that.
    i = closed ? j : lines.length;
  }
  return kept.join('\n');
}

/**
 * Shortest `issues[]` leaf worth subtracting from the corpus.
 *
 * `toSentences` discards anything of 8 characters or fewer, so a shorter leaf
 * cannot carry a claim on its own — while the short values are exactly the ones
 * that recur inside genuine testimony (`"error"`, `"info"`, `"warning"`,
 * `"critical"`, `"bin/x.js"`), where blanking them would mangle the agent's own
 * words. The floor is the sentence floor, deliberately.
 */
const MIN_SUBTRACTED_LEAF = 9;

// ---------------------------------------------------------------------------
// Bounds on the leaf walk
//
// The walk must terminate on any payload, so the bounds cannot go away. What
// they can do is sit where no real `issues[]` reaches them. The first pair
// (depth 8 / 500 leaves) did not: probing the subtraction with 15 payload
// shapes left 2 bypasses, both of them the caps rather than the algorithm — a
// findings list longer than 500 leaves, and a finding nested past 8 levels.
// Both are reachable by an ordinary large review, and a bypass here is a false
// BLOCK: the leaked text is another agent's quoted claim, charged to a spawn
// with no way to produce evidence for it (v2.3.18 W8 C-3).
//
// Depth is free to raise — it bounds recursion, not scanning. 8 → 64 closes the
// nesting shape at no cost.
//
// Count is not. Subtraction is O(leaves × |src|), `src` being the
// MAX_STRIP_BYTES (256 KB) tail `buildClaimText` passes in. Measured worst case
// (distinct findings that ALL match, so every iteration pays a split+join):
//
//     500 → 2 ms   1 000 → 5 ms   2 000 → 16 ms   3 000 → 41 ms   5 000 → 164 ms
//
// 3 000 is the last point worth paying on a SubagentStop, and 2.5× the largest
// shape the probe found. Beyond it growth is quadratic until `src` saturates at
// 256 KB (20 000 leaves → 493 ms) — the answer to "why not drop the cap".
//
// MAX_LEAF_VISITS covers a gap the count cap never did: `out.length` only counts
// leaves at or above MIN_SUBTRACTED_LEAF, so a payload of millions of short
// strings was walked in full under the old bound.
//
// Truncation past those bounds is NOT a residual leak: `subtractIssueLeaves`
// discards the prose wholesale rather than returning a corpus scrubbed of the
// first 3 000 findings and carrying the rest. The spawn's own summary and
// assumptions still reach the claim corpus; what is lost is claim-gating of
// prose outside the Structured Result, for a payload with 3 000+ findings.
// A deliberate lean toward not-blocking, and loud in every count the gate
// already reports.
// ---------------------------------------------------------------------------

const MAX_LEAF_DEPTH  = 64;
const MAX_LEAF_COUNT  = 3000;
const MAX_LEAF_VISITS = 200000;

/**
 * Collect the string leaves of a value.
 *
 * `budget.truncated` is set when any bound stopped the walk — the caller needs
 * to know that what it got back is a prefix, not the whole set.
 *
 * @param {*} value
 * @param {string[]} out
 * @param {number} depth
 * @param {{n:number, truncated:boolean}} [visits] — shared walk budget.
 * @returns {string[]}
 */
function collectStringLeaves(value, out, depth, visits) {
  const budget = visits || { n: 0, truncated: false };
  if (out.length >= MAX_LEAF_COUNT || depth > MAX_LEAF_DEPTH) {
    budget.truncated = true;
    return out;
  }
  if (++budget.n > MAX_LEAF_VISITS) {
    budget.truncated = true;
    return out;
  }
  if (typeof value === 'string') {
    if (value.length >= MIN_SUBTRACTED_LEAF) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out, depth + 1, budget);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) collectStringLeaves(value[k], out, depth + 1, budget);
  }
  return out;
}

/**
 * Subtract the parsed `issues[]` string leaves from prose.
 *
 * The delimiter-agnostic close on the `issues[]` leak, and the reason the two
 * strips above are no longer the whole answer. Each of them is anchored on a
 * *delimiter* — a `## Structured Result` heading, then a fence — and each was
 * added after a payload arrived without the one before it. The fourth shape had
 * no delimiter at all: `structured_result` supplied as an object with the same
 * JSON repeated as bare text in `result`. Extraction succeeded, both strips
 * found nothing to anchor on, and a reviewer's quotation of a developer's "we
 * verified the hook fires" blocked the reviewer with a remedy no reviewer can
 * satisfy.
 *
 * Anchoring on the *content* instead ends the sequence: the leak is that
 * `sr.issues` text reached the corpus, and `sr.issues` is already parsed, so the
 * exact strings can be removed whatever wrapped them. No parser, no delimiter,
 * no fifth shape.
 *
 * Only ever called once the block has parsed — with `sr === null` nothing is
 * known to subtract and the raw text is all the corpus has.
 *
 * Returns `''` when the leaf walk hit a bound: a partly scrubbed corpus is the
 * leak itself, so an incomplete subtraction discards the prose rather than
 * shipping the tail of someone else's findings. See the bounds block above for
 * what that costs and why the caps sit where they do (v2.3.18 W8 C-3).
 *
 * @param {string} text
 * @param {object|null} sr parsed Structured Result
 * @returns {string}
 */
function subtractIssueLeaves(text, sr) {
  let src = String(text || '');
  if (!src || !sr || typeof sr !== 'object') return src;
  const budget = { n: 0, truncated: false };
  const leaves = collectStringLeaves(sr.issues, [], 0, budget);
  if (budget.truncated) return '';
  if (leaves.length === 0) return src;

  // Longest first: a finding that embeds a shorter one is removed whole rather
  // than shattered into fragments that no longer match.
  leaves.sort((a, b) => b.length - a.length);
  for (const leaf of leaves) {
    if (src.indexOf(leaf) !== -1) src = src.split(leaf).join(' ');
    // The same string as JSON re-serialises it: `"` → `\"`, a newline → `\n`.
    // Without this any finding carrying a quote or a line break survives.
    const escaped = JSON.stringify(leaf).slice(1, -1);
    if (escaped !== leaf && src.indexOf(escaped) !== -1) src = src.split(escaped).join(' ');
  }
  return src;
}

/** Split prose into claim-bearing sentences (bullets count as sentences). */
function toSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map(s => s.replace(/^[-*\d.)\s]+/, '').trim())
    .filter(s => s.length > 8 && s.length < 400);
}

function normalizeRole(role) {
  return String(role || '').toLowerCase().trim();
}

function ruleAppliesTo(rule, role) {
  return rule.roles.includes('*') || rule.roles.includes(normalizeRole(role));
}

/**
 * Match claim sentences against the rule table.
 *
 * @param {string} text
 * @param {string} role
 * @returns {{rule: ClaimRule, sentence: string}[]}
 */
function matchClaims(text, role) {
  const out = [];
  for (const s of toSentences(text)) {
    for (const r of RULES) {
      if (!ruleAppliesTo(r, role)) continue;
      if (r.claim.test(s)) out.push({ rule: r, sentence: s });
    }
  }
  return out;
}

/**
 * Evidence search: strongest match wins.
 *
 * 'strong' = a tool in `evidence.tools` (or, when `tools` is empty, any tool)
 * whose `name + ' ' + JSON.stringify(input)` also satisfies `evidence.argRe`.
 * 'weak'   = a right-shaped call that failed argRe, or a bare `Read`.
 *
 * A rule may also declare `evidence.events`: audit event types that satisfy it
 * without a transcript tool call. That is not a loophole — it is how an
 * obligation discharged *for* the agent (M1 prefetch grounding) stays visible.
 * The probe is only consulted when the transcript yielded nothing strong, so
 * it can never downgrade real evidence.
 *
 * @param {ClaimRule} rule
 * @param {{name:string, input:object, idx:number}[]} calls
 * @param {{hasAuditEvent?: function(string[]): boolean}} [opts]
 * @returns {{strength:'strong'|'weak', tool:string, idx:number}|null}
 */
function findEvidence(rule, calls, opts) {
  const wanted = (rule.evidence && rule.evidence.tools) || [];
  const argRe = rule.evidence && rule.evidence.argRe;
  const events = (rule.evidence && rule.evidence.events) || [];
  let weak = null;
  for (const c of calls || []) {
    // Empty `tools` means "any tool, argRe decides" — used by name-pattern rules
    // such as mcp-grounded (/^mcp__/).
    if (wanted.length > 0 && !wanted.includes(c.name)) {
      // A Read on a relevant path is weak corroboration, never sufficient.
      if (c.name === 'Read') weak = weak || { strength: 'weak', tool: 'Read', idx: c.idx };
      continue;
    }
    const hay = callHaystack(c);
    if (argRe && !argRe.test(hay)) {
      if (wanted.length > 0) weak = weak || { strength: 'weak', tool: c.name, idx: c.idx };
      continue;
    }
    return { strength: 'strong', tool: c.name, idx: c.idx };
  }

  if (events.length > 0 && opts && typeof opts.hasAuditEvent === 'function') {
    let seen = null;
    try { seen = opts.hasAuditEvent(events); } catch (_e) { seen = null; }
    if (seen) {
      return {
        strength: 'strong',
        tool: 'audit:' + (typeof seen === 'string' ? seen : events[0]),
        idx: -1,
      };
    }
  }
  return weak;
}

/**
 * Turn Structured Result fields and observed tool calls into claim sentences.
 *
 * This is how the role-critical point-gates survive the port: their triggers
 * were JSON fields and tool sequences, not prose. Synthesising a sentence puts
 * them through the same single matcher instead of a second code path.
 *
 * @param {object|null} sr    parsed Structured Result
 * @param {string} role
 * @param {{name:string}[]} [calls] transcript tool calls
 * @returns {string[]} sentences, each prefixed with SYNTHETIC_PREFIX
 */
function syntheticClaims(sr, role, calls) {
  const r = normalizeRole(role);
  const out = [];

  if (sr && typeof sr === 'object') {
    if (sr.tests_passing === true) {
      out.push('tests_passing: true — the test suite passes.');
    }
    if (r === 'researcher' && !isNoClearFit(sr)) {
      out.push('research verdict issued with cited sources.');
    }
    // Only when the oracle actually asserted something — an oracle that
    // reports "no documented behaviour found" has nothing to ground, and must
    // stay downgradeable.
    const oracleAsserted = (Array.isArray(sr.claims) && sr.claims.length > 0) ||
      (Array.isArray(sr.findings) && sr.findings.length > 0) ||
      sr.source_url || sr.stability_tier;
    if (r === 'platform-oracle' && oracleAsserted) {
      out.push('platform claims asserted with stability_tier and source_url grounding.');
    }
  }

  // Unconditional for allowlisted roles — mirrors the retired mcp-grounding
  // gate, which fired on every spawn of those roles regardless of content.
  if (MCP_GROUNDING_ROLES.includes(r)) {
    out.push('result produced by a grounding-required role.');
  }

  // Consulting the pattern catalog creates the obligation to acknowledge it —
  // the trigger the retired validate-pattern-application.js used.
  if (Array.isArray(calls) && calls.some(c => String(c.name || '').includes('pattern_find'))) {
    out.push('consulted the pattern catalog; pattern guidance applied.');
  }

  return out.map(s => SYNTHETIC_PREFIX + s);
}

/**
 * Evaluate the Structured-Result assertion table.
 *
 * @param {object|null} sr
 * @param {string} role
 * @returns {{assertion: SrAssertion, violations: string[]}[]} failures only
 */
function evaluateAssertions(sr, role) {
  if (!sr || typeof sr !== 'object') return [];
  const r = normalizeRole(role);
  const out = [];
  for (const a of SR_ASSERTIONS) {
    if (!a.roles.includes('*') && !a.roles.includes(r)) continue;
    let violations = [];
    try { violations = a.check(sr) || []; } catch (_e) { violations = []; }
    if (violations.length > 0) out.push({ assertion: a, violations });
  }
  return out;
}

/**
 * Extract a Structured Result from a hook payload.
 * (Shared shape, previously duplicated across the six point-gates.)
 */
function extractStructuredResult(event) {
  if (!event) return null;
  if (event.structured_result && typeof event.structured_result === 'object') {
    return event.structured_result;
  }
  const direct = event.agent_output_json || event.result_json;
  if (direct && typeof direct === 'object') return direct;

  const raw = rawOutputText(event);
  if (!raw) return null;

  const tail = raw.slice(-65536);
  const m = tail.match(/##\s*Structured Result[\s\S]*?```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (m) {
    try { return JSON.parse(m[1]); } catch (_e) { /* fall through */ }
  }
  return null;
}

module.exports = {
  RULES,
  SR_ASSERTIONS,
  MCP_GROUNDING_ROLES,
  EXECUTION_ROLES,
  MIN_RESEARCH_SOURCES,
  VALID_STABILITY_TIERS,
  SYNTHETIC_PREFIX,
  RAW_OUTPUT_FIELDS,
  rawOutputText,
  stripNonTestimony,
  stripStructuredResultSection,
  stripStructuredResultFences,
  subtractIssueLeaves,
  toSentences,
  matchClaims,
  findEvidence,
  syntheticClaims,
  evaluateAssertions,
  extractStructuredResult,
  countSources,
  isNoClearFit,
};
