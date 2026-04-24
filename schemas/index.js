'use strict';

/**
 * schemas/index.js — barrel export + `validateOrDie` helper.
 *
 * v2.1.13 R-ZOD. Boot-validation entry points. Every caller that needs to
 * assert structural correctness of a config, pattern, or specialist file at
 * load time should go through `validateOrDie` so error messages are uniform
 * (file path + key path + expected + got).
 *
 * Design:
 *   - Pure-sync. No I/O of its own — callers pass already-parsed data.
 *   - Throws on failure (by design — "die" in the name). Boot scripts catch,
 *     print, and exit non-zero.
 *   - Validator runtime is handwritten (schemas/_validator.js), not zod — the
 *     R-ZOD task considered zod and rejected it on install-size grounds (~5 MB
 *     vs. ~2 KB for the subset we actually use).
 *   - Success returns the schema-parsed value; today no schema uses transforms,
 *     so output === input byte-for-byte for valid data.
 */

const { configSchema } = require('./config.schema');
const { patternFrontmatterSchema } = require('./pattern.schema');
const { specialistFrontmatterSchema } = require('./specialist.schema');

/**
 * Format a validation error object into a concise, multi-line human-readable
 * message. Each issue becomes one line: `  - <key.path>: <message> (got <value>)`.
 *
 * @param {{ issues: Array<{ path: (string|number)[], message: string }> }} err
 * @param {unknown} data - The input that failed validation, for "got" hints.
 * @returns {string[]} Array of formatted issue lines.
 */
function formatZodIssues(err, data) {
  if (!err || !Array.isArray(err.issues)) return [];
  return err.issues.map((issue) => {
    const keyPath = issue.path && issue.path.length > 0
      ? issue.path.join('.')
      : '<root>';
    // Walk the data object to extract the actual offending value so the
    // error message can quote "got X" without the caller having to do it.
    let gotValue;
    try {
      gotValue = issue.path.reduce(
        (acc, k) => (acc == null ? acc : acc[k]),
        data
      );
    } catch (_) {
      gotValue = undefined;
    }
    const gotStr = gotValue === undefined
      ? ''
      : ' (got ' + safeJsonStringify(gotValue) + ')';
    return '  - ' + keyPath + ': ' + issue.message + gotStr;
  });
}

function safeJsonStringify(v) {
  try {
    const s = JSON.stringify(v);
    // Keep error messages readable — trim very long values.
    if (typeof s === 'string' && s.length > 120) {
      return s.slice(0, 117) + '...';
    }
    return s;
  } catch (_) {
    return '[unserializable]';
  }
}

/**
 * Validate `data` against `schema`. On failure, throw an Error whose message
 * lists file path, each offending key path, and the expected-vs-got hint.
 *
 * @param {import('./_validator').Schema} schema - A zod schema (e.g., configSchema).
 * @param {unknown} data - Already-parsed JSON / YAML-frontmatter payload.
 * @param {string} label - Human-readable label — typically the file path.
 * @returns {unknown} The schema-parsed value when validation succeeds.
 * @throws {Error} When validation fails. Error.details.issues contains the
 *   raw zod issues array for programmatic consumers.
 */
function validateOrDie(schema, data, label) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const lines = formatZodIssues(result.error, data);
  const header = 'orchestray: validation failed for ' + (label || '<input>');
  const message = header + ':\n' + lines.join('\n');
  const err = new Error(message);
  err.details = {
    label: label || null,
    issues: result.error.issues,
  };
  throw err;
}

/**
 * Variant of validateOrDie that returns a structured result instead of
 * throwing. Useful for batch validators (e.g., bin/validate-config.js) that
 * need to aggregate findings across multiple files before exiting.
 *
 * @param {import('./_validator').Schema} schema
 * @param {unknown} data
 * @param {string} label
 * @returns {{ ok: true, data: unknown } | { ok: false, label: string, issues: Array<{ path: string, message: string, got?: unknown }>, message: string }}
 */
function validate(schema, data, label) {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };

  const lines = formatZodIssues(result.error, data);
  return {
    ok: false,
    label: label || '<input>',
    issues: result.error.issues.map((issue) => {
      let got;
      try {
        got = issue.path.reduce(
          (acc, k) => (acc == null ? acc : acc[k]),
          data
        );
      } catch (_) {
        got = undefined;
      }
      return {
        path: issue.path.join('.') || '<root>',
        message: issue.message,
        got,
      };
    }),
    message: 'orchestray: validation failed for ' + (label || '<input>') + ':\n' + lines.join('\n'),
  };
}

module.exports = {
  // Schemas
  configSchema,
  patternFrontmatterSchema,
  specialistFrontmatterSchema,
  // Helpers
  validateOrDie,
  validate,
  formatZodIssues,
  // Re-export full sub-module namespaces for callers that want the
  // secondary schemas (leaf section schemas, category enums, constants).
  config: require('./config.schema'),
  pattern: require('./pattern.schema'),
  specialist: require('./specialist.schema'),
};
