'use strict';

/**
 * plugin-namespace.js — Plugin tool name builder, parser, and collision guard.
 *
 * W-NS-1 (v2.3.0): Implements the broker-emitted name format defined in
 * v230-ipc-design.md §4 (Tool Name Namespacing Strategy) and the
 * defense-in-depth collision-rejection specified in W-SEC-3.
 *
 * Namespace format (canonical):
 *   broker-emitted  = "plugin_" + <plugin-name> + "_" + <tool-name>
 *   Claude Code UI  = "mcp__orchestray__" + broker-emitted
 *
 * Both plugin-name and tool-name follow kebab-case with the regex
 * /^[a-z][a-z0-9-]{1,47}$/ (2–48 chars, lowercase, hyphens allowed,
 * NO underscores). The absence of underscores in valid names is the
 * invariant that makes split-on-first-underscore safe: after stripping
 * the "plugin_" prefix, the first underscore unambiguously separates
 * plugin-name from tool-name because plugin-name can never contain one.
 *
 * W-SEC-3 (collision rejection): W-SCHEMA-1 RESERVED_PREFIXES blocks plugins
 * from registering a name beginning with "plugin_", preventing them from
 * crafting a broker-emitted name that collides with another plugin's tools.
 * `assertNoCoreCollision` provides an additional defense-in-depth check
 * at tool-registration time to catch any residual collision with core tools.
 *
 * Pure functions — no I/O, no side effects, deterministic.
 */

/** @type {string} Prefix prepended to every broker-emitted plugin tool name. */
const NAMESPACE_PREFIX = 'plugin_';

/** @type {string} Separator between plugin-name and tool-name segments. */
const SEPARATOR = '_';

/**
 * Kebab-case validation regex shared by both plugin-name and tool-name.
 * Matches: 2–48 characters, starts with a lowercase letter, followed by
 * lowercase letters, digits, or hyphens. Underscores are intentionally
 * excluded — the underscore is the sole separator character.
 *
 * @type {RegExp}
 */
const _NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;

/**
 * Build the broker-emitted name for a plugin tool.
 *
 * The returned string has the form: `plugin_<pluginName>_<toolName>`.
 * Claude Code prepends `mcp__orchestray__` automatically when displaying
 * the tool to users.
 *
 * @param {string} pluginName - Plugin identifier (kebab-case, 2–48 chars).
 * @param {string} toolName   - Tool identifier within the plugin (kebab-case, 2–48 chars).
 * @returns {string} Broker-emitted namespaced tool name.
 * @throws {TypeError} If either argument fails the kebab-case regex.
 */
function buildNamespacedName(pluginName, toolName) {
  if (typeof pluginName !== 'string' || !_NAME_RE.test(pluginName)) {
    throw new TypeError(
      `buildNamespacedName: pluginName must match /^[a-z][a-z0-9-]{1,47}$/, got: ${JSON.stringify(pluginName)}`
    );
  }
  if (typeof toolName !== 'string' || !_NAME_RE.test(toolName)) {
    throw new TypeError(
      `buildNamespacedName: toolName must match /^[a-z][a-z0-9-]{1,47}$/, got: ${JSON.stringify(toolName)}`
    );
  }
  return NAMESPACE_PREFIX + pluginName + SEPARATOR + toolName;
}

/**
 * Parse a broker-emitted namespaced name back to its constituent parts.
 *
 * Splitting strategy: after stripping the `plugin_` prefix, split on the
 * FIRST underscore. This is safe because the kebab-case regex guarantees
 * plugin-name contains no underscores, so the first underscore is
 * unambiguously the separator between plugin-name and tool-name.
 *
 * Returns `null` (not throws) for any input that does not conform to the
 * plugin namespace format, so callers can treat unknown names gracefully.
 *
 * @param {string} namespacedName - A candidate broker-emitted tool name.
 * @returns {{pluginName: string, toolName: string}|null}
 *   Parsed parts on success; `null` if the name is not in the plugin namespace
 *   or fails validation.
 */
function parseNamespacedName(namespacedName) {
  if (typeof namespacedName !== 'string') return null;
  if (!namespacedName.startsWith(NAMESPACE_PREFIX)) return null;

  const remainder = namespacedName.slice(NAMESPACE_PREFIX.length);

  // Must have at least one separator so we get both plugin-name and tool-name.
  const sepIdx = remainder.indexOf(SEPARATOR);
  if (sepIdx === -1) return null;

  const pluginName = remainder.slice(0, sepIdx);
  const toolName   = remainder.slice(sepIdx + 1);

  // Both halves must satisfy the kebab-case regex.
  if (!_NAME_RE.test(pluginName)) return null;
  if (!_NAME_RE.test(toolName))   return null;

  return { pluginName, toolName };
}

/**
 * Return true iff the given name is in the plugin tool namespace.
 *
 * A lightweight prefix check — use when you only need to know whether a
 * name was emitted by the plugin broker, not to extract its parts.
 *
 * @param {string} name - A broker-emitted tool name.
 * @returns {boolean}
 */
function isPluginToolName(name) {
  return typeof name === 'string' && name.startsWith(NAMESPACE_PREFIX);
}

/**
 * Assert that a broker-emitted namespaced name does not collide with any
 * tool in the provided core tools list (W-SEC-3 defense-in-depth).
 *
 * W-SCHEMA-1 RESERVED_PREFIXES already prevents plugins from registering
 * names that would produce a broker-emitted name colliding with the
 * `plugin_` prefix. The tool-registry's `_register` function checks
 * `_coreMap.has(name)` and throws — that is the production check.
 * This export is test-only and provides an additional assertion surface;
 * it is not called in the production plugin-loader path.
 *
 * @param {string}          namespacedName - Broker-emitted name to check.
 * @param {Set<string>|string[]} coreToolsList - Known core tool names.
 * @throws {TypeError} If namespacedName is found in coreToolsList.
 */
function assertNoCoreCollision(namespacedName, coreToolsList) {
  const set = coreToolsList instanceof Set
    ? coreToolsList
    : new Set(coreToolsList);

  if (set.has(namespacedName)) {
    throw new TypeError(
      `assertNoCoreCollision: tool name "${namespacedName}" collides with a core tool (W-SEC-3)`
    );
  }
}

module.exports = {
  NAMESPACE_PREFIX,
  SEPARATOR,
  buildNamespacedName,
  parseNamespacedName,
  isPluginToolName,
  assertNoCoreCollision,
};
