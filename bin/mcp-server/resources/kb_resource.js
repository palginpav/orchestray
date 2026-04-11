'use strict';

/**
 * `orchestray:kb://` resource handler.
 *
 * Per v2011b-architecture.md §3.3 and v2011c-stage2-plan.md §9.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');

const SECTIONS = ['artifacts', 'facts', 'decisions'];
const LIST_CAP = 100;

function _root(context) {
  return (context && context.projectRoot) || null;
}

async function list(context) {
  let dir;
  try {
    dir = paths.getKbDir(_root(context));
  } catch (_e) {
    return { resources: [] };
  }
  if (!fs.existsSync(dir)) return { resources: [] };

  const rows = [];
  for (const section of SECTIONS) {
    const sectionDir = path.join(dir, section);
    if (!fs.existsSync(sectionDir)) continue;
    let files;
    try {
      files = fs.readdirSync(sectionDir).filter((n) => n.endsWith('.md'));
    } catch (_e) {
      continue;
    }
    for (const name of files) {
      const slug = name.slice(0, -3);
      const filepath = path.join(sectionDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filepath).mtimeMs;
      } catch (_e) { /* swallow */ }
      rows.push({
        uri: 'orchestray:kb://' + section + '/' + slug,
        name: section + '/' + slug,
        description: '',
        mimeType: 'text/markdown',
        _mtime: mtimeMs,
      });
    }
  }

  rows.sort((a, b) => b._mtime - a._mtime);
  const top = rows.slice(0, LIST_CAP).map((r) => {
    const { _mtime, ...rest } = r;
    return rest;
  });

  return { resources: top };
}

async function templates(_context) {
  return {
    resourceTemplates: [
      {
        uriTemplate: 'orchestray:kb://{section}/{slug}',
        name: 'Knowledge base entry',
        description: 'KB entry from .orchestray/kb/{section}/{slug}.md',
        mimeType: 'text/markdown',
      },
    ],
  };
}

async function read(uri, context, parsed) {
  // B6: accept pre-parsed URI from server.js dispatch (see pattern_resource
  // for the same pattern). Fallback parses when called directly from a test.
  const { scheme, segments } = parsed || paths.parseResourceUri(uri);
  if (scheme !== 'kb') {
    const e = new Error('kb_resource.read: wrong scheme ' + scheme);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }
  if (segments.length !== 2) {
    const e = new Error('kb URI must have section/slug form');
    e.code = 'PATH_TRAVERSAL';
    throw e;
  }
  const [section, slug] = segments;
  // B3: single delegation to paths.resolveKbFile. Tests passing
  // context.projectRoot get the fixture behavior; production walks up.
  // resolveKbFile checks the section-name allow list internally.
  const filepath = paths.resolveKbFile(section, slug, _root(context));

  const text = fs.readFileSync(filepath, 'utf8');
  return {
    contents: [
      { uri, mimeType: 'text/markdown', text },
    ],
  };
}

module.exports = {
  list,
  templates,
  read,
};
