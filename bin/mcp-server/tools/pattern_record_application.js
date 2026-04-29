'use strict';

/**
 * `pattern_record_application` MCP tool.
 *
 * Increments `times_applied` and updates `last_applied` on a pattern file.
 * See CHANGELOG.md §2.0.11 (Stage 2 MCP tools & resources) for design context.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { checkLimit, recordSuccess } = require('../lib/tool-counts');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

const OUTCOMES = ['applied', 'applied-success', 'applied-failure'];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['slug', 'orchestration_id', 'outcome'],
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 200 },
    orchestration_id: { type: 'string', minLength: 1, maxLength: 64 },
    // task_id is optional but enables W6 per-task rate-limit enforcement
    // when both orchestration_id and task_id are present.
    task_id: { type: 'string', minLength: 1, maxLength: 64 },
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
  emitHandlerEntry('pattern_record_application', context);
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_record_application: ' + validation.errors.join('; '));
  }

  // W6 (v2.0.16): per-(orchestration_id, task_id) rate-limit pre-check.
  // checkLimit is read-only — does NOT increment the counter.
  // recordSuccess is called only after the pattern file is successfully written.
  // Only enforced when task_id is present alongside orchestration_id.
  const orchId = input.orchestration_id;
  const taskId = (input && typeof input.task_id === 'string') ? input.task_id : null;
  const _projectRoot = (context && context.projectRoot) || null;
  const _config = (context && context.config) || null;
  if (orchId && taskId && _projectRoot) {
    const limitResult = checkLimit(
      { orchestration_id: orchId, task_id: taskId, tool_name: 'pattern_record_application' },
      _projectRoot,
      _config
    );
    if (limitResult.exceeded) {
      return toolError(
        'pattern_record_application: max_per_task rate limit exceeded for task "' + taskId +
        '" (' + limitResult.count + '/' + limitResult.maxAllowed + ' calls used)'
      );
    }
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

  // W6 (F06): record successful call only after pattern file write succeeds.
  if (orchId && taskId && _projectRoot) {
    recordSuccess(
      { orchestration_id: orchId, task_id: taskId, tool_name: 'pattern_record_application' },
      _projectRoot,
      _config
    );
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

module.exports = {
  definition,
  handle,
};
