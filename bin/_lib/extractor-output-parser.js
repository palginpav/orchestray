'use strict';

/**
 * extractor-output-parser.js — Pure parser for Haiku extractor subprocess output.
 *
 * Exports `parseExtractorOutput(stdout)` which validates that the subprocess emitted
 * a valid `ExtractorOutput` JSON object (§4.A.3 of the v2.1.7 roadmap) and translates
 * it into the Layer-B-compatible proposal shape expected by `validateProposal`.
 *
 * Rejection criteria (any one causes ALL proposals to be dropped):
 *   - Output is not valid JSON
 *   - `schema_version !== 1`
 *   - `proposals` is not an array
 *   - Any `proposals[i]` is missing a required field
 *   - Any `proposals[i].category` is not in the auto-extract category allowlist
 *   - Any body string field (`context_md`, `approach_md`, `title`) exceeds its size cap
 *
 * Translation (ExtractorOutput → Layer-B proposal shape):
 *   slug         → name  (kebab-case identifier)
 *   title        → description  (user-visible summary)
 *   approach_md  → approach     (grounded evidence narrative)
 *   category     → category     (pass-through)
 *   proposed_confidence → confidence (if present; else default 0.5)
 *   tip_type     → tip_type     (if present; else default 'strategy')
 *   source_event_ids[0] first orch-prefixed entry → evidence_orch_id (or orchId param)
 *
 * NOTE on tip_type: the ExtractorOutput interface (§4.A.3) does not require tip_type,
 * but validateProposal (Layer B) does. The parser defaults to 'strategy' when absent
 * and accepts 'strategy'|'recovery'|'optimization' when present. This is documented
 * as a deviation from the §4.A.3 type interface — the pattern-extractor.md prompt
 * encourages but does not require the field.
 *
 * v2.1.7 — Bundle A live backend.
 */

// Size caps matching §4.A.3
const MAX_TITLE_CHARS       = 120;
const MAX_CONTEXT_MD_CHARS  = 2000;
const MAX_APPROACH_MD_CHARS = 4000;
const MAX_EVIDENCE_REFS     = 10;
const SLUG_MIN = 8;
const SLUG_MAX = 64;
const SLUG_RE  = /^[a-z0-9-]+$/;

const VALID_CATEGORIES = new Set([
  'decomposition',
  'routing',
  'specialization',
  'design-preference',
]);

const VALID_TIP_TYPES = new Set([
  'strategy',
  'recovery',
  'optimization',
]);

const ORCH_ID_RE = /^orch-/;

/**
 * Match a single wrapping markdown code fence, e.g.:
 *   ```json
 *   {...}
 *   ```
 * The language tag is optional. Leading/trailing whitespace around the fence
 * is tolerated. Anything inside is captured and returned.
 *
 * Haiku often wraps structured output in a code fence despite explicit prompt
 * instructions not to — this strip is the fail-open recovery path.
 */
const CODE_FENCE_RE = /^\s*```(?:[A-Za-z0-9_+.-]+)?\s*\n([\s\S]*?)\n```\s*$/;

/**
 * Remove a single wrapping markdown code fence if present. Returns the inner
 * content trimmed. If no fence is present, returns the input trimmed.
 *
 * @param {string} raw
 * @returns {string}
 */
function _stripCodeFence(raw) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  const m = trimmed.match(CODE_FENCE_RE);
  if (m) return m[1].trim();
  return trimmed;
}

/**
 * @typedef {Object} ParseResult
 * @property {object[]} proposals   - Layer-B-compatible proposal objects (translated)
 * @property {string[]} parseErrors - Human-readable parse error descriptions
 */

/**
 * Parse and validate the raw stdout from the Haiku extractor subprocess.
 *
 * On any structural rejection (non-JSON, wrong schema_version, missing required
 * field in any proposal, or category outside allowlist), returns empty proposals
 * and populates parseErrors.
 *
 * Individual proposals that fail field-level validation within a structurally
 * valid envelope are dropped individually and reported in parseErrors.
 *
 * @param {string} stdout - Raw stdout from the extractor subprocess
 * @returns {ParseResult}
 */
function parseExtractorOutput(stdout) {
  // ── 1. JSON parse ──────────────────────────────────────────────────────────
  if (typeof stdout !== 'string' || !stdout.trim()) {
    return { proposals: [], parseErrors: ['empty or non-string stdout'] };
  }

  let parsed;
  const candidate = _stripCodeFence(stdout);
  try {
    parsed = JSON.parse(candidate);
  } catch (_e) {
    // Fallback: if fence-stripping changed the input and the stripped form failed,
    // retry on the raw trimmed input. Handles pathological cases where the fence
    // regex matched too greedily or the backend emitted nested fences.
    const raw = stdout.trim();
    if (candidate !== raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (_e2) {
        return { proposals: [], parseErrors: ['stdout is not valid JSON'] };
      }
    } else {
      return { proposals: [], parseErrors: ['stdout is not valid JSON'] };
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { proposals: [], parseErrors: ['ExtractorOutput must be a JSON object'] };
  }

  // ── 2. schema_version check ────────────────────────────────────────────────
  if (parsed.schema_version !== 1) {
    return {
      proposals:   [],
      parseErrors: [`schema_version must be 1, got: ${JSON.stringify(parsed.schema_version)}`],
    };
  }

  // ── 3. proposals array check ───────────────────────────────────────────────
  if (!Array.isArray(parsed.proposals)) {
    return { proposals: [], parseErrors: ['proposals must be an array'] };
  }

  // ── 4. Validate and translate each proposal ────────────────────────────────
  const translated = [];
  const parseErrors = [];

  for (let i = 0; i < parsed.proposals.length; i++) {
    const p = parsed.proposals[i];
    const prefix = `proposals[${i}]`;

    if (p === null || typeof p !== 'object' || Array.isArray(p)) {
      parseErrors.push(`${prefix}: must be a plain object`);
      continue;
    }

    // Required fields presence check
    const missing = [];
    for (const field of ['slug', 'category', 'title', 'context_md', 'approach_md', 'evidence_refs', 'source_event_ids']) {
      if (!(field in p)) missing.push(field);
    }
    if (missing.length > 0) {
      parseErrors.push(`${prefix}: missing required fields: ${missing.join(', ')}`);
      continue;
    }

    // slug validation
    if (typeof p.slug !== 'string'
      || p.slug.length < SLUG_MIN
      || p.slug.length > SLUG_MAX
      || !SLUG_RE.test(p.slug)) {
      parseErrors.push(`${prefix}: slug must be kebab-case ${SLUG_MIN}..${SLUG_MAX} chars`);
      continue;
    }

    // category validation (auto-extract allowlist)
    if (!VALID_CATEGORIES.has(p.category)) {
      parseErrors.push(`${prefix}: category '${p.category}' not in allowlist`);
      continue;
    }

    // title validation
    if (typeof p.title !== 'string'
      || p.title.length < 10
      || p.title.length > MAX_TITLE_CHARS) {
      parseErrors.push(`${prefix}: title must be 10..${MAX_TITLE_CHARS} chars`);
      continue;
    }

    // context_md validation
    if (typeof p.context_md !== 'string' || p.context_md.length > MAX_CONTEXT_MD_CHARS) {
      parseErrors.push(`${prefix}: context_md must be a string ≤${MAX_CONTEXT_MD_CHARS} chars`);
      continue;
    }

    // approach_md validation
    if (typeof p.approach_md !== 'string' || p.approach_md.length > MAX_APPROACH_MD_CHARS) {
      parseErrors.push(`${prefix}: approach_md must be a string ≤${MAX_APPROACH_MD_CHARS} chars`);
      continue;
    }

    // evidence_refs validation
    if (!Array.isArray(p.evidence_refs) || p.evidence_refs.length > MAX_EVIDENCE_REFS) {
      parseErrors.push(`${prefix}: evidence_refs must be an array of ≤${MAX_EVIDENCE_REFS} entries`);
      continue;
    }

    // source_event_ids validation
    if (!Array.isArray(p.source_event_ids)) {
      parseErrors.push(`${prefix}: source_event_ids must be an array`);
      continue;
    }

    // tip_type (optional in ExtractorOutput, required by Layer B)
    let tipType = 'strategy';
    if ('tip_type' in p) {
      if (!VALID_TIP_TYPES.has(p.tip_type)) {
        parseErrors.push(`${prefix}: tip_type '${p.tip_type}' not in allowlist`);
        continue;
      }
      tipType = p.tip_type;
    }

    // proposed_confidence (optional)
    let confidence = 0.5;
    if ('proposed_confidence' in p) {
      const c = p.proposed_confidence;
      if (typeof c !== 'number' || !isFinite(c) || c < 0.3 || c > 0.7) {
        parseErrors.push(`${prefix}: proposed_confidence must be a number in [0.3, 0.7]`);
        continue;
      }
      confidence = c;
    }

    // Derive evidence_orch_id from source_event_ids (first orch-prefixed entry)
    // or from evidence_refs. Falls back to 'unknown'.
    let evidenceOrchId = 'unknown';
    for (const id of p.source_event_ids) {
      if (typeof id === 'string' && ORCH_ID_RE.test(id)) {
        evidenceOrchId = id;
        break;
      }
    }
    if (evidenceOrchId === 'unknown') {
      for (const ref of p.evidence_refs) {
        if (typeof ref === 'string' && ORCH_ID_RE.test(ref)) {
          evidenceOrchId = ref;
          break;
        }
      }
    }

    // Translate to Layer-B proposal shape:
    //   slug        → name
    //   title       → description
    //   approach_md → approach
    //   evidence_orch_id derived above
    translated.push({
      name:             p.slug,
      category:         p.category,
      tip_type:         tipType,
      confidence,
      description:      p.title,
      approach:         p.approach_md,
      evidence_orch_id: evidenceOrchId,
    });
  }

  return { proposals: translated, parseErrors };
}

module.exports = { parseExtractorOutput, _stripCodeFence };
