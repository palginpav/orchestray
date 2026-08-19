'use strict';

/**
 * plugin-input-schema-validator.js — Strict inputSchema validator for plugin tools.
 *
 * Security hardening: W-SEC-9 (v2.3.0). ajv removed in v2.3.8 (socket.dev flags).
 *
 * Purpose: Sub-plugins declare an `inputSchema` (JSON Schema document) per tool in their
 * manifest. Before tool-call arguments are validated against the schema, this module
 * validates the schema itself — rejecting DoS, SSRF, and injection constructs before
 * any schema is compiled or executed.
 *
 * Threats addressed (G3 §5 — W-SEC-9):
 *   T-SCHEMA-1a  Remote $ref (SSRF): "https://attacker.com/schema.json"
 *   T-SCHEMA-1b  data:, file:, ftp:, ws:, wss: $ref schemes
 *   T-SCHEMA-1c  Unsupported formats that may require network/registry resolution
 *   T-SCHEMA-1d  format: "regex" (ReDoS attack surface)
 *   T-SCHEMA-1e  Deep schema recursion (DoS via stack/CPU)
 *   T-SCHEMA-1f  Unknown keywords in strict mode
 *
 * Usage:
 *   const { compileToolInputSchema, validateInput } = require('./plugin-input-schema-validator');
 *   const validator = compileToolInputSchema(jsonSchema);     // throws if unsafe
 *   const { ok, errors } = validateInput(jsonSchema, input);  // compile + validate in one shot
 */

const { compile: _subsetCompile } = require('./json-schema-subset');

// ---------------------------------------------------------------------------
// $ref scheme blocklist — anything starting with these schemes is remote/unsafe.
// ---------------------------------------------------------------------------

/**
 * Pattern matching $ref values that reference remote or filesystem resources.
 * Local JSON Pointer refs like "#/definitions/foo" and bare names do NOT match.
 * @type {RegExp}
 */
const REMOTE_REF_PATTERN = /^(https?:|file:|data:|ftp:|wss?:)/i;

// ---------------------------------------------------------------------------
// Format whitelist — known-safe, offline-resolvable formats only.
// Anything outside this set (including "regex" which is a ReDoS vector) is rejected.
// ---------------------------------------------------------------------------

/**
 * Set of JSON Schema format values that are safe to use in tool input schemas.
 * Notably absent: "regex" (ReDoS), IRI/IDN formats (require lookup tables), and
 * any user-defined formats.
 * @type {ReadonlySet<string>}
 */
const ALLOWED_FORMATS = new Set([
  'date', 'time', 'date-time', 'duration',
  'email', 'hostname', 'ipv4', 'ipv6',
  'uri', 'uri-reference', 'uri-template',
  'uuid', 'json-pointer', 'relative-json-pointer',
]);

// ---------------------------------------------------------------------------
// AST pre-checker — inspects the schema object tree for security threats.
// ---------------------------------------------------------------------------

/**
 * Recursively walks a JSON Schema AST and throws on unsafe constructs:
 *   - Remote $ref (SSRF vector)
 *   - Formats outside ALLOWED_FORMATS (ReDoS / registry-lookup vector)
 *   - Schema depth exceeding MAX_DEPTH (CPU/stack DoS vector)
 *
 * This defense runs BEFORE the subset compiler touches the schema.
 *
 * @param {unknown} schema  The schema value to inspect (any node in the AST).
 * @param {number}  depth   Current recursion depth (default 0).
 * @param {string}  path    JSON-path string for error messages (default '#').
 * @throws {Error} On any unsafe construct or excessive depth.
 */
function _rejectUnsafeSchemaConstructs(schema, depth = 0, path = '#') {
  if (depth > 32) {
    throw new Error(`schema too deep at ${path}`);
  }
  if (schema === null || typeof schema !== 'object') {
    return;
  }
  if (Array.isArray(schema)) {
    schema.forEach((item, i) =>
      _rejectUnsafeSchemaConstructs(item, depth + 1, `${path}[${i}]`)
    );
    return;
  }

  // Check $ref scheme.
  if (typeof schema.$ref === 'string' && REMOTE_REF_PATTERN.test(schema.$ref)) {
    throw new Error(`remote $ref rejected at ${path}: ${schema.$ref}`);
  }

  // Check format allowlist.
  if (typeof schema.format === 'string' && !ALLOWED_FORMATS.has(schema.format)) {
    throw new Error(
      `unsupported format '${schema.format}' at ${path}; allowed: ${[...ALLOWED_FORMATS].join(', ')}`
    );
  }

  // Recurse into all object values.
  for (const key of Object.keys(schema)) {
    _rejectUnsafeSchemaConstructs(schema[key], depth + 1, `${path}/${key}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a JSON Schema into a validator function.
 *
 * Performs two layers of safety checks before returning:
 *   1. Pre-check: _rejectUnsafeSchemaConstructs scans the AST for unsafe constructs.
 *   2. Compile: json-schema-subset rejects unknown keywords (strict mode parity).
 *
 * The returned validator function is safe to call repeatedly:
 *   `const ok = validator(input); if (!ok) console.log(validator.errors);`
 *
 * @param {object} jsonSchema  The JSON Schema document to compile.
 * @returns {Function}  Validator; call as validator(input) → boolean. Has .errors property.
 * @throws {Error}  If the schema contains unsafe constructs or unknown keywords.
 */
function compileToolInputSchema(jsonSchema) {
  // Layer 1: reject remote $ref, disallowed formats, excessive depth.
  _rejectUnsafeSchemaConstructs(jsonSchema);

  // Layer 2: compile with subset validator (unknown keywords → throws).
  let subsetValidator;
  try {
    subsetValidator = _subsetCompile(jsonSchema);
  } catch (err) {
    // "ajv compile failed:" prefix preserves observable error contract for callers.
    throw new Error(`ajv compile failed: ${err.message}`);
  }

  // Wrap to match the ajv call-signature: validator(input) → boolean, with .errors.
  function validator(input) {
    const result = subsetValidator(input);
    validator.errors = result.valid ? null : result.errors;
    return result.valid;
  }
  validator.errors = null;
  return validator;
}

/**
 * Convenience function: compile a schema and immediately validate a single input.
 *
 * No in-repo caller: plugin-loader.js deliberately calls compileToolInputSchema()
 * directly and caches the returned validator per tool at load time, since it
 * validates the same schema on every tool call and recompiling per call (what
 * this wrapper does) would be wasteful. This function is kept as public one-shot
 * API — documented in this file's own usage example above — for callers that
 * validate a schema once (tests, ad-hoc CLI checks, future non-hot-path callers).
 *
 * @param {object}  jsonSchema  The JSON Schema to validate against.
 * @param {unknown} input       The value to validate.
 * @returns {{ ok: boolean, errors: Array|null }}
 *   `ok` is true if the input is valid; `errors` is null on success or an error
 *   array on failure. Each error has { instancePath, message }.
 * @throws {Error}  If the schema itself is unsafe or fails compilation.
 */
function validateInput(jsonSchema, input) {
  const validator = compileToolInputSchema(jsonSchema);
  const ok = validator(input);
  return { ok, errors: ok ? null : validator.errors };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  compileToolInputSchema,
  validateInput,
  ALLOWED_FORMATS,
  REMOTE_REF_PATTERN,
  _rejectUnsafeSchemaConstructs,
};
