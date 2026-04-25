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
const crypto = require('crypto');

const SCHEMA_REL_PATH = path.join('agents', 'pm-reference', 'event-schemas.md');

// ---------------------------------------------------------------------------
// Process-level cache: one parse per process invocation
// ---------------------------------------------------------------------------

let _cachedSchemas = null; // Map<string, { required: string[], version: number }>
let _cacheSourcePath = null;

/**
 * Extract event schemas from the event-schemas.md content.
 * Returns a Map of event_type → { required: string[], version: number }.
 *
 * Uses the same heuristic parser as regen-schema-shadow.js.
 */
function parseSchemas(content) {
  const schemas = new Map();
  const SECTION_RE = /^### [`]?([a-z][a-z0-9_.-]*)(?:[`]| event| Event)/mg;
  const KEY_VALUE_RE = /^\s+"([^"]+)"\s*:\s*(.+?)(?:,\s*)?$/;

  const sectionStarts = [];
  let m;
  while ((m = SECTION_RE.exec(content)) !== null) {
    sectionStarts.push({ index: m.index, slug: m[1] });
  }

  for (let i = 0; i < sectionStarts.length; i++) {
    const sectionEnd = (i + 1 < sectionStarts.length)
      ? sectionStarts[i + 1].index
      : content.length;
    const sectionContent = content.slice(sectionStarts[i].index, sectionEnd);

    const fenceStart = sectionContent.indexOf('```json');
    if (fenceStart === -1) continue;
    const fenceContentStart = fenceStart + '```json'.length;
    const fenceEnd = sectionContent.indexOf('```', fenceContentStart);
    if (fenceEnd === -1) continue;

    const jsonBlock = sectionContent.slice(fenceContentStart, fenceEnd);

    const typeMatch = jsonBlock.match(/"type"\s*:\s*"([^"]+)"/);
    if (!typeMatch) continue;
    const eventType = typeMatch[1];

    if (!/^[a-z][a-z0-9_.-]*$/.test(eventType)) continue;
    if (schemas.has(eventType)) continue;

    const required = [];
    let version = 1;
    const lines = jsonBlock.split('\n').filter(l => !l.match(/^```/));

    for (const line of lines) {
      const km = line.match(KEY_VALUE_RE);
      if (!km) continue;
      const key = km[1];
      const valText = km[2].trim();

      if (key === 'type') continue;
      if (key === 'version') {
        const v = parseInt(valText, 10);
        if (!isNaN(v)) version = v;
        required.push(key);
        continue;
      }

      const isOptional = /optional|null|undefined|\?/.test(valText) ||
        valText === 'null' ||
        (valText.startsWith('"') && valText.includes('optional'));

      if (!isOptional) {
        required.push(key);
      }
    }

    schemas.set(eventType, { required, version });
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
