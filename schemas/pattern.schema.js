'use strict';

/**
 * schemas/pattern.schema.js — zod schema for pattern frontmatter.
 *
 * v2.1.13 R-ZOD. Validates the YAML frontmatter block of every `*.md` file
 * under `.orchestray/patterns/`. Fields mirror what the pattern-find MCP tool
 * (`bin/mcp-server/tools/pattern_find.js`) consumes and what the pattern-
 * extractor writes.
 *
 * Authoritative field list (from surveying `.orchestray/patterns/*.md` on
 * the v2.1.12 codebase):
 *   - name               : required, kebab-case basename (matches filename)
 *   - category           : required, enum — see CATEGORIES below
 *   - confidence         : required, number in [0, 1]
 *   - description        : required, string
 *   - times_applied      : optional, non-negative integer
 *   - last_applied       : optional, ISO timestamp or null
 *   - created_from       : optional, orchestration-id string
 *   - deprecated         : optional, boolean
 *   - deprecated_at      : optional, ISO timestamp
 *   - deprecated_reason  : optional, string
 *   - trigger_actions    : optional, array of strings
 *   - source             : optional, string — provenance hint ("auto", "manual")
 *   - sharing            : optional, enum ("local-only" | "federated") — v2.1.13 R-FED-PRIVACY
 *   - applies_to         : optional, array of strings — free-form scope hints
 *   - tags               : optional, array of strings
 */

const { z } = require('./_validator');

// See v2.1.13 R-ZOD scope + `pattern_find` tool JSON schema (agent_role /
// categories mirror the enum used in the MCP surface).
const CATEGORIES = [
  'decomposition',
  'routing',
  'specialization',
  'anti-pattern',
  'design-preference',
  'user-correction',
  'roi',
];

const categoryEnum = z.enum(CATEGORIES);

// R-FED-PRIVACY (v2.1.13) — new key that must be schema-accepted from day one
// even if the current pattern corpus hasn't adopted it yet. Migration-safe
// default is "federated" at read time; the schema accepts missing key.
const sharingEnum = z.enum(['local-only', 'federated']);

// ------------------------------------------------------------------
// YAML-string preprocessors
//
// The simple YAML frontmatter parser used across Orchestray (see
// `bin/validate-specialist.js::parseFrontmatter`) returns every scalar as a
// string — YAML's implicit typing ("0.7" → number, "null" → null, "true" →
// boolean) is not resolved. Rather than duplicating YAML typing rules in the
// parser we coerce per-field in the schema using `z.preprocess`. This keeps
// the parser simple and the type rules declarative in one place.
// ------------------------------------------------------------------

/** Coerce YAML-string representations of numbers to actual numbers. */
const yamlNumber = z.preprocess((v) => {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return v; // let zod emit "Expected number"
    const n = Number(t);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}, z.number());

/** Coerce YAML-string representations of booleans ("true"/"false") to actual booleans. */
const yamlBoolean = z.preprocess((v) => {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return v;
}, z.boolean());

/** Coerce YAML-string "null" to JS null (so `last_applied: null` works). */
function coerceYamlNull(v) {
  if (typeof v === 'string' && v.trim().toLowerCase() === 'null') return null;
  return v;
}

// ISO-8601-ish timestamp. We don't use z.string().datetime() because the
// pattern corpus historically stores both "2026-04-17T17:36:11.111Z" and
// "2026-04-16T14:01:00Z" — both are valid ISO-8601 but zod's strict datetime
// matcher varies across 3.x releases. A permissive regex keeps back-compat.
const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, {
    message: 'must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SS[.sss]Z)',
  });

/** `last_applied: null` OR ISO timestamp string. Coerces the YAML "null" literal. */
const yamlIsoOrNull = z.preprocess(coerceYamlNull, isoTimestamp.nullable());

const patternFrontmatterSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'name must be lowercase kebab-case (letters, digits, hyphens)',
  }),
  category: categoryEnum,
  confidence: yamlNumber.pipe(z.number().min(0).max(1)),
  description: z.string().min(1),

  // Optional / observed-in-corpus fields
  times_applied: yamlNumber.pipe(z.number().int().min(0)).optional(),
  last_applied: yamlIsoOrNull.optional(),
  created_from: z.string().min(1).optional(),

  // Deprecation metadata
  deprecated: yamlBoolean.optional(),
  deprecated_at: isoTimestamp.optional(),
  deprecated_reason: z.string().optional(),

  // Trigger heuristics + provenance
  trigger_actions: z.array(z.string().min(1)).optional(),
  source: z.string().optional(),

  // v2.1.13 R-FED-PRIVACY — per-pattern sharing control
  sharing: sharingEnum.optional(),

  // Free-form scoping hints observed in some hand-written patterns
  applies_to: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
}).passthrough(); // future-compat: new optional keys don't hard-fail old schema

module.exports = {
  patternFrontmatterSchema,
  CATEGORIES,
  categoryEnum,
  sharingEnum,
  isoTimestamp,
  // Exposed for reuse in specialist.schema.js and future schemas that need
  // to validate YAML-string primitives (numbers/booleans/null) uniformly.
  yamlNumber,
  yamlBoolean,
  yamlIsoOrNull,
};
