'use strict';

/**
 * Layered tool registry for the Orchestray MCP server.
 *
 * v2.3.0 §W-REG-2 (final impl, supersedes W-REG-1). Provides a two-layer tool table:
 *   - Core layer  : canonical TOOL_TABLE entries imported via initCoreTools().
 *   - Overlay layer: plugin-contributed entries registered via _register().
 *
 * The overlay is empty in v2.3.0 GA (no plugins loaded until Wave 2+). The
 * registry is intentionally forward-compatible: callers can register and
 * unregister overlay tools without touching core entries.
 *
 * Exports
 * -------
 *   CORE_TOOLS            — Proxy that reads from the live core map (read-only guard).
 *   initCoreTools(table)  — Activate the registry with the frozen TOOL_TABLE from
 *                           server.js. Must be called once at startup.
 *   listTools()           — Array<{name, description, inputSchema}> ordered
 *                           core-first then overlay, each in insertion order.
 *   resolveTool(name)     — Returns {definition, handler} or undefined.
 *   _register(entry)      — Add an overlay tool {name, definition, handler}.
 *   _unregister(name)     — Remove an overlay tool by name.
 *   _isCoreTool(name)     — Boolean: is this name in the core layer?
 *   _overlaySize()        — Number of overlay entries.
 */

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Map<string, {definition: object, handler: Function}>} */
const _coreMap = new Map();

/** @type {Map<string, {definition: object, handler: Function}>} */
const _overlayMap = new Map();

let _initialized = false;

// ---------------------------------------------------------------------------
// CORE_TOOLS proxy (read-only view of the core map)
// ---------------------------------------------------------------------------

/**
 * Read-only Proxy over the internal core map. Supports property access by
 * tool name and `Object.entries()` / `for...in` enumeration — matching the
 * access patterns that existed when server.js iterated TOOL_TABLE directly.
 */
const CORE_TOOLS = new Proxy(_coreMap, {
  get(target, prop, _receiver) {
    if (typeof prop === 'symbol') {
      // Fail-loud per feedback_mechanical_over_prose. Wave 1 reviewer flagged
      // silent-undefined as a Wave 2 footgun for plugin authors who try
      // `for (const x of CORE_TOOLS)` or `[...CORE_TOOLS]`.
      throw new TypeError(
        'CORE_TOOLS does not support iteration via symbols. ' +
        'Use CORE_TOOLS.entries(), .keys(), .values(), or .forEach() instead.'
      );
    }
    if (prop === 'entries') return () => target.entries();
    if (prop === 'keys') return () => target.keys();
    if (prop === 'values') return () => target.values();
    if (prop === 'size') return target.size;
    if (prop === 'has') return (k) => target.has(k);
    if (prop === 'forEach') return (fn) => target.forEach(fn);
    return target.get(prop);
  },
  has(target, prop) {
    return target.has(prop);
  },
  ownKeys(target) {
    return [...target.keys()];
  },
  getOwnPropertyDescriptor(target, prop) {
    if (target.has(prop)) {
      return { configurable: true, enumerable: true, value: target.get(prop) };
    }
    return undefined;
  },
  set(_target, _prop, _value) {
    throw new TypeError('CORE_TOOLS is read-only');
  },
  deleteProperty(_target, _prop) {
    throw new TypeError('CORE_TOOLS is read-only');
  },
});

// ---------------------------------------------------------------------------
// initCoreTools
// ---------------------------------------------------------------------------

/**
 * Activate the registry with the frozen TOOL_TABLE from server.js.
 *
 * @param {Object} toolTable — TOOL_TABLE (Object.freeze'd map of name -> {definition, handler})
 * @throws {Error} if called more than once (guards against accidental re-init).
 */
function initCoreTools(toolTable) {
  if (_initialized) {
    throw new Error('tool-registry: initCoreTools() called more than once');
  }
  if (!toolTable || typeof toolTable !== 'object') {
    throw new TypeError('tool-registry: initCoreTools() requires a non-null object');
  }
  for (const [name, entry] of Object.entries(toolTable)) {
    if (!entry || typeof entry !== 'object') continue;
    _coreMap.set(name, { definition: entry.definition, handler: entry.handler });
  }
  _initialized = true;
}

// ---------------------------------------------------------------------------
// listTools
// ---------------------------------------------------------------------------

/**
 * Return the merged tool list: core tools first (in TOOL_TABLE insertion
 * order), then overlay tools. Each entry is the tool's definition object
 * ({name, description, inputSchema}).
 *
 * This is the shape used by tools/list. Core handler references never leave
 * the registry — only definitions are exposed here.
 *
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 */
function listTools() {
  const result = [];
  for (const entry of _coreMap.values()) {
    if (entry && entry.definition) result.push(entry.definition);
  }
  for (const entry of _overlayMap.values()) {
    if (entry && entry.definition) result.push(entry.definition);
  }
  return result;
}

// ---------------------------------------------------------------------------
// resolveTool
// ---------------------------------------------------------------------------

/**
 * Look up a tool entry by name. Core layer takes precedence over overlay
 * (overlay cannot shadow core tools to prevent privilege escalation by
 * plugins overwriting known-good handlers).
 *
 * @param {string} name
 * @returns {{definition: object, handler: Function} | undefined}
 */
function resolveTool(name) {
  if (_coreMap.has(name)) return _coreMap.get(name);
  if (_overlayMap.has(name)) return _overlayMap.get(name);
  return undefined;
}

// ---------------------------------------------------------------------------
// Overlay management (_register / _unregister)
// ---------------------------------------------------------------------------

/**
 * Register a plugin-contributed tool in the overlay layer. Core tool names
 * cannot be registered in the overlay (the core layer always wins).
 *
 * @param {{name: string, definition: object, handler: Function}} entry
 * @throws {TypeError} on missing or invalid fields.
 * @throws {Error} if the name shadows a core tool.
 */
function _register(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('tool-registry._register: entry must be an object');
  }
  const { name, definition, handler } = entry;
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('tool-registry._register: entry.name must be a non-empty string');
  }
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('tool-registry._register: entry.definition must be an object');
  }
  if (typeof handler !== 'function') {
    throw new TypeError('tool-registry._register: entry.handler must be a function');
  }
  if (_coreMap.has(name)) {
    throw new Error('tool-registry._register: cannot shadow core tool "' + name + '"');
  }
  _overlayMap.set(name, { definition, handler });
}

/**
 * Remove a plugin-contributed tool from the overlay. No-op if the name is
 * not in the overlay. Core tools cannot be unregistered.
 *
 * @param {string} name
 */
function _unregister(name) {
  _overlayMap.delete(name);
}

// ---------------------------------------------------------------------------
// Introspection helpers
// ---------------------------------------------------------------------------

/** @param {string} name @returns {boolean} */
function _isCoreTool(name) {
  return _coreMap.has(name);
}

/** @returns {number} */
function _overlaySize() {
  return _overlayMap.size;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CORE_TOOLS,
  initCoreTools,
  listTools,
  resolveTool,
  _register,
  _unregister,
  _isCoreTool,
  _overlaySize,
};
