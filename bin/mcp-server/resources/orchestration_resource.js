'use strict';

/**
 * `orchestray:orchestration://` MCP resource handler.
 *
 * Exposes live and archived orchestration state for the /orchestray:resume path.
 *
 * Supported URI shapes:
 *   orchestray:orchestration://current
 *     → merged JSON from .orchestray/state/orchestration.md +
 *       .orchestray/audit/current-orchestration.json
 *   orchestray:orchestration://current/tasks/<task_id>
 *     → per-task file .orchestray/state/tasks/<task_id>.md
 *   orchestray:orchestration://current/routing
 *     → full .orchestray/state/routing.jsonl contents
 *   orchestray:orchestration://current/checkpoints
 *     → .orchestray/state/mcp-checkpoint.jsonl for current orchestration_id
 *   orchestray:orchestration://{orch-id}
 *     → archived orchestration summary from .orchestray/history/{orch-id}/.
 *       orch-id must match ^orch-[A-Za-z0-9-]{1,80}$ (path-traversal guard).
 *       Returns RESOURCE_NOT_FOUND when no such history directory exists.
 *
 * Per v2016-release-plan.md §W2 + D6 (historical URI, deferred).
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const { parseFrontmatter: _parseFrontmatter } = require('../../_lib/frontmatter-parse');

function _root(context) {
  return (context && context.projectRoot) || null;
}

/**
 * Parse the orchestration.md frontmatter block into a plain object.
 * Returns {} if the file is missing, unreadable, or has no frontmatter.
 * Fail-open: any parse error returns the partial result so far.
 *
 * @param {string} text - raw markdown content
 * @returns {object}
 */
function parseFrontmatter(text) {
  if (typeof text !== 'string') return {};
  const result = _parseFrontmatter(text);
  return result ? result.frontmatter : {};
}

/**
 * Read the current orchestration state from the two canonical state files
 * and merge them into a single JSON object.
 *
 * Files consulted:
 *   .orchestray/state/orchestration.md               — YAML frontmatter
 *   .orchestray/audit/current-orchestration.json     — rich audit snapshot
 *   .orchestray/audit/events.jsonl                   — last 50 events (tail)
 *
 * Returns {} (merged result) on any partial read failure — fail-open.
 *
 * @param {string|null} root - Project root override (for tests)
 * @returns {object}
 */
function readCurrentOrchestrationState(root) {
  const base = root || null;

  let orchMd = {};
  let currentJson = {};
  let recentEvents = [];

  // 1. Parse orchestration.md frontmatter
  try {
    const mdPath = path.join(base || paths.getProjectRoot(), '.orchestray', 'state', 'orchestration.md');
    const text = fs.readFileSync(mdPath, 'utf8');
    orchMd = parseFrontmatter(text);
  } catch (_e) {
    // Missing or unreadable — continue with empty
  }

  // 2. Parse current-orchestration.json
  try {
    const jsonPath = path.join(base || paths.getProjectRoot(), '.orchestray', 'audit', 'current-orchestration.json');
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      currentJson = parsed;
    }
  } catch (_e) {
    // Missing or malformed — continue with empty
  }

  // 3. Tail events.jsonl for recent events (last 50).
  // Cap read at 128 KB to avoid blocking on huge files.
  try {
    const eventsPath = path.join(base || paths.getProjectRoot(), '.orchestray', 'audit', 'events.jsonl');
    const MAX_EVENTS_TAIL = 128 * 1024; // 128 KB tail window
    let raw;
    try {
      const stat = fs.statSync(eventsPath);
      if (stat.size > MAX_EVENTS_TAIL) {
        const fd = fs.openSync(eventsPath, 'r');
        try {
          const buf = Buffer.alloc(MAX_EVENTS_TAIL);
          const bytesRead = fs.readSync(fd, buf, 0, MAX_EVENTS_TAIL, stat.size - MAX_EVENTS_TAIL);
          raw = buf.slice(0, bytesRead).toString('utf8');
          // Skip the first (potentially truncated) line.
          const firstNl = raw.indexOf('\n');
          if (firstNl !== -1) raw = raw.slice(firstNl + 1);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        raw = fs.readFileSync(eventsPath, 'utf8');
      }
    } catch (_readErr) {
      raw = null;
    }
    if (raw !== null) {
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      const tail = lines.slice(-50);
      for (const line of tail) {
        try {
          recentEvents.push(JSON.parse(line));
        } catch (_e) {
          // Skip malformed lines
        }
      }
    }
  } catch (_e) {
    // Missing or unreadable — leave recentEvents empty
  }

  // Merge: currentJson wins for key conflicts (richer audit snapshot)
  return Object.assign({}, orchMd, currentJson, { recent_events: recentEvents });
}

// ---------------------------------------------------------------------------
// D6 helpers — historical orchestration URI
// ---------------------------------------------------------------------------

/**
 * Validate that an orch-id segment is safe (no path traversal, valid format).
 * Returns true when the id matches ^orch-[A-Za-z0-9-]{1,80}$.
 *
 * @param {string} orchId
 * @returns {boolean}
 */
function isValidOrchId(orchId) {
  return /^orch-[A-Za-z0-9-]{1,80}$/.test(orchId);
}

/**
 * Read a summary from an archived orchestration history directory.
 *
 * Reads:
 *   .orchestray/history/{orch-id}/events.jsonl — last 128 KB tail, last 50 events
 *   .orchestray/history/{orch-id}/state/orchestration.md — if present (optional)
 *
 * Returns a synthesized summary object.
 *
 * @param {string} historyDir - Absolute path to the orch-id directory
 * @param {string} orchId
 * @returns {object}
 */
function readHistoricalOrchestration(historyDir, orchId) {
  const MAX_EVENTS_TAIL = 128 * 1024; // 128 KB tail window (mirrors F12 fix)
  const result = { orchestration_id: orchId, source: 'history', recent_events: [] };

  // 1. Read events.jsonl tail (bounded read — same as readCurrentOrchestrationState)
  try {
    const eventsPath = path.join(historyDir, 'events.jsonl');
    let raw;
    try {
      const stat = fs.statSync(eventsPath);
      if (stat.size > MAX_EVENTS_TAIL) {
        const fd = fs.openSync(eventsPath, 'r');
        try {
          const buf = Buffer.alloc(MAX_EVENTS_TAIL);
          const bytesRead = fs.readSync(fd, buf, 0, MAX_EVENTS_TAIL, stat.size - MAX_EVENTS_TAIL);
          raw = buf.slice(0, bytesRead).toString('utf8');
          const firstNl = raw.indexOf('\n');
          if (firstNl !== -1) raw = raw.slice(firstNl + 1);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        raw = fs.readFileSync(eventsPath, 'utf8');
      }
    } catch (_readErr) {
      raw = null;
    }

    if (raw !== null) {
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      const tail = lines.slice(-50);
      for (const line of tail) {
        try { result.recent_events.push(JSON.parse(line)); } catch (_e) { /* skip malformed */ }
      }
    }
  } catch (_e) {
    // Missing or unreadable events.jsonl — continue with empty recent_events.
  }

  // 2. Read state/orchestration.md frontmatter if present (optional sub-path)
  try {
    const mdPath = path.join(historyDir, 'state', 'orchestration.md');
    const text = fs.readFileSync(mdPath, 'utf8');
    const mdFields = parseFrontmatter(text);
    Object.assign(result, mdFields);
    // Ensure our synthesized fields win over any conflicting frontmatter values.
    result.orchestration_id = orchId;
    result.source = 'history';
  } catch (_e) {
    // File absent — non-fatal. Events alone form a valid summary.
  }

  return result;
}

/**
 * List the last N archived orchestrations under .orchestray/history/
 * that match the orch-id naming pattern, sorted by mtime descending.
 *
 * @param {string} base - Project root
 * @param {number} limit - Maximum number of entries to return
 * @returns {Array<{name: string, mtime: number}>}
 */
function listRecentHistoryOrchestrations(base, limit) {
  const historyDir = path.join(base, '.orchestray', 'history');
  let entries;
  try {
    entries = fs.readdirSync(historyDir);
  } catch (_e) {
    return [];
  }

  const validEntries = [];
  for (const name of entries) {
    if (!isValidOrchId(name)) continue;
    const entryPath = path.join(historyDir, name);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.isDirectory()) {
        validEntries.push({ name, mtime: stat.mtimeMs });
      }
    } catch (_e) {
      // Skip unreadable entries.
    }
  }

  // Sort by mtime descending (most recent first), take top N.
  validEntries.sort((a, b) => b.mtime - a.mtime);
  return validEntries.slice(0, limit);
}

// ---------------------------------------------------------------------------
// list — current active orchestration + last 5 archived orchestrations
// ---------------------------------------------------------------------------

async function list(context) {
  const root = _root(context);
  const base = root || null;

  const resources = [
    {
      uri: 'orchestray:orchestration://current',
      name: 'Current orchestration state',
      description: 'Live orchestration state from .orchestray/state/orchestration.md and audit/current-orchestration.json',
      mimeType: 'application/json',
    },
    {
      uri: 'orchestray:orchestration://current/routing',
      name: 'Current routing decisions',
      description: '.orchestray/state/routing.jsonl — model routing decisions for current orchestration',
      mimeType: 'application/x-ndjson',
    },
    {
      uri: 'orchestray:orchestration://current/checkpoints',
      name: 'Current MCP checkpoints',
      description: '.orchestray/state/mcp-checkpoint.jsonl — MCP checkpoint ledger for current orchestration',
      mimeType: 'application/x-ndjson',
    },
  ];

  // Include last 5 archived orchestrations by mtime (hundreds could exist).
  try {
    const projectBase = base || paths.getProjectRoot();
    const recent = listRecentHistoryOrchestrations(projectBase, 5);
    for (const entry of recent) {
      resources.push({
        uri: 'orchestray:orchestration://' + entry.name,
        name: 'Archived orchestration: ' + entry.name,
        description: 'Historical orchestration state from .orchestray/history/' + entry.name,
        mimeType: 'application/json',
      });
    }
  } catch (_e) {
    // Fail-open: history listing errors must not break list().
  }

  return { resources };
}

// ---------------------------------------------------------------------------
// templates — URI templates for parametric sub-resources
// ---------------------------------------------------------------------------

async function templates(_context) {
  return {
    resourceTemplates: [
      {
        uriTemplate: 'orchestray:orchestration://current/tasks/{task_id}',
        name: 'Current task file',
        description: 'Per-task state file from .orchestray/state/tasks/<task_id>.md',
        mimeType: 'text/markdown',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// read — dispatch on URI segments
// ---------------------------------------------------------------------------

async function read(uri, context, parsed) {
  const { scheme, segments } = parsed || paths.parseResourceUri(uri);

  if (scheme !== 'orchestration') {
    const e = new Error('orchestration_resource.read: wrong scheme ' + scheme);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }

  const root = _root(context);

  // orchestray:orchestration://current
  if (segments.length === 1 && segments[0] === 'current') {
    const state = readCurrentOrchestrationState(root);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(state, null, 2),
        },
      ],
    };
  }

  // orchestray:orchestration://current/routing
  if (
    segments.length === 2 &&
    segments[0] === 'current' &&
    segments[1] === 'routing'
  ) {
    const base = root || paths.getProjectRoot();
    const routingPath = path.join(base, '.orchestray', 'state', 'routing.jsonl');
    let text = '';
    try {
      text = fs.readFileSync(routingPath, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        const e = new Error('routing.jsonl read error');
        e.code = 'READ_ERROR';
        throw e;
      }
      // ENOENT: return empty string (file not yet created)
    }
    return {
      contents: [
        { uri, mimeType: 'application/x-ndjson', text },
      ],
    };
  }

  // orchestray:orchestration://current/checkpoints
  if (
    segments.length === 2 &&
    segments[0] === 'current' &&
    segments[1] === 'checkpoints'
  ) {
    const base = root || paths.getProjectRoot();
    const checkpointPath = path.join(base, '.orchestray', 'state', 'mcp-checkpoint.jsonl');
    let text = '';
    try {
      text = fs.readFileSync(checkpointPath, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        const e = new Error('mcp-checkpoint.jsonl read error');
        e.code = 'READ_ERROR';
        throw e;
      }
    }
    return {
      contents: [
        { uri, mimeType: 'application/x-ndjson', text },
      ],
    };
  }

  // orchestray:orchestration://current/tasks/<task_id>
  if (
    segments.length === 3 &&
    segments[0] === 'current' &&
    segments[1] === 'tasks'
  ) {
    const taskId = segments[2];
    // assertSafeSegment already ran in parseResourceUri — safe to use directly.
    const base = root || paths.getProjectRoot();
    const tasksDir = path.join(base, '.orchestray', 'state', 'tasks');
    const tasksDirAbs = path.resolve(tasksDir);
    const taskFile = path.resolve(path.join(tasksDir, taskId + '.md'));

    // Belt-and-braces containment check
    if (
      taskFile !== tasksDirAbs &&
      !taskFile.startsWith(tasksDirAbs + path.sep)
    ) {
      const e = new Error('task_id escapes tasks root');
      e.code = 'PATH_TRAVERSAL';
      throw e;
    }

    let text;
    try {
      text = fs.readFileSync(taskFile, 'utf8');
    } catch (err) {
      const e = new Error('task file not found: ' + taskId);
      e.code = err && err.code === 'ENOENT' ? 'RESOURCE_NOT_FOUND' : 'READ_ERROR';
      throw e;
    }

    return {
      contents: [
        { uri, mimeType: 'text/markdown', text },
      ],
    };
  }

  // orchestray:orchestration://{orch-id} — historical archived orchestration.
  if (segments.length === 1) {
    const orchId = segments[0];

    // Path-traversal guard: validate orch-id format before any filesystem access.
    if (!isValidOrchId(orchId)) {
      const e = new Error('invalid orch-id format: ' + orchId);
      e.code = 'RESOURCE_NOT_FOUND';
      throw e;
    }

    const base = root || paths.getProjectRoot();
    const historyBase = path.join(base, '.orchestray', 'history');
    const historyDirAbs = path.resolve(historyBase);
    const orchDir = path.resolve(path.join(historyBase, orchId));

    if (orchDir !== historyDirAbs && !orchDir.startsWith(historyDirAbs + path.sep)) {
      const e = new Error('orch-id escapes history root');
      e.code = 'RESOURCE_NOT_FOUND';
      throw e;
    }

    // Check that the directory exists.
    try {
      const stat = fs.statSync(orchDir);
      if (!stat.isDirectory()) {
        const e2 = new Error('orchestration not found: ' + orchId);
        e2.code = 'RESOURCE_NOT_FOUND';
        throw e2;
      }
    } catch (err) {
      if (err && err.code === 'RESOURCE_NOT_FOUND') throw err;
      const e = new Error('orchestration not found: ' + orchId);
      e.code = 'RESOURCE_NOT_FOUND';
      throw e;
    }

    const summary = readHistoricalOrchestration(orchDir, orchId);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }

  const e = new Error('unknown orchestration sub-path: ' + segments.join('/'));
  e.code = 'RESOURCE_NOT_FOUND';
  throw e;
}

module.exports = {
  list,
  templates,
  read,
};
