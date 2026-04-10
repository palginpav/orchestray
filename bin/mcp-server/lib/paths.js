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
 * Defense against path traversal. Rejects a segment if:
 *   - it is not a non-empty string
 *   - it is dots-only ("." "..", "...", etc.)
 *   - it contains a forward or back slash
 *   - it contains a null byte
 *   - it is longer than 200 chars
 *
 * Throws an Error with `code = 'PATH_TRAVERSAL'` on any violation.
 */
function assertSafeSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0) {
    const e = new Error('empty path segment');
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
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
  if (segment.length > 200) {
    const e = new Error('segment too long (> 200 chars)');
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
  if (typeof uri !== 'string') {
    const e = new Error('uri must be a string');
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
  const m = /^orchestray:([a-z]+):\/\/(.*)$/i.exec(uri);
  if (!m) {
    const e = new Error('malformed URI: ' + uri);
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
  const scheme = m[1];
  const rest = m[2];
  const segments = rest.length === 0 ? [] : rest.split('/');
  for (const seg of segments) assertSafeSegment(seg);
  return { scheme, segments };
}

function getPatternsDir() {
  return path.join(getProjectRoot(), '.orchestray', 'patterns');
}

function getHistoryDir() {
  return path.join(getProjectRoot(), '.orchestray', 'history');
}

function getKbDir() {
  return path.join(getProjectRoot(), '.orchestray', 'kb');
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

function resolvePatternFile(slug) {
  assertSafeSegment(slug);
  const dir = getPatternsDir();
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

function resolveHistoryArchive(orchId) {
  assertSafeSegment(orchId);
  const dir = getHistoryDir();
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

function resolveHistoryTaskFile(orchId, taskId) {
  const archive = resolveHistoryArchive(orchId);
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

function resolveKbFile(section, slug) {
  if (!_KB_SECTIONS.has(section)) {
    const e = new Error('unknown kb section: ' + section);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  assertSafeSegment(slug);
  const dir = getKbDir();
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
  resolvePatternFile,
  resolveHistoryArchive,
  resolveHistoryTaskFile,
  resolveKbFile,
};
