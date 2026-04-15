'use strict';

/**
 * `pattern_deprecate` MCP tool.
 *
 * Marks a pattern file as deprecated by setting frontmatter fields:
 *   deprecated: true
 *   deprecated_at: <ISO timestamp>
 *   deprecated_reason: <reason>
 *   deprecated_note: <optional free-text note>
 *
 * Atomic write: read → modify frontmatter in-memory → write via rename-dance.
 * Emits a `pattern_deprecated` audit event on success.
 *
 * Pattern search: patterns are looked up under .orchestray/patterns/ first,
 * then .orchestray/team-patterns/. PATTERN_NOT_FOUND is returned when not found
 * in either location.
 *
 * Per v2016-release-plan.md §W7 / D1 (deferred).
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { writeAuditEvent } = require('../lib/audit');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEPRECATION_REASON_ENUM = ['low-confidence', 'superseded', 'user-rejected', 'other'];

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['pattern_name', 'reason'],
  properties: {
    pattern_name: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Filename stem of the pattern (without .md extension) under .orchestray/patterns/ or .orchestray/team-patterns/.',
    },
    reason: {
      type: 'string',
      enum: DEPRECATION_REASON_ENUM,
      description: 'Reason for deprecation. "other" requires a "note".',
    },
    note: {
      type: 'string',
      maxLength: 500,
      description: 'Optional free-text note. Required when reason is "other".',
    },
  },
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const definition = deepFreeze({
  name: 'pattern_deprecate',
  description:
    'Mark a pattern as deprecated. Sets deprecated: true, deprecated_at, ' +
    'deprecated_reason, and optional deprecated_note in the pattern frontmatter. ' +
    'Idempotent: re-deprecating an already-deprecated pattern updates the fields. ' +
    'After deprecation, pattern_find will exclude the pattern from its results.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a pattern file, searching both patterns
 * directories. Returns { patternFile, patternsDir } on success, or null when
 * not found in either location.
 *
 * @param {string} patternName - The filename stem (no .md)
 * @param {string|null} projectRoot - Optional project root override (for tests)
 * @returns {{ patternFile: string, patternsDir: string } | null}
 */
function resolvePatternFile(patternName, projectRoot) {
  const candidateDirs = [];

  if (projectRoot) {
    candidateDirs.push(
      path.join(projectRoot, '.orchestray', 'patterns'),
      path.join(projectRoot, '.orchestray', 'team-patterns')
    );
  } else {
    try {
      candidateDirs.push(paths.getPatternsDir());
    } catch (_e) {
      // No project root — no patterns found.
      return null;
    }
    // team-patterns is a sibling of patterns
    try {
      const root = paths.getProjectRoot();
      candidateDirs.push(path.join(root, '.orchestray', 'team-patterns'));
    } catch (_e) {
      // Ignore — team-patterns is optional.
    }
  }

  for (const dir of candidateDirs) {
    const candidate = path.join(dir, patternName + '.md');
    // Belt-and-braces containment check before stat
    const resolved = path.resolve(candidate);
    const rootAbs = path.resolve(dir);
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
      // Traversal: skip (caller already validated but be safe)
      continue;
    }
    try {
      fs.accessSync(resolved, fs.constants.F_OK);
      return { patternFile: resolved, patternsDir: dir };
    } catch (_e) {
      // Not in this directory — try next
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_deprecate: ' + validation.errors.join('; '));
  }

  // "other" requires a note.
  if (input.reason === 'other' && (!input.note || !input.note.trim())) {
    return toolError('pattern_deprecate: reason "other" requires a non-empty "note"');
  }

  const patternName = input.pattern_name;

  // Validate the pattern name for safe segment (no "..", "/", null bytes, etc.)
  try {
    paths.assertSafeSegment(patternName);
  } catch (err) {
    return toolError('pattern_deprecate: unsafe pattern_name: ' + (err && err.message));
  }

  const projectRoot = (context && context.projectRoot) || null;

  // Resolve the pattern file (search patterns/ then team-patterns/)
  const resolved = resolvePatternFile(patternName, projectRoot);
  if (!resolved) {
    return toolError('PATTERN_NOT_FOUND: pattern "' + patternName + '" not found in patterns or team-patterns directories');
  }

  const { patternFile } = resolved;

  // Read current content
  let content;
  try {
    content = fs.readFileSync(patternFile, 'utf8');
  } catch (err) {
    return toolError('pattern_deprecate: read failed: ' + (err && err.message));
  }

  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) {
    return toolError('pattern_deprecate: malformed frontmatter in ' + patternName);
  }

  const nowIso = new Date().toISOString();

  // Merge deprecation fields into frontmatter (idempotent — overwrites if already deprecated)
  const nextFm = Object.assign({}, parsed.frontmatter, {
    deprecated: true,
    deprecated_at: nowIso,
    deprecated_reason: input.reason,
  });

  if (input.note && input.note.trim()) {
    nextFm.deprecated_note = input.note.trim();
  } else {
    // Remove any stale note from a prior deprecation (clean re-deprecate)
    delete nextFm.deprecated_note;
  }

  // Atomic write: write to .tmp then rename (same pattern as pattern_record_application)
  const nextContent = frontmatter.stringify({ frontmatter: nextFm, body: parsed.body });
  const tmp = patternFile + '.tmp';
  try {
    fs.writeFileSync(tmp, nextContent, 'utf8');
    fs.renameSync(tmp, patternFile);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    return toolError(
      'pattern_deprecate: write failed (' +
      (err && err.code ? err.code : 'write_failed') + ')'
    );
  }

  // Emit audit event
  try {
    const orchId =
      (context && context.orchestration_id) ||
      require('../lib/audit').readOrchestrationId();
    writeAuditEvent({
      timestamp: new Date().toISOString(),
      type: 'pattern_deprecated',
      orchestration_id: orchId,
      pattern_name: patternName,
      reason: input.reason,
      note: input.note || null,
    });
  } catch (_e) {
    // Audit failure must not block the response — fail-open.
  }

  return toolSuccess({
    pattern_name: patternName,
    deprecated: true,
    deprecated_at: nowIso,
    deprecated_reason: input.reason,
    deprecated_note: (input.note && input.note.trim()) ? input.note.trim() : null,
  });
}

module.exports = {
  definition,
  handle,
};
