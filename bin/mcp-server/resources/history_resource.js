'use strict';

/**
 * `orchestray:history://` resource handler.
 *
 * Per v2011b-architecture.md §3.3 and v2011c-stage2-plan.md §9.
 *
 * Supported URI shapes:
 *   orchestray:history://audit/live
 *   orchestray:history://orch/<orch_id>
 *   orchestray:history://orch/<orch_id>/summary
 *   orchestray:history://orch/<orch_id>/tasks/<task_id>
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');

function _historyDir(context) {
  if (context && context.projectRoot) {
    return path.join(context.projectRoot, '.orchestray', 'history');
  }
  return paths.getHistoryDir();
}

function _auditFile(context) {
  if (context && context.projectRoot) {
    return path.join(context.projectRoot, '.orchestray', 'audit', 'events.jsonl');
  }
  return paths.getAuditEventsPath();
}

async function list(context) {
  const resources = [
    {
      uri: 'orchestray:history://audit/live',
      name: 'Live audit events',
      description: "Current session's .orchestray/audit/events.jsonl",
      mimeType: 'application/x-ndjson',
    },
  ];

  let dir;
  try {
    dir = _historyDir(context);
  } catch (_e) {
    return { resources };
  }
  if (!fs.existsSync(dir)) return { resources };

  let dirs;
  try {
    dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse(); // name desc
  } catch (_e) {
    return { resources };
  }

  const top = dirs.slice(0, 20);
  for (const d of top) {
    resources.push({
      uri: 'orchestray:history://orch/' + d,
      name: d,
      description: 'Archived orchestration ' + d,
      mimeType: 'application/x-ndjson',
    });
  }

  return { resources };
}

async function templates(_context) {
  return {
    resourceTemplates: [
      {
        uriTemplate: 'orchestray:history://orch/{orch_id}/summary',
        name: 'Orchestration summary',
        description: 'Markdown summary for an archived orchestration',
        mimeType: 'text/markdown',
      },
      {
        uriTemplate: 'orchestray:history://orch/{orch_id}/tasks/{task_id}',
        name: 'Archived task file',
        description: 'Markdown task file for an archived task',
        mimeType: 'text/markdown',
      },
    ],
  };
}

async function read(uri, context) {
  const { scheme, segments } = paths.parseResourceUri(uri);
  if (scheme !== 'history') {
    const e = new Error('history_resource.read: wrong scheme ' + scheme);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }

  // audit/live
  if (segments.length === 2 && segments[0] === 'audit' && segments[1] === 'live') {
    const f = _auditFile(context);
    if (!fs.existsSync(f)) {
      const e = new Error('live audit events.jsonl not found');
      e.code = 'RESOURCE_NOT_FOUND';
      throw e;
    }
    const text = fs.readFileSync(f, 'utf8');
    return {
      contents: [
        { uri, mimeType: 'application/x-ndjson', text },
      ],
    };
  }

  // orch/<id>
  if (segments.length >= 2 && segments[0] === 'orch') {
    const orchId = segments[1];
    paths.assertSafeSegment(orchId);
    const dir = _historyDir(context);
    const archiveDir = path.resolve(path.join(dir, orchId));
    const rootAbs = path.resolve(dir);
    if (archiveDir !== rootAbs && !archiveDir.startsWith(rootAbs + path.sep)) {
      const e = new Error('path escapes history root');
      e.code = 'PATH_TRAVERSAL';
      throw e;
    }
    if (!fs.existsSync(archiveDir)) {
      const e = new Error('history archive not found: ' + orchId);
      e.code = 'RESOURCE_NOT_FOUND';
      throw e;
    }

    if (segments.length === 2) {
      // orch/<id> — return events.jsonl
      const f = path.join(archiveDir, 'events.jsonl');
      if (!fs.existsSync(f)) {
        const e = new Error('archive events.jsonl not found');
        e.code = 'RESOURCE_NOT_FOUND';
        throw e;
      }
      const text = fs.readFileSync(f, 'utf8');
      return {
        contents: [
          { uri, mimeType: 'application/x-ndjson', text },
        ],
      };
    }

    if (segments.length === 3 && segments[2] === 'summary') {
      const f = path.join(archiveDir, 'orchestration.md');
      if (!fs.existsSync(f)) {
        const e = new Error('orchestration summary not found: ' + orchId);
        e.code = 'RESOURCE_NOT_FOUND';
        throw e;
      }
      const text = fs.readFileSync(f, 'utf8');
      return {
        contents: [
          { uri, mimeType: 'text/markdown', text },
        ],
      };
    }

    if (segments.length === 4 && segments[2] === 'tasks') {
      const taskId = segments[3];
      paths.assertSafeSegment(taskId);
      const f = path.resolve(path.join(archiveDir, 'tasks', taskId + '.md'));
      if (!f.startsWith(archiveDir + path.sep)) {
        const e = new Error('path escapes archive');
        e.code = 'PATH_TRAVERSAL';
        throw e;
      }
      if (!fs.existsSync(f)) {
        const e = new Error('task file not found: ' + orchId + '/' + taskId);
        e.code = 'RESOURCE_NOT_FOUND';
        throw e;
      }
      const text = fs.readFileSync(f, 'utf8');
      return {
        contents: [
          { uri, mimeType: 'text/markdown', text },
        ],
      };
    }
  }

  const e = new Error('unknown history sub-path: ' + segments.join('/'));
  e.code = 'RESOURCE_NOT_FOUND';
  throw e;
}

module.exports = {
  list,
  templates,
  read,
};
