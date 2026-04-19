'use strict';

/**
 * Shared constants for the Orchestray MCP server.
 *
 * Centralises values that are referenced from multiple tool/lib files to
 * avoid divergence. Import from here; never define in a per-tool file.
 *
 * Per T3 D2 (v2.0.15 reviewer audit — add agent_role enum to
 * history_query_events INPUT_SCHEMA and share the constant).
 */

/**
 * Canonical list of Orchestray agent role identifiers.
 * Must match the `agent_role` values emitted in audit events and the
 * frontmatter `agent_role` fields in pattern files.
 *
 * @type {string[]}
 */
const AGENT_ROLES = [
  'pm',
  'architect',
  'developer',
  'refactorer',
  'reviewer',
  'debugger',
  'tester',
  'documenter',
  'inventor',
  'researcher',
  'security-engineer',
];

module.exports = { AGENT_ROLES };
