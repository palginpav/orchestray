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
 * Wave 4 additions (W-LISTCH-3/W-SEC-24, W-DEG-1/W-SEC-25):
 *   - listTools() now accepts options: { maxBytes, audit, pluginStateAccessor }.
 *   - maxBytes: response size cap in bytes (default 1 MiB = 1 048 576). Overlay
 *     entries are dropped from the END until the JSON-serialised response fits.
 *     Core tools are NEVER dropped. When truncation occurs, a single
 *     plugin_tools_truncated audit event is emitted with {removed_count, max_bytes,
 *     plugin_name} (W-LISTCH-3, W-SEC-24).
 *   - pluginStateAccessor: (plugin_name) => 'ready'|'degraded'|'dead'|'unloaded'|null
 *     Overlay entries whose plugin is 'degraded' get a '[DEGRADED] ' prefix on
 *     their description. Entries whose plugin is 'dead' or 'unloaded' are omitted
 *     entirely. Default accessor returns 'ready' for every name (W-DEG-1, W-SEC-25).
 *
 * Exports
 * -------
 *   CORE_TOOLS            — Proxy that reads from the live core map (read-only guard).
 *   initCoreTools(table)  — Activate the registry with the frozen TOOL_TABLE from
 *                           server.js. Must be called once at startup.
 *   listTools(opts?)      — Array<{name, description, inputSchema}> ordered
 *                           core-first then overlay, each in insertion order.
 *                           May be truncated if maxBytes cap is exceeded (overlay
 *                           entries from the end are dropped; core tools preserved).
 *   resolveTool(name)     — Returns {definition, handler} or undefined.
 *   _register(entry)      — Add an overlay tool {name, plugin_name?, definition, handler}.
 *                           plugin_name is stored for pluginStateAccessor lookups.
 *   _unregister(name)     — Remove an overlay tool by name.
 *   _isCoreTool(name)     — Boolean: is this name in the core layer?
 *   _overlaySize()        — Number of overlay entries.
 */

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Map<string, {definition: object, handler: Function}>} */
const _coreMap = new Map();

/** @type {Map<string, {definition: object, handler: Function, plugin_name: string|undefined}>} */
const _overlayMap = new Map();

/** Default size cap for listTools() responses: 1 MiB (W-LISTCH-3, W-SEC-24). */
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
 * W-LISTCH-3 / W-SEC-24: if the JSON-serialised result exceeds opts.maxBytes
 * (default 1 MiB), overlay entries are dropped from the END until the
 * response fits. Core tools are NEVER dropped. A single plugin_tools_truncated
 * audit event is emitted via opts.audit when truncation occurs.
 *
 * W-DEG-1 / W-SEC-25: overlay entries are filtered/annotated based on their
 * plugin's current state as reported by opts.pluginStateAccessor:
 *   - 'degraded'  → description prefixed with '[DEGRADED] '
 *   - 'dead'      → entry omitted entirely
 *   - 'unloaded'  → entry omitted entirely
 *   - 'ready'/null/undefined → entry passed through unchanged
 *
 * @param {object} [opts]
 * @param {number|null} [opts.maxBytes=1048576]  Response size cap in bytes.
 *   Pass null to disable the cap. Pull from opts.tools_response_max_bytes when
 *   W-CFG-1 wires config; until then the default is always used.
 * @param {function({type: string, ...}): void} [opts.audit]  Callback for
 *   emitting audit events. Called at most once per listTools() invocation that
 *   triggers truncation. Must not throw.
 * @param {function(plugin_name: string): string|null} [opts.pluginStateAccessor]
 *   Returns the current state of a plugin by name. Default: () => 'ready'.
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

  // --- W-DEG-1: build filtered+annotated overlay list ---
  // Collect as [{definition, plugin_name}] so we can drop/annotate and also
  // track plugin_name for the truncation audit event.
  const overlayItems = [];
  for (const entry of _overlayMap.values()) {
    if (!entry || !entry.definition) continue;
    const pname = entry.plugin_name || null;
    const state = stateOf(pname);
    // Dead or unloaded plugins: drop the tool entirely (W-DEG-1/W-SEC-25).
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

  // --- Build initial result: core first, then overlay ---
  const result = [];
  for (const entry of _coreMap.values()) {
    if (entry && entry.definition) result.push(entry.definition);
  }
  for (const item of overlayItems) {
    result.push(item.definition);
  }

  // --- W-LISTCH-3 / W-SEC-24: size cap enforcement ---
  if (maxBytes !== null && typeof maxBytes === 'number') {
    // Count only non-null core definitions actually pushed — the floor below
    // which the while-loop must never trim (core tools are never dropped).
    let pushedCoreCount = 0;
    for (const entry of _coreMap.values()) {
      if (entry && entry.definition) pushedCoreCount++;
    }

    // Trim overlay entries from the end until we fit.
    let removedCount = 0;
    let lastDroppedPluginName = undefined;
    while (result.length > pushedCoreCount && JSON.stringify(result).length > maxBytes) {
      result.pop();
      // Find corresponding plugin_name from overlayItems (match by position from end).
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
      } catch (_e) {
        // audit callback must never crash listTools — swallow silently.
      }
    }
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
 * W-DEG-1/W-SEC-25: the optional plugin_name field is stored alongside the
 * entry so that listTools() can query the pluginStateAccessor to decide whether
 * to surface, annotate, or suppress the tool (W-LOAD-3 counterpart).
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
  _overlayMap.set(name, {
    definition,
    handler,
    // plugin_name is optional; stored as undefined when absent so
    // pluginStateAccessor callers can distinguish "no plugin" from empty string.
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
