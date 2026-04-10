'use strict';

/**
 * Hand-written JSON-Schema subset validators for the Orchestray MCP server.
 *
 * Per v2011c-stage1-plan.md §3.2. No external deps — Stage 1 discipline is
 * Node 20 stdlib only.
 *
 * Public contract:
 *   validateAskUserInput(input)              -> { ok: true } | { ok: false, errors: string[] }
 *   validateAskUserOutput(output)            -> { ok: true } | { ok: false, errors: string[] }
 *   validateElicitationRequestedSchema(sch)  -> { ok: true } | { ok: false, errors: string[] }
 *
 * Also exports ASK_USER_TOOL_DEFINITION — the canonical tool descriptor
 * returned by the server's `tools/list` response. Shape per §4.2.
 *
 * Validators are pure: they never throw, never hit the filesystem, never do
 * I/O. Callers decide whether to surface a failure as an `isError: true` tool
 * result or a JSON-RPC `-32602` error.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v) { return typeof v === 'string'; }
function isInteger(v) { return typeof v === 'number' && Number.isInteger(v); }

const VALID_FIELD_TYPES = new Set(['text', 'boolean', 'select', 'number']);

// ---------------------------------------------------------------------------
// validateAskUserInput
// ---------------------------------------------------------------------------

/**
 * Validate the `arguments` object of an `ask_user` tool call. See §4.2 for
 * the authoritative schema.
 */
function validateAskUserInput(input) {
  const errors = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['input must be an object'] };
  }

  // --- title ---
  if (!('title' in input)) {
    errors.push('title is required');
  } else if (!isString(input.title)) {
    errors.push('title must be a string');
  } else if (input.title.length < 1 || input.title.length > 120) {
    errors.push('title length must be 1..120');
  }

  // --- question ---
  if (!('question' in input)) {
    errors.push('question is required');
  } else if (!isString(input.question)) {
    errors.push('question must be a string');
  } else if (input.question.length < 3 || input.question.length > 500) {
    errors.push('question length must be 3..500');
  }

  // --- form ---
  if (!('form' in input)) {
    errors.push('form is required');
  } else if (!Array.isArray(input.form)) {
    errors.push('form must be an array');
  } else if (input.form.length < 1) {
    errors.push('form must contain at least one field');
  } else if (input.form.length > 5) {
    errors.push('form must contain at most 5 fields (maxItems=5)');
  } else {
    input.form.forEach((field, idx) => {
      const fieldErrs = validateAskUserFormField(field, idx);
      for (const e of fieldErrs) errors.push(e);
    });
  }

  // --- timeout_seconds (optional) ---
  if ('timeout_seconds' in input && input.timeout_seconds !== undefined) {
    if (!isInteger(input.timeout_seconds)) {
      errors.push('timeout_seconds must be an integer');
    } else if (input.timeout_seconds < 10 || input.timeout_seconds > 600) {
      errors.push('timeout_seconds must be in [10, 600]');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

function validateAskUserFormField(field, idx) {
  const errors = [];
  const prefix = `form[${idx}]`;

  if (!isPlainObject(field)) {
    return [`${prefix} must be an object`];
  }

  if (!('name' in field)) {
    errors.push(`${prefix}.name is required`);
  } else if (!isString(field.name)) {
    errors.push(`${prefix}.name must be a string`);
  } else if (field.name.length < 1 || field.name.length > 64) {
    errors.push(`${prefix}.name length must be 1..64`);
  }

  if (!('label' in field)) {
    errors.push(`${prefix}.label is required`);
  } else if (!isString(field.label)) {
    errors.push(`${prefix}.label must be a string`);
  } else if (field.label.length < 1 || field.label.length > 200) {
    errors.push(`${prefix}.label length must be 1..200`);
  }

  if (!('type' in field)) {
    errors.push(`${prefix}.type is required`);
  } else if (!isString(field.type)) {
    errors.push(`${prefix}.type must be a string`);
  } else if (!VALID_FIELD_TYPES.has(field.type)) {
    errors.push(
      `${prefix}.type must be one of text|boolean|select|number (got "${field.type}")`
    );
  }

  if ('choices' in field && field.choices !== undefined) {
    if (!Array.isArray(field.choices)) {
      errors.push(`${prefix}.choices must be an array`);
    } else if (field.choices.length > 12) {
      errors.push(`${prefix}.choices must contain at most 12 items`);
    } else {
      field.choices.forEach((c, ci) => {
        if (!isString(c)) {
          errors.push(`${prefix}.choices[${ci}] must be a string`);
        }
      });
    }
  }

  if ('required' in field && field.required !== undefined) {
    if (typeof field.required !== 'boolean') {
      errors.push(`${prefix}.required must be a boolean`);
    }
  }

  // `default` is intentionally unconstrained (may be any primitive matching field.type).

  return errors;
}

// ---------------------------------------------------------------------------
// validateAskUserOutput
// ---------------------------------------------------------------------------

/**
 * Validate the handler's return payload. Must have a boolean `cancelled` key;
 * other keys are answer values and are not individually typed because they
 * vary with the form schema.
 */
function validateAskUserOutput(output) {
  if (!isPlainObject(output)) {
    return { ok: false, errors: ['output must be an object'] };
  }
  if (!('cancelled' in output)) {
    return { ok: false, errors: ['output.cancelled is required'] };
  }
  if (typeof output.cancelled !== 'boolean') {
    return { ok: false, errors: ['output.cancelled must be a boolean'] };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// validateElicitationRequestedSchema
// ---------------------------------------------------------------------------

const ALLOWED_PROP_TYPES = new Set(['string', 'integer', 'number', 'boolean']);
const DISALLOWED_COMBINATORS = ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else'];

/**
 * Validate that a requestedSchema about to be sent via `elicitation/create`
 * conforms to the MCP elicitation subset: flat object, primitive property
 * types only, enums allowed on strings. No nesting, no arrays, no
 * combinators, no $ref.
 */
function validateElicitationRequestedSchema(schema) {
  const errors = [];

  if (!isPlainObject(schema)) {
    return { ok: false, errors: ['requestedSchema must be an object'] };
  }

  if (schema.type !== 'object') {
    errors.push('requestedSchema.type must be "object"');
  }

  for (const key of DISALLOWED_COMBINATORS) {
    if (key in schema) {
      errors.push(`requestedSchema must not use "${key}" (nesting/refs forbidden)`);
    }
  }

  if ('properties' in schema) {
    if (!isPlainObject(schema.properties)) {
      errors.push('requestedSchema.properties must be an object');
    } else {
      for (const [propName, propDef] of Object.entries(schema.properties)) {
        const prefix = `properties.${propName}`;
        if (!isPlainObject(propDef)) {
          errors.push(`${prefix} must be an object`);
          continue;
        }

        for (const key of DISALLOWED_COMBINATORS) {
          if (key in propDef) {
            errors.push(`${prefix} must not use "${key}"`);
          }
        }

        if (!('type' in propDef)) {
          errors.push(`${prefix}.type is required`);
        } else if (propDef.type === 'object') {
          errors.push(`${prefix}.type must be a primitive (nesting forbidden)`);
        } else if (propDef.type === 'array') {
          errors.push(`${prefix}.type must be a primitive (arrays forbidden)`);
        } else if (!ALLOWED_PROP_TYPES.has(propDef.type)) {
          errors.push(
            `${prefix}.type must be one of string|integer|number|boolean (got "${propDef.type}")`
          );
        }

        if ('enum' in propDef) {
          if (propDef.type !== 'string') {
            errors.push(`${prefix}.enum is only allowed on string properties`);
          } else if (!Array.isArray(propDef.enum)) {
            errors.push(`${prefix}.enum must be an array`);
          }
        }
      }
    }
  }

  if ('required' in schema) {
    if (!Array.isArray(schema.required)) {
      errors.push('requestedSchema.required must be an array');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ASK_USER_TOOL_DEFINITION — canonical descriptor returned by `tools/list`
// ---------------------------------------------------------------------------

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  return Object.freeze(obj);
}

const ASK_USER_TOOL_DEFINITION = deepFreeze({
  name: 'ask_user',
  description:
    'Ask the user a structured question mid-task and block until they answer. ' +
    'Use when ambiguity blocks progress and the answer determines your next step. ' +
    'Budget: at most 2 per task (PM-enforced).',
  inputSchema: {
    type: 'object',
    required: ['title', 'question', 'form'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 120 },
      question: { type: 'string', minLength: 3, maxLength: 500 },
      form: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          required: ['name', 'label', 'type'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 64 },
            label: { type: 'string', minLength: 1, maxLength: 200 },
            type: { type: 'string', enum: ['text', 'boolean', 'select', 'number'] },
            choices: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            required: { type: 'boolean' },
            default: {},
          },
        },
      },
      timeout_seconds: { type: 'integer', minimum: 10, maximum: 600 },
    },
  },
});

// ---------------------------------------------------------------------------
// validateAgainstSchema — generic JSON-Schema-subset validator (Stage 2)
// ---------------------------------------------------------------------------

/**
 * Supported constructs:
 *   type: object      + properties, required (additionalProperties ignored)
 *   type: string      + minLength, maxLength, enum
 *   type: integer     + minimum, maximum  (Number.isInteger required)
 *   type: number      + minimum, maximum  (finite)
 *   type: boolean
 *   type: array       + items (type, enum, nested), minItems, maxItems
 *
 * Rejects unsupported keywords (oneOf/anyOf/allOf/$ref/not/if/then/else/
 * const/format/patternProperties/propertyNames/additionalItems) with an
 * "unsupported schema keyword" error.
 *
 * Returns { ok: true } | { ok: false, errors: string[] }. Pure; never throws.
 *
 * Per v2011c-stage2-plan.md §5.
 */

const UNSUPPORTED_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  '$ref',
  'const',
  'format',
  'patternProperties',
  'propertyNames',
  'additionalItems',
];

function validateAgainstSchema(value, schema, pathStr) {
  const errors = [];
  if (pathStr === undefined) pathStr = '';
  _validate(value, schema, pathStr, errors);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

function _pathLabel(pathStr) {
  return pathStr.length > 0 ? pathStr : '(root)';
}

function _validate(value, schema, pathStr, errors) {
  if (!isPlainObject(schema)) {
    errors.push(_pathLabel(pathStr) + ': schema must be an object');
    return;
  }

  // Reject unsupported keywords (including type-array form).
  for (const kw of UNSUPPORTED_KEYWORDS) {
    if (kw in schema) {
      errors.push(
        _pathLabel(pathStr) + ': unsupported schema keyword "' + kw + '"'
      );
    }
  }
  if (Array.isArray(schema.type)) {
    errors.push(
      _pathLabel(pathStr) + ': unsupported schema keyword "type as array"'
    );
  }

  // Bail early on unsupported-keyword rejection — the caller gets a clean
  // single message. Any further checks would just add noise.
  if (errors.length > 0) return;

  const type = schema.type;

  if (type === 'object') {
    if (!isPlainObject(value)) {
      errors.push(_pathLabel(pathStr) + ': must be an object');
      return;
    }
    if ('required' in schema) {
      if (!Array.isArray(schema.required)) {
        errors.push(_pathLabel(pathStr) + ': required must be an array');
      } else {
        for (const name of schema.required) {
          if (!(name in value)) {
            errors.push(
              (pathStr.length > 0 ? pathStr + '.' : '') + name + ': is required'
            );
          }
        }
      }
    }
    if ('properties' in schema) {
      if (!isPlainObject(schema.properties)) {
        errors.push(_pathLabel(pathStr) + ': properties must be an object');
      } else {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          if (propName in value) {
            const childPath = (pathStr.length > 0 ? pathStr + '.' : '') + propName;
            _validate(value[propName], propSchema, childPath, errors);
          }
        }
      }
    }
    return;
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push(_pathLabel(pathStr) + ': must be a string');
      return;
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(
        _pathLabel(pathStr) + ': string length must be >= ' + schema.minLength +
        ' (got ' + value.length + ')'
      );
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(
        _pathLabel(pathStr) + ': string length must be <= ' + schema.maxLength +
        ' (got ' + value.length + ')'
      );
    }
    if ('enum' in schema) {
      if (!Array.isArray(schema.enum)) {
        errors.push(_pathLabel(pathStr) + ': enum must be an array');
      } else if (!schema.enum.includes(value)) {
        errors.push(
          _pathLabel(pathStr) + ': must be one of ' + JSON.stringify(schema.enum) +
          ' (got "' + value + '")'
        );
      }
    }
    return;
  }

  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(_pathLabel(pathStr) + ': must be integer');
      return;
    }
    if (!Number.isInteger(value)) {
      errors.push(_pathLabel(pathStr) + ': must be integer (got ' + value + ')');
      return;
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(_pathLabel(pathStr) + ': must be >= ' + schema.minimum);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(_pathLabel(pathStr) + ': must be <= ' + schema.maximum);
    }
    return;
  }

  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(_pathLabel(pathStr) + ': must be a finite number');
      return;
    }
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(_pathLabel(pathStr) + ': must be >= ' + schema.minimum);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(_pathLabel(pathStr) + ': must be <= ' + schema.maximum);
    }
    return;
  }

  if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(_pathLabel(pathStr) + ': must be a boolean');
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(_pathLabel(pathStr) + ': must be an array');
      return;
    }
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(
        _pathLabel(pathStr) + ': array length must be >= ' + schema.minItems +
        ' (got ' + value.length + ')'
      );
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(
        _pathLabel(pathStr) + ': array must contain at most ' + schema.maxItems +
        ' items (got ' + value.length + ')'
      );
    }
    if ('items' in schema) {
      const itemsSchema = schema.items;
      if (Array.isArray(itemsSchema)) {
        errors.push(
          _pathLabel(pathStr) + ': unsupported schema keyword "items as array"'
        );
      } else if (isPlainObject(itemsSchema)) {
        value.forEach((elem, idx) => {
          const childPath = (pathStr.length > 0 ? pathStr : '') + '[' + idx + ']';
          _validate(elem, itemsSchema, childPath, errors);
        });
      }
    }
    return;
  }

  if (type === undefined) {
    // Schemas without `type` are permissive (shape-less). Tests don't rely
    // on this being an error; mirror ajv's default-permissive behavior.
    return;
  }

  errors.push(_pathLabel(pathStr) + ': unsupported type "' + String(type) + '"');
}

module.exports = {
  validateAskUserInput,
  validateAskUserOutput,
  validateElicitationRequestedSchema,
  validateAgainstSchema,
  deepFreeze,
  ASK_USER_TOOL_DEFINITION,
};
