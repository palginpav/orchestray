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

function _kbDir(context) {
  if (context && context.projectRoot) {
    return path.join(context.projectRoot, '.orchestray', 'kb');
  }
  return paths.getKbDir();
}

async function list(context) {
  let dir;
  try {
    dir = _kbDir(context);
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

async function read(uri, context) {
  const { scheme, segments } = paths.parseResourceUri(uri);
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
  if (!SECTIONS.includes(section)) {
    const e = new Error('unknown kb section: ' + section);
    e.code = 'RESOURCE_NOT_FOUND';
    throw e;
  }

  let filepath;
  if (context && context.projectRoot) {
    paths.assertSafeSegment(slug);
    const dir = path.join(context.projectRoot, '.orchestray', 'kb');
    const rootAbs = path.resolve(dir);
    const resolved = path.resolve(path.join(dir, section, slug + '.md'));
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
      const e = new Error('path escapes kb root');
      e.code = 'PATH_TRAVERSAL';
      throw e;
    }
    if (!fs.existsSync(resolved)) {
      const e = new Error('kb entry not found: ' + section + '/' + slug);
      e.code = 'RESOURCE_NOT_FOUND';
      throw e;
    }
    filepath = resolved;
  } else {
    filepath = paths.resolveKbFile(section, slug);
  }

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
