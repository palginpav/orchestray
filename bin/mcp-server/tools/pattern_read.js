'use strict';

/**
 * `pattern_read` MCP tool (R-CAT v2.1.14).
 *
 * Returns the full body and metadata for a single pattern by slug.
 * This is the JIT counterpart to `pattern_find?mode=catalog`: agents browse the
 * compact catalog, then call pattern_read only for matches that look promising.
 *
 * Input:  { slug: string }
 * Output: { slug, confidence, full_body, applications, applications_count }
 *   or    { not_found: true, slug } on missing slug.
 *
 * Auth/permission gating: follows the same isToolEnabled path in server.js
 * as all other tools; no additional enforcement needed.
 *
 * Audit: writes an mcp_tool_call event to the audit log (via writeAuditEvent)
 * so the zero-read audit script (bin/audit-zero-read-patterns.js) can compute
 * which catalog-returned slugs were never fetched.
 */

const fs   = require('node:fs');
const path = require('node:path');

const paths       = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError }            = require('../lib/tool-result');
const { logStderr }                         = require('../lib/rpc');
const { writeAuditEvent, readOrchestrationId } = require('../lib/audit');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

const INPUT_SCHEMA = {
  type: 'object',
  required: ['slug'],
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 200 },
  },
};

const definition = deepFreeze({
  name: 'pattern_read',
  description:
    'Return the full body and metadata for a single pattern by slug. ' +
    'Use after pattern_find(mode="catalog") to fetch only the patterns ' +
    'that look promising — JIT retrieval avoids loading every body up front.',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, context) {
  emitHandlerEntry('pattern_read', context);
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_read: ' + validation.errors.join('; '));
  }

  const slug = input.slug;

  // Resolve the patterns directory. Context may inject projectRoot for tests.
  let patternsDir;
  let projectRoot;
  try {
    if (context && context.projectRoot) {
      projectRoot = context.projectRoot;
      patternsDir = path.join(projectRoot, '.orchestray', 'patterns');
    } else {
      patternsDir = paths.getPatternsDir();
      projectRoot = process.cwd();
    }
  } catch (_err) {
    return toolSuccess({ not_found: true, slug });
  }

  const filepath = path.join(patternsDir, slug + '.md');

  // Emit audit event so zero-read audit can track which slugs are fetched.
  // Fail-open: audit failure must not block the tool result.
  try {
    writeAuditEvent({
      timestamp: new Date().toISOString(),
      type: 'pattern_read',
      tool: 'pattern_read',
      slug,
      orchestration_id: readOrchestrationId(),
    });
  } catch (_e) { /* non-fatal */ }

  let content;
  try {
    content = fs.readFileSync(filepath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Pattern not found — return structured not-found instead of throwing.
      return toolSuccess({ not_found: true, slug });
    }
    logStderr('pattern_read: read failed for slug=' + slug + ': ' + (err && err.message));
    return toolError('pattern_read: could not read pattern file for slug "' + slug + '"');
  }

  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) {
    logStderr('pattern_read: no frontmatter for slug=' + slug);
    return toolError('pattern_read: pattern file for slug "' + slug + '" has no frontmatter');
  }

  const fm = parsed.frontmatter;

  // Resolve confidence (mirrors pattern_find._numericConfidence).
  let confidence = fm.confidence;
  if (typeof confidence === 'string') {
    const map = { low: 0.3, medium: 0.6, high: 0.9 };
    confidence = (confidence in map) ? map[confidence] : (Number(confidence) || 0.5);
  } else if (typeof confidence !== 'number') {
    confidence = 0.5;
  }

  // times_applied / applications alias.
  const timesApplied =
    typeof fm.times_applied === 'number' ? fm.times_applied :
    typeof fm.times_applied === 'string' ? (parseInt(fm.times_applied, 10) || 0) : 0;

  return toolSuccess({
    slug,
    confidence,
    context_hook: (typeof fm.context_hook === 'string' && fm.context_hook.length >= 5)
      ? fm.context_hook : null,
    full_body: content,
    applications: timesApplied,
    applications_count: timesApplied,
  });
}

module.exports = {
  definition,
  handle,
};
