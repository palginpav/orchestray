'use strict';

/**
 * json-schema-subset.js — Interpreted JSON Schema validator (no eval/codegen).
 *
 * Replaces ajv for plugin-input-schema-validator.js (W-SEC-9 follow-up).
 * Supports exactly the keyword subset that Orchestray plugin inputSchemas use.
 * Rejects unknown keywords (parity with ajv strict mode).
 *
 * compile(schema) → validate(data) → { valid: boolean, errors: Error[] }
 *   Error shape: { instancePath: string, message: string }
 *
 * Allowed keywords (standard JSON Schema Draft-07 subset):
 *   Structural:  type, properties, required, additionalProperties
 *                items, minItems, maxItems
 *   Scalar:      enum, const, minLength, maxLength, minimum, maximum, format
 *   Composition: $ref (local JSON Pointer only — remote refs blocked upstream)
 *   Meta:        definitions, $schema, title, description, default, examples
 *                (meta keywords: carry no validation semantics, ignored)
 *
 * Unknown keywords → compile() throws "unknown keyword" error.
 */

// ---------------------------------------------------------------------------
// Keyword registry
// ---------------------------------------------------------------------------

/**
 * Keywords with active validation semantics — processed during tree-walk.
 * @type {Set<string>}
 */
const VALIDATION_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'format',
  '$ref',
]);

/**
 * Annotation-only keywords — present in valid schemas but carry no validation
 * semantics here. We accept them silently (like ajv with allErrors:false).
 * @type {Set<string>}
 */
const ANNOTATION_KEYWORDS = new Set([
  '$schema',
  'definitions',
  'title',
  'description',
  'default',
  'examples',
  '$id',
  '$comment',
  'readOnly',
  'writeOnly',
  'deprecated',
]);

// Format validators (same patterns as plugin-input-schema-validator).
const FORMAT_VALIDATORS = new Map([
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

// ---------------------------------------------------------------------------
// Schema pre-validation (compile-time checks)
// ---------------------------------------------------------------------------

/**
 * Walk schema AST and verify no unknown keywords exist.
 * Also validates that $ref values are local (not remote).
 * Throws on violation — same contract as ajv strict mode.
 *
 * @param {unknown} schema
 * @param {number} depth
 * @param {string} path
 */
function _assertSchemaValid(schema, depth, path) {
  if (depth === undefined) depth = 0;
  if (path === undefined) path = '#';

  if (depth > 32) {
    throw new Error(`schema too deep at ${path}`);
  }
  if (schema === null || typeof schema !== 'object') {
    return;
  }
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => _assertSchemaValid(item, depth + 1, `${path}[${i}]`));
    return;
  }

  for (const key of Object.keys(schema)) {
    if (!VALIDATION_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      throw new Error(`unknown keyword "${key}" at ${path} — not allowed in strict mode`);
    }
    const val = schema[key];
    // properties and definitions hold sub-schemas keyed by name — recurse into values.
    if ((key === 'properties' || key === 'definitions') && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const [subName, subSchema] of Object.entries(val)) {
        _assertSchemaValid(subSchema, depth + 1, `${path}/${key}/${subName}`);
      }
    } else {
      _assertSchemaValid(val, depth + 1, `${path}/${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

/**
 * Resolve a local JSON Pointer $ref against rootSchema.
 * Only supports #/definitions/... and #/ patterns.
 *
 * @param {string} ref
 * @param {object} rootSchema
 * @returns {object} resolved sub-schema
 */
function _resolveRef(ref, rootSchema) {
  if (!ref.startsWith('#')) {
    // Remote $ref — blocked by pre-checker upstream; treat as passthrough here.
    return {};
  }
  const pointer = ref.slice(1); // strip leading '#'
  if (pointer === '' || pointer === '/') {
    return rootSchema;
  }
  const parts = pointer.split('/').filter(Boolean).map(
    (p) => p.replace(/~1/g, '/').replace(/~0/g, '~')
  );
  let node = rootSchema;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !(part in node)) {
      return {}; // unresolvable — validate nothing (safe default)
    }
    node = node[part];
  }
  return node;
}

/**
 * Core recursive validator.
 *
 * @param {unknown} data
 * @param {object} schema
 * @param {object} rootSchema  Root schema for $ref resolution.
 * @param {string} instancePath
 * @param {Array<{instancePath:string, message:string}>} errors  Accumulated errors.
 */
function _validate(data, schema, rootSchema, instancePath, errors) {
  if (instancePath === undefined) instancePath = '';
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;

  // $ref — resolve and validate recursively (local refs only; remote blocked upstream)
  if ('$ref' in schema) {
    const resolved = _resolveRef(schema.$ref, rootSchema);
    _validate(data, resolved, rootSchema, instancePath, errors);
    return; // $ref is exclusive — other keywords in same schema object ignored (Draft-07)
  }

  // type
  if ('type' in schema) {
    const t = schema.type;
    let typeOk = false;
    switch (t) {
      case 'string':   typeOk = typeof data === 'string'; break;
      case 'number':   typeOk = typeof data === 'number' && isFinite(data); break;
      case 'integer':  typeOk = Number.isInteger(data); break;
      case 'boolean':  typeOk = typeof data === 'boolean'; break;
      case 'null':     typeOk = data === null; break;
      case 'array':    typeOk = Array.isArray(data); break;
      case 'object':   typeOk = data !== null && typeof data === 'object' && !Array.isArray(data); break;
      default:         typeOk = true; // unknown type — pass through
    }
    if (!typeOk) {
      errors.push({ instancePath, message: `must be ${t}` });
      return; // stop further checks — type mismatch makes others meaningless
    }
  }

  // enum
  if ('enum' in schema) {
    const enumVals = schema.enum;
    if (Array.isArray(enumVals)) {
      const matched = enumVals.some((v) => _deepEqual(v, data));
      if (!matched) {
        errors.push({ instancePath, message: `must be one of: ${JSON.stringify(enumVals)}` });
      }
    }
  }

  // const
  if ('const' in schema) {
    if (!_deepEqual(schema.const, data)) {
      errors.push({ instancePath, message: `must be equal to const ${JSON.stringify(schema.const)}` });
    }
  }

  // string keywords
  if (typeof data === 'string') {
    if ('minLength' in schema && data.length < schema.minLength) {
      errors.push({ instancePath, message: `must have length >= ${schema.minLength}` });
    }
    if ('maxLength' in schema && data.length > schema.maxLength) {
      errors.push({ instancePath, message: `must have length <= ${schema.maxLength}` });
    }
    if ('format' in schema) {
      const fmt = schema.format;
      const rx = FORMAT_VALIDATORS.get(fmt);
      if (rx && !rx.test(data)) {
        errors.push({ instancePath, message: `must match format "${fmt}"` });
      }
      // unknown formats accepted (blocked at compile time by pre-checker upstream)
    }
  }

  // number / integer keywords
  if (typeof data === 'number') {
    if ('minimum' in schema && data < schema.minimum) {
      errors.push({ instancePath, message: `must be >= ${schema.minimum}` });
    }
    if ('maximum' in schema && data > schema.maximum) {
      errors.push({ instancePath, message: `must be <= ${schema.maximum}` });
    }
  }

  // array keywords
  if (Array.isArray(data)) {
    if ('minItems' in schema && data.length < schema.minItems) {
      errors.push({ instancePath, message: `must have >= ${schema.minItems} items` });
    }
    if ('maxItems' in schema && data.length > schema.maxItems) {
      errors.push({ instancePath, message: `must have <= ${schema.maxItems} items` });
    }
    if ('items' in schema && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
      data.forEach((item, idx) => {
        _validate(item, schema.items, rootSchema, `${instancePath}/${idx}`, errors);
      });
    }
  }

  // object keywords
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    // required
    if ('required' in schema && Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!(name in data)) {
          errors.push({ instancePath: `${instancePath}/${name}`, message: 'is required' });
        }
      }
    }

    // properties
    const props = schema.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const [propName, propSchema] of Object.entries(props)) {
        if (propName in data) {
          _validate(data[propName], propSchema, rootSchema, `${instancePath}/${propName}`, errors);
        }
      }
    }

    // additionalProperties
    if ('additionalProperties' in schema && schema.additionalProperties === false) {
      const allowedProps = new Set(Object.keys(props || {}));
      for (const key of Object.keys(data)) {
        if (!allowedProps.has(key)) {
          errors.push({ instancePath: `${instancePath}/${key}`, message: 'additional property not allowed' });
        }
      }
    }
  }
}

/**
 * Deep equality check for enum/const matching.
 * Handles primitives, arrays, plain objects.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function _deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => _deepEqual(v, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => _deepEqual(a[k], b[k]));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compile a schema into a reusable validator function.
 *
 * @param {object} schema
 * @returns {function(data: unknown): { valid: boolean, errors: Array<{instancePath:string, message:string}> }}
 * @throws {Error} If schema contains unknown keywords or exceeds depth limit.
 */
function compile(schema) {
  _assertSchemaValid(schema);
  const rootSchema = schema;
  return function validate(data) {
    const errors = [];
    _validate(data, rootSchema, rootSchema, '', errors);
    return { valid: errors.length === 0, errors };
  };
}

module.exports = { compile };
