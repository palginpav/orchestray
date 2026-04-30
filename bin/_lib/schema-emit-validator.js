'use strict';

/**
 * schema-emit-validator.js — R-SHDW emit validator (v2.1.14).
 *
 * Validates an audit event payload against the full event-schemas.md.
 * This is the AUTHORITY — the shadow is a hint; this validator is the gate.
 *
 * Parsed schema is cached in process memory after first load (zero-IO on
 * subsequent validations within the same process invocation).
 *
 * Usage: import validateEvent from this module and call:
 *   const result = validateEvent(cwd, eventPayload);
 *   if (!result.valid) { ... result.errors ... }
 */

const fs     = require('fs');
const path   = require('path');

// FN-28 (v2.2.15) — DELETED inline parseSchemas; route through the canonical
// shared parser so the validator and regen-schema-shadow.js / tier2-index can
// never disagree about which slugs the source declares. The dual-parser drift
// was the root cause of the v2.2.14 G-08 schema-shadow auto-disable (W2-01 P0).
const { parseEventSchemas } = require('./event-schemas-parser');

const SCHEMA_REL_PATH = path.join('agents', 'pm-reference', 'event-schemas.md');

// ---------------------------------------------------------------------------
// Process-level cache: one parse per process invocation
// ---------------------------------------------------------------------------

let _cachedSchemas = null; // Map<string, { required: string[], version: number }>
let _cacheSourcePath = null;

/**
 * Build the validator's `Map<slug, { required, version }>` from the canonical
 * parser's array output. The canonical parser also returns `optional` and
 * `enum_dialect_hash`, which the validator does not need; we discard them so
 * downstream consumers see exactly the same shape as before FN-28.
 *
 * Exposed (and exported) so tests can drive the validator's lookup table from
 * the same content as `parseEventSchemas` and assert the slug sets match.
 */
function parseSchemas(content) {
  const schemas = new Map();
  const events  = parseEventSchemas(content);
  for (const ev of events) {
    if (!ev || typeof ev.slug !== 'string') continue;
    if (schemas.has(ev.slug)) continue;
    schemas.set(ev.slug, {
      required: Array.isArray(ev.required) ? ev.required.slice() : [],
      version:  typeof ev.version === 'number' ? ev.version : 1,
    });
  }
  return schemas;
}

/**
 * Load (or return cached) event schemas.
 *
 * @param {string} cwd - Project root.
 * @returns {Map<string, { required: string[], version: number }>|null}
 */
function getSchemas(cwd) {
  const schemaPath = path.join(cwd, SCHEMA_REL_PATH);

  if (_cachedSchemas !== null && _cacheSourcePath === schemaPath) {
    return _cachedSchemas;
  }

  try {
    const content = fs.readFileSync(schemaPath, 'utf8');
    const parsed  = parseSchemas(content);
    // Empty or unparseable schema content is functionally equivalent to an
    // unreadable file — treat both as the "schema unavailable" signal so the
    // gateway falls through to the warnings path rather than dropping every
    // event as "unknown type". Tests run in tmpDirs with stub schema files
    // and depend on this behavior.
    if (!parsed || parsed.size === 0) return null;
    _cachedSchemas   = parsed;
    _cacheSourcePath = schemaPath;
    return _cachedSchemas;
  } catch (_e) {
    return null;
  }
}

/**
 * Validate an event payload against the full schema.
 *
 * @param {string} cwd - Project root.
 * @param {object} eventPayload - The event to validate.
 * @returns {{ valid: boolean, errors: string[], event_type: string|null }}
 */
function validateEvent(cwd, eventPayload) {
  if (!eventPayload || typeof eventPayload !== 'object') {
    return { valid: false, errors: ['event payload must be an object'], event_type: null };
  }

  // Normalise: accept both 'type' (canonical) and 'event' (legacy)
  const eventType = eventPayload.type || eventPayload.event;
  if (!eventType || typeof eventType !== 'string') {
    return {
      valid: false,
      errors: ['event payload must have a "type" field'],
      event_type: null,
    };
  }

  // Load schemas
  const schemas = getSchemas(cwd);
  if (schemas === null) {
    // Can't load schema — fail-open (let the event through with a warning)
    return {
      valid: true,
      errors: [],
      warnings: ['schema file unreadable — validation skipped'],
      event_type: eventType,
    };
  }

  const schema = schemas.get(eventType);
  if (!schema) {
    return {
      valid: false,
      errors: [
        'unknown event type "' + eventType + '" — not found in agents/pm-reference/event-schemas.md. ' +
        'Add a schema entry before emitting this event type.',
      ],
      event_type: eventType,
    };
  }

  // Check required fields
  const errors = [];
  for (const field of schema.required) {
    if (!(field in eventPayload)) {
      errors.push(
        'event type "' + eventType + '" missing required field "' + field + '" ' +
        '(schema ref: agents/pm-reference/event-schemas.md)'
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    event_type: eventType,
    schema_version: schema.version,
  };
}

/**
 * Clear the process-level cache (for testing).
 */
function clearCache() {
  _cachedSchemas = null;
  _cacheSourcePath = null;
}

module.exports = { validateEvent, getSchemas, parseSchemas, clearCache };
