'use strict';

/**
 * `orchestray:pattern://` resource handler.
 *
 * Per v2011b-architecture.md §3.3 and v2011c-stage2-plan.md §9.
 *
 * Exports:
 *   async list(context)
 *   async templates(context)
 *   async read(uri, context)
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');

function _root(context) {
  return (context && context.projectRoot) || null;
}

async function list(context) {
  let dir;
  try {
    dir = paths.getPatternsDir(_root(context));
  } catch (_e) {
    return { resources: [] };
  }
  if (!fs.existsSync(dir)) return { resources: [] };

  let entries;
  try {
    entries = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch (_e) {
    return { resources: [] };
  }

  const rows = [];
  for (const name of entries) {
    const slug = name.slice(0, -3);
    const filepath = path.join(dir, name);
    let content;
    try {
      content = fs.readFileSync(filepath, 'utf8');
    } catch (_e) {
      continue;
    }
    const parsed = frontmatter.parse(content);
    if (!parsed.hasFrontmatter) {
      try { process.stderr.write('[orchestray-mcp] pattern_resource.list: skip (no frontmatter) ' + name + '\n'); } catch (_e2) {}
      continue;
    }
    const fm = parsed.frontmatter;
    const name2 = (typeof fm.name === 'string' && fm.name) || slug;
    const description = (typeof fm.description === 'string' && fm.description) || _firstLine(parsed.body) || '';
    const conf = _toNum(fm.confidence, 0.5);
    const times = _toInt(fm.times_applied, 0);
    const lastApplied = typeof fm.last_applied === 'string' ? fm.last_applied : '';
    rows.push({
      uri: 'orchestray:pattern://' + slug,
      name: name2,
      description,
      mimeType: 'text/markdown',
      _sortKey: [conf * times, lastApplied, slug],
    });
  }

  rows.sort((a, b) => {
    if (b._sortKey[0] !== a._sortKey[0]) return b._sortKey[0] - a._sortKey[0];
    if (a._sortKey[1] !== b._sortKey[1]) {
      return a._sortKey[1] < b._sortKey[1] ? 1 : -1; // last_applied desc
    }
    if (a._sortKey[2] < b._sortKey[2]) return -1;
    if (a._sortKey[2] > b._sortKey[2]) return 1;
    return 0;
  });

  return {
    resources: rows.map((r) => {
      const { _sortKey, ...rest } = r;
      return rest;
    }),
  };
}

async function templates(_context) {
  return {
    resourceTemplates: [
      {
        uriTemplate: 'orchestray:pattern://{slug}',
        name: 'Pattern',
        description: 'Orchestration pattern stored under .orchestray/patterns/',
        mimeType: 'text/markdown',
      },
    ],
  };
}

async function read(uri, context, parsed) {
  // B6: accept pre-parsed URI from server.js dispatch to avoid re-running
  // parseResourceUri() on every read (the server already parsed it once
  // during scheme routing). Fallback to a fresh parse when called directly
  // by a test with no parsed tuple supplied.
  const { scheme, segments } = parsed || paths.parseResourceUri(uri);
  if (scheme !== 'pattern') {
    const e = new Error('pattern_resource.read: wrong scheme ' + scheme);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  if (segments.length !== 1) {
    const e = new Error('pattern URI must have exactly one segment (slug)');
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
  // B3: single delegation to paths.resolvePatternFile, which now accepts an
  // optional root override. Tests that inject context.projectRoot get the
  // fixture behavior; production uses the walk-up.
  const filepath = paths.resolvePatternFile(segments[0], _root(context));

  const text = fs.readFileSync(filepath, 'utf8');
  return {
    contents: [
      { uri, mimeType: 'text/markdown', text },
    ],
  };
}

function _firstLine(s) {
  if (typeof s !== 'string') return '';
  const i = s.indexOf('\n');
  const line = i === -1 ? s : s.slice(0, i);
  return line.trim();
}

function _toNum(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function _toInt(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

module.exports = {
  list,
  templates,
  read,
};
