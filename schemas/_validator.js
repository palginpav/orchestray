'use strict';

/**
 * schemas/_validator.js — tiny validator with a zod-compatible subset API.
 *
 * v2.1.13 R-ZOD (option C). Replaces the `zod` runtime dep with a handwritten
 * ~250-line validator supporting only the subset of zod actually used by
 * Orchestray schemas. Why: zod's on-disk footprint (~5 MB) exceeded the plan's
 * advertised install-size budget by 20x; a handwritten validator gives us the
 * same declarative API with no external dep.
 *
 * Covered API (mirrors zod v3 shape):
 *   z.string(), z.number(), z.boolean(), z.enum([...]), z.array(inner),
 *   z.object(shape), z.union([...]), z.record(valueSchema | keySchema, valueSchema),
 *   z.preprocess(fn, schema)
 *
 *   Chainable: .optional(), .nullable(), .min(n, {message?}),
 *              .max(n, {message?}), .int(), .positive(),
 *              .regex(re, {message?}), .refine(fn, {message}),
 *              .pipe(next), .passthrough() (object only),
 *              .strict() (object only)
 *
 *   Terminal: .safeParse(data) → { success: true, data } | { success: false, error: { issues } }
 *             .parse(data) → data (throws on failure, zod-compatible)
 *
 * Not covered (intentionally — no caller uses them):
 *   .transform, .default, .catch, .partial, .extend, .merge, strictObject,
 *   discriminated unions, recursive schemas, async refinements, branded types.
 *
 * Error shape matches zod's issue shape closely enough that schemas/index.js
 * can format issues without knowing which validator produced them:
 *   { path: string[], message: string, code?: string }
 */

/** @typedef {{ ok: true, value: unknown } | { ok: false, issues: Array<{ path: (string|number)[], message: string }> }} ParseResult */

function makeSchema(parseFn) {
  const schema = {
    _parse: parseFn,
    safeParse(data) {
      const res = parseFn(data, []);
      if (res.ok) return { success: true, data: res.value };
      return { success: false, error: { issues: res.issues } };
    },
    parse(data) {
      const res = parseFn(data, []);
      if (res.ok) return res.value;
      const err = new Error('validation failed');
      err.issues = res.issues;
      throw err;
    },
    optional() {
      return makeSchema((v, path) =>
        v === undefined ? { ok: true, value: undefined } : parseFn(v, path)
      );
    },
    nullable() {
      return makeSchema((v, path) =>
        v === null ? { ok: true, value: null } : parseFn(v, path)
      );
    },
    refine(predicate, opts) {
      const msg = (opts && opts.message) || 'refinement failed';
      const subPath = (opts && opts.path) || [];
      return makeSchema((v, path) => {
        const inner = parseFn(v, path);
        if (!inner.ok) return inner;
        try {
          if (predicate(inner.value)) return inner;
        } catch (_) {
          // fall through to failure
        }
        return { ok: false, issues: [{ path: path.concat(subPath), message: msg }] };
      });
    },
    pipe(next) {
      return makeSchema((v, path) => {
        const inner = parseFn(v, path);
        if (!inner.ok) return inner;
        return next._parse(inner.value, path);
      });
    },
  };
  return schema;
}

function issue(path, message) {
  return { ok: false, issues: [{ path: path.slice(), message }] };
}

// ---------- primitives ----------

// v2.1.13 F-M-3: chainables must return a NEW schema each call. Earlier
// revisions mutated a closed-over `state` object and returned the SAME schema,
// which silently poisoned any partially-built primitive that was reused
// downstream (e.g. `const nonEmpty = z.string().min(1); const longer =
// nonEmpty.min(10)` would make nonEmpty require min=10). Each chainable
// rebuilds the schema over a shallow-copied state object.

function _buildStringSchema(state) {
  const base = makeSchema((v, path) => {
    if (typeof v !== 'string') return issue(path, 'Expected string');
    if (state.min !== null && v.length < state.min) {
      return issue(path, state.minMsg || `String must contain at least ${state.min} character(s)`);
    }
    if (state.max !== null && v.length > state.max) {
      return issue(path, state.maxMsg || `String must contain at most ${state.max} character(s)`);
    }
    if (state.regex !== null && !state.regex.test(v)) {
      return issue(path, state.regexMsg || `String does not match pattern ${state.regex}`);
    }
    return { ok: true, value: v };
  });
  base.min = (n, opts) => _buildStringSchema({ ...state, min: n, minMsg: opts && opts.message ? opts.message : state.minMsg });
  base.max = (n, opts) => _buildStringSchema({ ...state, max: n, maxMsg: opts && opts.message ? opts.message : state.maxMsg });
  base.regex = (re, opts) => _buildStringSchema({ ...state, regex: re, regexMsg: opts && opts.message ? opts.message : state.regexMsg });
  return base;
}

function stringSchema() {
  return _buildStringSchema({ min: null, max: null, regex: null, regexMsg: null, minMsg: null, maxMsg: null });
}

function _buildNumberSchema(state) {
  const base = makeSchema((v, path) => {
    if (typeof v !== 'number' || Number.isNaN(v)) return issue(path, 'Expected number');
    if (state.int && !Number.isInteger(v)) return issue(path, 'Expected integer');
    if (state.positive && v <= 0) return issue(path, 'Expected positive number');
    if (state.min !== null && v < state.min) {
      return issue(path, state.minMsg || `Number must be ≥ ${state.min}`);
    }
    if (state.max !== null && v > state.max) {
      return issue(path, state.maxMsg || `Number must be ≤ ${state.max}`);
    }
    return { ok: true, value: v };
  });
  base.min = (n, opts) => _buildNumberSchema({ ...state, min: n, minMsg: opts && opts.message ? opts.message : state.minMsg });
  base.max = (n, opts) => _buildNumberSchema({ ...state, max: n, maxMsg: opts && opts.message ? opts.message : state.maxMsg });
  base.int = () => _buildNumberSchema({ ...state, int: true });
  base.positive = () => _buildNumberSchema({ ...state, positive: true });
  return base;
}

function numberSchema() {
  return _buildNumberSchema({ min: null, max: null, int: false, positive: false, minMsg: null, maxMsg: null });
}

function booleanSchema() {
  return makeSchema((v, path) => {
    if (typeof v !== 'boolean') return issue(path, 'Expected boolean');
    return { ok: true, value: v };
  });
}

function enumSchema(values) {
  const set = new Set(values);
  const listed = values.map((x) => JSON.stringify(x)).join(' | ');
  return makeSchema((v, path) => {
    if (!set.has(v)) return issue(path, `Invalid enum value. Expected ${listed}, got ${JSON.stringify(v)}`);
    return { ok: true, value: v };
  });
}

function _buildArraySchema(inner, state) {
  const base = makeSchema((v, path) => {
    if (!Array.isArray(v)) return issue(path, 'Expected array');
    if (state.min !== null && v.length < state.min) {
      return issue(path, `Array must contain at least ${state.min} element(s)`);
    }
    if (state.max !== null && v.length > state.max) {
      return issue(path, `Array must contain at most ${state.max} element(s)`);
    }
    const out = [];
    const issues = [];
    for (let i = 0; i < v.length; i++) {
      const r = inner._parse(v[i], path.concat([i]));
      if (r.ok) out.push(r.value);
      else issues.push(...r.issues);
    }
    if (issues.length) return { ok: false, issues };
    return { ok: true, value: out };
  });
  base.min = (n) => _buildArraySchema(inner, { ...state, min: n });
  base.max = (n) => _buildArraySchema(inner, { ...state, max: n });
  return base;
}

function arraySchema(inner) {
  return _buildArraySchema(inner, { min: null, max: null });
}

function _buildObjectSchema(shape, state) {
  const keys = Object.keys(shape);
  const base = makeSchema((v, path) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return issue(path, 'Expected object');
    }
    const out = {};
    const issues = [];
    for (const k of keys) {
      const r = shape[k]._parse(v[k], path.concat([k]));
      if (r.ok) {
        if (r.value !== undefined) out[k] = r.value;
      } else {
        issues.push(...r.issues);
      }
    }
    if (state.mode === 'passthrough') {
      for (const k of Object.keys(v)) {
        if (!(k in shape)) out[k] = v[k];
      }
    } else if (state.mode === 'strict') {
      for (const k of Object.keys(v)) {
        if (!(k in shape)) {
          issues.push({ path: path.concat([k]), message: `Unrecognized key: ${k}` });
        }
      }
    }
    if (issues.length) return { ok: false, issues };
    return { ok: true, value: out };
  });
  base.passthrough = () => _buildObjectSchema(shape, { ...state, mode: 'passthrough' });
  base.strict = () => _buildObjectSchema(shape, { ...state, mode: 'strict' });
  return base;
}

function objectSchema(shape) {
  return _buildObjectSchema(shape, { mode: 'strip' });
}

function unionSchema(options) {
  return makeSchema((v, path) => {
    const collected = [];
    for (const opt of options) {
      const r = opt._parse(v, path);
      if (r.ok) return r;
      collected.push(...r.issues);
    }
    return { ok: false, issues: [{ path, message: 'No union variant matched', code: 'invalid_union', unionErrors: collected }] };
  });
}

function recordSchema(a, b) {
  const keySchema = b ? a : null;
  const valueSchema = b || a;
  return makeSchema((v, path) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return issue(path, 'Expected object (record)');
    }
    const out = {};
    const issues = [];
    for (const k of Object.keys(v)) {
      if (keySchema) {
        const kr = keySchema._parse(k, path.concat([k]));
        if (!kr.ok) { issues.push(...kr.issues); continue; }
      }
      const vr = valueSchema._parse(v[k], path.concat([k]));
      if (vr.ok) out[k] = vr.value;
      else issues.push(...vr.issues);
    }
    if (issues.length) return { ok: false, issues };
    return { ok: true, value: out };
  });
}

function preprocessSchema(fn, inner) {
  return makeSchema((v, path) => {
    let coerced;
    try {
      coerced = fn(v);
    } catch (_) {
      coerced = v;
    }
    return inner._parse(coerced, path);
  });
}

// ---------- public namespace ----------

const z = {
  string: stringSchema,
  number: numberSchema,
  boolean: booleanSchema,
  enum: enumSchema,
  array: arraySchema,
  object: objectSchema,
  union: unionSchema,
  record: recordSchema,
  preprocess: preprocessSchema,
};

module.exports = { z };
