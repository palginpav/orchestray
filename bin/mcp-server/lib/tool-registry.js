'use strict';

/**
 * Layered tool registry for the Orchestray MCP server.
 *
 * Two-layer tool table:
 *   - Core layer  : canonical TOOL_TABLE entries imported via initCoreTools().
 *   - Overlay layer: plugin-contributed entries registered via _register().
 *
 * listTools() options: { maxBytes, audit, pluginStateAccessor }.
 *   - maxBytes: response size cap in bytes (default 1 MiB = 1 048 576). Overlay
 *     entries are dropped from the END until the JSON-serialised response fits.
 *     Core tools are NEVER dropped. When truncation occurs, a single
 *     plugin_tools_truncated audit event is emitted with {removed_count, max_bytes,
 *     plugin_name}.
 *   - pluginStateAccessor: (plugin_name) => 'ready'|'degraded'|'dead'|'unloaded'|null
 *     'degraded' → '[DEGRADED] ' prefix on description.
 *     'dead'|'unloaded' → entry omitted entirely.
 *     Default accessor returns 'ready'.
 *
 * Exports
 * -------
 *   CORE_TOOLS            — Read-only Proxy over the core map.
 *   initCoreTools(table)  — Activate with the frozen TOOL_TABLE. Call once at startup.
 *   listTools(opts?)      — Array<{name, description, inputSchema}> core-first, overlay-second.
 *   resolveTool(name)     — Returns {definition, handler} or undefined.
 *   _register(entry)      — Add an overlay tool {name, plugin_name?, definition, handler}.
 *   _unregister(name)     — Remove an overlay tool by name.
 *   _isCoreTool(name)     — Boolean.
 *   _overlaySize()        — Number of overlay entries.
 */

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Map<string, {definition: object, handler: Function}>} */
const _coreMap = new Map();

/** @type {Map<string, {definition: object, handler: Function, plugin_name: string|undefined}>} */
const _overlayMap = new Map();

/** Default size cap for listTools() responses: 1 MiB. */
const DEFAULT_MAX_BYTES = 1048576;

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
      // Fail-loud: plugin authors who try `for (const x of CORE_TOOLS)` or
      // `[...CORE_TOOLS]` should get a clear error instead of silent-undefined.
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
 * If the JSON-serialised result exceeds opts.maxBytes (default 1 MiB), overlay
 * entries are dropped from the END until it fits. Core tools are NEVER dropped.
 * A single plugin_tools_truncated audit event is emitted via opts.audit.
 *
 * Overlay entries are filtered/annotated by opts.pluginStateAccessor:
 *   - 'degraded'  → description prefixed with '[DEGRADED] '
 *   - 'dead'      → entry omitted
 *   - 'unloaded'  → entry omitted
 *   - 'ready'/null/undefined → passed through unchanged
 *
 * @param {object} [opts]
 * @param {number|null} [opts.maxBytes=1048576]  Response size cap. Pass null to disable.
 * @param {function({type: string, ...}): void} [opts.audit]  Audit callback; must not throw.
 * @param {function(plugin_name: string): string|null} [opts.pluginStateAccessor]
 *   Default: () => 'ready'.
 * @returns {Array<{name: string, description: string, inputSchema: object}>}
 */
function listTools(opts) {
  const maxBytes = (opts && opts.maxBytes !== undefined)
    ? opts.maxBytes
    : DEFAULT_MAX_BYTES;
  const audit = (opts && typeof opts.audit === 'function') ? opts.audit : null;
  const stateOf = (opts && typeof opts.pluginStateAccessor === 'function')
    ? opts.pluginStateAccessor
    : () => 'ready';

  // Build filtered+annotated overlay list.
  const overlayItems = [];
  for (const entry of _overlayMap.values()) {
    if (!entry || !entry.definition) continue;
    const pname = entry.plugin_name || null;
    const state = stateOf(pname);
    if (state === 'dead' || state === 'unloaded') continue;
    if (state === 'degraded') {
      // Clone definition to avoid mutating the stored entry.
      const def = Object.assign({}, entry.definition, {
        description: '[DEGRADED] ' + (entry.definition.description || ''),
      });
      overlayItems.push({ definition: def, plugin_name: pname });
    } else {
      overlayItems.push({ definition: entry.definition, plugin_name: pname });
    }
  }

  // Build result: core first, then overlay.
  const result = [];
  for (const entry of _coreMap.values()) {
    if (entry && entry.definition) result.push(entry.definition);
  }
  for (const item of overlayItems) {
    result.push(item.definition);
  }

  // Size cap enforcement: trim overlay entries from the end until response fits.
  if (maxBytes !== null && typeof maxBytes === 'number') {
    let pushedCoreCount = 0;
    for (const entry of _coreMap.values()) {
      if (entry && entry.definition) pushedCoreCount++;
    }

    let removedCount = 0;
    let lastDroppedPluginName = undefined;
    while (result.length > pushedCoreCount && JSON.stringify(result).length > maxBytes) {
      result.pop();
      const overlayIdx = overlayItems.length - 1 - removedCount;
      if (overlayIdx >= 0 && overlayItems[overlayIdx]) {
        lastDroppedPluginName = overlayItems[overlayIdx].plugin_name || undefined;
      }
      removedCount++;
    }

    if (removedCount > 0 && audit) {
      try {
        audit({
          type: 'plugin_tools_truncated',
          removed_count: removedCount,
          max_bytes: maxBytes,
          ...(lastDroppedPluginName !== undefined && { plugin_name: lastDroppedPluginName }),
        });
      } catch (_e) { /* swallow — audit must never crash listTools */ }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// resolveTool
// ---------------------------------------------------------------------------

/**
 * Look up a tool entry by name. Core layer takes precedence (overlay cannot
 * shadow core tools — prevents privilege escalation by plugins).
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
 * cannot be shadowed. The optional plugin_name field is stored so listTools()
 * can query pluginStateAccessor to surface, annotate, or suppress the tool.
 *
 * @param {{name: string, plugin_name?: string, definition: object, handler: Function}} entry
 * @throws {TypeError} on missing or invalid fields.
 * @throws {Error} if the name shadows a core tool.
 */
function _register(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('tool-registry._register: entry must be an object');
  }
  const { name, plugin_name, definition, handler } = entry;
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
  // Reject duplicate overlay registrations: silent Map.set replacement could
  // let a second plugin overwrite a prior plugin's tool. Callers that want to
  // update a tool MUST _unregister(name) first, making replacement explicit.
  if (_overlayMap.has(name)) {
    throw new Error('tool-registry._register: overlay tool "' + name + '" already registered (call _unregister first)');
  }
  _overlayMap.set(name, {
    definition,
    handler,
    // Undefined when absent so callers can distinguish "no plugin" from empty string.
    plugin_name: (typeof plugin_name === 'string' && plugin_name.length > 0)
      ? plugin_name
      : undefined,
  });
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
