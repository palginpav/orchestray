'use strict';

/**
 * `pattern_record_application` MCP tool.
 *
 * Increments `times_applied` and updates `last_applied` on a pattern file.
 * Per v2011b-architecture.md §3.2.2 and v2011c-stage2-plan.md §4/§6.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');

const OUTCOMES = ['applied', 'applied-success', 'applied-failure'];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['slug', 'orchestration_id', 'outcome'],
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 200 },
    orchestration_id: { type: 'string', minLength: 1, maxLength: 64 },
    outcome: { type: 'string', enum: OUTCOMES },
    note: { type: 'string', maxLength: 500 },
  },
};

const definition = deepFreeze({
  name: 'pattern_record_application',
  description:
    'Record that a pattern was applied in an orchestration. Increments ' +
    'times_applied and updates last_applied. Call once per pattern after ' +
    'the decomposition that used it completes.',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_record_application: ' + validation.errors.join('; '));
  }

  const slug = input.slug;

  // Resolve patterns directory. Prefer context-injected projectRoot
  // (fixture strategy) so tests don't need to chdir into a tmpdir.
  let patternsDir;
  try {
    if (context && context.projectRoot) {
      patternsDir = path.join(context.projectRoot, '.orchestray', 'patterns');
    } else {
      patternsDir = paths.getPatternsDir();
    }
  } catch (err) {
    return toolError('pattern_record_application: no project root');
  }

  // Validate slug for safe segment (covers "..", "/", null byte, etc.).
  try {
    paths.assertSafeSegment(slug);
  } catch (err) {
    return toolError('pattern_record_application: unsafe slug: ' + (err && err.message));
  }

  const patternFile = path.join(patternsDir, slug + '.md');
  // Belt-and-braces containment check against the patterns root.
  const resolved = path.resolve(patternFile);
  const rootAbs = path.resolve(patternsDir);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    return toolError('pattern_record_application: slug escapes patterns root');
  }
  if (!fs.existsSync(resolved)) {
    return toolError('pattern not found: ' + slug);
  }

  // Read current times_applied so we can increment it (rewriteField
  // overwrites blindly; it does not understand increments).
  let content;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    return toolError('pattern_record_application: read failed: ' + (err && err.message));
  }
  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) {
    return toolError('pattern_record_application: malformed frontmatter in ' + slug);
  }

  const currentCount = _toInt(parsed.frontmatter.times_applied, 0);
  const newCount = currentCount + 1;
  const nowIso = new Date().toISOString();

  // Single read-modify-write: update both fields atomically in one pass so
  // a concurrent call cannot interleave between two separate rewriteField
  // calls and silently lose the times_applied increment (TOCTOU fix).
  const nextFm = Object.assign({}, parsed.frontmatter, {
    times_applied: newCount,
    last_applied: nowIso,
  });
  const nextContent = frontmatter.stringify({ frontmatter: nextFm, body: parsed.body });
  const tmp = resolved + '.tmp';
  try {
    fs.writeFileSync(tmp, nextContent, 'utf8');
    fs.renameSync(tmp, resolved);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    return toolError('pattern_record_application: write failed (' + (err && err.code ? err.code : 'write_failed') + ')');
  }

  return toolSuccess({
    slug,
    times_applied: newCount,
    last_applied: nowIso,
  });
}

function _toInt(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

function toolSuccess(structuredContent) {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toolError(text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
  };
}

module.exports = {
  definition,
  handle,
};
