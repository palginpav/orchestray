'use strict';

/**
 * Cross-platform path helpers for the Orchestray MCP server.
 *
 * Single chokepoint for plugin-root and project-root resolution. No untrusted
 * caller paths are accepted in Stage 1 — all inputs come from the server's
 * own environment (env vars, __dirname, process.cwd()).
 *
 * Per v2011c-stage1-plan.md §3.1.
 */

const fs = require('node:fs');
const path = require('node:path');

const WALK_CAP = 20;

/**
 * Walk upward from `start` looking for a directory that contains `marker`.
 * Returns the first directory that has it, or null if the walk cap is hit.
 *
 * `marker` is a relative path like `.claude-plugin/plugin.json` or `.orchestray`.
 */
function walkUpFor(start, marker) {
  let current = path.resolve(start);
  for (let i = 0; i < WALK_CAP; i++) {
    const candidate = path.join(current, marker);
    try {
      // fs.existsSync is acceptable here — one-time startup check, not hot path.
      if (fs.existsSync(candidate)) {
        return current;
      }
    } catch (_e) {
      // Ignore and keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached filesystem root.
      return null;
    }
    current = parent;
  }
  return null;
}

/**
 * Resolve the plugin root — the directory containing `.claude-plugin/plugin.json`.
 *
 * Resolution order:
 *   1. `ORCHESTRAY_PLUGIN_ROOT` env var if set and valid
 *   2. Walk up from this file's directory until `.claude-plugin/plugin.json` is found
 *
 * Throws on miss; server.js catches at startup and exits 1.
 */
function getPluginRoot() {
  const fromEnv = process.env.ORCHESTRAY_PLUGIN_ROOT;
  if (fromEnv && fromEnv.length > 0) {
    const marker = path.join(fromEnv, '.claude-plugin', 'plugin.json');
    if (fs.existsSync(marker)) {
      return path.resolve(fromEnv);
    }
    // Env var was set but invalid — still try to walk up as a fallback.
  }

  const found = walkUpFor(__dirname, path.join('.claude-plugin', 'plugin.json'));
  if (found) return found;
  throw new Error('plugin root not found');
}

/**
 * Resolve the project root — the directory containing `.orchestray/`.
 *
 * Walks up from `process.cwd()` (not __dirname) so callers that chdir into a
 * sandbox/fixture get the expected result. Throws on miss.
 */
function getProjectRoot() {
  const found = walkUpFor(process.cwd(), '.orchestray');
  if (found) return found;
  throw new Error('project root not found (no .orchestray/ in cwd ancestors)');
}

/** Absolute path to `<project>/.orchestray/audit/events.jsonl`. */
function getAuditEventsPath() {
  return path.join(getProjectRoot(), '.orchestray', 'audit', 'events.jsonl');
}

/** Absolute path to `<project>/.orchestray/audit/current-orchestration.json`. */
function getCurrentOrchestrationPath() {
  return path.join(getProjectRoot(), '.orchestray', 'audit', 'current-orchestration.json');
}

/** Absolute path to `<project>/.orchestray/config.json`. */
function getConfigPath() {
  return path.join(getProjectRoot(), '.orchestray', 'config.json');
}

// ---------------------------------------------------------------------------
// Stage 2 additions — resource URI parsing + traversal-safe resolvers
// ---------------------------------------------------------------------------

/**
 * Defense against bad path segments. Two error classes:
 *
 * - `PATH_TRAVERSAL` — the segment *looks hostile*: dots-only (`.`, `..`,
 *   `...`), contains a path separator, or contains a null byte. These are
 *   what a real attacker writes; treat them as security signals.
 *
 * - `INVALID_SEGMENT` — the segment is *just malformed*: non-string, empty,
 *   or longer than 200 chars. These are honest input-shape mistakes and
 *   carry no traversal semantics.
 *
 * Both codes still map to JSON-RPC `-32602` (invalid params) at the
 * resources/read dispatcher, so the client surface is unchanged; the
 * split exists so future log reviewers and security tooling can
 * distinguish "user typo" from "someone is probing path traversal".
 * m2 from the v2.0.11 solidification pass.
 */
function assertSafeSegment(segment) {
  // Non-hostile shape errors: wrong type, empty, too long.
  if (typeof segment !== 'string' || segment.length === 0) {
    const e = new Error('empty path segment');
    e.code = 'INVALID_SEGMENT';
    throw e;
  }
  if (segment.length > 200) {
    const e = new Error('segment too long (> 200 chars)');
    e.code = 'INVALID_SEGMENT';
    throw e;
  }
  // Hostile shape errors: dots-only, separators, null bytes.
  if (/^\.+$/.test(segment)) {
    const e = new Error('dot-only segment: ' + segment);
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
  if (segment.indexOf('/') !== -1 || segment.indexOf('\\') !== -1) {
    const e = new Error('segment contains path separator: ' + segment);
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
  if (segment.indexOf('\u0000') !== -1) {
    const e = new Error('segment contains null byte');
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
}

/**
 * Parse an `orchestray:<scheme>://<path>` URI into { scheme, segments }.
 * Throws Error with `code = 'PATH_TRAVERSAL'` on any malformed URI or
 * unsafe segment.
 *
 * Shapes supported:
 *   orchestray:pattern://<slug>
 *   orchestray:history://audit/live
 *   orchestray:history://orch/<orch_id>
 *   orchestray:history://orch/<orch_id>/summary
 *   orchestray:history://orch/<orch_id>/tasks/<task_id>
 *   orchestray:kb://<section>/<slug>
 */
function parseResourceUri(uri) {
  // Non-hostile URI-shape errors carry `INVALID_URI` per the m2 taxonomy
  // split. Per-segment checks still throw PATH_TRAVERSAL / INVALID_SEGMENT
  // out of assertSafeSegment as usual.
  if (typeof uri !== 'string') {
    const e = new Error('uri must be a string');
    e.code = 'INVALID_URI';
    throw e;
  }
  const m = /^orchestray:([a-z]+):\/\/(.*)$/i.exec(uri);
  if (!m) {
    const e = new Error('malformed URI: ' + uri);
    e.code = 'INVALID_URI';
    throw e;
  }
  const scheme = m[1];
  const rest = m[2];
  const segments = rest.length === 0 ? [] : rest.split('/');
  for (const seg of segments) assertSafeSegment(seg);
  return { scheme, segments };
}

// The resource-dir helpers accept an optional `root` override so resource
// handlers and tests can inject a fixture project root without each call site
// re-implementing the path join + traversal defense. When `root` is omitted,
// the usual getProjectRoot() walk-up is used. B3 cleanup from the v2.0.11
// solidification pass.
function getPatternsDir(root) {
  return path.join(root || getProjectRoot(), '.orchestray', 'patterns');
}

function getHistoryDir(root) {
  return path.join(root || getProjectRoot(), '.orchestray', 'history');
}

function getKbDir(root) {
  return path.join(root || getProjectRoot(), '.orchestray', 'kb');
}

function getAuditEventsPathIn(root) {
  return path.join(root || getProjectRoot(), '.orchestray', 'audit', 'events.jsonl');
}

function _assertContained(resolved, rootAbs, label) {
  // path.resolve + startsWith containment check. The trailing separator is
  // important: without it, "/a/patterns_evil" would pass a "startsWith
  // /a/patterns" test.
  if (
    resolved !== rootAbs &&
    !resolved.startsWith(rootAbs + path.sep)
  ) {
    const e = new Error('path escapes ' + label + ' root');
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
}

function resolvePatternFile(slug, root) {
  assertSafeSegment(slug);
  const dir = getPatternsDir(root);
  const rootAbs = path.resolve(dir);
  const resolved = path.resolve(path.join(dir, slug + '.md'));
  _assertContained(resolved, rootAbs, 'patterns');
  if (!fs.existsSync(resolved)) {
    const e = new Error('pattern not found: ' + slug);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  return resolved;
}

function resolveHistoryArchive(orchId, root) {
  assertSafeSegment(orchId);
  const dir = getHistoryDir(root);
  const rootAbs = path.resolve(dir);
  const resolved = path.resolve(path.join(dir, orchId));
  _assertContained(resolved, rootAbs, 'history');
  if (!fs.existsSync(resolved)) {
    const e = new Error('history archive not found: ' + orchId);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  return resolved;
}

function resolveHistoryTaskFile(orchId, taskId, root) {
  const archive = resolveHistoryArchive(orchId, root);
  assertSafeSegment(taskId);
  const resolved = path.resolve(path.join(archive, 'tasks', taskId + '.md'));
  _assertContained(resolved, archive, 'history archive');
  if (!fs.existsSync(resolved)) {
    const e = new Error('task file not found: ' + orchId + '/' + taskId);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  return resolved;
}

const _KB_SECTIONS = new Set(['facts', 'decisions', 'artifacts']);

function resolveKbFile(section, slug, root) {
  if (!_KB_SECTIONS.has(section)) {
    const e = new Error('unknown kb section: ' + section);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  assertSafeSegment(slug);
  const dir = getKbDir(root);
  const rootAbs = path.resolve(dir);
  const resolved = path.resolve(path.join(dir, section, slug + '.md'));
  _assertContained(resolved, rootAbs, 'kb');
  if (!fs.existsSync(resolved)) {
    const e = new Error('kb entry not found: ' + section + '/' + slug);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  return resolved;
}

module.exports = {
  getPluginRoot,
  getProjectRoot,
  getAuditEventsPath,
  getCurrentOrchestrationPath,
  getConfigPath,
  // Stage 2
  assertSafeSegment,
  parseResourceUri,
  getPatternsDir,
  getHistoryDir,
  getKbDir,
  getAuditEventsPathIn,
  resolvePatternFile,
  resolveHistoryArchive,
  resolveHistoryTaskFile,
  resolveKbFile,
};
