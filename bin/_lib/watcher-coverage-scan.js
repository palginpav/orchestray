'use strict';

/**
 * watcher-coverage-scan.js — meta-test helper for prose-MUST-emit coverage.
 * (v2.2.10 N2)
 *
 * Why this exists
 * ---------------
 * Agent markdown files (agents/pm.md, agents/pm-reference/*.md, agents/<role>.md)
 * contain prose instructions telling the PM or other agents to emit specific
 * audit events.  If those instructions exist in prose but the event_type is NOT
 * backstopped by pm-emit-state-watcher.js (WATCH_TARGETS) or listed in
 * audit-pm-emit-coverage.js (WATCHED_EVENT_TYPES), the emit can silently
 * disappear when the PM deviates.
 *
 * This helper:
 *   1. Accepts an array of file paths (absolute or relative to cwd).
 *   2. Scans each file for the patterns:
 *        MUST emit `<event_type>`
 *        emit `<event_type>`
 *      where <event_type> matches /^[a-z][a-z0-9_]*$/.
 *   3. Returns a Set<string> of all captured event_type slugs.
 *
 * Reusability
 * -----------
 * This module is used by:
 *   - bin/__tests__/v2210-watcher-coverage.test.js  (CI gate)
 *   - bin/audit-firing-nightly.js (F3) can optionally import it too.
 *
 * Usage
 * -----
 *   const { scanForMustEmitPatterns } = require('./_lib/watcher-coverage-scan');
 *   const events = scanForMustEmitPatterns(['/abs/path/to/pm.md', ...]);
 *   // => Set { 'verify_fix_start', 'tier2_invoked', ... }
 */

const fs   = require('node:fs');
const path = require('node:path');

// Matches both:
//   MUST emit `some_event_type`
//   emit `some_event_type`
// The backtick delimiters are required.
const EMIT_PATTERN = /\bemit\s+`([a-z][a-z0-9_]*)`/g;

// ---------------------------------------------------------------------------
// False-positive exclusions
// ---------------------------------------------------------------------------
//
// These slugs appear in "emit `X`" patterns in agent docs but are NOT
// standalone events that the PM or another agent is instructed to emit.
// Each entry carries a comment explaining why it is excluded.
//
const KNOWN_NON_EVENTS = new Set([
  // Structured Result field name listed in agents/architect.md — the sentence
  // says "emit `acceptance_rubric`" meaning "include this field", not an audit event.
  'acceptance_rubric',

  // Structured Result field name listed in agents/architect.md — same pattern
  // as acceptance_rubric; refers to the JSON result field, not an event.
  'assumptions',

  // Described in agents/pm.md prose as an event the hook emits when a blocked
  // file-read is attempted. It is hook-emitted (not a PM prose MUST-emit) and
  // the hook already wires it — no watcher backstop needed.
  'event_schemas_full_load_blocked',

  // Described in agents/pm-reference/handoff-contract.md as a hook-emitted
  // event (the T15 handoff-body hook emits it). Not a PM prose MUST-emit.
  'handoff_body_block',

  // Described in agents/pm-reference/handoff-contract.md alongside
  // handoff_body_block — also hook-emitted by T15. Not a PM prose MUST-emit.
  'handoff_body_warn',

  // Field name inside the `archetype_cache_advisory_served` event payload,
  // as described in agents/pm-reference/phase-decomp.md. The surrounding
  // sentence says to emit `pm_reasoning_brief` AS A FIELD, not a standalone event.
  'pm_reasoning_brief',

  // Appears in agents/pm-reference/event-schemas.md as the schema declaration
  // header for the pre_done_checklist_failed event schema itself, not a prose
  // MUST-emit instruction to the PM.
  'pre_done_checklist_failed',

  // Same as pre_done_checklist_failed — appears in event-schemas.md as a
  // schema declaration header, not a prose MUST-emit.
  'task_completion_warn',
]);

// Files whose "emit `X`" patterns are schema declarations, not prose-emit
// instructions. Scanning these produces only false positives.
// Identified by filename (basename match) so it works regardless of absolute path.
const EXCLUDED_FILE_BASENAMES = new Set([
  'event-schemas.md',  // schema declaration doc — `### \`<event>\` event` headers
]);

// Section heading prefixes that introduce structured-result field listings,
// not prose-emit instructions. When we encounter one of these headings, we
// skip the content until the next same-or-higher-level heading.
const STRUCTURED_RESULT_HEADINGS = [
  '### Structured Result',
  '## Structured Result',
];

/**
 * Strip content inside "Structured Result" sections from a markdown string.
 * These sections list field names (e.g., `emit \`assumptions\``) as output
 * format documentation, not as prose-emit instructions.
 *
 * @param {string} content - raw markdown file content
 * @returns {string} content with Structured Result sections removed
 */
function stripStructuredResultSections(content) {
  const lines = content.split('\n');
  const out   = [];
  let skipping = false;
  let skipLevel = 0; // heading level (2 or 3) that opened the skip block

  for (const line of lines) {
    // Check if this line opens a Structured Result section
    const openHeading = STRUCTURED_RESULT_HEADINGS.find(h => line.trimStart().startsWith(h));
    if (openHeading) {
      skipping   = true;
      skipLevel  = openHeading.startsWith('##') && !openHeading.startsWith('###') ? 2 : 3;
      continue; // don't include the heading itself
    }

    if (skipping) {
      // Stop skipping when we hit a heading at the same or higher level.
      // A heading of level N is "## " (N=2) or "### " (N=3), etc.
      const headingMatch = line.match(/^(#{1,6})\s/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        if (level <= skipLevel) {
          skipping = false;
          out.push(line);
          continue;
        }
      }
      // Still inside Structured Result — skip the line
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * Scan one or more markdown files for `emit \`<event_type>\`` patterns.
 *
 * Exclusions applied:
 *   1. Files in EXCLUDED_FILE_BASENAMES are skipped entirely.
 *   2. Content inside "Structured Result" sections is stripped before scanning.
 *   3. Captured slugs in KNOWN_NON_EVENTS are filtered from the result.
 *
 * @param {string[]} filePaths - absolute or cwd-relative file paths to scan
 * @returns {Set<string>} all event_type slugs found in the files
 */
function scanForMustEmitPatterns(filePaths) {
  const found = new Set();

  for (const filePath of filePaths) {
    // Skip schema declaration files — their "emit `X`" patterns are headers,
    // not prose-emit instructions.
    if (EXCLUDED_FILE_BASENAMES.has(path.basename(filePath))) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_e) {
      // File not readable — skip silently (fail-open for CI)
      continue;
    }

    // Strip Structured Result sections before scanning — those sections list
    // output field names using backtick syntax that the scanner misreads as
    // prose-emit instructions.
    content = stripStructuredResultSections(content);

    // Reset lastIndex before each file scan (global regex is stateful)
    EMIT_PATTERN.lastIndex = 0;

    let match;
    while ((match = EMIT_PATTERN.exec(content)) !== null) {
      const slug = match[1];
      // Skip known false positives (non-event backtick references).
      if (KNOWN_NON_EVENTS.has(slug)) continue;
      found.add(slug);
    }
  }

  return found;
}

/**
 * Convenience: resolve glob-style patterns using node:fs to enumerate
 * a directory.  Accepts an array of paths which may include directories
 * (all *.md files within are scanned) or explicit file paths.
 *
 * This avoids a glob dependency — only node:fs/path are used.
 *
 * @param {string[]} globs - mix of explicit file paths and directory paths
 * @returns {string[]} resolved absolute file paths
 */
function resolveMarkdownPaths(globs) {
  const resolved = [];
  for (const entry of globs) {
    let stat;
    try { stat = fs.statSync(entry); }
    catch (_e) { continue; }

    if (stat.isFile()) {
      resolved.push(entry);
    } else if (stat.isDirectory()) {
      let items;
      try { items = fs.readdirSync(entry); }
      catch (_e) { continue; }
      for (const item of items) {
        if (item.endsWith('.md')) {
          resolved.push(path.join(entry, item));
        }
      }
    }
  }
  return resolved;
}

/**
 * Extract all event_type strings from a WATCH_TARGETS array.
 * Handles both static `eventType` field and dynamic resolvers that may
 * also emit 'verify_fix_fail' alongside 'verify_fix_pass'.
 *
 * @param {object[]} watchTargets - WATCH_TARGETS array from pm-emit-state-watcher.js
 * @returns {Set<string>}
 */
function extractWatcherEventTypes(watchTargets) {
  const types = new Set();
  for (const target of watchTargets) {
    if (typeof target.eventType === 'string') {
      types.add(target.eventType);
    }
    // B1 rule emits both verify_fix_pass and verify_fix_fail dynamically.
    // The buildPayload for task_verify_fix_outcome contains both type strings
    // explicitly — surface them here.
    if (target.id === 'task_verify_fix_outcome') {
      types.add('verify_fix_pass');
      types.add('verify_fix_fail');
    }
  }
  return types;
}

module.exports = {
  scanForMustEmitPatterns,
  resolveMarkdownPaths,
  extractWatcherEventTypes,
};
