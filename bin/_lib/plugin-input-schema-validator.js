'use strict';

/**
 * plugin-input-schema-validator.js — Strict Ajv inputSchema validator for plugin tools.
 *
 * Security hardening: W-SEC-9 (v2.3.0).
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

const Ajv = require('ajv');

// ---------------------------------------------------------------------------
// Static Ajv configuration — locked at module load. No network. No remote $ref.
// ---------------------------------------------------------------------------

/**
 * SAFE_AJV_CONFIG — immutable options object passed to every Ajv instance.
 * CRITICAL: do NOT add loadSchema; without it, any $ref pointing to a URL fails
 * synchronously (ajv cannot resolve it) rather than making a network call.
 * @type {Readonly<object>}
 */
const SAFE_AJV_CONFIG = Object.freeze({
  strict: true,               // unknown keywords → reject
  strictSchema: true,
  strictNumbers: true,
  strictTypes: true,
  strictTuples: true,
  strictRequired: true,
  allErrors: false,           // first error is enough; avoids error-amplification DoS
  validateFormats: true,
  allowUnionTypes: false,
  // loadSchema intentionally absent — no network capability
});

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
// Safe format definitions — lightweight regex-based validators for ALLOWED_FORMATS.
// These are registered on every Ajv instance so that schemas using these formats
// compile cleanly under validateFormats:true. Only formats in ALLOWED_FORMATS are
// registered; any other format is already blocked by the pre-checker.
// ---------------------------------------------------------------------------

/**
 * Minimal regex validators for each format in ALLOWED_FORMATS.
 * Purpose: satisfy Ajv's validateFormats:true requirement without external libraries.
 * These patterns are intentionally non-exhaustive — correctness of format checking
 * is secondary to security (unknown formats are blocked, not loosely matched).
 * @type {Map<string, RegExp>}
 */
const _FORMAT_VALIDATORS = new Map([
  ['date',                   /^\d{4}-\d{2}-\d{2}$/],
  ['time',                   /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/],
  ['date-time',              /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/],
  ['duration',               /^P(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/],
  ['email',                  /^[^\s@]+@[^\s@]+\.[^\s@]+$/],
  ['hostname',               /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/],
  ['ipv4',                   /^(\d{1,3}\.){3}\d{1,3}$/],
  ['ipv6',                   /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})?$/],
  ['uri',                    /^\w[\w+\-.]*:/],
  ['uri-reference',          /^(\w[\w+\-.]*:)?[^\s]*$/],
  ['uri-template',           /^[^\s]*$/],
  ['uuid',                   /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['json-pointer',           /^(\/[^/~]*(~[01][^/~]*)*)*$/],
  ['relative-json-pointer',  /^\d+(\/[^/~]*(~[01][^/~]*)*)*$/],
]);

/**
 * Register all safe format validators on an Ajv instance.
 * @param {import('ajv').default} ajvInstance
 */
function _registerSafeFormats(ajvInstance) {
  for (const [name, pattern] of _FORMAT_VALIDATORS) {
    ajvInstance.addFormat(name, pattern);
  }
}

// ---------------------------------------------------------------------------
// AST pre-checker — inspects the schema object tree before handing it to ajv.
// ---------------------------------------------------------------------------

/**
 * Recursively walks a JSON Schema AST and throws on unsafe constructs:
 *   - Remote $ref (SSRF vector)
 *   - Formats outside ALLOWED_FORMATS (ReDoS / registry-lookup vector)
 *   - Schema depth exceeding MAX_DEPTH (CPU/stack DoS vector)
 *
 * This defense runs BEFORE ajv ever touches the schema, so ajv cannot be tricked
 * into resolving a remote reference during its own schema-walk.
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
 * Compile a JSON Schema into an Ajv validator function.
 *
 * Performs two layers of safety checks before returning:
 *   1. Pre-check: _rejectUnsafeSchemaConstructs scans the AST for unsafe constructs.
 *   2. Compile: Ajv compiles under SAFE_AJV_CONFIG; unknown keywords → throws.
 *
 * The returned validator function is safe to call repeatedly:
 *   `const ok = validator(input); if (!ok) console.log(validator.errors);`
 *
 * @param {object} jsonSchema  The JSON Schema document to compile.
 * @returns {Function}  Ajv validator; call as validator(input) → boolean.
 * @throws {Error}  If the schema contains unsafe constructs or fails ajv compilation.
 */
function compileToolInputSchema(jsonSchema) {
  // Layer 1: pre-check the schema AST before ajv can touch it.
  _rejectUnsafeSchemaConstructs(jsonSchema);

  // Layer 2: compile with strict ajv (unknown keywords → StrictMode error → caught + rethrown).
  const ajv = new Ajv(SAFE_AJV_CONFIG);
  _registerSafeFormats(ajv);
  let validator;
  try {
    validator = ajv.compile(jsonSchema);
  } catch (err) {
    throw new Error(`ajv compile failed: ${err.message}`);
  }
  return validator;
}

/**
 * Convenience function: compile a schema and immediately validate a single input.
 *
 * @param {object}  jsonSchema  The JSON Schema to validate against.
 * @param {unknown} input       The value to validate.
 * @returns {{ ok: boolean, errors: Array|null }}
 *   `ok` is true if the input is valid; `errors` is null on success or the Ajv error
 *   array on failure.
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
  SAFE_AJV_CONFIG,
};
