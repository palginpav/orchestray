'use strict';

/**
 * `history_find_similar_tasks` MCP tool.
 *
 * Walks `.orchestray/history/*\/tasks/*.md`, computes case-folded token
 * Jaccard between the input `task_summary` and each task file's
 * (title + first 200 body chars), and returns the top matches.
 *
 * See CHANGELOG.md §2.0.11 (Stage 2 MCP tools & resources) for design context.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const { assertSafeSegment } = paths;
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { logStderr } = require('../lib/rpc');

const INPUT_SCHEMA = {
  type: 'object',
  required: ['task_summary'],
  properties: {
    task_summary: { type: 'string', minLength: 3, maxLength: 1000 },
    limit: { type: 'integer', minimum: 1, maximum: 10 },
    min_similarity: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const definition = deepFreeze({
  name: 'history_find_similar_tasks',
  description:
    'Find prior tasks similar to a new task description. Use during ' +
    'decomposition to surface prior art before deciding on a plan. ' +
    'Similarity is case-folded token Jaccard (title + first 200 body chars).',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('history_find_similar_tasks: ' + validation.errors.join('; '));
  }

  const limit = typeof input.limit === 'number' ? input.limit : 5;
  const minSimilarity = typeof input.min_similarity === 'number' ? input.min_similarity : 0.2;

  // Resolve history directory. Context override wins.
  let historyDir;
  try {
    if (context && context.projectRoot) {
      historyDir = path.join(context.projectRoot, '.orchestray', 'history');
    } else {
      historyDir = paths.getHistoryDir();
    }
  } catch (err) {
    return toolSuccess({ matches: [] });
  }

  if (!fs.existsSync(historyDir)) {
    return toolSuccess({ matches: [] });
  }

  const queryTokens = _tokenize(input.task_summary);
  const candidates = [];

  let archiveDirs;
  try {
    // T3 C3: sort archive dirs for deterministic processing order. Archive
    // directory names are ISO timestamps and sort lexicographically (= chronologically),
    // matching the precedent set in history_scan.js:173.
    archiveDirs = fs.readdirSync(historyDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    return toolError('history_find_similar_tasks: readdir failed: ' + (err && err.message));
  }

  for (const orchId of archiveDirs) {
    try { assertSafeSegment(orchId); } catch (_e) { continue; }
    const tasksDir = path.join(historyDir, orchId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    let taskFiles;
    try {
      taskFiles = fs.readdirSync(tasksDir).filter((n) => n.endsWith('.md'));
    } catch (err) {
      logStderr('history_find_similar_tasks: readdir failed ' + tasksDir);
      continue;
    }
    for (const name of taskFiles) {
      const taskId = name.slice(0, -3);
      try { assertSafeSegment(taskId); } catch (_e) { continue; }
      const filepath = path.join(tasksDir, name);
      let content;
      try {
        content = fs.readFileSync(filepath, 'utf8');
      } catch (err) {
        continue;
      }
      const title = _extractH1(content);
      if (!title) {
        logStderr('history_find_similar_tasks: no title in ' + filepath);
        continue;
      }
      const bodyAfterTitle = _bodyAfterH1(content);
      const sample = title + ' ' + bodyAfterTitle.slice(0, 200);
      const sampleTokens = _tokenize(sample);
      const similarity = _jaccard(queryTokens, sampleTokens);
      candidates.push({
        orch_id: orchId,
        task_id: taskId,
        similarity,
        outcome: null,
        patterns_applied: [],
        ref: 'orchestray:history://orch/' + orchId + '/tasks/' + taskId,
      });
    }
  }

  const filtered = candidates
    .filter((m) => m.similarity >= minSimilarity)
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      if (a.orch_id < b.orch_id) return -1;
      if (a.orch_id > b.orch_id) return 1;
      if (a.task_id < b.task_id) return -1;
      if (a.task_id > b.task_id) return 1;
      return 0;
    })
    .slice(0, limit);

  return toolSuccess({ matches: filtered });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _extractH1(content) {
  if (typeof content !== 'string') return null;
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * Return all content after the first H1 heading line.
 * Skips frontmatter and any lines before the first `# Title` so that
 * frontmatter key-value noise does not pollute similarity token extraction.
 * If no H1 is found, returns an empty string.
 */
function _bodyAfterH1(content) {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) {
      return lines.slice(i + 1).join('\n');
    }
  }
  return '';
}

function _tokenize(text) {
  if (typeof text !== 'string') return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3)
  );
}

function _jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const x of a) if (b.has(x)) overlap++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : overlap / union;
}

module.exports = {
  definition,
  handle,
};
