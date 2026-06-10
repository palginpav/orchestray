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
 * Superset of all roles known to the system; history_query_events and
 * cost_budget_check use this enum for filtering. Keep in sync with the
 * agent file list in agents/ and CLAUDE.md §Agent Roles.
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
  'release-manager',
  'ux-critic',
  'platform-oracle',
  'project-intent',
];

/**
 * Maximum allowed size for a single JSON-RPC input frame (line), in bytes.
 * Lines exceeding this are rejected with JSONRPC_INVALID_REQUEST before
 * JSON.parse — preventing OOM from newline-starved or oversized frames.
 *
 * Chosen to comfortably cover the largest legitimate payload:
 *   kb_write content maxLength 1 MiB + specialist 512 KiB + framing ≈ 2 MiB.
 * 8 MiB gives 4× headroom while keeping the guard meaningful.
 */
const MAX_INPUT_BYTES = 8 * 1024 * 1024; // 8 MiB

module.exports = { AGENT_ROLES, MAX_INPUT_BYTES };
