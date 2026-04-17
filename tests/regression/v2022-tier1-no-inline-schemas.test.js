#!/usr/bin/env node
'use strict';

/**
 * v2.0.22 regression — tier1-orchestration.md must not contain inline event schemas.
 *
 * Schema-by-reference convention (Section 13, v2.0.22): canonical event schemas live
 * in agents/pm-reference/event-schemas.md and are referenced from tier1 by pointer
 * comment, not duplicated inline.  Inline duplication causes the three-source-of-truth
 * problem that led to R2-I-F2 and the Dynamic Agent Spawn pointer suffix mismatch (F4).
 *
 * Detection heuristic:
 *   A JSON fenced block is "schema-shaped" if it parses successfully AND has > 5
 *   top-level fields.  Five-or-fewer-field blocks are structural (e.g. KB index
 *   skeleton, config examples) and are permitted inline.
 *
 * Allowlist (types that legitimately remain in tier1):
 *   - verify_fix_start / verify_fix_pass / verify_fix_fail / verify_fix_oscillation
 *     (verify_fix_* family) — tightly coupled to the verify-fix loop control flow in
 *     Section 18; not pure schema definitions.
 *   - escalation — likewise control-flow adjacent.
 *   - threshold_signal — calibration signal, not an audit event.
 *   - pattern_applied — pattern-record protocol inline example.
 *
 * Note: orchestration_start, orchestration_complete, replan, dynamic_agent_spawn,
 * dynamic_agent_cleanup are NOT in the allowlist.  VW4 moves those to event-schemas.md.
 * Until VW4 lands, those blocks will cause this test to fail — that is the intended
 * behavior (the test guards the post-VW4 state).  To allow a specific type temporarily,
 * add its "type" value to ALLOWED_TYPES below.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..', '..');

// Files to scan (optional bonus: also scan pm.md per the task spec)
const SCAN_FILES = [
  path.join(repoRoot, 'agents', 'pm-reference', 'tier1-orchestration.md'),
  path.join(repoRoot, 'agents', 'pm.md'),
];

// Minimum number of top-level fields for a block to be considered "schema-shaped".
const SCHEMA_FIELD_THRESHOLD = 5;

// Event types that are explicitly allowed to remain inline.
// To allow a specific type temporarily, add its "type" value here.
const ALLOWED_TYPES = new Set([
  'verify_fix_start',
  'verify_fix_pass',
  'verify_fix_fail',
  'verify_fix_oscillation',
  'escalation',
  'threshold_signal',
  'pattern_applied',
]);

/**
 * Extract all fenced ```json blocks from markdown content.
 * Returns an array of { line, src, parsed } objects where:
 *   line  — 1-indexed line number of the opening fence
 *   src   — raw JSON string
 *   parsed — parsed object (null if parse failed)
 */
function extractJsonBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  let inBlock = false;
  let blockLines = [];
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (!inBlock && /^\s*```json\s*$/.test(lines[i])) {
      inBlock = true;
      blockLines = [];
      blockStart = i + 1; // 1-indexed
    } else if (inBlock && /^\s*```\s*$/.test(lines[i])) {
      inBlock = false;
      const src = blockLines.join('\n');
      let parsed = null;
      try {
        parsed = JSON.parse(src);
      } catch (_e) {
        // Not valid JSON — not a schema, skip
      }
      blocks.push({ line: blockStart, src, parsed });
      blockLines = [];
      blockStart = -1;
    } else if (inBlock) {
      blockLines.push(lines[i]);
    }
  }

  return blocks;
}

/**
 * Classify a parsed JSON object as "schema-shaped":
 *   - It is an object (not an array)
 *   - It has more than SCHEMA_FIELD_THRESHOLD top-level fields
 */
function isSchemaShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.keys(parsed).length > SCHEMA_FIELD_THRESHOLD;
}

describe('v2022 — tier1 no-inline-schemas guardrail', () => {
  for (const filePath of SCAN_FILES) {
    const relPath = path.relative(repoRoot, filePath);

    test(`${relPath} contains no disallowed inline event schemas`, () => {
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (_e) {
        // File doesn't exist (e.g. on a branch where pm.md lives elsewhere) — skip
        return;
      }

      const blocks = extractJsonBlocks(content);
      const violations = [];

      for (const b of blocks) {
        if (!isSchemaShape(b.parsed)) continue;

        const eventType = b.parsed.type;
        if (!eventType) continue; // structural blocks (KB index, config) have no "type"

        if (ALLOWED_TYPES.has(eventType)) continue;

        violations.push({ type: eventType, line: b.line });
      }

      if (violations.length > 0) {
        const msgs = violations.map(v =>
          `${relPath} has an inline JSON schema for type '${v.type}' at line ${v.line}.\n` +
          `Fix: move the block to agents/pm-reference/event-schemas.md, then replace the inline block\n` +
          `in ${relPath} with a cross-reference comment, e.g.:\n` +
          `    <!-- schema: see event-schemas.md#${v.type} -->\n` +
          `To allow a specific type inline temporarily, add its "type" value to ALLOWED_TYPES in this test file.`
        );
        assert.fail(msgs.join('\n\n'));
      }
    });
  }
});
