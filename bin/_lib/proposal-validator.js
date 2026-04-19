'use strict';

const { foldToSkeleton } = require('./unicode-confusables');

/**
 * proposal-validator.js — Layer B output validator for auto-extracted pattern proposals.
 *
 * Enforces the schema defined in v2.1.6 design §6.2:
 *   - Strict field set (no extra fields allowed)
 *   - Protected fields rejected (METR invariant, §6.5)
 *   - confidence capped at 0.7 (reward-hacking prevention)
 *   - Injection-marker heuristic on description + approach (F-01 Layer B)
 *   - Error messages never echo rejected values (F-07)
 *
 * Hand-rolled validation per project convention (no zod dependency).
 *
 * SECURITY NOTE — Layer B is a canary, NOT a gate.
 * Primary defenses are:
 *   Layer A: event-quarantine.js field-allowlist (strips free-text before LLM sees it)
 *   Layer C: human review via `accept <slug>` showing full body + approach
 * Layer B (this module) adds defense-in-depth via regex heuristics. It is
 * intentionally imperfect and must not be relied upon as the sole protection.
 * W3 callers MUST always pass events through quarantineEvents() first.
 *
 * v2.1.6 — W1 safety boundary; W1b patch — Unicode/paraphrase hardening (W2-01).
 */

// ---------------------------------------------------------------------------
// Normalisation helpers (W2-01 fix)
// ---------------------------------------------------------------------------

/**
 * Minimal HTML entity decoder for the subset used in injection attempts.
 * Max ~15 lines — no library import (project convention: no new deps).
 *
 * Handles: &lt; &gt; &amp; &quot; &#xNN; &#DDD;
 *
 * @param {string} text
 * @returns {string}
 */
function _decodeHtmlEntities(text) {
  return text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x([0-9a-fA-F]{1,4});/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]{1,5});/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Decode source-form unicode/hex escapes that an LLM might evaluate.
 * e.g. \u0049 → I,  \x49 → I
 *
 * @param {string} text
 * @returns {string}
 */
function _decodeSourceEscapes(text) {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Collapse punctuation-separated individual letters to their joined form.
 * "I.G.N.O.R.E." → "IGNORE"   "I-G-N-O-R-E" → "IGNORE"
 *
 * @param {string} text
 * @returns {string}
 */
function _collapsePunctuationLetters(text) {
  // Replace sequences like A.B.C. or A-B-C or A_B_C or A B (single-letter words)
  // with the letters joined. We repeat until stable to handle long sequences.
  let prev = '';
  let cur = text;
  while (prev !== cur) {
    prev = cur;
    cur = cur.replace(/\b([A-Za-z])[.\-_ ]+(?=[A-Za-z]\b)/g, '$1');
  }
  return cur;
}

/**
 * Detect mixed-script text (Latin + Greek/Cyrillic/Han in same string).
 * Homoglyph attacks use this technique to defeat ASCII-only regex.
 *
 * @param {string} text
 * @returns {boolean}
 */
function _hasMixedScript(text) {
  const hasLatin    = /[A-Za-z]/.test(text);
  const hasNonLatin = /[\u0370-\u03FF\u0400-\u04FF\u4E00-\u9FFF]/u.test(text);
  return hasLatin && hasNonLatin;
}

/**
 * Normalise text for injection-marker matching (W2-01).
 *
 * Steps (in order):
 *   1. NFKC normalisation — maps fullwidth/compatibility chars to ASCII equivalents.
 *   2. Strip zero-width characters.
 *   3. Decode HTML entities.
 *   4. Decode source-form unicode/hex escapes.
 *   5. NFKD + diacritic strip — maps accented Latin and some homoglyphs to ASCII.
 *   5b. UTS#39 confusables fold — folds Cyrillic/Greek/Armenian/Mathematical
 *       lookalikes to their ASCII skeleton. This catches single-codepoint
 *       substitutions (e.g. Cyrillic а U+0430) that NFKD cannot decompose
 *       to ASCII because they have no Unicode decomposition. See
 *       bin/_lib/unicode-confusables.js for the hand-curated subset.
 *   6. Collapse punctuation-separated letters.
 *   7. Lowercase.
 *
 * The original text is preserved for storage; only the normalised copy is tested
 * against markers.
 *
 * @param {string} text
 * @returns {string}
 */
function _normaliseForMarkerScan(text) {
  if (typeof text !== 'string') return '';

  // Step 1: NFKC — maps ｆｕｌｌｗｉｄｔｈ, ² etc. to ASCII
  let out = text.normalize('NFKC');

  // Step 2: strip zero-width chars (U+200B–U+200D, U+FEFF)
  out = out.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // Step 3: decode HTML entities
  out = _decodeHtmlEntities(out);

  // Step 4: decode source-form escapes
  out = _decodeSourceEscapes(out);

  // Step 5: NFKD + remove combining diacritics (marks, category M)
  // This maps accented Latin chars to base ASCII; partial for Greek/Cyrillic
  // where the Unicode decomposition doesn't produce ASCII.
  out = out.normalize('NFKD').replace(/\p{M}/gu, '');

  // Step 5b: UTS#39 confusables fold — catches single-codepoint Cyrillic/Greek
  // lookalikes that survive NFKD because they have no ASCII decomposition
  // (e.g. Cyrillic а U+0430 does not decompose to Latin a). The mixed-script
  // detector is kept as defense-in-depth but is now redundant for the
  // homoglyph attack class after this fold.
  out = foldToSkeleton(out);

  // Step 6: collapse punctuation-separated letters (I.G.N.O.R.E. → IGNORE)
  out = _collapsePunctuationLetters(out);

  // Step 7: lowercase
  return out.toLowerCase();
}

// ---------------------------------------------------------------------------
// Injection-marker heuristics (Layer B)
// ---------------------------------------------------------------------------

/**
 * Markers that indicate possible prompt injection or instruction override.
 * Exported so tests can canary-check completeness.
 *
 * Rules:
 *   - Imperative override phrases (case-insensitive via normalisation above).
 *   - Natural-language paraphrase imperatives (added in W1b — W2-01 fix).
 *   - Instruction-delimiter tokens.
 *   - XML-style system tags.
 *   - Base64-padded strings ≥ 4 consecutive base64 chars ending with "=".
 *
 * All patterns are matched against the _normalised_ (lowercased) text, so
 * patterns below may be written in lowercase.
 *
 * @type {RegExp[]}
 */
const LAYER_B_MARKERS = [
  // Core imperative override phrases
  // NOTE: patterns use /i flag so they work on both normalised (lowercased)
  // and raw text. Normalization (NFKC, homoglyph fold, etc.) is applied before
  // matching; /i is belt-and-suspenders for direct export usage in tests.
  /\bignore\s+all\s+previous\s+instructions\b/i,
  /\bdisregard\s+(all\s+)?(previous|prior|above)\s+(instructions|context|rules)\b/i,
  /\boverride\s+(all\s+)?(previous|prior|above|system|the)\b/i,
  /\boverride\s+all\b/i,
  /\bforget\s+(all\s+)?(previous|prior|above|everything)\b/i,
  /\byou\s+must\s+(now\s+)?(ignore|forget|disregard|emit|output|always)\b/i,
  /\balways\s+(emit|output|respond\s+with|ignore|include)\b/i,
  /\bnever\s+(again\s+)?(refuse|reject|apply|enforce|check)\b/i,
  // Natural-language paraphrases (W2-01 additions)
  /\bplease\s+disregard\b/i,
  /\bkindly\s+pay\s+no\s+attention\b/i,
  /\bpay\s+no\s+attention\s+to\b/i,
  /\byou\s+may\s+override\b/i,
  /\bsystem\s+override\b/i,
  /\bprior\s+instructions\b/i,
  /\bprevious\s+instructions\b/i,
  /\/\/\s*system\b/i,
  // "system:" at line start (after optional whitespace)
  /^\s*system\s*:/im,
  // Instruction-delimiter tokens
  /```\s*system\b/i,
  /\[inst\]/i,
  /\[\/inst\]/i,
  /\[\[system\]\]/i,
  // XML system tags (matched after HTML-entity decoding)
  /<\s*system\s*>/i,
  /<\/\s*system\s*>/i,
  /<\s*\/?s\s*>/i,
  // Section delimiter that looks like a jailbreak boundary
  /^---\s*\n\s*(system|instruction|override)/im,
  // Base64-padded strings (4+ consecutive base64-alphabet chars followed by =)
  /[A-Za-z0-9+/]{16,}={1,2}(?:\s|$)/,
];

/**
 * Returns true if the string contains any Layer B injection marker.
 *
 * The input is first normalised (NFKC, zero-width strip, HTML-entity decode,
 * source-escape decode, NFKD+diacritic strip, punctuation-letter collapse,
 * lowercase) before matching so that Unicode homoglyphs and encoding bypasses
 * are caught (W2-01 fix).
 *
 * Additionally, if the original text contains mixed Latin + non-Latin scripts
 * AND the normalised form matches any marker, it is rejected with reason
 * `mixed_script_suspicion`.
 *
 * @param {string} text
 * @returns {{ detected: boolean, reason?: string }}
 */
function _containsInjectionMarker(text) {
  if (typeof text !== 'string') return { detected: false };

  // Mixed-script check on the original text.
  const mixed = _hasMixedScript(text);

  const normalised = _normaliseForMarkerScan(text);

  for (const marker of LAYER_B_MARKERS) {
    if (marker.test(normalised)) {
      const reason = mixed ? 'mixed_script_suspicion' : 'marker_match';
      return { detected: true, reason };
    }
  }

  // If mixed-script but no marker match on normalised text, still flag —
  // the homoglyph may have survived normalisation but looks suspicious.
  if (mixed) {
    // Only flag if the normalised text is meaningfully different from original
    // (i.e. normalisation actually changed something — sign of an encoding trick).
    if (normalised !== text.toLowerCase()) {
      return { detected: true, reason: 'mixed_script_suspicion' };
    }
  }

  return { detected: false };
}

// ---------------------------------------------------------------------------
// Protected fields (METR invariant, §6.5)
// These fields may only be set by human-authorized paths or the MCP tool layer.
// Any proposal that includes them is rejected.
// ---------------------------------------------------------------------------

const PROTECTED_FIELDS = new Set([
  'trigger_actions',
  'deprecated',
  'deprecated_at',
  'deprecated_reason',
  'merged_from',
  'times_applied',
  'last_applied',
  'decay_half_life_days',
]);

// ---------------------------------------------------------------------------
// Allowed schema fields (strict mode — unknown fields cause rejection)
// ---------------------------------------------------------------------------

const ALLOWED_FIELDS = new Set([
  'name',
  'category',
  'tip_type',
  'confidence',
  'description',
  'approach',
  'evidence_orch_id',
]);

const VALID_CATEGORIES = new Set([
  'decomposition',
  'routing',
  'specialization',
  'anti-pattern',
  'user-correction',
]);

const VALID_TIP_TYPES = new Set([
  'strategy',
  'recovery',
  'optimization',
]);

const NAME_REGEX   = /^[a-z0-9-]{3,64}$/;
const ORCH_ID_REGEX = /^orch-[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

/**
 * Validate a pattern proposal object.
 *
 * Error `detail` fields never contain rejected values (F-07 — prevents
 * echoing attacker strings into events.jsonl).
 *
 * @param {object} proposal - The proposal object to validate.
 * @param {object} [opts]
 * @param {boolean} [opts.strict=true] - When true (default), reject unknown fields.
 * @returns {{ ok: true, proposal: object } | { ok: false, errors: Array<{field: string, rule: string}> }}
 */
function validateProposal(proposal, opts) {
  const strict = (opts && opts.strict === false) ? false : true;
  const errors = [];

  if (proposal === null || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return { ok: false, errors: [{ field: '<root>', rule: 'must be a plain object' }] };
  }

  // --- 1. Protected-field check (F-03/F-08 METR invariant) ---
  for (const key of Object.keys(proposal)) {
    if (PROTECTED_FIELDS.has(key)) {
      errors.push({ field: key, rule: 'protected field — human/curator-authorized only' });
    }
  }

  // --- 2. Unknown-field check (strict mode) ---
  if (strict) {
    for (const key of Object.keys(proposal)) {
      if (!ALLOWED_FIELDS.has(key) && !PROTECTED_FIELDS.has(key)) {
        errors.push({ field: key, rule: 'unknown field (strict mode)' });
      }
    }
  }

  // If protected or unknown fields were found, return immediately to avoid
  // processing further — do not leak information about which values failed.
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // --- 3. Required fields ---

  // name
  if (typeof proposal.name !== 'string') {
    errors.push({ field: 'name', rule: 'required string' });
  } else if (!NAME_REGEX.test(proposal.name)) {
    errors.push({ field: 'name', rule: 'regex mismatch: must match /^[a-z0-9-]{3,64}$/' });
  }

  // category
  if (typeof proposal.category !== 'string') {
    errors.push({ field: 'category', rule: 'required string' });
  } else if (!VALID_CATEGORIES.has(proposal.category)) {
    errors.push({ field: 'category', rule: 'invalid enum value' });
  }

  // confidence
  if (typeof proposal.confidence !== 'number') {
    errors.push({ field: 'confidence', rule: 'required number' });
  } else if (proposal.confidence < 0.3 || proposal.confidence > 0.7) {
    errors.push({ field: 'confidence', rule: 'out of range: must be in [0.3, 0.7]' });
  }

  // description
  if (typeof proposal.description !== 'string') {
    errors.push({ field: 'description', rule: 'required string' });
  } else if (proposal.description.length < 10 || proposal.description.length > 200) {
    errors.push({ field: 'description', rule: 'length out of range: must be 10–200 chars' });
  } else if (_containsInjectionMarker(proposal.description).detected) {
    errors.push({ field: 'description', rule: 'Layer B injection marker detected' });
  }

  // approach
  if (typeof proposal.approach !== 'string') {
    errors.push({ field: 'approach', rule: 'required string' });
  } else if (proposal.approach.length < 20 || proposal.approach.length > 2000) {
    errors.push({ field: 'approach', rule: 'length out of range: must be 20–2000 chars' });
  } else if (_containsInjectionMarker(proposal.approach).detected) {
    errors.push({ field: 'approach', rule: 'Layer B injection marker detected' });
  }

  // evidence_orch_id
  if (typeof proposal.evidence_orch_id !== 'string') {
    errors.push({ field: 'evidence_orch_id', rule: 'required string' });
  } else if (!ORCH_ID_REGEX.test(proposal.evidence_orch_id)) {
    errors.push({ field: 'evidence_orch_id', rule: 'regex mismatch: must match /^orch-[a-z0-9-]+$/' });
  }

  // --- 4. Optional tip_type ---
  if (proposal.tip_type !== undefined) {
    if (typeof proposal.tip_type !== 'string' || !VALID_TIP_TYPES.has(proposal.tip_type)) {
      errors.push({ field: 'tip_type', rule: 'invalid enum value: must be strategy|recovery|optimization' });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, proposal };
}

module.exports = { validateProposal, LAYER_B_MARKERS, PROTECTED_FIELDS };
