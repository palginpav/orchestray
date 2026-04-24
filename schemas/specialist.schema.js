'use strict';

/**
 * schemas/specialist.schema.js — zod schema for specialist templates.
 *
 * v2.1.13 R-ZOD. Validates the YAML frontmatter block of every `*.md` file
 * under `specialists/`. Mirrors the rules already enforced by
 * `bin/validate-specialist.js` (the existing ad-hoc lint, v2.1.9 B3) so the
 * two checks stay in agreement.
 *
 * Required fields:
 *   - name         : kebab-case basename (matches filename)
 *   - description  : single-line, ≤ MAX_DESCRIPTION_LENGTH (500)
 *   - model        : alias ("haiku" | "sonnet" | "opus" | "inherit") OR a
 *                    known model id prefix ("claude-haiku...", etc.)
 *
 * Optional fields:
 *   - tools        : comma-separated string OR array of strings
 *   - memory       : "user" | "project" | "local"
 *   - effort       : "low" | "medium" | "high" | "xhigh" | "max"
 *
 * Compatibility note: keep MAX_DESCRIPTION_LENGTH in sync with
 * `bin/validate-specialist.js` — both constants reflect the same v2.1.8
 * decision to allow up to 500 chars (the PM §21 trigger-phrase routing reads
 * the description directly).
 */

const { z } = require('./_validator');

const VALID_MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'inherit'];
const MODEL_ID_PREFIXES = ['claude-haiku', 'claude-sonnet', 'claude-opus'];
const VALID_MEMORY = ['user', 'project', 'local'];
const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

// Same ceiling as validate-specialist.js MAX_DESCRIPTION_LENGTH.
const MAX_DESCRIPTION_LENGTH = 500;

const modelField = z.string().min(1).refine(
  (v) => {
    const trimmed = v.trim();
    if (VALID_MODEL_ALIASES.includes(trimmed)) return true;
    return MODEL_ID_PREFIXES.some((p) => trimmed.startsWith(p));
  },
  {
    message:
      'model must be one of {haiku, sonnet, opus, inherit} or a claude-* model id',
  }
);

const toolsField = z.union([
  z.string().min(1),
  z.array(z.string().min(1)),
]);

const specialistFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, {
      message: 'name must be lowercase kebab-case (letters, digits, hyphens)',
    }),
  description: z
    .string()
    .min(1)
    .max(MAX_DESCRIPTION_LENGTH, {
      message: `description must be ≤ ${MAX_DESCRIPTION_LENGTH} characters`,
    }),
  model: modelField,
  tools: toolsField.optional(),
  memory: z.enum(VALID_MEMORY).optional(),
  effort: z.enum(VALID_EFFORT).optional(),
}).passthrough();

module.exports = {
  specialistFrontmatterSchema,
  VALID_MODEL_ALIASES,
  MODEL_ID_PREFIXES,
  VALID_MEMORY,
  VALID_EFFORT,
  MAX_DESCRIPTION_LENGTH,
};
