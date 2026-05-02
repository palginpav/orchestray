'use strict';

/**
 * plugin-manifest-schema.js — PluginManifest zod schema with security hardening.
 *
 * Security mitigations implemented here:
 *   W-SEC-3:  Reserved-name and reserved-prefix rejection on plugin/tool names.
 *   W-SEC-10: Prototype-pollution scrub (scrubPrototype) applied to raw JSON
 *             before any zod parsing.
 *   W-SEC-11: Bidi/zero-width unicode rejection in name and description fields
 *             (these codepoints can spoof consent UI).
 *
 * Usage:
 *   const { parseManifest } = require('./plugin-manifest-schema');
 *   const manifest = parseManifest(JSON.parse(rawJsonString)); // throws ZodError on failure
 */

const { z } = require('zod');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Kebab-case name rule: lowercase letter start, 2-48 chars total. */
const NAME_REGEX = /^[a-z][a-z0-9-]{1,47}$/;

/**
 * W-SEC-3: Prefixes reserved for internal/platform use.
 * Plugin and tool names must not start with any of these.
 */
const RESERVED_PREFIXES = Object.freeze(['plugin_', 'orchestray', 'mcp', 'core', '__']);

/**
 * W-SEC-3: Exact names reserved for internal/platform use.
 * Plugin names must not exactly equal any of these.
 */
const RESERVED_NAMES = Object.freeze(['orchestray', 'core', 'plugin', 'system']);

/**
 * W-SEC-11: Unicode bidirectional and zero-width codepoints.
 * Ranges cover U+200B–U+200F (zero-width spaces/joiners/direction marks),
 * U+202A–U+202E (LRE, RLE, PDF, LRO, RLO — bidi embedding/override),
 * U+2060–U+206F (word joiner and invisible formatting chars),
 * U+FEFF (BOM/zero-width no-break space).
 */
const BIDI_OR_ZW_REGEX = /[​-‏‪-‮⁠-⁯﻿]/;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** @param {string} name */
function _hasReservedPrefix(name) {
  return RESERVED_PREFIXES.some(p => name.startsWith(p));
}

/** @param {string} name */
function _isReservedName(name) {
  return RESERVED_NAMES.includes(name);
}

/** @param {string} s */
function _hasUnicodeAttack(s) {
  return BIDI_OR_ZW_REGEX.test(s);
}

// ---------------------------------------------------------------------------
// W-SEC-10: Prototype-pollution scrub
// ---------------------------------------------------------------------------

/**
 * Recursively strip __proto__, prototype, and constructor keys from a parsed
 * JSON value, returning a new null-prototype object tree.
 *
 * Must be called on any raw JSON before passing to PluginManifestSchema.parse().
 *
 * @param {unknown} obj
 * @param {number}  [depth=0]
 * @returns {unknown}
 */
function scrubPrototype(obj, depth = 0) {
  if (depth > 32) throw new Error('manifest depth exceeded');
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => scrubPrototype(v, depth + 1));
  const out = Object.create(null); // null-prototype defeats downstream prototype attacks
  for (const k of Object.keys(obj)) {
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
    out[k] = scrubPrototype(obj[k], depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PluginToolDeclSchema = z.object({
  name: z.string()
    .regex(NAME_REGEX, 'tool name must be kebab-case 2-48 chars')
    .refine(n => !_hasReservedPrefix(n), { message: 'tool name uses reserved prefix' })
    .refine(s => !_hasUnicodeAttack(s), { message: 'tool name contains bidi/zero-width unicode' }),
  description: z.string().max(500)
    .refine(s => !_hasUnicodeAttack(s), { message: 'tool description contains bidi/zero-width unicode' }),
  inputSchema: z.object({}).passthrough(), // full JSON Schema validation deferred to W-SCHEMA-2
});

const PluginManifestSchema = z.object({
  schema_version: z.literal(1),
  name: z.string()
    .regex(NAME_REGEX, 'plugin name must be kebab-case 2-48 chars')
    .refine(n => !_hasReservedPrefix(n), { message: 'plugin name uses reserved prefix (plugin_, orchestray, mcp, core, __)' })
    .refine(n => !_isReservedName(n), { message: 'plugin name is reserved (orchestray, core, plugin, system)' })
    .refine(s => !_hasUnicodeAttack(s), { message: 'plugin name contains bidi/zero-width unicode' }),
  version: z.string()
    .regex(
      /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?(\+[A-Za-z0-9.-]+)?$/,
      'version must be semver (e.g. "1.0.0")'
    ),
  description: z.string().min(1).max(500)
    .refine(s => !_hasUnicodeAttack(s), { message: 'description contains bidi/zero-width unicode' }),
  entrypoint: z.string()
    .refine(p => !p.startsWith('/'), { message: 'entrypoint must be relative to plugin root, not absolute' })
    .refine(p => !p.includes('..'), { message: 'entrypoint must not contain parent traversal' }),
  transport: z.enum(['stdio']),
  runtime: z.enum(['node', 'python', 'any']),
  tools: z.array(PluginToolDeclSchema).min(1, 'manifest must declare at least one tool'),
  capabilities: z.object({}).passthrough().optional(),
  signature: z.object({}).passthrough().optional(),
}).strict(); // W-SEC-9 alignment: reject unknown top-level keys

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse and validate a plugin manifest.
 *
 * Applies scrubPrototype (W-SEC-10) before zod validation.
 * Throws ZodError on any validation failure.
 *
 * @param {unknown} rawJson - Already JSON.parsed value (not a string).
 * @returns {import('zod').infer<typeof PluginManifestSchema>}
 */
function parseManifest(rawJson) {
  const scrubbed = scrubPrototype(rawJson);
  return PluginManifestSchema.parse(scrubbed);
}

module.exports = {
  PluginManifestSchema,
  PluginToolDeclSchema,
  parseManifest,
  scrubPrototype,
  RESERVED_PREFIXES,
  RESERVED_NAMES,
  // helpers exposed for tests
  _hasReservedPrefix,
  _isReservedName,
  _hasUnicodeAttack,
};
