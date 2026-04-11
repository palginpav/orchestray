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

function _root(context) {
  return (context && context.projectRoot) || null;
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
    dir = paths.getHistoryDir(_root(context));
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

  const totalCount = dirs.length;
  const top = dirs.slice(0, 20);
  for (const d of top) {
    resources.push({
      uri: 'orchestray:history://orch/' + d,
      name: d,
      description: 'Archived orchestration ' + d,
      mimeType: 'application/x-ndjson',
    });
  }

  return { resources, _truncated: totalCount > 20, _totalCount: totalCount };
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

async function read(uri, context, parsed) {
  // B6: accept pre-parsed URI from server.js dispatch.
  const { scheme, segments } = parsed || paths.parseResourceUri(uri);
  if (scheme !== 'history') {
    const e = new Error('history_resource.read: wrong scheme ' + scheme);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  const root = _root(context);

  // audit/live — read the live events.jsonl via the parametrized helper.
  if (segments.length === 2 && segments[0] === 'audit' && segments[1] === 'live') {
    const f = paths.getAuditEventsPathIn(root);
    // Remove existsSync + readFileSync TOCTOU: wrap the read in try/catch so
    // a file deleted between check and read maps to RESOURCE_NOT_FOUND, not
    // JSONRPC_INTERNAL_ERROR (M2 fix).
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (err) {
      const e = new Error('live audit events.jsonl not found');
      e.code = err.code === 'ENOENT' ? 'RESOURCE_NOT_FOUND' : 'READ_ERROR';
      throw e;
    }
    return {
      contents: [
        { uri, mimeType: 'application/x-ndjson', text },
      ],
    };
  }

  // orch/<id>[/...] — delegate to paths.resolveHistoryArchive /
  // resolveHistoryTaskFile for a single traversal-guard chokepoint (B3).
  if (segments.length >= 2 && segments[0] === 'orch') {
    const orchId = segments[1];
    const archiveDir = paths.resolveHistoryArchive(orchId, root);

    if (segments.length === 2) {
      const f = path.join(archiveDir, 'events.jsonl');
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch (err) {
        const e = new Error('archive events.jsonl not found');
        e.code = err.code === 'ENOENT' ? 'RESOURCE_NOT_FOUND' : 'READ_ERROR';
        throw e;
      }
      return {
        contents: [
          { uri, mimeType: 'application/x-ndjson', text },
        ],
      };
    }

    if (segments.length === 3 && segments[2] === 'summary') {
      const f = path.join(archiveDir, 'orchestration.md');
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch (err) {
        const e = new Error('orchestration summary not found: ' + orchId);
        e.code = err.code === 'ENOENT' ? 'RESOURCE_NOT_FOUND' : 'READ_ERROR';
        throw e;
      }
      return {
        contents: [
          { uri, mimeType: 'text/markdown', text },
        ],
      };
    }

    if (segments.length === 4 && segments[2] === 'tasks') {
      const f = paths.resolveHistoryTaskFile(orchId, segments[3], root);
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch (err) {
        const e = new Error('task file not found: ' + segments[3]);
        e.code = err.code === 'ENOENT' ? 'RESOURCE_NOT_FOUND' : 'READ_ERROR';
        throw e;
      }
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
